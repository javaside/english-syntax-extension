// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 导入即执行 IIFE，把 __englishSyntaxInitialize / __englishSyntaxMessage 挂到 window。
// bootstrap 的模块级状态（state/previewHadCards/lastVisibleFingerprint 等）在同一进程内
// 跨用例共享，因此每个用例都重新 initialize() 来复位（previewHadCards 只在「先有卡、再清卡」
// 的判据里用到，RESTORE_ALL 分支会把它复位，详见用例）。
import "./bootstrap-entry";

interface Posted {
  type: string;
  [key: string]: unknown;
}

const posted: Posted[] = [];

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function coreResultMessage(previewId: string, generation: number, blockId: string): Record<string, unknown> {
  return {
    version: 1,
    type: "CORE_RESULT",
    previewId,
    generation,
    sentenceId: `s-${blockId}-0`,
    blockId,
    analysisJson: JSON.stringify({
      sentenceId: `s-${blockId}-0`,
      components: [
        { startToken: 0, endToken: 1, role: "SUBJECT", translation: "该服务", text: "The service" },
      ],
    }),
    tokensJson: JSON.stringify([
      { id: 0, text: "The", leadingWhitespace: "", punctuation: false },
      { id: 1, text: "service", leadingWhitespace: " ", punctuation: false },
    ]),
  };
}

function hostPost(text: string): void {
  posted.push(JSON.parse(text) as Posted);
}

