# 追问对话段落级上下文 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** chat 每轮提问注入「本句所在段 + 前后各一段」的原文（不分析），让模型能回答跨句指代/省略类问题；双端（Chrome / IntelliJ）同构。

**Architecture:** 页面侧脚本（Chrome content / IntelliJ web）按**文档序**算邻段并封顶截断，服务侧（Chrome SW / Kotlin）只做形状+封顶校验后拼进 prompt；prompt 四段变五段，两端逐字一致。chat 无缓存、会话机制（conversationId/停靠恢复/调度）全部不动。

**Tech Stack:** TypeScript（chrome-plugin Vitest/Playwright；intellij-plugin web 侧 Vitest）、Kotlin（IntelliJ Platform, Gradle）。

**Spec:** `docs/superpowers/specs/2026-11-28-chat-paragraph-context-design.md`（本计划从 spec 取值，执行者须同时读 spec）。

## Global Constraints

- **五处封顶常量必须同值**：`MAX_CHAT_SURROUNDING_BEFORE_CHARS = 1200`（保尾，截断前置 `…`）、`MAX_CHAT_SURROUNDING_CURRENT_CHARS = 4000`（整段；超长句锚窗口）、`MAX_CHAT_SURROUNDING_AFTER_CHARS = 800`（保头，截断后置 `…`）。分布：`chrome-plugin/src/shared/protocol.ts`、`chrome-plugin/src/content/chat-surroundings.ts`（import 前者）、`intellij-plugin/src/main/resources/web/bridge.ts`、`intellij-plugin/src/main/resources/web/chat-surroundings.ts`（import 前者）、`intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/bridge/BridgeProtocol.kt`。
- **prompt 首行不动**（`Discuss the verified translation analysis with the reader.`）；`PROMPT_FIRST_LINES` 不含 chat；`contracts.json` 的 `promptFirstLines` 零变更；`CORE/DETAIL` 版本常量不动。
- **双端五段逐字一致**。两段原文如下，Task 2（TS）与 Task 6（Kotlin）必须逐字节照抄：
  - 指令追加句（拼在现有指令串 `…split into short paragraphs.` 之后，前缀一个空格）：
    `The surrounding paragraphs are reference context only: use them to resolve references that point outside the sentence (for example what a pronoun refers to), but keep every answer about the selected sentence — do not analyze, divide, or translate the context paragraphs.`
  - 新增段（**一个**数组元素，内部四行以 `\n` 连接；缺省值写 `none`）：
    ```
    Surrounding context (reference only; not the topic):
    Paragraph before: {before 或 "none"}
    Paragraph containing the selected sentence: {current}
    Paragraph after: {after 或 "none"}
    ```
- **prompt 数组共 11 个元素**（`\n\n` 连接）：①首行 ②指令（含追加句）③`Selected sentence:` ④`serializeSentence` 句载荷 ⑤`Verified core result:` ⑥紧凑 core ⑦上下文段 ⑧`Conversation history (oldest first):` ⑨紧凑 history ⑩`Reader question:` ⑪question。上下文原文**直排**，不走 `serialize`/`serializeSentence`（spec 已豁免并写明理由）。
- **邻段一律按文档序**（`compareDocumentPosition` / DOM 先序遍历），不用 Map 插入序。
- 提交信息中文主题；lint 基线**恰好 1 个错误**（`options.test.ts` 的 `no-unnecessary-type-assertion`），不得新增错误。
- 门禁：Chrome `cd chrome-plugin && npm test && npx playwright test && npm run lint && npm run format:check && npm run build`；IntelliJ `(cd intellij-plugin && npm ci && npm test) && ./gradlew :intellij-plugin:test :intellij-plugin:buildPlugin :intellij-plugin:verifyPluginProjectConfiguration`。

## Review Focus

