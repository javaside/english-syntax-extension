# IntelliJ 插件追问对话面板设计

- 日期：2026-11-10
- 状态：待评审
- 范围：IntelliJ 插件（intellij-plugin/，Kotlin + JCEF web 预览页）；Chrome 版已上线，本文档只覆盖 IntelliJ 侧移植
- 侦察依据：`.superpowers/recon/intellij-chat-recon.md`（file:line 均出自该报告）

## 意图与为什么

Chrome 版追问面板已验证：读完成分划分仍看不懂时，基于该句**已核实分析**继续向模型多轮提问、流式看答案。IntelliJ 插件的用户是同一批人（Markdown 预览里读英文文档），需要同样的能力。目标功能与 Chrome 版**全量对等**：句头图标入口、锚点弹出、可拖动、多轮流式对话。

## 目标

1. 预览页每个已解析句子头部有聊天气泡图标按钮（Chrome 同款视觉：无文字、20px 圆、默认半透明、悬停句区显现、提示「追问这句」）。
2. 点击处在锚点右下 14px 弹出浮层面板（视口钳制、可拖动、多轮历史、Enter 发送/Shift+Enter 换行、流式逐字全量替换渲染）。
3. 上下文 = 该句 `SentenceInput` + 已核实 `CoreAnalysis`——**Kotlin 侧从 `SentenceRecord` 重建**（`input` + `core`，PreviewSession.kt:82-87），桥上不传分析载荷。
4. chat 请求走 `DETAIL_CLICK` 优先级、`${documentId}:chat` 调度命名空间、按轮唯一 cacheKey、无缓存无修复轮；文本双路径（流式 + 缓冲）都接 `reasoning_effort:"none"` 降级。
5. 密钥不过桥（PasswordSafe 在 Kotlin 侧解析，现状即满足）；流式与最终文本过 Kotlin 侧脱敏。

## 非目标 / 反目标

- 非目标：Chrome/IntelliJ 共用代码（两套 DOM 与协议体系，平行实现）；chat 持久化；markdown 渲染（纯文本 pre-wrap）；修改 contracts.json / ErrorCode 枚举 / PROMPT_FIRST_LINES；改 SQLite 缓存。
- 反目标：**chat 消息绕过 generation 校验**（IntelliJ 硬不变量：旧响应不得污染新 DOM，chat 不豁免）；**chat 携带 apiKey/headers/baseUrl 过桥**（BridgeProtocol 的 forbiddenKeys 白名单必须照拦）；修复轮（自由文本无 schema）。

## 约束（来自仓库不变量与侦察）

- **桥是唯一校验门**（BridgeProtocol.kt 每类型精确键白名单 + forbiddenKeys，:136）：IntelliJ 没有 Chrome 式 content 路由拒绝列表，`CHAT_ASK` 的 parse case **就是**防伪造门——Chrome 的入站上限（question trim 后 1..2000、history ≤6 项/≤8000 字符、role 枚举）必须结构化进 parse。
- **四地同步**：BridgeProtocol.kt case ↔ web/bridge.ts 类型/键表/parse case ↔ PreviewSessionConnector `when` + PreviewSession 发送点 ↔ bootstrap-entry `handleHostMessage` + render.ts 消费；漏 bridge.ts case 会**静默丢消息**。
- **generation 双端过滤**：JS 侧 `parseHostMessage(value, currentGeneration)`（bridge.ts:218）丢弃 generation 不符的一切 Host 消息——CHAT_STREAM/CHAT_RESULT/CHAT_ERROR 必带 generation；面板再按 conversationId 把关（第二道防线，Chrome 同款）。
- **调度取消缺口**：`cancelDocument` 精确匹配（RequestScheduler.kt:101-112）；`PreviewSession.dispose()` 现状**从不调 cancelDocument**（:482-487，既有缺口）——chat 的静默超时流会把该缺口放大成永久占槽，因此 stop()/onGenerationChanged()/dispose() 三处都必须追加 `cancelDocument("${documentId}:chat")`（只补 chat 命名空间；core 的既有缺口不在本次范围，记录为观察项）。
- **文本路径不能复用 JSON 收尾**：`parseEnvelopeContent`/`parseContent`（OpenAiCompatibleClient.kt:462-488）与 `streamRequest` 末尾的 `parseContent`（:383）会把自由文本判成 INVALID_MODEL_OUTPUT——文本模式必须绕开；SSE 读循环、静默超时看门狗（:359-371）、reasoning/streamSupport 降级链（:197-225）可复用。
- **updateDom 会重写 body**：官方预览 PREVIEW_RENDERED → 新 generation 重画 DOM——面板 host 挂 `document.documentElement`（html）而非 body；generation 变化即作废会话（面板收摊或标 stale）。
- **bundle.js 是提交物**：web TS 改完必须 `npm run bundle-web` 并提交 bundle.js，gradle 不重建。
- 门禁：`(cd intellij-plugin && npm ci && npm test)` + `./gradlew :intellij-plugin:test :intellij-plugin:buildPlugin :intellij-plugin:verifyPluginProjectConfiguration`；Kotlin 测试经 FixtureLoader 读 10 份 shared-fixtures——**chat 不新增/不改任何 shared-fixture**。

