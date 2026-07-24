# 学习卡片布局紧凑化 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 短句共行、译文宽度封顶、成分后标点并入英文行，消除"每行很短"的布局浪费。

**Architecture:** 全部改动集中在 `src/content/learning-block.ts`：STYLES 字符串两处 CSS 改动（`.sentence` inline-flex + `:has(.detail)` 独占行；`.translation` 16em 上限）与 `renderCore` 的标点归属改动（成分后标点附加到前一成分 `.english` 内）。E2E 用几何探针断言真实布局（happy-dom 无布局能力，CSS 效果只能 E2E 验）。无协议改动。

**Tech Stack:** TypeScript + Vitest（happy-dom）+ Playwright（几何断言）。

**门禁（最后任务跑全量）：**

```bash
npm test && npx playwright test && npm run lint && npm run format:check && npm run build
```

lint 基线**恰好 1 个既有错误**（`src/options/options.test.ts`），不许新增。

**Spec:** `docs/superpowers/specs/2026-07-24-card-layout-compaction-design.md`

**已存在的调查产物（本计划要接手处理）：** 工作区有未提交的 `tests/e2e/layout-probe.spec.ts`（临时探针，Task 3 删除）和 `tests/fixtures/pages/probe-long.html`（Task 3 重命名转正）。

---

### Task 1: 成分后标点并入英文行（TS + 单测）

**Files:**

- Modify: `src/content/learning-block.ts`（`renderCore` 约第 366-447 行、`#appendPunctuation` 约第 645-655 行）
- Test: `src/content/learning-block.test.ts`

- [ ] **Step 1: 写失败测试**

沿用文件内既有 `block()` / `sentence` / `tokens` / `analysis` 夹具（`analysis` 的 OBJECT 成分区间 2-3，token 3 是句号）。新增：

```ts
it("成分区间尾与句间标点并入对应成分的英文行，不再是独立盒子", () => {
  const element = block();
  element.setExpectedSentenceIds(["sentence-1"]);
  element.renderCore(sentence, tokens, analysis);
  const sentenceElement = element.host.shadowRoot!.querySelector(".sentence")!;

  // 句号（token 3，OBJECT 区间尾）在宾语成分的英文行内，sentence 无独立标点子节点
  expect(sentenceElement.querySelector(":scope > .punctuation")).toBeNull();
  const objectEnglish = sentenceElement.querySelectorAll(".component .english")[2]!;
  expect(objectEnglish.textContent).toBe("books.");
  // 文本重建顺序不变
  expect(sentenceElement.textContent).toContain("Learners");
});

it("成分间隙的标点附加到前一成分英文行，句首标点保持独立", () => {
  const gapTokens: Token[] = [
    { id: 0, text: "«", start: 0, end: 1, leadingWhitespace: "", punctuation: true },
    { id: 1, text: "Yes", start: 1, end: 4, leadingWhitespace: "", punctuation: false },
    { id: 2, text: ",", start: 4, end: 5, leadingWhitespace: "", punctuation: true },
    { id: 3, text: "learners", start: 6, end: 14, leadingWhitespace: " ", punctuation: false },
    { id: 4, text: "read", start: 15, end: 19, leadingWhitespace: " ", punctuation: false },
    { id: 5, text: ".", start: 19, end: 20, leadingWhitespace: "", punctuation: true },
  ];
  const gapAnalysis: CoreAnalysis = {
    schemaVersion: CORE_SCHEMA_VERSION,
    sentenceId: "sentence-1",
    components: [
      { startToken: 1, endToken: 1, role: GrammarRole.INDEPENDENT_ELEMENT, translation: "是的" },
      { startToken: 3, endToken: 3, role: GrammarRole.SUBJECT, translation: "学习者" },
      { startToken: 4, endToken: 5, role: GrammarRole.PREDICATE, translation: "阅读" },
    ],
    modelProfileId: "profile-1",
  };
  const element = block();
  element.setExpectedSentenceIds(["sentence-1"]);
  element.renderCore("«Yes, learners read.", gapTokens, gapAnalysis);
  const sentenceElement = element.host.shadowRoot!.querySelector(".sentence")!;

  // 句首 « 无前置成分，保持独立子节点
  expect(sentenceElement.firstElementChild!.className).toBe("punctuation");
  // 逗号（成分间隙）并入第一个成分的英文行
  const englishSpans = sentenceElement.querySelectorAll(".component .english");
  expect(englishSpans[0]!.textContent).toBe("Yes,");
  // 句号（谓语区间尾）并入谓语英文行
  expect(englishSpans[2]!.textContent).toBe("read.");
  // 除句首外没有其他独立标点
  expect(sentenceElement.querySelectorAll(":scope > .punctuation")).toHaveLength(1);
});
```

