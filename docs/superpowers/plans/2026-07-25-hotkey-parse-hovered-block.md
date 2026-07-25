# 快捷键解析悬停段落 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 `Alt+T`（Chrome 扩展命令，可在 `chrome://extensions/shortcuts` 改键）对鼠标悬停的段落运行现有逐句语法解析卡片；冷页面上轻量启动会话只解析该段，不做全页扫描。

**Architecture:** manifest `commands` + SW `chrome.commands.onCommand` → 按需注入内容脚本 → 下发新页面命令 `PARSE_HOVERED_BLOCK` → content 侧用 CSS `:hover` 链最深元素 + 现有 `nearestSafeBlock()` 定位段落 → 复用 `registerCandidates` + `queueVisibleBlock` 解析链路。`SessionController.start()` 新增 `scan: false` 轻量模式与 `scanned` 升级标记。失败反馈复用右下角进度胶囊新增的 `notice()`。

**Tech Stack:** TypeScript、Chrome MV3、vitest（jsdom/happy-dom）、Playwright。

**Spec:** `docs/superpowers/specs/2026-07-25-hotkey-parse-hovered-block-design.md`

**门禁（每个任务的测试步骤只跑该文件；最后 Task 7 跑全量）：** `npm test && npx playwright test && npm run lint && npm run format:check && npm run build`

**项目硬约定（来自 AGENTS.md，违反会静默出错）：**

- 新增 `RequestMessage` 成员必须同步：`protocol.ts` 类型 + `isRequestMessage`、SW `route()` case（`route` 末尾有 `assertNever`，漏 case 过不了 `npm run build` 的 tsc）、`sendPageCommand` body 联合类型、content `ContentScriptRouter.route` switch、`RoutedController` 接口。
- 本功能**不新增** `ResponseMessage` 成员、不新增提示词、不动缓存，所以 `isRuntimeResponse`、`tests/support/fake-openai-server.ts`、`analysis-cache.ts` 都不要碰。
- lint 基线恰好 1 个已知错误，不要新增。

---

## File Structure（全部改动一览）

| 文件                                     | 动作   | 职责                                                                         |
| ---------------------------------------- | ------ | ---------------------------------------------------------------------------- |
| `src/shared/protocol.ts`                 | Modify | `PARSE_HOVERED_BLOCK` 请求类型 + guard                                       |
| `src/shared/protocol.test.ts`            | Modify | guard 测试                                                                   |
| `src/background/service-worker.ts`       | Modify | `sendPageCommand` 联合类型、`route()` case、`commands.onCommand` 监听        |
| `src/background/service-worker.test.ts`  | Modify | chromeMock 增 `commands`、route/onCommand 测试                               |
| `manifest.json`                          | Modify | `commands` 段（Alt+T）                                                       |
| `src/shared/manifest.test.ts`            | Modify | commands 断言                                                                |
| `src/content/session-controller.ts`      | Modify | `start({scan})`、`scanned` 升级、`parseHoveredBlock()`、`hoverTarget` 可注入 |
| `src/content/session-controller.test.ts` | Modify | 控制器新行为测试 + router 测试（含既有 stub 补方法）                         |
| `src/content/content-script.ts`          | Modify | `RoutedController` 接口、router case、失败提示接线                           |
| `src/content/progress-pill.ts`           | Modify | `notice()` 短暂提示                                                          |
| `src/content/progress-pill.test.ts`      | Modify | notice 测试                                                                  |
| `tests/e2e/extension.spec.ts`            | Modify | 端到端用例                                                                   |
| `README.md`                              | Modify | 使用说明补快捷键                                                             |

---

### Task 1: 协议类型 `PARSE_HOVERED_BLOCK` + SW route case

`route()` 末尾的 `assertNever(request)` 要求联合类型每个成员都有 case，所以协议类型和 SW case 必须同一提交完成，否则 `npm run build`（tsc）失败。

**Files:**

- Modify: `src/shared/protocol.ts`
- Modify: `src/background/service-worker.ts`
- Test: `src/shared/protocol.test.ts`
- Test: `src/background/service-worker.test.ts`

- [ ] **Step 1: 写失败的 guard 测试**

