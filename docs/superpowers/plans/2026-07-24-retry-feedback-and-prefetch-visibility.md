# 重试按钮交互反馈 + 预载开关状态可见 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 弹窗副标题显示「预载成分详解」开关状态；「重新解析」按钮获得 hover/按下/解析中/暂停提示四态反馈。

**Architecture:** 弹窗侧给 `PopupDependencies` 注入 `getPrefetchDetail`（复用 `ConfigRepository` 现有方法）拼进副标题。卡片侧把两处重试按钮的创建收敛为 `#createRetry` 私有方法（点击即禁用+「解析中…」），新增公开方法 `resetRetry(sentenceId, hint?)`；`session-controller` 三处 `state !== "running"` 静默 return 的分支（`retryCore`/`requestDetail`/`submitCorrection`）改为调用 `resetRetry(sentenceId, "会话已暂停")`。无协议改动（不新增 `ResponseMessage` 成员，无需三层校验同步）。

**Tech Stack:** TypeScript + Vitest（happy-dom、fake timers）。样式在 learning-block Shadow DOM 内联样式表。

**门禁（每个任务提交前跑通所属测试；最后任务跑全量）：**

```bash
npm test && npx playwright test && npm run lint && npm run format:check && npm run build
```

lint 基线是**恰好 1 个既有错误**（`src/options/options.test.ts` 的 `no-unnecessary-type-assertion`），不许新增。

**Spec:** `docs/superpowers/specs/2026-07-24-retry-feedback-and-prefetch-visibility-design.md`

---

### Task 1: 弹窗副标题显示预载开关状态

**Files:**

- Modify: `src/popup/popup.ts`（interface 第 12-19 行、`createPopupPage` 第 84-98 行、`runtimeDependencies` 第 182 行起）
- Test: `src/popup/popup.test.ts`

- [x] **Step 1: 写失败测试**

在 `src/popup/popup.test.ts` 的 `dependencies()` 工厂（第 33 行起）加入默认实现（否则接口收紧后全文件类型报错）：

```ts
function dependencies(overrides: Partial<PopupDependencies> = {}): PopupDependencies {
  return {
    listProfiles: vi.fn(() => Promise.resolve(profiles)),
    getActiveProfileId: vi.fn(() => Promise.resolve("profile-a")),
    getActiveTab: vi.fn(() => Promise.resolve({ id: 7, url: "https://example.com/article" })),
    getStatus: vi.fn(() => Promise.resolve(status({}))),
    sendCommand: vi.fn(() => Promise.resolve(status({}))),
    openOptions: vi.fn(),
    getPrefetchDetail: vi.fn(() => Promise.resolve(false)),
    ...overrides,
  };
}
```

在 `describe("Popup", ...)` 内新增三个用例：

```ts
it("开启预载时副标题追加「预载详解已开启」", async () => {
  await createPopupPage(root(), dependencies({ getPrefetchDetail: () => Promise.resolve(true) }));

  expect(subline().textContent).toBe("DeepSeek · deepseek-v4-flash · 预载详解已开启");
});

it("关闭预载时副标题只有模型信息", async () => {
  await createPopupPage(root(), dependencies());

  expect(subline().textContent).toBe("DeepSeek · deepseek-v4-flash");
});

it("运行中的「详解预载中 n/m」仍覆盖副标题", async () => {
  await createPopupPage(
    root(),
    dependencies({
      getPrefetchDetail: () => Promise.resolve(true),
      getStatus: () =>
        Promise.resolve(
          status({
            state: "running",
            discovered: 4,
            ready: 2,
            detailTotal: 6,
            detailReady: 1,
            detailFailed: 0,
          }),
        ),
    }),
  );

  expect(subline().textContent).toBe("详解预载中 1/6");
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/popup/popup.test.ts`
Expected: 类型错误或断言失败（`getPrefetchDetail` 不在 `PopupDependencies` 上 / 副标题无追加文案）。

- [x] **Step 3: 最小实现**

`src/popup/popup.ts` 三处改动。

接口（第 12-19 行）加一行：

