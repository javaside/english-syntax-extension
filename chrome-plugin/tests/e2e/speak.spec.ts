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

    // 面板焦点朗读:面板顶部喇叭读当前详解区间,点击进入按下态。
    const focusSpeak = page.locator(".detail > [data-syntax-detail-speak]");
    await expect(focusSpeak).toBeVisible();
    await focusSpeak.click();
    await expect(focusSpeak).toHaveAttribute("aria-pressed", "true");

    // 接管语义:句头喇叭朗读中,点面板条目喇叭——条目接管、句头复位。
    const sentenceSpeak = page.locator("[data-syntax-speak]").first();
    await sentenceSpeak.click();
    await expect(sentenceSpeak).toHaveAttribute("aria-pressed", "true");

    const entrySpeak = entrySpeaks.first();
    await entrySpeak.click();
    await expect(entrySpeak).toHaveAttribute("aria-pressed", "true");
    await expect(sentenceSpeak).toHaveAttribute("aria-pressed", "false");
    await expect(focusSpeak).toHaveAttribute("aria-pressed", "false");
  });
});

test.describe("cloud tts source", () => {
  const localProfile = (harness: ExtensionHarness) => [
    {
      id: "profile-speak",
      name: "Local e2e-model",
      baseUrl: harness.fakeModel.baseUrl,
      apiKey: "sk-e2e-secret",
      model: "e2e-model",
    },
  ];

  test("云端语音源:点喇叭发起一次合成请求,播完自动复位且全程只合成一次", async ({ harness }) => {
    await harness.seedProfiles(localProfile(harness), "profile-speak");
    await harness.seedTtsSource({
      enabled: true,
      baseUrl: harness.fakeModel.baseUrl,
      apiKey: "sk-tts-secret",
      model: "FunAudioLLM/CosyVoice2-0.5B",
      voice: "anna",
    });
    const page = await startArticle(harness);

    await expect(page.locator("[data-syntax-learning-block]")).toHaveCount(4, {
      timeout: 20_000,
    });
    const speak = page.locator("[data-syntax-speak]").first();
    await expect(speak).toBeVisible();

    harness.fakeModel.clearRecorded();
    await speak.click();
    await expect(speak).toHaveAttribute("aria-pressed", "true");

    await expect
      .poll(() => harness.fakeModel.recordedOfKind("tts-speech").length, { timeout: 10_000 })
      .toBe(1);
    const request = harness.fakeModel.recordedOfKind("tts-speech")[0]!;
    // SW 侧请求形态:音色带模型前缀,鉴权头在场,正文是所点句子的文本。
    expect(request.voice).toBe("FunAudioLLM/CosyVoice2-0.5B:anna");
    expect(request.authorizationPresent).toBe(true);
    expect(request.promptText.length).toBeGreaterThan(0);

    // 静音 mp3 只有约 26ms:不等点停,断言音频自然播完后按钮经 onended 广播复位,
    // 且全程只有一次合成请求(点停/重读的语义已由单测钉住)。
    await expect(speak).toHaveAttribute("aria-pressed", "false", { timeout: 5_000 });
    expect(harness.fakeModel.recordedOfKind("tts-speech")).toHaveLength(1);
  });

  test("云端语音源失败:页面胶囊明示回落,按钮不静默卡死", async ({ harness }) => {
    await harness.seedProfiles(localProfile(harness), "profile-speak");
    // 端口 9(discard 协议)连接立即被拒:云端失败走真实回落路径,不依赖外网。
    await harness.seedTtsSource({
      enabled: true,
      baseUrl: "http://127.0.0.1:9/v1",
      apiKey: "sk-tts-secret",
      model: "FunAudioLLM/CosyVoice2-0.5B",
      voice: "anna",
    });
    const page = await startArticle(harness);

    await expect(page.locator("[data-syntax-learning-block]")).toHaveCount(4, {
      timeout: 20_000,
    });
    const speak = page.locator("[data-syntax-speak]").first();
    await speak.click();

    // 真机教训:回落只写 console 用户看不见,表现为「无声又无提示」。
    // 页面胶囊必须明示一次。
    await expect(page.locator("[data-syntax-progress-pill]")).toContainText("云端语音不可用", {
      timeout: 8_000,
    });
    // 本地回落播完(无音频输出环境事件照到)后按钮复位,不卡按下态。
    await expect(speak).toHaveAttribute("aria-pressed", "false", { timeout: 10_000 });
  });

  test("会话先启动、后配置云端:下一次点喇叭即走云端,无需重启会话", async ({ harness }) => {
    await harness.seedProfiles(localProfile(harness), "profile-speak");
    const page = await startArticle(harness);
    await expect(page.locator("[data-syntax-learning-block]")).toHaveCount(4, {
      timeout: 20_000,
    });

    // 用户中途才去选项页配置云端:会话已在跑,配置保存后不重新开始学习。
    await harness.seedTtsSource({
      enabled: true,
      baseUrl: harness.fakeModel.baseUrl,
      apiKey: "sk-tts-secret",
      model: "FunAudioLLM/CosyVoice2-0.5B",
      voice: "anna",
    });

    harness.fakeModel.clearRecorded();
    const speak = page.locator("[data-syntax-speak]").first();
    await speak.click();
    await expect(speak).toHaveAttribute("aria-pressed", "true");
    await expect
      .poll(() => harness.fakeModel.recordedOfKind("tts-speech").length, { timeout: 10_000 })
      .toBe(1);
  });

  test("云端语音源关闭:零合成请求,朗读仍走本地", async ({ harness }) => {
    await harness.seedProfiles(localProfile(harness), "profile-speak");
    await harness.seedTtsSource({
      enabled: false,
      baseUrl: harness.fakeModel.baseUrl,
      apiKey: "sk-tts-secret",
      model: "FunAudioLLM/CosyVoice2-0.5B",
      voice: "anna",
    });
    const page = await startArticle(harness);

    await expect(page.locator("[data-syntax-learning-block]")).toHaveCount(4, {
      timeout: 20_000,
    });
    const speak = page.locator("[data-syntax-speak]").first();
    await expect(speak).toBeVisible();

    harness.fakeModel.clearRecorded();
    await speak.click();
    // 按下态翻转证明点击已被处理;负向探针再留一小段确定性宽限——
    // 消息若发出,早在点击的同一任务里就计数了。
    await expect(speak).toHaveAttribute("aria-pressed", "true");
    await page.waitForTimeout(500);
    expect(harness.fakeModel.recordedOfKind("tts-speech")).toHaveLength(0);
    // 「没配/禁用」不是错误:不得弹「云端语音不可用」骚扰用户。
    await expect(page.locator("[data-syntax-progress-pill]")).not.toContainText("云端语音不可用");
  });
});
