/**
 * 科学 DOM 文本归一化:把一个元素读成「送给句子层」的纯文本。
 *
 * 与直接拼接所有可见文本节点的旧做法不同,这一层用 DOM 语义处理科学文档:
 *
 * 1. 普通可见 Text 按 DOM 顺序保留;
 * 2. `<math>` 只产出**一个**稳定表示——优先 `alttext`,否则剔除辅助子树后的可见
 *    MathML 文本——并且在 math 处停止递归,绝不把公式渲染文本与 annotation、
 *    assistive fallback 一起收入(那会让同一公式在句文本里出现两三遍);
 * 3. `<annotation>`、`aria-hidden` 辅助内容不与可见公式重复;
 * 4. Unicode 空白统一折叠为单个空格。
 *
 * 刻意不做的事:不解析 TeX、不翻译公式、不按 URL 分支。内联数学保留为可重建的
 * 原子片段——删除它会让英文语法与缓存键失真。
 */

/** 这些子树的内容不参与「可见文本」:它们是公式辅助信息或辅助技术回退。 */
const AUXILIARY_SELECTOR = "annotation,semantics>annotation,[aria-hidden='true']";

function isHiddenElement(element: Element): boolean {
  if (element.matches("[hidden],[aria-hidden='true']")) return true;
  const style = getComputedStyle(element);
  return (
    style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse"
  );
}

function visibleMathText(math: Element): string {
  // 无 alttext 时剔除 annotation/assistive 子树,把剩余可见 MathML 文本读一遍。
  let text = "";
  const walker = math.ownerDocument.createTreeWalker(math, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (parent === null) continue;
    if (parent.closest(AUXILIARY_SELECTOR) !== null) continue;
    if (parent.closest("math") !== math) continue;
    text += node.textContent ?? "";
  }
  return text;
}

function appendReadableText(node: Node, into: { text: string }): void {
  if (node.nodeType === Node.TEXT_NODE) {
    into.text += node.textContent ?? "";
    return;
  }
  if (!(node instanceof Element)) return;
  if (isHiddenElement(node)) return;
  if (node.tagName.toLowerCase() === "math") {
    into.text += node.getAttribute("alttext") ?? visibleMathText(node);
    return;
  }
  if (node.matches(AUXILIARY_SELECTOR)) return;
  for (const child of Array.from(node.childNodes)) appendReadableText(child, into);
}

/**
 * 读取元素的可读文本。注意:根元素**自身**的隐藏状态不在职责内——inventory 需要
 * 为「hidden」排除项登记完整文本,可见性分类属于 inventory 层。
 */
export function normalizedReadableText(element: Element): string {
  const accumulator = { text: "" };
  // 根元素自身的「隐藏 / 辅助」身份刻意不判:inventory 要为 hidden/math-auxiliary
  // 排除项登记完整文本,分类是调用方的职责。只有后代才参与跳过。
  if (element.tagName.toLowerCase() === "math") {
    accumulator.text += element.getAttribute("alttext") ?? visibleMathText(element);
  } else {
    for (const child of Array.from(element.childNodes)) appendReadableText(child, accumulator);
  }
  return accumulator.text.replace(/\s+/gu, " ").trim();
}