1. **插入序错位喂错邻段**（轻量→全量升级后 Map 序 `[p3,p1,p2,…]`、突变刷新重插尾部）→ 必须按文档序取 ±1。测试：Task 3（session 层错序场景）+ Task 7（走查天然文档序）。
2. **IntelliJ auto 模式整页挂卡且全部已注册** → 只读走查必须忽略 `registeredElements`/`HIDDEN_ATTRIBUTE` 两项过滤。测试：Task 7 `preview.test.ts`。
3. **伪造/超限 surroundings** → 双端门拒收（Chrome `isChatContext`、IntelliJ 桥双镜像）。测试：Task 1 + Task 5。
4. **本块不在候选清单**（轻量合成 `selection-N` 锚、`nearestPreviewBlock` 门不匹配的显式块）→ 并入排序后取真实邻段；元素脱 DOM → `none`。测试：Task 3 + Task 7 的 `documentOrderedNeighbors` 单测。
5. **本段超长（块上限 20k 字符）** → 句锚窗口必须完整包含锚句而不是头部截断。测试：Task 3 + Task 7 的 `capSurroundingCurrent` 单测。

---

### Task 1: Chrome 协议层——ChatSurroundings 类型、封顶常量、isChatContext 守卫

**Files:**
- Modify: `chrome-plugin/src/shared/protocol.ts`（常量区 ~line 27 与 `ChatContext` ~line 283；`isChatContext` ~line 447）
- Test: `chrome-plugin/src/background/service-worker.test.ts`（chat 用例区 ~line 1756）

**Interfaces:**
- Produces: `export interface ChatSurroundings { before?: string; current?: string; after?: string }`、三个 `MAX_CHAT_SURROUNDING_*_CHARS` 常量、`ChatContext.surroundings?: ChatSurroundings`。Task 2/3 消费。

- [ ] **Step 1: Write the failing test**

在 `service-worker.test.ts` 的 chat 用例区扩展 `chatAskRequest`，支持可选 `surroundings`；新增三个非法用例，走既有 `dispatch` helper 断言 ERROR：

```ts
// chatAskRequest options 增 surroundings?: ChatSurroundings；合法轮次带
// { before: "Previous paragraph text.", current: "Current paragraph text.", after: "Next paragraph text." }
// 非法用例（各断言 response 为 ERROR、code 为 MALFORMED_MESSAGE）：
// 1) surroundings: { before: "x", extra: "y" }            —— 多余键
// 2) surroundings: { before: "x".repeat(1201) }            —— 超 1200 上限
// 3) surroundings: { before: "   " }                       —— trim 后为空
// 4) context: { kind: "sentence", sentence, core, surroundings: "not-an-object" } —— 类型错
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd chrome-plugin && npx vitest run src/background/service-worker.test.ts`
Expected: FAIL（新用例断言 ERROR，实际走了正常路径或类型不匹配）

- [ ] **Step 3: Implement in `src/shared/protocol.ts`**

