# Gemini Session Exporter - 技术细节文档

本文档详细描述了 Gemini Session Exporter 油猴脚本的技术实现细节、架构设计及核心算法。

## 1. 架构概览 (Architecture Overview)

本脚本基于 **Browser UserScript (浏览器用户脚本)** 架构，运行在用户浏览器的 Tampermonkey/Violentmonkey 环境中。它采用 **UI 注入 + DOM 探测 + 状态机** 的混合模式工作。

### 1.1 核心组件
*   **DOM Observer (DOM 观察者)**: 负责监听和查找页面上动态加载的元素（侧边栏、聊天记录）。
*   **State Manager (状态管理器)**: 利用 `GM_setValue/GM_getValue` 实现跨页面刷新/跳转的任务持久化，这是这类 SPA (单页应用) 爬虫稳定运行的关键。
*   **Crawler Engine (爬虫引擎)**:
    *   **Discovery**: 发现并收集所有会话链接。
    *   **Extraction**: 解析当前会话内容的 HTML 并转为 Markdown。
*   **Export Pipeline (导出流水线)**: 内存中累积数据 -> ZIP 打包 -> Blob 下载。

## 2. 关键技术实现

### 2.1 状态持久化与断点续传 (State Persistence)
由于 Gemini 网页版是 Angular/Lit 构建的 SPA，但 URL 变化有时可能导致页面重载（Hard Reload）或内存状态丢失。为了保证稳定性，我们不依赖 JS 内存变量存储队列，而是使用 UserScript 的存储 API：

*   **`STATE_KEYS.QUEUE`**: 待处理的会话对象数组 `[{id, url, title}, ...]`。
*   **`STATE_KEYS.RESULTS`**: 已抓取的会话内容数组 `[{filename, content}, ...]`。
*   **`STATE_KEYS.IS_RUNNING`**: 布尔值，用于在脚本初始化 (`initUI`) 时判断是否需要自动恢复任务。

**工作流**:
1.  脚本加载时检查 `IS_RUNNING`。
2.  如果为 `true`，读取 `QUEUE`。
3.  取出一个任务，跳转/点击。
4.  等待加载 -> 提取 -> 存入 `RESULTS`。
5.  更新 `QUEUE` -> 递归/重载继续。

### 2.2 侧边栏无限滚动算法 (Sidebar Discovery)
Gemini 侧边栏采用懒加载机制，仅渲染视口内的列表项。

```javascript
// 伪代码逻辑
async function crawlSidebar() {
    let lastHeight = 0;
    while(true) {
        navElement.scrollTop = navElement.scrollHeight; // 滚动到底部
        await sleep(1500); // 等待网络请求和 DOM 渲染
        
        if (navElement.scrollHeight === lastHeight) {
            // 如果高度不再变化，说明加载完毕
            break; 
        }
        lastHeight = navElement.scrollHeight;
    }
    // 此时 DOM 中已包含所有 <a> 标签
    return extractLinks();
}
```

### 2.3 内容提取与转换 (Extraction & Transformation)

#### 选择器策略 (Selector Strategy)
为了应对混淆代码，我们优先使用语义化标签和属性，其次是稳定的类名结构：
*   **容器**: `infinite-scroller.chat-history` (Angular 组件)
*   **用户消息**: `user-query` (自定义标签)
*   **模型消息**: `model-response` (自定义标签) -> `.markdown` (Markdown 渲染容器)

#### HTML 转 Markdown
使用了 **Turndown** 库。
*   **自定义配置**:
    *   `headingStyle: 'atx'` (# 风格标题)
    *   `codeBlockStyle: 'fenced'` (``` 风格代码块)
*   脚本会尝试定位 `.markdown` 容器，直接转换渲染好的 HTML，从而完美保留**粗体**、*斜体*、`代码`、表格等格式，比直接提取 `innerText` 效果好得多。

### 2.4 ZIP 打包与进度反馈 (v0.3 优化)
*   **库**: `JSZip`
*   **策略**: 将所有 Markdown 字符串保留在 `GM_storage` 或内存中。当队列处理完毕后，一次性生成 ZIP Blob。
*   **进度回调** (v0.3 新增):
    *   JSZip 的 `generateAsync` 方法支持第二个参数 `onUpdate`，它会在压缩过程中被周期性调用。
    *   回调函数接收 `metadata` 对象，包含：
        *   `percent`: 压缩进度百分比 (0-100)
        *   `currentFile`: 当前正在处理的文件名
    *   脚本利用这个回调实时更新 UI 状态文本和进度条。
    
#### 进度条实现
```javascript
// UI 组件
const progressBar = document.createElement('div');
progressBar.style.width = '0%'; // 初始化为 0%
progressBar.style.transition = 'width 0.3s ease'; // 平滑动画

// 在压缩时更新
zip.generateAsync(
    { type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } },
    function(metadata) {
        const percent = metadata.percent.toFixed(0);
        progressBar.style.width = percent + '%';
        progressBar.innerText = percent + '%';
    }
);
```

#### 分阶段进度映射
*   **0-5%**: 侧边栏滚动和会话发现
*   **5-10%**: 会话列表解析完成
*   **10-90%**: 逐个提取会话内容（根据 `done/total` 动态计算）
*   **90-100%**: ZIP 压缩阶段（基于 JSZip 的 `metadata.percent`）

*   **限制**: 如果历史记录极其庞大（如几百兆文本），可能会触碰到浏览器的内存或 Storage Quota 限制。目前的 v0.3 版本适用于普通用户（< 10MB 文本数据）。

## 3. 防风控与安全性 (Safety & Anti-Blocking)

*   **拟人化延时**: 在每次页面跳转和抓取之间，强制插入 `1500ms ~ 3000ms` 的延时，模拟用户阅读速度，防止触发 Google 的 "Unusual traffic" 验证码。
*   **被动触发**: 脚本完全由用户点击触发，不会在后台静默运行，符合 Google 安全规范。
*   **本地运行**: 所有数据处理均在本地浏览器完成，不上传任何数据到第三方服务器。

## 4. 依赖库说明

| 库名称 | 版本 | 用途 | 来源 (CDN) |
| :--- | :--- | :--- | :--- |
| **Turndown** | Latest | HTML -> Markdown 转换 | unpkg.com |
| **JSZip** | 3.10.1 | 多文件打包 | cdnjs.cloudflare.com |
| **FileSaver.js** | 2.0.5 | 触发浏览器已保存文件下载 | cdnjs.cloudflare.com |

## 5. 已知限制与未来优化

1.  **图片支持**: 目前仅提取文本和代码。Gemini 生成的图片通常是临时的 Google UserContent 链接，直接导出 Markdown 后链接可能会过期。未来版本需考虑将图片转为 Base64 或下载到 ZIP 中。
2.  **动态类名失效**: 如果 Google 重构前端代码（例如移除 `user-query` 标签），选择器需要更新。
3.  **PDF 高级排版**: 目前未集成 PDF 生成，因为浏览器端 JS 生成 PDF (jspdf) 对中文支持较差且排版困难。建议用户导出 Markdown 后使用 Typora/Pandoc 转换。
