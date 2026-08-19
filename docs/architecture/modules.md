# 模块地图

每个源文件一行职责。**绝大多数 `*.ts` 旁边都有同名 `*.test.ts`**(下表不重复列出),想知道某模块的确切行为,读它的测试比读实现快。

以下各表的路径都相对于 `chrome-plugin/`(intellij-plugin 一节除外)。三个例外:`shared/errors.ts` 与 `shared/versions.ts` 是纯常量,没有测试;`content/content-script.ts` 的测试在 `content/session-controller.test.ts` 里(`ContentScriptRouter` 与 `isRuntimeResponse` 两组)。反过来,`shared/manifest.test.ts` 与 `language/teaching-sentences.test.ts` 没有对应的实现文件——它们钉的是仓库里的 JSON。

## chrome-plugin/src/shared —— 两侧共用的契约

| 文件               | 职责                                               | 关键导出                                                                                                                                                                                                                                |
| ------------------ | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `protocol.ts`      | 扩展内部消息的**唯一真相**:类型定义 + 运行时守卫   | `RequestMessage` / `ResponseMessage` / `SessionStatus` / `CoreStreamPush` / `DetailStreamPush` / `isRequestMessage` / `isCoreStreamPush` / `isDetailStreamPush` / `isSessionComplete` / `MAX_SENTENCES_PER_REQUEST`(=6) / `assertNever` |
| `grammar.ts`       | 语法角色枚举与分析结果的数据模型                   | `GrammarRole`(16 个) / `GRAMMAR_LABELS`(中文标签) / `Token` / `TokenRange` / `CoreComponent` / `CoreAnalysis` / `DetailStructure` / `DetailAnalysis`                                                                                    |
| `errors.ts`        | 全部错误码                                         | `ERROR_CODES`(13 个) / `ExtensionError`                                                                                                                                                                                                 |
| `versions.ts`      | 四个版本常量                                       | `MESSAGE_VERSION` / `CORE_SCHEMA_VERSION` / `CORE_PROMPT_VERSION` / `DETAIL_PROMPT_VERSION`                                                                                                                                             |
| `manifest.test.ts` | 钉住 manifest 的权限形态、快捷键、图标、版本一致性 | —                                                                                                                                                                                                                                       |

## chrome-plugin/src/language —— 纯函数,无 DOM、无 chrome API

| 文件                         | 职责                                                                                                                                                                                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `segmenter.ts`               | `segmentBlock()` 用 `Intl.Segmenter` 分句(带 `Mr.`/`e.g.` 等缩写合并);`tokenize()` 切词并标注 `punctuation`;`rebuildTokens()` 无损还原;`createSentenceId()` = SHA-256(sessionId+blockId+order+归一化文本) 取前 24 位 |
| `analysis-validator.ts`      | `validateCoreBatch()` / `validateDetail()`——模型输出的最终裁判:字段白名单、区间在句内、成分有序不重叠、**非标点 token 恰好被覆盖一次**、译文长度上限、危险文本拦截                                                   |
| `teaching-sentences.test.ts` | 校验 `tests/fixtures/teaching-sentences.json`(chrome-plugin 内)教学语料的结构不变量(12 类 × 3 句、分句、无损分词、词元数)。**刻意不断言任何模型答案**                                                                                 |

## chrome-plugin/src/background —— Service Worker 世界

