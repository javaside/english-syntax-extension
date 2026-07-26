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

test("紧凑布局：短句共行、无孤行标点、译文不撑卡、详解以栏宽独占整行", async ({ harness }) => {
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
  // 不用 fakeModel.script：脚本队列按请求 FIFO 不看类型，core 合并/预载/详解请求会错位消费
  // outcome（详解点击可能拿到 core 形状响应）。默认 auto 对本测试所有块几何结果相同。
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
  // （句首可以有多个独立标点——不变量是「前面出现过成分」的标点必须已并入英文行）
  const strayPunctuation = await page.evaluate(() =>
    [...document.querySelectorAll("[data-syntax-learning-block]")]
      .flatMap((host) => [...host.shadowRoot!.querySelectorAll(".sentence")])
      .map(
        (sentence) =>
          [...sentence.children].filter(
            (child, index, children) =>
              child.className === "punctuation" &&
              children.slice(0, index).some((prior) => prior.classList.contains("component")),
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
  // 面板以栏宽展示——但靠的是面板自己是块级兄弟节点，不是把句子撑宽。
  // 旧实现让句子变块级来腾宽度，代价是共行的邻句被挤到下一行。
  const opened = await page.evaluate(() => {
    const host = [...document.querySelectorAll("[data-syntax-learning-block]")][3]!;
    const root = host.shadowRoot!;
    const width = (selector: string) =>
      Math.round(root.querySelector(selector)!.getBoundingClientRect().width);
    return {
      sentence: width(".sentence"),
      detail: width(".detail"),
      column: width(".sentences"),
    };
  });
  expect(opened.detail).toBeGreaterThan(opened.column * 0.9);
  expect(opened.sentence).toBeLessThanOrEqual(collapsedWidth + 8);
  await shortHost.locator(".component").first().click();
  await expect(shortHost.locator(".detail")).toHaveCount(0);
  const restoredWidth = await measureFirstSentenceWidth();
  expect(restoredWidth).toBeLessThanOrEqual(collapsedWidth + 8);

  // (e) 基线对齐：给第 4 块第一张卡注入两行长译文制造高度差后，
  // 同一视觉行里的英文行（含跨句）top 仍然齐平——不能因高卡把英文行顶上去。
  // 加宽会把第三句挤到下一行（合法换行），因此只断言仍共行的前两句。
  const englishTops = await page.evaluate(() => {
    const host = [...document.querySelectorAll("[data-syntax-learning-block]")][3]!;
    const root = host.shadowRoot!;
    root.querySelector(".translation")!.textContent =
      "这是一段足够长以至于必然折成两行的中文译文示例用来制造卡片高度差";
    return [...root.querySelectorAll(".sentence")]
      .slice(0, 2)
      .flatMap((sentence) =>
        [...sentence.querySelectorAll(".english")].map((english) =>
          Math.round(english.getBoundingClientRect().top),
        ),
      );
  });
  expect(englishTops.length).toBeGreaterThanOrEqual(4);
  expect(new Set(englishTops).size).toBe(1);

  // (f) 长译文铺开：宽卡（英文很宽）里带 translation-wide 的译文铺满卡宽，
  // 不再以 16em 窄列居中折行；卡宽仍由英文决定，不被译文撑大。
  // 类的应用阈值由单测覆盖，这里注入类只验证 CSS 几何。
  const wideSpread = await page.evaluate(() => {
    const host = [...document.querySelectorAll("[data-syntax-learning-block]")][0]!;
    const card = host.shadowRoot!.querySelector(".component")!;
    const english = card.querySelector(".english")!;
    const translation = card.querySelector(".translation")!;
    english.textContent = "to address the challenge of incorporating relevant data into prompts";
    translation.textContent = "为了解决将相关数据纳入提示以获取准确AI模型响应的挑战";
    translation.classList.add("translation-wide");
    return {
      cardWidth: Math.round(card.getBoundingClientRect().width),
      translationWidth: Math.round(translation.getBoundingClientRect().width),
    };
  });
  // 旧 CSS（16em 封顶）下译文宽 ≤206px，铺开后应与卡同宽且远超 16em。
  expect(wideSpread.cardWidth).toBeGreaterThan(300);
  expect(wideSpread.translationWidth).toBeGreaterThanOrEqual(wideSpread.cardWidth - 6);
});

test("打开详解不挤动同行的相邻句子", async ({ harness }) => {
  await harness.seedProfiles(
    [{ id: "p", name: "fake", baseUrl: harness.fakeModel.baseUrl, apiKey: "k", model: "m" }],
    "p",
  );
  const page = await harness.context.newPage();
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(`${harness.pagesOrigin}/wrap-probe.html`);
  const tabId = await harness.tabIdFor(`${harness.pagesOrigin}/wrap-probe.html`);
  await harness.dispatchFromUi({
    version: 1,
    requestId: "layout:wrap",
    type: "START_SESSION",
    tabId,
    documentId: "layout-wrap",
  });

  const componentTops = () =>
    page.evaluate(() => {
      const root = document.querySelector("[data-syntax-learning-block]")?.shadowRoot;
      const tops = [...(root?.querySelectorAll(".component") ?? [])].map((c) =>
        Math.round(c.getBoundingClientRect().top),
      );
      return [...new Set(tops)].sort((a, b) => a - b);
    });

  await expect(page.locator("[data-syntax-learning-block] .component").first()).toBeVisible();
  await page.waitForTimeout(200);
  const before = await componentTops();
  // 这段被切成两句且共行:前置条件不成立的话这条用例就测不到东西
  expect(before).toHaveLength(1);

  await page.locator("[data-syntax-learning-block] .component").first().click();
  await expect(page.locator(".detail")).toHaveCount(1);
  await page.waitForTimeout(200);

  // 点开详解只应在下方插入面板，不该让同行的另一句掉到下一行
  expect(await componentTops()).toEqual(before);
});

test("长句折行时，详解面板出现在被点成分那一行的下方", async ({ harness }) => {
  await harness.seedProfiles(
    [{ id: "p", name: "fake", baseUrl: harness.fakeModel.baseUrl, apiKey: "k", model: "m" }],
    "p",
  );
  const page = await harness.context.newPage();
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(`${harness.pagesOrigin}/multiline-probe.html`);
  const tabId = await harness.tabIdFor(`${harness.pagesOrigin}/multiline-probe.html`);
  await harness.dispatchFromUi({
    version: 1,
    requestId: "layout:multiline",
    type: "START_SESSION",
    tabId,
    documentId: "layout-multiline",
  });

  await expect(page.locator("[data-syntax-learning-block] .component").first()).toBeVisible();
  await page.waitForTimeout(200);

  const lines = await page.evaluate(() => {
    const root = document.querySelector("[data-syntax-learning-block]")!.shadowRoot!;
    const tops = [...root.querySelectorAll(".component")].map((c) =>
      Math.round(c.getBoundingClientRect().top),
    );
    return [...new Set(tops)].sort((a, b) => a - b);
  });
  // 前置条件:这句确实折了行，否则这条用例测不到东西
  expect(lines.length).toBeGreaterThanOrEqual(2);

  await page.locator("[data-syntax-learning-block] .component").first().click();
  await expect(page.locator(".detail")).toHaveCount(1);
  await page.waitForTimeout(200);

  const placement = await page.evaluate(() => {
    const root = document.querySelector("[data-syntax-learning-block]")!.shadowRoot!;
    const detail = root.querySelector(".detail")!.getBoundingClientRect();
    const comps = [...root.querySelectorAll(".component")].map((c) => c.getBoundingClientRect());
    const firstLineTop = Math.min(...comps.map((r) => r.top));
    const firstLine = comps.filter((r) => Math.abs(r.top - firstLineTop) < 4);
    const below = comps.filter((r) => r.top > detail.bottom - 1);
    return {
      detailTop: Math.round(detail.top),
      firstLineBottom: Math.round(Math.max(...firstLine.map((r) => r.bottom))),
      componentsBelowPanel: below.length,
      totalComponents: comps.length,
    };
  });

  // 面板紧跟在第一行下方
  expect(placement.detailTop).toBeGreaterThanOrEqual(placement.firstLineBottom - 2);
  // 且后面几行的成分仍在面板之下——面板没有被推到整句末尾
  expect(placement.componentsBelowPanel).toBeGreaterThan(0);
});