常量区（`MAX_SENTENCES_PER_REQUEST` 旁）新增三个常量与接口；`ChatContext` 增 `surroundings?: ChatSurroundings`；`isChatContext` 的 `hasOnlyKeys` 键集加 `"surroundings"`，并新增 `isChatSurroundings` 守卫：`isRecord` + `hasOnlyKeys(value, ["before","current","after"])` + 至少一个键存在 + 每个存在的键是 string、`trim()` 非空、长度 ≤ 对应 `MAX_CHAT_SURROUNDING_*_CHARS`。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd chrome-plugin && npx vitest run src/background/service-worker.test.ts`
Expected: PASS（含既有 chat 用例不回归）

- [ ] **Step 5: Commit**

```bash
git add chrome-plugin/src/shared/protocol.ts chrome-plugin/src/background/service-worker.test.ts
git commit -m "feat: chat 段落上下文的协议类型与守卫(Chrome)"
```

### Task 2: Chrome buildChatPrompt 五段

**Files:**
- Modify: `chrome-plugin/src/background/prompts.ts:397-417`（`buildChatPrompt`）
- Test: `chrome-plugin/src/background/prompts.test.ts`（`describe("buildChatPrompt")` ~line 688）

**Interfaces:**
- Consumes: Task 1 的 `ChatContext.surroundings`。
- Produces: prompt 11 元素数组（见 Global Constraints）；Task 6 的 Kotlin 实现逐字镜像它。

- [ ] **Step 1: Write the failing test**

`describe("buildChatPrompt")` 内改造 `prompt()` helper 支持 `surroundings`；新增断言：

```ts
// 带 surroundings: { before: "Before text.", current: "Current text.", after: "After text." }
// 1) text.split("\n\n") 长度 === 11
// 2) sections[6] === "Surrounding context (reference only; not the topic):\n" +
//    "Paragraph before: Before text.\n" +
//    "Paragraph containing the selected sentence: Current text.\n" +
//    "Paragraph after: After text."
// 3) sections[1] 以 Global Constraints 的指令追加句结尾（含前导空格）
// 不带 surroundings:
// 4) sections[6] 三处值均为 "none"
// 既有断言保留: 首行不变、PROMPT_FIRST_LINES 不含 chat
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd chrome-plugin && npx vitest run src/background/prompts.test.ts`
Expected: FAIL（11 段断言不成立）

- [ ] **Step 3: Implement `buildChatPrompt`**

数组从 9 元素扩到 11 元素：在 `serialize(input.context.core)` 之后插入上下文段元素——`input.context.surroundings` 的三字段（缺省 `"none"`）按 Global Constraints 的骨架四行以 `"\n"` join；指令串追加句照抄。函数签名不变（surroundings 从 `input.context` 读）。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd chrome-plugin && npx vitest run src/background/prompts.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add chrome-plugin/src/background/prompts.ts chrome-plugin/src/background/prompts.test.ts
git commit -m "feat: chat 提示词注入 Surrounding context 段(Chrome)"
```

### Task 3: Chrome content 邻段计算——纯函数模块 + askChat 接线

**Files:**
- Create: `chrome-plugin/src/content/chat-surroundings.ts`、`chrome-plugin/src/content/chat-surroundings.test.ts`
- Modify: `chrome-plugin/src/content/session-controller.ts:840-874`（`askChat`）+ 轻量会话一次性扫描缓存字段（`stop()` 清空）
- Test: `chrome-plugin/src/content/session-controller.test.ts`（`describe("SessionController 追问对话接线")` ~line 2742）

**Interfaces:**
- Consumes: Task 1 的 `ChatSurroundings` 与三个常量（import，不得自写数字）。
- Produces（`chat-surroundings.ts`，Task 7 的 web 模块逐函数镜像）：

```ts
export interface SurroundingCandidate {
  element: HTMLElement;
  text: string;
}
/** 候选按 compareDocumentPosition 排文档序,返回 current 的 ±1;current 脱 DOM 或不在候选里时按并入排序处理,均无邻块则两项 undefined。 */
export function documentOrderedNeighbors(
  candidates: readonly SurroundingCandidate[],
  current: SurroundingCandidate,
): { before?: SurroundingCandidate; after?: SurroundingCandidate };
/** trim 后 ≤1200 原样返回;超长取尾部 1200 字符并前置 "…"(U+2026)。 */
export function capSurroundingBefore(text: string): string;
/** trim 后 ≤800 原样返回;超长取头部 800 字符并后置 "…"。 */
export function capSurroundingAfter(text: string): string;
/** trim 后 ≤4000 原样返回;超长取句锚窗口(算法见 Step 3),两端按需 "…"。 */
export function capSurroundingCurrent(text: string, anchorText: string): string;
export function buildChatSurroundings(input: {
  neighbors: { before?: string; after?: string };
  currentText: string;
  anchorText: string;
}): ChatSurroundings;
```

- [ ] **Step 1: Write the failing tests（纯函数）**

