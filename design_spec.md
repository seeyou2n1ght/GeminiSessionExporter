# Gemini 会话导出脚本 - 详细设计方案

## 1. 项目目标
开发一个 Tampermonkey (油猴) 脚本，能够：
1. 遍历 Gemini 网页版侧边栏，获取所有历史会话。
2. 逐个加载会话并提取对话内容（文本、代码、图片）。
3. 支持导出为 TXT, Markdown, PDF 格式。
4. 提供友好的 UI 界面展示进度。

## 2. 技术架构

### 2.1 依赖库 (通过 @require 引入)
- **JSZip**: 用于打包多个会话文件，避免浏览器拦截批量下载。
- **Turndown**: 用于将 HTML 转换为高质量的 Markdown。
- **html2canvas & jspdf**: (可选) 用于生成 PDF，或者直接利用浏览器的打印功能。

### 2.2 模块划分

#### A. UI Manager (界面管理)
- **入口**: 页面左下角或侧边栏顶部的 "Export" 按钮。
- **面板**:
  - [ ] 导出范围选择 (Current Chat / All Chats)
  - [ ] 格式选择 (Checkboxes: MD, TXT, PDF)
  - [ ] 状态显示 (Log: "Found 25 chats...", "Processing 3/25")
  - [ ] 控制按钮 (Start, Stop, Download Zip)

#### B. Discovery Engine (会话发现)
Gemini 的会话列表位于侧边栏 (`nav`)。
- **逻辑**:
  1. 定位侧边栏容器。
  2. 执行 `scrollTop = scrollHeight`。
  3. 等待加载 (观察 DOM 变化或固定延时)。
  4. 重复直到高度不再变化。
  5. 解析所有 `<a>` 标签，提取 `href` (格式如 `/app/xyz...`) 和标题。

#### C. Extraction Engine (内容提取)
针对单个会话页面的解析。
- **容器定位**: 寻找包含对话流的主容器 `main`。
- **消息块识别**:
  - 用户消息: 通常有特定的类名或 `data-testid="user-message"` (需探测)。
  - 模型消息: 包含 Markdown 渲染后的 HTML。
- **数据清洗**:
  - 移除 "Show drafts", "Regenerate" 等干扰按钮文本。
  - 处理代码块：保留语言标识。

#### D. Export Engine (导出引擎)
- **Markdown 构建器**: 组合 Header (标题, 时间) + 消息体。
- **Zip 打包**: 将生成的内容添加到 Zip 对象中，最后触发 Blob 下载。

## 3. 关键难点与解决方案

| 难点 | 解决方案 |
|------|----------|
| **动态类名 (Obfuscated Classes)** | 尽量使用相对稳定的属性选择器 (如 `role`, `aria-label`, `data-*`)，或者基于层级结构的 `:nth-child`。提供“手动更新选择器”的配置项。 |
| **懒加载 (Lazy Loading)** | 必须在脚本中实现自动滚动逻辑，并配合 `MutationObserver` 等待内容加载完毕。 |
| **单页应用跳转 (SPA Nav)** | 不使用 `window.location.href` (会导致重载)。使用 React/Angular 兼容的点击模拟，或者直接修改 history api 后触发事件。 |
| **API 速率限制** | 在批量导出时，每个会话之间设置 **2000ms - 5000ms** 的随机延时。 |

## 4. 开发路线图 (Roadmap)
1. **v0.1 (当前)**: 搭建脚手架，实现 **导出当前会话为 Markdown**。验证 DOM 选择器。
2. **v0.2**: 实现侧边栏自动滚动和会话列表抓取。
3. **v0.3**: 实现批量遍历逻辑和 Zip 打包。
4. **v0.4**: 增加 PDF 支持和 UI 美化。

---
建议先从 **v0.1** 开始：编写脚本提取**当前屏幕上**的对话内容，确认选择器是否有效。
