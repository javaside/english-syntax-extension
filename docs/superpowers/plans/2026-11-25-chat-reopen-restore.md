# 追问对话重开恢复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 追问对话按句恢复——关闭/换句后重开同句,气泡与历史回来;新增「新对话」按钮补回重置能力;双端对等。

**Architecture:** 面板仍是活跃会话持有者;Chrome 在 `session-controller`、IntelliJ 在 `web/bootstrap-entry` 各持一份 `Map<sentenceId, ChatTurn[]>`(LRU 8)。关闭/换句时快照停靠,重开时恢复历史;conversationId 每次打开新铸(恢复内容不恢复 id,迟到旧轮照旧被 guard 丢弃)。

**Tech Stack:** TypeScript(Vitest + happy-dom);Kotlin/桥/SW/protocol.ts 零改动。

**Spec:** `docs/superpowers/specs/2026-11-25-chat-reopen-restore-design.md`

## Global Constraints

- 协议红线:`protocol.ts`、`service-worker.ts`、`manifest.json`、Kotlin 桥、`bundle.js` 之外的 web 源码,一个字符都不动 `intellij-plugin` 的 Kotlin/桥文件。
- lint 基线恰好 1 个错误(options.test.ts 的 `no-unnecessary-type-assertion`),不得新增错误。
- 既有钉住口径必须原样通过:「dispose 移除 host 并作废会话」「换锚定句 open 重置会话」「再点一次图标 → 计数器递增出新 conversationId」。
- LRU 上限 8(`MAX_STORED_CHAT_CONVERSATIONS = 8`,双端同名常量、同值)。
- 停靠快照 = 面板原始未裁剪 `#history`;空会话(history 为空)不停靠。
- 恢复后的请求视图照旧走 `#trimmedHistory`(SW 兜底边界 6 项/8000 字符不变)。
- 提交信息用中文主题。

## Review Focus

1. **在飞轮关闭再重开,续问的 history 混入悬空 user 轮** → Task 2 测试:关闭时在飞、重开续问,`CHAT_ASK.history` 不含悬空轮。
2. **「新对话」后重开又把被丢弃的旧对话恢复回来** → Task 2 测试:点新对话 → 关闭 → 重开,历史为空。
3. **A→B 切换后 A 的在飞迟到答案落进 B 面板** → Task 2 测试:B 的气泡不含 A 的迟到答案(新 id guard)。
4. **store 溢出无逐出** → Task 2 测试:停靠第 9 句时最旧句被逐出,重开最旧句为空会话。
5. **IntelliJ 换代后 stale 会话复活** → Task 5 测试:换代后再点图标,历史为空。

---

### Task 1: Chrome ChatPanel 恢复 API 与「新对话」按钮

**Files:**
- Modify: `chrome-plugin/src/content/chat-panel.ts`
- Test: `chrome-plugin/src/content/chat-panel.test.ts`

**Interfaces:**
- Produces(供 Task 2 消费,签名照抄):
  - `onClose: () => void = () => {}` — dispose 清态**之前**触发。
  - `onNewConversation: () => void = () => {}` — 「新对话」按钮点击时触发;面板自身不清态,由控制器回调里重开。
  - `activeConversation(): { sentenceId: string; conversationId: string; history: ChatTurn[] } | null` — 原始未裁剪历史**副本**;`#conversationId === undefined` 或无 sentenceId 时 null。
  - `restoreHistory(history: readonly ChatTurn[]): void` — 复制入 `#history`,按 turn.role 重画 user/assistant 气泡,`#assistantBubble = undefined`,滚到底。

- [ ] **Step 1: 写失败测试**(chat-panel.test.ts 增 4 条)
  1. `restoreHistory 重画气泡并落历史`:openPanel → completeRound 两轮 → `panel.open({sentenceId:"sentence-1", summary})`+`setConversationId(新 id)`(模拟重开)→ `restoreHistory([user:问1, assistant:答1, user:问2, assistant:答2])` → 断言 `.message` 4 个、文案顺序对、`currentConversation().conversationId` 为新 id、输入可用。
  2. `activeConversation 返回未裁剪历史副本`:4 轮问答(8 项)→ `activeConversation().history` 长度 8(与 `currentConversation()` 裁到 6 对照);改副本不污染面板;`conversationId`/`sentenceId` 正确;未开会话为 null。
  3. `dispose 先触发 onClose 再清态`:`onClose` 里调 `activeConversation()` 断言拿得到快照;dispose 后 `currentConversation()` 为 null(既有口径)。
  4. `「新对话」按钮触发 onNewConversation`:header 有「新对话」按钮,点击触发回调一次;按钮 pointerdown 不启动拖动(复用既有拖动守卫断言形状)。

