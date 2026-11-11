/**
 * 追问对话浮层（Chrome 端 content/chat-panel.ts 平移,DOM/样式适配预览页体系）。
 *
 * 预览页是非 Shadow DOM 环境:类名带 english-syntax- 前缀、视觉规则全部活在
 * preview.css（Kotlin 单独注入,不进 bundle）；host 挂 `document.documentElement`
 * ——官方 Markdown 预览的 updateDom 重写整个 body,挂 body 的浮层会随之消失。
 *
 * 会话状态 = { conversationId, 锚定句摘要, history };conversationId 由 bootstrap
 * 在图标点击时铸好经 open 传入（Task 4 评审钉死的 seam）,所有 assistant 侧方法按
 * 它把关:换句 open 重置会话后,旧会话的迟到流/结果直接丢弃。回答气泡纯文本 +
 * pre-wrap（不引 markdown）,`renderStreamedText` 按「截至目前完整回答」的推送形状
 * **全量替换**当前气泡（调度器静默重试后重画同一段文本,天然无害）。
 */
import {
  MAX_CHAT_HISTORY_CHARACTERS,
  MAX_CHAT_HISTORY_TURNS,
  MAX_CHAT_QUESTION_CHARACTERS,
  type ChatErrorHostMessage,
  type ChatResultHostMessage,
  type ChatStreamHostMessage,
  type ChatTurn,
} from "./bridge";

/** bootstrap-entry 转发来的 CHAT_* 三条 host 消息（generation 已在 bridge 层过滤）。 */
export type ChatHostMessage = ChatStreamHostMessage | ChatResultHostMessage | ChatErrorHostMessage;

/**
 * 拖动钳制边界:不依赖布局就能算的「至少留一个可抓取的角」——left/top 各自
 * 距视口边 ≥8px,且 left ≤ innerWidth-120 / top ≤ innerHeight-80（面板宽 400、
 * 高 560 以内,保证标题栏总有一截在视口里,拖丢了也拽得回来）。
 */
const DRAG_MARGIN = 8;
const DRAG_MAX_LEFT_RESERVE = 120;
const DRAG_MAX_TOP_RESERVE = 80;

/** 锚点弹出的右下偏移:面板左上角落在点击位置右下方 14px（阅读顺序自然）。 */
const CHAT_POPUP_OFFSET = 14;

/** 摘要行长度上限（Chrome 端 controller 同款 slice(0, 40)）。 */
const SUMMARY_MAX_CHARS = 40;

/**
 * stop()/换代取消在飞的 chat 后,Kotlin 发来的 CHAT_ERROR 以错误码名作前缀
 * （chatFailureText 的 `"$code：$detail"`）。那是用户侧的正常终态,不是失败——
 * 渲染成中性提示,别把「取消」画成红色错误（Task 3 移交的语义）。
 */
const CANCELLED_MESSAGE_PREFIX = "REQUEST_CANCELLED";
const CANCELLED_NOTICE_TEXT = "本轮回答已取消，可重新提问";

/** open() 的上下文:会话 id + 锚定句 + 摘要行文本 + 可选弹出锚点。 */
export interface ChatPanelContext {
  /** bootstrap 铸好的会话 id（`${previewId}:chat:${n}`）;面板据此路由迟到的 CHAT_*。 */
  conversationId: string;
  sentenceId: string;
  /** 锚定句摘要（bootstrap 按 token 重建的句原文截断）;标题栏显示,悬停看全文。 */
  summary: string;
  /**
   * 弹出锚点（点击「问」图标的视口坐标）:面板弹在锚点右下方 14px（视口钳制照旧）。
   * 换句追问带新锚点 = 面板跟着句子走;不传则保持当前位置（默认右下/拖动落点）。
   */
  anchor?: { x: number; y: number };
}

export class ChatPanel {
  /**
   * 提交回调:bootstrap 的接线（installChatPanel）赋值,输入框 Enter 提交时收到
   * trim 后的问题文本。接线层负责 appendUserTurn/beginAssistantTurn 的时序与
   * CHAT_ASK 的构造发送。
   */
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
  /** 拖动状态;pointerup/pointercancel 清空。null = 未在拖。 */
  #drag: { startX: number; startY: number; baseLeft: number; baseTop: number } | null = null;
  /** 用户拖过之后的位置（像素）;重开面板时沿用,没拖过则保持 CSS 默认右下。 */
  #placedLeft: number | undefined;
  #placedTop: number | undefined;

