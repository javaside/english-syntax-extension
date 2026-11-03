# 追问对话面板（Chat Panel）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chrome 扩展卡片上每个句子可发起多轮追问对话（浮层面板、流式回答），上下文锚定该句已核实的成分分析。

**Architecture:** content 侧新浮层 `ChatPanel`（`DiagnosisPanel` 同款工艺）+ `SessionController.askChat`；新协议 `CHAT_ASK`/`CHAT_RESULT`/`CHAT_STREAM`（端口推送，全量文本形状）；SW 路由到 `AnalysisService.chat`（`detail-click` 优先级、`${documentId}:chat` 命名空间、无缓存无修复）；adapter 新增纯文本流式/缓冲两条路径。

**Tech Stack:** TypeScript + Vitest(fake-indexeddb/happy-dom) + Playwright 假服务器（既有工程，零新依赖）。

**Spec:** `docs/superpowers/specs/2026-11-03-chat-panel-design.md`（本计划从 spec 出发，执行者须同时读 spec）。

## Global Constraints

- 在 worktree `.worktrees/chat-panel`（分支 `chat-panel`）实现；提交信息中文主题；每任务一提交。
- **对话不写任何缓存、不进修复轮**（自由文本，无 schema 校验）。
- chat prompt 首行 `"Discuss the verified translation analysis with the reader."` 是 `buildChatPrompt` 函数内字面量，**绝不进 `PROMPT_FIRST_LINES`/`shared-fixtures/contracts.json`**（动了触发 gradle 门禁，破坏 Chrome-only 范围；`buildDiagnosisPrompt` 先例）。
- 协议三层同步清单（spec「三层同步清单」节）：protocol 类型+守卫 ｜ SW 路由 ｜ content `isRuntimeResponse` 加 `CHAT_RESULT` case ｜ content 入站拒绝列表（content-script.ts 的 `request.type === "ANALYZE_CORE" ||` 块）加 `CHAT_ASK` ｜ 端口推送守卫 `isChatStreamPush`。
- `CHAT_STREAM` 推送**截至目前完整回答**（`text` 字段，非增量）——调度器静默重试下增量会乱序。
- 调度命名空间 `${documentId}:chat`；`cacheKey = conversationId + ":" + sha256(question).slice(0,16)`（按轮次唯一）。
- SW 端口 `onDisconnect` 与 `cancelTab` 处**追加** `scheduler.cancelDocument(`${documentId}:chat`)`（槽位回收；`cancelDocument` 精确匹配，既有取消链够不到后缀命名空间）。
- 流式条件：`documentPorts.has(documentId) && getStreamRendering()` 且 adapter 有文本流式方法；否则缓冲路径整段随 `CHAT_RESULT` 下发。**两条路径都接 `reasoning_effort: "none"` 降级**（流式分支的 400/422 reasoning 嗅探要新加，`streamRequest` 现在没有）。
- 入站校验失败（question trim 后空 / >2000 / history 非法）→ ERROR `MALFORMED_MESSAGE`；无 profile → ERROR `CONFIG_MISSING`。不新增错误码。
- 历史裁剪：最近 6 轮且总字符 ≤ 8000（面板构造 history 时丢最旧轮）。
- 文本过 `redactProfileSecrets`。
- 门禁（chrome-plugin 内）：`npm test && npx playwright test && npm run lint && npm run format:check && npm run build`；lint 基线**恰好 1 个错误**（options.test.ts 的 no-unnecessary-type-assertion，不许修）。不动 shared-fixtures/intellij → 无需 gradle。

## Review Focus

执行者按任务实现；以下五类输入/故障由对应任务的测试钉住（已列入各任务步骤）：

1. **调度器重试让流式文本乱序/重复**——推送与渲染都是全量替换（Task 3 service 测试 + Task 5 面板测试）。
2. **同会话连续两问拿到同一在飞 promise**——per-round cacheKey（Task 3：第一问在飞时发第二问，断言两次 model 调用、两个不同 key）。
3. **流式路径上 reasoning_effort 被拒后永久失败**——流式分支降级探针（Task 2：首响应 400 reasoning → 重发不带字段并成功）。
4. **页面关走后 chat 永久占住全局并发槽**——onDisconnect/cancelTab 回收（Task 4：断言 cancelDocument 收到 `${documentId}:chat`）。
5. **页面伪造 CHAT_ASK/CHAT_STREAM**——入站拒绝列表 + `isChatStreamPush` 形状校验（Task 1）。

