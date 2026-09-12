import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
// 生产 segmenter 直接进 E2E:期望句集合与页面跑的是同一份实现,不允许测试里再抄一份。
// segmenter 只依赖正则与纯函数(type-only 的 DOM 依赖在转译时擦除),Node 侧可用。
import { segmentBlock } from "../../src/language/segmenter";
import { MAX_SENTENCES_PER_REQUEST } from "../../src/shared/protocol";
import { test, expect } from "./fixtures";
import type { ExtensionHarness } from "./fixtures";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * 页面级覆盖 E2E(Task 11 第一部分)。
 *
 * 两份 coverage fixture(页面 + 冻结 inventory)在这里走完整链路:自动扫描发现 →
 * 逐块视口解析 → 卡片渲染 → STOP 无损还原 → 重开缓存零请求。所有等待都用探针
 * (fake model 请求记录 + GET_SESSION_STATUS),不用墙钟;真模型 candidate 属
 * Task 11 第二部分,另行派发。
 */

interface InventoryContract {
  units: readonly { id: string; text: string; automatic: boolean }[];
}

interface CoverageSessionStatus {
  discovered: number;
  queued: number;
  ready: number;
  failed: number;
  skipped?: number;
  inFlight?: number;
}

interface CoverageFixture {
  name: string;
  /** STOP 后必须逐字节还原的元素:标题 / 表格 / 图注(或题注) / 链接。 */
  restoreSelectors: string[];
  /** 嵌套结构组:组内每个自动单元恰好一张卡(figcaption>p、li 带子列表、table、dl)。 */
  nestedGroups: Record<string, number>;
}

const COVERAGE_FIXTURES: CoverageFixture[] = [
  {
    name: "arxiv-paper-coverage",
    restoreSelectors: [
      "[data-audit-id='arxiv-paper-title']",
      "[data-audit-id='arxiv-definition-table']",
      "[data-audit-id='arxiv-figure-caption']",
      "a[href='mailto:author@example.org']",
    ],
    nestedGroups: {
      // figcaption > p:只有 p 一张卡,figcaption 与 figure 都不整体成卡。
      "[data-audit-id='arxiv-figure']": 1,
      // div 带直接文本 + 子 p:父保持原文,只有子 p 一张卡。
      "[data-audit-id='arxiv-partial-parent']": 1,
      // caption + 两个 th + 自然语言 td 各一张;公式 td(display-math)不算。
      "[data-audit-id='arxiv-definition-table']": 4,
    },
  },
  {
    name: "spring-ai-coverage",
    restoreSelectors: [
      "[data-audit-id='spring-page-title']",
      "[data-audit-id='spring-table']",
      "[data-audit-id='spring-table-caption']",
      // 页面没有链接元素;用「自身不替换、子单元各有卡」的嵌套 li 补位还原检查。
      "[data-audit-id='spring-tool-calling']",
    ],
    nestedGroups: {
      // 列表单元:四个叶子 li 各一张卡(嵌套 li 只进叶子,父 li 保持原文)。
      "[data-audit-id='spring-feature-list']": 4,
      // 父 li(unsafe-partial-replacement)保持原文,只有两个子 li 各一张卡。
      "[data-audit-id='spring-tool-calling']": 2,
      // dt + dd 各一张。
      "[data-audit-id='spring-definitions']": 2,
      // caption + 表头 + 自然语言 td 各一张;✓ 列与非英文单元格不算。
      "[data-audit-id='spring-table']": 3,
    },
  },
];

/** 任何模型请求都不得携带的文本:公式 / annotation / 作者与邮箱 / 占位符 / 文献噪声。 */
const FORBIDDEN_PROMPT_FRAGMENTS = [
  "p(H0 | d) proportional to", // arXiv display equation
  "H_0", // TeX annotation(math 辅助内容)
  "author@example.org", // 作者邮箱
  "\\Acp", // LaTeXML 转换占位符
  "Many Authors. Journal metadata", // 无题名 reference
  "Alice Researcher", // 论文作者块
  "Hidden author affiliation", // 隐藏段落(arXiv)
  "Hidden migration instructions", // 隐藏段落(Spring)
  "Reference navigation", // 站点导航(Spring)
  "Related documentation", // 边栏(Spring)
  "arXiv paper tools", // 站点工具条(arXiv)
  "Download source", // 交互按钮(arXiv)
  "Try Spring AI", // 交互按钮(Spring)
  "仅供测试", // 非英文单元格(Spring)
];