（`Token`、`CoreAnalysis`、`CORE_SCHEMA_VERSION`、`GrammarRole` 已在测试文件 import。若 `#validateCoreInput` 对 `«Yes, learners read.` 的重建校验报错，说明 start/end 偏移写错——按报错信息修 token 偏移，不改产品校验逻辑。若 happy-dom 不支持 `:scope >` 选择器，等价改用 `[...sentenceElement.children].filter((c) => c.className === "punctuation")` 断言，意图不变。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/content/learning-block.test.ts`
Expected: FAIL——现状标点是 sentence 直接子节点，`:scope > .punctuation` 非空、english 文本不含标点。

- [ ] **Step 3: 实现**

`src/content/learning-block.ts` 的 `renderCore`（约第 366-447 行）三处：

① 循环外声明追踪变量（`let nextToken = 0;` 旁）：

```ts
let lastEnglish: HTMLElement | null = null;
```

② 循环首行的间隙标点调用改为传入归属目标：

```ts
this.#appendPunctuation(
  lastEnglish ?? sentenceElement,
  tokens,
  nextToken,
  component.startToken - 1,
);
```

③ 成分 token 循环中删除区间尾标点的排除（`if (index === component.endToken) { continue; }` 整段删除），让区间尾标点自然进入 `english`；同时删除 `sentenceElement.append(componentElement);` 之后的整个区间尾标点补append块：

```ts
for (let index = component.startToken; index <= component.endToken; index += 1) {
  const token = tokens[index];
  if (token === undefined) {
    continue;
  }
  const leadingWhitespace = index === component.startToken ? "" : token.leadingWhitespace;
  if (token.punctuation) {
    english.append(createElement("span", "punctuation", leadingWhitespace + token.text));
  } else {
    english.append(document.createTextNode(leadingWhitespace + token.text));
  }
}
```

（原注释「The gap between components comes from...」保留在原位。）

④ 每轮迭代末尾（`nextToken = component.endToken + 1;` 之前或之后）记录：

```ts
lastEnglish = english;
```

⑤ 循环后的句尾标点调用同样传目标：

```ts
this.#appendPunctuation(lastEnglish ?? sentenceElement, tokens, nextToken, tokens.length - 1);
```

⑥ `#appendPunctuation`（约第 645 行）改为向传入目标追加（参数名与 doc 同步）：

```ts
/** 把 [startToken, endToken] 里的标点追加到 target：有前置成分时是其英文行，否则是句容器。 */
#appendPunctuation(
  target: HTMLElement,
  tokens: readonly Token[],
  startToken: number,
  endToken: number,
): void {
  for (let index = startToken; index <= endToken; index += 1) {
    const token = tokens[index];
    if (token?.punctuation === true) {
      target.append(createElement("span", "punctuation", token.leadingWhitespace + token.text));
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/content/learning-block.test.ts`
Expected: 全部 PASS。既有用例若有对标点为独立子节点的隐含依赖（如子节点计数），按新归属修正断言（文本顺序类断言不应变）。

- [ ] **Step 5: 提交**

```bash
npm run format:check
git add src/content/learning-block.ts src/content/learning-block.test.ts
git commit -m "fix: 成分后标点并入前一成分英文行，消除句号孤行"
```

---

### Task 2: 短句共行与译文宽度上限（CSS）

**Files:**

- Modify: `src/content/learning-block.ts`（仅 STYLES 字符串）

CSS 无法在 happy-dom 单测断言，行为由 Task 3 的 E2E 几何断言覆盖；本任务只改样式并保证既有测试不回归。

- [ ] **Step 1: 实现**

STYLES 中，在 `.sentence, .detail-annotations { ... }` 共享块（保持原样）之后插入：

```css
.sentence {
  display: inline-flex;
  vertical-align: bottom;
  margin-inline-end: 0.75em;
  margin-block-end: 0.55em;
}

/* 打开详解面板的句子独占整行，保证面板以栏宽展示；关闭后自动恢复共行。 */
.sentence:has(.detail) {
  display: flex;
  margin-inline-end: 0;
}
```

