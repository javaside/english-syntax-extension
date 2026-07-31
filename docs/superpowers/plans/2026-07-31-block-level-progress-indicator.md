# 段落级解析进度指示 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 正在解析的段落显示一根左侧竖条 + 极淡底色，进行中出现、离开 `requesting` 相位即撤。

**Architecture:** 新增 `BlockActivityMarker`，复用 `BlockReplacement` 的「注入 `<style>` + 防冲突随机类名 + 精确还原」套路。`SessionController` 在 `transition()` 这一个收口点刷新块级状态，挂载点取 `replacement.currentElement()`，流式换卡片后标记自动迁移。

**Tech Stack:** TypeScript + Vite，Vitest（happy-dom）单测，Playwright E2E（假 OpenAI 服务器）。

**设计依据:** `docs/superpowers/specs/2026-07-31-block-level-progress-indicator-design.md`

**门禁（每次提交前）:** `npm test && npx playwright test && npm run lint && npm run format:check && npm run build`
lint 基线是**恰好 1 个错误**（`src/options/options.test.ts` 的 `no-unnecessary-type-assertion`），不要修它，也不要新增。

---

## 文件结构

| 文件                                        | 职责                                                               |
| ------------------------------------------- | ------------------------------------------------------------------ |
| `src/content/block-activity-marker.ts`      | 新建。把「解析中」标记打到某元素上并精确撤掉。不含任何会话逻辑     |
| `src/content/block-activity-marker.test.ts` | 新建。组件单测                                                     |
| `src/content/session-controller.ts`         | 修改。`ControllerMarker` 接口、`blockId`/`marker` 字段、刷新与清理 |
| `src/content/session-controller.test.ts`    | 修改。harness 加 `markers`，新增接线用例                           |
| `tests/e2e/extension.spec.ts`               | 修改。真实浏览器验收                                               |

---

## Task 1: BlockActivityMarker 组件

**Files:**

- Create: `src/content/block-activity-marker.ts`
- Test: `src/content/block-activity-marker.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `src/content/block-activity-marker.test.ts`：

```ts
// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";
import { BlockActivityMarker } from "./block-activity-marker";

function paragraph(attributes: Record<string, string> = {}): HTMLElement {
  const element = document.createElement("p");
  element.textContent = "Readers understand complex sentences.";
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  document.body.append(element);
  return element;
}

