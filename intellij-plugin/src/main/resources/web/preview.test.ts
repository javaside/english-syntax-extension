// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deepestHovered,
  ensureBlockId,
  HOVER_CHAIN_SELECTOR,
  nearestPreviewBlock,
  observeBlocks,
  resetScanRegistry,
  scanMarkdownBlocks,
} from "./preview";

function fixture(): HTMLElement {
  const container = document.createElement("div");
  container.innerHTML = `
    <h1 id="title">Understanding Grammar in Practice</h1>
    <p id="plain">The service validates every response before returning it.</p>
    <hard-gate id="hard-gate">Do not implement anything until your human partner approves the design.</hard-gate>
    <extremely-important id="important">Always preserve the complete instruction when translating this document.</extremely-important>
    <ul>
      <li id="list-item-1">Readers parse sentences quickly and accurately.</li>
      <li id="list-item-short">Too short.</li>
    </ul>
    <blockquote id="quote">
      <p id="quote-inner">Well-designed tools reduce the cognitive load of reading.</p>
    </blockquote>
    <pre><code id="code">const answer = theService.validates(everyResponse);</code></pre>
    <table><tr><td id="cell">The table cell text is long enough here.</td></tr></table>
    <div class="math" id="math">E equals m times c squared with extra words.</div>
    <div class="mermaid" id="mermaid">graph TD; A --> B with english words too.</div>
    <div class="footnotes" id="footnote"><p>Some footnote text that is english and long.</p></div>
    <button id="button">A button with plenty of english text inside it.</button>
    <div id="nested"><p id="nested-inner">Nested paragraph inside a wrapper div here.</p></div>
    <div data-english-syntax-card="true" id="card">Previously rendered card content here.</div>
    <p id="chinese">这一段是中文内容，没有足够的英文单词比例。</p>
  `;
  document.body.append(container);
  return container;
}

describe("scanMarkdownBlocks", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("collects safe leaf blocks only", () => {
    const container = fixture();
    const blocks = scanMarkdownBlocks(container);

    const ids = blocks.map((block) => block.element.id);
    expect(ids).toContain("title");
    expect(ids).toContain("plain");
    expect(ids).toContain("list-item-1");
    expect(ids).toContain("quote-inner");
    expect(ids).toContain("nested-inner");
  });

  it("collects text wrapped by hyphenated custom elements", () => {
    const container = fixture();
    const blocks = scanMarkdownBlocks(container);

    expect(blocks.find((block) => block.element.id === "hard-gate")?.text).toBe(
      "Do not implement anything until your human partner approves the design.",
    );
    expect(blocks.find((block) => block.element.id === "important")?.text).toBe(
      "Always preserve the complete instruction when translating this document.",
    );
  });

  it("skips code, math, mermaid, and interactive controls", () => {
    const container = fixture();
    const ids = scanMarkdownBlocks(container).map((block) => block.element.id);

    expect(ids).not.toContain("code");
    expect(ids).not.toContain("math");
    expect(ids).not.toContain("mermaid");
    expect(ids).not.toContain("button");
    expect(ids).not.toContain("card");
    // 表格的语义子单元（自然语言 td）现在是候选；表格/脚注容器本身仍是结构壳。
    expect(ids).toContain("cell");
  });

  it("skips short blocks and blocks below the english ratio", () => {
    const container = fixture();
    const ids = scanMarkdownBlocks(container).map((block) => block.element.id);

    expect(ids).not.toContain("list-item-short");
    expect(ids).not.toContain("chinese");
  });

  it("does not register the same element twice", () => {
    const container = fixture();
    const first = scanMarkdownBlocks(container);
    const second = scanMarkdownBlocks(container);

    expect(second).toHaveLength(0);
    expect(first.length).toBeGreaterThan(0);
  });

  it("resetScanRegistry lets rescan rediscover all blocks after reinitialize", () => {
    const container = fixture();
    const first = scanMarkdownBlocks(container);
    expect(first.length).toBeGreaterThan(0);

    // 再次点开始（重新 initialize）：清空注册表后应能重新扫描出全部块，
    // 否则失败句永远无法重派（真机「失败后再点开始不动」）。
    resetScanRegistry();
    const rediscovered = scanMarkdownBlocks(container);
    expect(rediscovered.length).toBeGreaterThan(0);
  });

  it("assigns stable block ids and marks elements", () => {
    const container = fixture();
    const blocks = scanMarkdownBlocks(container);

    for (const block of blocks) {
      expect(block.blockId).toMatch(/^english-syntax-block-\d+$/);
      expect(block.element.getAttribute("data-english-syntax-block")).toBe(block.blockId);
    }
  });
});

