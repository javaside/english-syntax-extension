# 详解面板内子结构下钻 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 详解面板里的子结构标注可点击,以该子结构 token 区间为新 focus 原地下钻一层详解,面板顶部「← 返回上级」沿栈纯前端回退。

**Architecture:** 返回栈与当前面板快照存在 `SyntaxLearningBlock` 实例上(`#detailStack` / `#currentDetail`),下钻复用现有 `syntax-detail-request` → `requestDetail` → `ANALYZE_DETAIL` 链路;controller 只在事件带 `drillDown: true` 时跳过「当前块 closeDetails」,`setDetailLoading` 检测同句已有面板即原地转 loading(不动 DOM 位置)。不改 runtime 协议、提示词、缓存键、假服务器。

**Tech Stack:** TypeScript + Vitest(happy-dom)+ Playwright E2E(既有假 OpenAI 服务器)。

**Spec:** `docs/superpowers/specs/2026-11-16-detail-drill-down-design.md`

## Global Constraints

- lint 基线恰好 1 个错误(`options.test.ts` 的 `no-unnecessary-type-assertion`),不得新增任何错误。
- 提交信息用中文主题。
- 门禁命令(在 `chrome-plugin/` 跑):`npm test && npx playwright test && npm run lint && npm run format:check && npm run build`。
- 不改 `src/shared/protocol.ts`(runtime 消息)、`prompts.ts`、缓存键构造、`tests/support/fake-openai-server.ts`。
- `SyntaxFocusEventDetail` 是 content 内部 DOM 事件类型,加可选字段 `drillDown?: true` 不触及三层协议校验。
- 面板单例不变式:全页同时只开一个面板;下钻不清当前块面板,但其余块的面板照旧全关。

## Review Focus

1. **返回后晚到的下钻响应**:面板 dataset 已改回父 focus,`renderDetail`/`renderError`/`renderDetailStructures` 按 focus 寻址必须找不到面板而静默丢弃,不得重开。→ Task 1 步骤 1d
2. **会话暂停时点标注**:controller 拒绝请求不调 `setDetailLoading`,栈不得被 push(否则后续正常详解会凭空多出返回按钮)。→ Task 1 步骤 1e(push 时机钉在 `setDetailLoading` 原地分支内)
3. **流式标注误挂点击**:`renderDetailStructures` 的标注必须是纯 span,点击只属于完整渲染。→ Task 1 步骤 1c
4. **closeDetails 清栈**:点其他成分/开新面板后旧栈必须清空,返回按钮不得复活。→ Task 1 步骤 1b
5. **返回是纯前端**:不派发任何事件、不发任何请求。→ Task 1 步骤 1f + Task 3 E2E fetch 计数断言
6. **单 token 子结构也可点**:无最小词数特判。→ Task 1 步骤 1a 断言覆盖

---

### Task 1: learning-block 下钻渲染与返回栈

**Files:**
- Modify: `chrome-plugin/src/content/learning-block.ts`
- Test: `chrome-plugin/src/content/learning-block.test.ts`

**Interfaces:**
- Consumes: 现有 `renderDetail(analysis: DetailAnalysis)`、`setDetailLoading(sentenceId: string, focus: TokenRange)`、`closeDetails()`、`SyntaxFocusEventDetail`(扩展 `drillDown?: true`)。
- Produces: `SyntaxFocusEventDetail` 新可选字段 `drillDown?: true`(Task 2 controller 依赖);`setDetailLoading` 行为扩展(同句已有面板时原地转 loading、DOM 节点与位置不动、`#currentDetail` 压栈)。私有新增:`#detailStack: DetailAnalysis[]`、`#currentDetail: DetailAnalysis | null`、`#annotations(structures, tokens, sentenceId?: string)`、`#createDetailBack()`。

