import { normalizedReadableText } from "./readable-dom-text";

/**
 * 页面语义单元清单(page semantic inventory)。
 *
 * 这是「自动扫描之前」的一层:枚举页面里每个安全、可读、有语义的英文单元,给每个
 * 单元一个明确结局——自动分析,或带稳定原因的排除——而不是只对正文长段落表现良好。
 *
 * 生产运行时只有 `automatic === true` 的投影(`document-scanner.ts` 的 `scanDocument`)
 * 会进入模型;排除项带稳定 reason,供测试与 acceptance inventory 审计,不进入
 * SW/JCEF 协议。
 *
 * 分类型候选规则(取消「统一 20 字符」单一阈值):
 * - 标题、`dt`、`th`、`caption`:有可读英文实词即可;
 * - `p/li/dd/td/figcaption` 与语义 callout/题名:靠语义标签、principal root 和英文占比;
 * - 松散 `div/section/span`:保留 20 字符门槛,防止 UI 标签与模板碎片进入模型;
 * - 显式手势(`document-scanner.ts` 的 `nearestSafeBlock`):不设长度门槛。
 */

export type ReadableUnitKind =
  | "heading"
  | "paragraph"
  | "list-item"
  | "definition-term"
  | "definition-body"
  | "table-caption"
  | "table-header"
  | "table-cell"
  | "figure-caption"
  | "callout"
  | "footnote"
  | "reference-title"
  | "loose-block";

export type ReadableUnitExclusionReason =
  | "outside-principal-content"
  | "excluded-region"
  | "unsafe-interactive"
  | "hidden"
  | "non-english"
  | "no-readable-words"
  | "loose-block-too-short"
  | "display-math"
  | "math-auxiliary"
  | "conversion-placeholder"
  | "reference-metadata"
  | "unsupported-reference-layout"
  | "covered-by-child"
  | "unsafe-partial-replacement";

export interface ReadableUnit {
  id: string;
  element: Element;
  kind: ReadableUnitKind;
  text: string;
  automatic: boolean;
  exclusionReason?: ReadableUnitExclusionReason;
}

/**
 * 自动扫描只认语义段落标签,免得把边栏、面包屑、按钮标签当正文。显式手势额外接受
 * 「松散块」——现代站点大量用 div/section/span 排版正文。`dt/dd/caption/th/td/
 * figcaption` 与 `.ltx_bib_title` 是语义单元:分类型门槛取代统一长度阈值。
 */
const BLOCK_SELECTOR =
  "h1,h2,h3,h4,h5,h6,p,li,blockquote,dt,dd,caption,th,td,figcaption,.ltx_bib_title";
const LOOSE_BLOCK_SELECTOR = "div,section,dd,td,figcaption";
const LOOSE_CANDIDATE_SELECTOR = "div,section,span";
const SEMANTIC_ROOT_SELECTOR = "article,main,[role='main']";
/** 站点导航与模板噪声区域。`header` 不在此列:它由 banner 位置判定条件排除。 */
const EXCLUDED_REGION_SELECTOR =
  "nav,aside,footer,form,pre,code,script,style,noscript,template,svg,canvas,iframe";
/**
 * header 只在「站点横幅位置」排除(横幅判定:不被任何正文容器包住,如 arXiv 站点
 * 工具条)。正文容器内的 header 是页面自己的标题区——Mintlify 一类站点把 h1 与
 * 页面引导段落渲染在里面,无条件排除会让页首段落永远翻不了。
 */
const HEADER_CONTENT_ANCESTOR_SELECTOR = "article,main,section,[role='main']";
/**
 * 只匹配「可编辑」状态。`contenteditable="false"` 是明确的只读展示区(X Articles、
 * 各类富文本预览),不是编辑器——按属性存在匹配会把整篇只读正文判成隐藏/危险内容。
 */
export const EDITABLE_CONTENT_SELECTOR =
  "[contenteditable='true'],[contenteditable=''],[contenteditable='plaintext-only']";
const HIDDEN_SELECTOR = `[hidden],[aria-hidden='true'],${EDITABLE_CONTENT_SELECTOR}`;
// 图片不在排除之列:卡片替换只是 display:none,段落里夹插图不妨碍可逆渲染。
const UNSAFE_DESCENDANT_SELECTOR = `button,input,textarea,select,video,audio,canvas,iframe,${EDITABLE_CONTENT_SELECTOR}`;
const MINIMUM_AUTO_TEXT_LENGTH = 20;

