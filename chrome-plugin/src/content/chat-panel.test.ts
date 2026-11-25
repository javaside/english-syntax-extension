// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatTurn } from "../shared/protocol";
import { ChatPanel } from "./chat-panel";

const CONVERSATION = "document-1:chat:1";

/** 面板按控制器(Task 6)的既定时序开一个会话:open → setConversationId。 */
function openPanel(summary = "Learners read books."): ChatPanel {
  const panel = new ChatPanel();
  panel.open({ sentenceId: "sentence-1", summary });
  panel.setConversationId(CONVERSATION);
  return panel;
}

/** 走完一轮完整问答:用户问与模型答都落进面板历史。 */
function completeRound(panel: ChatPanel, question: string, answer: string): void {
  panel.appendUserTurn(question);
  panel.beginAssistantTurn(CONVERSATION);
  panel.completeAssistantTurn(CONVERSATION, answer);
}

function assistantBubbles(panel: ChatPanel): NodeListOf<HTMLElement> {
  return panel.host.shadowRoot!.querySelectorAll<HTMLElement>(".message.assistant");
}

function inputOf(panel: ChatPanel): HTMLTextAreaElement {
  return panel.host.shadowRoot!.querySelector<HTMLTextAreaElement>("textarea")!;
}

describe("ChatPanel", () => {
  afterEach(() => {
    document.documentElement.innerHTML = "";
  });

  it("未开会话时 currentConversation 为 null；open 惰性挂载并显示锚定句摘要行", () => {
    const panel = new ChatPanel();
    expect(panel.currentConversation()).toBeNull();
    expect(panel.host.isConnected).toBe(false); // 惰性:构造不挂载

    panel.open({ sentenceId: "sentence-1", summary: "Learners read books." });

    expect(panel.host.isConnected).toBe(true);
    expect(panel.host.shadowRoot!.querySelector(".summary")?.textContent).toBe(
      "Learners read books.",
    );
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

    // 边界:4 项 × 2000 = 恰 8000,一条不丢(与 SW 兜底同边界)
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

    expect(panel.host.shadowRoot!.textContent).toContain("NETWORK_ERROR：网络请求失败");
    expect(panel.currentConversation()!.history).toEqual([]); // 失败轮不入历史
    expect(inputOf(panel).disabled).toBe(false);
  });

  it("换锚定句 open 重置会话:摘要行换新,旧 conversationId 的迟到事件被忽略", () => {
    const panel = openPanel();
    completeRound(panel, "问1", "答1");

    panel.open({ sentenceId: "sentence-2", summary: "Writers practice." });
    panel.setConversationId("document-1:chat:2");

    expect(panel.host.shadowRoot!.querySelector(".summary")?.textContent).toBe("Writers practice.");
    panel.renderStreamedText(CONVERSATION, "旧会话的迟到流");
    panel.completeAssistantTurn(CONVERSATION, "旧会话的迟到答案");
    expect(panel.host.shadowRoot!.textContent).not.toContain("旧会话");

    const conversation = panel.currentConversation()!;
    expect(conversation.conversationId).toBe("document-1:chat:2");
    expect(conversation.history).toEqual([]);
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
    expect(panel.host.shadowRoot!.textContent).not.toContain("迟到的流式分片");
  });

  it("锚点与 diagnosis-panel(bottom 64px)错开,不与其同位精确重叠", () => {
    const panel = new ChatPanel();
    const style = panel.host.shadowRoot!.querySelector("style")!.textContent ?? "";

    expect(style).toContain("bottom: 84px");
    expect(style).not.toContain("bottom: 64px");
  });

  // 2026-11-08 真机反馈:面板固定右下且不可拖,读左上段落时视线往返很远。
  // 标题栏(pointerdown/move/up)拖动,位置落在 .panel(fixed 元素;host 是 0×0 壳)
  // 的内联样式上,钳制在视口内,重开后保持。
  it("拖动标题栏移动面板:left/top 跟随、解除右下锚定、并钳制在视口内", () => {
    const panel = openPanel();
    const header = panel.host.shadowRoot!.querySelector(".header")!;
    const surface = panel.host.shadowRoot!.querySelector<HTMLElement>(".panel")!;

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
    panel.open({ sentenceId: "sentence-2", summary: "另一句" });
    expect(surface.style.left).toBe(`${window.innerWidth - 120}px`);
    expect(surface.style.top).toBe(`${window.innerHeight - 80}px`);
  });

  it("拖动从按钮上起手时不生效(收起/关闭仍可点),未按住时 move 无副作用", () => {
    const panel = openPanel();
    const close = panel.host.shadowRoot!.querySelector(".header button:last-child")!;
    const surface = panel.host.shadowRoot!.querySelector<HTMLElement>(".panel")!;

    close.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 10, clientY: 10 }));
    document.dispatchEvent(new MouseEvent("pointermove", { clientX: 300, clientY: 300 }));
    document.dispatchEvent(new MouseEvent("pointerup", { clientX: 300, clientY: 300 }));
    expect(surface.style.left).toBe("");

    // 没有按住标题栏的裸 move 不改位置。
    document.dispatchEvent(new MouseEvent("pointermove", { clientX: 400, clientY: 400 }));
    expect(surface.style.left).toBe("");
  });

  // 2026-11-09 真机反馈:面板总在右下角,离正在读的句子太远。open 带 anchor
  // (点击「问」图标的视口坐标)时,面板弹在锚点右下方 14px,视口钳制照旧;
  // 不带 anchor(测试桩/无锚点打开)保持既有位置语义。
  it("open 带 anchor:面板弹在锚点右下方,且覆盖此前的拖动落点", () => {
    const panel = openPanel();
    const surface = panel.host.shadowRoot!.querySelector<HTMLElement>(".panel")!;

    // 先拖到别处,再带 anchor 换句——应跳到锚点处,不是留在拖动落点。
    const header = panel.host.shadowRoot!.querySelector(".header")!;
    header.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, clientX: 100, clientY: 100 }),
    );
    document.dispatchEvent(new MouseEvent("pointermove", { clientX: 500, clientY: 400 }));
    document.dispatchEvent(new MouseEvent("pointerup", { clientX: 500, clientY: 400 }));
    expect(surface.style.left).toBe("400px");

    panel.open({ sentenceId: "sentence-9", summary: "锚点句", anchor: { x: 60, y: 30 } });

    expect(surface.style.left).toBe("74px");
    expect(surface.style.top).toBe("44px");
  });

  it("open 不带 anchor:位置不动(沿用拖动落点或默认右下)", () => {
    const panel = openPanel();
    const surface = panel.host.shadowRoot!.querySelector<HTMLElement>(".panel")!;
    expect(surface.style.left).toBe(""); // 默认 CSS 右下,无内联定位

    panel.open({ sentenceId: "sentence-9", summary: "无锚点" });
    expect(surface.style.left).toBe("");
  });

  // —— 重开恢复(2026-11-25 spec):关闭/换句后同句重开,控制器用 restoreHistory
  //    把停靠的历史画回来;conversationId 由控制器新铸,快照取未裁剪原始历史。 ——

  it("restoreHistory 重画气泡并落历史;恢复会话指向新铸的 conversationId", () => {
    const panel = openPanel();
    completeRound(panel, "问1", "答1");
    completeRound(panel, "问2", "答2");

    // 模拟控制器重开时序:open 复位 → 新 id → 恢复历史
    panel.open({ sentenceId: "sentence-1", summary: "Learners read books." });
    panel.setConversationId("document-1:chat:9");
    const restored: ChatTurn[] = [
      { role: "user", content: "问1" },
      { role: "assistant", content: "答1" },
      { role: "user", content: "问2" },
      { role: "assistant", content: "答2" },
    ];
    panel.restoreHistory(restored);

    const bubbles = [...panel.host.shadowRoot!.querySelectorAll<HTMLElement>(".message")];
    expect(bubbles.map((bubble) => `${bubble.className}=${bubble.textContent}`)).toEqual([
      "message user=问1",
      "message assistant=答1",
      "message user=问2",
      "message assistant=答2",
    ]);
    const conversation = panel.currentConversation()!;
    expect(conversation.conversationId).toBe("document-1:chat:9");
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

    const newChat = [
      ...panel.host.shadowRoot!.querySelectorAll<HTMLButtonElement>(".header button"),
    ].find((button) => button.textContent === "新对话")!;
    expect(newChat).toBeDefined();

    // 按钮起手不算拖(收起/关闭同款守卫):面板位置不动
    newChat.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, clientX: 10, clientY: 10 }),
    );
    document.dispatchEvent(new MouseEvent("pointermove", { clientX: 300, clientY: 300 }));
    document.dispatchEvent(new MouseEvent("pointerup", { clientX: 300, clientY: 300 }));
    const surface = panel.host.shadowRoot!.querySelector<HTMLElement>(".panel")!;
    expect(surface.style.left).toBe("");

    newChat.click();
    expect(fresh).toHaveBeenCalledTimes(1);
    // 清态是控制器回调的职责(重铸 id + open 复位),面板不动自己的历史
    expect(panel.currentConversation()).not.toBeNull();
  });
});
