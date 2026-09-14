/**
 * 科学 DOM 文本归一化:把一个元素读成「送给句子层」的纯文本。
 *
 * 与直接拼接所有可见文本节点的旧做法不同,这一层用 DOM 语义处理科学文档:
 *
 * 1. 普通可见 Text 按 DOM 顺序保留;
 * 2. `<math>` 一律产出「剔除辅助子树后的可见 MathML 文本」——LaTeXML 的
 *    `alttext` 恒为 TeX 源码(`H_{0}`、`\Lambda`),采它会把 TeX 语法污染进
 *    句文本、Token 与页面显示,2026-09-12 真机实测 79/1548 个成分含反斜杠
 *    后弃用。可见文本是排好版的(`H0`、`Λ`),与用户所见一致;
 * 3. `<annotation>`、`<annotation-xml>`、`aria-hidden` 辅助内容、`<mphantom>`
 *    不可见占位不与可见公式重复;
 * 4. Unicode 空白统一折叠为单个空格。
 *
 * 刻意不做的事:不解析 TeX、不翻译公式、不按 URL 分支。内联数学保留为可重建的
 * 原子片段——删除它会让英文语法与缓存键失真。
 *
 * 能力边界:输出是**选定 MathML 表示树的文本线性化**,不等价于数学语义,也不
 * 保证保留由布局或元素语义生成的全部符号(mfrac 分子分母、上下标按 DOM 文本
 * 顺序线性拼接;msqrt/mfenced 的结构性符号不生成)。Token 重建只保证该线性化
 * 文本可逆,不保证源公式可逆。
 */

/** 这些子树的内容不参与「可见文本」:公式辅助信息、辅助技术回退、不可见占位。 */
const AUXILIARY_SELECTOR =
  "annotation,annotation-xml,semantics>annotation,[aria-hidden='true'],mphantom";

/**
 * 脚注容器整棵排除。LaTeXML 把脚注写成正文句号后紧跟的
 * `<span class="ltx_role_footnote"><sup class="ltx_note_mark">2</sup>…</span>`,
 * 里面还带一份脚注正文。若把它的文本拼进来,正文句末就变成 `uncertainties.2`,
 * 分句器会当成小数/版本号而拒绝在句号处断句,两句粘成一个畸形长句,
 * 模型只能硬划并失败(2026-09-14 真机 97 词失败句即此形态)。
 */
const FOOTNOTE_SELECTOR =
  ".ltx_role_footnote,[role='doc-footnote'],sup.ltx_note_mark,section.footnotes";

function isHiddenElement(element: Element): boolean {
  if (element.matches("[hidden],[aria-hidden='true']")) return true;
  const style = getComputedStyle(element);
  return (
    style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse"
  );
}

function isSkippedMathAncestor(ancestor: Element, math: Element): boolean {
  if (ancestor.closest(AUXILIARY_SELECTOR) !== null) return true;
  // 嵌套 <math> 本身不是排除理由:它的文本节点由外层 walker 一并读到。
  // 真正要跳过的是「属于另一个 math 子树」的节点——那不会出现在本 walker 里。
  if (ancestor.closest("math") === null) return true; // math 外层(防御:walker 已限定)
  // math 内部的隐藏后代(mrow display:none 等)整棵子树阻断。
  return ancestor !== math && isHiddenElement(ancestor);
}

function visibleMathText(math: Element): string {
  // 递归读可见 MathML 文本:TreeWalker 拿文本节点,逐个向上检查祖先是否被排除。
  let text = "";
  const walker = math.ownerDocument.createTreeWalker(math, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    let skipped = false;
    for (
      let ancestor: Element | null = node.parentElement;
      ancestor !== null && ancestor !== math.parentElement;
      ancestor = ancestor.parentElement
    ) {
      if (ancestor !== math && isSkippedMathAncestor(ancestor, math)) {
        skipped = true;
        break;
      }
      if (ancestor === math) break;
    }
    if (!skipped) text += node.textContent ?? "";
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
    into.text += visibleMathText(node);
    return;
  }
  if (node.matches(AUXILIARY_SELECTOR)) return;
  if (node.matches(FOOTNOTE_SELECTOR)) return;
  for (const child of Array.from(node.childNodes)) appendReadableText(child, into);
}

/**
 * 读取元素的可读文本。注意:根元素**自身**的隐藏状态不在职责内——inventory 需要
 * 为 hidden/math-auxiliary 排除项登记完整文本,可见性分类属于 inventory 层。
 */
export function normalizedReadableText(element: Element): string {
  const accumulator = { text: "" };
  if (element.tagName.toLowerCase() === "math") {
    accumulator.text += visibleMathText(element);
  } else {
    for (const child of Array.from(element.childNodes)) appendReadableText(child, accumulator);
  }
  return accumulator.text.replace(/\s+/gu, " ").trim();
}