/** LaTeXML 语义类:参考文献的题名 / 作者 / 年份,论文作者块与邮箱。 */
const REFERENCE_TITLE_SELECTOR = ".ltx_bib_title";
const REFERENCE_METADATA_SELECTOR =
  ".ltx_bib_authors,.ltx_bib_year,.ltx_authors,a[href^='mailto:']";
const BIBITEM_SELECTOR = ".ltx_bibitem";
/** callout / note / warning / abstract 一类可识别的语义容器。 */
const CALLOUT_SELECTOR = "[role='note'],[role='note'] *,.callout,.note,.warning,.abstract";
const FOOTNOTE_CONTAINER_SELECTOR = ".ltx_role_footnote,[role='doc-footnote'],section.footnotes";
const DISPLAY_MATH_SELECTOR = "math[display='block'],.ltx_equation,table.equation,div.equation";
/** 公式辅助内容:TeX annotation 与 assistive fallback,不与可见公式重复。 */
const MATH_AUXILIARY_SELECTOR = "annotation,.ltx_MathML";
/** LaTeXML 已知转换占位符:孤立的宏名残留(如 `\Acp`),不是可读正文。 */
const CONVERSION_PLACEHOLDER_PATTERN = /^\\[A-Za-z]+$/u;
/** inventory 审计锚点:fixture 用它钉住「这一页要求完整分类」的分母。 */
const AUDIT_ATTRIBUTE = "data-audit-id";

const INLINE_DISPLAY = /^(?:|inline|inline-\w+|contents|none)$/u;

interface ScoredBlock {
  element: Element;
  text: string;
}

function queryElements(root: ParentNode, selector: string): Element[] {
  const matches = Array.from(root.querySelectorAll(selector));
  if (root instanceof Element && root.matches(selector)) matches.unshift(root);
  return matches;
}

/**
 * 命中的排除区祖先:静态导航噪声区域,或处于站点横幅位置的 `header`。祖先链上
 * 可能有多个 header(外层横幅包着正文容器、内层是页面标题区),逐个按各自位置
 * 判定——内层在 article/main/section/[role=main] 内即内容标题区,外层横幅照旧排除。
 */
function excludedRegionAncestor(element: Element): Element | null {
  const staticRegion = element.closest(EXCLUDED_REGION_SELECTOR);
  if (staticRegion !== null) return staticRegion;
  for (
    let current: Element | null = element.parentElement;
    current !== null;
    current = current.parentElement
  ) {
    if (!current.matches("header")) continue;
    const parent = current.parentElement;
    if (parent === null || parent.closest(HEADER_CONTENT_ANCESTOR_SELECTOR) === null) {
      return current;
    }
  }
  return null;
}

// ─── 可见性与文本判定 ─────────────────────────────────────────────────────────