---

### Task 1: 协议层与 content 守卫

**Files:**
- Modify: `chrome-plugin/src/shared/protocol.ts`（`CoreSentenceFailure` 定义之后、`ResponseMessage` 附近；入站拒绝列表在 content-script）
- Modify: `chrome-plugin/src/content/content-script.ts`（`isRuntimeResponse` switch 的 `CORE_RESULT` case 后；入站拒绝块 `request.type === "ANALYZE_CORE" ||`；端口推送分发处 `isDetailStreamPush(message)` 一带）
- Test: `chrome-plugin/src/shared/protocol.test.ts`、`chrome-plugin/src/content/content-script-diagnosis.test.ts`

**Interfaces（后续任务依赖）:**
```ts
// protocol.ts 新增（导出）
export interface ChatTurn { role: "user" | "assistant"; content: string }
export interface ChatContext { kind: "sentence"; sentence: SentenceInput; core: CoreAnalysis }
// RequestMessage 增：PageRequestBase & { type: "CHAT_ASK"; conversationId: string;
//   context: ChatContext; history: ChatTurn[]; question: string }
// ResponseMessage 增：MessageBase & { type: "CHAT_RESULT"; conversationId: string; answer: string }
export interface ChatStreamPush { version: typeof MESSAGE_VERSION; type: "CHAT_STREAM";
  documentId: string; conversationId: string; text: string }
export function isChatStreamPush(value: unknown): value is ChatStreamPush
// isRequestMessage 的 switch 需认得 CHAT_ASK；content 入站拒绝列表同步加 CHAT_ASK
// 端口推送分发：isChatStreamPush 命中 → 转发 controller.onChatStreamPush(push)（Task 6 定义）
```

- [ ] **Step 1: 写失败测试** — protocol.test.ts：`isChatStreamPush` 合法形状通过、缺 `conversationId`/`text` 非串/`version` 错误被拒；`isRequestMessage` 接受合法 `CHAT_ASK`、拒绝缺 `question`/`history` 非数组。content-script-diagnosis.test.ts：`isRuntimeResponse` 接受合法 `CHAT_RESULT`、拒绝 `answer` 非串/`conversationId` 缺失；伪造 `CHAT_ASK` 入站被拒（`route()` 返回 `MALFORMED_MESSAGE`）。
- [ ] **Step 2: 跑测试确认失败** — `cd <worktree>/chrome-plugin && npx vitest run src/shared/protocol.test.ts src/content/content-script-diagnosis.test.ts`，预期新断言 FAIL。
- [ ] **Step 3: 实现** — protocol.ts 加类型与守卫（守卫风格照抄 `isCoreStreamPush`/`isDetailStreamPush`：`hasOnlyKeys` + 逐字段判型；`history` 逐项校验 role 枚举与 content 非空串、上限 6 项×8000 字符不在此判——SW 侧兜底判长度，守卫只判形状）。content-script：`isRuntimeResponse` 加 case；入站拒绝列表加 `"CHAT_ASK"`；端口分发链加 `isChatStreamPush` → 调 `controller.onChatStreamPush`（Task 6 才有该方法——本任务先在 `RoutedController` 接口加可选方法 `onChatStreamPush?(push: ChatStreamPush): void`，转发处可选调用，避免编译断链）。
- [ ] **Step 4: 跑测试确认通过** — 同 Step 2 命令，预期 PASS；再跑 `npm test` 全量确认无回归。
- [ ] **Step 5: 提交** — `git add -A && git commit -m "协议层新增追问对话三条消息与 content 守卫"`

### Task 2: adapter 纯文本两条路径

**Files:**
- Modify: `chrome-plugin/src/background/openai-compatible-adapter.ts`（`ChatMessage` 定义处；`completeDetailStreaming` 之后加两个方法；`streamRequest` 的非 2xx 分支加 reasoning 嗅探）
- Test: `chrome-plugin/src/background/openai-compatible-adapter.test.ts`

