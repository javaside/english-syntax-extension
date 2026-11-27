# Alt+T 悬停解析开关循环 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Alt+T 悬停解析在双端获得完整开关循环：翻译 → 再按恢复原文 → 再按重显卡片（不调模型）。

**Architecture:** 卡片是否在页上即开关状态，块记录/句子 phase/缓存全不动。Chrome 端只改 `SessionController.parseHoveredBlock()` 的两条拦截分支；IntelliJ 端改 `bootstrap-entry.ts` 的两条「该段已解析」分支，renderer 公开单块 `restoreBlock`/`repaintBlock`。协议、Kotlin、prompt 零变更。

**Tech Stack:** TypeScript（Vitest / happy-dom / Playwright 假服务器）+ IntelliJ web 侧 TS（Vitest）。

**Spec:** `docs/superpowers/specs/2026-11-28-hover-toggle-restore-design.md`（裁决：双端同步、只 Alt+T 有开关语义、解析中不取消）

## Global Constraints

- 在隔离 worktree 开发（`superpowers:using-git-worktrees`），绝不在 main 直接写实现
- 协议零变更：不碰 `chrome-plugin/src/shared/protocol.ts`、`intellij-plugin` 的 `BridgeProtocol.kt` 与任何桥消息
- `explicitBlockNotice` 及其 `ALREADY_PARSED_ERROR` 保持原语义（`parseSelection` 仍提示「该段已解析」）
- 双端去抖常量 `PARSE_DEBOUNCE_MS = 400` 不变；被去抖挡掉的 toggle 按键**静默忽略**（返回 `undefined`，不得闪回）
- toggle 关/开成功均不打 pill/flashStatus（原文复现/卡片复现即反馈）；「该段正在解析中…」提示文案双端逐字一致
- Chrome 门禁全套 + lint 基线恰好 1 个既有错误；IntelliJ 门禁 `npm test` + gradle 三件；提交信息中文主题
- 文档同步：`docs/architecture/rendering.md`、AGENTS.md「显式手势」段、CHANGELOG；提交前 `npm run docs:drift`

## Review Focus

1. **去抖窗口内的连按**（400ms 内开关交替）：第二按必须静默忽略，卡片不得抖动闪回 —— Task 1 测试钉住
2. **纯 skipped 块**（cacheOnly 整块未命中，卡片从未上页）：重显分支不得凭空插纯文本卡，维持「该段已解析」提示 —— Task 1 测试
3. **流式/queued 间隙按键**（卡片已在页、句子未全终态）：不得关卡，走原有「提示在飞 / 继续下发」路径 —— Task 1 / Task 4 测试
4. **IntelliJ 重显误走 `registerBlock`**：会丢句子映射、卡片点不动 —— Task 4 测试断言不注册、不重发 `PARSE_BLOCK`
5. **追问面板锚定在别的块时 toggle 本块**：不得误收面板 —— Task 4 测试（`sentenceBlockId` 判块后才 `dispose`）

---

### Task 1: Chrome 控制器开关逻辑

**Files:**
- Modify: `chrome-plugin/src/content/session-controller.ts:574-646`（`parseHoveredBlock` 及其周边）
- Test: `chrome-plugin/src/content/session-controller.test.ts`（悬停快捷键用例区，~1474-1760）

**Interfaces:**
- Consumes: 现有 `blockShowing`、`IN_FLIGHT_PHASES`、`SETTLED_PHASES`、`debounceExplicitParse`、`IN_FLIGHT_ERROR`、`ALREADY_PARSED_ERROR`、`ControllerReplacement.restore()/show()/active`、`ControllerMarker.clear()`
- Produces: `parseHoveredBlock()` 语义扩展（无新公开 API）：全终态 + 卡片在页 → `restore()` 后返回 `undefined`；全终态 + 卡片不在页 + 至少一句 ready/failed → `show()` 重显并返回 `undefined`；`restores`/`shows` 计数语义不变（E2E 与后续任务依赖假件计数）

- [ ] **Step 1: 写「关」的失败测试（两个探针）**