`.translation, .annotation-translation` 块加一行译文宽度上限（约 20 个汉字；否决方案与理由见 spec 改动二，勿"优化"回退）：

```css
.translation,
.annotation-translation {
  font-size: max(12px, 0.8em);
  opacity: 0.78;
  max-inline-size: 16em;
}
```

- [ ] **Step 2: 跑单测确认无回归**

Run: `npx vitest run src/content/learning-block.test.ts`
Expected: 全部 PASS（纯样式字符串改动）。

- [ ] **Step 3: 提交**

```bash
npm run format:check
git add src/content/learning-block.ts
git commit -m "feat: 短句卡片共行展示，译文宽度16em封顶不再撑宽卡片"
```

---

### Task 3: E2E 布局回归测试（探针转正）

**Files:**

- Rename: `tests/fixtures/pages/probe-long.html` → `tests/fixtures/pages/layout-article.html`（内容不变，工作区已存在）
- Create: `tests/e2e/layout.spec.ts`
- Delete: `tests/e2e/layout-probe.spec.ts`（临时探针）

- [ ] **Step 1: 转正 fixture 并删除临时探针**

```bash
mv tests/fixtures/pages/probe-long.html tests/fixtures/pages/layout-article.html
rm tests/e2e/layout-probe.spec.ts
```

- [ ] **Step 2: 写 E2E（几何断言，不用截图不用墙钟）**

`tests/e2e/layout.spec.ts`：

```ts
import type { Page } from "@playwright/test";
import { test, expect, type ExtensionHarness } from "./fixtures";

let requestCounter = 0;

async function startSession(harness: ExtensionHarness, path: string): Promise<Page> {
  const page = await harness.context.newPage();
  await page.goto(`${harness.pagesOrigin}/${path}`);
  const tabId = await harness.tabIdFor(`${harness.pagesOrigin}/${path}`);
  const response = await harness.dispatchFromUi({
    version: 1,
    requestId: `layout:${++requestCounter}`,
    type: "START_SESSION",
    tabId,
    documentId: `layout-doc-${requestCounter}`,
  });
  expect(response, JSON.stringify(response)).toMatchObject({ type: "SESSION_STATUS" });
  return page;
}

test("紧凑布局：短句共行、无孤行标点、译文不撑卡、详解独占整行", async ({ harness }) => {
  await harness.seedProfiles(
    [
      {
        id: "profile-layout",
        name: "Layout",
        baseUrl: harness.fakeModel.baseUrl,
        apiKey: "sk-layout",
        model: "layout-model",
      },
    ],
    "profile-layout",
  );
  harness.fakeModel.script("layout-model", [
    { kind: "compound" },
    { kind: "compound" },
    { kind: "compound" },
    { kind: "compound" },
  ]);
  const page = await startSession(harness, "layout-article.html");
  const hosts = page.locator("[data-syntax-learning-block]");
  await expect(hosts).toHaveCount(4, { timeout: 20_000 });
  // 每个块都渲染出成分后再量几何
  await expect(page.locator("[data-syntax-learning-block]").last()).toBeVisible();
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            [...document.querySelectorAll("[data-syntax-learning-block]")].filter(
              (host) => (host.shadowRoot?.querySelectorAll(".component").length ?? 0) > 0,
            ).length,
        ),
      { timeout: 20_000 },
    )
    .toBe(4);

  // (a) 多短句段（第 4 个块）：三个句子共享同一行
  const shortRowTops = await page.evaluate(() => {
    const host = [...document.querySelectorAll("[data-syntax-learning-block]")][3]!;
    return [...host.shadowRoot!.querySelectorAll(".sentence")].map((sentence) =>
      Math.round(sentence.getBoundingClientRect().top),
    );
  });
  expect(shortRowTops).toHaveLength(3);
  expect(new Set(shortRowTops).size).toBe(1);

  // (b) 无孤行标点：任何句子都没有跟在成分后的独立标点子节点
  const strayPunctuation = await page.evaluate(() =>
    [...document.querySelectorAll("[data-syntax-learning-block]")]
      .flatMap((host) => [...host.shadowRoot!.querySelectorAll(".sentence")])
      .map(
        (sentence) =>
          [...sentence.children].filter(
            (child, index) => child.className === "punctuation" && index > 0,
          ).length,
      )
      .reduce((sum, count) => sum + count, 0),
  );
  expect(strayPunctuation).toBe(0);

  // (c) 译文封顶：把短句（第 3 个块）译文改成 30 字长文后，卡宽仍 ≤ 230px（16em≈205px + 余量）
  const cappedWidth = await page.evaluate(() => {
    const host = [...document.querySelectorAll("[data-syntax-learning-block]")][2]!;
    const root = host.shadowRoot!;
    for (const t of root.querySelectorAll(".translation")) {
      t.textContent = "这是一段明显比对应英文片段宽得多的超长中文译文示例用来验证上限";
    }
    const widths = [...root.querySelectorAll(".component")].map(
      (c) => c.getBoundingClientRect().width,
    );
    return Math.max(...widths);
  });
  expect(cappedWidth).toBeLessThanOrEqual(230);

  // (d) 打开详解 → 该句独占整行（宽度≈栏宽）；再点一次关闭 → 恢复共行收窄
  const shortHost = page.locator("[data-syntax-learning-block]").nth(3);
  const measureFirstSentenceWidth = () =>
    page.evaluate(() => {
      const host = [...document.querySelectorAll("[data-syntax-learning-block]")][3]!;
      return Math.round(host.shadowRoot!.querySelector(".sentence")!.getBoundingClientRect().width);
    });
  const collapsedWidth = await measureFirstSentenceWidth();
  await shortHost.locator(".component").first().click();
  await expect(shortHost.locator(".detail")).toBeVisible();
  const expandedWidth = await measureFirstSentenceWidth();
  expect(expandedWidth).toBeGreaterThan(collapsedWidth * 1.5);
  await shortHost.locator(".component").first().click();
  await expect(shortHost.locator(".detail")).toHaveCount(0);
  const restoredWidth = await measureFirstSentenceWidth();
  expect(restoredWidth).toBeLessThanOrEqual(collapsedWidth + 8);
});
```