`chat-surroundings.test.ts`（happy-dom 造元素）：
- `capSurroundingBefore`：1200 恰好原样；1201 取尾 1200 且首字符 `…`；首尾空白先 trim。
- `capSurroundingAfter`：800 边界与 `…` 后置。
- `capSurroundingCurrent`：≤4000 原样；超长且 anchor 命中 → 输出**完整包含** anchorText 且 ≤4000+2；anchor 长于窗口 → 从 anchor 起始处开窗；anchor 不命中 → 头部窗口；两端 `…` 仅在真截断时出现。
- `documentOrderedNeighbors`：三个段落按 DOM 顺序构造但 candidates 乱序传入 → before/after 是 DOM 序 ±1；current 不在 candidates 里 → 并入后仍取到真实邻块；current 脱 DOM（`remove()`）→ `{}`。

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd chrome-plugin && npx vitest run src/content/chat-surroundings.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: Implement `chat-surroundings.ts`**

`documentOrderedNeighbors`：过滤 `element.isConnected`；`[...candidates, current]` 去重（按 element 身份）后以 `a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING` 排序；定位 current 取 ±1。
`capSurroundingCurrent` 算法（签名与测试不定死的部分）：`trimmed = text.trim()`；`idx = trimmed.indexOf(anchorText)`；`start = idx >= 0 ? Math.max(0, idx - 1200) : 0`；`end = start + 4000`；若 `idx >= 0 && end < idx + anchorText.length` 则 `start = idx; end = idx + 4000`；`end = Math.min(trimmed.length, end)`；返回 `(start > 0 ? "…" : "") + trimmed.slice(start, end) + (end < trimmed.length ? "…" : "")`。
`buildChatSurroundings`：`{ before: cap 前(neighbors.before), current: capSurroundingCurrent(currentText, anchorText), after: cap 后(neighbors.after) }`，缺省字段不置（undefined）。

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd chrome-plugin && npx vitest run src/content/chat-surroundings.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing session tests**

`session-controller.test.ts` 的 chat 用例区（沿用 `chatHarness`，页面扩成三段 `<p>`，`scan` 回调返回三个 candidate）：
1. **常规**：`askChat("sentence-2"...)`（中段句）→ 发出的 `CHAT_ASK.context.surroundings.before`/`after` 恰为前/后段文本，`current` 为中段整段文本。
2. **文档序钉子**：`scan: () => [c2, c1, c3]`（扫描序刻意打乱模拟插入序错位）→ 中段句的 before 仍是 DOM 序前段（c1）。
3. **轻量一次性扫描**：按既有显式手势测试的模式构造未扫描会话（`parseHoveredBlock`/`parseSelection` 路径，参考同文件既有用例）→ 首次 `askChat` 后 `options.scan` 恰好多调一次（spy 计数）、扫描结果**未**注册块（`status.discovered` 不变）；第二次 `askChat` 不再调用（缓存）；`stop()` 后缓存作废（重新调用）。
4. **合法巨长块**：本段文本 > 4000 → `surroundings.current` ≤ 4002 且含锚句。

- [ ] **Step 6: Run tests to verify they fail**

Run: `cd chrome-plugin && npx vitest run src/content/session-controller.test.ts`
Expected: FAIL（surroundings 尚未接线）

- [ ] **Step 7: Implement in `session-controller.ts`**