const HAN_PATTERN = /[\u{4e00}-\u{9fff}]/u;

let requestCounter = 0;

function uiMessage(type: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { version: 1, requestId: `page-coverage:${type}:${++requestCounter}`, type, ...extra };
}

function loadInventory(fixtureName: string): InventoryContract {
  return JSON.parse(
    readFileSync(
      join(projectRoot, "tests", "fixtures", "page-inventory", `${fixtureName}.json`),
      "utf8",
    ),
  ) as InventoryContract;
}

/** 期望句集合:inventory 的 automatic 单元文本过生产 segmenter。 */
function expectedSentences(inventory: InventoryContract): string[] {
  return inventory.units
    .filter((unit) => unit.automatic)
    .flatMap((unit) => segmentBlock(unit.text).map((sentence) => sentence.text));
}

function learningBlocks(page: Page) {
  return page.locator("[data-syntax-learning-block]");
}

async function seedCoverageProfile(harness: ExtensionHarness, model: string): Promise<void> {
  await harness.seedProfiles(
    [
      {
        id: "profile-page-coverage",
        name: "Page coverage",
        baseUrl: harness.fakeModel.baseUrl,
        apiKey: "sk-page-coverage-secret",
        model,
      },
    ],
    "profile-page-coverage",
  );
}

async function startCoverageSession(
  harness: ExtensionHarness,
  fixtureName: string,
  documentId: string,
): Promise<{ page: Page; tabId: number }> {
  const page = await harness.context.newPage();
  const url = `${harness.pagesOrigin}/${fixtureName}.html`;
  await page.goto(url);
  const tabId = await harness.tabIdFor(url);
  const started = await harness.dispatchFromUi(uiMessage("START_SESSION", { tabId, documentId }));
  expect(started, JSON.stringify(started)).toMatchObject({ type: "SESSION_STATUS" });
  return { page, tabId };
}

async function sessionStatus(
  harness: ExtensionHarness,
  tabId: number,
  documentId: string,
): Promise<CoverageSessionStatus | null> {
  const response = (await harness.dispatchFromUi(
    uiMessage("GET_SESSION_STATUS", { tabId, documentId }),
  )) as { status?: CoverageSessionStatus };
  return response.status ?? null;
}

/** 全部句子到终态且没有在飞工作;expectedCount 是期望句总数。 */
function isSettled(status: CoverageSessionStatus, expectedCount: number): boolean {
  const settledCount = status.ready + status.failed + (status.skipped ?? 0);
  return (
    status.discovered === expectedCount &&
    settledCount === status.discovered &&
    status.queued === 0 &&
    (status.inFlight ?? 0) === 0
  );
}

/**
 * 逐个 automatic 单元滚进视口(不要一次 scrollTo 底部,让每块都真实走一遍视口发现)。
 * 用普通 DOM scrollIntoView 而不是 Playwright 的 scrollIntoViewIfNeeded:相邻块连带
 * 解析会把尚未滚到的原文提前变 display:none,后者的 actionability 等待会对每个这样的
 * 元素空转到超时;而 display:none 的原文根本不需要滚——它自己的块已被登记派发。
 */
async function scrollThroughUnits(page: Page, unitIds: readonly string[]): Promise<void> {
  for (const id of unitIds) {
    await page.evaluate((auditId) => {
      const unit = document.querySelector(`[data-audit-id="${auditId}"]`);
      unit?.scrollIntoView({ block: "center" });
      // 交还一帧,让 IntersectionObserver 的回调有机会先跑。
      return new Promise<void>((done) => requestAnimationFrame(() => done()));
    }, id);
  }
}

/** 每张卡的译文数量与全部译文文本,用于「每块至少一条且都含 Han」断言。 */
async function translationAudit(page: Page): Promise<{ perBlock: number[]; texts: string[] }> {
  return page.evaluate(() => {
    const hosts = [...document.querySelectorAll("[data-syntax-learning-block]")];
    const perBlock: number[] = [];
    const texts: string[] = [];
    for (const host of hosts) {
      const translations = [...(host.shadowRoot?.querySelectorAll(".translation") ?? [])];
      perBlock.push(translations.length);
      for (const translation of translations) texts.push(translation.textContent ?? "");
    }
    return { perBlock, texts };
  });
}