「关」有两个入口探针，行为相同（都到 `restore()`）：
- **卡片探针**：hoverTarget 返回 `subject.replacements[0]!.displayed`（鼠标停在卡片上，`blockShowing` 命中）
- **原文探针**：改造现有用例「同一段落重复触发快捷键幂等：不重复注册句子」（~1554，hoverTarget 返回原文 `p`）——卡片在页（原文被隐藏）时 hover 链 quirks 仍可能指原文，等价关

两探针都断言：解析完成（`status.ready === 1`）后再次 `parseHoveredBlock()` 返回 `undefined`（不再是 `ALREADY_PARSED_ERROR`）、`subject.replacements[0]!.restores === 1`、`subject.markers[0]!.marked === null`、句子 phase 仍全 ready、`transport.sent` 的 `ANALYZE_CORE` 仍 1 条。现有「在飞时再按提示正在解析中」用例（~1571）保持原断言不动。

Run: `cd chrome-plugin && npx vitest run src/content/session-controller.test.ts -t 快捷键`
Expected: 新断言 FAIL（当前返回 `ALREADY_PARSED_ERROR`，`restores === 0`）

- [ ] **Step 2: 实现「关」分支（两探针共用一条路径）**

`parseHoveredBlock()` 的全终态关逻辑统一为私有 `toggleOff(block: BlockRecord): ExtensionError | undefined`（过 `debounceExplicitParse`，被挡返回 `undefined` 静默；`block.replacement.restore()` + `block.marker.clear()`；返回 `undefined`）。接入两处：`blockShowing(hovered)` 命中且全终态时（in-flight 分支保持 `IN_FLIGHT_ERROR`；queued 间隙落回原路径不变）；`known !== undefined` 且全终态且 `replacement.active === true` 时（原 `explicitBlockNotice` 在此路径的「已解析」提示被 toggle 替换——in-flight 提示保持）。`explicitBlockNotice` 本身不改（`parseSelection` 依赖原语义），`parseHoveredBlock` 内不再经它处理全终态情形。

Run: 同 Step 1 命令
Expected: PASS（含所有既有用例；`parseSelection` 相关用例不红）

- [ ] **Step 3: 写「开/循环/边界」的失败测试**

同一用例文件新增：
- **重显**：关之后（`restores === 1`）hoverTarget 返回原文 `p`，再按 → 返回 `undefined`、`shows === 2`、`ANALYZE_CORE` 计数不变、phase 不变
- **循环**：连续关→开→关，`restores === 2`、`shows === 3`（fake 的 `active` 语义即状态）
- **去抖**：`harness` 注入可控 `now`（`SessionControllerOptions.now`），400ms 内第二按返回 `undefined` 且 `restores` 不增；拨过 401ms 后生效
- **纯 skipped 块**：FakeTransport 返回 `cacheOnly: true` 且零 analyses（`renderSkipped` 路径），解析后按第二次 → 仍返回 `ALREADY_PARSED_ERROR`、`restores === 0`
- **选区不 toggle**：`parseSelection` 在已解析块上仍返回「该段已解析」提示（现有断言保留/补钉）

Run: 同 Step 1 命令
Expected: 新增用例 FAIL（`show` 未重调 / 重显路径缺失）

- [ ] **Step 4: 实现「开」分支与去抖接线**

`known !== undefined` 且全终态时：`replacement.active === true` → 关（与 `blockShowing` 分支同款：过 debounce，被挡返回 `undefined`；`restore()` + `marker.clear()`）；`active === false` 且至少一句 `phase` 为 `ready` 或 `failed` → 开（过 debounce；`replacement.show(candidate.element, learningBlock)`，返回 `undefined`）；`active === false` 且纯 skipped → 返回 `ALREADY_PARSED_ERROR`。in-flight 提示与 queued 间隙继续下发的原有路径保持。重显判据里「hover 指原文但卡片在页」（quirks 等价）由 `active === true` 分支天然覆盖。

Run: 同 Step 1 命令
Expected: PASS 全部

- [ ] **Step 5: 全量回归 + 提交**

