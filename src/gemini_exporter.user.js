// ==UserScript==
// @name         Gemini Session Exporter
// @namespace    http://tampermonkey.net/
// @version      0.5
// @description  Export Gemini chat history to Markdown/PDF/ZIP
// @author       Antigravity
// @match        https://gemini.google.com/*
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @require      https://unpkg.com/turndown/dist/turndown.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/FileSaver.js/2.0.5/FileSaver.min.js
// ==/UserScript==

(function () {
    'use strict';

    // --- Configuration & Constants ---
    const SELECTORS = {
        CHAT_CONTAINER: 'infinite-scroller.chat-history',
        USER_ROW: 'user-query',
        MODEL_ROW: 'model-response',
        MODEL_CONTENT: '.markdown',
        // Updated selector to work with Gemini's latest DOM structure
        SIDEBAR_CONTAINER: '[role="navigation"] infinite-scroller, side-navigation-content infinite-scroller, side-navigation-v2 infinite-scroller, side-navigation infinite-scroller, nav infinite-scroller',
        SIDEBAR_ITEM: 'a.conversation',
        TITLE: 'h1.title, .conversation-title, a.conversation.active .conversation-title'
    };

    const STATE_KEYS = {
        QUEUE: 'gemini_export_queue',
        RESULTS: 'gemini_export_results',
        IS_RUNNING: 'gemini_export_running',
        SETTINGS: 'gemini_export_settings'
    };

    const DEFAULT_SETTINGS = {
        format: 'markdown', // 'markdown' or 'txt'
        exportMode: 'zip',  // 'zip' (all in one) or 'single' (individual downloads - not recommended for batch)
        includeMetadata: true,
        delay: 2000
    };

    // TurndownService singleton for HTML to Markdown conversion
    const turndownService = new TurndownService({
        headingStyle: 'atx',
        codeBlockStyle: 'fenced'
    });

    // --- Helper: Settings Management ---
    function getSettings() {
        return { ...DEFAULT_SETTINGS, ...GM_getValue(STATE_KEYS.SETTINGS, {}) };
    }

    function saveSettings(newSettings) {
        GM_setValue(STATE_KEYS.SETTINGS, newSettings);
    }

    // --- Helper: retrySelector ---
    function waitForElement(selector, timeout = 5000) {
        return new Promise(resolve => {
            if (document.querySelector(selector)) {
                return resolve(document.querySelector(selector));
            }

            const observer = new MutationObserver(mutations => {
                if (document.querySelector(selector)) {
                    resolve(document.querySelector(selector));
                    observer.disconnect();
                }
            });

            observer.observe(document.body, {
                childList: true,
                subtree: true
            });

            setTimeout(() => {
                observer.disconnect();
                resolve(null);
            }, timeout);
        });
    }

    // --- Core: Extraction Logic ---
    function getConversationTitle() {
        const activeSidebarItem = document.querySelector('a.conversation[aria-current="page"] .conversation-title');
        if (activeSidebarItem) return activeSidebarItem.innerText.trim();
        return `Gemini_Chat_${new Date().toISOString().slice(0, 10)}`;
    }

    function extractCurrentConversation() {
        const historyContainer = document.querySelector(SELECTORS.CHAT_CONTAINER);
        if (!historyContainer) {
            alert('Error: Could not find chat history container.');
            return null;
        }

        const output = [];
        const allMessages = Array.from(historyContainer.querySelectorAll(`${SELECTORS.USER_ROW}, ${SELECTORS.MODEL_ROW}`));

        allMessages.forEach(msg => {
            const isUser = msg.tagName.toLowerCase() === SELECTORS.USER_ROW;
            let text = '';

            if (isUser) {
                text = msg.innerText || msg.textContent;
                text = text.replace(/edit\s*$/i, '').trim();
            } else {
                const markdownContainer = msg.querySelector(SELECTORS.MODEL_CONTENT) || msg.querySelector('.message-content') || msg;
                if (markdownContainer) {
                    text = turndownService.turndown(markdownContainer.innerHTML);
                } else {
                    text = msg.innerText;
                }
            }

            if (text) {
                output.push({
                    role: isUser ? 'User' : 'Gemini',
                    content: text
                });
            }
        });

        return output;
    }

    function generateContent(messages, title) {
        const settings = getSettings();

        if (settings.format === 'txt') {
            let txt = `Title: ${title}\n`;
            if (settings.includeMetadata) txt += `Date: ${new Date().toLocaleString()}\n`;
            txt += `\n------------------\n\n`;
            messages.forEach(msg => {
                txt += `[${msg.role}]\n${msg.content}\n\n`;
            });
            return { content: txt, ext: 'txt', type: 'text/plain;charset=utf-8' };
        } else {
            // Markdown
            let md = `# ${title}\n\n`;
            if (settings.includeMetadata) md += `> Exported at: ${new Date().toLocaleString()}\n\n`;
            messages.forEach(msg => {
                md += `## ${msg.role}\n\n`;
                md += `${msg.content}\n\n`;
                md += `---\n\n`;
            });
            return { content: md, ext: 'md', type: 'text/markdown;charset=utf-8' };
        }
    }

    // --- Batch Export Logic ---
    const BatchExporter = {
        async crawlSidebar(updateStatus) {
            updateStatus('🔍 Locating sidebar...');
            const nav = document.querySelector(SELECTORS.SIDEBAR_CONTAINER);
            if (!nav) throw new Error('Sidebar not found');

            updateStatus('📜 Scrolling to find sessions...');
            let previousHeight = 0;
            let noChangeCount = 0;

            for (let i = 0; i < 100; i++) {
                nav.scrollTop = nav.scrollHeight;
                await new Promise(r => setTimeout(r, 1500));

                if (nav.scrollHeight === previousHeight) {
                    noChangeCount++;
                    if (noChangeCount >= 2) break;
                } else {
                    noChangeCount = 0;
                }
                previousHeight = nav.scrollHeight;
                updateStatus(`📜 Scrolling... found ${document.querySelectorAll(SELECTORS.SIDEBAR_ITEM).length} items`);
            }

            const links = Array.from(document.querySelectorAll(SELECTORS.SIDEBAR_ITEM)).map(a => ({
                title: a.innerText.split('\n')[0].trim() || 'Untitled',
                url: a.href,
                id: a.href.split('/').pop()
            }));

            // Filter duplicates
            const unique = [];
            const ids = new Set();
            links.forEach(l => {
                if (!ids.has(l.id)) {
                    ids.add(l.id);
                    unique.push(l);
                }
            });

            return unique;
        },

        async processQueue(updateStatus, updateProgress, totalCount) {
            const queue = GM_getValue(STATE_KEYS.QUEUE, []);
            let results = GM_getValue(STATE_KEYS.RESULTS, []);
            const settings = getSettings();

            if (queue.length === 0) {
                this.finalizeExport(results, updateStatus, updateProgress);
                return;
            }

            // Calculate progress: processed = total - remaining
            const processed = totalCount - queue.length;
            const progressPercent = Math.round((processed / totalCount) * 90); // 0-90% for extraction, 90-100% for compression
            if (updateProgress) updateProgress(progressPercent);

            const currentItem = queue[0];
            updateStatus(`⏳ [${processed + 1}/${totalCount}] ${currentItem.title}`);

            // Navigate if needed
            if (window.location.href !== currentItem.url) {
                const link = document.querySelector(`a[href*="${currentItem.id}"]`);
                if (link) {
                    link.click();
                } else {
                    window.location.href = currentItem.url;
                }
            }

            // Wait for content
            const chatContainer = await waitForElement(SELECTORS.CHAT_CONTAINER, 10000);

            if (!chatContainer) {
                // Element not found after timeout, record error and continue
                results.push({
                    filename: `ERROR_${currentItem.id}.txt`,
                    content: `Failed to load chat container for: ${currentItem.title}`
                });
            } else {
                await new Promise(r => setTimeout(r, settings.delay));

                // Extract
                const messages = extractCurrentConversation();
                if (messages && messages.length > 0) {
                    const { content, ext } = generateContent(messages, currentItem.title);
                    const safeTitle = currentItem.title.replace(/[^a-z0-9\u4e00-\u9fa5]/gi, '_').slice(0, 50);
                    results.push({
                        filename: `${safeTitle}_${currentItem.id}.${ext}`,
                        content: content
                    });
                } else {
                    results.push({ filename: `ERROR_${currentItem.id}.txt`, content: "Failed to extract messages." });
                }
            }

            // Update State
            queue.shift();
            GM_setValue(STATE_KEYS.QUEUE, queue);
            GM_setValue(STATE_KEYS.RESULTS, results);

            // Loop (recursive call with same totalCount)
            this.processQueue(updateStatus, updateProgress, totalCount);
        },

        finalizeExport(results, updateStatus, updateProgress) {
            const settings = getSettings();

            if (settings.exportMode === 'single') {
                // Not really recommended for batch, but implemented as requested
                updateStatus('💾 Saving individual files...');
                results.forEach((f, i) => {
                    setTimeout(() => {
                        const blob = new Blob([f.content], { type: 'text/plain;charset=utf-8' });
                        saveAs(blob, f.filename);
                    }, i * 500);
                });
                updateStatus('✅ Individual downloads started.');
                cleanup();
            } else {
                // ZIP Mode
                updateStatus('📦 Preparing ZIP...');
                if (updateProgress) updateProgress(90);
                const zip = new JSZip();

                results.forEach((f) => {
                    zip.file(f.filename, f.content);
                });

                updateStatus('🗜️ Compressing...');
                zip.generateAsync(
                    { type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } },
                    (metadata) => {
                        const compressProgress = 90 + Math.round(metadata.percent / 10); // 90-100%
                        updateStatus(`🗜️ Compressing: ${metadata.percent.toFixed(0)}%`);
                        if (updateProgress) updateProgress(compressProgress);
                    }
                ).then(function (content) {
                    saveAs(content, `Gemini_Export_Full_${new Date().toISOString().slice(0, 10)}.zip`);
                    updateStatus('✅ Done! Download started.');
                    if (updateProgress) updateProgress(100);
                    cleanup();
                });
            }

            function cleanup() {
                GM_setValue(STATE_KEYS.IS_RUNNING, false);
                GM_deleteValue(STATE_KEYS.QUEUE);
                GM_deleteValue(STATE_KEYS.RESULTS);
                setTimeout(() => {
                    const overlay = document.getElementById('gemini-exporter-overlay');
                    if (overlay) overlay.remove();
                }, 3000);
            }
        }
    };

    // --- UI: Settings Modal ---
    function showSettingsModal() {
        if (document.getElementById('gemini-settings-modal')) return;

        const current = getSettings();

        const modal = document.createElement('div');
        modal.id = 'gemini-settings-modal';
        Object.assign(modal.style, {
            position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
            backgroundColor: '#1e1e1e', color: '#fff', padding: '20px', borderRadius: '8px',
            boxShadow: '0 0 20px rgba(0,0,0,0.8)', zIndex: '10001',
            minWidth: '300px', fontFamily: 'sans-serif'
        });

        let html = `<h2 style="margin-top:0">Export Settings</h2>`;

        // Format
        html += `<div style="margin-bottom:15px">
            <label>Format:</label><br>
            <select id="gs-format" style="width:100%; padding:5px; margin-top:5px; background:#333; color:#fff; border:1px solid #555">
                <option value="markdown" ${current.format === 'markdown' ? 'selected' : ''}>Markdown (.md)</option>
                <option value="txt" ${current.format === 'txt' ? 'selected' : ''}>Plain Text (.txt)</option>
            </select>
        </div>`;

        // Export Mode
        html += `<div style="margin-bottom:15px">
            <label>Save Mode (Batch):</label><br>
            <select id="gs-mode" style="width:100%; padding:5px; margin-top:5px; background:#333; color:#fff; border:1px solid #555">
                <option value="zip" ${current.exportMode === 'zip' ? 'selected' : ''}>Single ZIP Archive (Recommended)</option>
                <option value="single" ${current.exportMode === 'single' ? 'selected' : ''}>Individual Files (Might prompt)</option>
            </select>
        </div>`;

        // Metadata
        html += `<div style="margin-bottom:15px">
            <label><input type="checkbox" id="gs-meta" ${current.includeMetadata ? 'checked' : ''}> Include Metadata (Date/Time)</label>
        </div>`;

        // Buttons
        html += `<div style="text-align:right; margin-top:20px">
            <button id="gs-cancel" style="margin-right:10px; padding:5px 10px; cursor:pointer">Cancel</button>
            <button id="gs-save" style="padding:5px 15px; background:#4caf50; color:white; border:none; border-radius:4px; cursor:pointer">Save</button>
        </div>`;

        modal.innerHTML = html;
        document.body.appendChild(modal);

        // Backdrop
        const backdrop = document.createElement('div');
        backdrop.id = 'gemini-settings-backdrop';
        Object.assign(backdrop.style, {
            position: 'fixed', top: 0, left: 0, width: '100%', height: '100%',
            backgroundColor: 'rgba(0,0,0,0.5)', zIndex: '10000', cursor: 'pointer'
        });
        document.body.appendChild(backdrop);

        const close = () => { modal.remove(); backdrop.remove(); };

        // Click backdrop to close
        backdrop.onclick = close;

        document.getElementById('gs-cancel').onclick = close;
        document.getElementById('gs-save').onclick = () => {
            saveSettings({
                format: document.getElementById('gs-format').value,
                exportMode: document.getElementById('gs-mode').value,
                includeMetadata: document.getElementById('gs-meta').checked,
                delay: 2000
            });
            close();
            showToast('✅ Settings saved!');
        };
    }

    // --- UI: Toast Notification ---
    function showToast(message, duration = 2000) {
        const toast = document.createElement('div');
        Object.assign(toast.style, {
            position: 'fixed', bottom: '20px', left: '50%', transform: 'translateX(-50%)',
            backgroundColor: '#333', color: 'white', padding: '12px 24px',
            borderRadius: '8px', boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
            zIndex: '10002', fontFamily: 'sans-serif', fontSize: '14px',
            opacity: '0', transition: 'opacity 0.3s'
        });
        toast.innerText = message;
        document.body.appendChild(toast);

        // Fade in
        setTimeout(() => toast.style.opacity = '1', 10);

        // Fade out and remove
        setTimeout(() => {
            toast.style.opacity = '0';
            setTimeout(() => toast.remove(), 300);
        }, duration);
    }

    // --- UI: Progress Overlay (No more side panel) ---
    function showProgressOverlay() {
        const overlay = document.createElement('div');
        overlay.id = 'gemini-exporter-overlay';
        Object.assign(overlay.style, {
            position: 'fixed', top: '20px', right: '20px',
            backgroundColor: 'rgba(0,0,0,0.9)', color: 'white',
            padding: '15px', borderRadius: '8px', zIndex: '10000',
            fontFamily: 'monospace', minWidth: '280px'
        });
        overlay.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                <span style="font-weight:bold;">Gemini Exporter</span>
                <button id="gs-stop" style="background:#e74c3c; color:white; border:none; padding:4px 10px; border-radius:4px; cursor:pointer; font-size:12px;">⏹ Stop</button>
            </div>
            <div id="gs-status">Starting...</div>
            <div id="gs-bar" style="width:0%; height:6px; background:#4caf50; margin-top:10px; border-radius:3px; transition: width 0.3s"></div>
        `;
        document.body.appendChild(overlay);

        // Stop button handler
        document.getElementById('gs-stop').onclick = () => {
            if (confirm('Stop the export process? Progress will be lost.')) {
                GM_setValue(STATE_KEYS.IS_RUNNING, false);
                GM_deleteValue(STATE_KEYS.QUEUE);
                GM_deleteValue(STATE_KEYS.RESULTS);
                GM_deleteValue('gemini_export_total');
                overlay.remove();
                alert('Export cancelled.');
            }
        };

        return {
            updateText: (txt) => {
                const el = document.getElementById('gs-status');
                if (el) el.innerText = txt;
            },
            updateBar: (pct) => {
                const el = document.getElementById('gs-bar');
                if (el) el.style.width = pct + '%';
            }
        };
    }

    // --- Menu Commands ---
    function runExportCurrent() {
        const title = getConversationTitle();
        const messages = extractCurrentConversation();
        if (messages && messages.length > 0) {
            const { content, ext, type } = generateContent(messages, title);
            const blob = new Blob([content], { type: type });
            saveAs(blob, `${title.replace(/[^a-z0-9]/gi, '_')}.${ext}`);
        } else {
            alert('No messages found!');
        }
    }

    async function runBatchExport() {
        if (!confirm('Start batch export of ALL sessions?')) return;

        GM_setValue(STATE_KEYS.IS_RUNNING, true);
        GM_setValue(STATE_KEYS.RESULTS, []);

        const ui = showProgressOverlay();

        try {
            const links = await BatchExporter.crawlSidebar((msg) => ui.updateText(msg));
            GM_setValue(STATE_KEYS.QUEUE, links);
            GM_setValue('gemini_export_total', links.length); // Store total for resume
            BatchExporter.processQueue(
                (msg) => ui.updateText(msg),
                (pct) => ui.updateBar(pct),
                links.length
            );
        } catch (e) {
            ui.updateText('Error: ' + e.message);
            GM_setValue(STATE_KEYS.IS_RUNNING, false);
        }
    }

    // --- Init ---
    GM_registerMenuCommand("📄 Export Current Session", runExportCurrent);
    GM_registerMenuCommand("📦 Batch Export All", runBatchExport);
    GM_registerMenuCommand("⚙️ Settings", showSettingsModal);

    // Resume Logic
    if (GM_getValue(STATE_KEYS.IS_RUNNING, false)) {
        const ui = showProgressOverlay();
        ui.updateText('Resuming batch export...');
        const totalCount = GM_getValue('gemini_export_total', 1); // Retrieve stored total
        BatchExporter.processQueue(
            (msg) => ui.updateText(msg),
            (pct) => ui.updateBar(pct),
            totalCount
        );
    }

})();
