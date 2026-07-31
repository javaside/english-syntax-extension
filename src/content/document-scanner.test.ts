// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { nearestSafeBlock, scanDocument } from "./document-scanner";

const fixturePaths = {
  article: "tests/fixtures/pages/article.html",
  interactive: "tests/fixtures/pages/interactive.html",
} as const;

function fixture(name: keyof typeof fixturePaths): string {
  return readFileSync(fixturePaths[name], "utf8");
}

describe("scanDocument", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("skips an incidental article without eligible content before the real main", () => {
    document.body.innerHTML = fixture("article");

    const blocks = scanDocument(document);

    // 段内插图不影响可逆渲染(原节点只是被 display:none 藏起来),所以 #with-image
    // 是正文候选;#with-button 带交互控件,仍然排除。
    expect(blocks.map(({ element }) => element.id || element.tagName)).toEqual([
      "intro",
      "linked",
      "quote",
      "list-item",
      "with-image",
    ]);
    expect(
      blocks.every(({ element }) => /^(?:H[1-6]|P|LI|BLOCKQUOTE)$/u.test(element.tagName)),
    ).toBe(true);
    expect(blocks.map(({ text }) => text)).toContain(
      "This English paragraph contains a helpful reference link for readers.",
    );
  });

  it("chooses the only semantic root containing valid safe English candidates", () => {
    document.body.innerHTML = `
      <article>
        <h2>Short note</h2>
        <form><p>This otherwise eligible English text is unsafe form content.</p></form>
        <p>This paragraph includes an unsafe <button>interactive control</button>.</p>
      </article>
      <div role="main">
        <p id="qualified-root-copy">This safe English paragraph belongs to the qualified semantic root.</p>
      </div>`;

    expect(scanDocument(document).map(({ element }) => element.id)).toEqual([
      "qualified-root-copy",
    ]);
  });

  it("re-picks the principal root on every scan instead of caching a stale one", () => {
    document.body.innerHTML = fixture("article");
    document.querySelector("#incidental-article")!.remove();
    scanDocument(document);
    const laterMainCopy = document.createElement("p");
    laterMainCopy.id = "later-main-copy";
    laterMainCopy.textContent =
      "This later English paragraph is directly inside main but outside the nested article.";
    document.querySelector("main")!.append(laterMainCopy);

    // 曾经缓存过一次正文容器,SPA 换内容后就再也认不出新段落。重扫必须重算。
    expect(scanDocument(document).map(({ element }) => element.id)).toContain("later-main-copy");
  });

  it("uses a text-density fallback and penalizes link-heavy navigation", () => {
    document.body.innerHTML = `
      <div id="link-farm">
        <p><a href="#1">First linked navigation destination with repeated words</a></p>
        <p><a href="#2">Second linked navigation destination with repeated words</a></p>
      </div>
      <section id="story">
        <p id="fallback-one">A patient writer explains the central idea with clear supporting details.</p>
        <p id="fallback-two">The following paragraph develops the argument for careful English readers.</p>
      </section>`;

    expect(scanDocument(document).map(({ element }) => element.id)).toEqual([
      "fallback-one",
      "fallback-two",
    ]);
  });

  it("requires twenty visible characters and English-dominant letter words in automatic mode", () => {
    document.body.innerHTML = `<main>
      <h2 id="short">Brief heading</h2>
      <p id="mixed">这是 一个 中文 句子 avec quelques mots English</p>
      <p id="glued">abc中文 def中文 ghi中文 jkl中文 mno中文 pqr中文</p>
      <p id="hidden-tail">Brief text <span hidden>with a long hidden English continuation</span></p>
      <p id="english">English readers can reliably recognize this sufficiently long sentence.</p>
    </main>`;

    expect(scanDocument(document).map(({ element }) => element.id)).toEqual(["english"]);
  });

  it("assigns stable WeakMap IDs without changing page attributes", () => {
    document.body.innerHTML = `<main><p id="copy">This English paragraph is deliberately long enough for automatic scanning.</p></main>`;
    const element = document.querySelector("#copy")!;
    const attributes = element.getAttributeNames();

    const first = scanDocument(document)[0];
    const second = scanDocument(document)[0];

    expect(first?.id).toBe(second?.id);
    expect(first?.id).toMatch(/^block-\d+$/u);
    expect(element.getAttributeNames()).toEqual(attributes);
  });
});

describe("nearestSafeBlock", () => {
  beforeEach(() => {
    document.body.innerHTML = fixture("interactive");
  });

  it("walks from a descendant to the nearest safe block", () => {
    scanDocument(document);
    const safe = document.querySelector("#safe")!;
    const child = document.createElement("span");
    child.textContent = "chosen words";
    safe.append(child);

    expect(nearestSafeBlock(child)?.element).toBe(safe);
  });

  it("lets a short block outside the principal root through", () => {
    const short = document.querySelector("#outside-short")!;

    expect(nearestSafeBlock(short)?.text).toBe("Tiny English text");
  });

  it("never accepts selection in editable or password content", () => {
    expect(nearestSafeBlock(document.querySelector("#editable"))).toBeNull();
    expect(nearestSafeBlock(document.querySelector("#password"))).toBeNull();
    expect(nearestSafeBlock(document.querySelector("#nested-input"))).toBeNull();
  });
});