function isLayoutVisible(element: Element): boolean {
  for (let current: Element | null = element; current !== null; current = current.parentElement) {
    if (current.matches(HIDDEN_SELECTOR)) return false;
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

function letterWords(text: string): string[] {
  return text.match(/\p{L}+(?:['’-]\p{L}+)*/gu) ?? [];
}

/** 英文词占全部实词的比例——词级判定,不是字符级(中文实词同样计入分母)。 */
function englishLetterRatio(text: string): number {
  const words = letterWords(text);
  const english = words.filter((word) => /^[A-Za-z]+(?:['’-][A-Za-z]+)*$/u.test(word)).length;
  return english / Math.max(1, words.length);
}

function isEnglishDominant(text: string): boolean {
  return englishLetterRatio(text) >= 0.6;
}

/**
 * 标签名不足以判断「是不是一段」:Mintlify 一类文档站整篇正文是 `<span data-as="p">`
 * 靠 CSS 渲染成块。按渲染盒子判定,标签名只作兜底(happy-dom 里内联元素的 computed
 * display 是空串而非 "inline")。
 */
function isRenderedBlock(element: Element): boolean {
  return (
    element.matches(LOOSE_BLOCK_SELECTOR) || !INLINE_DISPLAY.test(getComputedStyle(element).display)
  );
}

function hasBlockChild(element: Element): boolean {
  return Array.from(element.children).some(
    (child) => isRenderedBlock(child) && normalizedReadableText(child).length > 0,
  );
}

function isBlockCandidate(element: Element, loose: boolean): boolean {
  if (element.matches(BLOCK_SELECTOR)) return true;
  if (!loose || !isRenderedBlock(element)) return false;
  // 松散块只认叶子块,否则从光标往上找会撞到包着整篇正文的外层容器。
  // `table/tr/figure` 一类结构容器永不整体成块:它们要么有语义子单元(caption/th/td/
  // figcaption —— `analyzableDescendants` 判 covered-by-child),要么是纯结构(无文本)。
  if (element.matches("table,tr,thead,tbody,figure")) return false;
  return !hasBlockChild(element);
}

function isSafeElement(element: Element, loose: boolean): boolean {
  return (
    isBlockCandidate(element, loose) &&
    excludedRegionAncestor(element) === null &&
    element.closest(HIDDEN_SELECTOR) === null &&
    element.querySelector(UNSAFE_DESCENDANT_SELECTOR) === null &&
    isLayoutVisible(element)
  );
}

/**
 * 显式手势(选中/悬停/右键)的候选文本:安全块 + 英文占比,不设长度门槛,也不要求
 * 落在得分最高的正文容器里。`document-scanner.ts` 的 `nearestSafeBlock` 用它保持
 * 「指哪解析哪」的既有取舍。
 */
export function explicitCandidateText(element: Element): string | null {
  if (!isSafeElement(element, true)) return null;
  const text = normalizedReadableText(element);
  if (text.length === 0 || !isEnglishDominant(text)) return null;
  return text;
}

// ─── principal root(正文容器)───────────────────────────────────────────────

function baseEligibleText(element: Element): string | null {
  if (!isSafeElement(element, true)) return null;
  const text = normalizedReadableText(element);
  if (letterWords(text).length === 0 || !isEnglishDominant(text)) return null;
  // 松散块(非语义 callout)保留 20 字符门槛;语义标签与题名靠英文占比把关。
  const loose = !element.matches(BLOCK_SELECTOR) && !element.matches(CALLOUT_SELECTOR);
  if (loose && text.length < MINIMUM_AUTO_TEXT_LENGTH) return null;
  return text;
}

function eligibleBlocks(root: ParentNode): ScoredBlock[] {
  return queryElements(root, `${BLOCK_SELECTOR},${LOOSE_CANDIDATE_SELECTOR}`).flatMap((element) => {
    const text = baseEligibleText(element);
    return text === null ? [] : [{ element, text }];
  });
}

function linkedTextLength(element: Element): number {
  return Array.from(element.querySelectorAll("a")).reduce(
    (total, link) => total + normalizedReadableText(link).length,
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
    if (excludedRegionAncestor(element) !== null || element.closest(HIDDEN_SELECTOR) !== null) {
      return [];
    }
    if (!isLayoutVisible(element)) return [];
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
      if (
        excludedRegionAncestor(ancestor) !== null ||
        ancestor.closest(HIDDEN_SELECTOR) !== null ||
        !isLayoutVisible(ancestor)
      ) {
        continue;
      }
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

// ─── 语义分类 ────────────────────────────────────────────────────────────────

function classifyKind(element: Element): ReadableUnitKind {
  if (element.matches(REFERENCE_TITLE_SELECTOR)) return "reference-title";
  if (element.matches("h1,h2,h3,h4,h5,h6")) return "heading";
  if (element.matches("dt")) return "definition-term";
  if (element.matches("dd")) return "definition-body";
  if (element.matches("caption")) return "table-caption";
  if (element.matches("th")) return "table-header";
  if (element.matches("td")) return "table-cell";
  if (element.matches("figcaption")) return "figure-caption";
  if (element.matches("li")) return "list-item";
  if (element.matches(CALLOUT_SELECTOR)) return "callout";
  if (
    element.tagName.toLowerCase() === "p" &&
    element.closest(FOOTNOTE_CONTAINER_SELECTOR) !== null
  ) {
    return "footnote";
  }
  if (element.tagName.toLowerCase() === "p") return "paragraph";
  return "loose-block";
}

function analyzableDescendants(element: Element): Element[] {
  return Array.from(element.querySelectorAll(BLOCK_SELECTOR)).filter(
    (descendant) => normalizedReadableText(descendant).length > 0,
  );
}

/**
 * 父元素自己的直接文本:不属于任何子元素的文本节点与内联公式。存在则整体替换父
 * 会把这段文本连坐——父要么与子单元并存(记 unsafe-partial-replacement),要么
 * 文本完全由子单元组成(记 covered-by-child)。
 */
function hasSeparableDirectText(element: Element): boolean {
  return Array.from(element.childNodes).some((node) => {
    if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? "").trim().length > 0;
    return node instanceof Element && node.tagName.toLowerCase() === "math";
  });
}

/** 单元自己的可见文本全部来自公式(公式单元格),不是自然语言。 */
function isFormulaOnlyElement(element: Element): boolean {
  if (element.querySelector("math") === null) return false;
  return Array.from(element.childNodes).every((node) => {
    if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? "").trim().length === 0;
    return node instanceof Element && node.tagName.toLowerCase() === "math";
  });
}

function isMathAuxiliary(element: Element): boolean {
  if (element.matches(MATH_AUXILIARY_SELECTOR)) return true;
  // assistive fallback:aria-hidden 的重复文本,且所在段落里确有公式。
  if (!element.matches("[aria-hidden='true']")) return false;
  const host = element.closest("p,li,dd,td,figcaption,div,section");
  return host !== null && host.querySelector("math") !== null;
}

/** 作者邮箱串与其转换残留(`show]`、孤立 `]`、逗号、连接词)构成的整块,不是可读正文。 */
const EMAIL_TOKEN_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const AUTHOR_RESIDUE_PATTERN = /^(show|and|,|;|\]|\[|\|)$/iu;

function isContactMetadataBlock(text: string): boolean {
  const parts = text.trim().split(/\s+/u);
  if (parts.length === 0) return false;
  let emails = 0;
  for (const part of parts) {
    const bare = part.replace(/^[\]]+/u, "").replace(/[.,;]+$/u, "");
    if (EMAIL_TOKEN_PATTERN.test(bare)) {
      emails += 1;
      continue;
    }
    if (AUTHOR_RESIDUE_PATTERN.test(part)) continue;
    return false; // 出现任何其它实词,说明是正文(如 "Contact us at …")
  }
  return emails > 0;
}

/**
 * 科学语义排除:无论英文占比多高、门槛多松,这些单元都不是可读自然语言。返回
 * undefined 表示「没有科学层面的排除理由」,继续走通用分类。
 */
function scientificExclusion(element: Element): ReadableUnitExclusionReason | undefined {
  const text = normalizedReadableText(element);
  if (CONVERSION_PLACEHOLDER_PATTERN.test(text)) return "conversion-placeholder";
  if (isMathAuxiliary(element)) return "math-auxiliary";
  if (isContactMetadataBlock(text)) return "reference-metadata";
  if (
    element.matches(REFERENCE_METADATA_SELECTOR) ||
    element.closest(REFERENCE_METADATA_SELECTOR) !== null
  ) {
    return "reference-metadata";
  }
  if (element.closest(DISPLAY_MATH_SELECTOR) !== null || isFormulaOnlyElement(element)) {
    return "display-math";
  }
  const bibitem = element.closest(BIBITEM_SELECTOR);
  if (bibitem !== null && bibitem.querySelector(REFERENCE_TITLE_SELECTOR) === null) {
    return "unsupported-reference-layout";
  }
  return undefined;
}

/**
 * 判定排除原因。科学语义原因已在自动资格阶段前置;这里处理覆盖关系(方向语义见
 * `coveredByAnalyzedDescendant` 的注释)、容器与可见性,最后是文本门槛。
 */
function classifyExclusion(
  element: Element,
  principalRoot: Element | null,
  automaticUnits: ReadonlySet<Element>,
): ReadableUnitExclusionReason | undefined {
  const text = normalizedReadableText(element);

  // 覆盖方向(义务 b):covered-by-child 记在「文本被另一侧单元覆盖」的一方——
  // ① 内联单元(如 <math>)躺在自动分析的祖先单元里,记在子节点上;
  // ② 父容器文本完全由子单元组成,记在父容器上。「完全由子组成」= 父的直接文本
  //    (含内联公式)为空或纯空白——`figcaption > p` 唯一进 p,`li` 带自己的
  //    直接文字则记 unsafe-partial-replacement,由显式路径兜底。
  //    方向①里 reason 记在「被父吸收的子」侧,命名沿用冻结的 covered-by-child
  //    (即使此处语义读作「子被父覆盖」)——fixture 全等契约按此方向钉住,不要改。
  const automaticAncestor = ancestorInSet(element, automaticUnits);
  if (automaticAncestor !== null) return "covered-by-child";
  const analyzableChildren = analyzableDescendants(element);
  if (analyzableChildren.length > 0) {
    return hasSeparableDirectText(element) ? "unsafe-partial-replacement" : "covered-by-child";
  }

  if (principalRoot !== null && !principalRoot.contains(element) && element !== principalRoot) {
    return "outside-principal-content";
  }
  if (excludedRegionAncestor(element) !== null) return "excluded-region";
  if (
    element.matches(UNSAFE_DESCENDANT_SELECTOR) ||
    element.querySelector(UNSAFE_DESCENDANT_SELECTOR) !== null
  ) {
    return "unsafe-interactive";
  }
  if (!isLayoutVisible(element)) return "hidden";
  if (letterWords(text).length === 0) return "no-readable-words";
  if (!isEnglishDominant(text)) return "non-english";
  if (
    !element.matches(BLOCK_SELECTOR) &&
    !element.matches(CALLOUT_SELECTOR) &&
    text.length < MINIMUM_AUTO_TEXT_LENGTH
  ) {
    return "loose-block-too-short";
  }
  return undefined;
}

function ancestorInSet(element: Element, units: ReadonlySet<Element>): Element | null {
  for (let ancestor = element.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
    if (units.has(ancestor)) return ancestor;
  }
  return null;
}

// ─── 枚举与组装 ──────────────────────────────────────────────────────────────

const ENUMERATION_SELECTOR = `${BLOCK_SELECTOR},${REFERENCE_METADATA_SELECTOR},${CALLOUT_SELECTOR}`;

/**
 * 枚举 root 下的可读语义单元:语义标签 / 语义类、渲染为块的松散叶子,以及带
 * `data-audit-id` 的诊断锚点(fixture 用它钉住完整分母——nav、table、button 这类
 * 结构锚点只在显式标注时进入清单,生产页面不会凭空多出导航噪声)。
 */
function enumerateUnitElements(root: ParentNode): Element[] {
  const units: Element[] = [];
  for (const element of queryElements(root, "*")) {
    const isUnit =
      element.matches(ENUMERATION_SELECTOR) ||
      element.hasAttribute(AUDIT_ATTRIBUTE) ||
      (element.matches(LOOSE_CANDIDATE_SELECTOR) &&
        isRenderedBlock(element) &&
        !hasBlockChild(element) &&
        !queryElements(root, BLOCK_SELECTOR).some(
          (block) => block !== element && block.contains(element),
        ));
    if (isUnit) units.push(element);
  }
  return units;
}

let nextUnitId = 1;

/**
 * 组装页面语义清单。两遍分类:先按「可作为自动单元」判定(安全 + 英文 + 分类型
 * 门槛),再对非自动单元按优先级给出稳定排除原因——覆盖判定要用到第一遍的自动
 * 集合(内联单元是否躺在自动分析的段落里)。
 */
export function inventoryReadableUnits(root: ParentNode): ReadableUnit[] {
  const elements = enumerateUnitElements(root);
  const principalRoot = selectPrincipalRoot(root);

  const automaticElements = new Set<Element>();
  for (const element of elements) {
    if (scientificExclusion(element) !== undefined) continue;
    if (baseEligibleText(element) === null) continue;
    // 自动扫描的克制之一:只收主内容区内的单元(导航/页脚由 principal root 挡住,
    // 与显式手势的取舍不同)。principal root 选不出来时退回整页,不静默清零。
    if (principalRoot !== null && !principalRoot.contains(element) && element !== principalRoot) {
      continue;
    }
    automaticElements.add(element);
  }
  // 父子去重在自动资格阶段就做:文本完全由可分析子单元组成的父、带不可分离直接
  // 文本的父,都不当自动单元(`figcaption > p` 只进 p;嵌套 `li` 只进叶子)。
  for (const element of [...automaticElements]) {
    if (analyzableDescendants(element).length === 0) continue;
    automaticElements.delete(element);
  }

  const units: ReadableUnit[] = [];
  for (const element of elements) {
    // 自动资格先过科学语义排除(占位符/公式辅助/文献元数据/独立公式),再谈覆盖与
    // 门槛——`\Acp` 或公式单元格文本再「英文」也不进模型。
    let reason: ReadableUnitExclusionReason | undefined;
    const scientific = scientificExclusion(element);
    if (scientific !== undefined) {
      reason = scientific;
    } else if (!automaticElements.has(element)) {
      reason = classifyExclusion(element, principalRoot, automaticElements);
    }
    const automatic = reason === undefined;
    const unit: ReadableUnit = {
      id: element.getAttribute(AUDIT_ATTRIBUTE) ?? `unit-${nextUnitId++}`,
      element,
      kind: classifyKind(element),
      text: normalizedReadableText(element),
      automatic,
    };
    if (reason !== undefined) unit.exclusionReason = reason;
    units.push(unit);
  }
  return units;
}

export interface CandidateGateResult {
  gate: string;
  ok: boolean;
  value?: string | number;
}

/**
 * 只读诊断出口:对单个元素按生产判据逐门复算,返回每门结果与当时取值。
 * 门顺序刻意镜像 classifyExclusion(:430-472) 的优先级链(科学排除 → 覆盖/部分替换 →
 * principal root → 排除区 → 交互元素 → 可见性 → 实词 → 英文 → 短块),block-candidate
 * 作为额外语义证据放最后;它与 inventoryReadableUnits 的判定必须一致——诊断报告要拿去
 * 改代码,不能复制一份会漂移的判据。不改任何生产路径行为,纯新增导出。
 */
export function explainElement(element: Element): CandidateGateResult[] {
  const text = normalizedReadableText(element);
  const words = letterWords(text).length;
  const ratio = englishLetterRatio(text);
  const scientific = scientificExclusion(element);
  const owner = element.ownerDocument; // 绝不引用全局 document——fixture 元素在独立 Window 文档里
  const principalRoot = selectPrincipalRoot(owner);
  const excluded = excludedRegionAncestor(element);
  const hasAnalyzableChildren = analyzableDescendants(element).length > 0;
  const unsafeSelf = element.matches(UNSAFE_DESCENDANT_SELECTOR); // 注意拼写 DESCENDANT
  const unsafeChild = element.querySelector(UNSAFE_DESCENDANT_SELECTOR) !== null;
  return [
    {
      gate: "scientific-exclusion",
      ok: scientific === undefined,
      ...(scientific === undefined ? {} : { value: scientific }),
    },
    { gate: "covered-by-child", ok: !hasAnalyzableChildren },
    // 条件门:仅在有可分析子时才评估(automatic 单元没有可分析子,恒 ok)——
    // 镜像 classifyExclusion 里 children 检查先于 hasSeparableDirectText 的顺序。
    {
      gate: "has-separable-direct-text",
      ok: !hasAnalyzableChildren || !hasSeparableDirectText(element),
    },
    {
      gate: "inside-principal-root",
      ok: principalRoot === null || principalRoot.contains(element) || element === principalRoot,
    },
    {
      gate: "excluded-region",
      ok: excluded === null,
      ...(excluded === null ? {} : { value: "excluded-region-ancestor" }),
    },
    // classifyExclusion:456 是 matches(自身) || querySelector(后代)——isSafeElement:205 只查后代,
    // 这里按 classifyExclusion 的口径(自身也算),unsafe-interactive 才有门可依。
    { gate: "unsafe-descendant", ok: !unsafeSelf && !unsafeChild },
    { gate: "hidden-ancestor", ok: element.closest(HIDDEN_SELECTOR) === null },
    { gate: "layout-visible", ok: isLayoutVisible(element) },
    { gate: "readable-words", ok: words > 0, value: words },
    { gate: "english-dominant", ok: ratio >= 0.6, value: Math.round(ratio * 100) / 100 },
    {
      gate: "min-auto-text-length",
      // 与 classifyExclusion:464-470 逐字同款:非 BLOCK 且非 CALLOUT 且 <20 才失败。
      ok:
        element.matches(BLOCK_SELECTOR) ||
        element.matches(CALLOUT_SELECTOR) ||
        text.length >= MINIMUM_AUTO_TEXT_LENGTH,
      value: text.length,
    },
    { gate: "block-candidate", ok: isBlockCandidate(element, true) },
  ];
}
