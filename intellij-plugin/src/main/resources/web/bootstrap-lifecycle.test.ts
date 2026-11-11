// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 导入即执行 IIFE，把 __englishSyntaxInitialize / __englishSyntaxMessage 挂到 window。
// bootstrap 的模块级状态（state/previewHadCards/lastVisibleFingerprint 等）在同一进程内
// 跨用例共享，因此每个用例都重新 initialize() 来复位（previewHadCards 只在「先有卡、再清卡」
// 的判据里用到，RESTORE_ALL 分支会把它复位，详见用例）。
import { sendChatAsk, setChatPanel, type ChatPanelSeam } from "./bootstrap-entry";

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
    // 角色源文件改了但没重建 bundle 时，单测会绿、真实 JCEF 却仍回退为英文枚举与灰色。
    expect(bundle).toContain('FRAGMENT_HEAD: "片段主体"');
    expect(bundle).toContain('FRAGMENT_HEAD: "#0284c7"');
    expect(bundle).toContain('FRAGMENT_HEAD: "#38bdf8"');
    // 忘了 npm run bundle-web 的症状是「Kotlin 侧全绿、真机按快捷键毫无反应」。
    expect(bundle).toContain("PARSE_BLOCK");
    expect(bundle).toContain("__englishSyntaxParseHoveredBlock");
    // 「该段已解析」有两处判据：鼠标停在卡片里、以及停在已出过卡的原文上（卡片的兄弟节点）。
    // 少一处就会对同一段重复下发，页面永远停在「解析中」——而这两条判据都只活在 bundle 里。
    expect(bundle.match(/该段已解析/g) ?? []).toHaveLength(2);
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
  const hostMessage = () =>
    (window as unknown as Record<string, unknown>).__englishSyntaxMessage as (
      message: Record<string, unknown>,
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
    // 键集必须与 Kotlin 的 hasOnlyKeys 白名单逐字一致：多一个键整条消息就被丢掉，
    // 表现为「按快捷键毫无反应」而不是报错。
    expect(Object.keys(parsed[0]!).sort()).toEqual([
      "blockId",
      "generation",
      "previewId",
      "text",
      "type",
      "version",
    ]);
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

  it("同一段解析完再按：提示已解析、不重复下发，卡片仍点得动", async () => {
    // 用户 bug：「同一段，已经按过快捷键翻译好，再按的话就一直显示在翻译状态，
    // 原来翻译出来的句子也点击不了。」两处成因都钉在这条用例里：
    //  ① 卡片插在原文之后，原文是卡片的**兄弟**节点 —— 上一条用例的
    //     `closest([data-english-syntax-card])` 只拦得住「鼠标停在卡片里」，
    //     停在原文上照样放行 → 对同一段重复下发 PARSE_BLOCK，而 Kotlin 侧那段已全 READY，
    //     于是没有任何 CORE_RESULT 回来撤掉「解析中」竖条与浮层。
    //  ② 放行后 `renderer.registerBlock` 会清空该块的句子映射，卡片虽然还在 DOM 上、
    //     监听器也还在，但 `#showDetailLoading`/`#showDetailPanel` 查 `#sentences` 全部落空，
    //     点成分毫无反应。
    const para = document.createElement("p");
    para.textContent = "The service validates every response before returning anything.";
    document.body.append(para);

    initialize()("pv-again", 0, false);
    await flush();
    posted.length = 0;

    parseHovered()(para);
    await flush();
    expect(posted.filter((m) => m.type === "PARSE_BLOCK")).toHaveLength(1);
    const blockId = para.getAttribute("data-english-syntax-block")!;

    hostMessage()(coreResultMessage("pv-again", 0, blockId));
    await flush();
    expect(document.querySelector("[data-english-syntax-card]")).not.toBeNull();
    expect(para.hasAttribute("data-english-syntax-hidden")).toBe(true);

    // 跨过 400ms 去抖窗口：要证明拦住第二次的是「这段已出卡」判据，而不是去抖顺手挡掉。
    const later = Date.now() + 5_000;
    vi.spyOn(Date, "now").mockReturnValue(later);
    posted.length = 0;

    parseHovered()(para);
    await flush();

    expect(posted.filter((m) => m.type === "PARSE_BLOCK")).toHaveLength(0);
    expect(label()).toContain("该段已解析");
    // 卡片没被清掉，且渲染器的句子映射还在 —— 点成分要能发出 DETAIL_REQUEST，
    // 并就地插出「正在加载详解…」占位（占位正是需要 `#sentences` 命中才画得出来的那一步）。
    const component = document.querySelector<HTMLElement>(".english-syntax-component");
    expect(component).not.toBeNull();
    component!.click();
    await flush();

    expect(posted.filter((m) => m.type === "DETAIL_REQUEST")).toHaveLength(1);
    expect(document.querySelector(".english-syntax-detail-loading")).not.toBeNull();
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

describe("bootstrap-entry 追问对话接线", () => {
  const initialize = () =>
    (window as unknown as Record<string, unknown>).__englishSyntaxInitialize as (
      previewId: string,
      generation: number,
      autoScan?: boolean,
    ) => void;
  const hostMessage = () =>
    (window as unknown as Record<string, unknown>).__englishSyntaxMessage as (
      message: Record<string, unknown>,
    ) => void;

  /** 渲染出一张 core 成功卡（带追问图标），返回句 id 与图标元素。 */
  function renderOneSentence(previewId: string): { sentenceId: string; icon: HTMLElement } {
    const el = document.createElement("p");
    el.textContent = "The service validates every response before returning anything.";
    document.body.append(el);
    initialize()(previewId, 0, false);
    const blockId = el.getAttribute("data-english-syntax-block");
    if (blockId === null) throw new Error("scan did not assign a block id");
    hostMessage()(coreResultMessage(previewId, 0, blockId));
    const icon = document.querySelector<HTMLElement>(".english-syntax-chat-ask");
    if (icon === null) throw new Error("chat icon not rendered on core-success sentence");
    return { sentenceId: `s-${blockId}-0`, icon };
  }

  afterEach(() => {
    // chatPanel 是模块级 seam：不拆掉会让其它 describe 的 host 消息被这里的假面板吃掉。
    setChatPanel(null);
  });

  it("图标点击 → 打开面板回调 {sentenceId, anchor}，不发任何桥消息", async () => {
    const opens: Array<{ conversationId: string; sentenceId: string; anchor: { x: number; y: number } }> = [];
    const panel: ChatPanelSeam = {
      open: (request) => {
        opens.push(request);
      },
      handleHostMessage: () => {},
    };
    setChatPanel(panel);
    const { sentenceId, icon } = renderOneSentence("pv-chat");
    posted.length = 0;

    icon.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 150, clientY: 90 }));
    await flush();

    expect(opens).toHaveLength(1);
    expect(opens[0]!.sentenceId).toBe(sentenceId);
    expect(opens[0]!.anchor).toEqual({ x: 150, y: 90 });
    // conversationId 由 bootstrap 的模块级计数器铸造（`${previewId}:chat:${n}`），open 时传入。
    expect(opens[0]!.conversationId).toMatch(/^pv-chat:chat:\d+$/);
    // B3：点击时没有合法 question（Kotlin parseChatAsk 会拒收），CHAT_ASK 只能由面板 submit 驱动。
    expect(posted.filter((m) => m.type === "CHAT_ASK")).toHaveLength(0);
    expect(posted).toHaveLength(0);
  });

  it("再点一次图标 → 计数器递增出新的 conversationId", async () => {
    const opens: Array<{ conversationId: string }> = [];
    setChatPanel({
      open: (request) => {
        opens.push({ conversationId: request.conversationId });
      },
      handleHostMessage: () => {},
    });
    const { icon } = renderOneSentence("pv-chat-again");

    icon.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 1, clientY: 2 }));
    icon.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 3, clientY: 4 }));
    await flush();

    expect(opens).toHaveLength(2);
    expect(opens[0]!.conversationId).toMatch(/^pv-chat-again:chat:\d+$/);
    expect(opens[1]!.conversationId).not.toBe(opens[0]!.conversationId);
  });

  it("未注册面板时点击图标是无害 no-op", async () => {
    const { icon } = renderOneSentence("pv-nopanel");
    posted.length = 0;

    expect(() => icon.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 1, clientY: 2 }))).not.toThrow();
    await flush();

    expect(posted).toHaveLength(0);
  });

  it("面板 submit（sendChatAsk）→ 构造并发送 CHAT_ASK；空问题不发", async () => {
    initialize()("pv-ask", 0, false);

    const ok = sendChatAsk({
      conversationId: "pv-ask:chat:1",
      sentenceId: "s-b1-0",
      question: "  为什么这里是系表结构？  ",
      history: [
        { role: "user", content: "第一问" },
        { role: "assistant", content: "第一答" },
      ],
    });
    expect(ok).toBe(true);

    const ask = posted.find((m) => m.type === "CHAT_ASK");
    expect(ask).toBeDefined();
    // 键集必须与 Kotlin hasOnlyKeys 白名单逐字一致：多一个键整条消息就被静默丢弃。
    expect(Object.keys(ask!).sort()).toEqual([
      "conversationId",
      "generation",
      "history",
      "previewId",
      "question",
      "sentenceId",
      "type",
      "version",
    ]);
    expect(ask!.version).toBe(1);
    expect(ask!.previewId).toBe("pv-ask");
    expect(ask!.generation).toBe(0);
    expect(ask!.conversationId).toBe("pv-ask:chat:1");
    expect(ask!.sentenceId).toBe("s-b1-0");
    // question 在发送侧先 trim（与 Kotlin 门同口径）。
    expect(ask!.question).toBe("为什么这里是系表结构？");
    expect(ask!.history).toEqual([
      { role: "user", content: "第一问" },
      { role: "assistant", content: "第一答" },
    ]);

    // 空白问题：直接不发（面板 submit 的防呆回退）。
    expect(
      sendChatAsk({ conversationId: "pv-ask:chat:1", sentenceId: "s-b1-0", question: "   ", history: [] }),
    ).toBe(false);
    expect(posted.filter((m) => m.type === "CHAT_ASK")).toHaveLength(1);
  });

  it("CHAT_STREAM / CHAT_RESULT / CHAT_ERROR → 原样转发面板缝；旧 generation 到不了面板", async () => {
    const received: string[] = [];
    const messages: unknown[] = [];
    setChatPanel({
      open: () => {},
      handleHostMessage: (message) => {
        received.push(message.type);
        messages.push(message);
      },
    });
    initialize()("pv-host", 3, false);

    hostMessage()({
      version: 1, type: "CHAT_STREAM", previewId: "pv-host", generation: 3,
      conversationId: "c1", text: "部分回答",
    });
    hostMessage()({
      version: 1, type: "CHAT_RESULT", previewId: "pv-host", generation: 3,
      conversationId: "c1", answer: "完整回答",
    });
    hostMessage()({
      version: 1, type: "CHAT_ERROR", previewId: "pv-host", generation: 3,
      conversationId: "c1", message: "REQUEST_CANCELLED：请求已取消",
    });
    await flush();

    expect(received).toEqual(["CHAT_STREAM", "CHAT_RESULT", "CHAT_ERROR"]);
    // 原样转发：与 parseHostMessage 的产物逐字段一致。REQUEST_CANCELLED 前缀渲染成中性
    // 文案是 Task 5 面板的事，接线层不得改写。
    expect(messages[0]).toEqual({
      version: 1, type: "CHAT_STREAM", previewId: "pv-host", generation: 3,
      conversationId: "c1", text: "部分回答",
    });
    expect(messages[1]).toEqual({
      version: 1, type: "CHAT_RESULT", previewId: "pv-host", generation: 3,
      conversationId: "c1", answer: "完整回答",
    });
    expect(messages[2]).toEqual({
      version: 1, type: "CHAT_ERROR", previewId: "pv-host", generation: 3,
      conversationId: "c1", message: "REQUEST_CANCELLED：请求已取消",
    });

    // 旧代次的迟到消息在 parseHostMessage 的 generation 等值门就被丢弃（第一道防线）。
    hostMessage()({
      version: 1, type: "CHAT_STREAM", previewId: "pv-host", generation: 2,
      conversationId: "c1", text: "旧代次",
    });
    await flush();
    expect(received).toHaveLength(3);
  });
});