- [ ] **Step 2: 跑测试确认失败**

  Run: `cd chrome-plugin && npx vitest run src/content/chat-panel.test.ts`
  Expected: FAIL(新成员不存在)。

- [ ] **Step 3: 实现**

  header 构造改 `header.append(this.#summary, newChat, collapse, close)`(`新对话` button.type="button",同款 `.header button` 样式,点击仅 `this.onNewConversation?.()`);dispose 首行 `this.onClose?.()`;`activeConversation`/`restoreHistory` 按接口块签名,气泡复用 `#bubble("user"|"assistant", text)`。

- [ ] **Step 4: 跑测试确认通过**(含既有 18 条不红)

- [ ] **Step 5: Commit** `feat: 追问面板新增恢复 API 与新对话按钮(Chrome)`

### Task 2: Chrome SessionController 按句存储与恢复

**Files:**
- Modify: `chrome-plugin/src/content/session-controller.ts:762-775`(openChat)、`:499`(stop 收摊)
- Test: `chrome-plugin/src/content/session-controller.test.ts`

**Interfaces:**
- Consumes: Task 1 的四个成员。
- Produces: `openChat(sentenceId, anchor?)` 对外签名不变;私有 `#chatConversations: Map<string, ChatTurn[]>`、`#parkChatConversation()`(空历史不停靠;停靠时 delete+set 刷新热度,超 8 逐出 `map.keys().next().value`)。

- [ ] **Step 1: 写失败测试**(session-controller.test.ts chat describe 增 6 条,复用 chatHarness)
  1. **关闭重开恢复**:openChat(s1) → askChat 两轮(CHAT_RESULT 假 transport)→ 面板 dispose(点「关闭」按钮)→ openChat(s1) → 断言 4 个气泡在、新 conversationId(递增)、续问时 `CHAT_ASK.history` 为恢复的 4 项。
  2. **A→B→A**:s1 两轮 → openChat(s2) → 断言 s2 空会话、s1 的气泡不在;回 openChat(s1) → s1 历史恢复;s2 的迟到 CHAT_RESULT(conversationId= s2 轮 id)不落进 s1 面板。
  3. **在飞关闭重开不含悬空轮**:askChat 悬住(transport 永不响应)→ dispose → openChat(s1) → 续问 → 断言 history 不含悬空那问(`#trimmedHistory` 裁剪)。
  4. **LRU 逐出**:对 9 个不同 sentenceId 各 openChat+一轮问答+dispose;重开第 1 句 → 空会话;重开第 8/9 句 → 恢复。
  5. **新对话**:openChat(s1) 两轮 → 点「新对话」(触发 onNewConversation 接线)→ 气泡清空、id 递增;dispose → openChat(s1) → 空会话(store 条目已删)。
  6. **stop 清空**:openChat(s1) 一轮 → `controller.stop()` → openChat(s1) → 首轮 history 为空。

- [ ] **Step 2: 跑测试确认失败**

  Run: `cd chrome-plugin && npx vitest run src/content/session-controller.test.ts`

- [ ] **Step 3: 实现**

  `openChat`:park → `stored = get(sentenceId)` → 铸新 id → `panel.open` → `setConversationId` → `stored !== undefined && panel.restoreHistory(stored)`;面板创建后一次性接线 `panel.onClose = () => this.#parkChatConversation()`;`panel.onNewConversation = () => { this.#chatConversations.delete(sentenceId); panel.open({sentenceId, summary}); panel.setConversationId(铸新 id); }`(闭包捕获 summary);`stop()` 在 `this.chatPanel?.dispose()` 旁加 `this.#chatConversations.clear()`。import `ChatTurn` 类型。

- [ ] **Step 4: 跑测试确认通过**(109 条既有不红)

- [ ] **Step 5: Commit** `feat: 追问对话按句恢复与新对话入口(Chrome)`

### Task 3: Chrome 门禁

- [ ] **Step 1**: `cd chrome-plugin && npm test && npx playwright test && npm run lint && npm run format:check && npm run build`
- [ ] **Step 2: Commit(如有修复)** `fix: Chrome 门禁修补`

### Task 4: IntelliJ web ChatPanel 同款

**Files:**
- Modify: `intellij-plugin/src/main/resources/web/chat-panel.ts`
- Test: `intellij-plugin/src/main/resources/web/chat-panel.test.ts`