function expectHanEverywhere(audit: { perBlock: number[]; texts: string[] }): void {
  expect(audit.texts.length).toBeGreaterThan(0);
  for (const text of audit.texts) {
    expect(text).toMatch(HAN_PATTERN);
  }
  for (const count of audit.perBlock) {
    expect(count).toBeGreaterThanOrEqual(1);
  }
}

for (const fixture of COVERAGE_FIXTURES) {
  test(`${fixture.name}:整页语义覆盖、缓存重开零请求与 STOP 无损还原`, async ({ harness }) => {
    test.setTimeout(180_000);
    const inventory = loadInventory(fixture.name);
    const units = inventory.units.filter((unit) => unit.automatic);
    const expected = expectedSentences(inventory);
    // 期望句集合自身唯一(两份 fixture 当前如此;若未来出现重复句,全等+唯一断言需改口径)。
    expect(new Set(expected).size, "fixture 期望句集合应唯一").toBe(expected.length);

    await seedCoverageProfile(harness, `coverage-${fixture.name}`);

    const page = await harness.context.newPage();
    await page.goto(`${harness.pagesOrigin}/${fixture.name}.html`);
    const originalMarkup = new Map<string, string>();
    for (const selector of fixture.restoreSelectors) {
      originalMarkup.set(selector, await page.locator(selector).evaluate((node) => node.outerHTML));
    }

    const documentId = `page-coverage-${fixture.name}`;
    const { tabId } = await startCoverageSession(harness, fixture.name, documentId);

    await scrollThroughUnits(
      page,
      units.map((unit) => unit.id),
    );

    // 探针轮询:整页状态定格(fake 请求集合 == 期望句集合)同时成立才算完成。
    await expect
      .poll(
        async () => {
          const status = await sessionStatus(harness, tabId, documentId);
          const requested = harness.fakeModel
            .recordedOfKind("core")
            .flatMap((request) => request.sentenceTexts);
          return {
            settled: status !== null && isSettled(status, expected.length),
            requested: [...requested].sort(),
          };
        },
        { timeout: 120_000 },
      )
      .toEqual({ settled: true, requested: [...expected].sort() });

    // core 请求集合:多重集全等(轮询里)+ 唯一 + 单请求不超批上限。修复轮是合法路径
    // (假服务器的位置式 SUBJECT/OBJECT 切分可能被本地 validator 拒掉一次),所以这里
    // 不要求 core-repair 为零——但每一个进入修复轮的批都必须最终成功,句子集合仍全等。
    const coreRequests = harness.fakeModel.recordedOfKind("core");
    const requestedSentences = coreRequests.flatMap((request) => request.sentenceTexts);
    expect(new Set(requestedSentences).size).toBe(expected.length);
    for (const request of coreRequests) {
      expect(request.sentenceTexts.length).toBeLessThanOrEqual(MAX_SENTENCES_PER_REQUEST);
    }
    // 唯一允许的非 core kind 是修复轮(详情点击/预载都没发生);修复轮是否出现
    // 取决于假服务器的位置式拆分是否撞上本地 validator 的硬门,两种都算绿。
    const requestedKinds = new Set(harness.fakeModel.recorded().map((request) => request.kind));
    expect(requestedKinds.has("core")).toBe(true);
    expect([...requestedKinds].filter((kind) => kind !== "core" && kind !== "core-repair")).toEqual(
      [],
    );

    const finalStatus = await sessionStatus(harness, tabId, documentId);
    expect(finalStatus).toMatchObject({
      discovered: expected.length,
      ready: expected.length,
      failed: 0,
      skipped: 0,
      queued: 0,
      inFlight: 0,
    });

    // 卡片:每个自动单元恰好一张(原文元素之后紧跟卡片宿主),嵌套组内不多不少。
    await expect(learningBlocks(page)).toHaveCount(units.length);
    for (const unit of units) {
      const hostFollows = await page
        .locator(`[data-audit-id="${unit.id}"]`)
        .evaluate(
          (node) => node.nextElementSibling?.hasAttribute("data-syntax-learning-block") === true,
        );
      expect(hostFollows, `${unit.id} 原文之后应紧跟一张卡片宿主`).toBe(true);
    }
    for (const [scope, cardCount] of Object.entries(fixture.nestedGroups)) {
      expect(await page.locator(`${scope} [data-syntax-learning-block]`).count()).toBe(cardCount);
    }

    // 译文义务:每条 rendered translation 都含 Han。假服务器译文(主语/其余成分)
    // 本身就是中文,若某条译文不是中文,说明渲染走了 isEchoTranslation 兜底或丢译文,
    // 「ledger 前移」的页面语义覆盖即告破。
    expectHanEverywhere(await translationAudit(page));

    // 排除义务:公式/annotation/作者与邮箱/占位符/无题名文献/隐藏与导航内容绝不进任何请求。
    for (const request of harness.fakeModel.recorded()) {
      const haystack = [request.promptText, request.sentenceTexts.join("\n")].join("\n");
      for (const fragment of FORBIDDEN_PROMPT_FRAGMENTS) {
        expect(haystack, `模型请求不得包含被排除内容:${fragment}`).not.toContain(fragment);
      }
    }

    // STOP:零残留 + 关键元素逐字节还原。
    const stopped = await harness.dispatchFromUi(uiMessage("STOP_SESSION", { tabId, documentId }));
    expect(stopped).toMatchObject({ type: "SESSION_STATUS", status: { state: "stopped" } });
    await expect(learningBlocks(page)).toHaveCount(0);
    await expect(page.locator("style[data-syntax-learning-hide]")).toHaveCount(0);
    await expect(page.locator("[data-syntax-learning-active]")).toHaveCount(0);
    await expect(page.locator("style[data-syntax-learning-active-style]")).toHaveCount(0);
    await expect(page.locator("[data-syntax-progress-pill]")).toHaveCount(0);
    for (const [selector, original] of originalMarkup) {
      expect(
        await page.locator(selector).evaluate((node) => node.outerHTML),
        `${selector} 停止后应逐字节还原`,
      ).toBe(original);
    }

    // 换 documentId 重开必须换 tab:SW 在 STOP_SESSION 时保留 activeTabs 条目,同 tab
    // 的 START_SESSION 会沿用 previous.documentId,请求里的新 id 被静默丢弃——名义上的
    // 「换键重开」并不成立。关掉原 tab(其记录随 tabs.onRemoved 清除)再开新 tab,
    // START_SESSION 的 documentId 参数才真正生效;零请求 + 全 ready 恰好钉住
    // 「缓存键不含 documentId」——新会话靠规范句文本 + 模式版本直接命中旧会话缓存。
    // URL 加查询串让 tabIdFor 精确认到新 tab,与原 tab 关闭时序解耦。
    harness.fakeModel.clearRecorded();
    const reopenDocumentId = `${documentId}-reopen`;
    await page.close();
    const reopenedPage = await harness.context.newPage();
    const reopenUrl = `${harness.pagesOrigin}/${fixture.name}.html?reopen=1`;
    await reopenedPage.goto(reopenUrl);
    const reopenedTabId = await harness.tabIdFor(reopenUrl);
    expect(reopenedTabId, "重开腿必须拿到新 tab").not.toBe(tabId);
    const reopened = await harness.dispatchFromUi(
      uiMessage("START_SESSION", { tabId: reopenedTabId, documentId: reopenDocumentId }),
    );
    expect(reopened).toMatchObject({ type: "SESSION_STATUS" });
    await scrollThroughUnits(
      reopenedPage,
      units.map((unit) => unit.id),
    );
    await expect
      .poll(
        async () => {
          const status = await sessionStatus(harness, reopenedTabId, reopenDocumentId);
          return {
            settled: status !== null && isSettled(status, expected.length),
            modelRequests: harness.fakeModel.recorded().length,
            ready: status?.ready ?? 0,
          };
        },
        { timeout: 120_000 },
      )
      .toEqual({ settled: true, modelRequests: 0, ready: expected.length });
    await expect(learningBlocks(reopenedPage)).toHaveCount(units.length);
    expectHanEverywhere(await translationAudit(reopenedPage));

    await harness.dispatchFromUi(
      uiMessage("STOP_SESSION", { tabId: reopenedTabId, documentId: reopenDocumentId }),
    );
    await expect(learningBlocks(reopenedPage)).toHaveCount(0);
    await reopenedPage.close();
  });
}