`src/shared/protocol.test.ts` 的 `it.each` 有效请求列表（第 77 行 `PARSE_CONTEXT_BLOCK` 条目之后）加一行：

```ts
    ["PARSE_CONTEXT_BLOCK", { ...page, type: "PARSE_CONTEXT_BLOCK" }],
    ["PARSE_HOVERED_BLOCK", { ...page, type: "PARSE_HOVERED_BLOCK" }],
```

同文件 describe 内再加一个拒绝多余键的测试（与 `REANALYZE_VISIBLE` 的同类测试并列）：

```ts
it("rejects a hovered-block request with surplus keys", () => {
  expect(isRequestMessage({ ...page, type: "PARSE_HOVERED_BLOCK", target: "body" })).toBe(false);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/shared/protocol.test.ts`
Expected: FAIL —— `accepts a valid PARSE_HOVERED_BLOCK request` 断言 `true` 但得到 `false`。

- [ ] **Step 3: 实现协议 + SW 同步点**

`src/shared/protocol.ts`：

联合类型末尾（第 51 行 `PARSE_CONTEXT_BLOCK` 成员之后）：

```ts
  | (PageRequestBase & { type: "PARSE_CONTEXT_BLOCK" })
  | (PageRequestBase & { type: "PARSE_HOVERED_BLOCK" });
```

`isRequestMessage` 的无载荷页面请求 case 组（第 204-209 行）加入：

```ts
    case "PAUSE_SESSION":
    case "STOP_SESSION":
    case "GET_SESSION_STATUS":
    case "REANALYZE_VISIBLE":
    case "PARSE_CONTEXT_BLOCK":
    case "PARSE_HOVERED_BLOCK":
      return hasOnlyKeys(value, pageOnlyKeys) && hasPageContext(value);
```

`src/background/service-worker.ts`：

`sendPageCommand` 的 body 联合（第 258-261 行）加一项：

```ts
    body:
      | { type: "START_SESSION"; prefetchDetail?: true }
      | { type: "PARSE_SELECTION"; selectionText: string }
      | { type: "PARSE_CONTEXT_BLOCK" }
      | { type: "PARSE_HOVERED_BLOCK" },
```

`route()` 的 switch 里，`PARSE_CONTEXT_BLOCK` case（第 585-598 行）之后加（形态镜像 `PARSE_SELECTION`：支持冷启动，注入后原样转发，回 ACK；不查 `activeTabs`）：

```ts
        case "PARSE_HOVERED_BLOCK": {
          if (!trustedExtensionUi) return errorResponse(request.requestId, "UNSUPPORTED_PAGE");
          await inject(request.tabId);
          await chromeApi.tabs.sendMessage(request.tabId, request);
          return {
            version: MESSAGE_VERSION,
            requestId: request.requestId,
            type: "ACK",
            acknowledgedType: request.type,
          };
        }
```

- [ ] **Step 4: 补 SW route 测试**

`src/background/service-worker.test.ts` 的 `describe("service worker orchestration")` 内（`PARSE_CONTEXT_BLOCK` 相关测试之后）加。注意 `dispatch` 的默认 sender 是页面 tab，这里需要 popup sender（文件里 START_SESSION 测试已有同构造法，若已有常量则直接复用，不要重复定义）：

```ts
it("PARSE_HOVERED_BLOCK：可信 UI 触发时注入并原样转发到页面", async () => {
  const subject = chromeMock();
  registerServiceWorker(dependencies(), subject.api);
  const popupSender = {
    id: "extension-id",
    url: "chrome-extension://extension-id/src/popup/popup.html",
  };

  const response = await dispatch(
    subject.events.runtime.onMessage.listeners[0]!,
    pageRequest({ type: "PARSE_HOVERED_BLOCK" }),
    popupSender,
  );

  expect(response).toMatchObject({ type: "ACK", acknowledgedType: "PARSE_HOVERED_BLOCK" });
  expect(subject.events.scripting.executeScript).toHaveBeenCalledOnce();
  expect(subject.events.tabs.sendMessage).toHaveBeenCalledWith(
    7,
    expect.objectContaining({ type: "PARSE_HOVERED_BLOCK" }),
  );
});

it("PARSE_HOVERED_BLOCK：网页侧伪造请求被拒绝", async () => {
  const subject = chromeMock();
  registerServiceWorker(dependencies(), subject.api);

  const response = await dispatch(
    subject.events.runtime.onMessage.listeners[0]!,
    pageRequest({ type: "PARSE_HOVERED_BLOCK" }),
  );

  expect(response).toMatchObject({ type: "ERROR", error: { code: "UNSUPPORTED_PAGE" } });
  expect(subject.events.scripting.executeScript).not.toHaveBeenCalled();
});
```

