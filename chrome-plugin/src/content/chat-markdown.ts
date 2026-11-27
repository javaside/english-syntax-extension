/**
 * 追问气泡的受限 markdown 渲染器（Chrome 端）。
 *
 * 设计边界（spec 2026-11-27-chat-markdown-rendering-design.md）:
 * - 子集 = 分段 / 六级内标题(统一 h4) / 无序+有序列表 / 围栏代码块 / 引用 /
 *   粗体 / 斜体 / 行内代码 / 段内换行;链接、嵌套列表、表格、下划线强调一律
 *   不支持——原样显示。
 * - XSS 面与纯 textContent 持平:所有内容只经 createElement / createTextNode /
 *   textContent,绝无 innerHTML——模型输出的 <script> 等天然变字面文本。
 * - 流式逐片全量重渲:未闭合的 ** 字面显示,未闭合的 ``` 围栏按代码块渲染到
 *   当前结尾,与闭合后的最终渲染保持一致。
 * - 产出元素只用语义标签、不发 class:样式由 ChatPanel 的 shadow DOM 选择器
 *   (.message.assistant p 等)承担。
 */

const FENCE_PREFIX = "```";
const HEADING_PATTERN = /^#{1,6}\s+/;
const BULLET_PATTERN = /^[-*+]\s+/;
const ORDERED_PATTERN = /^\d+\.\s+/;
const QUOTE_PATTERN = /^>\s?/;

/** 清空 target 后把 text 解析成受限 markdown 的 DOM 节点填入。 */
export function renderMarkdown(target: HTMLElement, text: string): void {
  target.replaceChildren();
  const doc = target.ownerDocument;
  const lines = text.split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.startsWith(FENCE_PREFIX)) {
      index += 1;
      const codeLines: string[] = [];
      while (index < lines.length && !lines[index]!.startsWith(FENCE_PREFIX)) {
        codeLines.push(lines[index]!);
        index += 1;
      }
      if (index < lines.length) index += 1; // 跳过闭围栏;未闭合则自然到结尾
      const code = doc.createElement("code");
      code.textContent = codeLines.join("\n");
      const pre = doc.createElement("pre");
      pre.append(code);
      target.append(pre);
      continue;
    }
    if (HEADING_PATTERN.test(line)) {
      const heading = doc.createElement("h4");
      heading.textContent = line.replace(HEADING_PATTERN, "");
      target.append(heading);
      index += 1;
      continue;
    }
    if (BULLET_PATTERN.test(line)) {
      index = renderList(target, doc, lines, index, "ul", BULLET_PATTERN);
      continue;
    }
    if (ORDERED_PATTERN.test(line)) {
      index = renderList(target, doc, lines, index, "ol", ORDERED_PATTERN);
      continue;
    }
    if (QUOTE_PATTERN.test(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length && QUOTE_PATTERN.test(lines[index]!)) {
        quoteLines.push(lines[index]!.replace(QUOTE_PATTERN, ""));
        index += 1;
      }
      const quote = doc.createElement("blockquote");
      quoteLines.forEach((quoteLine, position) => {
        if (position > 0) quote.append(doc.createElement("br"));
        appendInline(quote, quoteLine, doc);
      });
      target.append(quote);
      continue;
    }
    if (line.trim().length === 0) {
      index += 1;
      continue;
    }
    // 段落:聚到空行或任何块级起始行为止,段内换行渲染成 br
    const paragraphLines: string[] = [];
    while (index < lines.length) {
      const next = lines[index]!;
      if (next.trim().length === 0 || isBlockStart(next)) break;
      paragraphLines.push(next);
      index += 1;
    }
    const paragraph = doc.createElement("p");
    paragraphLines.forEach((paragraphLine, position) => {
      if (position > 0) paragraph.append(doc.createElement("br"));
      appendInline(paragraph, paragraphLine, doc);
    });
    target.append(paragraph);
  }
}

function isBlockStart(line: string): boolean {
  return (
    line.startsWith(FENCE_PREFIX) ||
    HEADING_PATTERN.test(line) ||
    BULLET_PATTERN.test(line) ||
    ORDERED_PATTERN.test(line) ||
    QUOTE_PATTERN.test(line)
  );
}

