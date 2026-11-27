// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./chat-markdown";

/** 渲染进一个新 div 并返回它,断言都对着这个 target 的 DOM 结构。 */
function render(text: string): HTMLDivElement {
  const target = document.createElement("div");
  renderMarkdown(target, text);
  return target;
}

describe("renderMarkdown", () => {
  it("纯文本渲染成单个 p,段内单个换行变成 br 且前后文本分段", () => {
    const plain = render("你好世界");
    expect(plain.children.length).toBe(1);
    expect(plain.children[0]!.tagName).toBe("P");
    expect(plain.children[0]!.textContent).toBe("你好世界");

    const wrapped = render("第一行\n第二行");
    const paragraph = wrapped.querySelector("p")!;
    expect(paragraph.firstChild!.textContent).toBe("第一行");
    expect(paragraph.children[0]!.tagName).toBe("BR");
    expect(paragraph.lastChild!.textContent).toBe("第二行");
  });

  it("空行分段:两个 p", () => {
    const target = render("甲\n\n乙");
    const paragraphs = target.querySelectorAll("p");
    expect(paragraphs.length).toBe(2);
    expect(paragraphs[0]!.textContent).toBe("甲");
    expect(paragraphs[1]!.textContent).toBe("乙");
  });

  it("行内标记:加粗、斜体、行内代码", () => {
    const bold = render("前**加粗**后");
    expect(bold.querySelector("strong")!.textContent).toBe("加粗");

    const italic = render("前*斜体*后");
    expect(italic.querySelector("em")!.textContent).toBe("斜体");

    const code = render("前`代码`后");
    expect(code.querySelector("code")!.textContent).toBe("代码");
  });

  it("侧翼规则:乘号两侧的 * 不成对,无空格侧翼正常成对", () => {
    const target = render("2 * 3 与 a * b,然后**中文**成立");
    expect(target.querySelectorAll("em").length).toBe(0);
    expect(target.querySelector("strong")!.textContent).toBe("中文");
  });

  it("定界符游程:两侧带空格的 ** 与残缺配对一律字面,三星成 em 套 strong", () => {
    // `** 空格 **` 曾被单星扫描配对出 <em>* 空格 *</em>——比纯文本更糟。游程规则:
    // 开/闭标记的星号游程长度必须相等,游程内不再单独配对,残缺整段字面。
    const spaced = render("** 空格 **");
    expect(spaced.querySelectorAll("em,strong").length).toBe(0);
    expect(spaced.querySelector("p")!.textContent).toBe("** 空格 **");

    const trailing = render("**加粗 **");
    expect(trailing.querySelectorAll("em,strong").length).toBe(0);
    expect(trailing.querySelector("p")!.textContent).toBe("**加粗 **");

    const mismatch = render("***重要**");
    expect(mismatch.querySelectorAll("em,strong").length).toBe(0);
    expect(mismatch.querySelector("p")!.textContent).toBe("***重要**");

    const triple = render("***重要***");
    const em = triple.querySelector("p > em")!;
    expect(em.querySelector("strong")!.textContent).toBe("重要");
    expect(triple.querySelector("p")!.textContent).toBe("重要");
  });

  it("未闭合的 ** 字面显示,不产生 strong", () => {
    const target = render("未闭合**标记");
    expect(target.querySelectorAll("strong").length).toBe(0);
    expect(target.querySelector("p")!.textContent).toContain("**标记");
  });

  it("行内代码优先:code 内容里的 ** 字面保留", () => {
    const target = render("说明 `a **b** c` 完毕");
    expect(target.querySelector("code")!.textContent).toBe("a **b** c");
    expect(target.querySelectorAll("strong").length).toBe(0);
  });

  it("六级标题统一渲染成 h4", () => {
    const target = render("# 一级\n## 二级\n###### 六级");
    const headings = target.querySelectorAll("h4");
    expect(headings.length).toBe(3);
    expect([...headings].map((heading) => heading.textContent)).toEqual(["一级", "二级", "六级"]);
  });

  it("无序与有序列表:连续同类行合并成一个列表", () => {
    const unordered = render("- 甲\n- 乙");
    const items = unordered.querySelectorAll("ul > li");
    expect(items.length).toBe(2);
    expect([...items].map((item) => item.textContent)).toEqual(["甲", "乙"]);

    const ordered = render("1. 甲\n2. 乙");
    const orderedItems = ordered.querySelectorAll("ol > li");
    expect(orderedItems.length).toBe(2);
    expect([...orderedItems].map((item) => item.textContent)).toEqual(["甲", "乙"]);
  });

  it("围栏代码块:内容逐字保留且不做行内解析;未闭合延续到结尾", () => {
    const closed = render("```\n**x**\nline2\n```");
    const code = closed.querySelector("pre > code")!;
    expect(code.textContent).toBe("**x**\nline2");
    expect(closed.querySelectorAll("strong").length).toBe(0);

    const unclosed = render("```\nabc");
    expect(unclosed.querySelector("pre > code")!.textContent).toBe("abc");
  });

  it("引用行渲染成 blockquote,文本不含 >", () => {
    const target = render("> 引用一行");
    const quote = target.querySelector("blockquote")!;
    expect(quote.textContent).toBe("引用一行");
  });

  it("原始 HTML 字面显示:不产生 script/img 元素节点", () => {
    const target = render("<script>alert(1)</script> 与 <img src=x onerror=alert(2)>");
    expect(target.querySelectorAll("script,img").length).toBe(0);
    expect(target.querySelector("p")!.textContent).toContain("<script>alert(1)</script>");
    expect(target.querySelector("p")!.textContent).toContain("<img src=x onerror=alert(2)>");
  });

  it("连续调用是全量替换:旧内容不残留", () => {
    const target = document.createElement("div");
    renderMarkdown(target, "**A**");
    renderMarkdown(target, "B");
    expect(target.children.length).toBe(1);
    expect(target.children[0]!.tagName).toBe("P");
    expect(target.children[0]!.textContent).toBe("B");
    expect(target.querySelectorAll("strong").length).toBe(0);
  });
});
