# IntelliJ 详解面板内子结构下钻 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** IntelliJ 预览页详解面板的子结构标注可点击下钻(新 focus 复用 DETAIL_REQUEST),「← 返回上级」纯前端弹栈回退——对等移植 Chrome 已上线功能。

**Architecture:** Kotlin 与桥零改动;全部改动在 `render.ts`(标注 button 化、下钻走既有 `#showDetailLoading`+`requestDetail`、`#detailStack` 返回栈)+ `preview.css`。另加一个 `#showDetailPanel` 的 focus 匹配守卫(下钻使晚到响应竞态高频化,3 行同时治好「关闭后重开/返回后跳回/切换被覆盖」三个既有场景)。

**Tech Stack:** TypeScript + Vitest(happy-dom,web 侧自有 package.json);Kotlin/Gradle 全量跑确认零影响。

**Spec:** `docs/superpowers/specs/2026-11-16-intellij-detail-drill-down-design.md`(差异点裁决见其表格)

## Global Constraints

- 双端门禁(仓库根):`(cd intellij-plugin && npm ci && npm test) && ./gradlew :intellij-plugin:test :intellij-plugin:buildPlugin :intellij-plugin:verifyPluginProjectConfiguration`
- 不改桥协议、不改 Kotlin 源码、不动双端 contracts(提示词首行/缓存键)。
- 提交信息用中文主题。
- render.ts 的平台约束:官方 Markdown 预览页全局 cursor 规则压制 stylesheet——按钮的 `cursor:pointer` 必须 JS 内联 `!important`(component 按钮同款模式)。

## Review Focus

1. **晚到 DETAIL_RESULT**:返回父级/关闭面板/切换成分后到达的旧响应必须被 focus 匹配守卫丢弃,不得重画。→ Task 2
2. **流式标注误挂点击**:`renderDetailStream` 路径标注是纯 span。→ Task 1 步骤 1c
3. **清栈点**:`closeDetail()`(句级 toggle/换代)与 `renderCoreError`(失败行)之后栈必须空,重开详解无返回按钮。→ Task 1 步骤 1b
4. **返回纯前端**:点击「← 返回上级」不产生新的 detailRequests、不发桥消息。→ Task 1 步骤 1a 断言
5. **单 token 子结构可下钻**(无最小词数特判)。→ Task 1 步骤 1a
6. **cursor 不说谎**:span 标注(流式)不得带 pointer;button 标注带内联 pointer。→ Task 1 步骤 1c

---

### Task 1: render.ts 标注可点、下钻与返回栈

**Files:**
- Modify: `intellij-plugin/src/main/resources/web/render.ts`、`intellij-plugin/src/main/resources/web/preview.css`
- Test: `intellij-plugin/src/main/resources/web/render.test.ts`

**Interfaces:**
- Consumes: 既有 `#showDetailLoading(sentenceId, focusStart, focusEnd)`、`requestDetail(sentenceId, focusStart, focusEnd)`、`#showDetailPanel`、`closeDetail()`、`renderCoreError`、`#renderDetailPanel(owner, structures, detail?)`。
- Produces: `#detailStack: DetailPayload[]`、`#currentDetailPayload: DetailPayload | null`;`#renderDetailPanel` 新可选参数 `options?: { interactive?: boolean }`;标注按钮类名 `english-syntax-annotation`(button 时同类名);返回按钮类名 `english-syntax-detail-back`。

- [ ] **Step 1: 写失败测试(沿用 `setup()` 工具与 `detailRequests` 收集器;helper `detailPayload(sentenceId, start, end, structures, explanation)` 仿 `corePayload` 风格)**

  1a. 标注可点与下钻:
  ```ts
  it("完整渲染的详解标注是按钮,点击以子结构区间再次请求详解", () => {
    // setup → renderCoreResult(两个成分 0..1/2..3) → 点第一个成分(renderer 内部触发,直接调
    //   #showDetailLoading 不可行——用公开路径:模拟点击 .english-syntax-component 按钮)
    // → renderDetailResult(父级:structures [0..0 名词核心, 1..1 后置修饰], focus 0..1)
    // → 断言 .english-syntax-annotation 两个、均为 BUTTON、单 token 也是按钮
    // → 点第二个标注 → detailRequests 收到 ["s1", 1, 1](下钻复用 requestDetail 入口)
    // → 面板回到 loading(.english-syntax-detail-loading 存在)
  });
  ```
  1b. 返回栈与清栈:
  ```ts
  it("下钻后返回上级纯前端恢复父级;句级关闭与失败行都清空返回栈", () => {
    // 父级(0..1,explanation "父级详解")→ 下钻 loading(1..1)→ renderDetailResult(子级 1..1)
    // → 面板顶部有 .english-syntax-detail-back,文本「← 返回上级」
    // → 记录 detailRequests.length → 点返回 → 面板内容回父级文案、返回按钮消失、
    //    detailRequests.length 不变(纯前端)
    // → 再下钻一次 → 点同句任一成分按钮(句级 toggle)→ 面板关闭 →
    //    重新点成分开新详解 → 无返回按钮(栈已清)
    // → 又下钻一次 → renderer.renderCoreError(...)→ 重画后重开详解无返回按钮
  });
  ```
  1c. 流式 span 不可点 + cursor:
  ```ts
  it("流式预览的标注是纯 span 且无 pointer 光标;完整渲染的按钮带内联 pointer", () => {
    // renderDetailStream("s1", 0, 1, [structures]) → 标注 tagName === "SPAN"
    //   且 style.cursor 不含 pointer
    // renderDetailResult(...) → 标注 BUTTON 且 style.cursor 含 pointer(内联 !important 模式)
  });
  ```

