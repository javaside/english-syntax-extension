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