Run: `cd chrome-plugin && npm test`
Expected: PASS（lint 基线不受影响——本任务未动 `options.test.ts`）

```bash
git add chrome-plugin/src/content/session-controller.ts chrome-plugin/src/content/session-controller.test.ts
git commit -m "feat: Alt+T 悬停解析支持开关循环——再按恢复原文/重显卡片(Chrome)"
```

---

### Task 2: Chrome E2E 开关循环

**Files:**
- Modify: `chrome-plugin/tests/e2e/extension.spec.ts:972-997`（现有「该段已解析」用例改为关语义）
- Test: 同文件新增循环用例

**Interfaces:**
- Consumes: Task 1 的行为；既有 `harness.dispatchFromUi(uiMessage("PARSE_HOVERED_BLOCK", …))`、`learningBlocks(page)`、`harness.fakeModel.recordedOfKind("core")` 探针

- [ ] **Step 1: 改造现有用例为「关」断言**

用例改名「同一段再按快捷键：恢复原文，不重发请求」：hover `#plain` → dispatch → 卡片出现后 hover 卡片（`learningBlocks(page).first().hover()`）→ dispatch → 断言 `#plain` `toBeVisible()`、`learningBlocks(page)` 计数为 0、`recordedOfKind("core")` 长度不变。原 pill 文案断言删除（toggle 成功不打 pill）。

Run: `cd chrome-plugin && npx playwright test extension.spec.ts -g "再按快捷键"`
Expected: FAIL（当前行为是提示「该段已解析」、卡片保留）

- [ ] **Step 2: 新增三连按循环用例**

同一 fixture（`hover-blocks.html` 的 `#plain`，两次 dispatch 共用一个 documentId）：解析 → 卡片 1 张、原文隐藏；hover 卡片 + dispatch → 原文可见、卡片 0 张、core 计数不变；再 hover 原文（`page.locator("#plain").hover()`）+ dispatch → 卡片 1 张、原文隐藏、core 计数仍不变。E2E 断言用探针（fetch 计数、节点可见性），不用墙钟。

Run: 同 Step 1 命令（`-g` 换成新用例名）
Expected: FAIL（第三按当前提示已解析，卡片不回来）

- [ ] **Step 3: 跑通并全量 E2E**

Run: `cd chrome-plugin && npx playwright test`
Expected: PASS（含其余悬停用例：`#div-paragraph`/`#illustrated` 首按行为不变）

- [ ] **Step 4: 提交**

```bash
git add chrome-plugin/tests/e2e/extension.spec.ts
git commit -m "test: E2E 覆盖 Alt+T 开关循环与原文恢复(Chrome)"
```

---

### Task 3: IntelliJ renderer 公开单块还原/重显

**Files:**
- Modify: `intellij-plugin/src/main/resources/web/render.ts`（`#repaintBlock` 建卡处 ~628-633、`#restoreBlock` ~1234、`#closeCorrection` ~1089、`restoreAll` ~1263）
- Test: `intellij-plugin/src/main/resources/web/render.test.ts`

**Interfaces:**
- Produces（Task 4 依赖，签名照抄）:
  - `restoreBlock(blockId: string): boolean` — 单块还原：块存在且卡片在页返回 `true`（并做该块的收尾：`#correction` 的句子属于该块才 `#closeCorrection()`；`#currentDetail` 的句子属于该块才清 `#currentDetail`/`#detailStack`/`#currentDetailPayload`；详解面板 DOM 挂卡内随卡销毁，其余块的 `.english-syntax-detail` 不动）；块不存在或无卡返回 `false`
  - `repaintBlock(blockId: string): void` — 公开薄壳，内部调 `#repaintBlock(blockId)`（空 options，重画已有句子、必要时重建卡片）
  - `sentenceBlockId(sentenceId: string): string | null` — 查 `#sentences` 的 `entry.blockId`，未注册返回 `null`
  - 卡片元素带 `dataset.blockId`（`#repaintBlock` 建 `record.card` 时设置）— bootstrap 用 `closest("[data-english-syntax-card]")` 反查