```ts
export interface PopupDependencies {
  listProfiles: () => Promise<PublicModelProfile[]>;
  getActiveProfileId: () => Promise<string | undefined>;
  getActiveTab: () => Promise<{ id?: number; url?: string }>;
  getStatus: (context: PopupTabContext) => Promise<SessionStatus>;
  sendCommand: (type: PopupCommand, context: PopupTabContext) => Promise<SessionStatus | undefined>;
  openOptions: () => void;
  getPrefetchDetail: () => Promise<boolean>;
}
```

`createPopupPage` 中并行读取（第 84-88 行的 `Promise.all`）并拼接 `modelLine`（第 98 行）：

```ts
const [profiles, activeProfileId, activeTab, prefetchDetail] = await Promise.all([
  dependencies.listProfiles(),
  dependencies.getActiveProfileId(),
  dependencies.getActiveTab(),
  dependencies.getPrefetchDetail(),
]);
```

```ts
const prefetchSuffix = prefetchDetail ? " · 预载详解已开启" : "";
const modelLine =
  profile === undefined ? "" : `${profile.name} · ${profile.model}${prefetchSuffix}`;
```

`runtimeDependencies()` 返回对象（`openOptions` 之前）加一行：

```ts
getPrefetchDetail: () => repository.getPrefetchDetail(),
```

- [x] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/popup/popup.test.ts`
Expected: 全部 PASS（含既有用例——默认 `false` 不改变旧断言）。

- [x] **Step 5: 提交**

```bash
git add src/popup/popup.ts src/popup/popup.test.ts
git commit -m "feat: 弹窗副标题显示预载成分详解开关状态"
```

---

### Task 2: 重试按钮样式与点击加载态（learning-block）

**Files:**

- Modify: `src/content/learning-block.ts`（STYLES 的 `.retry` 块约第 164-171 行、reduced-motion 块约第 174 行、`renderError` 第 540 行、`renderFailure` 第 563 行）
- Test: `src/content/learning-block.test.ts`

- [x] **Step 1: 写失败测试**

在 `src/content/learning-block.test.ts` 新增（沿用文件内既有的 `block()` / `sentence` / `tokens` / `analysis` 夹具；详解错误路径参照第 264 行既有用例的 `renderCore → setDetailLoading → renderError` 流程）：

```ts
it("整句失败的重试按钮点击后禁用、显示解析中且只派发一次事件", () => {
  const element = block();
  element.setExpectedSentenceIds(["sentence-1"]);
  element.renderFailure("sentence-1", sentence, "网络请求失败");
  let dispatched = 0;
  element.addEventListener("syntax-reanalyze-request", () => {
    dispatched += 1;
  });
  const retry = element.host.shadowRoot!.querySelector<HTMLButtonElement>(".retry")!;

  retry.click();
  retry.click();

  expect(retry.disabled).toBe(true);
  expect(retry.textContent).toBe("解析中…");
  expect(dispatched).toBe(1);

  // 再次失败重渲染后，按钮复原为可点击的「重新解析」
  element.renderFailure("sentence-1", sentence, "网络请求失败");
  const rerendered = element.host.shadowRoot!.querySelector<HTMLButtonElement>(".retry")!;
  expect(rerendered.disabled).toBe(false);
  expect(rerendered.textContent).toBe("重新解析");
});