/** 语义文档块 fixture：标题/定义列表/表格/图注/脚注，及其代码/数学/公式/非英文反例。 */
function semanticFixture(): HTMLElement {
  const container = document.createElement("div");
  container.innerHTML = `
    <h3 id="short-h3">Overview</h3>
    <dl>
      <dt id="term">Chat Model</dt>
      <dd id="definition">A model that processes conversational prompts.</dd>
      <dt id="cn-term">参数</dt>
    </dl>
    <table>
      <caption id="caption">Supported model capabilities</caption>
      <thead>
        <tr><th id="header">Capability</th></tr>
        <tr><th id="cn-header">仅供测试</th><th id="en-header">API</th></tr>
      </thead>
      <tbody>
        <tr>
          <td id="natural-cell">Portable chat completion API</td>
          <td class="math" id="formula-cell">p(z | Lambda)</td>
          <td id="symbol-cell">λ = 3.2 ± 0.4</td>
          <td id="chinese-cell">仅供测试</td>
          <td id="cell-with-p"><p id="inner-p">A natural language sentence inside a table cell.</p></td>
        </tr>
      </tbody>
    </table>
    <figure>
      <img alt="diagram" />
      <figcaption id="figure-caption">A figure caption with enough English words.</figcaption>
    </figure>
    <figure>
      <figcaption><p id="figure-caption-p">A caption paragraph inside a figure caption wrapper.</p></figcaption>
    </figure>
    <div class="footnotes"><p id="footnote-p">Some footnote text that is english and long enough here.</p></div>
    <pre><code id="code">const answer = theService.validates(everyResponse);</code></pre>
    <div class="math" id="math">E equals m times c squared with extra words.</div>
    <div class="mermaid" id="mermaid">graph TD; A --> B with english words too.</div>
    <button id="button">A button with plenty of english text inside it.</button>
    <div data-english-syntax-card="true" id="card">Previously rendered card content here.</div>
  `;
  document.body.append(container);
  return container;
}

describe("scanMarkdownBlocks semantic document blocks", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  const ids = (): string[] =>
    scanMarkdownBlocks(semanticFixture()).map((block) => block.element.id);

  it("collects short headings, definition terms and bodies, captions, and table headers", () => {
    expect(ids()).toEqual(expect.arrayContaining(["short-h3", "term", "definition", "caption", "header"]));
  });

  it("short semantic tags skip only the length gate, not the english ratio", () => {
    const found = ids();
    // 短语义英文（th "API"，3 字符 <20）被收录：门只豁免长度，不豁免英文占比。
    expect(found).toContain("en-header");
    // 短语义中文（dt "参数" / th "仅供测试"）仍被英文占比拦下，不会被收录。
    expect(found).not.toContain("cn-term");
    expect(found).not.toContain("cn-header");
  });

  it("collects natural-language table cells and inner paragraphs, skipping formula/symbol/chinese cells", () => {
    const found = ids();
    expect(found).toContain("natural-cell");
    expect(found).toContain("inner-p");
    // td>p 只进叶子 p，td 容器不再单独成块。
    expect(found).not.toContain("cell-with-p");
    expect(found).not.toContain("formula-cell");
    expect(found).not.toContain("symbol-cell");
    expect(found).not.toContain("chinese-cell");
  });

  it("collects figure captions, inner caption paragraphs, and footnote paragraphs", () => {
    expect(ids()).toEqual(expect.arrayContaining(["figure-caption", "figure-caption-p", "footnote-p"]));
  });

  it("still skips code, math, mermaid, interactive controls, and cards", () => {
    const found = ids();
    expect(found).not.toContain("code");
    expect(found).not.toContain("math");
    expect(found).not.toContain("mermaid");
    expect(found).not.toContain("button");
    expect(found).not.toContain("card");
  });
});