- [ ] **Step 5: 运行两个测试文件确认通过**

Run: `npx vitest run src/shared/protocol.test.ts src/background/service-worker.test.ts`
Expected: PASS（全部，含既有用例）。

- [ ] **Step 6: Commit**

```bash
git add src/shared/protocol.ts src/shared/protocol.test.ts src/background/service-worker.ts src/background/service-worker.test.ts
git commit -m "feat: 协议新增 PARSE_HOVERED_BLOCK 请求并接入 SW 路由"
```

---

### Task 2: manifest `commands` 段（Alt+T）

**Files:**

- Modify: `manifest.json`
- Test: `src/shared/manifest.test.ts`

- [ ] **Step 1: 写失败的 manifest 测试**

`src/shared/manifest.test.ts` 的 describe 内加：

```ts
it("registers the hovered-block keyboard command", () => {
  expect(manifest.commands).toEqual({
    "parse-hovered-block": {
      suggested_key: { default: "Alt+T" },
      description: "解析鼠标悬停的段落",
    },
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/shared/manifest.test.ts`
Expected: FAIL —— `manifest.commands` 为 `undefined`。

- [ ] **Step 3: 修改 manifest.json**

在 `"action"` 键之后加：

```json
  "commands": {
    "parse-hovered-block": {
      "suggested_key": { "default": "Alt+T" },
      "description": "解析鼠标悬停的段落"
    }
  },
```

（`vite-plugin-web-extension` 会把该段原样写入 `dist/manifest.json`，无需改构建配置。）

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run src/shared/manifest.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add manifest.json src/shared/manifest.test.ts
git commit -m "feat: manifest 注册 Alt+T 快捷键命令 parse-hovered-block"
```

---

### Task 3: SessionController 轻量启动 + `parseHoveredBlock()`

**Files:**

- Modify: `src/content/session-controller.ts`
- Test: `src/content/session-controller.test.ts`

- [ ] **Step 1: 写失败的控制器测试**

`src/content/session-controller.test.ts` 的 `describe("SessionController")` 内加四个测试。既有 `harness(text, transport, overrides)` 会把 `<main><p>${text}</p></main>` 写入 body 并接受 `SessionControllerOptions` 覆盖；`hoverTarget` 是本任务新增的可注入选项：

```ts
it("快捷键冷启动：轻量启动只解析悬停段落，不做全页扫描", async () => {
  const scan = vi.fn(() => {
    throw new Error("lite start must not scan the document");
  });
  const subject = harness("Readers understand complex sentences.", new FakeTransport(), {
    scan,
    hoverTarget: () => document.querySelector("p"),
  });

  const error = await subject.controller.parseHoveredBlock();

  expect(error).toBeUndefined();
  expect(scan).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(subject.controller.status.ready).toBe(1));
  expect(subject.controller.status.state).toBe("running");
  expect(subject.replacements[0]!.shows).toBe(1);
});

it("轻量会话后完整 start() 补做全页扫描，且只补一次（升级路径）", async () => {
  const scan = vi.fn(() => [
    {
      id: "scanned-block",
      element: document.querySelector("p")! as HTMLElement,
      text: "Readers understand complex sentences.",
    },
  ]);
  const subject = harness("Readers understand complex sentences.", new FakeTransport(), {
    scan,
    hoverTarget: () => document.querySelector("p"),
  });

  await subject.controller.parseHoveredBlock();
  expect(scan).not.toHaveBeenCalled();

  await subject.controller.start();

  expect(scan).toHaveBeenCalledOnce();
  await subject.controller.start();
  expect(scan).toHaveBeenCalledOnce(); // scanned 标记：完整 start 只扫一次
});

