// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";
import { scanMarkdownBlocks } from "./preview";

function fixture(): HTMLElement {
  const container = document.createElement("div");
  container.innerHTML = `
    <h1 id="title">Understanding Grammar in Practice</h1>
    <p id="plain">The service validates every response before returning it.</p>
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

  it("skips code, tables, math, mermaid, footnotes, and interactive controls", () => {
    const container = fixture();
    const ids = scanMarkdownBlocks(container).map((block) => block.element.id);

    expect(ids).not.toContain("code");
    expect(ids).not.toContain("cell");
    expect(ids).not.toContain("math");
    expect(ids).not.toContain("mermaid");
    expect(ids).not.toContain("footnote");
    expect(ids).not.toContain("button");
    expect(ids).not.toContain("card");
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

  it("assigns stable block ids and marks elements", () => {
    const container = fixture();
    const blocks = scanMarkdownBlocks(container);

    for (const block of blocks) {
      expect(block.blockId).toMatch(/^english-syntax-block-\d+$/);
      expect(block.element.getAttribute("data-english-syntax-block")).toBe(block.blockId);
    }
  });
});
