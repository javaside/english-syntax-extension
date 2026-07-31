export interface CandidateBlock {
  id: string;
  element: Element;
  text: string;
}

/**
 * 自动扫描只认语义段落标签,免得把边栏、面包屑、按钮标签当正文。
 * 显式手势(选中/悬停/右键)额外接受这些「松散块」——现代站点大量用 div /
 * section 排版正文,只认 <p> 会让用户指着段落却被告知找不到段落。
 */
const BLOCK_SELECTOR = "h1,h2,h3,h4,h5,h6,p,li,blockquote";
const LOOSE_BLOCK_SELECTOR = "div,section,dd,td,figcaption";
const SEMANTIC_ROOT_SELECTOR = "article,main,[role='main']";
const EXCLUSION_SELECTOR =
  "nav,aside,footer,form,pre,code,script,style,noscript,template,svg,canvas,iframe," +
  "[contenteditable],[hidden],[aria-hidden='true']";
// 图片不在此列:卡片替换只是把原节点 display:none,退出时原样恢复,所以段落里
// 夹一张插图并不妨碍可逆渲染,而按钮/输入控件会连同交互状态一起被藏掉。
const UNSAFE_DESCENDANT_SELECTOR =
  "button,input,textarea,select,video,audio,canvas,iframe,[contenteditable]";
const MINIMUM_AUTO_TEXT_LENGTH = 20;

const blockIds = new WeakMap<Element, string>();
let nextBlockId = 1;

function queryElements(root: ParentNode, selector: string): Element[] {
  const matches = Array.from(root.querySelectorAll(selector));
  if (root instanceof Element && root.matches(selector)) matches.unshift(root);
  return matches;
}

function normalizedText(element: Element): string {
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let text = "";
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (parent !== null && isLayoutVisible(parent)) text += node.textContent ?? "";
  }
  return text.replace(/\s+/gu, " ").trim();
}

function isLayoutVisible(element: Element): boolean {
  for (let current: Element | null = element; current !== null; current = current.parentElement) {
    if (current.matches("[hidden],[aria-hidden='true']")) return false;
    const style = getComputedStyle(current);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse"
    ) {
      return false;
    }
  }
  return true;
}