it("悬停处没有安全段落时返回明确错误", async () => {
  const subject = harness("Readers understand complex sentences.", new FakeTransport(), {
    hoverTarget: () => null,
  });

  const error = await subject.controller.parseHoveredBlock();

  expect(error).toMatchObject({
    code: "UNSAFE_CONTENT_BLOCK",
    message: "未找到可解析的段落，请将鼠标悬停在正文段落上",
  });
});

it("同一段落重复触发快捷键幂等：不重复注册句子", async () => {
  const subject = harness("Readers understand complex sentences.", new FakeTransport(), {
    hoverTarget: () => document.querySelector("p"),
  });

  await subject.controller.parseHoveredBlock();
  await vi.waitFor(() => expect(subject.controller.status.ready).toBe(1));
  await subject.controller.parseHoveredBlock();

  expect(subject.controller.status.discovered).toBe(1);
});
```

说明：`parseHoveredBlock` 走 `nearestSafeBlock`（真实 DOM 判定，与既有 `parseContextBlock` 测试同机制），不吃 harness 的 `scan` 覆盖，所以第一个测试里 `scan` 抛错即可证明轻量启动没有扫描。文本必须 ≥20 字符且英文占优，`"Readers understand complex sentences."` 满足。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/content/session-controller.test.ts`
Expected: FAIL —— `subject.controller.parseHoveredBlock is not a function`（4 个新测试全挂，既有用例不受影响）。

- [ ] **Step 3: 实现控制器改动**

`src/content/session-controller.ts`：

1. `SessionControllerOptions`（`requestFeedback` 之后）加：

```ts
  /** 测试注入：返回当前鼠标悬停的最深元素；默认查询 CSS :hover 链。 */
  hoverTarget?: () => Element | null;
```

2. `CONTEXT_ERROR` 常量之后加：

```ts
const HOVER_ERROR: ExtensionError = {
  code: "UNSAFE_CONTENT_BLOCK",
  message: "未找到可解析的段落，请将鼠标悬停在正文段落上",
  retryable: false,
};
```

3. 类字段区（`selectedProfileId` 附近）加：

```ts
  private scanned = false;
  private readonly hoverTarget: () => Element | null;
```

构造函数里（`this.document` 赋值之后、`this.viewport = ...` 之前）：

```ts
this.hoverTarget =
  options.hoverTarget ??
  (() => {
    const chain = this.document.querySelectorAll(":hover");
    return chain.length > 0 ? (chain[chain.length - 1] ?? null) : null;
  });
```

4. 重写 `start()`（现第 210-235 行），把扫描部分抽成私有方法并支持升级：

```ts
  async start(options?: { prefetchDetail?: boolean; scan?: boolean }): Promise<void> {
    const wantScan = options?.scan !== false;
    if (this.state === "running") {
      // 轻量会话（快捷键冷启动）后用户点图标：补做全页扫描升级为完整会话。
      if (wantScan) {
        await this.performScan();
        this.emitStatus();
      }
      return;
    }
    if (this.state === "paused") {
      this.resume();
      if (wantScan) {
        await this.performScan();
        this.emitStatus();
      }
      return;
    }
    this.state = "running";
    if (options?.prefetchDetail === true) {
      this.prefetcher = new DetailPrefetcher({
        send: (item) => this.sendPrefetch(item.sentence, item.core),
        onChange: () => this.emitStatus(),
      });
    }
    this.document.addEventListener("contextmenu", this.recordContextTarget, true);
    this.document.addEventListener("syntax-detail-request", this.handleDetailEvent);
    this.document.addEventListener("syntax-reanalyze-request", this.handleCorrectionEvent);
    this.document.addEventListener("syntax-correction-request", this.handleExplicitCorrectionEvent);
    this.installMutationObserver();
    this.removeDisconnectListener = this.options.transport.onDisconnect?.(
      this.handleTransportDisconnect,
    );
    if (wantScan) await this.performScan();
    this.emitStatus();
  }

  private async performScan(): Promise<void> {
    if (this.scanned) return;
    this.scanned = true;
    const candidates = this.scan(this.document);
    await this.registerCandidates(candidates);
    this.viewport.observe(candidates);
  }
```