**Interfaces:**
```ts
export interface ChatMessage { role: "system" | "user" | "assistant"; content: string }  // role 扩容
// 类上新增（AnalysisService 的 adapter 端口后续引用）：
completeText(profile: ModelProfile, messages: readonly ChatMessage[], signal: AbortSignal): Promise<string>
completeTextStreaming(profile: ModelProfile, messages: readonly ChatMessage[], signal: AbortSignal,
  onDelta: (chunk: string) => void): Promise<string>
```
- 两条路径都带 `reasoningOverride(profile)`；`completeTextStreaming` 走 `streamRequest`（`stream: true`、无 response_format、SSE delta 逐段回调并累积为完整文本返回）；重试循环照 `streamWithExtractor`：`UnsupportedResponseFormatError` 不适用（无 schema），但 **`UnsupportedReasoningControlError` 必须可从流式分支抛出**——在 `streamRequest` 的 `!response.ok` 分支加：`(400|422) && /reasoning[_ ]?effort/i.test(text) → throw new UnsupportedReasoningControlError()`（照抄缓冲 `request()` 的既有嗅探；这是新增，别只引用 `streamWithExtractor`）。
- [ ] **Step 1: 写失败测试** — ① 流式：mock fetch 返回 SSE 文本 delta 三片 → `completeTextStreaming` 逐片回调且返回值 === 拼接全文；② 流式 reasoning 降级：首响应 400（body 含 `reasoning_effort`）→ `persistReasoningControl` 收到 `"unsupported"`，重发请求体不含 `reasoning_effort` 且成功；③ 缓冲：`completeText` 返回全文且请求体带 `reasoning_effort:"none"`；④ assistant 角色可进 messages。
- [ ] **Step 2: 跑测试确认失败** — `npx vitest run src/background/openai-compatible-adapter.test.ts`
- [ ] **Step 3: 实现**（照上述接口与嗅探要求）。
- [ ] **Step 4: 跑测试确认通过** — 同上，另跑 `npm test` 确认无回归。
- [ ] **Step 5: 提交** — `git commit -m "adapter 新增纯文本流式与缓冲路径及流式 reasoning 降级探针"`

### Task 3: buildChatPrompt 与 AnalysisService.chat

**Files:**
- Modify: `chrome-plugin/src/background/prompts.ts`（`buildDiagnosisPrompt` 之后加 `buildChatPrompt`）
- Modify: `chrome-plugin/src/background/analysis-service.ts`（`AnalysisModelWork.schema` 改可选；`explainDiagnosis` 之后加 `chat`；`AnalysisService` 接口与 `defaultDependencies`/导出同步）
- Test: `chrome-plugin/src/background/prompts.test.ts`、`chrome-plugin/src/background/analysis-service.test.ts`