`askChat` 内、构造 `request` 前新增私有方法 `#chatSurroundingsFor(sentence: SentenceRecord): ChatSurroundings`：
- `current` 块 = `this.blocks.get(sentence.blockId)`（`candidate.text` 与 `candidate.element`）。
- 候选集 = `[...this.blocks.values()].map(b => ({ element: b.candidate.element, text: b.candidate.text }))`；若 `!this.scanned`，合并一次性扫描缓存（`this.scan(this.document)` 的返回 map 成候选，**只读**：不调 `registerCandidates`、不 `viewport.observe`；缓存存私有字段，`stop()` 清空）。
- `documentOrderedNeighbors(candidates, { element: 当前块 element, text: 当前块 text })` → `buildChatSurroundings({ neighbors, currentText, anchorText: sentence.input.text })`。
- `request` 的 `context` 增 `surroundings`。

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd chrome-plugin && npx vitest run src/content/session-controller.test.ts && npx vitest run src/background/prompts.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add chrome-plugin/src/content/chat-surroundings.ts chrome-plugin/src/content/chat-surroundings.test.ts chrome-plugin/src/content/session-controller.ts chrome-plugin/src/content/session-controller.test.ts
git commit -m "feat: askChat 按文档序计算段落上下文(Chrome)"
```

### Task 4: Chrome E2E + 文档同步 + Chrome 全门禁

**Files:**
- Modify: `chrome-plugin/tests/e2e/extension.spec.ts`（chat 用例 ~line 1081「追问对话 chat 面板」）
- Modify: `AGENTS.md`（chat 旁路 bullet 追加段落上下文规则）、`docs/architecture/protocol.md`、`docs/architecture/model-pipeline.md`、`CHANGELOG.md`
- 可能修改: `chrome-plugin/src/shared/architecture-docs.test.ts` 红了所指向的文档（**不得放宽断言**）

**Interfaces:**
- Consumes: Task 1-3 的全部产物（已合入运行时链路）。

- [ ] **Step 1: Write the failing E2E assertion**

在既有 chat 用例（两段流式回答那个）里、第一轮发送后断言：`harness.fakeModel` 记录的 chat 请求（`recordedOfKind`，kind 以 `detectKind` 实现为准）prompt 含 `"Surrounding context (reference only; not the topic):"` 行（用例页面单段，三值应为 `none`/本段文本——不断言墙钟）。

- [ ] **Step 2: Run to verify it fails**

Run: `cd chrome-plugin && npx playwright test -g "追问对话"`
Expected: FAIL（prompt 无该段）

- [ ] **Step 3: Verify it passes**

Run: `cd chrome-plugin && npx playwright test -g "追问对话"`
Expected: PASS（Task 3 已接线，E2E 只是端到端钉子；若红则修 Task 1-3 的接线）

- [ ] **Step 4: 文档同步**

`protocol.md`（CHAT_ASK 字段与守卫）、`model-pipeline.md`（chat prompt 五段+封顶常量）、`AGENTS.md` chat 旁路 bullet 追加「段落上下文：页面侧按文档序取本段±1、封顶 1200/4000/800、邻段原文带封顶过桥/过 SW，服务侧只校验」、`CHANGELOG.md`。然后 `npm run docs:drift` 并补漏；`npm test` 若 `architecture-docs.test.ts` 红则改文档（不放宽断言）。

- [ ] **Step 5: Chrome 全门禁**

Run: `cd chrome-plugin && npm test && npx playwright test && npm run lint && npm run format:check && npm run build`
Expected: 全绿；lint 恰好 1 个既有错误

- [ ] **Step 6: Commit**

```bash
git add chrome-plugin AGENTS.md docs CHANGELOG.md
git commit -m "feat: chat 段落上下文端到端与文档(Chrome)"
```

### Task 5: IntelliJ 桥门双镜像——CHAT_ASK 九键 + surroundings 封顶门 + model 类型与映射

**Files:**
- Modify: `intellij-plugin/src/main/resources/web/bridge.ts`（常量区 ~line 13、`ChatAskPageMessage` ~line 79、`PAGE_KEYS_BY_TYPE` ~line 204、parse `case "CHAT_ASK"` ~line 302）
- Modify: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/bridge/BridgeProtocol.kt`（常量 ~line 227、`PageMessage.ChatAsk` ~line 62-77、`parseChatAsk` ~line 325）
- Modify: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/model/Prompts.kt:339`（`ChatTurn` 旁新增 model 类型）
- Test: `intellij-plugin/src/main/resources/web/bridge.test.ts`、`intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/bridge/BridgeProtocolTest.kt`

**Interfaces:**
- Produces:
  - web：`export interface ChatSurroundings { before?: string; current?: string; after?: string }`、三个 `MAX_CHAT_SURROUNDING_*_CHARS` 常量、`ChatAskPageMessage.surroundings?: ChatSurroundings`。Task 7 消费。
  - Kotlin bridge：`PageMessage.ChatAsk` 增 `val surroundings: ChatSurroundings?`（嵌套 `data class ChatSurroundings(val before: String?, val current: String?, val after: String?)`）。
  - Kotlin model：`data class ChatSurroundings(val before: String?, val current: String?, val after: String?)`（与 `model.ChatTurn` 并排，**与 bridge 类型分立**——沿用 ChatTurn 的桥/模型分层先例，connector 做映射）。Task 6 消费。

- [ ] **Step 1: Write the failing tests**

`bridge.test.ts`（沿用既有 `chatAsk(...)` helper，扩可选 surroundings）与 `BridgeProtocolTest.kt`（沿用 ~line 228 的 JSON 构造）**双端同组用例**：
- 合法：三字段全带（各 ≤ 上限）、只带 `current`、不带 `surroundings` 键 → 解析成功且字段正确。
- 非法（两端都断言拒收 null）：多余键（`{before,extra}`）、`before` 超 1200、`current` 超 4000、`after` 超 800、空串、纯空白串（web `.trim()` / Kotlin `trimJsWhitespace` 同答案）、`surroundings` 为非对象、空对象 `{}`（零键）、顶层多 `surroundings` 之外的白名单键泄漏（如 `apiKey`）照旧拒。

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd intellij-plugin && npx vitest run src/main/resources/web/bridge.test.ts && ./gradlew :intellij-plugin:test --tests "dev.codetui.englishsyntax.bridge.BridgeProtocolTest"`
Expected: FAIL（新用例不受门保护）