/** 从 start 起把连续同类列表行合并成一个 ul/ol,返回扫描停下的下标。 */
function renderList(
  target: HTMLElement,
  doc: Document,
  lines: readonly string[],
  start: number,
  tag: "ul" | "ol",
  pattern: RegExp,
): number {
  const list = doc.createElement(tag);
  let index = start;
  while (index < lines.length && pattern.test(lines[index]!)) {
    const item = doc.createElement("li");
    appendInline(item, lines[index]!.replace(pattern, ""), doc);
    list.append(item);
    index += 1;
  }
  target.append(list);
  return index;
}

/**
 * 行内解析:先扫反引号把行内代码摘出来(内容不做后续解析),普通段再递归
 * 找粗体、斜体。未配对的标记字符一律字面保留。
 */
function appendInline(parent: Node, text: string, doc: Document): void {
  let rest = text;
  while (rest.length > 0) {
    const opening = rest.indexOf("`");
    if (opening === -1) {
      appendEmphasis(parent, rest, doc);
      break;
    }
    if (opening > 0) appendEmphasis(parent, rest.slice(0, opening), doc);
    const closing = rest.indexOf("`", opening + 1);
    if (closing === -1) {
      parent.appendChild(doc.createTextNode(rest.slice(opening)));
      break;
    }
    const content = rest.slice(opening + 1, closing);
    if (content.length === 0) {
      // 空行内代码:两个反引号字面保留
      parent.appendChild(doc.createTextNode(rest.slice(opening, closing + 1)));
    } else {
      const code = doc.createElement("code");
      code.textContent = content;
      parent.appendChild(code);
    }
    rest = rest.slice(closing + 1);
  }
}

/** 粗体优先、斜体其次的递归强调解析;找不到配对就整段按纯文本。 */
function appendEmphasis(parent: Node, text: string, doc: Document): void {
  const pair = findEmphasisPair(text);
  if (pair === null) {
    if (text.length > 0) parent.appendChild(doc.createTextNode(text));
    return;
  }
  appendEmphasis(parent, text.slice(0, pair.start), doc);
  const content = text.slice(pair.start + pair.width, pair.end);
  if (pair.width === 3) {
    // 三星 = 斜体套粗体(与 CommonMark 的 ***x*** 一致)
    const em = doc.createElement("em");
    const strong = doc.createElement("strong");
    appendEmphasis(strong, content, doc);
    em.append(strong);
    parent.appendChild(em);
  } else {
    const element = doc.createElement(pair.width === 2 ? "strong" : "em");
    appendEmphasis(element, content, doc);
    parent.appendChild(element);
  }
  appendEmphasis(parent, text.slice(pair.end + pair.width), doc);
}

/**
 * 找下一对强调标记——按「星号游程」整体判定,不按单字符配对:开游程后不得紧跟
 * 空白、闭游程前不得紧邻空白(侧翼规则,`2 * 3` 的乘号因此不成对),且**两侧游程
 * 长度必须相等**——游程内不再单独配对(`** 空格 **`、`***重要**` 这类残缺组合
 * 整段字面,不产出吞标记的畸形 em)。宽度 1=斜体、2=粗体、3=斜体套粗体;
 * 超过 3 的游程不解析(子集外,字面)。
 */
function findEmphasisPair(text: string): { start: number; end: number; width: number } | null {
  for (let start = 0; start < text.length;) {
    if (text[start] !== "*") {
      start += 1;
      continue;
    }
    let runEnd = start;
    while (runEnd < text.length && text[runEnd] === "*") runEnd += 1;
    const width = runEnd - start;
    // 开游程:后跟非空白,宽度 1..3
    if (width <= 3 && runEnd < text.length && !isWhitespace(text[runEnd]!)) {
      for (let end = runEnd + 1; end + width <= text.length;) {
        if (text[end] !== "*") {
          end += 1;
          continue;
        }
        let closeRunEnd = end;
        while (closeRunEnd < text.length && text[closeRunEnd] === "*") {
          closeRunEnd += 1;
        }
        // 闭游程:等长且前邻非空白;不等长就跳过整条游程再找
        if (closeRunEnd - end === width && !isWhitespace(text[end - 1]!)) {
          return { start, end, width };
        }
        end = closeRunEnd;
      }
    }
    start = runEnd; // 这条游程当不成开标记,跳过整条
  }
  return null;
}

function isWhitespace(character: string): boolean {
  return /\s/.test(character);
}