**Interfaces:**
```ts
// prompts.ts
export function buildChatPrompt(input: {
  context: ChatContext; history: readonly ChatTurn[]; question: string;
}): string   // 首行 "Discuss the verified translation analysis with the reader."（函数内字面量）
// analysis-service.ts
export interface ChatInput extends AnalysisInputBase {
  conversationId: string; context: ChatContext; history: readonly ChatTurn[]; question: string;
  onStreamedText?: (text: string) => void;   // 截至目前的完整回答（累积全量）
}
export interface ChatOutcome { answer: string }
// AnalysisService 接口增：chat(input: ChatInput, signal: AbortSignal): Promise<ChatOutcome>
```
- `chat` 实现要点：不查/不写缓存；`requestModel(profile, `${documentId}:chat`, "detail-click", `${conversationId}:${cacheKeyOf(question)}`, 1, [{role:"user", content: buildChatPrompt(...)}], undefined /*schema 可选*/, signal)`；有 `onStreamedText` 且 adapter 有 `completeTextStreaming` 时 work.run 走流式（内部累积后回调），否则 `completeText`。`cacheKeyOf` = sha256(question).slice(0,16)（模块内小工具，`crypto.subtle` 同 `createSentenceId` 用法）。
- prompt 结构（spec §AnalysisService 的四段）：系统指令（中文回答/不重新划分成分/冲突以分析为准）→ `serializeSentence(context.sentence)` + `serialize(context.core)` → 历史轮次 → 问题。全部单条 user 消息内多段（与既有 prompt 同构）。
- [ ] **Step 1: 写失败测试** — prompts.test.ts：首行逐字 === 固定行；包含 `serializeSentence` 的 token 载荷与紧凑 core；历史两轮按序出现在问题之前；断言不含 `\n  "`（紧凑序列化既有断言风格）。analysis-service.test.ts：① chat 走 `detail-click` 优先级且 documentId 传 `${documentId}:chat`（scheduler stub 记录入参）；② **同 conversation 两问在飞 → 两个不同 cacheKey、两次 model 调用**（防调度合并串答案）；③ 有 `onStreamedText` 时流式回调收到累积全量；④ 不写缓存（MemoryCache.core 空）。
- [ ] **Step 2: 跑测试确认失败** — `npx vitest run src/background/prompts.test.ts src/background/analysis-service.test.ts`
- [ ] **Step 3: 实现**（schema 可选化：`AnalysisModelWork.schema?: JsonSchemaSpec`，`requestModel` 的 schema 参数默认 undefined；既有调用零改动）。
- [ ] **Step 4: 跑测试确认通过** — 同上 + `npm test` 全量。
- [ ] **Step 5: 提交** — `git commit -m "chat 服务与提示词：detail-click 优先级、chat 命名空间、按轮 cacheKey"`

### Task 4: SW 路由 CHAT_ASK 与槽位回收

**Files:**
- Modify: `chrome-plugin/src/background/service-worker.ts`（`case "ANALYZE_DETAIL"` 之后加 `case "CHAT_ASK"`；端口 `onDisconnect` 处理器与 `cancelTab` 处各追加一行取消）
- Test: `chrome-plugin/src/background/service-worker.test.ts`

**Interfaces（Task 6 依赖 SW 行为契约，不依赖代码符号）:**
- 合法 `CHAT_ASK` → `analysisService.chat`（`documentId` 原样、service 内部加后缀）→ 流式条件满足时经 `streamSink` 同款闭包按端口推 `CHAT_STREAM`（`text` 累积全量、`redactProfileSecrets`）→ 完成回 `{type:"CHAT_RESULT", conversationId, answer}`（answer 同样过 redact）。
- question trim 后空 / >2000 / history 项非法（role 不在枚举、content 空、超 6 项或总超 8000）→ ERROR `MALFORMED_MESSAGE`。无 profile → ERROR `CONFIG_MISSING`。AUTH_FAILED → `pauseProfile` + ERROR（照既有语义）。
- 端口 `onDisconnect` 与 `cancelTab`：在既有 `cancelDocument(documentId)` 旁追加 `cancelDocument(`${documentId}:chat`)`。
- [ ] **Step 1: 写失败测试** — ① 合法请求：mock `chat` 返回流式回调序列 → 断言端口 postMessage 收到 2 条 `CHAT_STREAM`（text 依次为两段全量）且 `CHAT_RESULT.answer` === 完整文本、无 SECRET 泄漏；② 校验拒绝：空 question / 7 轮 history → `MALFORMED_MESSAGE`；③ 无 profile → `CONFIG_MISSING`；④ 槽位回收：注册端口后触发 `onDisconnect` → 断言 scheduler stub（或经依赖注入的 cancelDocument 记录）收到 `document-1:chat`。
- [ ] **Step 2: 跑测试确认失败** — `npx vitest run src/background/service-worker.test.ts`
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 跑测试确认通过** — 同上 + `npm test`。
- [ ] **Step 5: 提交** — `git commit -m "SW 路由 CHAT_ASK：流式推送、校验与 chat 槽位回收"`

### Task 5: ChatPanel 浮层与卡片「问」按钮

**Files:**
- Create: `chrome-plugin/src/content/chat-panel.ts`
- Modify: `chrome-plugin/src/content/learning-block.ts`（句子区头部按钮；`syntax-detail-request` 派发处附近）
- Test: `chrome-plugin/src/content/chat-panel.test.ts`（新建）、`chrome-plugin/src/content/learning-block.test.ts`