- [ ] **Step 1: 写失败测试(`learning-block.test.ts`,沿用文件顶部 `sentence/tokens/analysis/detailFor` 夹具,`detailFor` 需扩展为可传 structures)**

  1a. 标注可点与事件:
  ```ts
  it("完整渲染的详解标注是按钮,点击以子结构区间派发 drillDown 的 syntax-detail-request", () => {
    const element = block();
    element.setExpectedSentenceIds(["sentence-1"]);
    element.renderCore(sentence, tokens, analysis);
    element.setDetailLoading("sentence-1", { startToken: 2, endToken: 3 });
    // 父级 structures: [0..2 的名词短语核心, 3..3 的后置介词短语](区间须在 focus 2..3 界内)
    // ——用 token 2..2 与 3..3 两个 structure
    const parent = detailWithStructures("sentence-1", 2, 3, [
      { startToken: 2, endToken: 2, role: "名词核心", explanation: "短语中心词" },
      { startToken: 3, endToken: 3, role: "后置修饰", explanation: "介词短语" },
    ]);
    element.renderDetail(parent);

    const events: Array<SyntaxFocusEventDetail> = [];
    element.addEventListener("syntax-detail-request", (e) => events.push((e as CustomEvent).detail));

    const annotations = [...element.host.shadowRoot!.querySelectorAll<HTMLButtonElement>(".annotation")];
    expect(annotations).toHaveLength(2);
    expect(annotations.every((a) => a.tagName === "BUTTON")).toBe(true); // 单 token 也是按钮
    annotations[1]!.click();
    expect(events).toEqual([
      { sentenceId: "sentence-1", focus: { startToken: 3, endToken: 3 }, drillDown: true },
    ]);
  });
  ```
  1b. 原地 loading 与清栈:
  ```ts
  it("同句已有面板时 setDetailLoading 原地转 loading 不重建;closeDetails 清空返回栈", () => {
    // renderCore → setDetailLoading(2..3) → renderDetail(父) → 断言面板节点 P1
    // → setDetailLoading(3..3)(下钻):P1 仍是同一 DOM 节点(toBe),dataset 区间已更新,
    //    class 含 detail-loading、文本含「正在加载」
    // → renderDetail(子,structures 3..3) → 面板顶部有「返回上级」按钮
    // → 点返回:面板 dataset 回到 2..3,内容为父级(能查到父级独有文案),无新事件
    // → closeDetails() → 重新 setDetailLoading+renderDetail(另一 focus 的详解)
    //    → 无「返回上级」按钮(栈已清)
  });
  ```
  1c. 流式标注不可点:
  ```ts
  it("流式预览的标注是纯 span,不派发事件", () => {
    // renderCore → setDetailLoading → renderDetailStructures(...)
    // → querySelectorAll(".annotation") 全部 tagName === "SPAN",点击后无事件
  });
  ```
  1d. 晚到响应不重开:
  ```ts
  it("返回父级后,晚到的子级响应因 focus 不匹配被丢弃", () => {
    // 下钻到 3..3 → renderDetail(子) → 点返回(面板回到 2..3)
    // → renderDetail(子 analysis 3..3) → 面板内容仍是父级,不重开
  });
  ```
  1e. 栈不因被拒请求变脏:
  ```ts
  it("未经过 setDetailLoading 的下钻点击不污染返回栈", () => {
    // renderDetail(父) → 手动再 renderDetail(父)(模拟 controller 拒绝后 UI 未变)
    // → 无返回按钮;正常下钻一次后返回一次,再无返回按钮(栈深度 1)
  });
  ```
  1f. 错误态保留返回按钮、重试原地、返回零派发:
  ```ts
  it("下钻失败的错误面板保留返回上级,重试带 drillDown 原地,返回不派发任何事件", () => {
    // 下钻 loading → renderError(子 focus) → 面板含错误文案 + 「返回上级」+「重新解析」
    // 记录 listener(syntax-detail-request / syntax-reanalyze-request)
    // → 点「重新解析」→ syntax-reanalyze-request 的 detail 含 drillDown: true(controller
    //    的 handleCorrectionEvent → resolveRetryInteraction 会把 detail 原样转给 requestDetail)
    // → 再次 renderError(重试又失败)→ 栈深度不变(点返回一次即回到父级,无多余层级)
    // → 点返回 → 两种事件计数均为 0,面板恢复父级内容,无「返回上级」按钮
  });
  ```
  辅助:`detailWithStructures(sentenceId, start, end, structures)` 返回完整 `DetailAnalysis`(grammarPoints/explanation 沿用 `detailFor` 的值,父级独有文案放进 explanation 便于断言)。

- [ ] **Step 2: 跑测试确认失败**

  Run: `cd chrome-plugin && npx vitest run src/content/learning-block.test.ts`
  Expected: 新增用例 FAIL(标注是 span、无 drillDown、无返回按钮)。