- Consumes: 既有 `#sentences: Map<string, { blockId, record }>`、`#blocks`、`#restoreBlock`

- [ ] **Step 1: 写失败测试**

`render.test.ts` 新增（参照既有 `restoreAll removes plugin nodes…` 用例 ~271 的搭法）：注册两块、各自 `renderCoreResult` 出卡后 `restoreBlock(blockA)` → A 原文可见（无 `HIDDEN_ATTRIBUTE`）、A 卡片不在 DOM、B 卡片原样且 B 原文仍隐藏；`restoreBlock` 返回 `true`；对未注册块返回 `false`。卡片属性用例：卡片元素 `dataset.blockId === blockId`。`repaintBlock`：`restoreBlock` 后 `repaintBlock(blockA)` → A 原文重新隐藏、卡片回来且句子内容在。`sentenceBlockId`：已注册句返回块 id，未注册返回 `null`。

Run: `cd intellij-plugin && npm test -- render.test.ts`
Expected: FAIL（方法不存在）

- [ ] **Step 2: 实现**

`#repaintBlock` 建卡分支加 `record.card.dataset.blockId = blockId`。新增三个公开方法（签名见 Interfaces；`restoreBlock` 内部逻辑：查 `#blocks`，无记录或 `record.card === null` 返回 `false`；判块收尾后调 `#restoreBlock(record)` 返回 `true`）。纠错行/详解的「属于该块」判定统一经 `#sentences.get(id)?.blockId === blockId`。

Run: 同 Step 1 命令
Expected: PASS（含 `restoreAll` 既有用例——`restoreAll` 可改为逐块调 `restoreBlock` 的语义或保持原样，以既有用例不红为准）

- [ ] **Step 3: web 全量回归 + 提交**

Run: `cd intellij-plugin && npm test`
Expected: PASS

```bash
git add intellij-plugin/src/main/resources/web/render.ts intellij-plugin/src/main/resources/web/render.test.ts
git commit -m "feat: renderer 公开单块还原/重显与句子→块查询(IntelliJ)"
```

---

### Task 4: IntelliJ bootstrap 开关接线

**Files:**
- Modify: `intellij-plugin/src/main/resources/web/bootstrap-entry.ts:287-330`（`parseHoveredBlock`）
- Test: `intellij-plugin/src/main/resources/web/bootstrap-lifecycle.test.ts`（既有「该段已解析」两用例 ~323-379 改造 + 新增）

**Interfaces:**
- Consumes: Task 3 的 `restoreBlock`/`repaintBlock`/`sentenceBlockId`/`dataset.blockId`；既有 `requestedBlocks`/`settledBlocks`、`flashStatus`、`ensureBlockId`、`chatPanelInstance`、`ChatPanel.dispose()`（触发 `onClose` 停靠后摘 host）
- Produces: 无新公开 API（行为变更）

- [ ] **Step 1: 写失败测试（改造 + 新增）**

改造既有两条「该段已解析」用例为关语义：解析 settle 后（a）显式传卡片内元素、(b) 显式传带 `HIDDEN_ATTRIBUTE` 的原文——`parseHoveredBlock(target)` 调用后原文可见、卡片移除、`postToHost` 无新 `PARSE_BLOCK`。新增：
- **重显**：关之后传未隐藏原文 → 卡片回来、`postToHost` 计数不变（不 `registerBlock`——断言卡片句子的 `data-sentence-id` 仍在且可查询）
- **循环**：关→开→关，卡片节点计数 0/1/0
- **正在解析中**：`requestedBlocks` 有、`settledBlocks` 无时传卡片元素 → `flashStatus` 文案「该段正在解析中…」、卡片不动
- **追问面板判块**：面板锚定块 B 的句子，toggle 块 A → 面板 host 仍在 DOM；toggle 块 B → 面板 host 被摘除（`dispose` 停靠路径）

Run: `cd intellij-plugin && npm test -- bootstrap-lifecycle.test.ts`
Expected: FAIL

- [ ] **Step 2: 实现**

