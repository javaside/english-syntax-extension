// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatTurn } from "./bridge";
import { ChatPanel } from "./chat-panel";

const CONVERSATION = "pv-1:chat:1";

/**
 * 按接线时序开一个会话:bootstrap 的图标点击监听铸好 conversationId 后经 open 传入
 * (Task 4 评审钉死的 seam:conversationId 由 bootstrap 铸、面板只存)。
 */
function openPanel(summary = "Learners read books.", conversationId = CONVERSATION): ChatPanel {
  const panel = new ChatPanel();
  panel.open({ conversationId, sentenceId: "sentence-1", summary });
  return panel;
}

/** 走完一轮完整问答:用户问与模型答都落进面板历史。 */
function completeRound(panel: ChatPanel, question: string, answer: string): void {
  panel.appendUserTurn(question);
  panel.beginAssistantTurn(CONVERSATION);
  panel.completeAssistantTurn(CONVERSATION, answer);
}

function assistantBubbles(panel: ChatPanel): NodeListOf<HTMLElement> {
  return panel.host.querySelectorAll<HTMLElement>(".english-syntax-chat-message--assistant");
}

function inputOf(panel: ChatPanel): HTMLTextAreaElement {
  return panel.host.querySelector<HTMLTextAreaElement>("textarea")!;
}

function surfaceOf(panel: ChatPanel): HTMLElement {
  return panel.host.querySelector<HTMLElement>(".english-syntax-chat-panel")!;
}

/** preview.css 是 Kotlin 单独注入的(不进 bundle),happy-dom 不加载,只能按文本钉规则。 */
function readPreviewCss(): string {
  return readFileSync(join(process.cwd(), "src/main/resources/web/preview.css"), "utf8");
}

/** 取一条平坦规则的声明块(选择器首次出现处到匹配的 `}`);缺失返回空串。 */
function cssRuleBlock(css: string, selector: string): string {
  const start = css.indexOf(selector);
  if (start === -1) return "";
  const open = css.indexOf("{", start);
  if (open === -1) return "";
  const end = css.indexOf("}", open);
  return end === -1 ? "" : css.slice(open, end + 1);
}

