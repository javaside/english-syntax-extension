# 总览:运行时、分层与端到端链路

## 1. 四个运行时上下文

MV3 把扩展拆成互不共享内存的几个世界。**每个模块能做什么,首先取决于它跑在哪个世界里**——这是本项目最多约束的来源。

| 上下文                   | 入口                                             | 能力                                           | 关键限制                                                                                        |
| ------------------------ | ------------------------------------------------ | ---------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **Service Worker(后台)** | `chrome-plugin/src/background/service-worker.ts` | 唯一能发模型请求的地方;持有缓存、调度器、配置  | **空闲约 30 秒即被终止**,内存状态随之清空                                                       |
| **Content script(页面)** | `chrome-plugin/src/content/content-script.ts`    | 读写页面 DOM、扫描段落、渲染卡片               | **读不到 `chrome.storage`**(SW 启动时设了 `TRUSTED_CONTEXTS`);`window.customElements` 为 `null` |
| **Popup(弹窗)**          | `chrome-plugin/src/popup/popup.ts`               | 启停会话、显示进度                             | 关闭即销毁;属于受信任扩展 UI                                                                    |
| **Options(选项页)**      | `chrome-plugin/src/options/options.ts`           | 管理 profile、缓存统计 / 上限 / 导入导出、开关 | 与 SW 同源,**直连同一个 IndexedDB**(大文件不过消息通道)                                         |

### manifest 与权限面(`chrome-plugin/manifest.json`)

`minimum_chrome_version: 120`。权限刻意收得很紧,`manifest.test.ts` 钉住这个形态:

| 项                          | 值                                                          | 为什么                                                                                                         |
| --------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `permissions`               | `activeTab` / `scripting` / `storage` / `contextMenus`      | `scripting` 用于按需注入 content script(**没有 `content_scripts` 静态声明**,不点就不注入)                      |
| `optional_host_permissions` | `https://*/*` / `http://localhost/*` / `http://127.0.0.1/*` | **可选而非必需**——安装时不弹全站权限警告,首次向用户自填的端点发请求时才申请。两个 localhost 是给本地 Ollama 的 |
| `commands`                  | `parse-hovered-block` = `Alt+T`                             | 唯一快捷键                                                                                                     |
| `action`                    | `default_popup` = `popup.html`                              | 无 popup 时才走 `action.onClicked`                                                                             |
| `options_ui`                | `open_in_tab: true`                                         | 选项页要放导入导出与大表格,弹窗尺寸不够                                                                        |

没有 `content_scripts`、没有 `web_accessible_resources`、没有远程代码。E2E 会把可选 host 权限临时提升为必需(见 [`build-test-release.md` §4](./build-test-release.md)),**发布产物保持 optional**,有一例专门断言这点。

由此产生的三条硬性后果,贯穿全仓库:

1. **设置必须由 SW 下发。** content script 拿不到 `chrome.storage`,所以"是否预载详解"这类开关由 SW 在 `START_SESSION` 页面命令上快照传下去。
2. **SW 的内存状态必须能熬过重启。** `activeTabs`(tabId → documentId + status)写进 `chrome.storage.session`;不写的话 SW 重启后会生成新 `documentId`,而页面上的卡片还攥着旧的,后续请求被判成过期文档拒掉,表现为"点成分报错、点重新解析没反应"。
3. **流式分片走端口,不走 `sendMessage`。** content script 建一条名为 `syntax-learning:<documentId>` 的 `runtime.Port`,SW 通过它 `postMessage` 推送分片(`CORE_STREAM` / `DETAIL_STREAM` / `CHAT_STREAM` 三种)。这条端口同时兼任**页面存活探测**:断开即取消该文档的全部在飞请求——含追问对话的独立调度命名空间 `${documentId}:chat`(cancelDocument 精确匹配,不追加这条取消,静默超时的流式回答会在页面关走后无限期占住全局并发槽)。

## 2. 分层

以下与后文所有 `src/...` 路径都在 `chrome-plugin/` 里(intellij-plugin 的对应实现见 `modules.md` 专节)。

