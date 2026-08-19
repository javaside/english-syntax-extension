import { SyntaxLearningBlock } from "./learning-block";

const STYLE_ATTRIBUTE = "data-syntax-learning-hide";
const SAFE_SUFFIX = /^[A-Za-z0-9_-]+$/u;
const reservedHiddenClasses = new Set<string>();
let nextHiddenClassId = 0;

export type HiddenClassSuffixFactory = (attempt: number) => string;

function defaultHiddenClassSuffix(): string {
  nextHiddenClassId += 1;
  return String(nextHiddenClassId);
}

export interface SentenceFailure {
  sentenceId: string;
  sentence: string;
  message: string;
}

function assertLearningBlock(block: SyntaxLearningBlock): void {
  if (!(block instanceof SyntaxLearningBlock)) {
    throw new TypeError("BlockReplacement requires a SyntaxLearningBlock");
  }
}

/**
 * 卡片插在原元素之后,继承的是父容器字体而不是被替换的那个元素——h2 换成卡片后
 * 会掉到正文字号,整篇文章的层级在解析后全部消失。卡片内部用 em 相对单位,所以
 * 把原元素的字号与字重搬到 host 上,整张卡片就按层级等比缩放。
 *
 * 只搬「与父容器不同」的值:普通段落照旧跟随页面,不写死任何尺寸。
 */
function inheritTypography(original: HTMLElement, host: HTMLElement): void {
  const parent = original.parentElement;
  if (parent === null) return;
  const own = getComputedStyle(original);
  const inherited = getComputedStyle(parent);
  if (own.fontSize !== "" && own.fontSize !== inherited.fontSize) {
    host.style.fontSize = own.fontSize;
  }
  if (own.fontWeight !== "" && own.fontWeight !== inherited.fontWeight) {
    host.style.fontWeight = own.fontWeight;
  }
}

function createHideStyle(document: Document, hiddenClass: string): HTMLStyleElement {
  const style = document.createElement("style");
  style.setAttribute(STYLE_ATTRIBUTE, hiddenClass);
  style.textContent = `.${hiddenClass} { display: none !important; }`;
  return style;
}

export class BlockReplacement {
  static readonly hiddenClass = "syntax-learning-original-hidden";

  #original: HTMLElement | null = null;
  #block: HTMLElement | null = null;
  #observer: MutationObserver | null = null;
  #appliedHiddenClass: string | null = null;
  #originalHadClassAttribute = false;
  #ownedStyle: HTMLStyleElement | null = null;
  readonly #hiddenClassSuffixFactory: HiddenClassSuffixFactory;

  constructor(hiddenClassSuffixFactory: HiddenClassSuffixFactory = defaultHiddenClassSuffix) {
    this.#hiddenClassSuffixFactory = hiddenClassSuffixFactory;
  }

  get active(): boolean {
    return this.#original !== null && this.#block !== null;
  }

  show(original: HTMLElement, block: SyntaxLearningBlock): void {
    assertLearningBlock(block);
    this.#display(original, block, block.isReadyToReplace());
  }

  /**
   * Puts a partially rendered block on the page while the rest of it is still
   * streaming. The readiness gate exists so a half-analyzed paragraph never
   * replaces the original silently; a preview is an explicit, temporary
   * exception, so it only needs one rendered sentence.
   */
  showPreview(original: HTMLElement, block: SyntaxLearningBlock): void {
    assertLearningBlock(block);
    this.#display(original, block, block.hasRenderedSentence());
  }

  #display(original: HTMLElement, block: SyntaxLearningBlock, allowed: boolean): void {
    if (!allowed) {
      return;
    }
    // Already displaying this exact pairing: the block re-renders its own
    // sentences in place, so tearing it down and re-inserting would only make
    // the preview flicker when the verified result lands.
    if (this.#original === original && this.#block === block.host) {
      return;
    }
    this.restore();
    if (original.parentNode === null) {
      return;
    }
    inheritTypography(original, block.host);
    const hiddenClass = this.#reserveHiddenClass(original);
    const style = createHideStyle(original.ownerDocument, hiddenClass);
    original.ownerDocument.head.append(style);
    original.after(block.host);
    this.#originalHadClassAttribute = original.hasAttribute("class");
    original.classList.add(hiddenClass);
    this.#original = original;
    this.#block = block.host;
    this.#appliedHiddenClass = hiddenClass;
    this.#ownedStyle = style;
    this.#observePageRemoval(original.ownerDocument);
  }

  showPartialFailure(
    original: HTMLElement,
    block: SyntaxLearningBlock,
    failures: readonly SentenceFailure[],
  ): void {
    if (failures.length === 0) {
      return;
    }
    for (const failure of failures) {
      block.renderFailure(failure.sentenceId, failure.sentence, failure.message);
    }
    this.show(original, block);
  }

  restore(): void {
    this.#observer?.disconnect();
    this.#observer = null;
    if (this.#appliedHiddenClass !== null) {
      this.#original?.classList.remove(this.#appliedHiddenClass);
      reservedHiddenClasses.delete(this.#appliedHiddenClass);
      // classList.remove leaves an empty class="" attribute behind; drop it
      // when the original element never had one so restoration is exact.
      if (!this.#originalHadClassAttribute && this.#original?.getAttribute("class") === "") {
        this.#original.removeAttribute("class");
      }
    }
    this.#ownedStyle?.remove();
    this.#block?.remove();
    this.#original = null;
    this.#block = null;
    this.#appliedHiddenClass = null;
    this.#ownedStyle = null;
  }

  currentElement(original: HTMLElement): Element {
    return this.#block ?? original;
  }

  #observePageRemoval(document: Document): void {
    this.#observer = new MutationObserver(() => {
      if (this.#original?.isConnected === false) {
        this.restore();
      }
    });
    this.#observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  #reserveHiddenClass(original: HTMLElement): string {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const suffix = this.#hiddenClassSuffixFactory(attempt);
      if (!SAFE_SUFFIX.test(suffix)) {
        throw new Error(
          "Hidden-class suffix must contain only letters, numbers, underscores, or hyphens",
        );
      }
      const candidate = `${BlockReplacement.hiddenClass}-${suffix}`;
      if (
        !reservedHiddenClasses.has(candidate) &&
        original.ownerDocument.getElementsByClassName(candidate).length === 0
      ) {
        reservedHiddenClasses.add(candidate);
        return candidate;
      }
    }
    throw new Error("Unable to allocate a collision-free syntax-learning hide class");
  }
}
