import type { ChatTurn } from "../shared/protocol";

/**
 * 历史裁剪上限。与 SW 入站兜底(service-worker.ts 的 CHAT_HISTORY_MAX_*)刻意同单位:
 * ChatTurn **项数**(最近 3 组问答 = 6 项,不是 6 组)与 content 字符数之和,从最旧
 * 项丢起。SW 侧超限直接 MALFORMED_MESSAGE,面板在读出侧先裁好,两边边界一致。
 */
const MAX_HISTORY_ITEMS = 6;
const MAX_HISTORY_CHARS = 8000;

/** SW 兜底对 question 的上限(trim 后 1..2000);UI 侧用 maxlength 先挡一道。 */
const QUESTION_MAX_CHARACTERS = 2000;

const STYLES = `
  :host { all: initial; }
  .panel {
    all: initial;
    /* 与 diagnosis-panel(同右下 bottom 64px)上下错开,不与其同位精确重叠。 */
    position: fixed; right: 16px; bottom: 84px; z-index: 2147483647;
    display: flex; flex-direction: column;
    width: min(400px, calc(100vw - 32px)); max-height: min(560px, 70vh);
    font: 13px/1.6 system-ui, sans-serif; color: #111;
    background: #fff; border: 1px solid #d4d4d8; border-radius: 10px;
    box-shadow: 0 8px 24px rgba(0,0,0,.18);
  }
  /* 面板本身可交互——与 diagnosis-panel 一样刻意不写 pointer-events: none。 */
  .header {
    display: flex; align-items: baseline; gap: 8px;
    padding: 10px 12px 8px; border-bottom: 1px solid #e4e4e7;
  }
  .summary {
    flex: 1; min-inline-size: 0; font-weight: 600; font-size: 12px; color: #52525b;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .header button, .composer button {
    all: initial;
    font: 11px/1.4 system-ui, sans-serif; cursor: pointer; color: #52525b;
    padding: 2px 8px; border: 1px solid #d4d4d8; border-radius: 6px;
  }
  .header button:focus-visible, .composer button:focus-visible,
  .composer textarea:focus-visible {
    outline: 2px solid #18181b; outline-offset: 1px;
  }
  .messages {
    flex: 1; min-height: 72px; overflow-y: auto;
    display: flex; flex-direction: column; gap: 8px; padding: 10px 12px;
  }
  /* 气泡是纯文本:不引 markdown,换行交给 pre-wrap,XSS 面只有 textContent。 */
  .message {
    max-width: 85%; padding: 6px 10px; border-radius: 10px;
    white-space: pre-wrap; overflow-wrap: anywhere;
  }
  .message.user {
    align-self: flex-end; background: #18181b; color: #fff;
    border-end-end-radius: 3px;
  }
  .message.assistant {
    align-self: flex-start; background: #f4f4f5; color: #111;
    border-end-start-radius: 3px;
  }
  .message.assistant.pending { color: #71717a; }
  .message.error {
    align-self: flex-start; color: #b91c1c; background: #fef2f2;
    border: 1px solid #fecaca;
  }
  .composer {
    display: flex; align-items: flex-end; gap: 8px;
    padding: 8px 12px 10px; border-top: 1px solid #e4e4e7;
  }
  .composer textarea {
    flex: 1; resize: vertical; min-height: 44px; max-height: 120px;
    font: inherit; color: inherit; padding: 6px 8px;
    border: 1px solid #d4d4d8; border-radius: 8px;
  }
  .composer textarea:disabled { background: #f4f4f5; }
  .composer button {
    align-self: flex-end; background: #18181b; color: #fff;
    border-color: #18181b; padding: 6px 14px; font-size: 12px;
  }
  .composer button:disabled { cursor: default; opacity: 0.5; }
  .panel.collapsed .messages, .panel.collapsed .composer { display: none; }
`;

/** open() 的锚定上下文:句子 id + 顶部摘要行文本(控制器已截断)。 */
export interface ChatPanelContext {
  sentenceId: string;
  summary: string;
}

/** 「问」按钮派发的追问请求事件 detail(syntax-detail-request 同款模式)。 */
export interface SyntaxChatRequestEventDetail {
  sentenceId: string;
}

/**
 * 追问对话浮层:host + open shadow root,固定右下、惰性单例挂载(工艺照
 * DiagnosisPanel)。会话状态 = { conversationId, 锚定句摘要, history };回答气泡
 * 纯文本 + pre-wrap;`renderStreamedText` 按「截至目前完整回答」的推送形状**全量
 * 替换**当前气泡(调度器静默重试后重画同一段文本,天然无害)。所有 assistant 侧
 * 方法按 conversationId 把关:换句 open 重置会话后,旧会话的迟到流/结果直接丢弃。
 */