it("成分详解失败的重试按钮点击后同样进入解析中状态", () => {
  const element = block();
  document.body.append(element.host);
  element.renderCore(sentence, tokens, analysis);
  element.setDetailLoading("sentence-1", { startToken: 1, endToken: 1 });
  element.renderError("sentence-1", { startToken: 1, endToken: 1 }, "网络请求失败");
  const retry = element.host.shadowRoot!.querySelector<HTMLButtonElement>(".retry")!;

  retry.click();

  expect(retry.disabled).toBe(true);
  expect(retry.textContent).toBe("解析中…");
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/content/learning-block.test.ts`
Expected: FAIL——点击后 `disabled` 为 `false`、文案仍为「重新解析」。

- [x] **Step 3: 实现——抽取 `#createRetry` 并加样式**

`src/content/learning-block.ts` 中，在 `renderError` 上方新增私有方法（类内）：

```ts
#createRetry(sentenceId: string, focus: TokenRange): HTMLButtonElement {
  const retry = createElement("button", "retry", "重新解析");
  retry.type = "button";
  retry.addEventListener("click", () => {
    if (retry.disabled) return;
    retry.disabled = true;
    retry.textContent = "解析中…";
    this.dispatchEvent(
      new CustomEvent<SyntaxFocusEventDetail>("syntax-reanalyze-request", {
        bubbles: true,
        composed: true,
        detail: eventDetail(sentenceId, focus),
      }),
    );
  });
  return retry;
}
```

`renderError`（第 540-551 行）原地替换按钮创建：

```ts
detail.append(this.#createRetry(sentenceId, focus));
```

`renderFailure`（第 563-574 行）同样替换：

```ts
failure.append(this.#createRetry(sentenceId, { startToken: 0, endToken: 0 }));
```

（两处原有的 `createElement("button", ...)`、`retry.type`、`retry.addEventListener` 及 `append(retry)` 整段删除。）

STYLES 中 `.retry` 块（约第 164 行）替换为：

```css
.retry {
  margin-inline-start: 0.5em;
  border: 1px solid currentColor;
  border-radius: 0.25em;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  transition:
    background-color 120ms ease,
    transform 80ms ease;
}

.retry:hover:enabled {
  background: color-mix(in srgb, currentColor 12%, transparent);
}

.retry:active:enabled {
  transform: translateY(1px);
}

.retry:disabled {
  cursor: default;
  opacity: 0.6;
}
```

reduced-motion 块（约第 174 行）扩展为：

```css
@media (prefers-reduced-motion: reduce) {
  .component,
  .retry {
    transition: none;
  }
}
```

- [x] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/content/learning-block.test.ts`
Expected: 全部 PASS（含第 288 行点击既有用例——事件仍派发）。

- [x] **Step 5: 提交**

```bash
git add src/content/learning-block.ts src/content/learning-block.test.ts
git commit -m "feat: 重新解析按钮增加手型/悬停/按下样式与点击后解析中禁用态"
```

---

### Task 3: `resetRetry` 方法（learning-block）

**Files:**

- Modify: `src/content/learning-block.ts`（类字段区约第 285-290 行、公开方法区）
- Test: `src/content/learning-block.test.ts`

- [x] **Step 1: 写失败测试**

```ts
it("resetRetry 恢复按钮为可点击的重新解析", () => {
  const element = block();
  element.setExpectedSentenceIds(["sentence-1"]);
  element.renderFailure("sentence-1", sentence, "网络请求失败");
  const retry = element.host.shadowRoot!.querySelector<HTMLButtonElement>(".retry")!;
  retry.click();

  element.resetRetry("sentence-1");

  expect(retry.disabled).toBe(false);
  expect(retry.textContent).toBe("重新解析");
});

it("resetRetry 带提示时先显示提示，约 2 秒后恢复", () => {
  vi.useFakeTimers();
  try {
    const element = block();
    element.setExpectedSentenceIds(["sentence-1"]);
    element.renderFailure("sentence-1", sentence, "网络请求失败");
    const retry = element.host.shadowRoot!.querySelector<HTMLButtonElement>(".retry")!;
    retry.click();

    element.resetRetry("sentence-1", "会话已暂停");

    expect(retry.textContent).toBe("会话已暂停");
    expect(retry.disabled).toBe(true);

    vi.advanceTimersByTime(2000);

    expect(retry.textContent).toBe("重新解析");
    expect(retry.disabled).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

it("resetRetry 重复提示不叠加计时器，只影响目标句", () => {
  vi.useFakeTimers();
  try {
    const element = block();
    element.setExpectedSentenceIds(["sentence-1", "sentence-2"]);
    element.renderFailure("sentence-1", sentence, "网络请求失败");
    element.renderFailure("sentence-2", sentence, "网络请求失败");
    const buttons = element.host.shadowRoot!.querySelectorAll<HTMLButtonElement>(".retry");
    const first = buttons[0]!;
    const second = buttons[1]!;

    element.resetRetry("sentence-1", "会话已暂停");
    vi.advanceTimersByTime(1000);
    element.resetRetry("sentence-1", "会话已暂停");
    vi.advanceTimersByTime(1000);

    expect(first.textContent).toBe("会话已暂停"); // 第二次提示重置了计时
    expect(second.textContent).toBe("重新解析"); // 未点名的句子不受影响

    vi.advanceTimersByTime(1000);
    expect(first.textContent).toBe("重新解析");
  } finally {
    vi.useRealTimers();
  }
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/content/learning-block.test.ts`
Expected: FAIL——`element.resetRetry is not a function`。

- [x] **Step 3: 实现 `resetRetry`**

`src/content/learning-block.ts`：模块顶部（`STYLES` 定义之前）加常量：

```ts
const RETRY_HINT_DURATION_MS = 2000;
```

类字段区（`#tokensBySentence` 之后）加：

```ts
#retryResetTimers = new Map<HTMLButtonElement, ReturnType<typeof setTimeout>>();
```

公开方法（放在 `renderFailure` 之后）：

```ts
/** 恢复该句所有「重新解析」按钮；带 hint 时先短暂显示提示再恢复（如暂停时点击）。 */
resetRetry(sentenceId: string, hint?: string): void {
  for (const retry of this.#sentences.querySelectorAll<HTMLButtonElement>(".retry")) {
    if (retry.closest<HTMLElement>("[data-sentence-id]")?.dataset.sentenceId !== sentenceId) {
      continue;
    }
    const timer = this.#retryResetTimers.get(retry);
    if (timer !== undefined) clearTimeout(timer);
    this.#retryResetTimers.delete(retry);
    if (hint === undefined) {
      retry.disabled = false;
      retry.textContent = "重新解析";
      continue;
    }
    retry.disabled = true;
    retry.textContent = hint;
    this.#retryResetTimers.set(
      retry,
      setTimeout(() => {
        this.#retryResetTimers.delete(retry);
        retry.disabled = false;
        retry.textContent = "重新解析";
      }, RETRY_HINT_DURATION_MS),
    );
  }
}
```

依赖的 DOM 事实（已存在，无需改）：`renderFailure` 的 `section.dataset.sentenceId` 与句子元素的 `dataset.sentenceId` 都在 `#sentences` 内，`closest` 能命中。

- [x] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/content/learning-block.test.ts`
Expected: 全部 PASS。

- [x] **Step 5: 提交**

```bash
git add src/content/learning-block.ts src/content/learning-block.test.ts
git commit -m "feat: 学习卡片支持 resetRetry 恢复重试按钮并短暂显示暂停提示"
```

---

### Task 4: 暂停时点击重试给出提示（session-controller）

**Files:**

- Modify: `src/content/session-controller.ts`（`ControllerBlock` 接口第 32-42 行、`requestDetail` 约第 324 行、`submitCorrection` 第 380 行、`retryCore` 第 680 行）
- Test: `src/content/session-controller.test.ts`（`FakeLearningBlock` 第 21 行起）

- [x] **Step 1: 写失败测试**

`FakeLearningBlock`（第 21 行起）加记录字段与方法：

```ts
retryResets: Array<{ sentenceId: string; hint?: string }> = [];

resetRetry(sentenceId: string, hint?: string): void {
  this.retryResets.push({ sentenceId, hint });
}
```

新增两个用例（放在第 870 行「retries a failed sentence as core analysis without requiring prior core」用例之后；沿用其 `harness`/`FakeTransport` 写法）：

```ts
it("暂停时点整句重试：按钮恢复并提示会话已暂停，不发请求", async () => {
  const subject = harness(
    undefined,
    new FakeTransport((message) =>
      Promise.resolve({
        version: 1,
        requestId: message.requestId,
        type: "CORE_RESULT",
        analyses: [],
      }),
    ),
  );
  await subject.controller.start();
  subject.viewport.emit();
  await vi.waitFor(() => expect(subject.controller.status.failed).toBe(1));
  subject.controller.pause();

  document.dispatchEvent(
    new CustomEvent("syntax-reanalyze-request", {
      detail: { sentenceId: "sentence-1", focus: { startToken: 0, endToken: 0 } },
    }),
  );

  await vi.waitFor(() =>
    expect(subject.learningBlocks[0]!.retryResets).toEqual([
      { sentenceId: "sentence-1", hint: "会话已暂停" },
    ]),
  );
  expect(subject.transport.sent).toHaveLength(1); // 仅最初的 ANALYZE_CORE
});

it("暂停时点详解重试：同样恢复按钮并提示", async () => {
  const subject = harness();
  await startAndEmit(subject);
  subject.controller.pause();

  document.dispatchEvent(
    new CustomEvent("syntax-reanalyze-request", {
      detail: { sentenceId: "sentence-1", focus: { startToken: 0, endToken: 1 } },
    }),
  );

  await vi.waitFor(() =>
    expect(subject.learningBlocks[0]!.retryResets).toEqual([
      { sentenceId: "sentence-1", hint: "会话已暂停" },
    ]),
  );
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/content/session-controller.test.ts`
Expected: 新用例 FAIL——`retryResets` 为空（现有代码静默 return）。

- [x] **Step 3: 实现——接口与三处守卫**

`ControllerBlock` 接口（第 32-42 行）在 `renderError` 之后加：

```ts
resetRetry(sentenceId: string, hint?: string): void;
```

（`SyntaxLearningBlock` 已在 Task 3 实现该方法，类型自然满足。）

`retryCore`（第 680-682 行）守卫拆开：

```ts
const located = this.locateSentence(sentenceId);
if (located === undefined) return;
if (this.state !== "running") {
  located.block.learningBlock.resetRetry(sentenceId, "会话已暂停");
  return;
}
```

`requestDetail`（约第 324-328 行）守卫拆开：

```ts
const located = this.locateSentence(detail.sentenceId);
if (located === undefined || located.sentence.core === undefined) {
  return;
}
if (this.state !== "running") {
  located.block.learningBlock.resetRetry(detail.sentenceId, "会话已暂停");
  return;
}
```

`submitCorrection`（第 380-389 行）守卫拆开：

```ts
const located = this.locateSentence(sentenceId);
if (located === undefined || located.sentence.core === undefined || feedback.trim().length === 0) {
  return;
}
if (this.state !== "running") {
  located.block.learningBlock.resetRetry(sentenceId, "会话已暂停");
  return;
}
```

说明：普通成分点击（非重试）在暂停时也会走 `requestDetail` 的该分支，此时句内没有 `.retry` 按钮，`resetRetry` 是无害空操作，无需区分来源。

- [x] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/content/session-controller.test.ts`
Expected: 全部 PASS（既有用例不受影响——运行态路径未变）。

- [x] **Step 5: 提交**

```bash
git add src/content/session-controller.ts src/content/session-controller.test.ts
git commit -m "fix: 会话暂停时点击重新解析给出提示而非静默忽略"
```

---

### Task 5: 全量门禁与收尾

**Files:** 无新改动（只跑验证；若 E2E 因文案断言失败才回改对应断言）

- [x] **Step 1: 全量单测**

Run: `npm test`
Expected: 全部 PASS。

- [x] **Step 2: E2E**

Run: `npx playwright test`
Expected: 全部 PASS。已核对现有 E2E 只用 `button.retry` 类选择器（`tests/e2e/extension.spec.ts:414,420`）、不断言按钮文案；点击后按钮短暂禁用由 Playwright 自动等待覆盖。若有失败，先读失败断言再最小修正测试（不得为过测试改产品语义）。

- [x] **Step 3: lint 基线 + 格式 + 构建**

Run: `npm run lint; npm run format:check && npm run build`
Expected: lint 恰好 1 个既有错误（`src/options/options.test.ts`），格式与构建通过。格式不过就 `npx prettier --write <文件>` 后重查。

- [x] **Step 4: 勾掉计划复选框并提交计划文档**

```bash
git add docs/superpowers/plans/2026-07-24-retry-feedback-and-prefetch-visibility.md
git commit -m "docs: 勾选重试反馈与预载可见性计划完成项"
```

- [ ] **Step 5: 真机验收提醒（人工）**

按 AGENTS.md 约定：真机装载 `dist/`，验证 ① 弹窗副标题在开关两态下的显示；② 失败句 hover 手型与高亮、点击变「解析中…」、失败后按钮复原；③ 暂停会话后点重试出现「会话已暂停」并在约 2 秒后恢复。涉及真实 key 的脚本放 `.superpowers/acceptance/`（永不提交）。
