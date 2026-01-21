# Gemini 会话导出脚本 (Gemini Session Exporter)

这是一个 Tampermonkey (油猴) 脚本，用于将 Google Gemini 的网页版会话记录导出为本地文件。

## ✨ 功能特点

1.  **批量导出 (Batch Export)**:
    *   自动滚动侧边栏，抓取所有历史会话。
    *   自动遍历每一个会话，提取对话内容。
    *   最后将所有会话打包成一个 ZIP 文件下载。
    *   支持断点续传：如果中途页面刷新，脚本会自动继续。
2.  **单会话导出**: 支持将当前正在查看的会话导出为 Markdown。
3.  **格式支持**:
    *   主要输出为 **Markdown (.md)**，完美保留代码块、标题和文本结构。
    *   (由于浏览器限制，批量导出仅支持 Markdown/ZIP，PDF 建议由 Markdown 转换)

## 🚀 安装步骤

1.  确保浏览器已安装 **Tampermonkey** 扩展。
2.  点击 Tampermonkey 图标 -> "添加新脚本"。
3.  打开本项目中的 `src/gemini_exporter.user.js` 文件，复制所有代码。
4.  粘贴到 Tampermonkey 编辑器中，保存 (Ctrl+S)。
5.  刷新 Gemini 页面 (https://gemini.google.com/)。

## 📖 使用指南

1.  脚本加载后，页面右下角会出现 **"Gemini Exporter v0.2"** 面板。
2.  **导出当前会话**:
    *   点击 "📄 Export Current (MD)"。
    *   文件将立即下载。
3.  **批量导出所有历史**:
    *   点击 "📦 Batch Export All (ZIP)"。
    *   **注意**: 脚本会自动控制页面滚动和跳转，请勿手动干预。
    *   完成后会自动下载 ZIP 包。

## ⚠️ 注意事项

*   **API 频率**: 脚本在会话之间设置了 2-3 秒的延时，以避免被 Google 暂时封禁。如果遇到 429 错误，请暂停一段时间再试。
*   **页面结构变化**: 如果 Google 更新了 Gemini 的网页代码 (Class 名变化)，脚本可能会失效。