| 文件                           | 职责                                                                                                                                                                    |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `service-worker.ts`            | 消息路由、来源与权限门、脱敏、`activeTabs` 持久化、端口管理、右键菜单 / 快捷键 / 图标点击的监听器注册、依赖装配                                                         |
| `analysis-service.ts`          | **核心编排**:缓存查找 → 按端点分块 → 提示词 → 调度 → 校验 → 一次修复 pass → 写缓存。同时实现 `lookupCore` / `lookupDetail`(纯缓存)与 `analyzeSentenceDetails`(整句预载) |
| `openai-compatible-adapter.ts` | HTTP 层:请求体构造、鉴权头、超时(流式为静默超时)、HTTP 错误映射、**三种能力降级**、流式读取                                                                             |
| `request-scheduler.ts`         | 通用优先级调度器:5 档优先级、`concurrency` / `backgroundConcurrency`、同 key 去重、可重试错误的指数退避、按 `documentId` 批量取消                                       |
| `analysis-cache.ts`            | IndexedDB(`english-syntax-learning-v1`,v2,三个 store:core/detail/correction)+ LRU 限额 + 导入导出;缓存键工厂 `createCoreCacheKey` / `createCorrectionCacheKey`          |
| `config-repository.ts`         | `chrome.storage.local` 里的 profile 与全局开关的读写与校验;`ModelProfile` 类型定义在这里                                                                                |
| `prompts.ts`                   | 全部提示词的构造与**序列化策略**(紧凑 JSON、精简 Token 载荷)                                                                                                            |
| `base-url.ts`                  | `normalizeBaseUrl`(强制 HTTPS,localhost 例外)/ `chatCompletionsUrl` / `hostPermissionPattern` / `isLoopbackBaseUrl`                                                     |
| `sse.ts`                       | 极简 SSE 解码器:只处理 `data:` 字段、空行边界、注释、CRLF,跨 chunk 缓冲半行                                                                                             |
| `core-stream-parser.ts`        | 从**还在流式中的** core 信封里逐个抠出闭合的 component,并归属到正确的 `sentenceId`                                                                                      |
| `detail-stream-parser.ts`      | 同上,但针对 detail 信封的 `structures[]`(信封是扁的,不需要归属;`focus` 对象在 `structures` 之前,所以必须按 key 判定而非数括号深度)                                      |

## chrome-plugin/src/content —— 页面世界

| 文件                       | 职责                                                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `content-script.ts`        | 三件事:①`ContentScriptRouter` 路由 SW 下发的页面命令;②`ChromeRuntimeTransport` 传输层(sendMessage + 端口 + 重连);③`isRuntimeResponse()` **响应守卫**   |
| `session-controller.ts`    | **最重的一个文件**:会话状态机、块与句的注册、相位流转、合批窗口、发请求与版本守卫、详解 / 纠正交互、MutationObserver、断线重连、状态上报               |
| `document-scanner.ts`      | `scanDocument()`(自动扫描:选正文容器 → 收候选块)与 `nearestSafeBlock()`(显式手势:从光标往上找最近的安全叶子块)。**两者的取舍刻意不同**                 |
| `viewport-observer.ts`     | `IntersectionObserver`(`rootMargin: 100%`)包一层,不支持时退回 scroll/resize + rAF 轮询;`isVisible()` 供优先级判定                                      |
| `learning-block.ts`        | Shadow DOM 卡片:三行成分、角色配色、并列分句编号、标点归属、详解面板的插入位置与内容、失败 / 跳过 / 重试的渲染                                         |
| `block-replacement.ts`     | **可逆替换**:给原元素加一个唯一 hide class + 注入对应 `display:none` 样式,卡片插在其后;`restore()` 精确还原(包括原本没有 `class` 属性时删掉空 `class`) |
| `block-activity-marker.ts` | 段落"正在解析"的蓝色竖条。**用 data 属性 + inset box-shadow**,不用 class、不用 border                                                                  |
| `detail-prefetcher.ts`     | 详解预载队列:按句去重、并发 2、暂停 / 恢复、块失效时丢弃、成分级计数(total / ready / failed)                                                           |
| `progress-pill.ts`         | 页面右下角进度胶囊。纯展示,从不发命令                                                                                                                  |

## chrome-plugin/src/popup / src/options —— 扩展 UI

| 文件                          | 职责                                                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `popup/popup.ts`              | 主按钮的四态文案与命令映射、次按钮「恢复网页原文」、会话活跃时 1 秒轮询状态、纯缓存模式的引导文案                                           |
| `popup/popup.html` `.css`     | 挂载点与样式                                                                                                                                |
| `options/options.ts`          | profile 增改 / 切换启用 / 测试连接、缓存统计 / 上限 / 清空 / 导入导出、两个开关(预载详解、流式渲染)、把 provider 错误翻译成可操作的中文提示 |
| `options/cache-transfer.ts`   | 缓存导出文件的格式定义与导入校验(格式 / schema 版本 / 键形状)                                                                               |
| `options/options.html` `.css` | 挂载点与样式                                                                                                                                |

## intellij-plugin —— IntelliJ IDEA Markdown 预览插件(第二运行时)

本节路径相对于 `intellij-plugin/`。除 Kotlin/Gradle 工程外,该子目录还有**自己的 npm 工程**(`package.json` / `vitest.config.ts` / `tsconfig.json`):`resources/web/` 的 TS 测试在 `intellij-plugin/` 里 `npm ci && npm test` 独立跑,不依赖 chrome-plugin 的依赖。