```
┌─ src/popup ─────────┐   ┌─ src/options ───────────────┐
│ 启停 / 进度 / 轮询   │   │ profile / 缓存 / 开关        │
└──────────┬──────────┘   └──────────┬──────────────────┘
           │ chrome.runtime.sendMessage(受信任 UI)
           ▼                          ▼
┌──────────────────────────────────────────────────────────┐
│ src/background/service-worker.ts   路由 + 权限门 + 脱敏     │
│   ├── config-repository   profile / 开关(storage.local)   │
│   ├── analysis-service    缓存 → 分块 → 校验 → 修复         │
│   │     ├── prompts               提示词与序列化           │
│   │     ├── request-scheduler     优先级 / 并发 / 重试      │
│   │     ├── openai-compatible-adapter  HTTP / 流式 / 降级   │
│   │     │     ├── sse                  SSE 帧解码          │
│   │     │     ├── core-stream-parser   边流边取成分         │
│   │     │     └── detail-stream-parser 边流边取结构         │
│   │     └── analysis-cache        IndexedDB + LRU          │
│   └── base-url            URL 归一化 / loopback 判定        │
└───────────┬──────────────────────────────────────────────┘
            │ sendMessage 响应  +  syntax-learning:<documentId> 端口推送
            ▼
┌──────────────────────────────────────────────────────────┐
│ src/content/content-script.ts   路由 + 传输 + 响应守卫      │
│   ├── block-diagnosis      段落诊断证据采集                 │
│   ├── diagnosis-panel      段落诊断面板                     │
│   └── session-controller   会话状态机 / 相位 / 合批 / 重连   │
│         ├── document-scanner    正文识别                   │
│         ├── viewport-observer   进入视口即入队               │
│         ├── learning-block      Shadow DOM 卡片与详解面板    │
│         ├── block-replacement   可逆替换原元素               │
│         ├── block-activity-marker 段落"解析中"标记           │
│         ├── detail-prefetcher   详解预载队列                 │
│         └── progress-pill       页面右下角进度胶囊            │
└──────────────────────────────────────────────────────────┘

            src/language   分句 / 分词 / 结果校验(两侧共用)
            src/shared     协议、语法角色、错误码、版本号
```

**依赖方向**:`shared` 与 `language` 谁都可以依赖,它们不依赖任何人;`background` 与 `content` **互不 import**(只通过 `shared/protocol` 里的类型通信);`options` / `popup` 可以直接 import `background` 里的仓储与缓存类(同源同世界)。

## 3. 四个解析入口

一次解析可以由四种方式发起,它们在**是否全页扫描**、**是否降优先级**、**是否需要已有会话**上各不相同:

| 入口                           | 触发                                 | 全页扫描                        | 优先级                                     | 需已有会话   |
| ------------------------------ | ------------------------------------ | ------------------------------- | ------------------------------------------ | ------------ |
| 点扩展图标 / popup「开始学习」 | `action.onClicked` / `START_SESSION` | 是                              | 视口内 `visible-core`,屏外 `prefetch-core` | 否(会创建)   |
| 快捷键 `Alt+T`「解析悬停段落」 | `commands.onCommand`                 | **否**(轻量会话,只解析指到那段) | `visible-core`                             | 否(会冷启动) |
| 右键「解析选中文本」           | `contextMenus`                       | **否**(轻量会话,只解析选中段)  | `visible-core`                             | 否(会冷启动) |
| 右键「解析此区域」             | `contextMenus`                       | 否                              | `visible-core`                             | **是**       |

悬停快捷键与「解析选中文本」同为**轻量冷启动**(显式手势只翻指到的那段,不做全页扫描;选区路径 2026-11-08 才补齐——此前冷启动会连整页一起翻)。轻量会话(快捷键冷启动)后若用户再点图标,`SessionController.start()` 会**补做全页扫描并补建预载器**,升级为完整会话——扫描时以 id 去重,不会把悬停那段注册两次。

右键还有第三个菜单项「诊断:这段为什么没解析」(`syntax-diagnose-block`,page/selection 双上下文)。它**不是解析入口**:只读手势,SW 侧经 `sendPageCommand` 下发 `DIAGNOSE_BLOCK` 给页面采集证据,全程**刻意不写 `activeTabs`**——记账会把未启动会话的 tab 伪造成 running,弹窗随即显示不存在的进行中会话,还会绕过「解析此区域」的 stopped 门。无账 tab 的诊断 `documentId` 因此由 SW 按表记忆复用(模块级 `diagnosisDocumentIds`):每次右键都现生成新 id 的话,content 侧会按 id 再建一个 controller 与 `syntax-learning:<documentId>` 端口,且只在 STOP_SESSION 回收——反复诊断即按次泄漏;会话启动后走账上 id,陈旧记忆随之清除。页面侧 `ContentScriptRouter` 收到后只回 ack,诊断编排异步跑:本地证据立即上 `DiagnosisPanel`,模型解释(`EXPLAIN_DIAGNOSIS` → `analysisService.explainDiagnosis`)走 `detail-click` 档且**不写任何缓存**;该请求**复用会话 transport**(`SessionController.transport` getter)——另开 transport 会建第二个 `syntax-learning:<documentId>` 端口,SW `onConnect` 无条件覆写 `documentPorts`,会话的流式推送就被劫持了。