（对照原实现逐行核对：`running` 早退、`paused` 转 `resume`、监听器注册、prefetcher 创建都保持原语义，仅扫描位置改变。）

5. `stop()` 里（`this.state = "stopped";` 之后）加一行：

```ts
this.scanned = false;
```

6. `parseContextBlock()` 之后加新方法：

```ts
  async parseHoveredBlock(): Promise<ExtensionError | undefined> {
    // 快捷键可作为页面冷启动入口：轻量启动，不做全页扫描。
    if (this.state === "stopped") await this.start({ scan: false });
    const candidate = nearestSafeBlock(this.hoverTarget());
    if (candidate === null) return HOVER_ERROR;
    if (!this.blocks.has(candidate.id)) await this.registerCandidates([candidate]);
    this.queueVisibleBlock(candidate.id, true);
    return undefined;
  }
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run src/content/session-controller.test.ts`
Expected: PASS（新增 4 个 + 全部既有用例，特别是既有 start/stop/parseSelection/parseContextBlock 行为不回归）。

- [ ] **Step 5: Commit**

```bash
git add src/content/session-controller.ts src/content/session-controller.test.ts
git commit -m "feat: SessionController 支持轻量启动并解析悬停段落"
```

---

### Task 4: content 路由 + 进度胶囊失败提示

**Files:**

- Modify: `src/content/content-script.ts`
- Modify: `src/content/progress-pill.ts`
- Test: `src/content/progress-pill.test.ts`
- Test: `src/content/session-controller.test.ts`（`describe("ContentScriptRouter")` 部分）

- [ ] **Step 1: 写失败的 router 测试与 pill 测试**

`src/content/session-controller.test.ts` 的 `describe("ContentScriptRouter")` 内加：

```ts
it("PARSE_HOVERED_BLOCK 路由到控制器并回 ACK", async () => {
  const parseHoveredBlock = vi.fn(() => Promise.resolve(undefined));
  const router = new ContentScriptRouter({
    controllerFactory: () => ({
      documentId: "document-1",
      status: { state: "running" as const, discovered: 0, queued: 0, ready: 0, failed: 0 },
      start: vi.fn(() => Promise.resolve()),
      pause: vi.fn(),
      resume: vi.fn(),
      stop: vi.fn(),
      parseSelection: vi.fn(() => Promise.resolve(undefined)),
      parseContextBlock: vi.fn(() => Promise.resolve(undefined)),
      parseHoveredBlock,
      reanalyzeVisible: vi.fn(),
      switchProfile: vi.fn(),
    }),
    transportFactory: () => new FakeTransport(),
  });

  const response = await router.route({
    version: 1,
    requestId: "hover-1",
    type: "PARSE_HOVERED_BLOCK",
    tabId: 3,
    documentId: "document-1",
  });

  expect(parseHoveredBlock).toHaveBeenCalledOnce();
  expect(response).toMatchObject({ type: "ACK", acknowledgedType: "PARSE_HOVERED_BLOCK" });
});

it("PARSE_HOVERED_BLOCK 控制器报错时回 ERROR 响应", async () => {
  const router = new ContentScriptRouter({
    controllerFactory: () => ({
      documentId: "document-1",
      status: { state: "running" as const, discovered: 0, queued: 0, ready: 0, failed: 0 },
      start: vi.fn(() => Promise.resolve()),
      pause: vi.fn(),
      resume: vi.fn(),
      stop: vi.fn(),
      parseSelection: vi.fn(() => Promise.resolve(undefined)),
      parseContextBlock: vi.fn(() => Promise.resolve(undefined)),
      parseHoveredBlock: vi.fn(() =>
        Promise.resolve({
          code: "UNSAFE_CONTENT_BLOCK" as const,
          message: "未找到可解析的段落，请将鼠标悬停在正文段落上",
          retryable: false,
        }),
      ),
      reanalyzeVisible: vi.fn(),
      switchProfile: vi.fn(),
    }),
    transportFactory: () => new FakeTransport(),
  });

  const response = await router.route({
    version: 1,
    requestId: "hover-2",
    type: "PARSE_HOVERED_BLOCK",
    tabId: 3,
    documentId: "document-1",
  });

  expect(response).toMatchObject({
    type: "ERROR",
    error: { code: "UNSAFE_CONTENT_BLOCK" },
  });
});
```