test("整页三轮非法脚本:失败可见、不写缓存,重新解析强制重发请求", async ({ harness }) => {
  test.setTimeout(180_000);
  const fixtureName = "spring-ai-coverage";
  const inventory = loadInventory(fixtureName);
  const expectedCount = expectedSentences(inventory).length;
  const model = `coverage-failure-${fixtureName}`;
  await seedCoverageProfile(harness, model);

  // 测试共享同一个浏览器 profile:前面的用例已把 spring 的句子写进缓存,会让
  // 本用例直接命中缓存而碰不到假服务器。先清缓存,让失败路径真正走到模型。
  const cleared = await harness.dispatchFromUi(uiMessage("CLEAR_CACHE"));
  expect(cleared, JSON.stringify(cleared)).toMatchObject({ type: "ACK" });

  // 首轮 + 至多两轮 repair:每个失败批消耗三份非法响应。队列刻意超量排满——
  // 少排任何一轮,后续 repair 会拿到队列耗尽后的默认合法响应,用例会从
  // 「验证失败可见」悄悄变成「修复成功渲染」。
  harness.fakeModel.script(
    model,
    Array.from({ length: 120 }, () => ({ kind: "invalid-json" as const })),
  );

  const documentId = `page-coverage-failure-${fixtureName}`;
  const { page, tabId } = await startCoverageSession(harness, fixtureName, documentId);
  await scrollThroughUnits(
    page,
    inventory.units.filter((unit) => unit.automatic).map((unit) => unit.id),
  );

  await expect
    .poll(
      async () => {
        const status = await sessionStatus(harness, tabId, documentId);
        return (
          status !== null && isSettled(status, expectedCount) && status.failed === expectedCount
        );
      },
      { timeout: 120_000 },
    )
    .toBe(true);

  const firstPassCore = harness.fakeModel.recordedOfKind("core").length;
  expect(firstPassCore).toBeGreaterThanOrEqual(
    Math.ceil(expectedCount / MAX_SENTENCES_PER_REQUEST),
  );
  // 判死之前必须真的完成两轮修复:每个失败批恰好 1 次 core + 2 次 core-repair。
  expect(harness.fakeModel.recordedOfKind("core-repair")).toHaveLength(firstPassCore * 2);

  // 失败逐句可见(每单元一句,共 expectedCount 条失败条目)。
  await expect(page.locator(".sentence-failure")).toHaveCount(expectedCount);
  await expect(page.locator(".sentence-failure").first()).toContainText("INVALID_MODEL_OUTPUT");
  await expect(
    page.locator(".sentence-failure", { hasText: "Portable API support across AI providers" }),
  ).toHaveCount(1);

  // 失败不写缓存的正面证据:REANALYZE_VISIBLE 带 bypassCache 强制绕过缓存,
  // 所以这里必然出现「第二批」等量的模型请求——若失败曾被写成成功缓存,绕过
  // 与否无从区分;真正的判据是:此前的失败结果没有以任何形式短路这一轮请求。
  // 队列仍是非法响应:第二批同样走到判死,请求数再次至少增加一批(1+2)/批。
  // 注意:本用例因此不钉「失败被写进缓存」这类回归——bypassCache 会把任何缓存
  // 条目(无论对错)都绕开;「失败不可作为缓存命中」由换键重开零请求腿覆盖。
  const beforeReanalyze = harness.fakeModel.recordedOfKind("core").length;
  const reanalyzed = await harness.dispatchFromUi(
    uiMessage("REANALYZE_VISIBLE", { tabId, documentId }),
  );
  expect(reanalyzed).toMatchObject({ type: "SESSION_STATUS" });
  await expect
    .poll(
      async () => {
        const status = await sessionStatus(harness, tabId, documentId);
        return (
          status !== null && isSettled(status, expectedCount) && status.failed === expectedCount
        );
      },
      { timeout: 120_000 },
    )
    .toBe(true);
  const afterReanalyzeCore = harness.fakeModel.recordedOfKind("core").length;
  expect(afterReanalyzeCore).toBeGreaterThanOrEqual(
    beforeReanalyze + Math.ceil(expectedCount / MAX_SENTENCES_PER_REQUEST),
  );
  expect(harness.fakeModel.recordedOfKind("core-repair")).toHaveLength(afterReanalyzeCore * 2);
  await expect(page.locator(".sentence-failure")).toHaveCount(expectedCount);
  await expect(page.locator(".component")).toHaveCount(0);

  await harness.dispatchFromUi(uiMessage("STOP_SESSION", { tabId, documentId }));
  await expect(learningBlocks(page)).toHaveCount(0);
});