## 4. 端到端链路:核心解析

```
用户点「开始学习」
  │
  ├─ popup → SW: START_SESSION {tabId, documentId}
  │
  ├─ SW: 注入 content-script.js → 读 activeProfile / prefetchDetail
  │      → tabs.sendMessage(START_SESSION, {prefetchDetail?})     ← 设置快照下发
  │
  ├─ content: SessionController.start()
  │      ├─ scanDocument(document)          正文容器打分 → 候选块
  │      ├─ 每块 segmentBlock + tokenize    → SentenceInput[]（相位 discovered）
  │      │     自定义标点候选边界 → 强非终结/语境缩写分类 → 合并 initial/列表/无实词片段
  │      │     U.S./Ph.D./Inc./Ltd./Co./Corp./etc. 遇小写或数字续片才合并，遇大写新句保留边界
  │      │     点号缩写/数字版本/URL/邮箱各占一个 Token；内部空白用显式 Unicode class
  │      └─ ViewportObserver.observe()      rootMargin 100%,进视口即回调
  │
  ├─ 视口回调 → enqueueForBatch()           按「屏外? × 跳缓存?」分桶
  │      └─ 攒满 6 句或 120ms 窗口到期 → analyzeBlocks()
  │            相位: cache-check → queued → requesting
  │
  ├─ content → SW: ANALYZE_CORE {sentences[], offscreen?, bypassCache?}
  │
  ├─ SW: 无 profile → lookupCore(纯缓存,cacheOnly: true 回包)
  │      profile 被鉴权失败暂停 → 只回缓存命中 + 批级 AUTH_FAILED
  │      否则 → CachedAnalysisService.analyzeCore()
  │            ├─ 逐句算缓存键 → 命中的直接出结果
  │            ├─ 未命中的按端点切块(云 2 句 / 本地 6 句),各块并行
  │            ├─ 每块: buildCorePrompt → scheduler.schedule(优先级)
  │            │        └─ adapter.completeJson[Streaming]()
  │            │              流式时逐分片经 CoreStreamParser 上报暂定成分
  │            │              → SW 经端口推 CORE_STREAM(已脱敏)
  │            ├─ validateCoreBatch()  结构/覆盖率 + 十六条本地语法粒度硬约束 + 译文质量门(含 Han、拒英文回显)
  │            ├─ 不合格 → 错误文案原样进入最多两轮逐轮收窄 repair(jumpQueue,同优先级插队)
  │            └─ 合格 → 写缓存
  │
  ├─ SW → content: CORE_RESULT {analyses[], cacheOnly?, error?}(全部脱敏)
  │
  └─ content: 逐块分发 → learningBlock.renderCore()
         相位 validating → ready(或 failed / skipped)
         → BlockReplacement.show() 把原元素 display:none、卡片插在其后
         → 状态经 relayStatus 回传 SW,并驱动右下角进度胶囊
```

流式开启时,`CORE_STREAM` 分片会让段落**先以未校验的暂定成分显示出来**(`showPreview` 绕过"整块齐备"闸门),完整响应到齐后用已校验结果再渲染一次覆盖。暂定成分**不写缓存、不改相位**(保持 `requesting`,不计入 `ready`),所以它不会让会话被误判为已完成。

## 5. 端到端链路:详解

```
用户点卡片上的某个成分
  │
  ├─ learning-block 派发 CustomEvent syntax-detail-request {sentenceId, focus}
  ├─ SessionController: 关掉全页其它面板 → setDetailLoading()(面板锚在被点那一视觉行下方)
  ├─ content → SW: ANALYZE_DETAIL {sentence, core, focus}
  ├─ SW → analyzeDetail(): 查缓存 → buildDetailPrompt → 调度(detail-click,优先级 1)
  │        流式时经 DetailStreamParser 推 DETAIL_STREAM,面板边收边填标注行
  ├─ validateDetail → 不合格再修一次 → 写缓存
  └─ SW → content: DETAIL_RESULT → renderDetail()(标注行 + 逐条解释 + 语法点 + 整体说明)
```

