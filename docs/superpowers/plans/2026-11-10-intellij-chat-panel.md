# IntelliJ 追问对话面板 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** IntelliJ 插件（JCEF Markdown 预览）支持句头图标发起的多轮流式追问对话——锚点弹出、可拖动，与 Chrome 版全量对等。

**Architecture:** 桥协议三件套（CHAT_ASK 极简化，Kotlin 从 SentenceRecord 重建上下文）→ Kotlin `OpenAiCompatibleClient` 文本双路径 → `AnalysisService.chat`（DETAIL_CLICK、`"${documentId}:chat"` 命名空间、无缓存无修复）→ PreviewSession 分发流式 CHAT_STREAM → web 新 `chat-panel.ts` 浮层 + render.ts 句头图标。

**Tech Stack:** Kotlin (IntelliJ Platform, kotlinx.coroutines/serialization) + web TS（vitest/happy-dom，bundle.js 提交物）。

**Spec:** `docs/superpowers/specs/2026-11-10-intellij-chat-panel-design.md`（执行者须同时读 spec 与侦察报告 `.superpowers/recon/intellij-chat-recon.md`）。

## Global Constraints

- 在 worktree `.worktrees/ij-chat`（分支 `ij-chat`）实现；提交信息中文主题；每任务一提交。
- **不改** shared-fixtures 任何文件、contracts.json、ErrorCode 枚举、PROMPT_FIRST_LINES；chat prompt 首行 `"Discuss the verified translation analysis with the reader."` 是 `buildChatPrompt` 函数内字面量。
- 桥四地同步缺一不可：BridgeProtocol.kt ↔ web/bridge.ts（类型+键表+parse）↔ PreviewSessionConnector/PreviewSession ↔ bootstrap-entry/render。
- 三条 Host 消息（CHAT_STREAM/CHAT_RESULT/CHAT_ERROR）必带 generation + conversationId；CHAT_STREAM.text 是**截至目前完整回答**。
- 累积器声明在调度 run 块内部、每次尝试归零（重试不翻倍）；onStreamedText 推累积全量。
- CHAT_ASK parse 结构化上限（question trim 后 1..2000；history ≤6 项/总 ≤8000 字符、role ∈ {user,assistant}、content 非空白）；不做 SessionState 静默门。
- CHAT_ERROR 文案 Kotlin 侧可读枚举（无 profile / 原句失效 / `<既有错误码>：<中文说明>`）。
- 取消：manager 长命 scope 路由 `"${previewId}-doc:chat"`（disposePreview 在 cancel job 前）+ Disposer.register(panel)→disposePreview 接线 + stop()/onGenerationChanged() 追加。
- 密钥不过桥（现状满足）；流式/最终文本过 Kotlin 脱敏。
- web 改完跑 `npm run bundle-web` 并**提交 bundle.js**。
- 门禁：`(cd intellij-plugin && npm ci && npm test)`；仓库根 `./gradlew :intellij-plugin:test :intellij-plugin:buildPlugin :intellij-plugin:verifyPluginProjectConfiguration`。不动 chrome-plugin/ 与 shared-fixtures/（无需 Chrome 门禁）。

## Review Focus

1. **调度静默重试翻倍文本**——累积器在 run 块内归零 + 重试脚本测试（Task 2）。
2. **漏 bridge.ts case 静默丢消息**——四地同步各有测试钉（Task 1 键表 + Task 4 接线）。
3. **旧 generation 消息污染新 DOM**——generation 过滤 + 面板 conversationId 双防线测试（Task 1/5）。
4. **stop 后提问静默挂起**——无状态门，core==null/无记录回 CHAT_ERROR 测试（Task 3）。
5. **预览关闭后占槽**——Disposer 接线 + manager scope 取消测试（Task 3）。

---

### Task 1: 桥协议三件套（Kotlin + web bridge.ts）

**Files:**
- Modify: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/bridge/BridgeProtocol.kt`
- Modify: `intellij-plugin/src/main/resources/web/bridge.ts`
- Test: `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/bridge/BridgeProtocolTest.kt`、`intellij-plugin/src/main/resources/web/bridge.test.ts`

**Interfaces（后续任务依赖）:**
```kotlin
// PageMessage 增（JS→Kotlin；字段集以既有消息类为准——侦察 BridgeProtocol.kt:11-13/62-64；
// 下列示意按既有风格可能不带 version 字段，以实际邻类为准）
data class ChatAsk(val previewId: String, val conversationId: String,
  val sentenceId: String, val history: List<ChatTurn>, val question: String)
