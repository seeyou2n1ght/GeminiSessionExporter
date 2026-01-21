// ==UserScript==
// @name         Gemini Session Exporter
// @namespace    http://tampermonkey.net/
// @version      0.2
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
        SIDEBAR_CONTAINER: 'side-navigation infinite-scroller, nav infinite-scroller',
        SIDEBAR_ITEM: 'a.conversation',
        TITLE: 'h1.title, .conversation-title, a.conversation.active .conversation-title'
    };

    const STATE_KEYS = {
        QUEUE: 'gemini_export_queue',
        RESULTS: 'gemini_export_results',
        IS_RUNNING: 'gemini_export_running',
        CURRENT_INDEX: 'gemini_export_index'
    };

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
        // Try to find the title in the header or the active sidebar item
        const activeSidebarItem = document.querySelector('a.conversation[aria-current="page"] .conversation-title');
        if (activeSidebarItem) return activeSidebarItem.innerText.trim();

        // Fallback: Use timestamp
        return `Gemini_Chat_${new Date().toISOString().slice(0, 10)}`;
    }

    function extractCurrentConversation() {
        const historyContainer = document.querySelector(SELECTORS.CHAT_CONTAINER);
        if (!historyContainer) {
            alert('Error: Could not find chat history container.');
            return null;
        }

        // Gemini structure: Rows are often generic divs. Inside them are user-query or model-response components.
        // We iterate through visual order.
        const output = [];

        // Strategy: Query all user-query and model-response elements in document order
        // This relies on the fact that they appear in chronological order in the DOM
        const allMessages = Array.from(historyContainer.querySelectorAll(`${SELECTORS.USER_ROW}, ${SELECTORS.MODEL_ROW}`));

        allMessages.forEach(msg => {
            const isUser = msg.tagName.toLowerCase() === SELECTORS.USER_ROW;
            let text = '';

            if (isUser) {
                // User query text
                text = msg.innerText || msg.textContent;
                text = text.replace(/edit\s*$/i, '').trim();
            } else {
                // Model response: Use Turndown on the .markdown container if available
                // We also check for 'message-content' which sometimes wraps the markdown
                const markdownContainer = msg.querySelector(SELECTORS.MODEL_CONTENT) || msg.querySelector('.message-content') || msg;
                if (markdownContainer) {
                    const turndownService = new TurndownService({
                        headingStyle: 'atx',
                        codeBlockStyle: 'fenced'
                    });
                    // Configure Turndown to ignore some Gemini-specific UI artifacts if needed
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

    function generateMarkdown(messages, title) {
        let md = `# ${title}\n\n`;
        md += `> Exported at: ${new Date().toLocaleString()}\n\n`;

        messages.forEach(msg => {
            md += `## ${msg.role}\n\n`;
            md += `${msg.content}\n\n`;
            md += `---\n\n`;
        });
        return md;
    }

    // --- Batch Export Logic ---
    const BatchExporter = {
        async crawlSidebar(updateStatus) {
            updateStatus('🔍 Locating sidebar...');
            const nav = document.querySelector(SELECTORS.SIDEBAR_CONTAINER);
            if (!nav) throw new Error('Sidebar not found');

            updateStatus('📜 Scrolling to find all chats...');
            let previousHeight = 0;
            let noChangeCount = 0;

            // Limit iterations to avoid infinite loops, e.g. 100 scrolls max
            for (let i = 0; i < 100; i++) {
                nav.scrollTop = nav.scrollHeight;
                await new Promise(r => setTimeout(r, 1500));

                if (nav.scrollHeight === previousHeight) {
                    noChangeCount++;
                    if (noChangeCount >= 2) break; // Stop if no growth twice
                } else {
                    noChangeCount = 0;
                }
                previousHeight = nav.scrollHeight;
                updateStatus(`📜 Scrolling... (found ${document.querySelectorAll(SELECTORS.SIDEBAR_ITEM).length} items)`);
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

        async processQueue(updateStatus) {
            const queue = GM_getValue(STATE_KEYS.QUEUE, []);
            let results = GM_getValue(STATE_KEYS.RESULTS, []);

            // If empty queue, we are done
            if (queue.length === 0) {
                this.finalizeExport(results, updateStatus);
                return;
            }

            const currentItem = queue[0];
            updateStatus(`⏳ Processing: ${currentItem.title} (${results.length} done, ${queue.length} left)`);

            // Navigate
            if (window.location.href !== currentItem.url) {
                // Try SPA navigation override first if possible, else direct assign
                // Finding the link in sidebar to click is safest for SPA
                const link = document.querySelector(`a[href*="${currentItem.id}"]`);
                if (link) {
                    link.click();
                } else {
                    window.location.href = currentItem.url;
                    // If hard reload, the script restarts and 'initUI' will verify 'IS_RUNNING' flag logic (to be implemented)
                    // For now, let's assume we need to wait for load here
                }
            }

            // Wait for content
            await waitForElement(SELECTORS.CHAT_CONTAINER, 10000);
            await new Promise(r => setTimeout(r, 2000)); // Extra buffer for API

            // Extract
            const messages = extractCurrentConversation();
            if (messages && messages.length > 0) {
                const md = generateMarkdown(messages, currentItem.title);
                results.push({ filename: `${currentItem.id}_${currentItem.title.replace(/[^a-z0-9]/gi, '_').slice(0, 50)}.md`, content: md });
            } else {
                results.push({ filename: `ERROR_${currentItem.id}.txt`, content: "Failed to extract or empty." });
            }

            // Update State
            queue.shift(); // Remove done
            GM_setValue(STATE_KEYS.QUEUE, queue);
            GM_setValue(STATE_KEYS.RESULTS, results);

            // Loop
            this.processQueue(updateStatus);
        },

        finalizeExport(results, updateStatus) {
            updateStatus('📦 Zipping files...');
            const zip = new JSZip();
            results.forEach(f => {
                zip.file(f.filename, f.content);
            });

            zip.generateAsync({ type: "blob" }).then(function (content) {
                saveAs(content, `Gemini_Export_Full_${new Date().toISOString().slice(0, 10)}.zip`);
                updateStatus('✅ Done! Download started.');
                // Reset State
                GM_setValue(STATE_KEYS.IS_RUNNING, false);
                GM_deleteValue(STATE_KEYS.QUEUE);
                GM_deleteValue(STATE_KEYS.RESULTS);
            });
        }
    };

    // --- UI: Control Panel ---
    function createTeleportContainer() {
        const existing = document.getElementById('gemini-exporter-panel');
        if (existing) return existing;

        const panel = document.createElement('div');
        panel.id = 'gemini-exporter-panel';
        Object.assign(panel.style, {
            position: 'fixed',
            bottom: '20px',
            right: '20px',
            backgroundColor: '#1e1e1e',
            color: '#fff',
            padding: '15px',
            borderRadius: '8px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
            zIndex: '9999',
            fontFamily: 'Google Sans, sans-serif',
            fontSize: '14px',
            minWidth: '250px',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px'
        });

        const title = document.createElement('h3');
        title.innerText = 'Gemini Exporter v0.2';
        title.style.margin = '0 0 5px 0';
        title.style.fontSize = '16px';
        title.style.borderBottom = '1px solid #333';
        title.style.paddingBottom = '5px';
        panel.appendChild(title);

        const status = document.createElement('div');
        status.id = 'gemini-export-status';
        status.innerText = 'Ready';
        status.style.fontSize = '12px';
        status.style.color = '#aaa';
        panel.appendChild(status);

        return { panel, status };
    }

    function addControl(panel, label, onClick) {
        const btn = document.createElement('button');
        btn.innerText = label;
        Object.assign(btn.style, {
            padding: '8px',
            backgroundColor: '#4caf50',
            border: 'none',
            borderRadius: '4px',
            color: 'white',
            cursor: 'pointer',
            fontWeight: 'bold'
        });
        btn.onmouseover = () => btn.style.backgroundColor = '#45a049';
        btn.onmouseout = () => btn.style.backgroundColor = '#4caf50';
        btn.onclick = onClick;
        panel.appendChild(btn);
        return btn;
    }

    function initUI() {
        // Wait for page load
        setTimeout(() => {
            const { panel, status } = createTeleportContainer();

            // Resume Check
            if (GM_getValue(STATE_KEYS.IS_RUNNING, false)) {
                addControl(panel, '🔴 Stop Export', () => {
                    GM_setValue(STATE_KEYS.IS_RUNNING, false);
                    window.location.reload();
                });
                status.innerText = 'Resuming batch export...';
                BatchExporter.processQueue((msg) => status.innerText = msg);
            } else {
                addControl(panel, '📄 Export Current (MD)', () => {
                    const title = getConversationTitle();
                    const messages = extractCurrentConversation();
                    if (messages && messages.length > 0) {
                        const mdContent = generateMarkdown(messages, title);
                        const blob = new Blob([mdContent], { type: 'text/markdown;charset=utf-8' });
                        saveAs(blob, `${title.replace(/[^a-z0-9]/gi, '_').slice(0, 50)}.md`);
                        status.innerText = 'Exported current chat.';
                    } else {
                        alert('No messages found! Please scroll to load history.');
                    }
                });

                addControl(panel, '📦 Batch Export All (ZIP)', async () => {
                    if (!confirm('This will scroll your sidebar to find ALL chats, then visit each one to export. It may take a while. Continue?')) return;

                    GM_setValue(STATE_KEYS.IS_RUNNING, true);
                    GM_setValue(STATE_KEYS.RESULTS, []); // Reset results

                    try {
                        const links = await BatchExporter.crawlSidebar((msg) => status.innerText = msg);
                        status.innerText = `Found ${links.length} chats. Starting export...`;
                        GM_setValue(STATE_KEYS.QUEUE, links);
                        BatchExporter.processQueue((msg) => status.innerText = msg);
                    } catch (e) {
                        status.innerText = 'Error: ' + e.message;
                        GM_setValue(STATE_KEYS.IS_RUNNING, false);
                    }
                });
            }

            document.body.appendChild(panel);
        }, 2000);
    }

    // --- Boot ---
    initUI();

})();