**预载路径**(选项页开启「预载成分详解」后):每句 core 就绪即 `DetailPrefetcher.enqueue()`,发 `PREFETCH_SENTENCE_DETAILS`——**一次整句请求覆盖该句所有缺失成分**,结果逐成分写进**与点击路径完全相同的缓存键**。于是后续点击零模型调用。

> 缓存键 = 规范化句文本 + schema 版本 + 提示词版本(core 用 `CORE_PROMPT_VERSION`,详解用 `DETAIL_PROMPT_VERSION`)+ focus 区间,**与 profile / 模型无关**。改任一侧的键构造必须两侧同步,并用对方路径读回验证。当前契约为 core `20` / detail `10`(core 17 在 16 的冒号/点分标识符口径上补充名词中心的自然局部译文;core 18 让 FANBOYS 并列片段的各并列项各成一个 `FRAGMENT_HEAD`、连词单列 `CONJUNCTION`;core 19 补非 FANBOYS 并列(逗号/分号/vs)的合并口径——短并列整体一个 head、长并列首项 head + 后续项 APPOSITIVE,把修复轮封死合法出路的旧指令改为按连接方式分流,core 20 再把判定改为逐项(混合列表 `A; B; and C` 的分号项一律 `APPOSITIVE`,修复轮逐项判定);detail 10 新增名词中心与后置 `of` 短语的自然局部译文教学;core 与 detail 旧缓存均按新提示词版本键作废),版本四文件(`versions.ts` / `Domain.kt` / `contracts.json` / `core-prompt-parity.json`)必须一次同步。

### 追问对话链路(chat,无缓存)

```
用户点句头「问」按钮
  ├─ learning-block 派发 CustomEvent syntax-chat-request {sentenceId}
  ├─ SessionController.openChat(): 惰性建 ChatPanel;无 core 的句子直接忽略
  │     换(或重按)锚定句 = 重置会话并生成新 conversationId(`${documentId}:chat:${n}`)
  ├─ 面板 Enter 提交 → askChat(): 面板先落用户轮 + pending 回答轮,再发 CHAT_ASK
  │     {context: {sentence, core}, history(面板已裁剪、不含本轮悬空用户轮), question}
  ├─ SW → chat(): 不查/不写缓存、无修复轮;流式经同一端口推 CHAT_STREAM(累积全量),
  │     handleStreamPush 的 CHAT_STREAM 分支按 conversationId 转发面板整段重画
  └─ SW → content: CHAT_RESULT 以缓冲答案校平收尾;ERROR 渲染 `${code}：${message}` 并撤销悬空用户轮
```

面板历史由 ChatPanel 自持(最近 6 项 / ≤8000 字符,与 SW 入站兜底同边界);`stop()` 时面板随控制器 dispose,在飞请求不取消(端口回收负责)。原句 core 中途被清(块还原重扫)后再提交:面板给「原句已失效」错误气泡,不发 `CHAT_ASK`、不污染历史。

## 6. 两个状态机

### 会话状态(`SessionStatus.state`)

```
stopped ──START_SESSION──▶ running ──PAUSE_SESSION──▶ paused
   ▲                          │                          │
   └────────STOP_SESSION──────┴──────START_SESSION───────┘
```

- `stop()` 会还原全部被替换的元素、清标记、取消在飞请求、断开端口。
- `pause()` 只挡新派发:已入队的块记进 `pausedBlocks`,`resume()` 时重新入队。**用户显式发起的解析(force)不受暂停门约束。**
- SPA 用 `history.pushState` 换页时文档不重载,SW 侧 `tabs.onUpdated` 只看到 url 变化——此时必须**同时通知页面结束会话**,否则 content script 里的 `MutationObserver` 会自顾自去解析新页面内容。

### 句子相位(`SentencePhase`)

```
discovered ─▶ cache-check ─▶ queued ─▶ requesting ─▶ validating ─▶ ready
                                 │           │            │
                                 │           │            └─▶ failed
                                 └───────────┴──────────────▶ skipped(纯缓存未命中)

任意相位 ──块内容变动 / 重新解析──▶ stale
```

- **段落级"解析中"竖条只绑 `requesting`**,由 `transition()` 统一收口刷新。
- `SessionStatus.inFlight` = `requesting + validating` 的句数。
- 判"会话是否跑完"用 `isSessionComplete()`:`discovered > 0 && queued === 0 && inFlight === 0`。**不能要求所有 `discovered` 都达终态**——长页面里屏外句子要滚到可见才入队,按那个口径会永远停在"解析中…"。