| 路径                                         | 职责                                                                                                |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `domain/Domain.kt`                           | Kotlin 领域模型:Token/SentenceInput/CoreAnalysis/DetailAnalysis/错误码,与 TS 契约同构               |
| `language/Segmenter.kt`                      | 分句分词(与 TS `segmenter.ts` 同规则,共享向量钉住)                                                  |
| `language/AnalysisValidator.kt`              | 模型输出校验(与 TS `analysis-validator.ts` 同规则)                                                  |
| `model/Prompts.kt`                           | core/detail/修复 prompt 构造,serialize 不缩进                                                       |
| `model/BaseUrl.kt`                           | URL 规范化与 loopback 判定(决定每请求句数上限)                                                      |
| `model/OpenAiCompatibleClient.kt`            | OpenAI 兼容客户端:缓冲/流式/JSON Schema 降级/reasoning 降级                                         |
| `model/SseDecoder.kt`                        | SSE 逐块解码(静默超时重置)                                                                          |
| `model/CoreStreamParser.kt`                  | core 流式增量解析(暂定成分)                                                                         |
| `model/DetailStreamParser.kt`                | detail 流式增量解析(暂定结构)                                                                       |
| `model/StreamJsonSupport.kt`                 | 流式能力降级位持久化                                                                                |
| `settings/ProfileState.kt`                   | Profile 持久化状态(JsonSchemaSupport 等降级位)                                                      |
| `settings/ProfileRepository.kt`              | Profile 仓库:敏感字段走 CredentialStore(PasswordSafe)                                               |
| `settings/CredentialStore.kt`                | 凭据存储抽象:密钥只进 PasswordSafe,永不入 state                                                     |
| `settings/EnglishSyntaxConfigurable.kt`      | 设置页 UI                                                                                           |
| `scheduler/RequestScheduler.kt`              | 优先级调度器:一请求一槽位、jumpQueue、backgroundConcurrency、按 document 取消(与 Chrome 端同名对应) |
| `cache/CacheKeys.kt`                         | 跨端一致的缓存键(SHA-256,共享向量钉住)                                                              |
| `cache/AnalysisCache.kt`                     | SQLite 缓存:跨 store LRU、单调时间戳、导入合并                                                      |
| `cache/CacheTransfer.kt`                     | 与 Chrome 扩展互通的导出/导入(格式头/schema 校验)                                                   |
| `analysis/AnalysisService.kt`                | 编排:查缓存→分块→调度→校验→一次修复→写缓存;AnalysisServicePort 供测试替换                           |
| `bridge/BridgeProtocol.kt`                   | JCEF 桥协议:键白名单严格校验,apiKey/headers/baseUrl 一律拒绝                                        |
| `markdown/EnglishSyntaxPreviewProvider.kt`   | Markdown 预览 Provider(注册到 org.intellij.markdown.html.panel.provider)                            |
| `markdown/EnglishSyntaxPreviewPanel.kt`      | 预览面板:previewId/generation、桥接入口、dispose 语义                                               |
| `session/PreviewSession.kt`                  | 单预览会话状态机:start/pause/resume/stop、可见块合批、优先级映射、generation 守卫                   |
| `session/PreviewSessionManager.kt`           | 项目级会话管理:每 preview 一个 child Job、活跃预览、Profile 快照刷新                                |
| `actions/PreviewActionSupport.kt`            | Action 启用条件与进度文案(纯函数)                                                                   |
| `actions/StartSyntaxLearningAction.kt`       | 开始句法学习(经 FileEditorManager 定位面板,不扫 Swing)                                              |
| `actions/TogglePauseSyntaxLearningAction.kt` | 暂停/继续切换                                                                                       |
| `actions/StopSyntaxLearningAction.kt`        | 停止并恢复原文                                                                                      |
| `EnglishSyntaxBundle.kt`                     | 消息 bundle 接线                                                                                    |
| `PluginIdentity.kt`                          | 插件身份常量                                                                                        |
| `resources/web/bridge.ts`                    | JS 侧桥协议镜像:hasOnlyKeys + generation 复检,旧代次丢弃                                            |
| `resources/web/preview.ts`                   | 预览 DOM 扫描:候选/排除选择器、英文占比、可见性观察                                                 |
| `resources/web/render.ts`                    | 句法卡片渲染:可逆替换、流式暂定卡、详解面板,XSS 安全 textContent                                    |
| `package.json` / `vitest.config.ts` / `tsconfig.json` | 子工程 npm 工程:web TS 测试(`npm ci && npm test`)独立运行,不挂在 chrome-plugin 依赖下      |

