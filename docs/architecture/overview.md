# 总览:运行时、分层与端到端链路

## 1. 四个运行时上下文

MV3 把扩展拆成互不共享内存的几个世界。**每个模块能做什么,首先取决于它跑在哪个世界里**——这是本项目最多约束的来源。

| 上下文                   | 入口                               | 能力                                           | 关键限制                                                                                        |
| ------------------------ | ---------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------- |
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
3. **流式分片走端口,不走 `sendMessage`。** content script 建一条名为 `syntax-learning:<documentId>` 的 `runtime.Port`,SW 通过它 `postMessage` 推送分片。这条端口同时兼任**页面存活探测**:断开即取消该文档的全部在飞请求。

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

## 3. 五个解析入口

一次解析可以由五种方式发起,它们在**是否全页扫描**、**是否降优先级**、**是否需要已有会话**上各不相同:

| 入口                           | 触发                                 | 全页扫描                        | 优先级                                     | 需已有会话   |
| ------------------------------ | ------------------------------------ | ------------------------------- | ------------------------------------------ | ------------ |
| 点扩展图标 / popup「开始学习」 | `action.onClicked` / `START_SESSION` | 是                              | 视口内 `visible-core`,屏外 `prefetch-core` | 否(会创建)   |
| 快捷键 `Alt+T`「解析悬停段落」 | `commands.onCommand`                 | **否**(轻量会话,只解析指到那段) | `visible-core`                             | 否(会冷启动) |
| 右键「解析选中文本」           | `contextMenus`                       | 否                              | `visible-core`                             | 否(会冷启动) |
| 右键「解析此区域」             | `contextMenus`                       | 否                              | `visible-core`                             | **是**       |
| popup「重新解析可见段落」      | `REANALYZE_VISIBLE`                  | 否                              | `visible-core` + `bypassCache`             | **是**       |

轻量会话(快捷键冷启动)后若用户再点图标,`SessionController.start()` 会**补做全页扫描并补建预载器**,升级为完整会话——扫描时以 id 去重,不会把悬停那段注册两次。

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
  │      ├─ 每块 segmentBlock + tokenize    → SentenceInput[](相位 discovered)
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
  │            ├─ validateCoreBatch()  覆盖率/有序/不重叠/角色枚举
  │            ├─ 不合格 → 一次 repair pass(jumpQueue,同优先级插队)
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

> 缓存键 = 规范化句文本 + schema 版本 + focus 区间,**与 profile / 模型无关**。改任一侧的键构造必须两侧同步,并用对方路径读回验证。

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
3. **模型输出校验 + 脱敏**:`validateCoreBatch` / `validateDetail` 拒绝越界区间、未知角色、覆盖率违规,以及含 `<script` / `<iframe` / `javascript:` / NUL 的文本;所有返回页面的模型文本都经 `redactProfileSecrets()` 把 apiKey 与自定义头值替换成 `[redacted]`——**流式分片也不例外**。

## IntelliJ 插件运行时(第二运行时)

Chrome 扩展之外,本仓库还交付一个 IntelliJ IDEA Markdown 预览插件(`intellij-plugin/`)。两个运行时**不共享运行代码**,只共享契约:

- 仓库根 `shared-fixtures/` 的分句/缓存键向量、交换 fixture 由 TS(chrome-plugin)与 Kotlin(intellij-plugin)测试同时消费——两端任何一侧改规则,另一侧的测试立刻红。
- 模型链路(prompt、校验、修复、降级)在 Kotlin 侧按同一骨架重新实现(见 [model-pipeline.md](./model-pipeline.md) 的 IntelliJ 小节)。

链路时序:IntelliJ 打开 `.md` 预览 → `EnglishSyntaxPreviewProvider` 提供 JCEF 面板 → `setHtml` 递增 generation 并通知页面 → JS 扫描可见块回传 `VISIBLE_BLOCKS` → `PreviewSession` 分句分词、合批、查 SQLite 缓存(与 Chrome 扩展互通)→ 未命中经 `RequestScheduler` 调模型 → 校验/一次修复 → `CORE_RESULT`/`CORE_STREAM` 回推页面 → `render.ts` 可逆替换卡片。用户手势(Tools 菜单的三个 Action)驱动 start/pause/stop;stop 发 `RESTORE_ALL` 恢复原文。

生命周期:每个预览一个 `PreviewSession`(child Job),面板 dispose 时随项目 scope 取消;Profile 是 start 时刻的快照,设置变更后由 Manager 刷新。JCEF 不可用时 Provider 报 UNAVAILABLE,Action 提示切换 JetBrains Runtime。
