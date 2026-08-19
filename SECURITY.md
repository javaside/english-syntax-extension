# 安全策略

适用于本仓库的两个运行时（Chrome 扩展 `chrome-plugin/` 与 IntelliJ 插件 `intellij-plugin/`）。

## 支持的版本

只有最新的正式版会收到安全修复。请先升级到 [最新 Release](https://github.com/javaside/english-syntax-extension/releases/latest) 再报告问题。

## 报告漏洞

**不要用公开 issue 报告安全漏洞。**

请通过 GitHub 的 [私密漏洞报告](https://github.com/javaside/english-syntax-extension/security/advisories/new) 提交。请尽量包含：

- 受影响的版本与运行时（Chrome 扩展 / IntelliJ 插件）
- 复现步骤，以及能证明影响的最小页面或模型响应
- 你认为的影响面（凭据泄露 / 页面内代码执行 / 越权读取存储等）

我会在收到后尽快确认，修复后在 Release 说明中致谢（如你不愿具名请说明）。

## 项目怎么处理你的敏感数据

弄清这些有助于判断某个行为是不是漏洞：

**Chrome 扩展：**

- **API Key 与自定义请求头只存在本地** `chrome.storage.local`，且该存储被设为 `TRUSTED_CONTEXTS`，**内容脚本读不到**。它们只在 Service Worker 里被取出并放进模型请求。
- **凭据不会进入渲染结果**。模型响应在送回页面前会做脱敏：响应中若混入 API Key 或请求头值，会被替换为 `[redacted]`。流式分片走同一套脱敏，不因为「只是预览」而跳过。
- **不申请常驻 host 权限**。模型端点的访问权限在配置时按需申请，仅限所填 origin；页面访问走 `activeTab`，只在用户主动触发时生效。
- **缓存**存在本地 IndexedDB，可在选项页清空或导出。导出文件包含已解析的句子与译文，分享前请自行确认其中没有敏感页面内容。

**IntelliJ 插件：**

- **API Key 只存 PasswordSafe**（经 `CredentialStore`），不进入插件状态文件、发往 JCEF 预览页的脚本、桥消息、SQLite 缓存或日志。发往预览页的消息在入口经键白名单过滤，`apiKey`/`headers`/`baseUrl` 等字段整体拒绝。
- **缓存**存在本地 SQLite，可清空或与 Chrome 扩展的导出文件双向导入导出。

**两个运行时共同：**

- **发给模型的内容**只有待解析的句子文本及其 Token，不含页面 URL、Cookie 或其他页面数据。唯一例外是「纠错重解析」会把你手写的反馈文本一并发送。
- **模型译文按纯文本渲染**，不会作为 HTML 解析——恶意模型响应里的脚本不会执行。

## 不属于安全漏洞的情形

- 你自己配置的第三方模型端点如何处理发送过去的句子——那取决于该服务的隐私政策，请自行评估。
- 需要用户手动安装恶意扩展或手动改本地存储才能触发的问题。