data class ChatTurn(val role: String /* user|assistant */, val content: String)
// HostMessage 增（Kotlin→JS；均带 generation）
data class ChatStream(val version: Int, val previewId: String, val generation: Int,
  val conversationId: String, val text: String)
data class ChatResult(val version: Int, val previewId: String, val generation: Int,
  val conversationId: String, val answer: String)
data class ChatError(val version: Int, val previewId: String, val generation: Int,
  val conversationId: String, val message: String)
```
```ts
// bridge.ts: ChatAskPageMessage / ChatStreamHostMessage / ChatResultHostMessage / ChatErrorHostMessage
// PAGE_KEYS_BY_TYPE/HOST_KEYS_BY_TYPE 条目含全部信封字段;parseChatAsk 结构化上限;
// parseHostMessage 的 generation 过滤对新 Host 消息自动生效(已有逻辑,验证即可)
```
- [ ] **Step 1: 写失败测试** — BridgeProtocolTest：CHAT_ASK 合法通过；question 空白/>2000 拒；history 7 项/超 8000 字符/role 非枚举/content 空白拒；forbiddenKeys(apiKey/headers/baseUrl) 拒；三条 Host 消息序列化含 generation/conversationId。bridge.test.ts：parseChatAsk 同上限；三条 Host parse + generation 不符丢弃 + 键多余拒收。
- [ ] **Step 2: 跑测试确认失败** — `cd intellij-plugin && npm test`（web 红）；`cd .. && ./gradlew :intellij-plugin:test --tests "dev.codetui.englishsyntax.bridge.*"`（Kotlin 红）。
- [ ] **Step 3: 实现**（照抄 VISIBLE_BLOCKS 嵌套数组与 CORE_STREAM 的既有 parse/serialize 风格）。
- [ ] **Step 4: 跑测试确认通过** — 双侧绿。
- [ ] **Step 5: 提交** — `git commit -m "桥协议新增追问对话三件套与 CHAT_ASK 防伪造门"`

### Task 2: Kotlin 文本双路径与 chat 服务

**Files:**
- Modify: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/model/OpenAiCompatibleClient.kt`
- Modify: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/model/Prompts.kt`（buildChatPrompt）
- Modify: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/analysis/AnalysisService.kt`（**`AnalysisServicePort` 接口 + 具体实现都要加 `chat`**）
- Modify: 端口的三个测试假实现各补一个 stub `chat`（不加则测试源集编译失败,gradle 在任何 --tests 过滤前先全量编译）：`session/PreviewSessionTest.kt:38`（FakeAnalysisService）、`session/PageMessageWiringTest.kt:43`（NoopAnalysisPort）、`actions/ActionStateTest.kt:31`（NoopService）
- Test: 对应 client/prompts/analysis 测试文件（Kotlin）