## 7. 数据流里的三道安全闸

1. **发送方校验**:`isRequestMessage()` 逐类型白名单字段(`hasOnlyKeys`),SW 收到不合规消息直接回 `INVALID_MODEL_OUTPUT`。
2. **来源与新鲜度校验**:带 `tabId` 的消息必须来自该 tab,或来自受信任扩展 UI(`sender.tab === undefined && sender.id === runtime.id && sender.url` 以本扩展 origin 开头);`documentId` 还必须与当前会话一致。此外 7 条命令(`START_SESSION` / `PAUSE_SESSION` / `STOP_SESSION` / `REANALYZE_VISIBLE` / 三个 `PARSE_*`)在各自 case 里**额外要求受信任 UI**。这三道门互相独立,细节见 [`protocol.md` §2.1](./protocol.md#21-三道门别混为一谈)——`GET_SESSION_STATUS` 与 `SWITCH_PROFILE` 常被误以为也有第三道门,其实没有。
3. **模型输出校验 + 脱敏**:`validateCoreBatch` / `validateDetail` 拒绝越界区间、未知角色、覆盖率违规、译文不含 Han 或回显英文,以及含 `<script` / `<iframe` / `javascript:` / NUL 的文本;所有返回页面的模型文本都经 `redactProfileSecrets()` 把 apiKey 与自定义头值替换成 `[redacted]`——**流式分片也不例外**。

## IntelliJ 插件运行时(第二运行时)

Chrome 扩展之外,本仓库还交付一个 IntelliJ IDEA Markdown 预览插件(`intellij-plugin/`,与 `chrome-plugin/` 平级的独立子模块:Kotlin 构建归 Gradle,`resources/web/` 的 TS 桥测试在 `intellij-plugin/` 里 `npm ci && npm test` 独立跑)。两个运行时**不共享运行代码**,只共享契约:

- 仓库根 `shared-fixtures/` 的分句/分词向量(`segmenter-vectors.json`)、缓存键向量、整段 core 提示词(`core-prompt-parity.json`)、译文质量边界(`translation-quality.json`)、交换 fixture 由 TS(chrome-plugin)与 Kotlin(intellij-plugin)测试同时消费——两端任何一侧改规则,另一侧的测试立刻红。分句不再借助各平台原始边界：两端先按「句末标点串 + 收尾引号/括号 + 空白」产生同一批候选。`Dr.` / `Prof.` / `Capt.` 等强非终结缩写始终撤销边界；`U.S.` / `Ph.D.` / `Inc.` / `Ltd.` / `Co.` / `Corp.` / `etc.` 等可收句缩写只在下一片段以小写词或数字开头时撤销边界，遇大写新句则保留。两端 token regex 的缩写内部空白统一使用显式 JS Unicode whitespace class（含 NBSP、U+2000–U+200A），不用平台 `\s`。链式 initials、编号与无实词片段按同一规则合并；`rebuildTokens` 只承诺对已 trim 的生产句文本无损。Gradle 配置缓存会无视 `shared-fixtures/` 变更把 `:intellij-plugin:test` 标 UP-TO-DATE——fixture 相关任务加 `--rerun-tasks`。
- 模型链路(prompt、校验、修复、降级)在 Kotlin 侧按同一骨架重新实现(见 [model-pipeline.md](./model-pipeline.md) 的 IntelliJ 小节)。

链路时序:IntelliJ 打开 `.md` 预览(官方 `MarkdownJCEFHtmlPanel`,IDEA 默认 JCEF 预览)→ 用户点 Tools → 开始句法学习 → `EnglishSyntaxPreviewPanel.findPanel` 经 `MarkdownPreviewFileEditor.PREVIEW_BROWSER` UserData 定位官方面板并包装 → `PreviewSessionConnector.start` 接线页面消息(先接线、后启动会话)→ 包装在页面 load 完成后注入 `web/bundle.js` 与 `preview.css`(bundle 由 `scripts/bundle-web.mjs` 从 `bootstrap-entry.ts` 打包;JS→Kotlin 走 `JBCefJSQuery`)→ `__englishSyntaxInitialize` 触发扫描 → JS 回传 `VISIBLE_BLOCKS` → `PreviewSessionConnector` 派发进 `PreviewSession` 分句分词、合批、查 SQLite 缓存(与 Chrome 扩展互通)→ 未命中经 `RequestScheduler` 调模型 → 校验/core 至多两轮修复(每轮仅剩余失败句) → `CORE_RESULT`/`CORE_STREAM`(带 `blockId`)回推页面 → `render.ts` 按 blockId 惰性注册句子、可逆替换卡片。完整 `CORE_RESULT` 同时作为该句的权威核心分析保存在 `SentenceRecord`;后续 `DETAIL_REQUEST` 必须把它原样传给详解模型,流式暂定成分不能替代它。官方每次整体重渲染(updateDom 重写 body)由 JS 上报 `PREVIEW_RENDERED`,Kotlin 换代重扫。用户手势(Tools 菜单的五个 Action)经 `PreviewSessionManagerService` 取 manager:前三个驱动 start/pause/stop,stop 发 `RESTORE_ALL` 恢复原文;第四个「解析鼠标悬停的段落」不碰会话开关,走下面的快捷键支线;第五个「重新解析全部段落(绕过缓存)」仅 RUNNING 可用,作废全部已解析句子并同 generation 重扫(会话级一次性 bypass 标志 + 指纹重置,详见 [model-pipeline.md](./model-pipeline.md) 的 IntelliJ 小节)。

快捷键支线(只翻悬停那一段):用户按 `Alt+T`(IDEA Action,或焦点在预览里时由页面 keydown 兼底)→ `ParseHoveredBlockAction` 经 `findPanel` 定位官方面板 → `PreviewSessionConnector.parseHovered` 接线并调 `panel.requestParseHoveredBlock()`(bundle 尚未注入时只记标记,延迟到注入末尾补发)→ 页面 `parseHoveredBlock()` 查 `:is(:hover)` + `nearestPreviewBlock` 定位段落 → 回传 `PARSE_BLOCK` → `PreviewSession.parseExplicitBlock` 在 STOPPED 时轻量启动(置 RUNNING 但不做全文扫描)并以 `ACTIVE_VISIBLE_CORE` 单块派发 → 其余(分句分词、查缓存、调度、校验、`CORE_RESULT` 回推、卡片替换)与整篇路径完全相同。

追问对话支线(与 Chrome 端 §5 的 chat 链路同构):句头聊天气泡图标(core 成功句才有)打开锚点弹出的浮层面板(`web/chat-panel.ts`,可拖动、多轮流式),面板 submit 才发 `CHAT_ASK`——Kotlin `AnalysisService.chat` 是无缓存、无修复的旁路(`DETAIL_CLICK` 档、`${documentId}:chat` 调度命名空间、按轮 cacheKey),流式 `CHAT_STREAM` 推**全量**文本、`CHAT_RESULT` 校平;stop/换代/面板关闭(`Disposer` → `disposePreview`)三处都回收 chat 命名空间的在飞请求。

纠正反馈支线(对齐 Chrome `REANALYZE_WITH_FEEDBACK`):失败行(had-core 的)「纠正」按钮打开卡片下方的内联输入行,提交才发 `FEEDBACK_REQUEST`——Kotlin `analyzeWithFeedback` 单句、无缓存、至多一轮修复(与 chat 同为骨架外旁路,详见 [model-pipeline.md](./model-pipeline.md) 的 IntelliJ 小节);成功复用 `CORE_RESULT` 落账重画,失败回 `FEEDBACK_ERROR` 就地显示、不动卡片。

生命周期:每个预览一个 `PreviewSession`(child Job),面板 dispose 时随项目 scope 取消;Profile 是 start 时刻的快照,设置变更后由 Manager 刷新。设置页是缓存互通与鉴权修复的入口:「导出缓存…/导入缓存…」与 Chrome 选项页共用 `english-syntax-cache` v1 格式,profile 保存/「测试连接」成功会解除 AUTH_FAILED 暂停。JCEF 不可用时 Action 不可用并提示切换 JetBrains Runtime。

AUTH_FAILED 暂停(F6,对齐 Chrome 鉴权暂停):请求结果/抛出的鉴权失败把 profile 记入应用级 `ProfilePauseRegistry`(`PreviewSessionManagerService` 单例,id → 凭据指纹);会话层 dispatch/重试前置查表,命中即回落纯缓存(未命中句 AUTH_FAILED 失败,不发模型请求),detail 先查缓存、chat/纠直接报错;凭据指纹变化(设置页保存,后台比较)或「测试连接」成功即解除,profile 删除清理死 key。这与用户手动 `pause()`(只挡新派发)是两回事——前者是 profile 级事实,随应用存活。