describe("observeBlocks", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("reports geometrically visible blocks immediately even if IntersectionObserver never fires its initial callback", () => {
    // 真机踩坑：JCEF 的 IntersectionObserver 初始回调不可靠（observe 后不产生 entries），
    // start() 只重发当前 Set（空集）→ VISIBLE_BLOCKS 永远不发出 → 点开始后毫无翻译。
    // 守卫：start() 必须用几何判定（getBoundingClientRect 与视口求交）播种可见集合，
    // IntersectionObserver 只负责之后的增量更新。
    const container = fixture();
    const blocks = scanMarkdownBlocks(container);
    expect(blocks.length).toBeGreaterThan(0);

    // 模拟一个「永不回调」的 IntersectionObserver。
    const observe = vi.fn();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(_callback: IntersectionObserverCallback) {
          void _callback;
        }
        observe = observe;
        disconnect(): void {}
        unobserve(): void {}
        takeRecords(): IntersectionObserverEntry[] {
          return [];
        }
        readonly root = null;
        readonly rootMargin = "";
        readonly thresholds = [];
      },
    );

    try {
      const reported: number[] = [];
      const visibility = observeBlocks(container, blocks, (visible) => {
        reported.push(visible.length);
      });
      visibility.start();

      // 立即同步回调一次，且含几何可见的块（happy-dom 中 rect 全 0，仍在 ±一屏窗口内）。
      expect(reported.length).toBeGreaterThan(0);
      expect(reported[0]).toBeGreaterThan(0);
      visibility.stop();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

function el(
  tag: string,
  id: string,
  text: string,
  attrs: Record<string, string> = {},
): HTMLElement {
  const node = document.createElement(tag);
  node.id = id;
  node.textContent = text;
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  return node;
}

describe("nearestPreviewBlock", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  function hoverFixture(): void {
    const container = document.createElement("div");
    container.append(el("p", "para", "The service validates every response before returning it."));
    container.append(el("p", "short", "Too short."));
    container.append(el("p", "chinese", "这一段几乎没有英文单词，只有少量 API 术语。"));
    container.append(
      el(
        "hard-gate",
        "hard-gate-hover",
        "Do not implement anything until your human partner approves the design.",
      ),
    );

    const inlineHost = el("p", "inline-host", "Wrapped ");
    inlineHost.append(el("em", "em", "emphasis"));
    container.append(inlineHost);

    // Mintlify 一类文档站整篇正文都是 <span>，外层 div 才是渲染盒子。
    const spanBlock = el("div", "span-block", "");
    spanBlock.append(el("span", "span-inner", "Docs sites render body text as spans."));
    container.append(spanBlock);
    const pre = document.createElement("pre");
    pre.append(el("code", "code", "const answer = theService.validates(everyResponse);"));
    container.append(pre);

    const table = document.createElement("table");
    const row = document.createElement("tr");
    row.append(el("td", "cell", "The table cell text is long enough here."));
    table.append(row);
    container.append(table);

    const card = el("div", "card", "", { "data-english-syntax-card": "true" });
    card.append(el("span", "in-card", "Rendered card text."));
    container.append(card);

    container.append(el("textarea", "editor", "Some text"));

    const editableHost = el("div", "editable-host", "", { contenteditable: "true" });
    editableHost.append(el("p", "editable", "Editable paragraph text here."));
    container.append(editableHost);

    document.body.append(container);
  }

  const at = (id: string): HTMLElement => document.getElementById(id)!;

  it("returns the hovered leaf block itself", () => {
    hoverFixture();
    expect(nearestPreviewBlock(at("para"))?.id).toBe("para");
  });

  it("walks up from an inline descendant to its block", () => {
    hoverFixture();
    expect(nearestPreviewBlock(at("em"))?.id).toBe("inline-host");
  });

  it("accepts a div whose only children are inline", () => {
    hoverFixture();
    expect(nearestPreviewBlock(at("span-inner"))?.id).toBe("span-block");
  });

  it("accepts a hovered hyphenated custom element even when the browser renders it inline", () => {
    hoverFixture();
    expect(nearestPreviewBlock(at("hard-gate-hover"))?.id).toBe("hard-gate-hover");
  });

  it("accepts short and non-english blocks that the auto scanner would skip", () => {
    // 显式手势不套用自动扫描的 20 字符 / 英文占比门槛。
    hoverFixture();
    expect(nearestPreviewBlock(at("short"))?.id).toBe("short");
    expect(nearestPreviewBlock(at("chinese"))?.id).toBe("chinese");
  });

  it("refuses code, tables, our own cards, and editable regions", () => {
    hoverFixture();
    expect(nearestPreviewBlock(at("code"))).toBeNull();
    expect(nearestPreviewBlock(at("cell"))).toBeNull();
    expect(nearestPreviewBlock(at("in-card"))).toBeNull();
    expect(nearestPreviewBlock(at("editor"))).toBeNull();
    expect(nearestPreviewBlock(at("editable"))).toBeNull();
  });

  it("handles null and text nodes", () => {
    hoverFixture();
    expect(nearestPreviewBlock(null)).toBeNull();
    expect(nearestPreviewBlock(at("para").firstChild)?.id).toBe("para");
  });
});

/**
 * quirks 模式（预览页 HTML 由 IDEA 生成，doctype 有无不由我们说了算）下 Chromium 只让链接
 * 匹配裸 `:hover`，`querySelectorAll(":hover")` 整页恒为空集，按快捷键只会得到「未找到可
 * 解析的段落」。实测同一 quirks 页面同一位置：`:hover` → 空，`:is(:hover)` → 完整悬停链。
 * happy-dom 不实现该 quirk，所以这里钉的是「查的到底是哪个选择器」。
 */
describe("deepestHovered", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("查的是 :is(:hover) 而不是裸 :hover", () => {
    expect(HOVER_CHAIN_SELECTOR).toBe(":is(:hover)");
    const outer = el("div", "outer", "");
    const inner = el("p", "inner", "Hovered paragraph.");
    outer.append(inner);
    document.body.append(outer);
    const chain = vi
      .spyOn(document, "querySelectorAll")
      .mockReturnValue([outer, inner] as unknown as ReturnType<Document["querySelectorAll"]>);

    try {
      expect(deepestHovered(document)?.id).toBe("inner");
      expect(chain).toHaveBeenCalledWith(":is(:hover)");
    } finally {
      chain.mockRestore();
    }
  });

  it("伪类不被支持时查询抛错也只当没悬停", () => {
    const chain = vi.spyOn(document, "querySelectorAll").mockImplementation(() => {
      throw new Error("unsupported pseudo-class");
    });

    try {
      expect(deepestHovered(document)).toBeNull();
    } finally {
      chain.mockRestore();
    }
  });
});

describe("ensureBlockId", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("assigns and persists a block id", () => {
    const element = el("p", "solo", "Anything.");
    document.body.append(element);

    const blockId = ensureBlockId(element);
    expect(blockId).toMatch(/^english-syntax-block-\d+$/);
    expect(element.getAttribute("data-english-syntax-block")).toBe(blockId);
    expect(ensureBlockId(element)).toBe(blockId);
  });

  it("shares the id counter with scanMarkdownBlocks so ids never collide", () => {
    const container = document.createElement("div");
    container.append(el("p", "a", "Alpha paragraph long enough for the scanner to accept it."));
    container.append(el("p", "b", "Beta paragraph long enough for the scanner to accept it."));
    document.body.append(container);

    // 显式路径先给 #a 分配 id，随后自动扫描应沿用它、并给 #b 一个不同的新 id。
    const manual = ensureBlockId(document.getElementById("a")!);
    const ids = scanMarkdownBlocks(container).map((block) => block.blockId);

    expect(ids).toContain(manual);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