同时给该 describe 里**所有既有的 controller stub 对象字面量**（`rejects malformed inbound…`、`控制器处理中抛异常…` 等约 4 处）补上一行 `parseHoveredBlock: vi.fn(() => Promise.resolve(undefined)),`（放在 `parseContextBlock` 之后），否则 `RoutedController` 接口收紧后 `npm run build` 类型报错。

`src/content/progress-pill.test.ts` 的 describe 内加（复用文件里已有的 `label()` / `spinnerVisible()` 辅助与 fake timers）：

```ts
it("notice 短暂展示提示文本后淡出", () => {
  pill.notice("未找到可解析的段落，请将鼠标悬停在正文段落上");

  expect(pill.host.isConnected).toBe(true);
  expect(label()).toBe("未找到可解析的段落，请将鼠标悬停在正文段落上");
  expect(spinnerVisible()).toBe(false);
  vi.advanceTimersByTime(2600);
  expect(pill.host.isConnected).toBe(false);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/content/session-controller.test.ts src/content/progress-pill.test.ts`
Expected: FAIL —— router 对 `PARSE_HOVERED_BLOCK` 落到 switch `default` 回 `invalidMessage`（Task 1 已让 `isRequestMessage` 放行该类型）；`pill.notice is not a function`。

- [ ] **Step 3: 实现**

`src/content/progress-pill.ts` 的 `update()` 之后加：

```ts
  /** 与会话状态无关的一次性提示（如快捷键未命中段落），短暂展示后淡出。 */
  notice(text: string): void {
    this.#cancelFade();
    this.#render(text, false);
    this.#fadeTimer = setTimeout(() => this.remove(), FADE_DELAY_MS);
  }
```

`src/content/content-script.ts`：

1. `RoutedController` 接口（`parseContextBlock` 之后）加：

```ts
  parseHoveredBlock(): Promise<ExtensionError | undefined>;
```

2. `ContentScriptRouter.route` 的 switch（`PARSE_CONTEXT_BLOCK` case 之后）加：

```ts
        case "PARSE_HOVERED_BLOCK": {
          const error = await controller.parseHoveredBlock();
          return error === undefined ? ack(request) : errorResponse(request.requestId, error);
        }
```

3. `installContentScript()` 里把 onMessage 监听改为在回包前接入失败提示（快捷键没有右键菜单那样的"已触发"反馈，未命中段落时必须就地告知；SW 侧对页面命令的响应是丢弃的，所以提示只能在 content 侧做）：

```ts
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void router.route(message).then((response) => {
    if (
      typeof message === "object" &&
      message !== null &&
      (message as { type?: unknown }).type === "PARSE_HOVERED_BLOCK" &&
      response.type === "ERROR"
    ) {
      pill.notice(response.error.message);
    }
    sendResponse(response);
  });
  return true;
});
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run src/content/session-controller.test.ts src/content/progress-pill.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/content/content-script.ts src/content/progress-pill.ts src/content/progress-pill.test.ts src/content/session-controller.test.ts
git commit -m "feat: content 路由 PARSE_HOVERED_BLOCK，未命中段落经进度胶囊提示"
```

---

### Task 5: SW `commands.onCommand` 监听（快捷键入口）

**Files:**

- Modify: `src/background/service-worker.ts`
- Test: `src/background/service-worker.test.ts`

- [ ] **Step 1: 写失败的测试**

`src/background/service-worker.test.ts`：

1. `chromeMock()` 里加命令事件。在 `const onContextClicked = ...` 之后加：

```ts
const onCommand = event<(command: string, tab?: chrome.tabs.Tab) => void>();
```

`api` 对象里（`contextMenus` 之后）加：

```ts
    commands: { onCommand },
```

2. describe 内加三个测试（放在右键菜单测试之后）：