## 方案（已与用户确认：全量对等 + 子 agent 流水线）

无分叉：桥协议三件套 + Kotlin 服务/客户端文本路径 + web 平行 UI，全部照 Chrome 版语义映射到 IntelliJ 对应物。唯一实质设计决策：

- **CHAT_ASK 极简化**（vs Chrome 把 context 从 UI 发过桥）：Kotlin `SentenceRecord` 已有 `input` + `core`，桥上只传 `{conversationId, sentenceId, history, question}`；`core == null`（句子失效）由 Kotlin 回 `CHAT_ERROR`（文案「原句已失效：请重新解析后再提问」，Chrome 同款语义）。省桥载荷且避免 JS 侧伪造分析上下文的面。
- **专用 `CHAT_ERROR` 消息**（不复用 CORE_ERROR）：ErrorCode 枚举被 contracts 钉死不加值；CHAT_ERROR 只带 `{generation, conversationId, message}` 人类可读文案（无 code 字段），承载「无可用 profile / 请求失败 / 原句失效」。

## 设计细节

### 桥协议（BridgeProtocol.kt ↔ web/bridge.ts）

```
PageMessage 增（JS→Kotlin）:
  CHAT_ASK { type, conversationId: String, sentenceId: String,
             history: [{role: "user"|"assistant", content}×≤6 项/≤8000 字符],
             question: String(trim 后 1..2000) }
  —— parse 结构化校验上限与枚举（防伪造门）；命中 forbiddenKeys 照拒。

HostMessage 增（Kotlin→JS，均必带 generation）:
  CHAT_STREAM { type, generation, conversationId, text }   // 截至目前完整回答（全量替换渲染，重试安全）
  CHAT_RESULT { type, generation, conversationId, answer }  // 最终全文（以缓冲答案为准收尾）
  CHAT_ERROR  { type, generation, conversationId, message } // 失败/无 profile/原句失效
```

conversationId 由 web 侧生成：`${previewId}:chat:${++n}`（previewId 即桥消息既有的会话标识）。

### Kotlin 客户端（OpenAiCompatibleClient.kt）

- `suspend fun completeText(profile, messages, signal): String` 与 `completeTextStreaming(profile, messages, signal, onDelta: (String) -> Unit): String`。
- 复用 SSE 读循环/静默超时/降级链；文本模式跳过 response_format 与一切 JSON parse，返回原始累积文本。
- `streamSupport == UNSUPPORTED` 前置短路到 completeText；流式 400 reasoning 嗅探 → 降级重发（Kotlin 降级链已有 catch，补抛出点，对齐 Chrome「两条路径都要接」）。
- `ChatMessage` role 扩含 `"assistant"`（Kotlin 侧 messages 模型）。

### Kotlin 服务（AnalysisService.kt + Prompts.kt）

- `Prompts.kt` 增 `buildChatPrompt(input, core, history, question)`：首行字面量 `"Discuss the verified translation analysis with the reader."`（**绝不进 PROMPT_FIRST_LINES/contracts.json**）；结构四段同 Chrome（系统指令 → serializeSentence + 紧凑 core JSON → 历史 → 问题）。
- `chat(profile, documentId, conversationId, sentenceId, history, question, onStreamedText): ChatOutcome`——克隆 analyzeDetail（:287-338）减缓存减修复：`DETAIL_CLICK` 优先级、`sentenceCount=1`、调度 documentId 用 `"${documentId}:chat"`、cacheKey = `conversationId + ":" + sha256(question).slice(16)`（防同会话两问合并）、`onStreamedText` 推累积全量。
- **累积器必须声明在调度 run 块内部、每次尝试重新归零**（Chrome analysis-service.ts:1237 同款）：调度器静默重试会重跑 `run()`（RequestScheduler.kt:150-167），analyzeDetail 把流式状态提升到请求外的习惯在自由文本上会把两次尝试的流拼成 "ABC…ABC…"。配套测试：脚本化一次「流中途可重试失败」，断言最终推送文本只含第二次尝试的内容。
- 文本过脱敏（复用/新增 Kotlin 侧 secret 脱敏，对齐 Chrome `redactProfileSecrets` 语义）后才进 CHAT_STREAM/CHAT_RESULT。

### 接线（PreviewSession / PreviewSessionConnector / PreviewSessionManager）

