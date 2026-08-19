/**
 * 生成应用商店用的截图。默认跳过——只有设置 STORE_SHOTS=1 才跑，免得每次 CI 都
 * 去打模型。刻意打本机真实模型而不是假服务器:商店截图应当展示真实输出。
 *
 *   OLLAMA_MODEL=qwen3.5:9b STORE_SHOTS=1 npx playwright test screenshots
 */
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "./fixtures";

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "store-assets");
const model = process.env.OLLAMA_MODEL ?? "qwen3.5:9b";
const baseUrl = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1";
const useFake = process.env.STORE_FAKE === "1";
const STORE = { width: 1280, height: 800 };

test.skip(process.env.STORE_SHOTS !== "1", "设置 STORE_SHOTS=1 才生成商店截图");
test.describe.configure({ timeout: 900_000 });

test("商店截图：学习卡片与详解面板", async ({ harness }) => {
  mkdirSync(outDir, { recursive: true });
  await harness.seedProfiles(
    [
      {
        id: "store",
        name: "本地模型",
        baseUrl: useFake ? harness.fakeModel.baseUrl : baseUrl,
        apiKey: "ollama",
        model: useFake ? "fake-model" : model,
        timeoutMs: 120_000,
        disableReasoning: true,
      },
    ],
    "store",
  );

  const page = await harness.context.newPage();
  await page.setViewportSize(STORE);
  await page.goto(`${harness.pagesOrigin}/showcase.html`);
  const tabId = await harness.tabIdFor(`${harness.pagesOrigin}/showcase.html`);
  await harness.dispatchFromUi({
    version: 1,
    requestId: "shots:start",
    type: "START_SESSION",
    tabId,
    documentId: "shots",
  });

  const blocks = page.locator("[data-syntax-learning-block]");
  await expect.poll(() => blocks.count(), { timeout: 240_000 }).toBeGreaterThanOrEqual(3);
  // 用固定等待，不再猜"什么时候算解析完"。
  // 试过按成分数轮询(流式下有平台期，会在请求在途时误判)和等进度胶囊消失
  // (会误判为已隐藏)，都不可靠。本地模型每句约 7 秒，按段落数留足余量即可；
  // 这是一次性生成商店素材的脚本，粗糙但可预期比聪明但不准更有用。
  const waitMs = Number(process.env.SHOT_WAIT_MS ?? 240_000);
  console.log(`等待 ${waitMs / 1000}s 让整页解析完成…`);
  await page.waitForTimeout(waitMs);
  const pillText = await page
    .locator("[data-syntax-progress-pill]")
    .textContent()
    .catch(() => null);
  console.log(`拍摄时进度胶囊: ${pillText ?? "(已消失)"}`);
  await page.screenshot({ path: join(outDir, "01-cards.png") });

  // 展开一个成分的详解
  await blocks.first().locator(".component").nth(1).click();
  await expect(page.locator(".detail")).toHaveCount(1, { timeout: 120_000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(outDir, "02-detail.png") });
});

test("商店截图：选项页", async ({ harness }) => {
  mkdirSync(outDir, { recursive: true });
  const page = await harness.context.newPage();
  await page.setViewportSize(STORE);
  await page.goto(harness.optionsUrl);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(outDir, "03-options.png") });
});