```ts
it("快捷键在冷页面上注入并下发 PARSE_HOVERED_BLOCK", async () => {
  const subject = chromeMock();
  registerServiceWorker(dependencies(), subject.api);

  subject.events.commands.onCommand.listeners[0]!("parse-hovered-block", {
    id: 7,
  } as chrome.tabs.Tab);
  await vi.waitFor(() => expect(subject.events.tabs.sendMessage).toHaveBeenCalledOnce());

  expect(subject.events.scripting.executeScript).toHaveBeenCalledOnce();
  expect(subject.events.tabs.sendMessage).toHaveBeenCalledWith(
    7,
    expect.objectContaining({ type: "PARSE_HOVERED_BLOCK", tabId: 7 }),
  );
});

it("快捷键忽略未知命令名与无 tab 的事件", async () => {
  const subject = chromeMock();
  registerServiceWorker(dependencies(), subject.api);

  subject.events.commands.onCommand.listeners[0]!("other-command", { id: 7 } as chrome.tabs.Tab);
  subject.events.commands.onCommand.listeners[0]!("parse-hovered-block", undefined);
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(subject.events.scripting.executeScript).not.toHaveBeenCalled();
  expect(subject.events.tabs.sendMessage).not.toHaveBeenCalled();
});

it("快捷键在不可注入页面上静默失败", async () => {
  const subject = chromeMock();
  subject.events.scripting.executeScript.mockRejectedValueOnce(
    new Error("Cannot access a chrome:// URL"),
  );
  registerServiceWorker(dependencies(), subject.api);

  subject.events.commands.onCommand.listeners[0]!("parse-hovered-block", {
    id: 7,
  } as chrome.tabs.Tab);
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(subject.events.tabs.sendMessage).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/background/service-worker.test.ts`
Expected: FAIL —— `subject.events.commands.onCommand.listeners[0]` 为 `undefined`（监听器未注册）。

- [ ] **Step 3: 实现监听器**

`src/background/service-worker.ts`：

1. 常量区（`CONTEXT_INSTRUCTION` 之后）加：

```ts
const HOVERED_BLOCK_COMMAND = "parse-hovered-block";
```

2. `chromeApi.action?.onClicked.addListener(...)` 块之后加（流程镜像右键「解析选中文本」的冷启动分支）：

```ts
chromeApi.commands?.onCommand.addListener((command, tab) => {
  if (command !== HOVERED_BLOCK_COMMAND) return;
  const tabId = tab?.id;
  if (tabId === undefined) return;
  void (async () => {
    const documentId = activeTabs.get(tabId)?.documentId ?? generatedDocumentId(tabId);
    await inject(tabId);
    const profile = await dependencies.configRepository.getActiveProfile();
    activeTabs.set(tabId, {
      documentId,
      status: emptyStatus("running", profile?.id),
    });
    await sendPageCommand(tabId, documentId, { type: "PARSE_HOVERED_BLOCK" });
  })().catch(() => {
    // chrome:// 等不可注入页面：与其他入口一致，静默忽略。
  });
});
```

