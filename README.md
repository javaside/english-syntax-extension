# English Syntax Learning —— Chrome 英语句法学习扩展

[![CI](https://github.com/javaside/english-syntax-extension/actions/workflows/ci.yml/badge.svg)](https://github.com/javaside/english-syntax-extension/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/javaside/english-syntax-extension)](https://github.com/javaside/english-syntax-extension/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**[⬇️ 下载最新版](https://github.com/javaside/english-syntax-extension/releases/latest)** · [更新日志](CHANGELOG.md) · [参与贡献](CONTRIBUTING.md)

一个 Manifest V3 Chrome 扩展：把网页中的英文段落替换为**逐句句法拆解卡片**（成分角色 / 英文原文 / 成分中文释义三行对照），点击任意成分再懒加载该成分的详细语法解析。分析由你自己配置的 OpenAI 兼容模型完成（DeepSeek、本地 Ollama、任何兼容 `/chat/completions` 的服务）。

## 环境要求

- Node.js ≥ 20（本项目在 Node 22 上开发验证）
- npm ≥ 10
- Chrome / Chromium ≥ 120（Manifest V3、`storage.setAccessLevel`）

## 安装

普通使用推荐直接下载打包好的版本，不需要 Node 环境：

1. 到 [Releases](https://github.com/javaside/english-syntax-extension/releases) 下载最新的 `english-syntax-extension-vX.Y.Z.zip`；
2. 解压到一个**不会被删掉**的目录（Chrome 每次启动都会从这个目录读取）；
3. 按下面「加载到 Chrome」的步骤选择该目录。

各版本的变化见 [CHANGELOG.md](CHANGELOG.md)。

## 从源码构建

仓库根下有两个平级子模块：`chrome-plugin/`（本扩展，完整 npm 工程）与 `intellij-plugin/`（IDEA Markdown 预览插件，Gradle 工程）。

```bash
git clone https://github.com/javaside/english-syntax-extension.git
cd english-syntax-extension/chrome-plugin
npm ci          # 安装依赖
npm run build   # 类型检查 + 产出 dist/
```

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

> 模型名以 [DeepSeek 官方文档](https://api-docs.deepseek.com/zh-cn/) 为准：当前推荐 `deepseek-v4-flash`（更强但更贵可选 `deepseek-v4-pro`）；旧模型名 `deepseek-chat`、`deepseek-reasoner` 将于 2026-07-24 弃用。测试连接若提示「已自动采用兼容模式」属正常现象（DeepSeek 不提供 JSON Schema 严格模式），不影响任何功能。推理类模型每段分析需要先输出思维链，耗时约 20–60 秒，建议超时设 120 秒。

**示例二：本地 Ollama**

| 字段       | 值                                    |
| ---------- | ------------------------------------- |
| 配置名称   | 本地 Ollama                           |
| Base URL   | `http://localhost:11434/v1`           |
| API Key    | `ollama`（Ollama 不校验，但字段必填） |
| 模型名     | `qwen2.5:14b` 等已拉取的模型          |
| 超时（秒） | 120（本地推理较慢）                   |

点「测试连接」会：请求**该模型地址的精确主机权限**（Chrome 弹出授权框，需手动允许）→ 发送一次最小 JSON 探测请求 → 报告该模型是否支持 JSON Schema 结构化输出（不支持会自动使用兼容模式）。

## 使用

1. 打开一篇英文文章页面（`http`/`https`）；
2. 点扩展图标 →「开始学习」（弹窗只有这一个主按钮，随状态变化）；
3. 或者不开整页学习：把鼠标悬停在某个段落上按 `Alt+T`（Mac：`Option+T`），只解析该段；快捷键可在 `chrome://extensions/shortcuts` 修改；
4. 视口内及附近的英文段落被替换为句法标注：成分名在上、按成分类型着色的细下划线、中文翻译在下；向下滚动增量分析；
5. 解析期间页面右下角有进度胶囊（「句法解析中 n/m」），完成后自动消失；
6. 点击任意成分 → 懒加载该成分的详细解析；
7. 主按钮即状态机：解析中点击=「暂停」，暂停后点击=「继续学习」，全部完成后点击=「恢复网页原文」；
8. 切换模型：设置页「已保存配置」选中目标配置 →「设为启用」（当前启用项带「（启用中）」标记）。

## 权限说明

| 权限                        | 用途                                                                              |
| --------------------------- | --------------------------------------------------------------------------------- |
| `activeTab` + `scripting`   | 仅在你点击「开始学习」后向当前标签页注入内容脚本                                  |
| `storage`                   | 保存模型配置；已设置 `TRUSTED_CONTEXTS`，**内容脚本（网页侧）读不到你的 API Key** |
| `contextMenus`              | 右键菜单入口                                                                      |
| `optional_host_permissions` | 模型地址按需精确授权（保存/测试配置时才弹授权框），不预先索要任何网站权限         |

清单中**没有**预置 `host_permissions`——扩展默认无权访问任何网站或模型地址。

## 发送给模型的内容与隐私

- 发送：被分析段落的**英文句子文本及分词结果**、你的纠错反馈文本；
- 不发送：页面 URL 以外的浏览记录、Cookie、表单内容、页面截图；
- API Key 仅存于扩展的 `chrome.storage.local`（受 TRUSTED_CONTEXTS 保护），**不做加密**——请注意任何能读取你 Chrome 用户目录的本地程序理论上都能拿到它；不要在共享电脑上保存高价值 Key。

## 缓存

分析结果缓存在扩展的 IndexedDB 中（核心/详解/纠错三类，键含模型地址、模型名、提示词版本），同一句子换页重读**零模型调用**。选项页可设置缓存上限（10–200 MB）并一键「清空缓存」（不会删除模型配置）。

## 不支持的页面

`chrome://`、`chrome-extension://`、Chrome 应用商店、PDF 查看器、本地 `file://`（除非你在扩展详情里手动允许）等无法注入内容脚本，弹窗会提示「此页面不支持句法解析」。

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

IntelliJ 插件：仓库根 `./gradlew :intellij-plugin:test :intellij-plugin:buildPlugin`；web 侧 TS 测试在 `intellij-plugin/` 里 `npm ci && npm test`。

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
│   └── tests                  # Playwright E2E、伪模型服务、固定页面与教学语料
├── intellij-plugin/           # IntelliJ IDEA Markdown 预览插件（Gradle 工程）
├── shared-fixtures/           # 双端共享的契约与测试向量（TS/Kotlin 同时消费）
└── docs/architecture/         # 架构文档：总览、模块地图、协议、两条主链路、不变量
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