function isEnglishDominant(text: string): boolean {
  const letterWords = text.match(/\p{L}+(?:['’-]\p{L}+)*/gu) ?? [];
  const englishWordCount = letterWords.filter((word) =>
    /^[A-Za-z]+(?:['’-][A-Za-z]+)*$/u.test(word),
  ).length;
  return englishWordCount / Math.max(1, letterWords.length) >= 0.6;
}

/**
 * 标签名不足以判断「是不是一段」:Mintlify 一类文档站(含 Claude Code 文档)整篇
 * 正文都是 <span data-as="p">,靠 CSS 渲染成块。所以按渲染盒子判定,标签名只作兜底
 * (happy-dom 等环境下内联元素的 computed display 是空串而非 "inline")。
 */
const INLINE_DISPLAY = /^(?:|inline|inline-\w+|contents|none)$/u;

function isRenderedBlock(element: Element): boolean {
  return (
    element.matches(LOOSE_BLOCK_SELECTOR) || !INLINE_DISPLAY.test(getComputedStyle(element).display)
  );
}

function hasBlockChild(element: Element): boolean {
  return Array.from(element.children).some(
    (child) => isRenderedBlock(child) && (child.textContent ?? "").trim().length > 0,
  );
}

function isBlockCandidate(element: Element, loose: boolean): boolean {
  if (element.matches(BLOCK_SELECTOR)) return true;
  if (!loose || !isRenderedBlock(element)) return false;
  // 松散块只认叶子块,否则从光标往上找会撞到包着整篇正文的外层容器。
  return !hasBlockChild(element);
}

function isSafeElement(element: Element, loose: boolean): boolean {
  return (
    isBlockCandidate(element, loose) &&
    element.closest(EXCLUSION_SELECTOR) === null &&
    element.querySelector(UNSAFE_DESCENDANT_SELECTOR) === null &&
    isLayoutVisible(element)
  );
}

function getBlockId(element: Element): string {
  const existing = blockIds.get(element);
  if (existing !== undefined) return existing;
  const id = `block-${nextBlockId++}`;
  blockIds.set(element, id);
  return id;
}

function candidateText(element: Element, automatic: boolean): string | null {
  if (!isSafeElement(element, !automatic)) return null;
  const text = normalizedText(element);
  if (
    text.length === 0 ||
    !isEnglishDominant(text) ||
    (automatic && text.length < MINIMUM_AUTO_TEXT_LENGTH)
  ) {
    return null;
  }
  return text;
}

function createCandidate(element: Element, automatic: boolean): CandidateBlock | null {
  const text = candidateText(element, automatic);
  if (text === null) return null;
  return { id: getBlockId(element), element, text };
}

interface ScoredBlock {
  element: Element;
  text: string;
}

function eligibleBlocks(root: ParentNode): ScoredBlock[] {
  return queryElements(root, BLOCK_SELECTOR).flatMap((element) => {
    const text = candidateText(element, true);
    return text === null ? [] : [{ element, text }];
  });
}

function linkedTextLength(element: Element): number {
  return Array.from(element.querySelectorAll("a")).reduce(
    (total, link) => total + normalizedText(link).length,
    0,
  );
}

function contentScore(blocks: readonly ScoredBlock[]): number {
  return blocks.reduce(
    (score, block) => score + block.text.length - 2 * linkedTextLength(block.element),
    0,
  );
}

function semanticRoot(root: ParentNode): Element | null {
  const ranked = queryElements(root, SEMANTIC_ROOT_SELECTOR).flatMap((element, order) => {
    if (element.closest(EXCLUSION_SELECTOR) !== null || !isLayoutVisible(element)) return [];
    const blocks = eligibleBlocks(element);
    if (blocks.length === 0) return [];
    return [
      {
        element,
        score: contentScore(blocks),
        scopeSize: element.querySelectorAll("*").length,
        order,
      },
    ];
  });
  ranked.sort(
    (left, right) =>
      right.score - left.score || left.scopeSize - right.scopeSize || left.order - right.order,
  );
  return ranked[0]?.element ?? null;
}

function fallbackRoot(root: ParentNode): Element | null {
  const safeBlocks = eligibleBlocks(root);
  const scores = new Map<Element, { textLength: number; linkedTextLength: number }>();

  for (const block of safeBlocks) {
    const length = block.text.length;
    const linkedLength = linkedTextLength(block.element);
    for (
      let ancestor = block.element.parentElement;
      ancestor !== null;
      ancestor = ancestor.parentElement
    ) {
      if (!root.contains(ancestor) && ancestor !== root) break;
      if (ancestor.closest(EXCLUSION_SELECTOR) !== null || !isLayoutVisible(ancestor)) continue;
      const score = scores.get(ancestor) ?? { textLength: 0, linkedTextLength: 0 };
      score.textLength += length;
      score.linkedTextLength += linkedLength;
      scores.set(ancestor, score);
      if (ancestor === root) break;
    }
  }

  let best: Element | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const [element, { textLength, linkedTextLength }] of scores) {
    const score = textLength * (1 - (2 * linkedTextLength) / Math.max(1, textLength));
    if (score > bestScore) {
      best = element;
      bestScore = score;
    }
  }
  return best;
}

function selectPrincipalRoot(root: ParentNode): Element | null {
  return semanticRoot(root) ?? fallbackRoot(root);
}

export function scanDocument(root: ParentNode): CandidateBlock[] {
  const principalRoot = selectPrincipalRoot(root);
  if (principalRoot === null) return [];
  return queryElements(principalRoot, BLOCK_SELECTOR).flatMap((element) => {
    const candidate = createCandidate(element, true);
    return candidate === null ? [] : [candidate];
  });
}

/**
 * 只服务用户显式手势(选中文本 / 快捷键悬停 / 右键此区域),所以不套用自动扫描
 * 那两道取舍:不要求落在得分最高的正文容器里(多 article 页面、SPA 换页后缓存
 * 失效都会误伤),也不设最短长度。指哪解析哪,歧义已由用户的鼠标消解。
 */
export function nearestSafeBlock(target: EventTarget | null): CandidateBlock | null {
  const start =
    target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  if (start === null) return null;
  if (
    start.matches("input[type='password'],textarea,[contenteditable]") ||
    start.closest("[contenteditable]") !== null
  ) {
    return null;
  }

  for (let current: Element | null = start; current !== null; current = current.parentElement) {
    const candidate = createCandidate(current, false);
    if (candidate !== null) return candidate;
  }
  return null;
}
