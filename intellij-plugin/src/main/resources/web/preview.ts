/**
 * Markdown 预览 DOM 扫描与可见性观察。
 *
 * 与 Chrome 端 document-scanner 的取舍不同：预览 DOM 是 Markdown 渲染产物，
 * 候选固定为 h1-h6/p/li/blockquote（blockquote 只取安全叶子），排除区覆盖
 * 代码/表格/数学/图表/脚注/交互控件。英文占比 >= 60%、最短 20 字符。
 */

export interface PreviewBlock {
  blockId: string;
  element: HTMLElement;
  text: string;
}

const CANDIDATE_SELECTOR = "h1,h2,h3,h4,h5,h6,p,li,blockquote";
const EXCLUDED_SELECTOR =
  "pre,code,table,.math,.katex,.mermaid,.footnotes,[role='doc-endnotes']," +
  "button,input,textarea,select,iframe,[contenteditable],[data-english-syntax-card]";
const HIDDEN_ATTRIBUTE = "data-english-syntax-hidden";
const BLOCK_ID_ATTRIBUTE = "data-english-syntax-block";
const MIN_TEXT_LENGTH = 20;
const ENGLISH_RATIO = 0.6;
const BLOCK_SELECTOR_PREFIX = "english-syntax-block-";

let nextBlockId = 0;
// 用 let：resetScanRegistry() 会重新赋值为空 WeakSet 实现清空注册表。
let registeredElements = new WeakSet<HTMLElement>();

/** 清空已扫描注册表：用户手动重新点「开始」（初始化）时调用，
 *  让 rescan 能重新扫描并上报全部段（否则 WeakSet 防重扫描会让二次
 *  scanMarkdownBlocks 返回空，失败句永远无法重派——真机「失败后再点开始不动」）。 */
export function resetScanRegistry(): void {
  // WeakSet 不可枚举，直接替换为空集合实现清空。
  registeredElements = new WeakSet<HTMLElement>();
}

function isExcluded(element: Element): boolean {
  return element.closest(EXCLUDED_SELECTOR) !== null;
}

function isRendered(element: HTMLElement): boolean {
  const display = element.ownerDocument.defaultView?.getComputedStyle(element).display ?? "";
  // happy-dom 里内联元素的 computed display 可能是空串——空串按非块处理。
  return display !== "" && !/^inline($|-)/.test(display);
}

function isLeafBlock(element: HTMLElement): boolean {
  return !Array.from(element.children).some((child) => isRendered(child as HTMLElement));
}

function englishRatio(text: string): number {
  const words = text.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0) return 0;
  const english = words.filter((word) => /^[A-Za-z]/.test(word)).length;
  return english / words.length;
}

/** 收集一个候选的安全叶子块；blockquote 递归取其内部叶子。 */
function collectCandidates(element: HTMLElement, into: HTMLElement[]): void {
  if (isExcluded(element)) return;
  if (element.tagName === "BLOCKQUOTE") {
    for (const child of element.querySelectorAll<HTMLElement>("p,li")) {
      collectCandidates(child, into);
    }
    return;
  }
  if (!isLeafBlock(element)) return;
  const text = (element.textContent ?? "").trim();
  if (text.length < MIN_TEXT_LENGTH) return;
  if (englishRatio(text) < ENGLISH_RATIO) return;
  into.push(element);
}

export function scanMarkdownBlocks(root: ParentNode): PreviewBlock[] {
  const elements: HTMLElement[] = [];
  for (const element of root.querySelectorAll<HTMLElement>(CANDIDATE_SELECTOR)) {
    collectCandidates(element, elements);
  }
  return elements
    .filter(
      (element) => !registeredElements.has(element) && !element.hasAttribute(HIDDEN_ATTRIBUTE),
    )
    .map((element) => {
      registeredElements.add(element);
      // 已带 block 标记的元素沿用旧 id（防重复扫描产生双 id）。
      const existing = element.getAttribute("data-english-syntax-block");
      const blockId = existing ?? `${BLOCK_SELECTOR_PREFIX}${nextBlockId++}`;
      if (existing === null) element.setAttribute(BLOCK_ID_ATTRIBUTE, blockId);
      return { blockId, element, text: (element.textContent ?? "").trim() };
    });
}

