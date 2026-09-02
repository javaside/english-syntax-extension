/**
 * Markdown 预览 DOM 扫描与可见性观察。
 *
 * 与 Chrome 端 document-scanner 的取舍不同：预览 DOM 是 Markdown 渲染产物，
 * 候选为 h1-h6/p/li/blockquote（blockquote 只取安全叶子），以及 Markdown 原文中的
 * 连字符自定义标签（如 HARD-GATE）；排除区覆盖代码/表格/数学/图表/脚注/交互控件。
 * 英文占比 >= 60%、最短 20 字符。
 */

export interface PreviewBlock {
  blockId: string;
  element: HTMLElement;
  text: string;
}

const STANDARD_CANDIDATE_TAGS = new Set([
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "P",
  "LI",
  "BLOCKQUOTE",
]);
const EXCLUDED_SELECTOR =
  "pre,code,table,.math,.katex,.mermaid,.footnotes,[role='doc-endnotes']," +
  "button,input,textarea,select,iframe,[contenteditable],[data-english-syntax-card]";
/**
 * 原文被卡片替换后打在原元素上的标记。`render.ts` 负责写/删，`preview.css` 据它隐藏原文，
 * 扫描与按段解析据它跳过「已经出过卡」的段落。
 */
export const HIDDEN_ATTRIBUTE = "data-english-syntax-hidden";
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

/**
 * 取或分配 blockId。与 [scanMarkdownBlocks] 共用 `nextBlockId` 计数器——显式路径先给
 * 某元素分配过 id，之后自动扫描会沿用它，不会出现双 id。
 */
export function ensureBlockId(element: HTMLElement): string {
  const existing = element.getAttribute(BLOCK_ID_ATTRIBUTE);
  if (existing !== null) return existing;
  const blockId = `${BLOCK_SELECTOR_PREFIX}${nextBlockId++}`;
  element.setAttribute(BLOCK_ID_ATTRIBUTE, blockId);
  return blockId;
}

/**
 * 悬停链选择器。
 *
 * `:is()` 不能省：quirks 模式（HTML 没有 doctype）下 Chromium 按 hover/active quirk
 * 只让链接匹配裸 `:hover`，`querySelectorAll(":hover")` 于是**整页恒为空集**，按快捷键
 * 只会得到「未找到可解析的段落」。该 quirk 只在「复合选择器里除伪类之外别无他物」时生效，
 * 塞进 `:is()` 就落进子选择器语境、不再适用（实测同一 quirks 页面：`:hover` → 空，
 * `:is(:hover)` → `html > body > main > p#safe`）；标准模式下两者结果恒等。
 *
 * 预览页 HTML 由 IDEA 生成，doctype 有无不由我们说了算，所以不赌它是标准模式。
 * Chrome 端同一判据在 `chrome-plugin/src/content/hover-target.ts`。
 */
export const HOVER_CHAIN_SELECTOR = ":is(:hover)";

/** 悬停链的最深元素。happy-dom 等环境不实现该伪类，查询可能抛错，兜住返回 null。 */
export function deepestHovered(doc: Document): Element | null {
  let chain: NodeListOf<Element> | null = null;
  try {
    chain = doc.querySelectorAll(HOVER_CHAIN_SELECTOR);
  } catch {
    chain = null;
  }
  if (chain === null || chain.length === 0) return null;
  return chain[chain.length - 1] ?? null;
}

/**
 * 显式手势（快捷键悬停解析）的块定位：从悬停元素逐级向上找最近的可解析块。
 *
 * **刻意不套用自动扫描的取舍**：不要求 20 字符、不要求英文占比、不限定候选标签。
 * `scanMarkdownBlocks` 要在整篇里躲开边栏与样板文字，这里只服务用户指到的那一处——
 * 套用后的症状是「鼠标明明停在段落上，快捷键却报『未找到可解析的段落』」（短段落、
 * 术语行、中英混排行全中招）。保留的判据只有四条：排除区、渲染盒子、叶子块、文本非空。
 *
 * 按渲染盒子而非标签名认块：Mintlify 一类文档站整篇正文都是 `<span>`，只按标签名
 * 认块会把这类站点整页判成「未找到」。只认叶子块，否则往上会撞到包着整篇正文的容器。
 */
export function nearestPreviewBlock(target: EventTarget | null): HTMLElement | null {
  const start =
    target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  if (start === null) return null;
  if (start.closest("input,textarea,[contenteditable]") !== null) return null;

  for (let current: Element | null = start; current !== null; current = current.parentElement) {
    if (!(current instanceof HTMLElement)) continue;
    if (isExcluded(current)) continue;
    // Markdown 原始 HTML 的连字符自定义标签默认 display:inline，但它本身就是作者声明的
    // 内容边界；显式手势应认它自身，而不是继续向上撞到包住整篇文档的容器。
    if (!isRendered(current) && !isHyphenatedCustomElement(current)) continue;
    if (!isLeafBlock(current)) continue;
    if ((current.textContent ?? "").trim().length === 0) continue;
    return current;
  }
  return null;
}

function isExcluded(element: Element): boolean {
  return element.closest(EXCLUDED_SELECTOR) !== null;
}

function isHyphenatedCustomElement(element: Element): boolean {
  return element.localName.includes("-");
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
  for (const element of root.querySelectorAll<HTMLElement>("*")) {
    if (!STANDARD_CANDIDATE_TAGS.has(element.tagName) && !isHyphenatedCustomElement(element)) continue;
    collectCandidates(element, elements);
  }
  return elements
    .filter(
      (element) => !registeredElements.has(element) && !element.hasAttribute(HIDDEN_ATTRIBUTE),
    )
    .map((element) => {
      registeredElements.add(element);
      return { blockId: ensureBlockId(element), element, text: (element.textContent ?? "").trim() };
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