**Interfaces（Task 6 依赖）:**
```ts
export class ChatPanel {
  open(context: { sentenceId: string; summary: string }): void  // 换锚定句 = 重置会话（新 conversationId 由控制器给，见下）
  setConversationId(id: string): void
  currentConversation(): { conversationId: string; history: ChatTurn[] } | null  // 已按 6 轮/8000 裁剪
  appendUserTurn(text: string): void
  beginAssistantTurn(conversationId: string): void
  renderStreamedText(conversationId: string, text: string): void   // 全量替换当前回答气泡
  completeAssistantTurn(conversationId: string, answer: string): void  // 以缓冲答案为准
  failAssistantTurn(conversationId: string, message: string): void
  onSubmit: (question: string) => void   // 控制器赋值；Enter 发送/Shift+Enter 换行/发送中禁用
  dispose(): void
}
```
- Shadow DOM + fixed 右下 + 惰性挂载（`DiagnosisPanel` 工艺照搬）；气泡 = 纯文本 + `white-space: pre-wrap`（不引 markdown）；顶部锚定句摘要行。
- learning-block：每句头部「问」按钮（`data-syntax-chat-ask`，仅当该句已有 core 分析时可用——`renderCore` 后启用、失败句禁用），点击 `dispatchEvent(new CustomEvent("syntax-chat-request", { detail: { sentenceId } }))`（冒泡，`syntax-detail-request` 同款）。
- [ ] **Step 1: 写失败测试** — chat-panel.test.ts（happy-dom）：open 后可见摘要行；appendUserTurn→beginAssistantTurn→renderStreamedText 两次全量→气泡文本等于第二次的 text（**替换而非追加**）；currentConversation 裁剪（构造 8 轮 → 返回最近 6 轮；构造超 8000 字符 → 丢最旧轮直到达标）；onSubmit 回调收到输入文本；dispose 移除 host。learning-block.test.ts：有 core 的句子出现「问」按钮且点击派发带 sentenceId 的 `syntax-chat-request`；失败句无可用按钮。
- [ ] **Step 2: 跑测试确认失败** — `npx vitest run src/content/chat-panel.test.ts src/content/learning-block.test.ts`
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 跑测试确认通过** — 同上 + `npm test`。
- [ ] **Step 5: 提交** — `git commit -m "追问浮层面板与卡片问按钮"`

### Task 6: SessionController 接线

**Files:**
- Modify: `chrome-plugin/src/content/session-controller.ts`（document 级事件监听区——`syntax-detail-request`/纠正事件一带；`RoutedController` 对应实现在本类）
- Test: `chrome-plugin/src/content/session-controller.test.ts`

**Interfaces:**
```ts
// SessionController 新增公共方法（Task 1 的转发点调用 onChatStreamPush）
openChat(sentenceId: string): void            // 惰性建 ChatPanel；换句重置会话并生成新 conversationId
askChat(sentenceId: string, question: string): Promise<void>
onChatStreamPush(push: ChatStreamPush): void  // 按 conversationId 转发面板；未知 id 丢弃
```
- `openChat`：从 `this.sentences` 取该句 `input`（SentenceInput）与 `sentence.core`（无 core 直接 return——按钮本应禁用）；`conversationId = `${documentId}:chat:${++chatCounter}``（实例字段）；面板 `open({sentenceId, summary: sentence.text.slice(0,40)})` + `setConversationId`；`panel.onSubmit = q => void this.askChat(sentenceId, q)`（重置会话时重绑）。
- `askChat`：面板 `appendUserTurn(question)` + `beginAssistantTurn`；发 `CHAT_ASK`（history 取 `panel.currentConversation().history`，**不含本轮**；context = {kind:"sentence", sentence, core}）；响应 `CHAT_RESULT` → `completeAssistantTurn` 并把 {user,assistant} 两 turn 记回面板历史；ERROR → `failAssistantTurn(conversationId, `${code}：${message}`)`。
- `onChatStreamPush`：会话匹配 → `renderStreamedText(push.conversationId, push.text)`；不匹配丢弃（旧会话流晚到无害）。
- stop()/dispose 链路：面板随控制器 dispose（`panel.dispose()`），不做请求取消（SW 端口回收负责）。
- [ ] **Step 1: 写失败测试** — ① openChat 打开面板并绑定 onSubmit；askChat 发出 `CHAT_ASK`（FakeTransport 记录：conversationId/context.sentence.sentenceId/history 为空首轮）；② CHAT_RESULT 后面板历史含本轮两 turn，第二轮请求 history 携带第一轮问答（**多轮接线**）；③ CHAT_STREAM 推送 → 面板气泡全量渲染；未知 conversationId 推送不炸不渲染；④ ERROR 响应 → failAssistantTurn 文案含 code；⑤ stop 后面板 host 已移除。
- [ ] **Step 2: 跑测试确认失败** — `npx vitest run src/content/session-controller.test.ts`
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 跑测试确认通过** — 同上 + `npm test`。
- [ ] **Step 5: 提交** — `git commit -m "SessionController 接线追问对话：会话、多轮历史与流式分发"`

