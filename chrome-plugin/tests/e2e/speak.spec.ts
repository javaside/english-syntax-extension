import { test, expect } from "./fixtures";
import type { ExtensionHarness } from "./fixtures";
import type { Page } from "@playwright/test";

// 与 extension.spec.ts 同款最小启动路径:本地 profile + 假模型服务器。
let requestCounter = 0;

function uiMessage(type: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { version: 1, requestId: `speak-e2e:${type}:${++requestCounter}`, type, ...extra };
}

async function startArticle(harness: ExtensionHarness): Promise<Page> {
  const page = await harness.context.newPage();
  await page.goto(`${harness.pagesOrigin}/dynamic-article.html`);
  const tabId = await harness.tabIdFor(`${harness.pagesOrigin}/dynamic-article.html`);
  const response = await harness.dispatchFromUi(
    uiMessage("START_SESSION", { tabId, documentId: `speak-doc-${++requestCounter}` }),
  );
  expect(response, JSON.stringify(response)).toMatchObject({ type: "SESSION_STATUS" });
  return page;
}

/**
 * 朗读 E2E 的断言口径:只断言挂载与按下态切换(点击后立即断言,不等音频、
 * 不 mock 语音、不断言墙钟)。真 Chrome 下 speak 真被调用;无音频输出的环境
 * 也只是不发声,状态断言不受影响。第二击的「停止」依赖 stop() 的同步
 * onEnd 回调,与音频进度无关。
 */
test.describe("sentence and word speaking", () => {
  test("sentence speak button toggles pressed state", async ({ harness }) => {
    await harness.seedProfiles(
      [
        {
          id: "profile-speak",
          name: "Local e2e-model",
          baseUrl: harness.fakeModel.baseUrl,
          apiKey: "sk-e2e-secret",
          model: "e2e-model",
        },
      ],
      "profile-speak",
    );
    const page = await startArticle(harness);

    await expect(page.locator("[data-syntax-learning-block]")).toHaveCount(4, {
      timeout: 20_000,
    });
    const speak = page.locator("[data-syntax-speak]").first();
    await expect(speak).toBeVisible();
    await expect(speak).toHaveAttribute("aria-pressed", "false");

    await speak.click();
    await expect(speak).toHaveAttribute("aria-pressed", "true");

    await speak.click();
    await expect(speak).toHaveAttribute("aria-pressed", "false");
  });

  test("detail annotation entries speak and take over from each other", async ({ harness }) => {
    await harness.seedProfiles(
      [
        {
          id: "profile-speak",
          name: "Local e2e-model",
          baseUrl: harness.fakeModel.baseUrl,
          apiKey: "sk-e2e-secret",
          model: "e2e-model",
        },
      ],
      "profile-speak",
    );
    const page = await startArticle(harness);

    await expect(page.locator("[data-syntax-learning-block]")).toHaveCount(4, {
      timeout: 20_000,
    });
    await page.locator(".component").first().click();
    const entrySpeaks = page.locator(".annotation-item button.speak");
    await expect(entrySpeaks.first()).toBeVisible({ timeout: 20_000 });

    // 结构契约:朗读按钮与下钻标注是兄弟,标注内部无嵌套 button。
    const nested = await page.evaluate(() => {
      const host = document.querySelector("[data-syntax-learning-block]")!;
      return [...host.shadowRoot!.querySelectorAll(".annotation button")].length;
    });
    expect(nested).toBe(0);

    // 接管语义:句头喇叭朗读中,点面板条目喇叭——条目接管、句头复位。
    const sentenceSpeak = page.locator("[data-syntax-speak]").first();
    await sentenceSpeak.click();
    await expect(sentenceSpeak).toHaveAttribute("aria-pressed", "true");

    const entrySpeak = entrySpeaks.first();
    await entrySpeak.click();
    await expect(entrySpeak).toHaveAttribute("aria-pressed", "true");
    await expect(sentenceSpeak).toHaveAttribute("aria-pressed", "false");
  });
});