- [ ] **Step 3: 实现 `learning-block.ts`**

  - `SyntaxFocusEventDetail` 加 `drillDown?: true`。
  - 字段:`#detailStack: DetailAnalysis[] = []`;`#currentDetail: DetailAnalysis | null = null`。
  - `#annotations(structures, tokens, sentenceId?: string)`:有 `sentenceId` 时标注渲染为 `button.annotation`(type="button"、appearance 复用 `.annotation` 样式新增的 button 重置、`aria-label`/`title` = `查看「${english}」的详细解析`),click 派发 `syntax-detail-request` 且 `detail: { sentenceId, focus: {startToken, endToken}, drillDown: true }`;无 `sentenceId`(流式)保持现状 span。
  - `renderDetail`:`#currentDetail = analysis`;调 `#annotations(..., tokens, analysis.sentenceId)`;栈非空时面板顶部 prepend 返回按钮。
  - `setDetailLoading` 开头:先查同句已开面板(`.detail[data-sentence-id="${sentenceId}"]`),命中则**原地升级**——`#currentDetail` 非 null 才 push 进栈(错误态重试时它是 null,层级不变、栈不增长)、置 `#currentDetail = null`、改写 dataset 区间为新 focus、class 置 `detail detail-loading`、`aria-busy="true"`、内容替换「正在加载详细解析…」、return;未命中走既有路径(开头 `closeDetails()` 不变,且它清栈)。
  - `closeDetails()`:移除面板之外清空 `#detailStack` 与 `#currentDetail`。
  - `#placeSentenceSection()` 重渲染句子的既有面板移除循环(detail.remove(),不经 closeDetails):移除了面板就同样清空 `#detailStack` 与 `#currentDetail`——面板生命周期结束,栈不得残留。
  - `renderError`:渲染错误与重试按钮后,栈非空时 prepend 返回按钮(与 renderDetail 同一个 `#createDetailBack()`);且栈非空时重试按钮派发的 `syntax-reanalyze-request` detail 带 `drillDown: true`(controller 的 `handleCorrectionEvent` → `resolveRetryInteraction` 会把事件 detail 原样转给 `requestDetail`,重试因此走下钻路径:面板原地、栈保留)。
  - `#createDetailBack()`:`button.detail-back`、type="button"、文本「← 返回上级」、aria-label 同文本;click 弹栈取父级,改写当前面板 dataset 为父 focus 后调 `renderDetail(parent)`;栈空时(防御)隐藏按钮。
  - CSS:`.annotation` 为 button 时重置(`appearance:none; border:0; background:transparent; font: inherit; color: inherit; cursor: pointer;`)、hover opacity 0.72、`:focus-visible` outline(并入既有 `.component:focus-visible` 选择器组);`.detail-back` 参考 `.retry` ghost 样式(边框、圆角、hover 背景当前色 12%),`margin-block-end: 0.5em`。

- [ ] **Step 4: 跑测试确认通过**

  Run: `cd chrome-plugin && npx vitest run src/content/learning-block.test.ts`
  Expected: 全部 PASS。

- [ ] **Step 5: Commit**

  ```bash
  git add chrome-plugin/src/content/learning-block.ts chrome-plugin/src/content/learning-block.test.ts
  git commit -m "详解面板标注可下钻:原地转 loading 与纯前端返回栈"
  ```

---

### Task 2: session-controller 下钻请求路径

