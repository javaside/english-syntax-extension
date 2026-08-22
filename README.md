# English Syntax Learning —— 英语句法学习（双平台）

[![CI](https://github.com/javaside/english-syntax-extension/actions/workflows/ci.yml/badge.svg)](https://github.com/javaside/english-syntax-extension/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/javaside/english-syntax-extension)](https://github.com/javaside/english-syntax-extension/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**[⬇️ 下载最新版](https://github.com/javaside/english-syntax-extension/releases/latest)** · [更新日志](CHANGELOG.md) · [参与贡献](CONTRIBUTING.md)

同一套「英语句法伴读」的两个平台实现，仓库根下两个平级子模块：

- **`chrome-plugin/`** —— Manifest V3 Chrome 扩展：把网页中的英文段落替换为**逐句句法拆解卡片**（成分角色 / 英文原文 / 成分中文释义三行对照），点击任意成分再懒加载该成分的详细语法解析。分析由你自己配置的 OpenAI 兼容模型完成（DeepSeek、本地 Ollama、任何兼容 `/chat/completions` 的服务）。**[↓ 直接往下读]**
- **`intellij-plugin/`** —— IntelliJ IDEA Markdown 预览插件：在 IDEA 自带的 Markdown 预览里做同样的句法拆解，SQLite 缓存与 Chrome 扩展互通（可导入导出），API Key 存 PasswordSafe。使用说明见下方[「IntelliJ 插件」](#intellij-插件)一节。

两个运行时不共享运行代码，只共享契约（分句/缓存键向量由 `shared-fixtures/` 双端测试同时钉住）。

## 功能特性

**两个平台共有的核心体验：**

- **逐句成分拆解卡片**：英文段落就地替换为「成分角色 / 英文原文 / 中文释义」三层对齐的卡片，主谓宾定状补 + 五类从句按类型着色，不打断阅读位置；
- **点击成分看详解**：懒加载该成分的内部结构、语法点与整体解释，详解按成分区间单独缓存；
- **任意 OpenAI 兼容模型**：多套配置可切换，保存时探测端点能力（JSON Schema / 流式 / 思考控制），不支持时自动降级，无需手动适配；
- **思考模型自动关思考**：默认要求模型不做推理直接作答（实测单句从 153 秒降到 1.4 秒），端点拒绝该参数时自动去掉重发；
- **按句缓存，跨端互通**：缓存键只含规范化句文本，换模型换配置仍命中；Chrome 扩展（IndexedDB）与 IntelliJ 插件（SQLite）的缓存可双向导入导出；
- **可逆替换**：任何时刻停止学习都能完整恢复原文，不改动你的文件或页面；
- **无遥测、无后端**：除了你自己配置的模型端点，不向任何服务器发请求。

**Chrome 扩展独有：** 整页 / 悬停段落（`Alt+T`）/ 右键选区三种解析入口；流式渐进渲染（成分逐个出现）；视口驱动增量分析；纠错重解析。

**IntelliJ 插件独有：** 在 IDEA 默认的 Markdown 预览内工作（无需切换 provider）；API Key 存系统级 PasswordSafe；Tools 菜单提供开始 / 暂停 / 停止。

## 环境要求

- Chrome 扩展（普通使用）：Chrome / Chromium ≥ 120（Manifest V3、`storage.setAccessLevel`），不需要 Node
- IntelliJ 插件（普通使用）：IntelliJ IDEA（Community / Ultimate）2025.1+，需 JetBrains Runtime（IDEA 默认运行时即含 JCEF）
- Chrome 扩展开发：另需 Node.js ≥ 22.20（`chrome-plugin/package.json` 的 `engines` 是硬要求）、npm ≥ 10
- IntelliJ 插件开发：另需 JDK 21 + Gradle（仓库根 `./gradlew ...`），web 桥测试在 `intellij-plugin/` 里 `npm ci`

## 安装

### Chrome 扩展

推荐直接下载打包好的版本，不需要 Node 环境：

1. 到 [Releases](https://github.com/javaside/english-syntax-extension/releases) 下载最新的 `english-syntax-extension-vX.Y.Z.zip`；
2. 解压到一个**不会被删掉**的目录（Chrome 每次启动都会从这个目录读取）；
3. 按下面「加载到 Chrome」的步骤选择该目录。

各版本的变化见 [CHANGELOG.md](CHANGELOG.md)。

### IntelliJ 插件

1. 从[ Releases](https://github.com/javaside/english-syntax-extension/releases) 下载 `intellij-plugin-X.Y.Z.zip`（或按[「打包分发」](#打包分发)自行构建）；
2. IDEA 里 `Settings/Preferences → Plugins → ⚙ → Install Plugin from Disk…`，选择该 zip，按提示重启；
3. 要求 IntelliJ IDEA 2025.1+ 且运行时含 JCEF（IDEA 官方发行版默认满足；若你换过运行时，见下方故障排查）。

## 从源码构建

```bash
git clone https://github.com/javaside/english-syntax-extension.git
cd english-syntax-extension/chrome-plugin
npm ci          # 安装依赖
npm run build   # 类型检查 + 产出 dist/
```

IntelliJ 插件从源码构建（需 JDK 21）：仓库根 `./gradlew :intellij-plugin:buildPlugin`。

## 打包分发

### Chrome 扩展 zip

在 `chrome-plugin/` 里：

```bash
npm run package   # = npm run build + scripts/package-extension.mjs 打 zip
```

产物是 `chrome-plugin/release/english-syntax-extension-vX.Y.Z.zip`（名字带版本号，内容为解压即用的 `dist/`，已剔除 source map）。想本地验证这个 zip：解压到任意目录，按「加载到 Chrome」选择该目录即可——与下载 Release 包的用法完全一致。

### IntelliJ 插件 zip

仓库根（需 JDK 21）：

```bash
./gradlew :intellij-plugin:buildPlugin
```

产物是 `intellij-plugin/build/distributions/intellij-plugin-X.Y.Z.zip`。在 IDEA 里安装：`Settings → Plugins → ⚙ → Install Plugin from Disk…` 选择该 zip。需要 JetBrains Runtime（JCEF）的 IDEA 运行时，社区版 2025.1+ 可用。

### 正式发版

发版有专门的流水线（版本一致性校验、全套门禁、CHANGELOG 切片、CI 建 draft release），维护者走 `chrome-plugin/` 里的 `npm run release -- X.Y.Z`，细节见[构建·测试·发布文档](docs/architecture/build-test-release.md)。

## 加载到 Chrome

1. 打开 `chrome://extensions`；
2. 右上角开启「开发者模式」；
3. 点「加载已解压的扩展程序」，选择解压出的目录（从源码构建则选 `dist/`）；
4. 工具栏出现扩展图标即加载成功。

> Chrome 会周期性提示「禁用开发者模式扩展」，选择保留即可——本扩展只通过 GitHub Release 分发，未上架应用商店。

## 配置模型（选项页）

右键扩展图标 →「选项」，或在弹窗中点右上角 ⚙︎（未配置模型时主按钮就是「去配置模型」）。

**示例一：DeepSeek**

| 字段       | 值                            |
| ---------- | ----------------------------- |
| 配置名称   | DeepSeek                      |
| Base URL   | `https://api.deepseek.com/v1` |
| API Key    | 你的 DeepSeek Key             |
| 模型名     | `deepseek-v4-flash`           |
| 超时（秒） | 120                           |

> 模型名以 [DeepSeek 官方文档](https://api-docs.deepseek.com/zh-cn/) 为准：当前推荐 `deepseek-v4-flash`（更强但更贵可选 `deepseek-v4-pro`）；旧模型名 `deepseek-chat`、`deepseek-reasoner` 已于 2026-07-24 弃用。测试连接若提示「已自动采用兼容模式」属正常现象（DeepSeek 不提供 JSON Schema 严格模式），不影响任何功能。思考模型（Qwen3、DeepSeek v4 等）会为一句话先生成上万 token 推理——扩展默认已要求模型不做思考，端点不接受该参数时会自动去掉并重发，**无需任何设置**，一般 2 秒内返回。

**示例二：本地 Ollama**

| 字段       | 值                                    |
| ---------- | ------------------------------------- |
| 配置名称   | 本地 Ollama                           |
| Base URL   | `http://localhost:11434/v1`           |
| API Key    | `ollama`（Ollama 不校验，但字段必填） |
| 模型名     | `qwen2.5:14b` 等已拉取的模型          |
| 超时（秒） | 120（本地推理较慢）                   |

点「测试连接」会：请求**该模型地址的精确主机权限**（Chrome 弹出授权框，需手动允许）→ 发送一次最小 JSON 探测请求 → 报告该模型是否支持 JSON Schema 结构化输出（不支持会自动使用兼容模式）。

## 使用（Chrome 扩展）

1. 打开一篇英文文章页面（`http`/`https`）；
2. 点扩展图标 →「开始学习」（弹窗只有这一个主按钮，随状态变化）；
3. 或者不开整页学习：把鼠标悬停在某个段落上按 `Alt+T`（Mac：`Option+T`），只解析该段；快捷键可在 `chrome://extensions/shortcuts` 修改；
4. 视口内及附近的英文段落被替换为句法标注：成分名在上、按成分类型着色的细下划线、中文翻译在下；向下滚动增量分析；
5. 解析期间页面右下角有进度胶囊（「句法解析中 n/m」），完成后自动消失；
6. 点击任意成分 → 懒加载该成分的详细解析；
7. 主按钮即状态机：解析中点击=「暂停」，暂停后点击=「继续学习」，全部完成后点击=「恢复网页原文」；
8. 切换模型：设置页「已保存配置」选中目标配置 →「设为启用」（当前启用项带「（启用中）」标记）。

## IntelliJ 插件

在 IDEA 里阅读英文 Markdown（文档、笔记、README）时，把默认的 Markdown 预览变成句法学习界面。**不修改源文件**，停止后完整恢复官方预览。

**使用步骤：**

1. `Settings → Tools → English Syntax Learning` 配置模型（与 Chrome 扩展同一套配置思路：Base URL / API Key / 模型名 / 超时；可存多份，一份为 Active）。API Key 存系统级 PasswordSafe，不进任何配置文件或日志；
2. 打开一个 `.md` 文件并切到预览（`Ctrl/Cmd+Shift+A` 搜 "Preview"，或编辑器右上角的预览图标）——用 IDEA 默认预览即可，插件不需要你切换任何 provider；
3. 菜单 `Tools → 句法学习 → 开始句法学习`；
4. 预览中可见及附近的英文段落被替换为句法卡片，点击成分看详解——体验与 Chrome 扩展一致；
5. 预览页右下角有进度浮层；`Tools → 句法学习` 里可暂停 / 继续 / 停止（停止即恢复原文）；
6. Markdown 源文件继续编辑时预览会重渲染，插件自动换代重新扫描，未变化的句子直接从缓存恢复。

**与 Chrome 扩展互通：** 插件设置页可导入 Chrome 扩展现出的缓存文件（反向亦可），同一批文档两端阅读零重复请求。

## 权限说明（Chrome 扩展）

| 权限                        | 用途                                                                              |
| --------------------------- | --------------------------------------------------------------------------------- |
| `activeTab` + `scripting`   | 仅在你点击「开始学习」后向当前标签页注入内容脚本                                  |
| `storage`                   | 保存模型配置；已设置 `TRUSTED_CONTEXTS`，**内容脚本（网页侧）读不到你的 API Key** |
| `contextMenus`              | 右键菜单入口                                                                      |
| `optional_host_permissions` | 模型地址按需精确授权（保存/测试配置时才弹授权框），不预先索要任何网站权限         |

清单中**没有**预置 `host_permissions`——扩展默认无权访问任何网站或模型地址。

（IntelliJ 插件不申请任何系统权限：只在 IDEA 内的 Markdown 预览里工作，模型请求由 IDE 进程直接发出，网络访问范围就是你自己填的模型端点。）

## 发送给模型的内容与隐私

- 发送：被分析段落的**英文句子文本及分词结果**、你的纠错反馈文本；
- 不发送：页面 URL 以外的浏览记录、Cookie、表单内容、页面截图；
- API Key 仅存于扩展的 `chrome.storage.local`（受 TRUSTED_CONTEXTS 保护），**不做加密**——请注意任何能读取你 Chrome 用户目录的本地程序理论上都能拿到它；不要在共享电脑上保存高价值 Key。

完整的隐私声明见 [PRIVACY.md](PRIVACY.md)。

## 缓存

分析结果缓存在扩展的 IndexedDB 中（核心/详解/纠错三类）。**缓存键只含规范化句文本、schema 版本与（详解的）成分区间——刻意不含模型地址、模型名与提示词版本**，所以换模型、换配置后同一句话仍命中缓存，换页重读**零模型调用**。选项页可设置缓存上限（10–200 MB）并一键「清空缓存」（不会删除模型配置），还能把缓存导出成文件（与 IntelliJ 插件互通导入）。

## 不支持的页面

`chrome://`、`chrome-extension://`、Chrome 应用商店、PDF 查看器、本地 `file://`（除非你在扩展详情里手动允许）等无法注入内容脚本，弹窗会提示「此页面不支持句法解析」。

IntelliJ 插件只处理 Markdown 预览里的正文段落；代码块、表格、数学公式、Mermaid 图、脚注区域不解析。

## 开发与测试

Chrome 扩展（在 `chrome-plugin/` 里）：

```bash
cd chrome-plugin
npm test              # 单元测试（vitest，746+ 用例，含架构文档同步断言）
npm run test:e2e      # 端到端测试（Playwright + 真实 Chromium 加载 dist/，本地模型伪服务，无外网依赖）
npm run build         # 类型检查 + 构建
npm run lint          # ESLint（typescript-eslint typeChecked）
npm run format:check  # Prettier
```

IntelliJ 插件（Kotlin 测试在仓库根跑，web 侧 TS 测试在 `intellij-plugin/` 里跑）：

```bash
# 仓库根
./gradlew :intellij-plugin:test :intellij-plugin:buildPlugin

# intellij-plugin/ 里
npm ci && npm test    # 预览页桥协议/渲染的 vitest（happy-dom）
```

首次跑 E2E 需要 `npx playwright install chromium`。

E2E 说明：MV3 可选主机权限的授权框是**原生对话框**，无法在无头环境自动点击，因此 E2E 构建会把 dist 复制到临时目录并把两个回环地址提升为必需 `host_permissions`；正式 `dist/manifest.json` 保持可选授权不变，且有专门用例断言这一点。测试语料见 `chrome-plugin/tests/fixtures/teaching-sentences.json`（12 类句型 × 3 句），CI 只校验分词与覆盖不变量，从不断言某个模型的唯一正确拆分。

## 故障排查

| 现象                                                  | 原因与处理                                                                                                                                                                                    |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 测试连接提示「鉴权失败」 / 学习卡片显示 `AUTH_FAILED` | API Key 错误或已吊销。修正 Key 保存后点卡片上的「重新解析」；同一无效 Key 会被暂停以避免反复计费请求，**更新 Key 后自动恢复**                                                                 |
| 卡片短暂等待后才出结果，偶发 `RATE_LIMITED`           | 命中限流（HTTP 429）。扩展会按 `Retry-After` 自动重试；频繁出现请降低滚动速度或换用限流更宽松的模型                                                                                           |
| 测试连接提示「网络连接失败」                          | Base URL 写错、服务未启动，或是**浏览器 CORS/私网限制**：远程服务需允许来自扩展的跨域请求（正常的 OpenAI 兼容服务都允许）；本地服务请确认用 `http://localhost` 或 `http://127.0.0.1` 并已授权 |
| 测试连接提示「未获得模型地址访问权限」                | 你在授权框点了拒绝。重新保存配置并在弹出的授权框中选择「允许」                                                                                                                                |
| 卡片显示 `INVALID_MODEL_OUTPUT`                       | 模型返回了无法解析/不完整的 JSON。扩展已自动做过一次结构修复仍失败；点「重新解析」重试，或换用结构化输出更稳定的模型（选项页会探测 JSON Schema 支持）                                         |
| 句子显示 `SENTENCE_TOO_LONG`                          | 单句超过 2000 字符（多为伪正文），该句跳过，不影响其他句子                                                                                                                                    |
| 部分句子成功、个别句子失败                            | 设计如此——失败按句隔离，失败句保留原文并提供「重新解析」按钮                                                                                                                                  |
| IntelliJ 里「开始句法学习」灰色不可点                  | 当前选中的文件不是 Markdown，或运行时不支持 JCEF——切换到含 JCEF 的 JetBrains Runtime（IDEA 官方发行版默认满足）后重启                                                                        |
| IntelliJ 点了开始但提示「未找到 Markdown 预览面板」    | 先打开 `.md` 文件的预览（编辑器右上角预览图标），再执行开始                                                                                                                                   |

## 目录结构

```
english-syntax-extension
├── chrome-plugin/             # Chrome MV3 扩展（完整 npm 工程）
│   ├── manifest.json          # MV3 清单（构建期生成 dist/manifest.json）
│   ├── src
│   │   ├── background/        # Service Worker：消息路由、分析服务、缓存、调度、OpenAI 兼容适配器
│   │   ├── content/           # 内容脚本：扫描、视口观察、学习卡片（Shadow DOM）、原文替换/还原
│   │   ├── language/          # 分句、分词、模型输出校验
│   │   ├── options/ popup/    # 选项页与弹窗
│   │   └── shared/            # 协议、错误码、语法角色等共享类型
│   ├── scripts/               # 打包、发版、lint 基线、文档漂移检查等工程脚本
│   └── tests/                 # Playwright E2E、伪模型服务、固定页面与教学语料
├── intellij-plugin/           # IntelliJ IDEA Markdown 预览插件
│   ├── src/main/kotlin/       # Kotlin：领域模型、调度、SQLite 缓存、JCEF 桥、会话与 Action
│   ├── src/main/resources/web # 预览页 TS（扫描/渲染/桥），测试在子目录 npm 独立跑
│   └── build.gradle.kts       # Gradle IntelliJ Platform 构建
├── shared-fixtures/           # 双端共享的契约与测试向量（TS/Kotlin 同时消费）
├── docs/
│   ├── architecture/          # 架构文档：总览、模块地图、协议、两条主链路、不变量
│   └── superpowers/           # 各功能的设计稿与实现计划（写于实现之前）
└── .github/                   # CI（三 job）、发版流水线、issue 模板、dependabot
```

想深入代码，先读 **[架构文档](docs/architecture/README.md)**：一页概览 + 「要改 X 就去 Y」索引 + 已踩过的坑清单，比通读源码快得多。日常开发的门禁与工程约定见 [`AGENTS.md`](AGENTS.md)。

## 许可证

[MIT](LICENSE)

## 参与与反馈

- 提问题或提建议：[Issues](https://github.com/javaside/english-syntax-extension/issues)
- 想动手改：先看 [CONTRIBUTING.md](CONTRIBUTING.md)，尤其是「lint 基线是恰好 1 个错误」和协议三层校验那几条
- 隐私说明：[PRIVACY.md](PRIVACY.md)——不收集任何数据，开发者收不到你的任何信息
- 安全问题：请走 [私密报告](https://github.com/javaside/english-syntax-extension/security/advisories/new)，不要开公开 issue，详见 [SECURITY.md](SECURITY.md)
- 参与本项目即表示你同意遵守 [行为准则](CODE_OF_CONDUCT.md)