`parseHoveredBlock(target?)` 三处改造：
1. 卡片分支（`closest("[data-english-syntax-card]")`）：`blockId = card.dataset.blockId`；`requestedBlocks.has(blockId) && !settledBlocks.has(blockId)` → `flashStatus("该段正在解析中…")`；否则（已 settle 或未请求——卡片在页必曾解析）→ `toggleOff(blockId)`
2. `HIDDEN_ATTRIBUTE` 分支：`blockId = ensureBlockId(element)`；同款 settle 判定 → 提示或 `toggleOff(blockId)`
3. 重显拦截（在现有 `ensureBlockId`+去抖之前）：`!element.hasAttribute(HIDDEN_ATTRIBUTE)` 且 `settledBlocks.has(ensureBlockId(element))` 且该块 `renderer` 有卡片历史（用 `renderer.currentElement`/卡片节点判，实现取最直接判据）→ `renderer.repaintBlock(blockId)` 后 return，**不** `registerBlock`、**不**发 `PARSE_BLOCK`
`toggleOff(blockId)` 内部：`renderer.restoreBlock(blockId)`；`chatSentenceId !== null && renderer.sentenceBlockId(chatSentenceId) === blockId` → `chatPanelInstance?.dispose()`（先停靠再摘 host，`dispose` 自带时序）。原文分支走 `ensureBlockId` 前注意：settle 判定只读集合，不改 `requestedBlocks`/`settledBlocks`。

Run: 同 Step 1 命令
Expected: PASS 全部

- [ ] **Step 3: web 全量 + Kotlin 门禁 + 提交**

Run: `cd intellij-plugin && npm test`；仓库根 `./gradlew :intellij-plugin:test :intellij-plugin:buildPlugin :intellij-plugin:verifyPluginProjectConfiguration`
Expected: PASS（Kotlin 零变更，跑门防意外）

```bash
git add intellij-plugin/src/main/resources/web/bootstrap-entry.ts intellij-plugin/src/main/resources/web/bootstrap-lifecycle.test.ts
git commit -m "feat: Alt+T 悬停解析支持开关循环——再按恢复原文/重显卡片(IntelliJ)"
```

---

### Task 5: 文档同步与全量门禁

**Files:**
- Modify: `docs/architecture/rendering.md`（单块还原/重显入口、双端 toggle 判据）、`AGENTS.md`（「显式手势」段：只有 Alt+T 有开关语义、解析中不取消、纯 skipped 块不重显）、`CHANGELOG`（双端条目）
- Test: `chrome-plugin/src/shared/architecture-docs.test.ts`（钉名字与数字——若引用了被改文档需同步）

**Interfaces:**
- Consumes: 前四个任务全部落地

- [ ] **Step 1: 改三份文档 + CHANGELOG**

要点照 spec「文档同步」段；AGENTS 写裁决本身（只 Alt+T、双端、去抖静默、纯 skipped 不重显），机制细节进 rendering.md。

- [ ] **Step 2: docs:drift + 双端全量门禁**

Run: `cd chrome-plugin && npm run docs:drift && npm test && npx playwright test && npm run lint && npm run format:check && npm run build`；`(cd intellij-plugin && npm ci && npm test) && ./gradlew :intellij-plugin:test :intellij-plugin:buildPlugin :intellij-plugin:verifyPluginProjectConfiguration`
Expected: 全绿；lint 恰好 1 个既有错误；docs:drift 无未核对项

- [ ] **Step 3: 提交**

```bash
git add docs/architecture/rendering.md AGENTS.md CHANGELOG chrome-plugin/src/shared/architecture-docs.test.ts
git commit -m "docs: Alt+T 开关循环的渲染文档与 AGENTS 约定(双端)"
```

---

## 验收口径（对齐 spec）

- 双端门禁全绿；Chrome E2E 三连按循环的 core fetch 计数全程不变（探针断言）
- 真机抽查（`.superpowers/acceptance/`，不入 CI）：Chrome 与 IDEA 各验一轮翻译→还原→重显，观察无「解析中」闪烁、追问面板只在锚定块被关时收走