/**
 * 快捷键/右键指到的段落是用户显式手势,和自动扫描的取舍不同:自动扫描要躲开
 * 边栏与样板文字,显式手势的歧义已经由用户的鼠标消解掉了。这些用例锁住
 * 「鼠标明明在段落上却报『未找到可解析的段落』」的各条成因。
 */
describe("nearestSafeBlock on an explicit gesture", () => {
  const LONG = "This paragraph carries plenty of ordinary English words for the reader.";

  function build(markup: string): void {
    document.body.replaceChildren();
    document.body.insertAdjacentHTML("afterbegin", markup);
  }

  function hover(selector: string): ReturnType<typeof nearestSafeBlock> {
    return nearestSafeBlock(document.querySelector(selector));
  }

  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("accepts a paragraph outside the highest scoring semantic root", () => {
    build(`<article><p>${LONG} ${LONG} ${LONG}</p></article>
           <article><p id="target">${LONG}</p></article>`);
    scanDocument(document);

    expect(hover("#target")?.element.id).toBe("target");
  });

  it("accepts a paragraph after the cached principal root goes stale", () => {
    build(`<main><p>${LONG} ${LONG}</p></main>`);
    scanDocument(document);
    build(`<main><p id="target">${LONG}</p></main>`);

    expect(hover("#target")?.element.id).toBe("target");
  });

  it("accepts a paragraph shorter than the automatic minimum", () => {
    build(`<main><p id="target">Tiny English text</p></main>`);

    expect(hover("#target")?.text).toBe("Tiny English text");
  });

  it("accepts a paragraph holding an inline image", () => {
    build(`<main><p id="target">${LONG} <img src="i.png" alt="i" /> tail.</p></main>`);

    expect(hover("#target")?.element.id).toBe("target");
  });

  it("accepts a leaf div used as a paragraph", () => {
    build(`<main><div id="target">${LONG}</div></main>`);

    expect(hover("#target")?.element.id).toBe("target");
  });

  it("climbs past an inline wrapper to the leaf div paragraph", () => {
    build(`<main><div id="target"><span id="inner">${LONG}</span></div></main>`);

    expect(hover("#inner")?.element.id).toBe("target");
  });

  it("refuses a wrapper div that holds other blocks", () => {
    build(`<main><div id="wrapper"><p>${LONG}</p><p>${LONG}</p></div></main>`);

    expect(hover("#wrapper")).toBeNull();
  });

  it("still refuses interactive, excluded and non-English content", () => {
    build(`<main>
      <p id="control">${LONG} <button>Copy</button></p>
      <nav><p id="navigation">${LONG}</p></nav>
      <pre><p id="code">${LONG}</p></pre>
      <p id="chinese">这是一个完全由中文写成的段落，没有任何英文词。</p>
    </main>`);

    expect(hover("#control")).toBeNull();
    expect(hover("#navigation")).toBeNull();
    expect(hover("#code")).toBeNull();
    expect(hover("#chinese")).toBeNull();
  });

  // Mintlify 一类文档站(含 Claude Code 文档)整篇正文都是 <span data-as="p">,
  // 靠 CSS 渲染成块。只按标签名认块会把这类站点全判成「未找到可解析的段落」。
  it("accepts an inline tag that renders as a block", () => {
    build(`<main><span data-as="p" style="display: block">${LONG}</span></main>`);

    expect(hover("span")?.text).toBe(LONG);
  });

  it("picks the span paragraph rather than the content container wrapping it", () => {
    build(`<div id="content">
      <span data-as="p" style="display: block">${LONG}</span>
      <span data-as="p" style="display: block">Another paragraph of plain English words.</span>
      <div><button>Copy page</button></div>
    </div>`);

    expect(hover("span")?.element.tagName.toLowerCase()).toBe("span");
  });

  it("does not mistake a genuinely inline span for a paragraph", () => {
    build(`<main><p id="host">${LONG} <span id="inline">emphasised</span></p></main>`);

    expect(hover("#inline")?.element.id).toBe("host");
  });

  it("keeps automatic scanning off block-rendered inline tags", () => {
    build(`<main>
      <span data-as="p" style="display: block">${LONG}</span>
      <p id="strict">${LONG}</p>
    </main>`);

    expect(scanDocument(document).map(({ element }) => element.id)).toEqual(["strict"]);
  });

  it("keeps automatic scanning off the loose div blocks", () => {
    build(`<main>
      <div id="loose">${LONG}</div>
      <p id="strict">${LONG}</p>
    </main>`);

    expect(scanDocument(document).map(({ element }) => element.id)).toEqual(["strict"]);
  });
});