**Interfaces:**
```kotlin
// OpenAiCompatibleClient(取消走协程:调度器 job.cancel → awaitCancellable 的
// invokeOnCancellation,与既有 completeJson 家族一致,**无 signal 参数**,
// CancellationToken 类型在代码库不存在)
suspend fun completeText(profile: ModelProfile, messages: List<ChatMessage>): String
suspend fun completeTextStreaming(profile: ModelProfile, messages: List<ChatMessage>,
  onDelta: (String) -> Unit): String
// Prompts
fun buildChatPrompt(input: SentenceInput, core: CoreAnalysis,
  history: List<ChatTurn>, question: String): String  // 首行函数内字面量
// AnalysisService(Port 接口与实现都加)
fun interface StreamedTextSink { fun onText(textSoFar: String) }  // 非挂起,镜像 StreamedComponentSink
suspend fun chat(profile: ModelProfile, documentId: String, conversationId: String,
  input: SentenceInput, core: CoreAnalysis,
  history: List<ChatTurn>, question: String,
  onStreamedText: StreamedTextSink? = null): String  // 返回最终全文(sentenceId 不需要——上下文由调用方取好传入)
```
- 文本模式绕开 parseEnvelopeContent/parseContent 与 streamRequest 末尾 JSON parse（OpenAiCompatibleClient.kt:462-488/:383）；复用 SSE 循环/静默超时/降级链；streamSupport==UNSUPPORTED 前置短路；流式 400 reasoning 嗅探补抛出点。
- chat：DETAIL_CLICK、调度 documentId `"${documentId}:chat"`、cacheKey `"$conversationId:" + sha256(question).slice(16)`、**累积器在 run 块内归零**、无缓存无修复、文本脱敏后回调。
- [ ] **Step 1: 写失败测试** — client：流式 delta 顺序与全文返回、缓冲带 reasoning_effort:"none"、streamSupport 短路、reasoning 400 降级重发；service：优先级/命名空间/按轮 cacheKey（同会话两问两次调用）/无缓存/修复零轮/**流中途可重试失败→最终推送只含第二次尝试**；prompts：首行逐字、四段结构、紧凑序列化。
- [ ] **Step 2: 跑测试确认失败** — `./gradlew :intellij-plugin:test --tests "*Client*" --tests "*AnalysisService*" --tests "*Prompts*"`（按实际测试类名）。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: 提交** — `git commit -m "Kotlin 文本双路径与 chat 服务：detail-click、chat 命名空间、按轮 cacheKey"`

### Task 3: PreviewSession 接线与取消闭环

**Files:**
- Modify: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/session/PreviewSession.kt`（CHAT_ASK 处理 + stop/onGenerationChanged 取消）
- Modify: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/session/PreviewSessionManager.kt`（disposePreview 经 manager scope 取消 `:chat`）
- Modify: PreviewSessionConnector（`Disposer.register(panel) { manager.disposePreview(previewId) }`）
- Test: 对应 session/wiring 测试（Kotlin）

**Interfaces（Task 4 web 依赖 Kotlin 行为契约）:**
- CHAT_ASK → 查 SentenceRecord；无记录/core==null → CHAT_ERROR("原句已失效：请重新解析后再提问")；无 profile → CHAT_ERROR("尚未配置可用的模型档案，请先在设置中配置")；成功流式 CHAT_STREAM → CHAT_RESULT；异常 → CHAT_ERROR("<既有错误码>：<中文说明>"，message 脱敏)。**无 SessionState 静默门**。
- stop()/onGenerationChanged() 追加 `cancelDocument("${documentId}:chat")`；disposePreview 在 cancel job 前经 manager scope 取消；Disposer 接线让面板关闭真正触发 disposePreview。
- [ ] **Step 1: 写失败测试** — ① CHAT_ASK 全链路（record 有 core → chat 被调、流式回调→CHAT_STREAM、完成→CHAT_RESULT）；② 无记录/无 core → CHAT_ERROR 原句失效（**stop 后再问也走这条,不静默**）；③ 无 profile → CHAT_ERROR 文案；④ stop/onGenerationChanged 后 `:chat` 取消被调；⑤ disposePreview（经 Disposer 触发）取消 `:chat` 且在 session job cancel 之前发出。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 跑测试确认通过** + gradle 全量 `:intellij-plugin:test`。
- [ ] **Step 5: 提交** — `git commit -m "PreviewSession 接线追问对话与取消闭环（含 Disposer 面板关闭接线）"`

### Task 4: web 桥接线与句头图标按钮

**Files:**
- Modify: `intellij-plugin/src/main/resources/web/bootstrap-entry.ts`（handleHostMessage 三 case + CHAT_ASK 发送 + document 级事件委托）
- Modify: `intellij-plugin/src/main/resources/web/render.ts`（句头 SVG 气泡按钮，仅 core 成功句）
- Test: `bootstrap-lifecycle.test.ts` / `render.test.ts`（按现有归属）

**Interfaces（Task 5 依赖）:**
```ts
// bootstrap-entry 暴露/转发的回调形状(照 DETAIL_REQUEST 既有模式):
// onChatAsk(message: ChatAskPageMessage) → panel 由 Task 5 建
// handleHostMessage: CHAT_STREAM/CHAT_RESULT/CHAT_ERROR → 转发 chat panel(经 generation 过滤后)
```
- 图标按钮：Chrome 同款视觉（无文字、20px 圆、默认半透明、悬停句区显现、title/aria「追问这句」）；仅句子有成分渲染时出现；点击带 anchor（clientX/Y,键盘回落 rect 右下）派发 document 级事件。
- [ ] **Step 1: 写失败测试** — render：core 成功句有按钮(无文字/SVG/aria)、失败句无；bootstrap：**图标点击 → 打开面板回调 `{sentenceId, anchor}`（clientX/Y，键盘回落 rect 右下）——不发任何桥消息**；**面板 submit（onSubmit）→ 构造并发送 CHAT_ASK**（conversationId `${previewId}:chat:${n}`、history 取面板 `currentConversation()`——点击时没有合法 question，先发会被 Task 1 的 parseChatAsk 拒收）；三条 Host 消息→转发回调。
- [ ] **Step 2: 跑测试确认失败** — `cd intellij-plugin && npm test`。
- [ ] **Step 3: 实现**（conversationId 计数与面板解耦：bootstrap 侧模块级计数器,面板 open 时传入）。
- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: 提交** — `git commit -m "web 桥接线与句头追问图标按钮"`

### Task 5: chat-panel.ts 浮层（锚点/拖动/多轮流式）

**Files:**
- Create: `intellij-plugin/src/main/resources/web/chat-panel.ts`
- Modify: `bootstrap-entry.ts`（面板实例化与消息路由）
- Test: `chat-panel.test.ts`（新建）

**Interfaces:**
```ts
export class ChatPanel {
  open(context: { conversationId: string; sentenceId: string; summary: string;
                  anchor?: { x: number; y: number } }): void
  setConversationId(id: string): void
  currentConversation(): { conversationId: string; history: ChatTurn[] } | null  // ≤6 项/≤8000 裁剪,不含悬空 user 轮
  appendUserTurn(text: string): void
  beginAssistantTurn(conversationId: string): void
  renderStreamedText(conversationId: string, text: string): void   // 全量替换
  completeAssistantTurn(conversationId: string, answer: string): void
  failAssistantTurn(conversationId: string, message: string): void  // 无 pending 轮也画错误气泡(原句失效路径)
  onSubmit: (question: string) => void
  dispose(): void
}
```
- host 挂 `document.documentElement`；锚点弹出 +14px、钳制 8/120/80；标题栏拖动（位置写真正 fixed 的 .panel）；Enter/Shift+Enter、maxlength 2000；PREVIEW_RENDERED 重初始化路径 dispose 面板。
- [ ] **Step 1: 写失败测试** — 移植 Chrome chat-panel 测试集：锚点弹出覆盖拖动落点、拖动/按钮起手不拖、全量替换、裁剪、failAssistantTurn 撤销悬空轮、dispose。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**（结构照 chrome-plugin/src/content/chat-panel.ts 平移,DOM/样式适配 preview.css 体系）。
- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: 提交** — `git commit -m "web 追问浮层面板：锚点弹出、拖动与多轮流式"`

### Task 6: bundle、文档与双门禁

**Files:**
- Rebuild: `intellij-plugin/src/main/resources/web/bundle.js`（`npm run bundle-web`）
- Modify: `docs/architecture/protocol.md`（IntelliJ 桥三消息 + generation/上限）、`rendering.md`（图标按钮/浮层/锚点/拖动/失效）、`model-pipeline.md`（chat prompt/无缓存/命名空间/文本双路径）、`modules.md`（chat-panel.ts 新文件）、`overview.md`（一句话）、`build-test-release.md`（bundle 提交约定如未覆盖）、`AGENTS.md`（chat 一句，含 IntelliJ 侧取消闭环）
- Modify: architecture-docs.test.ts 仅当其钉住 modules 地图新文件时（新 web 文件是否在地图内——按仓库现状,web 文件历史上是否入 modules.md 由 drift 提示决定）

- [ ] **Step 1: 跑 chrome-plugin 的 docs:drift 与 architecture 测试**（若钉住 intellij web 文件清单则先补）。
- [ ] **Step 2: 双门禁全绿** — `(cd intellij-plugin && npm ci && npm test && npm run bundle-web)`；`./gradlew :intellij-plugin:test :intellij-plugin:buildPlugin :intellij-plugin:verifyPluginProjectConfiguration`；bundle.js 入提交。
- [ ] **Step 3: 提交** — `git commit -m "文档与门禁：IntelliJ 追问对话链路同步"`

## 执行注意（对 subagent 执行者）

- 每任务开工前读 spec + 本任务全文 + 侦察报告；只做自己任务内的文件。
- Kotlin 测试命令在仓库根跑 gradle；web 测试在 intellij-plugin/ 下跑 npm。
- 提交信息用任务给定的中文主题。