  constructor(ownerDocument: Document = document) {
    this.#doc = ownerDocument;
    this.host = ownerDocument.createElement("div");
    this.host.dataset.englishSyntaxChatPanel = "";
    this.#root = ownerDocument.createElement("div");
    this.#root.className = "english-syntax-chat-panel";
    this.#root.setAttribute("aria-label", "追问对话");

    this.#summary = ownerDocument.createElement("div");
    this.#summary.className = "english-syntax-chat-summary";
    const collapse = ownerDocument.createElement("button");
    collapse.type = "button";
    collapse.textContent = "收起";
    collapse.addEventListener("click", () => {
      // 折叠态走 data 属性（preview.css 选择器锚点）,与 class 无关。
      const collapsed = this.#root.toggleAttribute("data-collapsed");
      collapse.textContent = collapsed ? "展开" : "收起";
    });
    this.#collapse = collapse;
    const close = ownerDocument.createElement("button");
    close.type = "button";
    close.textContent = "关闭";
    close.addEventListener("click", () => this.dispose());
    const header = ownerDocument.createElement("div");
    header.className = "english-syntax-chat-header";
    header.append(this.#summary, collapse, close);
    // 标题栏拖动把手:move/up 挂在 document 上,指针甩出标题栏也能继续拖。
    // 从按钮上起手不算拖（收起/关闭仍可点）;抓取以 pointerdown 的 target 判定。
    header.addEventListener("pointerdown", (event) => {
      if (event.target instanceof Element && event.target.closest("button")) return;
      // 基准取 .english-syntax-chat-panel（真正 fixed 定位的元素）的 rect;
      // host 是 0×0 的静态挂载壳,写 host 不动面板。
      const rect = this.#root.getBoundingClientRect();
      this.#drag = {
        startX: event.clientX,
        startY: event.clientY,
        baseLeft: rect.left,
        baseTop: rect.top,
      };
      header.style.setProperty("cursor", "grabbing", "important");
      event.preventDefault(); // 别把标题栏文本选进拖动
    });
    // cursor 走内联 !important:官方预览主题压得过任何 stylesheet 的 cursor
    // （成分按钮同款坑——见 render.ts）。
    header.style.setProperty("cursor", "grab", "important");
    collapse.style.setProperty("cursor", "pointer", "important");
    close.style.setProperty("cursor", "pointer", "important");
    ownerDocument.addEventListener("pointermove", (event) => {
      if (this.#drag === null) return;
      this.#applyPosition(
        this.#drag.baseLeft + event.clientX - this.#drag.startX,
        this.#drag.baseTop + event.clientY - this.#drag.startY,
      );
    });
    const endDrag = (): void => {
      if (this.#drag === null) return;
      this.#drag = null;
      header.style.setProperty("cursor", "grab", "important");
    };
    ownerDocument.addEventListener("pointerup", endDrag);
    ownerDocument.addEventListener("pointercancel", endDrag);

    this.#messages = ownerDocument.createElement("div");
    this.#messages.className = "english-syntax-chat-messages";

    this.#input = ownerDocument.createElement("textarea");
    this.#input.className = "english-syntax-chat-input";
    this.#input.setAttribute("maxlength", String(MAX_CHAT_QUESTION_CHARACTERS));
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
    this.#send.className = "english-syntax-chat-send";
    this.#send.textContent = "发送";
    this.#send.style.setProperty("cursor", "pointer", "important");
    this.#send.addEventListener("click", () => this.#submit());
    const composer = ownerDocument.createElement("div");
    composer.className = "english-syntax-chat-composer";
    composer.append(this.#input, this.#send);

    this.#root.append(header, this.#messages, composer);
    this.host.append(this.#root);
  }

  /**
   * 换锚定句 = 重置会话:历史与气泡清空、摘要行换新、conversationId 换成 bootstrap
   * 新铸的那只,旧会话的迟到流/结果自此全部丢弃。带锚点（点「问」处）弹出:面板跟着
   * 句子走,覆盖此前的拖动落点;不带锚点则保持既有位置（默认右下/上次拖动落点）。
   */
  open(context: ChatPanelContext): void {
    this.#conversationId = context.conversationId;
    this.#history = [];
    this.#assistantBubble = undefined;
    if (context.anchor !== undefined) {
      this.#applyPosition(
        context.anchor.x + CHAT_POPUP_OFFSET,
        context.anchor.y + CHAT_POPUP_OFFSET,
      );
    } else if (this.#placedLeft !== undefined && this.#placedTop !== undefined) {
      // 用户拖过的位置显式重贴一次（拖动落点存在内联样式上,本就未丢;这里补上
      // 「重开沿用」的语义,与 Chrome 端一致）。
      this.#applyPosition(this.#placedLeft, this.#placedTop);
    }
    this.#messages.replaceChildren();
    this.#summary.textContent = context.summary.slice(0, SUMMARY_MAX_CHARS);
    this.#summary.title = context.summary; // 摘要行省略号截断,悬停看全文
    this.#root.dataset.sentenceId = context.sentenceId;
    this.#root.removeAttribute("data-collapsed");
    this.#collapse.textContent = "收起"; // 换会话默认展开,别残留上一次的按钮文案
    this.#input.value = "";
    this.#setSending(false);
    if (!this.host.isConnected) this.#doc.documentElement.append(this.host);
  }

  /** 会话 id 的显式轮换（open 已带 id,这只留给测试与潜在的手动作废/续用点）。 */
  setConversationId(id: string): void {
    this.#conversationId = id;
  }

  /**
   * 当前会话的请求视图:history 已按 Kotlin parse 门同单位裁剪（项 ≤ 6、总字符
   * ≤ 8000,从最旧丢起）,且**不含尾部悬空的 user 轮**——已提交未回答的那一问属于
   * 「本轮」,由 CHAT_ASK 的 question 字段单独承载,不重复进 history。返回的是
   * 副本,调用方改动不污染面板状态。
   */
  currentConversation(): { conversationId: string; history: ChatTurn[] } | null {
    if (this.#conversationId === undefined) return null;
    return { conversationId: this.#conversationId, history: this.#trimmedHistory() };
  }

  /**
   * bootstrap 转发来的 CHAT_* 统一入口:按消息类型分发,conversationId 由各方法
   * 自行把关（generation 等值门已在 bridge.parseHostMessage 过滤,这是第二道防线）。
   */
  handleHostMessage(message: ChatHostMessage): void {
    switch (message.type) {
      case "CHAT_STREAM":
        this.renderStreamedText(message.conversationId, message.text);
        return;
      case "CHAT_RESULT":
        this.completeAssistantTurn(message.conversationId, message.answer);
        return;
      case "CHAT_ERROR":
        this.failAssistantTurn(message.conversationId, message.message);
        return;
    }
  }

  appendUserTurn(text: string): void {
    this.#history.push({ role: "user", content: text });
    this.#messages.append(this.#bubble("user", text));
    this.#scrollToEnd();
  }

  /** 开始一轮回答:建立 pending 气泡并进入发送中（输入禁用）。旧会话 id 忽略。 */
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
   * 无进行中轮次（completeAssistantTurn/failAssistantTurn 已收尾）的迟到分片
   * 直接忽略——此时再建泡会把已结束的一轮又画出一个重复气泡。
   */
  renderStreamedText(conversationId: string, text: string): void {
    if (conversationId !== this.#conversationId) return;
    if (this.#assistantBubble === undefined) return;
    const bubble = this.#assistantBubble;
    bubble.classList.remove("english-syntax-chat-message--pending");
    bubble.textContent = text;
    this.#scrollToEnd();
  }

  /**
   * 回答落定:以缓冲答案为准校平气泡（防流式尾片丢失）,push 进历史并解除发送中。
   * 缓冲路径（无分片）同样走这里,气泡整段出现。
   */
  completeAssistantTurn(conversationId: string, answer: string): void {
    if (conversationId !== this.#conversationId) return;
    if (this.#assistantBubble === undefined) {
      this.#assistantBubble = this.#bubble("assistant", answer);
      this.#messages.append(this.#assistantBubble);
    }
    const bubble = this.#assistantBubble;
    bubble.classList.remove("english-syntax-chat-message--pending");
    bubble.textContent = answer;
    this.#assistantBubble = undefined;
    this.#history.push({ role: "assistant", content: answer });
    this.#setSending(false);
    this.#scrollToEnd();
  }

  /**
   * 失败轮不入历史:撤销悬空 user 轮,history 始终是完整问答对;输入恢复。
   * 无 pending 轮也画错误气泡（Kotlin「原句已失效」路径:提交后记录/core 缺失,
   * 面板里可能没有任何进行中轮次,不能静默吞掉）。REQUEST_CANCELLED 前缀按中性
   * 提示渲染（用户主动取消的正常终态）,原文留在 title 里备查。
   */
  failAssistantTurn(conversationId: string, message: string): void {
    if (conversationId !== this.#conversationId) return;
    const last = this.#history[this.#history.length - 1];
    if (last?.role === "user") this.#history.pop();
    const cancelled = message.startsWith(CANCELLED_MESSAGE_PREFIX);
    const text = cancelled ? CANCELLED_NOTICE_TEXT : message;
    const bubble = this.#assistantBubble;
    if (bubble !== undefined) {
      // 复用 pending 气泡的位置,换成错误/通知样式
      bubble.className = cancelled
        ? "english-syntax-chat-message english-syntax-chat-message--notice"
        : "english-syntax-chat-message english-syntax-chat-message--error";
      bubble.textContent = text;
    } else {
      // 无 pending 轮（原句失效路径）:新建气泡,这一轮同样不占 #assistantBubble。
      this.#messages.append(this.#bubble(cancelled ? "notice" : "error", text));
    }
    const placed = bubble ?? (this.#messages.lastElementChild as HTMLElement | null);
    if (cancelled) placed?.setAttribute("title", message); // 原始文案备查
    this.#assistantBubble = undefined;
    this.#setSending(false);
    this.#scrollToEnd();
  }

  /**
   * 钳制到视口内并落到 .english-syntax-chat-panel 的内联样式——它才是
   * position:fixed 的元素,host 只是 0×0 的挂载壳,写 host 不动面板。定位后改用
   * left/top（清掉 right/bottom 的 CSS 默认右下锚定）。记下落点供重开沿用。
   */
  #applyPosition(left: number, top: number): void {
    const view = this.#doc.defaultView;
    const maxLeft = Math.max(DRAG_MARGIN, (view?.innerWidth ?? 0) - DRAG_MAX_LEFT_RESERVE);
    const maxTop = Math.max(DRAG_MARGIN, (view?.innerHeight ?? 0) - DRAG_MAX_TOP_RESERVE);
    const clampedLeft = Math.min(Math.max(left, DRAG_MARGIN), maxLeft);
    const clampedTop = Math.min(Math.max(top, DRAG_MARGIN), maxTop);
    this.#root.style.left = `${clampedLeft}px`;
    this.#root.style.top = `${clampedTop}px`;
    this.#root.style.right = "auto";
    this.#root.style.bottom = "auto";
    this.#placedLeft = clampedLeft;
    this.#placedTop = clampedTop;
  }

  /** 关闭浮层并作废会话（对话不持久化:面板关闭即丢;对象常驻,下次 open 重开）。 */
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
    variant: "user" | "assistant" | "assistant pending" | "error" | "notice",
    text: string,
  ): HTMLElement {
    const bubble = this.#doc.createElement("div");
    // "assistant pending" 展开成 --assistant 与 --pending 两个修饰类,其余单类。
    const variantClasses = variant
      .split(" ")
      .map((part) => `english-syntax-chat-message--${part}`);
    bubble.className = ["english-syntax-chat-message", ...variantClasses].join(" ");
    bubble.textContent = text;
    return bubble;
  }

  #trimmedHistory(): ChatTurn[] {
    let items = this.#history;
    if (items[items.length - 1]?.role === "user") {
      items = items.slice(0, -1);
    }
    items = items.slice(-MAX_CHAT_HISTORY_TURNS);
    let characters = items.reduce((total, turn) => total + turn.content.length, 0);
    while (items.length > 0 && characters > MAX_CHAT_HISTORY_CHARACTERS) {
      characters -= items[0]!.content.length;
      items = items.slice(1);
    }
    return items.map((turn) => ({ role: turn.role, content: turn.content }));
  }

  #scrollToEnd(): void {
    this.#messages.scrollTop = this.#messages.scrollHeight;
  }
}