注意：`.component` 是 Shadow DOM 内元素，Playwright locator 能穿透 open shadow root；若 `shortHost.locator(".component")` 定位失败，改用 `page.evaluate` 内 `dispatchEvent(new MouseEvent("click", { bubbles: true }))` 点击并说明原因。detail 由假模型 `detail` 响应自动生成（`detectKind` 识别，无需脚本）。

- [ ] **Step 3: 运行新 E2E**

Run: `npx playwright test tests/e2e/layout.spec.ts`
Expected: PASS。失败时先读断言值：(a) 失败多为共行 CSS 未生效；(c) 失败看 16em 是否被其他规则覆盖；(d) 失败看 `:has` 选择器。

- [ ] **Step 4: 提交**

```bash
npm run format:check
git add tests/e2e/layout.spec.ts tests/fixtures/pages/layout-article.html
git rm -q --cached tests/e2e/layout-probe.spec.ts 2>/dev/null || true
git commit -m "test: 卡片紧凑布局 E2E 几何回归(共行/标点归属/译文封顶/详解独占行)"
```

（`layout-probe.spec.ts` 从未提交过，直接 `rm` 即可，`git rm --cached` 仅兜底。）

---

### Task 4: 全量门禁与收尾

**Files:** 无新改动（只跑验证与勾选）

- [ ] **Step 1: 全量单测** — Run: `npm test`，Expected: 全部 PASS。
- [ ] **Step 2: 全量 E2E** — Run: `npx playwright test`，Expected: 全部 PASS。既有用例若因标点归属结构断言失败，按 spec 语义最小修正测试断言（不得为过测试改产品语义）。
- [ ] **Step 3: lint/格式/构建** — Run: `npm run lint; npm run format:check && npm run build`，Expected: lint 恰好 1 个既有错误、其余通过。
- [ ] **Step 4: 勾掉计划复选框并提交**

```bash
git add docs/superpowers/plans/2026-07-24-card-layout-compaction.md
git commit -m "docs: 勾选卡片布局紧凑化计划完成项"
```

- [ ] **Step 5: 真机验收提醒（人工）**

真机加载 `dist/`，重点看：① 多个短句是否共行且间距自然；② 不等高句子相邻时 `vertical-align: bottom` 的观感；③ 打开/关闭成分详解时句子展开/收回是否跳动；④ 长文章页整体密度对比修复前。
