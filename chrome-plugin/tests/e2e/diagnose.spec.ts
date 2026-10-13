import { test, expect } from "./fixtures";
import type { ExtensionHarness } from "./fixtures";

/**
 * 段落诊断 E2E(Task 11):右键菜单 → DIAGNOSE_BLOCK → content 编排 →
 * EXPLAIN_DIAGNOSIS → SW → 假服务器 → DIAGNOSIS_RESULT → 面板。
 *
 * Playwright 点不开 Chrome 原生右键菜单,所以复刻 SW 右键菜单分支的两个动作:
 * `inject(tabId)`(manifest 没有声明式 content_scripts,SW 各手势都先注入)与
 * `chrome.tabs.sendMessage` 下发页面命令。落点靠对目标段落发一次真实右键
 * (不打开原生菜单,但会派发 contextmenu DOM 事件 + 在点击处放下折叠光标):
 * D1 的选区锚点优先,contextmenu 捕获监听(recordDiagnosisTarget)次之,两条路
 * 都解析到被右键的段落——断言落点不是 body 兜底。
 * 断言全部用探针(假服务器请求记录 + 面板文本),不用墙钟。
 */

/** 剪贴板读取需要授权(fixture 页在 http://127.0.0.1 源,可授)。 */
async function grantClipboard(harness: ExtensionHarness): Promise<void> {
  // test.use 的 permissions 只作用于 Playwright 默认 context;E2E 的页面在
  // harness 的持久化 context 里,授权必须发到那里。writeText 在无头环境下没有
  // 稳定的 user-activation 判定,一并授 clipboard-write 走权限路径。
  await harness.context.grantPermissions(["clipboard-read", "clipboard-write"]);
}

async function injectContentScript(harness: ExtensionHarness, tabId: number): Promise<void> {
  await harness.serviceWorker.evaluate(
    (id: number) =>
      chrome.scripting.executeScript({ target: { tabId: id }, files: ["content-script.js"] }),
    tabId,
  );
}

/** 经 SW 侧 chrome.tabs.sendMessage 下发 DIAGNOSE_BLOCK——Playwright 点不开原生右键菜单。 */
async function sendDiagnoseBlock(harness: ExtensionHarness, tabId: number): Promise<unknown> {
  return harness.serviceWorker.evaluate(
    (id: number) =>
      chrome.tabs.sendMessage(id, {
        version: 1,
        requestId: `e2e-diagnose-${Date.now()}`,
        type: "DIAGNOSE_BLOCK",
        tabId: id,
        documentId: "e2e-diagnosis",
      }),
    tabId,
  );
}

test.describe("段落诊断", () => {
  test("诊断命令 → 面板出现 → 发了模型请求 → 报告可复制", async ({ harness }) => {
    await grantClipboard(harness);
    await harness.seedProfiles(
      [{ id: "p1", name: "fake", baseUrl: harness.fakeModel.baseUrl, apiKey: "k", model: "m" }],
      "p1",
    );
    const page = await harness.context.newPage();
    await page.goto(`${harness.pagesOrigin}/spring-ai-coverage.html`);
    const tabId = await harness.tabIdFor(page.url());

    await injectContentScript(harness, tabId);
    await page.locator("[data-audit-id='spring-feature-lead']").click({ button: "right" });
    const acknowledged = await sendDiagnoseBlock(harness, tabId);
    expect(acknowledged).toMatchObject({ type: "ACK", acknowledgedType: "DIAGNOSE_BLOCK" });

    const panel = page.locator("[data-syntax-diagnosis-panel]");
    await expect(panel).toBeAttached();
    await expect(panel).toContainText("本地判定证据");
    await expect(panel).toContainText("english-dominant");
    // 探针断言(不用墙钟):假服务器确实收到 diagnosis 请求。
    await expect
      .poll(() => harness.fakeModel.recordedOfKind("diagnosis").length)
      .toBeGreaterThanOrEqual(1);
    // 模型解释到位后才复制(面板从「生成中…」切到解释文本)。
    await expect(panel).toContainText("likelyCause:");
    await panel.locator(".copy").click();
    await expect(panel.locator(".copy")).toContainText("已复制");
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toContain("## 概述");
    expect(clip).toContain("## 模型解释");
    expect(clip).toContain("## 本地判定证据");
    // 报告里的模型段是假服务器的应答本体,不是「生成中…」占位——模型解释真的
    // 走完了 DIAGNOSIS_RESULT 回包。落点断言到「解析出目标段落」这一层:右键的
    // mousedown 会放下一个折叠光标,D1 的选区锚点优先级因此常胜过 contextmenu
    // 落点(两个平台行为不同,但都解析到被右键的那个段落)——断言落点不是 body
    // 兜底、且选择器路径正是目标段落。
    expect(clip).toContain("english ratio below threshold");
    expect(clip).toContain("main > article > p");
    expect(clip).not.toContain("落点来源: body");
  });

  test("无 profile → 面板只出本地段,modelError=CONFIG_MISSING,且不发请求", async ({ harness }) => {
    await grantClipboard(harness);
    // 刻意不 seedProfiles:storage 里没有可用档案。
    const page = await harness.context.newPage();
    await page.goto(`${harness.pagesOrigin}/spring-ai-coverage.html`);
    const tabId = await harness.tabIdFor(page.url());

    await injectContentScript(harness, tabId);
    await page.locator("[data-audit-id='spring-feature-lead']").click({ button: "right" });
    await sendDiagnoseBlock(harness, tabId);

    const panel = page.locator("[data-syntax-diagnosis-panel]");
    await expect(panel).toContainText("本地判定证据");
    await expect(panel).toContainText("CONFIG_MISSING");
    // CONFIG_MISSING 已可见 = EXPLAIN_DIAGNOSIS 走完且没发任何模型请求。
    expect(harness.fakeModel.recorded().length).toBe(0);
    await panel.locator(".copy").click();
    await expect(panel.locator(".copy")).toContainText("已复制");
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toContain("## 本地判定证据");
    // modelError 也进报告:本地证据完整、模型段明确记录 CONFIG_MISSING。
    expect(clip).toContain("模型解释不可用：CONFIG_MISSING");
  });
});

test.describe("右键菜单注册（真浏览器回归）", () => {
  // 2026-10-13 真机探针曾复现：菜单只挂在 onInstalled 上，--load-extension 首次
  // 加载时事件不触发，三个菜单全部缺失。Playwright 点不开原生菜单，但可以用
  // contextMenus.update 的 lastError 探测注册结果（update 不存在的 id 会回
  // "Cannot find menu item"，存在则成功）——这是该 bug 唯一可自动化的真浏览器断言。
  test("SW 启动即注册三个菜单，不依赖 onInstalled", async ({ harness }) => {
    const probe = (id: string) =>
      harness.serviceWorker.evaluate(async (menuId: string) => {
        const exists = await new Promise<boolean>((resolve) => {
          chrome.contextMenus.update(menuId, { title: "probe" }, () => {
            resolve(!chrome.runtime.lastError);
          });
        });
        return exists;
      }, id);

    // 注册是 SW 启动后的异步序列，探针轮询至多 5 秒
    await expect.poll(() => probe("syntax-parse-selection")).toBe(true);
    await expect.poll(() => probe("syntax-parse-context-block")).toBe(true);
    await expect.poll(() => probe("syntax-diagnose-block")).toBe(true);
  });
});
