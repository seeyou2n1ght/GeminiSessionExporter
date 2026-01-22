# Gemini 会话导出脚本 (Gemini Session Exporter)

这是一个 Tampermonkey (油猴) 脚本，用于将 Google Gemini 的网页版会话记录导出为本地文件。

## ✨ 功能特点

1.  **灵活的导出菜单**: 
    *   完全集成到 Tampermonkey 菜单中，不干扰页面原本的 UI。
    *   支持导出**当前会话**或**批量导出所有历史**。
2.  **批量导出 (Batch Export)**:
    *   自动滚动侧边栏，发现并抓取所有历史会话。
    *   **断点续传**: 页面刷新或网络中断后自动恢复进度。
    *   **进度反馈**: 右上角悬浮窗实时显示处理进度。
3.  **高度可配置 (v0.4)**:
    *   **格式**: 支持 Markdown (.md) 或纯文本 (.txt)。
    *   **打包**: 默认生成 ZIP 包，也支持按文件单独下载。
    *   **元数据**: 可选是否包含时间戳等信息。
4.  **智能格式转换**:
    *   完美保留代码块、标题、粗体等 Markdown 格式。
    *   支持中文文件名的安全转换。

## 🚀 安装步骤

1.  确保浏览器已安装 **Tampermonkey** 扩展。
2.  点击 Tampermonkey 图标 -> "添加新脚本"。
3.  打开本项目中的 `src/gemini_exporter.user.js` 文件，复制所有代码。
4.  粘贴到 Tampermonkey 编辑器中，保存 (Ctrl+S)。
5.  刷新 Gemini 页面 (https://gemini.google.com/)。

## 📖 使用指南

### 1. 导出操作
所有操作均通过 **Tampermonkey 菜单** 触发：
1.  点击浏览器地址栏右侧的 **Tampermonkey 图标**。
2.  找到 "Gemini Session Exporter" 下的菜单项：
    *   **📄 Export Current Session**: 立即导出当前聊天窗口及其内容。
    *   **📦 Batch Export All**: 开始自动遍历并导出所有历史会话 (生成 ZIP)。
    *   **⚙️ Settings**: 打开配置面板。

### 2. 批量导出流程
*   点击 "📦 Batch Export All" 后，右上角会出现进度悬浮窗。
*   脚本会自动滚动侧边栏以加载所有会话。
*   脚本会依次跳转到每个会话页面抓取内容。
*   **请勿手动关闭页面**，直到提示 "✅ Done!" 并开始下载 ZIP 文件。

### 3. 配置选项
点击菜单中的 **⚙️ Settings** 可以修改：
*   **Format**: 导出文件的格式 (Markdown 或 TXT)。
*   **Save Mode**: 
    *   `Single ZIP Archive`: (推荐) 所有会话打包成一个 ZIP。
    *   `Individual Files`: 浏览器会逐个下载文件 (注意：可能会被浏览器拦截弹窗)。

## ⚠️ 注意事项

*   **API 频率**: 脚本在会话之间设置了 2秒 的延时，以避免被 Google 暂时封禁 (429 Too Many Requests)。
*   **页面结构**: 脚本依赖 Gemini 的 DOM 结构，如果 Google 大幅改版网页，脚本可能需要更新。