describe("ChatPanel", () => {
  afterEach(() => {
    document.documentElement.innerHTML = "";
  });

  it("未开会话时 currentConversation 为 null；open 惰性挂载并显示锚定句摘要行", () => {
    const panel = new ChatPanel();
    expect(panel.currentConversation()).toBeNull();
    expect(panel.host.isConnected).toBe(false); // 惰性:构造不挂载

    panel.open({ conversationId: CONVERSATION, sentenceId: "sentence-1", summary: "Learners read books." });

    expect(panel.host.isConnected).toBe(true);
    // host 挂 document.documentElement:官方 updateDom 重写 body 带不走浮层。
    expect(panel.host.parentElement).toBe(document.documentElement);
    expect(panel.host.querySelector(".english-syntax-chat-summary")?.textContent).toBe(
      "Learners read books.",
    );
    // conversationId 由 open 传入(Task 4 seam),面板据此路由迟到的 CHAT_*。
    expect(panel.currentConversation()!.conversationId).toBe(CONVERSATION);
  });

  it("renderStreamedText 全量替换当前回答气泡,不是追加", () => {
    const panel = openPanel();
    panel.appendUserTurn("这句为什么这么译");
    panel.beginAssistantTurn(CONVERSATION);
    panel.renderStreamedText(CONVERSATION, "第一段:主谓宾结构。");
    panel.renderStreamedText(CONVERSATION, "第一段:主谓宾结构。第二段:修饰关系。");

    const bubbles = assistantBubbles(panel);
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]!.textContent).toBe("第一段:主谓宾结构。第二段:修饰关系。");
  });

  it("currentConversation 只带最近 6 个 ChatTurn 项(最近 3 组问答)", () => {
    const panel = openPanel();
    for (let round = 1; round <= 4; round += 1) {
      completeRound(panel, `问${round}`, `答${round}`);
    }

    const conversation = panel.currentConversation()!;
    expect(conversation.conversationId).toBe(CONVERSATION);
    // 8 项裁到最近 6 项,顺序保持提问先后
    expect(conversation.history.map((turn) => `${turn.role}:${turn.content}`)).toEqual([
      "user:问2",
      "assistant:答2",
      "user:问3",
      "assistant:答3",
      "user:问4",
      "assistant:答4",
    ]);
  });

  it("总字符超 8000 时从最旧项丢起,直到达标;恰 8000 一条不丢", () => {
    const panel = openPanel();
    const long = (tag: string) => `${tag}:${"字".repeat(1499)}`; // 每项恰 1500 字符
    for (let round = 1; round <= 4; round += 1) {
      completeRound(panel, long(`问${round}`), long(`答${round}`));
    }

    const overflow = panel.currentConversation()!;
    // 先裁到最近 6 项(9000 字符)→ 丢最旧的「问2」→ 5 项 7500 字符
    expect(overflow.history.map((turn) => turn.content.slice(0, 2))).toEqual([
      "答2",
      "问3",
      "答3",
      "问4",
      "答4",
    ]);
    expect(
      overflow.history.reduce((total: number, turn) => total + turn.content.length, 0),
    ).toBeLessThanOrEqual(8000);

    // 边界:4 项 × 2000 = 恰 8000,一条不丢(与 Kotlin parse 门同边界)
    const boundary = openPanel();
    completeRound(boundary, "甲".repeat(2000), "乙".repeat(2000));
    completeRound(boundary, "丙".repeat(2000), "丁".repeat(2000));
    const kept = boundary.currentConversation()!.history;
    expect(kept).toHaveLength(4);
    expect(kept.reduce((total: number, turn) => total + turn.content.length, 0)).toBe(8000);
  });

  it("currentConversation 不含已提交未回答的悬空用户轮,且返回副本", () => {
    const panel = openPanel();
    completeRound(panel, "问1", "答1");
    panel.appendUserTurn("问2"); // 本轮:由 CHAT_ASK 的 question 字段单独承载
    panel.beginAssistantTurn(CONVERSATION);

    const first = panel.currentConversation()!;
    expect(first.history.map((turn) => turn.content)).toEqual(["问1", "答1"]);

    // 调用方改动不得污染面板历史
    first.history[0]!.content = "污染";
    first.history.pop();
    expect(panel.currentConversation()!.history.map((turn) => turn.content)).toEqual([
      "问1",
      "答1",
    ]);
  });

  it("Enter 提交把 trim 后的输入交给 onSubmit 并清空输入框;Shift+Enter 换行不提交", () => {
    const panel = openPanel();
    const submitted = vi.fn();
    panel.onSubmit = submitted;
    const input = inputOf(panel);
    expect(input.getAttribute("maxlength")).toBe("2000");
    input.value = "  这句为什么这么译  ";

    const shiftEnter = new KeyboardEvent("keydown", {
      key: "Enter",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(shiftEnter);
    expect(submitted).not.toHaveBeenCalled();
    expect(shiftEnter.defaultPrevented).toBe(false);
    expect(input.value).toBe("  这句为什么这么译  ");

    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    input.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    expect(submitted).toHaveBeenCalledTimes(1);
    expect(submitted.mock.calls[0]).toEqual(["这句为什么这么译"]);
    expect(input.value).toBe("");
  });

  it("completeAssistantTurn 以缓冲答案校平气泡,解除输入禁用并把回答记入历史", () => {
    const panel = openPanel();
    panel.appendUserTurn("问1");
    panel.beginAssistantTurn(CONVERSATION);
    expect(inputOf(panel).disabled).toBe(true); // 发送中禁用

    panel.renderStreamedText(CONVERSATION, "流式前半");
    panel.completeAssistantTurn(CONVERSATION, "流式前半 + 缓冲补齐的尾片");

    expect(assistantBubbles(panel)[0]!.textContent).toBe("流式前半 + 缓冲补齐的尾片");
    expect(inputOf(panel).disabled).toBe(false);
    const expected: ChatTurn[] = [
      { role: "user", content: "问1" },
      { role: "assistant", content: "流式前半 + 缓冲补齐的尾片" },
    ];
    expect(panel.currentConversation()!.history).toEqual(expected);
  });

  it("缓冲路径不发分片:completeAssistantTurn 直接整段渲染回答气泡", () => {
    const panel = openPanel();
    panel.appendUserTurn("问1");
    panel.beginAssistantTurn(CONVERSATION);
    panel.completeAssistantTurn(CONVERSATION, "整段一次性出现的回答");

    expect(assistantBubbles(panel)).toHaveLength(1);
    expect(assistantBubbles(panel)[0]!.textContent).toBe("整段一次性出现的回答");
  });

  it("failAssistantTurn 渲染错误文案,撤销悬空用户轮并恢复输入", () => {
    const panel = openPanel();
    panel.appendUserTurn("问1");
    panel.beginAssistantTurn(CONVERSATION);

    panel.failAssistantTurn(CONVERSATION, "NETWORK_ERROR：网络请求失败");

    expect(panel.host.textContent).toContain("NETWORK_ERROR：网络请求失败");
    expect(panel.currentConversation()!.history).toEqual([]); // 失败轮不入历史
    expect(inputOf(panel).disabled).toBe(false);
  });

  it("failAssistantTurn 无 pending 轮也画错误气泡(原句失效路径),不污染历史", () => {
    // Kotlin 侧记录/core 缺失时发 CHAT_ERROR「原句已失效」——那时面板里可能没有任何
    // 进行中轮次,错误气泡仍要画出来,不能静默吞掉。
    const panel = openPanel();
    panel.failAssistantTurn(CONVERSATION, "原句已失效：请重新解析后再提问");

    expect(
      panel.host.querySelector(".english-syntax-chat-message--error")?.textContent,
    ).toContain("原句已失效");
    expect(panel.currentConversation()!.history).toEqual([]);
    expect(inputOf(panel).disabled).toBe(false);
  });

  it("REQUEST_CANCELLED 前缀渲染为中性提示而非红色错误,且撤销悬空用户轮", () => {
    // Task 3 移交:stop()/换代取消在飞的 chat 后,面板收到 REQUEST_CANCELLED 前缀的
    // CHAT_ERROR——那是用户主动取消的正常终态,不该被当成红色错误。
    const panel = openPanel();
    panel.appendUserTurn("问1");
    panel.beginAssistantTurn(CONVERSATION);

    panel.failAssistantTurn(CONVERSATION, "REQUEST_CANCELLED：Scheduled request was cancelled");

    const notice = panel.host.querySelector(".english-syntax-chat-message--notice");
    expect(notice).not.toBeNull();
    expect(notice!.textContent).toBe("本轮回答已取消，可重新提问");
    expect(notice!.getAttribute("title")).toBe("REQUEST_CANCELLED：Scheduled request was cancelled");
    expect(panel.host.querySelector(".english-syntax-chat-message--error")).toBeNull();
    expect(panel.currentConversation()!.history).toEqual([]);
    expect(inputOf(panel).disabled).toBe(false);
  });

  it("handleHostMessage 按 conversationId 路由 CHAT_* 三件套;旧会话 id 被忽略", () => {
    const panel = openPanel();
    panel.appendUserTurn("问1");
    panel.beginAssistantTurn(CONVERSATION);

    panel.handleHostMessage({
      version: 1,
      type: "CHAT_STREAM",
      previewId: "pv-1",
      generation: 0,
      conversationId: CONVERSATION,
      text: "流式回答",
    });
    expect(assistantBubbles(panel)[0]!.textContent).toBe("流式回答");

    panel.handleHostMessage({
      version: 1,
      type: "CHAT_RESULT",
      previewId: "pv-1",
      generation: 0,
      conversationId: CONVERSATION,
      answer: "完整回答",
    });
    expect(assistantBubbles(panel)).toHaveLength(1);
    expect(assistantBubbles(panel)[0]!.textContent).toBe("完整回答");
    const history = panel.currentConversation()!.history;
    expect(history).toEqual([
      { role: "user", content: "问1" },
      { role: "assistant", content: "完整回答" },
    ]);

    // 旧会话(换句前/面板重开前)的迟到错误到不了面板:conversationId 第二道防线。
    panel.handleHostMessage({
      version: 1,
      type: "CHAT_ERROR",
      previewId: "pv-1",
      generation: 0,
      conversationId: "pv-1:chat:0",
      message: "旧会话的迟到错误",
    });
    expect(panel.host.textContent).not.toContain("旧会话的迟到错误");
    expect(panel.currentConversation()!.history).toEqual(history);
  });

  it("换锚定句 open 重置会话:摘要行换新,旧 conversationId 的迟到事件被忽略", () => {
    const panel = openPanel();
    completeRound(panel, "问1", "答1");

    panel.open({
      conversationId: "pv-1:chat:2",
      sentenceId: "sentence-2",
      summary: "Writers practice.",
    });

    expect(panel.host.querySelector(".english-syntax-chat-summary")?.textContent).toBe(
      "Writers practice.",
    );
    panel.renderStreamedText(CONVERSATION, "旧会话的迟到流");
    panel.completeAssistantTurn(CONVERSATION, "旧会话的迟到答案");
    expect(panel.host.textContent).not.toContain("旧会话");

    const conversation = panel.currentConversation()!;
    expect(conversation.conversationId).toBe("pv-1:chat:2");
    expect(conversation.history).toEqual([]);
  });

  it("setConversationId 轮换会话 id:旧 id 的流式与收尾被忽略", () => {
    const panel = openPanel();
    panel.setConversationId("pv-1:chat:9");

    panel.beginAssistantTurn(CONVERSATION);
    panel.renderStreamedText(CONVERSATION, "旧 id 的流");
    panel.completeAssistantTurn(CONVERSATION, "旧 id 的答案");

    expect(assistantBubbles(panel)).toHaveLength(0);
    expect(panel.currentConversation()!.conversationId).toBe("pv-1:chat:9");
  });

  it("dispose 移除 host 并作废会话", () => {
    const panel = openPanel();
    completeRound(panel, "问1", "答1");

    panel.dispose();

    expect(panel.host.isConnected).toBe(false);
    expect(panel.currentConversation()).toBeNull();
  });

  it("收尾后的迟到流式分片不建新泡:无进行中轮次则忽略流文本", () => {
    const panel = openPanel();
    completeRound(panel, "问1", "答1"); // completeAssistantTurn 已清 #assistantBubble

    panel.renderStreamedText(CONVERSATION, "迟到的流式分片");

    const bubbles = assistantBubbles(panel);
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]!.textContent).toBe("答1");
    expect(panel.host.textContent).not.toContain("迟到的流式分片");
  });

  it("收起/展开切换 data-collapsed 与按钮文案;关闭按钮 dispose 面板并作废会话", () => {
    const panel = openPanel();
    const surface = surfaceOf(panel);
    // 按文案取按钮(头部现为 摘要|新对话|收起|关闭,位置序号不再稳定)。
    const buttonOf = (label: string): HTMLButtonElement | undefined =>
      [...panel.host.querySelectorAll<HTMLButtonElement>(".english-syntax-chat-header button")].find(
        (button) => button.textContent === label,
      );
    const collapse = buttonOf("收起");
    const close = buttonOf("关闭");
    expect(collapse).toBeDefined();
    expect(close).toBeDefined();

    collapse!.click();
    expect(surface.hasAttribute("data-collapsed")).toBe(true);
    expect(collapse!.textContent).toBe("展开");

    collapse!.click();
    expect(surface.hasAttribute("data-collapsed")).toBe(false);
    expect(collapse!.textContent).toBe("收起");

    close!.click();
    expect(panel.host.isConnected).toBe(false);
    expect(panel.currentConversation()).toBeNull();
  });

  // 面板样式活在 preview.css(Kotlin 单独注入,不进 bundle):定位体系与状态浮层
  // (right 12/bottom 12)错开、折叠隐藏、中性通知的视觉类都得按文本钉住——缺失的
  // 症状是单测全绿、真机浮层跑到屏幕外或与状态浮层同位重叠。
  it("preview.css 钉住浮层定位与折叠规则:fixed 右下、与状态浮层错开、可折叠", () => {
    const css = readPreviewCss();
    const panelBlock = cssRuleBlock(css, ".english-syntax-chat-panel {");
    expect(panelBlock).toMatch(/position:\s*fixed/);
    expect(panelBlock).toMatch(/bottom:\s*84px/);
    expect(panelBlock).not.toMatch(/bottom:\s*12px/); // 不与状态浮层(right 12/bottom 12)同位
    expect(panelBlock).toMatch(/z-index:\s*2147483647/);

    expect(css).toMatch(
      /\.english-syntax-chat-panel\[data-collapsed\][^{]*\{[^}]*display:\s*none/,
    );
    // REQUEST_CANCELLED 中性通知与红色错误是两个视觉类,混用会退回「取消当错误」。
    expect(css).toMatch(/\.english-syntax-chat-message--notice\s*\{/);
    expect(css).toMatch(/\.english-syntax-chat-message--error\s*\{/);
    // 深色主题:面板是写死浅色的浮层,不随主题换底会变成暗页上的白色补丁。
    expect(css).toMatch(/:root\[data-english-syntax-dark="true"\] \.english-syntax-chat-panel/);
  });

  // 2026-11-08 Chrome 真机反馈同源:面板固定右下且不可拖,读左上段落时视线往返很远。
  // 标题栏(pointerdown/move/up)拖动,位置落在 .english-syntax-chat-panel(fixed 元素;
  // host 是 0×0 挂载壳)的内联样式上,钳制在视口内,重开后保持。
  it("拖动标题栏移动面板:left/top 跟随、解除右下锚定、并钳制在视口内", () => {
    const panel = openPanel();
    const header = panel.host.querySelector(".english-syntax-chat-header")!;
    const surface = surfaceOf(panel);

    header.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, clientX: 100, clientY: 100 }),
    );
    document.dispatchEvent(new MouseEvent("pointermove", { clientX: 220, clientY: 160 }));
    document.dispatchEvent(new MouseEvent("pointerup", { clientX: 220, clientY: 160 }));

    expect(surface.style.left).toBe("120px");
    expect(surface.style.top).toBe("60px");
    expect(surface.style.right).toBe("auto");
    expect(surface.style.bottom).toBe("auto");

    // 拖出视口右下:钳制到「至少留一个可抓取的角」的边界内。
    header.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, clientX: 220, clientY: 160 }),
    );
    document.dispatchEvent(new MouseEvent("pointermove", { clientX: 9000, clientY: 9000 }));
    document.dispatchEvent(new MouseEvent("pointerup", { clientX: 9000, clientY: 9000 }));

    expect(surface.style.left).toBe(`${window.innerWidth - 120}px`);
    expect(surface.style.top).toBe(`${window.innerHeight - 80}px`);

    // 关闭后重开:面板回到用户拖到的位置,而不是回到默认右下。
    panel.dispose();
    panel.open({ conversationId: CONVERSATION, sentenceId: "sentence-2", summary: "另一句" });
    expect(surface.style.left).toBe(`${window.innerWidth - 120}px`);
    expect(surface.style.top).toBe(`${window.innerHeight - 80}px`);
  });

  it("拖动从按钮上起手时不生效(收起/关闭仍可点),未按住时 move 无副作用", () => {
    const panel = openPanel();
    const close = panel.host.querySelector(
      ".english-syntax-chat-header button:last-child",
    )!;
    const surface = surfaceOf(panel);

    close.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, clientX: 10, clientY: 10 }),
    );
    document.dispatchEvent(new MouseEvent("pointermove", { clientX: 300, clientY: 300 }));
    document.dispatchEvent(new MouseEvent("pointerup", { clientX: 300, clientY: 300 }));
    expect(surface.style.left).toBe("");

    // 没有按住标题栏的裸 move 不改位置。
    document.dispatchEvent(new MouseEvent("pointermove", { clientX: 400, clientY: 400 }));
    expect(surface.style.left).toBe("");
  });

  // 2026-11-09 Chrome 真机反馈同源:面板总在右下角,离正在读的句子太远。open 带 anchor
  // (点「问」图标的视口坐标)时,面板弹在锚点右下方 14px,视口钳制照旧;不带 anchor
  // 则保持既有位置语义。
  it("open 带 anchor:面板弹在锚点右下方,且覆盖此前的拖动落点", () => {
    const panel = openPanel();
    const surface = surfaceOf(panel);

    // 先拖到别处,再带 anchor 换句——应跳到锚点处,不是留在拖动落点。
    const header = panel.host.querySelector(".english-syntax-chat-header")!;
    header.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, clientX: 100, clientY: 100 }),
    );
    document.dispatchEvent(new MouseEvent("pointermove", { clientX: 500, clientY: 400 }));
    document.dispatchEvent(new MouseEvent("pointerup", { clientX: 500, clientY: 400 }));
    expect(surface.style.left).toBe("400px");

    panel.open({
      conversationId: "pv-1:chat:9",
      sentenceId: "sentence-9",
      summary: "锚点句",
      anchor: { x: 60, y: 30 },
    });

    expect(surface.style.left).toBe("74px");
    expect(surface.style.top).toBe("44px");
  });

  it("open 不带 anchor:位置不动(沿用拖动落点或默认右下)", () => {
    const panel = openPanel();
    const surface = surfaceOf(panel);
    expect(surface.style.left).toBe(""); // 默认 CSS 右下,无内联定位

    panel.open({ conversationId: "pv-1:chat:9", sentenceId: "sentence-9", summary: "无锚点" });
    expect(surface.style.left).toBe("");
  });

  // —— 重开恢复(2026-11-25 spec):关闭/换句后同句重开,bootstrap 用 restoreHistory
  //    把停靠的历史画回来;conversationId 每次新铸,快照取未裁剪原始历史。 ——

  it("restoreHistory 重画气泡并落历史;恢复会话指向新铸的 conversationId", () => {
    const panel = openPanel();
    completeRound(panel, "问1", "答1");
    completeRound(panel, "问2", "答2");

    // 模拟 bootstrap 重开时序:open 复位(带新 id)→ 恢复历史
    panel.open({ conversationId: "pv-1:chat:9", sentenceId: "sentence-1", summary: "Learners read books." });
    const restored: ChatTurn[] = [
      { role: "user", content: "问1" },
      { role: "assistant", content: "答1" },
      { role: "user", content: "问2" },
      { role: "assistant", content: "答2" },
    ];
    panel.restoreHistory(restored);

    const bubbles = [...panel.host.querySelectorAll<HTMLElement>(".english-syntax-chat-message")];
    expect(bubbles.map((bubble) => `${bubble.className}=${bubble.textContent}`)).toEqual([
      "english-syntax-chat-message english-syntax-chat-message--user=问1",
      "english-syntax-chat-message english-syntax-chat-message--assistant=答1",
      "english-syntax-chat-message english-syntax-chat-message--user=问2",
      "english-syntax-chat-message english-syntax-chat-message--assistant=答2",
    ]);
    const conversation = panel.currentConversation()!;
    expect(conversation.conversationId).toBe("pv-1:chat:9");
    expect(conversation.history).toEqual(restored);
    // 传入数组是副本:调用方改动不污染面板
    restored.push({ role: "user", content: "污染" });
    expect(panel.currentConversation()!.history).toHaveLength(4);
    // 恢复的会话无在飞轮:输入可用
    expect(inputOf(panel).disabled).toBe(false);
  });

  it("activeConversation 返回未裁剪历史副本(对照 currentConversation 裁剪);未开会话为 null", () => {
    const fresh = new ChatPanel();
    expect(fresh.activeConversation()).toBeNull();

    const panel = openPanel();
    for (let round = 1; round <= 4; round += 1) {
      completeRound(panel, `问${round}`, `答${round}`);
    }

    const active = panel.activeConversation()!;
    expect(active.sentenceId).toBe("sentence-1");
    expect(active.conversationId).toBe(CONVERSATION);
    // 8 项全量快照;请求视图(currentConversation)裁到最近 6 项
    expect(active.history.map((turn) => `${turn.role}:${turn.content}`)).toEqual([
      "user:问1",
      "assistant:答1",
      "user:问2",
      "assistant:答2",
      "user:问3",
      "assistant:答3",
      "user:问4",
      "assistant:答4",
    ]);
    expect(panel.currentConversation()!.history).toHaveLength(6);

    // 副本:改外层不污染面板
    active.history.pop();
    active.history[0]!.content = "污染";
    const reread = panel.activeConversation()!;
    expect(reread.history).toHaveLength(8);
    expect(reread.history[0]!.content).toBe("问1");
  });

  it("dispose 先触发 onClose 再清态(钩子里仍能拿到完整快照)", () => {
    const panel = openPanel();
    completeRound(panel, "问1", "答1");

    let snapshot: ReturnType<ChatPanel["activeConversation"]> = null;
    panel.onClose = () => {
      snapshot = panel.activeConversation();
    };
    panel.dispose();

    expect(snapshot).not.toBeNull();
    expect(snapshot!.sentenceId).toBe("sentence-1");
    expect(snapshot!.conversationId).toBe(CONVERSATION);
    expect(snapshot!.history.map((turn) => turn.content)).toEqual(["问1", "答1"]);
    // 既有口径不变:dispose 之后会话作废
    expect(panel.currentConversation()).toBeNull();
  });

  it("「新对话」按钮触发 onNewConversation;面板自身不清态,按钮起手不启动拖动", () => {
    const panel = openPanel();
    completeRound(panel, "问1", "答1");
    const fresh = vi.fn();
    panel.onNewConversation = fresh;

    const newChat = [...panel.host.querySelectorAll<HTMLButtonElement>(".english-syntax-chat-header button")].find(
      (button) => button.textContent === "新对话",
    )!;
    expect(newChat).toBeDefined();

    // 按钮起手不算拖(收起/关闭同款守卫):面板位置不动
    newChat.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 10, clientY: 10 }));
    document.dispatchEvent(new MouseEvent("pointermove", { clientX: 300, clientY: 300 }));
    document.dispatchEvent(new MouseEvent("pointerup", { clientX: 300, clientY: 300 }));
    expect(surfaceOf(panel).style.left).toBe("");

    newChat.click();
    expect(fresh).toHaveBeenCalledTimes(1);
    // 清态是 bootstrap 回调的职责(重铸 id + open 复位),面板不动自己的历史
    expect(panel.currentConversation()).not.toBeNull();
  });

  // —— 受限 markdown 渲染(2026-11-27 spec):assistant 气泡经 web/chat-markdown.ts
  //    渲染,user/error/notice 保持纯文本;流式逐片全量重渲,未闭合标记字面显示。 ——

  it("assistant 回答经受限 markdown 渲染:加粗成 strong,标记符不显示", () => {
    const panel = openPanel();
    panel.appendUserTurn("问1");
    panel.beginAssistantTurn(CONVERSATION);
    panel.completeAssistantTurn(CONVERSATION, "这是**加粗**的说明");

    const bubble = assistantBubbles(panel)[0]!;
    expect(bubble.querySelector("strong")!.textContent).toBe("加粗");
    expect(bubble.textContent).toContain("加粗");
    expect(bubble.textContent).not.toContain("**");
  });

  it("user 气泡不渲染 markdown:标记原样显示", () => {
    const panel = openPanel();
    panel.appendUserTurn("**不是粗体**");

    const userBubble = panel.host.querySelector<HTMLElement>(
      ".english-syntax-chat-message--user",
    )!;
    expect(userBubble.querySelector("strong")).toBeNull();
    expect(userBubble.textContent).toBe("**不是粗体**");
  });

  it("流式逐片全量重渲:未闭合的字面显示,闭合后成 strong", () => {
    const panel = openPanel();
    panel.appendUserTurn("问1");
    panel.beginAssistantTurn(CONVERSATION);

    panel.renderStreamedText(CONVERSATION, "生成中的**粗");
    const mid = assistantBubbles(panel)[0]!;
    expect(mid.querySelector("strong")).toBeNull();
    expect(mid.textContent).toContain("**粗");

    panel.renderStreamedText(CONVERSATION, "生成中的**粗体**完毕");
    const done = assistantBubbles(panel)[0]!;
    expect(done.querySelector("strong")!.textContent).toBe("粗体");
    expect(done.textContent).not.toContain("**");
  });

  it("restoreHistory 的 assistant 轮同样渲染 markdown,user 轮仍纯文本", () => {
    const panel = openPanel();
    panel.restoreHistory([
      { role: "user", content: "问1" },
      { role: "assistant", content: "带**标记**的回答" },
    ]);

    const bubbles = [
      ...panel.host.querySelectorAll<HTMLElement>(".english-syntax-chat-message"),
    ];
    expect(bubbles[1]!.querySelector("strong")!.textContent).toBe("标记");
    expect(bubbles[0]!.textContent).toBe("问1");
  });

  it("error 气泡不渲染 markdown:错误文案里的标记原样显示", () => {
    const panel = openPanel();
    panel.appendUserTurn("问1");
    panel.beginAssistantTurn(CONVERSATION);

    panel.failAssistantTurn(CONVERSATION, "NETWORK_ERROR：**失败**详情");

    const errorBubble = panel.host.querySelector<HTMLElement>(
      ".english-syntax-chat-message--error",
    )!;
    expect(errorBubble.querySelector("strong")).toBeNull();
    expect(errorBubble.textContent).toContain("**失败**");
  });

  // markdown 元素样式活在 preview.css(不进 bundle):缺失的症状是单测全绿、
  // 真机列表/代码块挤成一团——按文本钉住(亮/暗两套)。
  it("preview.css 钉住 assistant 气泡的 markdown 渲染规则(含暗色)", () => {
    const css = readPreviewCss();
    const assistantBlock = cssRuleBlock(css, ".english-syntax-chat-message--assistant {");
    expect(assistantBlock).toMatch(/white-space:\s*normal/);
    expect(assistantBlock).not.toMatch(/white-space:\s*pre-wrap/); // 换行改由 br 承担
    expect(css).toMatch(/\.english-syntax-chat-message--assistant\s+p\s*\{/);
    expect(css).toMatch(
      /\.english-syntax-chat-message--assistant\s+ul\s*,\s*\.english-syntax-chat-message--assistant\s+ol\s*\{/,
    );
    expect(css).toMatch(/\.english-syntax-chat-message--assistant\s+pre\s*\{/);
    expect(css).toMatch(/\.english-syntax-chat-message--assistant\s+blockquote\s*\{/);
    // 暗色主题:代码块底色与引用边框必须跟主题换,否则暗页上亮块刺眼。
    expect(css).toMatch(
      /:root\[data-english-syntax-dark="true"\]\s+\.english-syntax-chat-message--assistant\s+pre\s*,\s*:root\[data-english-syntax-dark="true"\]\s+\.english-syntax-chat-message--assistant\s+code\s*\{/,
    );
    expect(css).toMatch(
      /:root\[data-english-syntax-dark="true"\]\s+\.english-syntax-chat-message--assistant\s+blockquote\s*\{/,
    );
    // 暗色可读性:assistant 的浅色 color 字面值(#111)必须被暗色显式覆盖——
    // 暗色规则若只换背景不换字色,#111 落在 #374151 上几乎不可读。
    expect(css).toMatch(
      /:root\[data-english-syntax-dark="true"\]\s+\.english-syntax-chat-message--assistant\s*\{[^}]*color:\s*#e5e7eb/,
    );
  });
});