**Files:**
- Modify: `chrome-plugin/src/content/session-controller.ts`(`requestDetail`,约 644-685 行)
- Test: `chrome-plugin/src/content/session-controller.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `SyntaxFocusEventDetail.drillDown?: true`;`ControllerBlock.closeDetails()` / `setDetailLoading(sentenceId, focus)`(签名均不变,`FakeLearningBlock` 无需改)。
- Produces: 无新接口;`requestDetail` 行为——`detail.drillDown === true` 时跳过当前块的面板关闭,其余块照旧;请求消息 `focus` 为事件携带区间。

- [ ] **Step 1: 写失败测试(沿用 `harness`/`FakeTransport`/`startAndEmit` 既有工具,参考 591 行 NO_CACHE 用例的构造方式)**

  ```ts
  it("drillDown 请求保留当前块面板、其余块面板照旧关闭,并携带子结构 focus", async () => {
    // 两块 harness(参照现有双块用例的构造),均 renderCore 就绪
    // transport 记录 ANALYZE_DETAIL 消息并返回合法 DETAIL_RESULT
    // await controller.requestDetail({ sentenceId: "sentence-1", focus: {0..1} })  // 打开父级
    // 记录 block0.closedDetails 基线
    // await controller.requestDetail({ sentenceId: "sentence-1", focus: {0..0}, drillDown: true })
    // 断言:block0.closedDetails 不再增加(面板保留);block1.closedDetails 增加(其余块照关)
    // 断言:发出的 ANALYZE_DETAIL 消息 focus === { startToken: 0, endToken: 0 }
    // 断言:block0.details 收到子级 DetailAnalysis(renderDetail 正常渲染)
  });

  it("非 drillDown 请求行为不变:当前块面板照旧关闭", async () => {
    // 同上构造,第二次 requestDetail 不带 drillDown
    // 断言:block0.closedDetails 增加(原有关闭行为保持)
  });
  ```

- [ ] **Step 2: 跑测试确认失败**

  Run: `cd chrome-plugin && npx vitest run src/content/session-controller.test.ts`
  Expected: 第一条 FAIL(drillDown 时当前块面板被关)。

- [ ] **Step 3: 实现**

  `requestDetail` 的关闭循环改为:
  ```ts
  for (const block of this.blocks.values()) {
    if (detail.drillDown === true && block === located.block) continue; // 下钻:面板原地升级
    block.learningBlock.closeDetails();
  }
  ```
  其余(含 `setDetailLoading` 与请求构造)不动。

- [ ] **Step 4: 跑测试确认通过**

  Run: `cd chrome-plugin && npx vitest run src/content/session-controller.test.ts`
  Expected: 全部 PASS。

- [ ] **Step 5: Commit**

  ```bash
  git add chrome-plugin/src/content/session-controller.ts chrome-plugin/src/content/session-controller.test.ts
  git commit -m "requestDetail 识别下钻:保留当前块面板,其余块照旧关闭"
  ```

---

### Task 3: E2E 下钻用例

**Files:**
- Modify: `chrome-plugin/tests/e2e/extension.spec.ts`(在 186 行「clicking a component…toggles it」用例之后新增)

**Interfaces:**
- Consumes: 既有 `harness.fakeModel.recordedOfKind("detail")`(假服务器 `respondDetail` 对任意 focus 返回区间=focus 的合法单 structure,无需改假服务器)、`page.locator(".detail")`、`seedLocalProfile`/`startSession` 工具。

- [ ] **Step 1: 写用例**

  ```ts
  test("drilling into a detail annotation loads a sub-detail in place and the back button restores the parent", async ({ harness }) => {
    // seedLocalProfile + startSession(单句文章,同 186 行用例的 fixture 选择)
    // 等 core 卡片出现 → 点第一个成分 → 等 .detail 含「详细语法解析」
    // const parentCount = harness.fakeModel.recordedOfKind("detail").length;  // = 1
    // 点 .detail 内第一个 .annotation(button)
    // 等 .detail 含「返回上级」(子级响应回来)
    // 断言 recordedOfKind("detail").length === parentCount + 1  // 真的调了模型(探针,不用墙钟)
    // 断言 .detail 内仍有标注与解析文案
    // 点「返回上级」→ 等 .detail 不含「返回上级」且含父级文案
    // 断言 recordedOfKind("detail").length 仍 === parentCount + 1  // 返回零请求
  });
  ```

- [ ] **Step 2: 跑该用例确认失败后实现无遗漏**

  实现已在 Task 1/2 完成;此用例失败即暴露集成缝隙,回到对应任务修复。

  Run: `cd chrome-plugin && npx playwright test extension.spec.ts -g "drilling"`
  Expected: PASS。

- [ ] **Step 3: Commit**

  ```bash
  git add chrome-plugin/tests/e2e/extension.spec.ts
  git commit -m "E2E:详解下钻发真请求、返回零请求"
  ```

---

### Task 4: 文档同步与全量门禁

**Files:**
- Modify: `docs/architecture/rendering.md`(「详解面板的锚定」一节,193 行附近)

- [ ] **Step 1: 更新 rendering.md**

  在「全页同时只开一个面板」段落后补:标注可下钻(子结构区间为新 focus、事件带 `drillDown`、controller 保留当前块面板)、`setDetailLoading` 同句原地升级、返回栈(`#detailStack`)纯前端回退、流式标注不可点、`closeDetails` 清栈。

- [ ] **Step 2: 跑 docs:drift 与门禁**

  Run: `cd chrome-plugin && npm run docs:drift && npm test && npx playwright test && npm run lint && npm run format:check && npm run build`
  Expected: 全绿;lint 恰好 1 个既有错误。

- [ ] **Step 3: Commit**

  ```bash
  git add docs/architecture/rendering.md
  git commit -m "架构文档:详解面板下钻与返回栈"
  ```
