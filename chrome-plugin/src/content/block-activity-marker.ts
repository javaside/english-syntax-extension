const ACTIVE_ATTRIBUTE = "data-syntax-learning-active";
const STYLE_ATTRIBUTE = "data-syntax-learning-active-style";
const SAFE_TOKEN = /^[A-Za-z0-9_-]+$/u;
const reservedTokens = new Set<string>();
let nextTokenId = 0;

export type ActiveTokenFactory = (attempt: number) => string;

function defaultActiveToken(): string {
  nextTokenId += 1;
  return String(nextTokenId);
}

/**
 * 用 data 属性而不是 class:BlockReplacement 靠「原文本来有没有 class 属性」决定
 * 还原时删不删空 class,标记一旦碰 class 就会让它误判,在页面上留下 class=""。
 *
 * 竖条用 inset box-shadow 而不是 border-left:前者不参与布局计算,文字不会位移,
 * 现有折行与紧凑布局 E2E 才不会被这个纯装饰性标记推翻。改动时不要退回边框实现。
 */
function createActiveStyle(document: Document, token: string): HTMLStyleElement {
  const selector = `[${ACTIVE_ATTRIBUTE}="${token}"]`;
  const style = document.createElement("style");
  style.setAttribute(STYLE_ATTRIBUTE, token);
  style.textContent = `
${selector} {
  box-shadow: inset 3px 0 0 rgba(10, 132, 255, 0.9) !important;
  background-color: rgba(10, 132, 255, 0.06) !important;
  animation: syntax-learning-active-${token} 1.6s ease-in-out infinite;
}
@keyframes syntax-learning-active-${token} {
  50% { box-shadow: inset 3px 0 0 rgba(10, 132, 255, 0.35) !important; }
}
@media (prefers-reduced-motion: reduce) {
  ${selector} { animation: none; }
}`;
  return style;
}

/**
 * 给「正在解析」的段落加视觉标记。只做打标与撤标,不认识会话与相位。
 */
export class BlockActivityMarker {
  static readonly activeAttribute = ACTIVE_ATTRIBUTE;

  #target: HTMLElement | null = null;
  #appliedToken: string | null = null;
  #ownedStyle: HTMLStyleElement | null = null;
  readonly #tokenFactory: ActiveTokenFactory;

  constructor(tokenFactory: ActiveTokenFactory = defaultActiveToken) {
    this.#tokenFactory = tokenFactory;
  }

  get target(): HTMLElement | null {
    return this.#target;
  }

  mark(element: HTMLElement): void {
    if (this.#target === element) return;
    this.clear();
    if (!element.isConnected) return;
    const token = this.#reserveToken(element);
    const style = createActiveStyle(element.ownerDocument, token);
    element.ownerDocument.head.append(style);
    element.setAttribute(ACTIVE_ATTRIBUTE, token);
    this.#target = element;
    this.#appliedToken = token;
    this.#ownedStyle = style;
  }

  clear(): void {
    if (this.#appliedToken !== null) {
      this.#target?.removeAttribute(ACTIVE_ATTRIBUTE);
      reservedTokens.delete(this.#appliedToken);
    }
    this.#ownedStyle?.remove();
    this.#target = null;
    this.#appliedToken = null;
    this.#ownedStyle = null;
  }

  #reserveToken(element: HTMLElement): string {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const token = this.#tokenFactory(attempt);
      if (!SAFE_TOKEN.test(token)) {
        throw new Error("Active token must contain only letters, numbers, underscores, or hyphens");
      }
      if (
        !reservedTokens.has(token) &&
        element.ownerDocument.querySelector(`[${ACTIVE_ATTRIBUTE}="${token}"]`) === null
      ) {
        reservedTokens.add(token);
        return token;
      }
    }
    throw new Error("Unable to allocate a collision-free syntax-learning active token");
  }
}