（`chrome.commands.onCommand` 回调签名 `(command: string, tab?: chrome.tabs.Tab)` 来自 `@types/chrome`，无需扩展类型。快捷键属用户手势，Chrome 会授予 `activeTab`，`inject` 与点图标同权。）

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run src/background/service-worker.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/background/service-worker.ts src/background/service-worker.test.ts
git commit -m "feat: SW 监听 Alt+T 命令，注入后下发悬停段落解析"
```

---

### Task 6: E2E 用例

Playwright 无法向 `chrome.commands` 发送真实扩展快捷键，所以 E2E 覆盖「命令下发之后」的完整链路：真实鼠标悬停（Chromium 里 `page.hover()` 产生真实 `:hover` 链）→ 经 `dispatchFromUi` 走 SW `route()` 的 `PARSE_HOVERED_BLOCK` case（与 onCommand 共享注入+转发逻辑）→ 内容脚本冷启动 → 只有悬停段落变卡片。onCommand 监听器本身已由 Task 5 单测覆盖。

**Files:**

- Test: `tests/e2e/extension.spec.ts`

- [ ] **Step 1: 确认 fixture 页面段落数**

Run: `grep -c "<p" tests/fixtures/pages/article.html`
Expected: ≥2。若 <2，下一步改用 `dynamic-article.html`（既有测试证明它视口内有 4 个可解析块），断言不变。

- [ ] **Step 2: 添加 E2E 测试**

`tests/e2e/extension.spec.ts` 末尾加（复用文件里已有的 `seedLocalProfile`、`openArticle`、`uiMessage`、`learningBlocks`、`requestCounter`）：

```ts
test("悬停段落经 PARSE_HOVERED_BLOCK 冷启动解析，其余段落保持原文", async ({ harness }) => {
  await seedLocalProfile(harness);
  const page = await openArticle(harness, "article.html");
  const tabId = await harness.tabIdFor(`${harness.pagesOrigin}/article.html`);
  const paragraphCount = await page.locator("p").count();
  expect(paragraphCount).toBeGreaterThan(1);

  await page.locator("p").first().hover();
  const response = await harness.dispatchFromUi(
    uiMessage("PARSE_HOVERED_BLOCK", { tabId, documentId: `e2e-doc-${++requestCounter}` }),
  );

  expect(response, JSON.stringify(response)).toMatchObject({ type: "ACK" });
  await expect(learningBlocks(page)).toHaveCount(1, { timeout: 20_000 });
  // 轻量启动不做全页扫描：其余段落原文可见。
  await expect(page.locator("p:visible")).toHaveCount(paragraphCount - 1);
});
```

- [ ] **Step 3: 运行 E2E 确认通过**

Run: `npx playwright test tests/e2e/extension.spec.ts -g "悬停段落"`
Expected: PASS（fixture 首次运行会先 `npm run build`，较慢属正常）。

若失败排查顺序：① `response` 不是 ACK → SW route case 或协议 guard 问题；② 卡片数 0 → 内容脚本 `:hover` 链为空（确认 hover 调用在 dispatch 之前）或 `nearestSafeBlock` 未命中（段落文本需 ≥20 字符且英文占优）；③ 卡片数 >1 → 轻量启动失效，检查 `start({ scan: false })`。

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/extension.spec.ts
git commit -m "test: E2E 覆盖悬停段落快捷键链路"
```

---

### Task 7: 文档 + 全量门禁

**Files:**

- Modify: `README.md`

- [ ] **Step 1: README 使用说明补快捷键**

`README.md` 「## 使用」一节，第 2 条之后插入一条（原 3-7 顺延重编号）：

```markdown
3. 或者不开整页学习：把鼠标悬停在某个段落上按 `Alt+T`（Mac：`Option+T`），只解析该段；快捷键可在 `chrome://extensions/shortcuts` 修改；
```

- [ ] **Step 2: 跑全量门禁**

Run:

```bash
npm test && npx playwright test && npm run lint && npm run format:check && npm run build
```

Expected: 全部通过；lint 保持基线（恰好 1 个既有错误，不允许新增）；format:check 无差异（若有差异先 `npm run format` 再重跑）。

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README 补充 Alt+T 悬停段落解析说明"
```

---

## Self-Review 记录

- **Spec 覆盖**：§1 触发链路 → Task 2 + Task 5；§2 协议 → Task 1；§3 控制器 → Task 3；§4 边界反馈 → Task 3（HOVER_ERROR）+ Task 4（pill.notice）+ Task 5（注入失败静默）；§5 测试 → 各任务 TDD 步骤 + Task 6 E2E + Task 7 门禁。无缺口。
- **类型一致性**：`parseHoveredBlock(): Promise<ExtensionError | undefined>` 在 Task 3（实现）、Task 4（接口与 stub）签名一致；`PARSE_HOVERED_BLOCK` 字符串在协议、SW、content、E2E 中一致；`HOVERED_BLOCK_COMMAND = "parse-hovered-block"` 与 manifest 命令名一致。
- **已知取舍**：SW onCommand 用 `emptyStatus("running")` 覆盖 activeTabs 状态，与既有右键选中文本分支完全一致（计数由 content 状态回传即刻修正）；升级路径不补建 DetailPrefetcher，与既有「运行中重复 START_SESSION 忽略 prefetchDetail」行为一致。