- `CHAT_ASK` → 查 `SentenceRecord(sentenceId)`；**不做任何静默状态门**（不照抄 `launchDetailRequest` 的 `if state == STOPPED return`——面板在 stop/RESTORE_ALL 后仍开着，静默丢弃会让输入框永久禁用；chat 是用户手势，与 Chrome 同款只判数据可用性）：记录不存在或 `core == null`（stop/onGenerationChanged 都会 `sentences.clear()`）→ `CHAT_ERROR("原句已失效：请重新解析后再提问")`；无可用 profile → `CHAT_ERROR`（文案见下）；否则 `chat(...)` 流式回调 → `CHAT_STREAM`（带 generation）、完成 → `CHAT_RESULT`、异常 → `CHAT_ERROR`。
- **CHAT_ERROR 文案在 Kotlin 侧枚举并直接可读**（无 code 字段，web 不能查表映射）：无 profile → `"尚未配置可用的模型档案，请先在设置中配置"`；原句失效 → `"原句已失效：请重新解析后再提问"`；请求失败 → `"<既有错误码名>：<中文说明>"`（复用 ErrorCode **既有值**做前缀，不新增枚举成员；中文说明取 Kotlin 侧已有的可读映射或脱敏后的 message）。
- **取消机制必须落到真实可达的路径**（评审 B2：`dispose()` 现状零生产调用方，且 session scope 的 launch 与紧随的 job.cancel 竞速会静默 no-op）：
  1. `PreviewSessionManager.disposePreview` 在取消 session job **之前**，经** manager 自己的长命 scope** `launch { analysis.cancelDocument("${previewId}-doc:chat") }`（manager 已持有 analysis，PreviewSessionManager.kt:14；不经 session scope，避开竞速）。
  2. **补上缺失的接线**：`EnglishSyntaxPreviewPanel.dispose()`（编辑器/预览关闭，:348-355）目前不通知 manager——PreviewSessionConnector 注册 `Disposer.register(panel) { manager.disposePreview(previewId) }`，把「预览关走」真正路由到会话回收（这也顺带激活了 core 请求在 dispose 路径上的既有回收意图）。
  3. `stop()` / `onGenerationChanged()` 照追加 `cancelDocument("${documentId}:chat")`（这两处是活路径）。

### Web UI（render.ts / preview.ts / 新 chat-panel.ts）

- 句头图标按钮：`#renderCard` 的句子 section（render.ts:427）挂 SVG 气泡按钮，document 级事件委托派发（bootstrap-entry.ts:418 先例）→ `CHAT_ASK`；仅该句已有 core（有成分渲染）才出现。
- `chat-panel.ts`（新）：浮层挂 `document.documentElement`；锚点弹出（点击 +14px、视口钳制 8/120/80 同 Chrome）、标题栏拖动、多轮 history（面板侧裁剪 ≤6 项/≤8000）、Enter/Shift+Enter、maxlength 2000、收起/关闭；`CHAT_STREAM` 全量替换当前回答气泡、`CHAT_RESULT` 收尾、`CHAT_ERROR` 错误气泡且撤销悬空 user 轮。
- PREVIEW_RENDERED（generation 变化）：面板随旧 generation 作废——JS generation 过滤天然丢弃迟到消息；失效接线挂在 web 侧重初始化路径（`initialize()` / `trackPreviewRendered`，bootstrap-entry.ts）里 dispose 或标 stale 面板。
- 桥键表（PAGE_KEYS_BY_TYPE / HOST_KEYS_BY_TYPE）的新条目必须含全部信封字段（version/previewId/generation 按各消息既有约定）——漏信封字段 parse 直接拒收。

### 测试与门禁

- Kotlin：BridgeProtocolTest 加 CHAT_ASK/CHAT_STREAM/CHAT_RESULT/CHAT_ERROR 的形状/上限/forbiddenKeys/generation 用例；AnalysisService 侧 chat 的优先级/命名空间/按轮 cacheKey/无缓存无修复/流式全量/onStreamedText 用例；client 文本双路径 + 降级用例；PromptsTest 首行逐字与结构用例。
- Web（vitest/happy-dom）：bridge.test.ts 三条 Host 消息 parse + generation 过滤 + CHAT_ASK 发送形状；render.test.ts 图标按钮出现条件与事件；chat-panel.test.ts 锚点/拖动/多轮/错误/失效路径（移植 Chrome 面板测试集）。
- 门禁：web `npm ci && npm test && npm run bundle-web`（提交 bundle.js）；仓库根 gradle 三任务；文档同步（protocol/model-pipeline/rendering/modules/overview/build-test-release + AGENTS.md 一句）。

## 留给 builder 的决定

- Kotlin 侧脱敏工具的具体落点（复用现有 SecretIsolation 相关 util 或新建小函数）。
- web 面板视觉与 Chrome 版的像素级差异（同款语义即可，两边不强求同一份 CSS）。
- PreviewSessionConnector 的 when 分支组织方式（跟随既有风格）。
- Kotlin 测试文件划分（并入既有 AnalysisService 相关测试文件或新建）。

## 尺寸

项目级：桥协议四地同步 + Kotlin 客户端/服务/提示词 + web UI 平行实现 + 双侧测试 + bundle + 六份文档。估 5–6 任务。