- [ ] **Step 3: Implement 双端门**

- web `bridge.ts`：常量 + 接口 + `PAGE_KEYS_BY_TYPE.CHAT_ASK` 追加 `"surroundings"`；parse 分支：`surroundings` 存在时须为 record、`hasOnlyKeys` 校验为 `["before","current","after"]` 的子集且至少一键、各值为 string、`trim()` 非空、长度 ≤ 对应常量；**值原样透传不 trim**（与 `question` 在门里 trim 的做法刻意不同——surroundings 是机器算好的已封顶文本，两侧一致只校验不改写）。
- Kotlin `BridgeProtocol.kt`：常量 + 嵌套类型 + `hasOnlyKeys` 九键 + 解析（`JsonObject`、键集恰为三键子集且非空、`string` 非空、`trimJsWhitespace` 判非空、`length` ≤ 对应常量、值原样透传）。
- `model/Prompts.kt`：新增 model `ChatSurroundings`。
- connector 映射（bridge 类型 → model 类型）依赖 Task 6 的 `launchChatAsk` 新签名，**挪到 Task 6 Step 3 一起落**，本 task 不碰 `PreviewSessionConnector.kt`。

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd intellij-plugin && npx vitest run src/main/resources/web/bridge.test.ts && ./gradlew :intellij-plugin:test --tests "dev.codetui.englishsyntax.bridge.BridgeProtocolTest"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add intellij-plugin/src/main/resources/web/bridge.ts intellij-plugin/src/main/resources/web/bridge.test.ts intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/bridge/BridgeProtocol.kt intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/bridge/BridgeProtocolTest.kt intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/model/Prompts.kt
git commit -m "feat: 桥 CHAT_ASK surroundings 封顶门双镜像(IntelliJ)"
```

### Task 6: Kotlin prompt 五段 + 会话/服务穿参

**Files:**
- Modify: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/model/Prompts.kt:341-366`（`buildChatPrompt`）
- Modify: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/analysis/AnalysisService.kt`（接口 `chat` ~line 126、实现 ~line 412）
- Modify: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/session/PreviewSession.kt:788-833`（`launchChatAsk`/`onChatAsk`）
- Modify: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/session/PreviewSessionConnector.kt:70-76`（映射，Task 5 遗留）
- Test: `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/model/PromptsTest.kt`（chat 区 ~line 518-565）、AnalysisService 与 PreviewSession 的既有 chat 测试

**Interfaces:**
- Consumes: Task 5 的 model `ChatSurroundings`。
- Produces: `buildChatPrompt(input: SentenceInput, core: CoreAnalysis, surroundings: ChatSurroundings?, history: List<ChatTurn>, question: String): String`；`AnalysisService.chat(profile, documentId, conversationId, input, core, surroundings: ChatSurroundings?, history, question, onStreamedText)`。

- [ ] **Step 1: Write the failing tests**

`PromptsTest.kt`（镜像 Task 2 的断言）：改造既有两用例 → `sections.size == 11`；`sections[1]` 以指令追加句结尾；`sections[6]` 带值与 `none` 两种形态逐字断言（字符串照抄 Global Constraints）；首行用例不动。
AnalysisService 测试：`chat(...)` 收到非空 surroundings → 发出的 prompt（经 fake client 捕获）含骨架头行；`null` → 三处 `none`。
PreviewSession 测试：`launchChatAsk` 传入 surroundings → fake analysis `chat` 收到同值。

- [ ] **Step 2: Run tests to verify they fail**

Run: `./gradlew :intellij-plugin:test --tests "dev.codetui.englishsyntax.model.PromptsTest"`
Expected: FAIL（11 段不成立 / 签名不存在）

- [ ] **Step 3: Implement**

`buildChatPrompt` 数组扩为 11 元素（Kotlin `listOf` 照抄 Global Constraints 的两段原文与元素顺序；上下文段为单元素、内部 `joinToString("\n")`）；doc comment「四段」→「五段」。`AnalysisService.chat` 接口与实现增参并传给 `buildChatPrompt`；`PreviewSession.launchChatAsk`/`onChatAsk` 增参透传；connector 映射接上（Task 5 遗留）。

- [ ] **Step 4: Run tests to verify they pass**

Run: `./gradlew :intellij-plugin:test`
Expected: PASS（全模块，防签名漏改）

- [ ] **Step 5: Commit**

```bash
git add intellij-plugin/src/main/kotlin intellij-plugin/src/test/kotlin
git commit -m "feat: Kotlin chat 提示词五段与会话穿参(IntelliJ)"
```

### Task 7: IntelliJ web 邻段计算——只读走查 + renderer 访问器 + bootstrap 接线

**Files:**
- Modify: `intellij-plugin/src/main/resources/web/preview.ts:187-201`（`scanMarkdownBlocks` 抽出共用候选走查）+ 新导出
- Modify: `intellij-plugin/src/main/resources/web/render.ts`（renderer 公有访问器，`sentenceText` 旁）
- Create: `intellij-plugin/src/main/resources/web/chat-surroundings.ts` + 测试
- Modify: `intellij-plugin/src/main/resources/web/bootstrap-entry.ts:680-698`（`sendChatAsk`）
- Test: `preview.test.ts`、`render.test.ts`（存在则扩）、`bootstrap-lifecycle.test.ts`（chat 区）

**Interfaces:**
- Consumes: Task 5 的 web `ChatSurroundings` 与常量。
- Produces:
  - `preview.ts`：`export function collectContextBlocks(root: ParentNode): SurroundingCandidate[]`（`SurroundingCandidate` 从 `chat-surroundings.ts` import）——与 `scanMarkdownBlocks` 共用同一候选走查（tag 过滤 + `collectCandidates` 资格门），**忽略 `registeredElements` 与 `HIDDEN_ATTRIBUTE` 过滤、零副作用**（不 `ensureBlockId`、不登记），文本取 `(element.textContent ?? "").trim()`，`querySelectorAll` 先序即文档序。
  - `render.ts`：`sentenceBlockElement(sentenceId: string): HTMLElement | null`（`#sentences` 的 blockId → `#blocks` 的 element）。
  - `web/chat-surroundings.ts`：**逐函数镜像** Task 3 的 `chrome-plugin/src/content/chat-surroundings.ts`（同名导出：`SurroundingCandidate`、`documentOrderedNeighbors`、`capSurroundingBefore/After/Current`、`buildChatSurroundings`）。