/** Markdown 重渲染后失效：原节点没了，注册记录要清掉。 */
export function releaseMissingBlocks(root: ParentNode): void {
  // WeakSet 无法枚举；扫描端按元素消亡自然失效，这里保留 hook 供 MutationObserver
  // 在节点被移除时显式调用（当前实现 WeakSet 自动失效，无需额外动作）。
  void root;
}

export interface BlockVisibility {
  /** 启动观察；callback 延续构造时传入的那个。 */
  start(): void;
  stop(): void;
}

/** 与视口（上下各扩一屏）求交的几何判定；不依赖 IntersectionObserver 的回调时机。 */
function geometricallyVisible(root: ParentNode, block: PreviewBlock): boolean {
  const view = root.ownerDocument?.defaultView;
  if (!view) return false;
  const rect = block.element.getBoundingClientRect();
  const viewportTop = -view.innerHeight;
  const viewportBottom = view.innerHeight * 2;
  return rect.bottom >= viewportTop && rect.top <= viewportBottom;
}

/**
 * IntersectionObserver（rootMargin 上下各一屏）；环境不支持时退化为
 * rAF 节流的 scroll/resize 检查。
 *
 * **start() 必先用几何判定播种可见集**：JCEF 环境里 IntersectionObserver
 * 的初始回调不可靠（observe 后可能不产生 entries），只重发当前 Set 会是
 * 空集——VISIBLE_BLOCKS 永远不发出，页面点开始后毫无反应。IO 只负责
 * 之后的滚动增量更新。
 */
export function observeBlocks(
  root: ParentNode,
  blocks: PreviewBlock[],
  callback: (visible: PreviewBlock[]) => void,
): BlockVisibility {
  const visible = new Set<PreviewBlock>();
  const emit = () => callback(Array.from(visible));

  if (typeof IntersectionObserver !== "undefined") {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const block = blocks.find((candidate) => candidate.element === entry.target);
          if (!block) continue;
          if (entry.isIntersecting) visible.add(block);
          else visible.delete(block);
        }
        emit();
      },
      { rootMargin: "100% 0px 100% 0px" },
    );
    blocks.forEach(({ element }) => observer.observe(element));
    return {
      start() {
        // 几何播种：不依赖 IO 的初始回调时机，立即得到首批可见块。
        visible.clear();
        for (const block of blocks) {
          if (geometricallyVisible(root, block)) visible.add(block);
        }
        emit();
      },
      stop() {
        observer.disconnect();
      },
    };
  }

  let raf = 0;
  const check = () => {
    raf = 0;
    const view = root.ownerDocument?.defaultView;
    if (!view) return;
    const viewportTop = -view.innerHeight;
    const viewportBottom = view.innerHeight * 2;
    visible.clear();
    for (const block of blocks) {
      const rect = block.element.getBoundingClientRect();
      if (rect.bottom >= viewportTop && rect.top <= viewportBottom) visible.add(block);
    }
    emit();
  };
  const schedule = () => {
    if (raf === 0) raf = requestAnimationFrame(check);
  };
  return {
    start() {
      viewOf(root)?.addEventListener("scroll", schedule, { passive: true });
      viewOf(root)?.addEventListener("resize", schedule, { passive: true });
      schedule();
    },
    stop() {
      viewOf(root)?.removeEventListener("scroll", schedule);
      viewOf(root)?.removeEventListener("resize", schedule);
      if (raf !== 0) cancelAnimationFrame(raf);
    },
  };
}

function viewOf(root: ParentNode): Window | null {
  return root.ownerDocument?.defaultView ?? null;
}