### Task 7: 假服务器 chat 类型与 E2E

**Files:**
- Modify: `chrome-plugin/tests/support/fake-openai-server.ts`（`detectKind` 加 chat 分支；流式响应经 `writeContent`）
- Modify: `chrome-plugin/tests/e2e/extension.spec.ts`（新增用例）
- Test: E2E 本身

**Interfaces:** 无代码接口；行为契约——`detectKind` 以 `"Discuss the verified translation analysis"` 前缀识别 chat，返回两段流式中文文本；服务器记录每次请求的完整 messages（供历史断言）。
- [ ] **Step 1: 假服务器扩展** — chat kind 流式输出两段（`writeContent`，禁止裸 `response.end`）；把收到的请求体 push 进记录数组并暴露查询路由（既有 probe 模式照搬）。
- [ ] **Step 2: 写 E2E 用例** — fixture 页解析就绪后：点某句「问」→ 面板出现且摘要行含该句文本 → 输入「这句为什么这么译」回车 → **探针式断言**：等待面板回答文本 === 服务器两段拼接全文（流式到齐，非只判「结束」）；fetch 计数 === 1。再输入第二轮 → 等待第二回答；断言第二次请求体（probe 查询）包含第一轮 question 与第一轮回答文本（多轮历史），fetch 计数 === 2。
- [ ] **Step 3: 跑 E2E** — `npx playwright test -g "chat"`，预期通过。
- [ ] **Step 4: 跑全量 E2E** — `npx playwright test`，确认无回归。
- [ ] **Step 5: 提交** — `git commit -m "E2E：追问对话流式到齐与多轮历史探针断言"`

### Task 8: 架构文档同步与全量门禁

**Files:**
- Modify: `docs/architecture/protocol.md`（两条新消息 + `CHAT_STREAM` 端口推送）、`model-pipeline.md`（chat prompt/无缓存/detail-click/chat 命名空间）、`rendering.md`（浮层与问按钮）、`modules.md`（chat-panel.ts 新文件）、`overview.md`（链路一句话）、`build-test-release.md`（E2E chat 约定）
- Modify: `chrome-plugin/src/shared/architecture-docs.test.ts`（消息类型全覆盖断言加三条新消息）
- Modify: `AGENTS.md`（关键约定一句话：chat 链路与 `${documentId}:chat` 回收）

- [ ] **Step 1: 跑 docs:drift 定位** — `npm run docs:drift`，按提示补六份文档（新消息进 protocol.md 表格；arch 测试红就改文档，**不放宽断言**）。
- [ ] **Step 2: 全量门禁** — `cd chrome-plugin && npm test && npx playwright test && npm run lint && npm run format:check && npm run build`（lint 恰 1 错为过）。
- [ ] **Step 3: 提交** — `git commit -m "文档与门禁：追问对话链路同步"`

## 执行注意（对 subagent 执行者）

- 每个任务开工前：读 spec（`docs/superpowers/specs/2026-11-03-chat-panel-design.md`）+ 本任务全文；只做自己任务内的文件。
- 测试命令一律在 worktree 的 `chrome-plugin/` 下执行。
- 提交信息用任务给定的中文主题。