- [ ] **Step 2: 跑测试确认失败**

  Run: `cd intellij-plugin && npx vitest run src/main/resources/web/render.test.ts`
  Expected: 新增用例 FAIL(标注是 span、无返回按钮、无下钻请求)。

- [ ] **Step 3: 实现 render.ts + preview.css**

  - `#detailStack: DetailPayload[] = []`;`#currentDetailPayload: DetailPayload | null = null`。
  - `renderDetailResult`:`#currentDetailPayload = detail`(在 `#showDetailPanel` 之后或之内)。
  - `#showDetailLoading`:若 `#currentDetailPayload !== null` 则压入 `#detailStack` 并置 null(错误/暂停拒答路径不经此,栈不脏——与 Chrome 同款 push 时机)。
  - `#renderDetailPanel(owner, structures, detail?, options?)`:`interactive` 时标注渲染为 `button`(type="button"、aria-label/title `查看「english」的详细解析`、JS 内联 cursor:pointer !important 含子元素——component 按钮同款循环);click 调 `this.#showDetailLoading(sentenceId, structure.startToken, structure.endToken)` + `this.requestDetail(同区间)`。sentenceId 从 `#currentDetail` 取(标注属于当前面板所属句)。
  - `#placeDetailPanel` 调用处(`#renderCard`):`detail !== undefined`(完整渲染)时传 `interactive: true`;`detailStructures` 无 detail(流式)不传。面板顶部:栈非空时 prepend「← 返回上级」`button.english-syntax-detail-back`(type="button");click 弹栈取父级 → `#showDetailPanel(父级.sentenceId, 父级.structures, 父级.focus.startToken, 父级.focus.endToken, 父级)` + `#currentDetailPayload = 父级`。
  - `closeDetail()` 与 `renderCoreError`:`#detailStack = []`、`#currentDetailPayload = null`。
  - `preview.css`:`.english-syntax-annotation` 的 button 重置属性(appearance/padding/border/background/font/color)只进 `button.english-syntax-annotation` 选择器(span 不得带 pointer/hover——Chrome 侧评审教训);`.english-syntax-detail-back` ghost 样式(与 retry 同族:边框、圆角、hover 当前色 12%)+ `:focus-visible`。

- [ ] **Step 4: 跑测试确认通过**

  Run: `cd intellij-plugin && npx vitest run src/main/resources/web/render.test.ts`
  Expected: 全部 PASS。

- [ ] **Step 5: Commit**

  ```bash
  git add intellij-plugin/src/main/resources/web/render.ts intellij-plugin/src/main/resources/web/preview.css intellij-plugin/src/main/resources/web/render.test.ts
  git commit -m "IntelliJ 预览页详解标注可下钻:返回栈与纯前端回退"
  ```

---

### Task 2: #showDetailPanel 的 focus 匹配守卫

**Files:**
- Modify: `intellij-plugin/src/main/resources/web/render.ts`(`#showDetailPanel`)
- Test: `intellij-plugin/src/main/resources/web/render.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `#currentDetail` 语义(loading/流式/返回后它分别是等待中/展示中/父级区间)。
- Produces: `#showDetailPanel` 开头守卫——`#currentDetail === null` 或其 `{sentenceId, focusStart, focusEnd}` 与消息不匹配时直接 return(不重画、不覆盖)。

- [ ] **Step 1: 写失败测试**

  ```ts
  it("晚到的详解响应不得重开已关闭的面板、不得覆盖返回后的父级、不得顶掉切换中的新焦点", () => {
    // 关闭后:点成分(loading 0..1)→ closeDetail()(点同句成分 toggle)→
    //   renderDetailResult(0..1 的响应)→ 无 .english-syntax-detail
    // 返回后:下钻(1..1)→ renderDetailResult(子级)→ 返回(面板回父级 0..1)→
    //   再 renderDetailResult(子级 1..1 晚到)→ 面板仍是父级文案
    // 切换中:点成分 A(loading 0..1)→ 立刻点成分 B(loading 2..3)→
    //   renderDetailResult(A 0..1)→ 面板仍 loading(B 在等),不被 A 顶掉
  });
  ```

- [ ] **Step 2: 跑测试确认失败**(现状:三个场景都会被晚到响应重画)

- [ ] **Step 3: 实现**:`#showDetailPanel` 开头比对 `#currentDetail` 与入参 sentenceId/focusStart/focusEnd,不等则 return。注意 `renderDetailStream` 与 `renderDetailResult` 都经此守卫。

- [ ] **Step 4: 全量 web 测试确认通过**

- [ ] **Step 5: Commit** `git commit -m "详解面板按 focus 匹配守卫:晚到响应不再重开或覆盖"`

---

### Task 3: 双端门禁与文档

**Files:**
- Modify: `docs/architecture/rendering.md`(下钻小节补 IntelliJ 对等说明与两处刻意差异)

- [ ] **Step 1: 双端门禁**

  Run(仓库根):
  ```bash
  (cd intellij-plugin && npm ci && npm test) \
    && ./gradlew :intellij-plugin:test :intellij-plugin:buildPlugin :intellij-plugin:verifyPluginProjectConfiguration
  ```
  Expected: 全绿(Kotlin 零改动,纯回归确认)。

- [ ] **Step 2: 更新 rendering.md**:「面板内下钻」小节补 IntelliJ 段——桥 `DETAIL_REQUEST` 任意区间零改动、整卡重画模式下的下钻、失败走既有 `CORE_ERROR` 失败行(栈随面板消失)、focus 匹配守卫。

- [ ] **Step 3: Commit** `git commit -m "架构文档:IntelliJ 预览页下钻对等实现"`