beforeEach(() => {
  document.body.replaceChildren();
  posted.length = 0;
  // bootstrap 在注入阶段才建 EnglishSyntaxHost，测试里先注入，让 postToHost 可捕获。
  (window as unknown as Record<string, unknown>).EnglishSyntaxHost = { post: hostPost };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("bootstrap-entry 停止回归", () => {
  it("committed JCEF bundle contains the current core token protocol", () => {
    const bundlePath = join(process.cwd(), "src/main/resources/web/bundle.js");
    const bundle = readFileSync(bundlePath, "utf8");

    expect(bundle).toContain("tokensJson");
    expect(bundle).toContain("english-syntax-punctuation");
    // 忘了 npm run bundle-web 的症状是「Kotlin 侧全绿、真机按快捷键毫无反应」。
    expect(bundle).toContain("PARSE_BLOCK");
    expect(bundle).toContain("__englishSyntaxParseHoveredBlock");
  });

  it("RESTORE_ALL 清卡后不再把清卡误判成官方重渲染、也不重新亮出进度浮层", async () => {
    // 预置一个可被扫描的英文段。
    const el = document.createElement("p");
    el.id = "p1";
    el.textContent = "The service validates every response before returning anything.";
    document.body.append(el);

    const initialize = (
      window as unknown as Record<string, unknown>
    ).__englishSyntaxInitialize as (previewId: string, generation: number) => void;
    const hostMessage = (
      window as unknown as Record<string, unknown>
    ).__englishSyntaxMessage as (message: Record<string, unknown>) => void;

    initialize("p1", 0);
    await flush();

    // 首批上报里应有 VISIBLE_BLOCKS；从中取真实 blockId 供 CORE_RESULT 命中渲染。
    const blocksMessage = posted.find((m) => m.type === "VISIBLE_BLOCKS");
    expect(blocksMessage).toBeDefined();
    const blocks = (blocksMessage as { blocks?: Array<{ blockId: string }> }).blocks ?? [];
    expect(blocks.length).toBeGreaterThan(0);
    const blockId = blocks[0]!.blockId;
    posted.length = 0;

    // 注入一条 CORE_RESULT 渲染出卡片：这会让 MutationObserver 里 trackPreviewRendered()
    // 把「有卡片」基线置为 true（previewHadCards = true）。
    hostMessage(coreResultMessage("p1", 0, blockId));
    await flush();
    expect(document.querySelector("[data-english-syntax-card]")).not.toBeNull();

    // 清空已发消息，只关注 RESTORE_ALL 之后的动作。
    posted.length = 0;

    // 用户点「停止并恢复原文」：Kotlin 发 RESTORE_ALL，JS 清掉卡片。
    hostMessage({ version: 1, type: "RESTORE_ALL", previewId: "p1", generation: 0 });
    await flush();

    // 关键回归断言：
    //  1) 我们主动清卡引发的 DOM 变更**不应**被上报为 PREVIEW_RENDERED（官方重渲染信号）。
    //  2) 进度浮层应保持隐藏（不在 RESTORE_ALL 后又 setStatus「正在解析」）。
    expect(posted.some((m) => m.type === "PREVIEW_RENDERED")).toBe(false);

    const status = document.getElementById("english-syntax-status");
    expect(status?.hidden ?? true).toBe(true);
  });
});

describe("bootstrap-entry 手动扫描模式", () => {
  it("autoScan=false 时只注册不上报，浮层也不亮", async () => {
    const el = document.createElement("p");
    el.textContent = "The service validates every response before returning anything.";
    document.body.append(el);

    const initialize = (window as unknown as Record<string, unknown>)
      .__englishSyntaxInitialize as (previewId: string, generation: number, autoScan?: boolean) => void;

    initialize("pv-manual", 0, false);
    await flush();

    expect(posted.some((m) => m.type === "VISIBLE_BLOCKS")).toBe(false);
    const status = document.getElementById("english-syntax-status");
    expect(status?.hidden ?? true).toBe(true);
  });

  it("autoScan 省略时仍按整篇模式上报（既有调用方不受影响）", async () => {
    const el = document.createElement("p");
    el.textContent = "The service validates every response before returning anything.";
    document.body.append(el);

    const initialize = (window as unknown as Record<string, unknown>)
      .__englishSyntaxInitialize as (previewId: string, generation: number, autoScan?: boolean) => void;

    initialize("pv-default", 0);
    await flush();

    expect(posted.some((m) => m.type === "VISIBLE_BLOCKS")).toBe(true);
  });

  it("上报的块全部出结果后浮层显示完成", async () => {
    // requestedBlocks 集合替换 reportedBlockCount 的回归：完成判定不能因为
    // settledBlocks 里残留上一轮的块而提前或永不满足。
    const el = document.createElement("p");
    el.textContent = "The service validates every response before returning anything.";
    document.body.append(el);

    const initialize = (window as unknown as Record<string, unknown>)
      .__englishSyntaxInitialize as (previewId: string, generation: number, autoScan?: boolean) => void;
    const hostMessage = (window as unknown as Record<string, unknown>)
      .__englishSyntaxMessage as (message: Record<string, unknown>) => void;

    initialize("pv-complete", 0, true);
    await flush();

    const blocksMessage = posted.find((m) => m.type === "VISIBLE_BLOCKS");
    expect(blocksMessage).toBeDefined();
    const blocks = (blocksMessage as { blocks?: Array<{ blockId: string }> }).blocks ?? [];
    expect(blocks).toHaveLength(1);

    hostMessage(coreResultMessage("pv-complete", 0, blocks[0]!.blockId));
    await flush();

    const label = document.querySelector(".english-syntax-status-label")?.textContent ?? "";
    expect(label).toContain("完成");
  });
});

describe("bootstrap-entry 按段解析", () => {
  const initialize = () =>
    (window as unknown as Record<string, unknown>).__englishSyntaxInitialize as (
      previewId: string,
      generation: number,
      autoScan?: boolean,
    ) => void;
  const parseHovered = () =>
    (window as unknown as Record<string, unknown>).__englishSyntaxParseHoveredBlock as (
      target?: Element | null,
    ) => void;
  const label = (): string =>
    document.querySelector(".english-syntax-status-label")?.textContent ?? "";

  it("只发一条单块 PARSE_BLOCK，且不上报整篇", async () => {
    const para = document.createElement("p");
    // 故意很短：显式手势不受自动扫描的 20 字符门槛限制。
    para.textContent = "Short.";
    const other = document.createElement("p");
    other.textContent = "Another paragraph long enough for the auto scanner to pick it up.";
    document.body.append(para, other);

    initialize()("pv-hover", 0, false);
    await flush();
    posted.length = 0;

    parseHovered()(para);
    await flush();

    const parsed = posted.filter((m) => m.type === "PARSE_BLOCK");
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.text).toBe("Short.");
    expect(parsed[0]!.blockId).toBe(para.getAttribute("data-english-syntax-block"));
    expect(posted.some((m) => m.type === "VISIBLE_BLOCKS")).toBe(false);
  });

  it("同一段 400ms 内重复触发只发一条", async () => {
    // 离屏渲染模式下同一次按键可能既到 IDE Action 又到 CEF，两条通道都会走到这里。
    const para = document.createElement("p");
    para.textContent = "Debounced paragraph text.";
    document.body.append(para);

    initialize()("pv-debounce", 0, false);
    await flush();
    posted.length = 0;

    parseHovered()(para);
    parseHovered()(para);
    await flush();

    expect(posted.filter((m) => m.type === "PARSE_BLOCK")).toHaveLength(1);
  });

  it("悬停不在正文上时提示且不发消息", async () => {
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.textContent = "const answer = 1;";
    pre.append(code);
    document.body.append(pre);

    initialize()("pv-miss", 0, false);
    await flush();
    posted.length = 0;

    parseHovered()(code);
    await flush();

    expect(posted.some((m) => m.type === "PARSE_BLOCK")).toBe(false);
    expect(label()).toContain("未找到");
  });

  it("悬停在已渲染的卡片上时提示该段已解析", async () => {
    const card = document.createElement("div");
    card.setAttribute("data-english-syntax-card", "true");
    const inner = document.createElement("span");
    inner.textContent = "Rendered card text.";
    card.append(inner);
    document.body.append(card);

    initialize()("pv-card", 0, false);
    await flush();
    posted.length = 0;

    parseHovered()(inner);
    await flush();

    expect(posted.some((m) => m.type === "PARSE_BLOCK")).toBe(false);
    expect(label()).toContain("该段已解析");
  });

  it("keydown 兼底逐位匹配修饰键，并随 setHotkey 改键", async () => {
    initialize()("pv-keyboard", 0, false);
    await flush();

    const setHotkey = (window as unknown as Record<string, unknown>).__englishSyntaxSetHotkey as (
      descriptor: unknown,
    ) => void;
    const clearLabel = (): void => {
      const node = document.querySelector(".english-syntax-status-label");
      if (node !== null) node.textContent = "";
    };
    const press = (init: KeyboardEventInit): void => {
      document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
    };

    // 修饰键必须逐一相等：Alt+Shift+T 不得触发绑定为 Alt+T 的入口。
    clearLabel();
    press({ code: "KeyT", altKey: true, shiftKey: true });
    await flush();
    expect(label()).toBe("");

    // 默认 Alt+T 触发。happy-dom 不实现 :hover，悬停查询取空 → 走「未找到」分支，
    // 这已足以证明入口被调用（用 event.code 而非 event.key：macOS 上 ⌥T 的 key 是 "†"）。
    press({ code: "KeyT", altKey: true });
    await flush();
    expect(label()).toContain("未找到");

    setHotkey({ code: "KeyJ", altKey: false, ctrlKey: true, shiftKey: false, metaKey: false });

    clearLabel();
    press({ code: "KeyT", altKey: true });
    await flush();
    expect(label()).toBe("");

    press({ code: "KeyJ", ctrlKey: true });
    await flush();
    expect(label()).toContain("未找到");

    // 显式 null = keymap 里没有可下发的绑定（两段式 chord / F7 之类）→ 关掉兼底监听。
    // 不能退回默认 Alt+T：那是用户没绑的幻影键位，按下去还会 preventDefault。
    setHotkey(null);
    clearLabel();
    press({ code: "KeyJ", ctrlKey: true });
    await flush();
    expect(label()).toBe("");
    press({ code: "KeyT", altKey: true });
    await flush();
    expect(label()).toBe("");

    // 复位：hotkey 是模块级状态，跨用例共享。
    setHotkey({ code: "KeyT", altKey: true, ctrlKey: false, shiftKey: false, metaKey: false });
  });
});