- [ ] **Step 1: Write the failing tests**

- `preview.test.ts`：先 `scanMarkdownBlocks` 注册全部块（auto 语义），再 `collectContextBlocks` → 返回**全部**块（含已注册、含已挂卡隐藏的）；零副作用断言：走查后再 `scanMarkdownBlocks` 仍返回空（注册态未被扰动）；DOM 先序。
- `render.test.ts`（或 renderer 所在测试文件）：`sentenceBlockElement` 命中已注册句 → 对应块元素；未注册句 → null。
- `chat-surroundings.test.ts`：镜像 Task 3 Step 1 的用例组（同断言、同值）。
- `bootstrap-lifecycle.test.ts`：三段 Markdown DOM，`sendChatAsk`（autoScan 与 manual 两种 `initialize` 形态）→ post 出的 `CHAT_ASK.surroundings.before/current/after` 为前后段与本段文本；巨长本段 → `current` 封顶含锚句。

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd intellij-plugin && npm test`
Expected: FAIL（走查/模块/接线不存在）

- [ ] **Step 3: Implement**

按 Interfaces 三块实现：`preview.ts` 把 `querySelectorAll` + tag 过滤 + `collectCandidates` 抽成私有 `collectEligibleElements(root)`，`scanMarkdownBlocks` 与 `collectContextBlocks` 各自消费（门单一来源，防漂移）；`render.ts` 加访问器；`chat-surroundings.ts` 镜实现；`bootstrap-entry.ts` 的 `sendChatAsk` 内：

```ts
// current 与候选集（renderer 找不到本句元素 → 不带 surroundings 键）
const currentEl = s.renderer.sentenceBlockElement(input.sentenceId);
const candidates = collectContextBlocks(document.body);
const current = currentEl === null ? null
  : candidates.find((c) => c.element === currentEl)
    ?? { element: currentEl, text: (currentEl.textContent ?? "").trim() };