export class ChatPanel {
  /** 控制器(Task 6)赋值;输入框 Enter 提交时收到 trim 后的问题文本。 */
  onSubmit: (question: string) => void = () => {};

  readonly host: HTMLElement;
  readonly #doc: Document;
  readonly #root: HTMLDivElement;
  readonly #summary: HTMLElement;
  readonly #collapse: HTMLButtonElement;
  readonly #messages: HTMLDivElement;
  readonly #input: HTMLTextAreaElement;
  readonly #send: HTMLButtonElement;
  #conversationId: string | undefined;
  #history: ChatTurn[] = [];
  #assistantBubble: HTMLElement | undefined;

  constructor(ownerDocument: Document = document) {
    this.#doc = ownerDocument;
    this.host = ownerDocument.createElement("div");
    this.host.dataset.syntaxChatPanel = "";
    const shadow = this.host.attachShadow({ mode: "open" });
    const style = ownerDocument.createElement("style");
    style.textContent = STYLES;
    this.#root = ownerDocument.createElement("div");
    this.#root.className = "panel";
    this.#root.setAttribute("aria-label", "追问对话");

    this.#summary = ownerDocument.createElement("div");
    this.#summary.className = "summary";
    const collapse = ownerDocument.createElement("button");
    collapse.type = "button";
    collapse.textContent = "收起";
    collapse.addEventListener("click", () => {
      const collapsed = this.#root.classList.toggle("collapsed");
      collapse.textContent = collapsed ? "展开" : "收起";
    });
    this.#collapse = collapse;
    const close = ownerDocument.createElement("button");
    close.type = "button";
    close.textContent = "关闭";
    close.addEventListener("click", () => this.dispose());
    const header = ownerDocument.createElement("div");
    header.className = "header";
    header.append(this.#summary, collapse, close);

    this.#messages = ownerDocument.createElement("div");
    this.#messages.className = "messages";

    this.#input = ownerDocument.createElement("textarea");
    this.#input.setAttribute("maxlength", String(QUESTION_MAX_CHARACTERS));
    this.#input.setAttribute("placeholder", "追问这句的翻译或划分…");
    this.#input.setAttribute("aria-label", "追问问题");
    this.#input.addEventListener("keydown", (event) => {
      // IME 组字中的 Enter 是选字确认,不是提交
      if (event.isComposing) return;
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault(); // Shift+Enter 走默认换行,回车不落进输入框
        this.#submit();
      }
    });
    this.#send = ownerDocument.createElement("button");
    this.#send.type = "button";
    this.#send.textContent = "发送";
    this.#send.addEventListener("click", () => this.#submit());
    const composer = ownerDocument.createElement("div");
    composer.className = "composer";
    composer.append(this.#input, this.#send);

    this.#root.append(header, this.#messages, composer);
    shadow.append(style, this.#root);
  }

  /** 换锚定句 = 重置会话:历史与气泡清空、conversationId 作废,摘要行换新句。 */
  open(context: ChatPanelContext): void {
    this.#conversationId = undefined;
    this.#history = [];
    this.#assistantBubble = undefined;
    this.#messages.replaceChildren();
    this.#summary.textContent = context.summary;
    this.#summary.title = context.summary; // 摘要行省略号截断,悬停看全文
    this.#root.dataset.sentenceId = context.sentenceId;
    this.#root.classList.remove("collapsed");
    this.#collapse.textContent = "收起"; // 换会话默认展开,别残留上一次的按钮文案
    this.#input.value = "";
    this.#setSending(false);
    if (!this.host.isConnected) this.#doc.documentElement.append(this.host);
  }

  setConversationId(id: string): void {
    this.#conversationId = id;
  }

  /**
   * 当前会话的请求视图:history 已按 SW 兜底同单位裁剪(项 ≤ 6、总字符 ≤ 8000,
   * 从最旧丢起),且**不含尾部悬空的 user 轮**——已提交未回答的那一问属于「本轮」,
   * 由 CHAT_ASK 的 question 字段单独承载,不重复进 history。返回的是副本,调用方
   * 改动不污染面板状态。
   */
  currentConversation(): { conversationId: string; history: ChatTurn[] } | null {
    if (this.#conversationId === undefined) return null;
    return { conversationId: this.#conversationId, history: this.#trimmedHistory() };
  }

  appendUserTurn(text: string): void {
    this.#history.push({ role: "user", content: text });
    this.#messages.append(this.#bubble("user", text));
    this.#scrollToEnd();
  }

  /** 开始一轮回答:建立 pending 气泡并进入发送中(输入禁用)。旧会话 id 忽略。 */
  beginAssistantTurn(conversationId: string): void {
    if (conversationId !== this.#conversationId) return;
    this.#setSending(true);
    const bubble = this.#bubble("assistant pending", "正在生成回答…");
    this.#assistantBubble = bubble;
    this.#messages.append(bubble);
    this.#scrollToEnd();
  }

  /**
   * 流式分片 = 截至目前的完整回答:全量替换当前气泡文本,不是追加。
   * 无进行中轮次(completeAssistantTurn/failAssistantTurn 已收尾)的迟到分片
   * 直接忽略——此时再建泡会把已结束的一轮又画出一个重复气泡。
   */
  renderStreamedText(conversationId: string, text: string): void {
    if (conversationId !== this.#conversationId) return;
    if (this.#assistantBubble === undefined) return;
    const bubble = this.#assistantBubble;
    bubble.classList.remove("pending");
    bubble.textContent = text;
    this.#scrollToEnd();
  }

  /**
   * 回答落定:以缓冲答案为准校平气泡(防流式尾片丢失),push 进历史并解除发送中。
   * 缓冲路径(无分片)同样走这里,气泡整段出现。
   */
  completeAssistantTurn(conversationId: string, answer: string): void {
    if (conversationId !== this.#conversationId) return;
    if (this.#assistantBubble === undefined) {
      this.#assistantBubble = this.#bubble("assistant", answer);
      this.#messages.append(this.#assistantBubble);
    }
    const bubble = this.#assistantBubble;
    bubble.classList.remove("pending");
    bubble.textContent = answer;
    this.#assistantBubble = undefined;
    this.#history.push({ role: "assistant", content: answer });
    this.#setSending(false);
    this.#scrollToEnd();
  }

  /** 失败轮不入历史:撤销悬空 user 轮,history 始终是完整问答对;输入恢复。 */
  failAssistantTurn(conversationId: string, message: string): void {
    if (conversationId !== this.#conversationId) return;
    const last = this.#history[this.#history.length - 1];
    if (last?.role === "user") this.#history.pop();
    const bubble = this.#assistantBubble;
    if (bubble !== undefined) {
      // 复用 pending 气泡的位置,换成错误样式
      bubble.className = "message error";
      bubble.textContent = message;
    } else {
      this.#messages.append(this.#bubble("error", message));
    }
    this.#assistantBubble = undefined;
    this.#setSending(false);
    this.#scrollToEnd();
  }

  /** 关闭浮层并作废会话(对话不持久化:面板关闭即丢)。 */
  dispose(): void {
    this.host.remove();
    this.#conversationId = undefined;
    this.#history = [];
    this.#assistantBubble = undefined;
    this.#messages.replaceChildren();
    this.#summary.textContent = "";
    delete this.#root.dataset.sentenceId;
    this.#input.value = "";
    this.#setSending(false);
  }

  #submit(): void {
    if (this.#input.disabled) return;
    const question = this.#input.value.trim();
    if (question.length === 0) return;
    this.onSubmit(question);
    this.#input.value = "";
  }

  #setSending(sending: boolean): void {
    this.#input.disabled = sending;
    this.#send.disabled = sending;
  }

  #bubble(
    variant: "user" | "assistant" | "assistant pending" | "error",
    text: string,
  ): HTMLElement {
    const bubble = this.#doc.createElement("div");
    bubble.className = `message ${variant}`;
    bubble.textContent = text;
    return bubble;
  }

  #trimmedHistory(): ChatTurn[] {
    let items = this.#history;
    if (items[items.length - 1]?.role === "user") {
      items = items.slice(0, -1);
    }
    items = items.slice(-MAX_HISTORY_ITEMS);
    let characters = items.reduce((total, turn) => total + turn.content.length, 0);
    while (items.length > 0 && characters > MAX_HISTORY_CHARS) {
      characters -= items[0]!.content.length;
      items = items.slice(1);
    }
    return items.map((turn) => ({ role: turn.role, content: turn.content }));
  }

  #scrollToEnd(): void {
    this.#messages.scrollTop = this.#messages.scrollHeight;
  }
}
