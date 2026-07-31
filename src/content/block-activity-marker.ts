const STYLE_ATTRIBUTE = "data-syntax-learning-active";
const SAFE_SUFFIX = /^[A-Za-z0-9_-]+$/u;
const reservedActiveClasses = new Set<string>();
let nextActiveClassId = 0;

export type ActiveClassSuffixFactory = (attempt: number) => string;

function defaultActiveClassSuffix(): string {
  nextActiveClassId += 1;
  return String(nextActiveClassId);
}

/**
 * 竖条用 inset box-shadow 而不是 border-left:前者不参与布局计算,文字不会位移,
 * 现有折行与紧凑布局 E2E 才不会被这个纯装饰性标记推翻。改动时不要退回边框实现。
 */
function createActiveStyle(document: Document, activeClass: string): HTMLStyleElement {
  const style = document.createElement("style");
  style.setAttribute(STYLE_ATTRIBUTE, activeClass);
  style.textContent = `
.${activeClass} {
  box-shadow: inset 3px 0 0 rgba(10, 132, 255, 0.9) !important;
  background-color: rgba(10, 132, 255, 0.06) !important;
  animation: ${activeClass}-pulse 1.6s ease-in-out infinite;
}
@keyframes ${activeClass}-pulse {
  50% { box-shadow: inset 3px 0 0 rgba(10, 132, 255, 0.35) !important; }
}
@media (prefers-reduced-motion: reduce) {
  .${activeClass} { animation: none; }
}`;
  return style;
}

/**
 * 给「正在解析」的段落加视觉标记。只做打标与撤标,不认识会话与相位。
 */
export class BlockActivityMarker {
  static readonly activeClass = "syntax-learning-block-active";

  #target: HTMLElement | null = null;
  #appliedClass: string | null = null;
  #targetHadClassAttribute = false;
  #ownedStyle: HTMLStyleElement | null = null;
  readonly #suffixFactory: ActiveClassSuffixFactory;

  constructor(suffixFactory: ActiveClassSuffixFactory = defaultActiveClassSuffix) {
    this.#suffixFactory = suffixFactory;
  }

  get target(): HTMLElement | null {
    return this.#target;
  }

  mark(element: HTMLElement): void {
    if (this.#target === element) return;
    this.clear();
    if (!element.isConnected) return;
    const activeClass = this.#reserveActiveClass(element);
    const style = createActiveStyle(element.ownerDocument, activeClass);
    element.ownerDocument.head.append(style);
    this.#targetHadClassAttribute = element.hasAttribute("class");
    element.classList.add(activeClass);
    this.#target = element;
    this.#appliedClass = activeClass;
    this.#ownedStyle = style;
  }

  clear(): void {
    if (this.#appliedClass !== null) {
      this.#target?.classList.remove(this.#appliedClass);
      reservedActiveClasses.delete(this.#appliedClass);
      // classList.remove 会留下空的 class="";元素本来没有就得删干净。
      if (!this.#targetHadClassAttribute && this.#target?.getAttribute("class") === "") {
        this.#target.removeAttribute("class");
      }
    }
    this.#ownedStyle?.remove();
    this.#target = null;
    this.#appliedClass = null;
    this.#ownedStyle = null;
  }

  #reserveActiveClass(element: HTMLElement): string {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const suffix = this.#suffixFactory(attempt);
      if (!SAFE_SUFFIX.test(suffix)) {
        throw new Error(
          "Active-class suffix must contain only letters, numbers, underscores, or hyphens",
        );
      }
      const candidate = `${BlockActivityMarker.activeClass}-${suffix}`;
      if (
        !reservedActiveClasses.has(candidate) &&
        element.ownerDocument.getElementsByClassName(candidate).length === 0
      ) {
        reservedActiveClasses.add(candidate);
        return candidate;
      }
    }
    throw new Error("Unable to allocate a collision-free syntax-learning active class");
  }
}