const surroundings = current === null ? undefined : buildChatSurroundings({
  neighbors: documentOrderedNeighbors(candidates, current),
  currentText: current.text,
  anchorText: s.renderer.sentenceText(input.sentenceId),
});
// 消息对象增 surroundings（undefined 时省略键）
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd intellij-plugin && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add intellij-plugin/src/main/resources/web
git commit -m "feat: web 侧只读走查与邻段计算(IntelliJ)"
```

### Task 8: IntelliJ 端到端钉子 + 文档 + 双端全门禁

**Files:**
- Modify: `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/session/PageMessageWiringTest.kt:217`（CHAT_ASK 用例带 surroundings）
- Modify: `AGENTS.md`（「八键白名单」→「九键白名单 + surroundings 三键子集与 1200/4000/800 封顶」）、`CHANGELOG.md`（收口）
- Test: 上述 wiring 用例

**Interfaces:**
- Consumes: Task 5-7 全部产物。

- [ ] **Step 1: Write the failing→passing wiring test**

`PageMessageWiringTest.kt` 既有 CHAT_ASK JSON 构造带 `"surroundings":{"before":"…","current":"…","after":"…"}` → 断言 fake analysis `chat` 收到映射后的 model `ChatSurroundings`（先跑 FAIL 验证门/穿参真实生效，再补漏）。

Run: `./gradlew :intellij-plugin:test --tests "dev.codetui.englishsyntax.session.PageMessageWiringTest"`
Expected: 先 FAIL 后 PASS

- [ ] **Step 2: 文档收口**

`AGENTS.md` 八键→九键与封顶说明；`CHANGELOG.md` 补 IntelliJ 侧；`cd chrome-plugin && npm run docs:drift` 复查无漏。

- [ ] **Step 3: 双端全门禁**

Run: `cd chrome-plugin && npm test && npx playwright test && npm run lint && npm run format:check && npm run build && cd .. && (cd intellij-plugin && npm ci && npm test) && ./gradlew :intellij-plugin:test :intellij-plugin:buildPlugin :intellij-plugin:verifyPluginProjectConfiguration`
Expected: 全绿；lint 恰好 1 个既有错误

- [ ] **Step 4: Commit**

```bash
git add intellij-plugin AGENTS.md CHANGELOG.md
git commit -m "feat: chat 段落上下文端到端与文档收口(IntelliJ)"
```