**Interfaces:**
- Produces(与 Task 1 同名同签名,供 Task 5 消费):`onClose`、`onNewConversation`、`activeConversation()`、`restoreHistory()`。按钮文案「新对话」,class 沿用 `english-syntax-chat-*` 体系,header 顺序 `summary | 新对话 | 收起 | 关闭`(close 保持 last-child,既有拖动测试用 `.header button:last-child` 认 close)。

- [ ] **Step 1: 写失败测试**(chat-panel.test.ts 增 4 条,镜像 Task 1 的断言,选择器用 `.english-syntax-chat-*`)
- [ ] **Step 2**: `cd intellij-plugin && npx vitest run src/main/resources/web/chat-panel.test.ts` 确认失败
- [ ] **Step 3: 实现**(镜像 Task 1;气泡复用该文件 `#bubble`)
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: Commit** `feat: 追问面板新增恢复 API 与新对话按钮(IntelliJ)`

### Task 5: IntelliJ bootstrap 按句存储与恢复

**Files:**
- Modify: `intellij-plugin/src/main/resources/web/bootstrap-entry.ts:555-559`(seam)、`:571-581`(模块态)、`:611-619`(installChatPanel)、`:646-667`(图标点击监听)、`:380-385`(换代)
- Test: `intellij-plugin/src/main/resources/web/bootstrap-lifecycle.test.ts`

**Interfaces:**
- Consumes: Task 4 四成员。
- Produces:
  - `ChatPanelSeam` 扩两个必需成员:`activeConversation(): { sentenceId: string; history: ChatTurn[] } | null`、`restoreHistory(history: readonly ChatTurn[]): void`(既有测试的 fake 面板需补桩)。
  - 模块级 `chatConversations: Map<string, ChatTurn[]>`(LRU 8,同 `#parkChatConversation` 语义);`installChatPanel` 里 `chatPanelInstance.onNewConversation = () => {...}`(删 store 条目、铸新 id、`panel.open` 复位);换代处(`chatPanelInstance?.dispose(); chatSentenceId = null;`)加 `chatConversations.clear()`。

- [ ] **Step 1: 写失败测试**(bootstrap-lifecycle.test.ts 增 4 条 + 既有 fake 面板补桩)
  1. **关闭重开恢复**:真面板流程(图标点击 → submit → CHAT_RESULT → 点「关闭」)→ 再点图标 → 气泡与历史恢复、conversationId 递增、续问 CHAT_ASK 携带恢复历史。
  2. **A→B→A**:同款,切句停靠/恢复。
  3. **新对话**:点「新对话」→ 气泡清空、id 递增;再关闭重开 → 空。
  4. **换代清空**:对话后触发换代(initialize 新 generation)→ 再点图标 → 空会话。
- [ ] **Step 2**: `cd intellij-plugin && npx vitest run src/main/resources/web/bootstrap-lifecycle.test.ts` 确认失败
- [ ] **Step 3: 实现**(图标监听:park → lookup → 铸新 id → open → restore;park 走 seam 的 activeConversation)
- [ ] **Step 4: 跑该文件 + `npx vitest run` 全量确认通过**
- [ ] **Step 5: Commit** `feat: 追问对话按句恢复与新对话入口(IntelliJ)`

### Task 6: IntelliJ 门禁

- [ ] **Step 1**: `(cd intellij-plugin && npm ci && npm test) && ./gradlew :intellij-plugin:test :intellij-plugin:buildPlugin :intellij-plugin:verifyPluginProjectConfiguration`(gradle 网络坑按 `--no-configuration-cache` 等既有绕法,见 memory)
- [ ] **Step 2: Commit(如有修复)** `fix: IntelliJ 门禁修补`

### Task 7: 文档同步与收尾

- [ ] **Step 1**: `cd chrome-plugin && npm run docs:drift`,按提示核 `docs/architecture/rendering.md`(双端 chat 面板重开/新对话行为)等;顺手核 modules.md 相关条目职责描述。
- [ ] **Step 2**: CHANGELOG 增 Unreleased 节(用户可感:重开恢复 + 新对话按钮)。
- [ ] **Step 3**: 跑 `chrome-plugin` architecture-docs 测试(`npx vitest run src/shared/architecture-docs.test.ts`)确认不红。
- [ ] **Step 4**: Commit `docs: 追问对话重开恢复的架构文档与 CHANGELOG`
- [ ] **Step 5**: 走 finishing-a-development-branch 流程(merge 决策交给用户)。