describe("BlockActivityMarker", () => {
  beforeEach(() => {
    document.head.replaceChildren();
    document.body.replaceChildren();
  });

  it("marks an element and restores it exactly on clear", () => {
    const element = paragraph({ class: "article-copy", style: "color: purple" });
    const marker = new BlockActivityMarker();

    marker.mark(element);
    expect(element.className).not.toBe("article-copy");
    expect(element.className).toContain("article-copy");
    expect(document.head.querySelector("style")).not.toBeNull();

    marker.clear();
    expect(element.className).toBe("article-copy");
    expect(element.getAttribute("style")).toBe("color: purple");
    expect(document.head.querySelector("style")).toBeNull();
  });

  it("leaves no empty class attribute when the element never had one", () => {
    const element = paragraph();
    const marker = new BlockActivityMarker();

    marker.mark(element);
    marker.clear();

    expect(element.hasAttribute("class")).toBe(false);
  });

  it("is idempotent for the same target", () => {
    const element = paragraph();
    const marker = new BlockActivityMarker();

    marker.mark(element);
    const applied = element.className;
    marker.mark(element);

    expect(element.className).toBe(applied);
    expect(document.head.querySelectorAll("style")).toHaveLength(1);
  });

  it("releases the previous target when the marker moves", () => {
    const first = paragraph();
    const second = paragraph();
    const marker = new BlockActivityMarker();

    marker.mark(first);
    marker.mark(second);

    expect(first.hasAttribute("class")).toBe(false);
    expect(second.className).not.toBe("");
    expect(document.head.querySelectorAll("style")).toHaveLength(1);
  });

  it("picks a fresh suffix when the page already uses the candidate class", () => {
    const squatter = document.createElement("div");
    squatter.className = `${BlockActivityMarker.activeClass}-1`;
    document.body.append(squatter);
    const element = paragraph();
    let attempts = 0;
    const marker = new BlockActivityMarker(() => {
      attempts += 1;
      return String(attempts);
    });

    marker.mark(element);

    expect(element.className).toBe(`${BlockActivityMarker.activeClass}-2`);
  });

  it("ignores a detached element", () => {
    const detached = document.createElement("p");
    const marker = new BlockActivityMarker();

    marker.mark(detached);

    expect(detached.hasAttribute("class")).toBe(false);
    expect(document.head.querySelector("style")).toBeNull();
  });

  it("clear is safe when nothing was marked", () => {
    expect(() => new BlockActivityMarker().clear()).not.toThrow();
  });

  it("clear survives the target being ripped out by the page", () => {
    const element = paragraph();
    const marker = new BlockActivityMarker();
    marker.mark(element);

    element.remove();

    expect(() => marker.clear()).not.toThrow();
    expect(document.head.querySelector("style")).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/content/block-activity-marker.test.ts`
Expected: FAIL，报错为无法解析模块 `./block-activity-marker`。

- [ ] **Step 3: 写实现**

创建 `src/content/block-activity-marker.ts`：

```ts
const STYLE_ATTRIBUTE = "data-syntax-learning-active";
const SAFE_SUFFIX = /^[A-Za-z0-9_-]+$/u;
const reservedActiveClasses = new Set<string>();
let nextActiveClassId = 0;

export type ActiveClassSuffixFactory = (attempt: number) => string;

function defaultActiveClassSuffix(): string {
  nextActiveClassId += 1;
  return String(nextActiveClassId);
}

/**
 * 竖条用 inset box-shadow 而不是 border-left:前者不参与布局计算,文字不会位移,
 * 现有折行与紧凑布局 E2E 才不会被这个纯装饰性标记推翻。改动时不要退回边框实现。
 */
function createActiveStyle(document: Document, activeClass: string): HTMLStyleElement {
  const style = document.createElement("style");
  style.setAttribute(STYLE_ATTRIBUTE, activeClass);
  style.textContent = `
.${activeClass} {
  box-shadow: inset 3px 0 0 rgba(10, 132, 255, 0.9) !important;
  background-color: rgba(10, 132, 255, 0.06) !important;
  animation: ${activeClass}-pulse 1.6s ease-in-out infinite;
}
@keyframes ${activeClass}-pulse {
  50% { box-shadow: inset 3px 0 0 rgba(10, 132, 255, 0.35) !important; }
}
@media (prefers-reduced-motion: reduce) {
  .${activeClass} { animation: none; }
}`;
  return style;
}

/**
 * 给「正在解析」的段落加视觉标记。只做打标与撤标,不认识会话与相位。
 */
export class BlockActivityMarker {
  static readonly activeClass = "syntax-learning-block-active";

  #target: HTMLElement | null = null;
  #appliedClass: string | null = null;
  #targetHadClassAttribute = false;
  #ownedStyle: HTMLStyleElement | null = null;
  readonly #suffixFactory: ActiveClassSuffixFactory;

  constructor(suffixFactory: ActiveClassSuffixFactory = defaultActiveClassSuffix) {
    this.#suffixFactory = suffixFactory;
  }

  get target(): HTMLElement | null {
    return this.#target;
  }

  mark(element: HTMLElement): void {
    if (this.#target === element) return;
    this.clear();
    if (!element.isConnected) return;
    const activeClass = this.#reserveActiveClass(element);
    const style = createActiveStyle(element.ownerDocument, activeClass);
    element.ownerDocument.head.append(style);
    this.#targetHadClassAttribute = element.hasAttribute("class");
    element.classList.add(activeClass);
    this.#target = element;
    this.#appliedClass = activeClass;
    this.#ownedStyle = style;
  }

  clear(): void {
    if (this.#appliedClass !== null) {
      this.#target?.classList.remove(this.#appliedClass);
      reservedActiveClasses.delete(this.#appliedClass);
      // classList.remove 会留下空的 class="";元素本来没有就得删干净。
      if (!this.#targetHadClassAttribute && this.#target?.getAttribute("class") === "") {
        this.#target.removeAttribute("class");
      }
    }
    this.#ownedStyle?.remove();
    this.#target = null;
    this.#appliedClass = null;
    this.#ownedStyle = null;
  }

  #reserveActiveClass(element: HTMLElement): string {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const suffix = this.#suffixFactory(attempt);
      if (!SAFE_SUFFIX.test(suffix)) {
        throw new Error(
          "Active-class suffix must contain only letters, numbers, underscores, or hyphens",
        );
      }
      const candidate = `${BlockActivityMarker.activeClass}-${suffix}`;
      if (
        !reservedActiveClasses.has(candidate) &&
        element.ownerDocument.getElementsByClassName(candidate).length === 0
      ) {
        reservedActiveClasses.add(candidate);
        return candidate;
      }
    }
    throw new Error("Unable to allocate a collision-free syntax-learning active class");
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/content/block-activity-marker.test.ts`
Expected: PASS，7 个用例全绿。

- [ ] **Step 5: 提交**

```bash
npx prettier --write src/content/block-activity-marker.ts src/content/block-activity-marker.test.ts
git add src/content/block-activity-marker.ts src/content/block-activity-marker.test.ts
git commit -m "feat: 新增段落解析中标记组件"
```

---

## Task 2: 接线到 SessionController

**Files:**

- Modify: `src/content/session-controller.ts`
- Test: `src/content/session-controller.test.ts`

- [ ] **Step 1: 写失败测试**

在 `src/content/session-controller.test.ts` 的 `Harness` 接口加一行 `markers: FakeMarker[];`，在 `harness()` 里注册 marker 工厂，并在 `FakeReplacement` 定义附近加 `FakeMarker`。

在 `FakeReplacement` 类定义之后插入：

```ts
class FakeMarker implements ControllerMarker {
  marked: HTMLElement | null = null;
  readonly history: (HTMLElement | null)[] = [];

  mark(element: HTMLElement): void {
    this.marked = element;
    this.history.push(element);
  }

  clear(): void {
    this.marked = null;
    this.history.push(null);
  }
}
```

并把 `ControllerMarker` 加进本文件顶部从 `./session-controller` 导入的类型列表。

在 `Harness` 接口内加：

```ts
  markers: FakeMarker[];
```

在 `harness()` 里，`const replacements: FakeReplacement[] = [];` 之后加：

```ts
const markers: FakeMarker[] = [];
```

在 options 的 `replacementFactory` 之后加：

```ts
    markerFactory: () => {
      const marker = new FakeMarker();
      markers.push(marker);
      return marker;
    },
```

并把 return 改成：

```ts
return { controller, transport, viewport, learningBlocks, replacements, transitions, markers };
```

然后在文件末尾追加用例：

```ts
describe("段落解析中标记", () => {
  it("解析期间打过标,ready 之后撤掉", async () => {
    const subject = harness();

    await startAndEmit(subject);

    // 期间至少打过一次标,收尾时必须是撤掉的状态。
    expect(subject.markers[0]?.history.some((entry) => entry !== null)).toBe(true);
    expect(subject.markers[0]?.marked).toBeNull();
  });

  it("请求还在飞的时候标记是亮的", async () => {
    const pending = new FakeTransport(() => new Promise<ResponseMessage>(() => {}));
    const subject = harness("Readers understand complex sentences.", pending);

    await subject.controller.start();
    subject.viewport.emit();
    await vi.waitFor(() => expect(subject.markers[0]?.marked).not.toBeNull());

    expect(subject.markers[0]?.marked).not.toBeNull();
  });
});
```

`startAndEmit` 是本文件已有的 helper（`controller.start()` → `viewport.emit()` → 等 `status.ready` 到 1）。`FakeTransport` 的构造函数接受一个 handler，传入永不 resolve 的 promise 就能把句子按在 `requesting` 相位上。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/content/session-controller.test.ts -t "段落解析中标记"`
Expected: FAIL — `markerFactory` 不是合法选项（TS 报错）或 `h.markers` 为空数组。

- [ ] **Step 3: 写实现**

在 `src/content/session-controller.ts`：

(a) 导入组件，加在 `import { BlockReplacement } ...` 之后：

```ts
import { BlockActivityMarker } from "./block-activity-marker";
```

(b) 在 `ControllerReplacement` 接口之后新增接口：

```ts
export interface ControllerMarker {
  mark(element: HTMLElement): void;
  clear(): void;
}
```

(c) `SentenceRecord` 加字段：

```ts
interface SentenceRecord {
  input: SentenceInput;
  phase: SentencePhase;
  core?: CoreAnalysis;
  blockId: string;
}
```

(d) `BlockRecord` 加字段：

```ts
marker: ControllerMarker;
```

(e) `SessionControllerOptions` 在 `replacementFactory` 之后加：

```ts
  markerFactory?: () => ControllerMarker;
```

(f) 在 `registerCandidates` 里，创建 `SentenceRecord` 的字面量补上 `blockId`：

```ts
const sentence: SentenceRecord = {
  input: { sentenceId, text: part.text, tokens: tokenize(part.text) },
  phase: "discovered",
  blockId: candidate.id,
};
```

(g) 同一函数里，`const replacement = (this.options.replacementFactory ?? ...)();` 之后加：

```ts
const marker = (this.options.markerFactory ?? (() => new BlockActivityMarker()))();
```

并在 `this.blocks.set(candidate.id, { ... })` 的对象字面量里加上 `marker,`。

(h) 新增私有方法，放在 `transition` 之前：

```ts
  /**
   * 块级「进行中」状态:块内任一句在 requesting 就打标。挂载点取当前呈现元素,
   * 流式换成卡片之后标记自动跟过去。
   */
  private refreshBlockActivity(blockId: string): void {
    const block = this.blocks.get(blockId);
    if (block === undefined) return;
    if (!block.sentences.some(({ phase }) => phase === "requesting")) {
      block.marker.clear();
      return;
    }
    const target = block.replacement.currentElement(block.candidate.element);
    if (isHTMLElement(target)) block.marker.mark(target);
  }
```

(i) 改 `transition`：

```ts
  private transition(sentence: SentenceRecord, phase: SentencePhase): void {
    sentence.phase = phase;
    this.refreshBlockActivity(sentence.blockId);
    this.options.onTransition?.(sentence.input.sentenceId, phase);
    this.emitStatus();
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/content/session-controller.test.ts`
Expected: PASS，整个文件全绿（含既有用例）。

- [ ] **Step 5: 跑全量单测**

Run: `npm test`
Expected: 全部通过。若有既有用例因 `SentenceRecord` 缺 `blockId` 而报 TS 错，补上对应的 `blockId`。

- [ ] **Step 6: 提交**

```bash
npx prettier --write src/content/session-controller.ts src/content/session-controller.test.ts
git add src/content/session-controller.ts src/content/session-controller.test.ts
git commit -m "feat: 解析中的段落显示进度标记"
```

---

## Task 3: 替换发生后把标记迁到卡片上

**Files:**

- Modify: `src/content/session-controller.ts`
- Test: `src/content/session-controller.test.ts`

- [ ] **Step 1: 写失败测试**

**先忠实化 `FakeReplacement`。** 它现在的 `currentElement()` 无条件返回 `this.displayed`，用它断言「标记迁到卡片」会**永远成立**，测不出任何东西。改成反映真实语义：

```ts
  currentElement(original: Element): Element {
    return this.active ? this.displayed : original;
  }
```

然后把新用例加进**已有的流式 `describe`**（就是定义了 `pendingHarness()` 和 `provisional` 的那个，搜 `renders provisional components` 定位）：

```ts
it("流式预览把标记迁到卡片上，整段完成前不撤", async () => {
  const { subject, transport } = pendingHarness();
  await subject.controller.start();
  subject.viewport.emit();
  await vi.waitFor(() =>
    expect(subject.transport.sent.some(({ type }) => type === "ANALYZE_CORE")).toBe(true),
  );

  transport.emitStream({
    version: 1,
    type: "CORE_STREAM",
    documentId: subject.controller.documentId,
    sentenceId: "sentence-1",
    components: provisional,
  });

  const replacement = subject.replacements[0]!;
  expect(replacement.previews).toBe(1);
  // 分片不改相位，句子仍在 requesting：标记必须还在，且已经迁到卡片上。
  expect(subject.markers[0]!.marked).toBe(replacement.displayed);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/content/session-controller.test.ts -t "流式预览把标记迁到卡片上"`
Expected: FAIL — 标记仍停在原 `<p>` 上，因为替换之后没有重新刷新挂载点。

- [ ] **Step 3: 写实现**

在 `src/content/session-controller.ts` 三处替换调用之后补刷新。

流式预览处（现约 1075 行，`renderProvisional` 一类的私有方法末尾）。把这段：

```ts
    if (!block.replacement.active) {
      block.replacement.showPreview(block.candidate.element, block.learningBlock);
    }
  }
```

改成：

```ts
    if (!block.replacement.active) {
      block.replacement.showPreview(block.candidate.element, block.learningBlock);
    }
    // 预览换上卡片之后原文已被藏起来，标记得跟到当前呈现元素上。
    this.refreshBlockActivity(block.candidate.id);
  }
```

处理完成/失败替换处（现约 773-777 行）：

```ts
if (failures.length > 0) {
  block.replacement.showPartialFailure(original, block.learningBlock, failures);
} else if (block.learningBlock.isReadyToReplace()) {
  block.replacement.show(original, block.learningBlock);
}
this.refreshBlockActivity(block.candidate.id);
this.emitStatus();
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/content/session-controller.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
npx prettier --write src/content/session-controller.ts src/content/session-controller.test.ts
git add src/content/session-controller.ts src/content/session-controller.test.ts
git commit -m "feat: 流式替换后进度标记跟随卡片"
```

---

## Task 4: 生命周期清理（停止会话与重连耗尽）

重连 4 次全失败后 `reconnectAndResume` 直接返回，句子相位**停在 `requesting`**。没有这一步，竖条会一直亮着。

**Files:**

- Modify: `src/content/session-controller.ts`
- Test: `src/content/session-controller.test.ts`

- [ ] **Step 1: 写失败测试**

追加到 `describe("段落解析中标记", ...)`：

```ts
it("停止会话清空所有标记", async () => {
  const pending = new FakeTransport(() => new Promise<ResponseMessage>(() => {}));
  const subject = harness("Readers understand complex sentences.", pending);
  await subject.controller.start();
  subject.viewport.emit();
  await vi.waitFor(() => expect(subject.markers[0]?.marked).not.toBeNull());

  subject.controller.stop();

  expect(subject.markers[0]?.marked).toBeNull();
});

it("重连彻底失败后不把标记留在页面上", async () => {
  const transport = new FakeTransport(() => new Promise<ResponseMessage>(() => {}));
  // 4 次退避全部失败，相位会停在 requesting。
  const reconnect = vi.fn<() => Promise<void>>().mockRejectedValue(new Error("worker down"));
  transport.reconnectHandler = reconnect;
  const subject = harness("Readers understand complex sentences.", transport, {
    setTimeout: (callback) => {
      callback();
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
  });
  await subject.controller.start();
  subject.viewport.emit();
  await vi.waitFor(() => expect(subject.markers[0]?.marked).not.toBeNull());

  transport.disconnect();
  await vi.waitFor(() => expect(reconnect).toHaveBeenCalledTimes(4));

  expect(subject.markers[0]?.marked).toBeNull();
});
```

注入的 `setTimeout` 同步执行回调，让 4 次退避（0/250/500/1000ms）瞬间跑完 —— 这是本文件既有断连用例的写法。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/content/session-controller.test.ts -t "标记"`
Expected: 「重连彻底失败」用例 FAIL —— `marked` 仍是那个 `<p>`。

- [ ] **Step 3: 写实现**

(a) 在 `stop()` 里，把既有的这一行：

```ts
for (const block of this.blocks.values()) block.replacement.restore();
```

改为：

```ts
for (const block of this.blocks.values()) {
  block.replacement.restore();
  block.marker.clear();
}
```

(b) 在 `reconnectAndResume` 的重试循环之后（函数末尾、`}` 之前）加：

```ts
// 重连彻底失败:相位会停在 requesting,标记不清会一直亮在页面上。
for (const block of this.blocks.values()) block.marker.clear();
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/content/session-controller.test.ts`
Expected: PASS。

- [ ] **Step 5: 跑全量单测**

Run: `npm test`
Expected: 全部通过。

- [ ] **Step 6: 提交**

```bash
npx prettier --write src/content/session-controller.ts src/content/session-controller.test.ts
git add src/content/session-controller.ts src/content/session-controller.test.ts
git commit -m "fix: 会话停止与重连失败时清掉进度标记"
```

---

## Task 5: 真实浏览器验收

**Files:**

- Modify: `tests/e2e/extension.spec.ts`

- [ ] **Step 1: 写测试**

在 `tests/e2e/extension.spec.ts` 里，紧跟既有的 `test("悬停段落经 PARSE_HOVERED_BLOCK 冷启动解析，其余段落保持原文", ...)` 之后加：

```ts
// 解析中的段落要能被认出来:标记在飞行期间存在,结束后不残留。
test("解析中的段落带进度标记，完成后不残留", async ({ harness }) => {
  await seedLocalProfile(harness);
  const release = harness.fakeModel.holdStreamBeforeEnd();
  const page = await openArticle(harness, "hover-blocks.html");
  const tabId = await harness.tabIdFor(`${harness.pagesOrigin}/hover-blocks.html`);
  const marked = page.locator('[class*="syntax-learning-block-active"]');

  await page.locator("#plain").hover();
  await harness.dispatchFromUi(
    uiMessage("PARSE_HOVERED_BLOCK", { tabId, documentId: `e2e-doc-${++requestCounter}` }),
  );

  await expect(marked).toHaveCount(1, { timeout: 20_000 });
  release();
  await expect(marked).toHaveCount(0, { timeout: 20_000 });
});
```

`harness.fakeModel.holdStreamBeforeEnd()` 是既有能力：挂住 `[DONE]`，返回一个直接调用即可放行的 `release`。既有用例「段落在流式响应收尾前就显示已生成的成分」用的就是这个写法。

- [ ] **Step 2: 构建并跑这一条**

Run: `npm run build && npx playwright test --grep "解析中的段落带进度标记"`
Expected: PASS。若 `toHaveCount(1)` 超时，先确认标记类名前缀与 `BlockActivityMarker.activeClass` 一致。

- [ ] **Step 3: 跑全量 E2E**

Run: `npx playwright test`
Expected: 全绿（截图用例 skipped 属正常）。**若耗时明显超过 40 秒**，说明改动影响了别的用例，先查清再继续。

- [ ] **Step 4: 提交**

```bash
npx prettier --write tests/e2e/extension.spec.ts
git add tests/e2e/extension.spec.ts
git commit -m "test: 补段落进度标记的真机验收"
```

---

## Task 6: 收尾

- [ ] **Step 1: 跑完整门禁**

```bash
npm test && npx playwright test && npm run lint && npm run format:check && npm run build
```

Expected: 单测全绿；E2E 全绿；lint **恰好 1 个**已知错误；format 干净；build 成功。

- [ ] **Step 2: 人眼确认视觉效果**

加载 `dist/` 到 Chrome（`chrome://extensions` → 重新加载），在一个正文较长的英文页面上按快捷键，确认：

1. 竖条在解析期间出现在**那一段**上，文字位置没有跳动（这是 `inset box-shadow` 该保证的）；
2. 解析完成变成卡片后竖条消失；
3. 深色页面上竖条依然看得清。

- [ ] **Step 3: 在 AGENTS.md 记一条约定**

在「关键工程约定」列表末尾追加：

```markdown
- **段落级进度标记只绑 `requesting` 相位**:打标/撤标统一由 `transition()` 收口刷新(`refreshBlockActivity`),挂载点取 `replacement.currentElement()` 以便流式换卡片后跟随。竖条必须用 `inset box-shadow` 而非 `border-left`——后者参与布局计算会让文字位移,推翻折行布局 E2E。重连彻底失败时相位会停在 `requesting`,必须单独清标记,否则竖条常亮。
```

- [ ] **Step 4: 提交**

```bash
npx prettier --write AGENTS.md
git add AGENTS.md
git commit -m "docs: 记录段落进度标记的相位与样式约定"
```