## chrome-plugin/tests / chrome-plugin/scripts

| 路径                                     | 职责                                                                                                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/e2e/fixtures.ts`                  | Playwright harness:构建扩展 → 复制一份 patch 掉 `host_permissions` → 起假模型服务器与固定页服务器 → 提供 `seedProfiles` / `tabIdFor` / `dispatchFromUi` |
| `tests/e2e/extension.spec.ts`            | 主 E2E 套件(30 余例):从选项页配置到流式降级的全链路                                                                                                     |
| `tests/e2e/layout.spec.ts`               | 布局回归:短句共行、译文不撑卡、详解面板锚定与不挤邻句                                                                                                   |
| `tests/e2e/screenshots.spec.ts`          | 商店截图生成(`STORE_SHOTS=1 npm run screenshots`)                                                                                                       |
| `tests/support/fake-openai-server.ts`    | 假 OpenAI 端点:按 prompt 首行识别请求类型、自动编造合法应答、可脚本化注入错误 / 分片 / 非法输出,并记录每次请求                                          |
| `tests/fixtures/pages/*.html`            | E2E 用的各类固定页面(普通文章、动态内容、并列句、错误对照、悬停、折行探针…)                                                                             |
| `tests/fixtures/teaching-sentences.json` | 12 类 × 3 句英语教学语料                                                                                                                                |
| `scripts/release.mjs`                    | 一条命令走完发版:改版本 → 全套门禁 → 打包 → 提交 → 打 tag → 推送                                                                                        |
| `scripts/release-notes.mjs`              | 从 CHANGELOG 切出指定版本那一节 + 补安装说明,作为 Release 正文                                                                                          |
| `scripts/package-extension.mjs`          | 把 `dist/` 打成带版本号的 zip 到 `release/`                                                                                                             |
| `scripts/check-lint-baseline.mjs`        | 与 CI 同法校验 lint 基线(恰好 1 error / 0 warning)                                                                                                      |
| `scripts/check-docs-drift.mjs`           | 按本次 git 改动反查该核对哪几份架构文档(`npm run docs:drift`,提醒而非门禁)                                                                              |
| `scripts/generate-icons.mjs`             | 从源图生成四种尺寸的透明圆角图标(产物已提交,构建不依赖它)                                                                                               |
| `scripts/generate-promo.mjs`             | 生成商店宣传图块,并自查官方图片规范                                                                                                                     |

## "我要改 X" 索引

| 想改的东西                     | 去哪                                                                                                                                           |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 语法角色的种类 / 中文名 / 配色 | `shared/grammar.ts` + `content/learning-block.ts` 的 `ROLE_COLORS`;**同时**要改 `prompts.ts` 的规则句与 `analysis-service.ts` 的 `CORE_SCHEMA` |
| 提示词措辞                     | `background/prompts.ts` —— **改首行前缀会破坏 E2E**(假服务器按首行识别请求类型)                                                                |
| 并发 / 优先级 / 重试           | `background/request-scheduler.ts` + `service-worker.ts` 的 `MODEL_REQUEST_CONCURRENCY`                                                         |
| 一次请求塞几句                 | `shared/protocol.ts` 的 `MAX_SENTENCES_PER_REQUEST` + `analysis-service.ts` 的 `CLOUD_SENTENCES_PER_REQUEST`                                   |
| 超时 / 降级 / HTTP 错误映射    | `background/openai-compatible-adapter.ts`                                                                                                      |
| 缓存键 / 淘汰 / 存储结构       | `background/analysis-cache.ts`(键的构造调用点在 `analysis-service.ts` 末尾三个私有方法)                                                        |
| 校验严格程度                   | `language/analysis-validator.ts`                                                                                                               |
| 哪些页面元素算"段落"           | `content/document-scanner.ts` —— 自动扫描与显式手势是两条路径,别互相套用                                                                       |
| 卡片长相 / 详解面板位置        | `content/learning-block.ts`(样式是文件顶部的 `STYLES` 常量,Shadow DOM 内联)                                                                    |
| 进度文案                       | `content/progress-pill.ts`(页面内)+ `popup/popup.ts`(弹窗)                                                                                     |
| 新增一条内部消息               | 见 [`protocol.md` §6](./protocol.md#6-新增一条消息的三层同步清单)                                                                              |
| 新增一个选项开关               | `background/config-repository.ts` 加读写 → `options/options.ts` 加控件 → 若 content 侧要用,还得由 SW 在 `START_SESSION` 上快照下发             |
