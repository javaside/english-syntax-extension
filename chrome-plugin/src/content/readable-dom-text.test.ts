// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { normalizedReadableText } from "./readable-dom-text";

function elementFrom(markup: string): Element {
  document.body.replaceChildren();
  document.body.insertAdjacentHTML("afterbegin", markup);
  return document.body.firstElementChild!;
}

/**
 * 科学文档的 DOM 文本归一化。这一层只负责「读什么」:普通可见文本按 DOM 顺序、
 * MathML 用单一稳定表示、辅助内容不重复、Unicode 空白折叠。它刻意不做的事:
 * 不解析 TeX、不翻译公式、不按 URL 分支——见 spec 的「不采用的方案」。
 */
describe("normalizedReadableText", () => {
  it("按 DOM 顺序拼接普通内联文本", () => {
    const element = elementFrom("<p>Hello <b>bold</b> <i>italic</i> world.</p>");

    expect(normalizedReadableText(element)).toBe("Hello bold italic world.");
  });

  it("跳过后代里被隐藏的子树", () => {
    const element = elementFrom("<div>Alpha <span hidden>beta secret</span> gamma.</div>");

    expect(normalizedReadableText(element)).toBe("Alpha gamma.");
  });

  it("跳过 computed display:none 的后代子树", () => {
    const element = elementFrom(
      '<p>Keep <span style="display: none">dropped subtree</span> the rest.</p>',
    );

    expect(normalizedReadableText(element)).toBe("Keep the rest.");
  });

  it("根元素自身的隐藏状态不由本函数负责", () => {
    // inventory 需要为「hidden」排除项登记完整文本;根自身的可见性属于分类层的职责,
    // 这样被隐藏的段落仍能以完整文本进入诊断清单。
    const hidden = elementFrom("<p hidden>Hidden migration instructions.</p>");

    expect(normalizedReadableText(hidden)).toBe("Hidden migration instructions.");
  });

  it("math 优先使用 alttext 且只取一次", () => {
    const element = elementFrom(
      '<p>Value of <math alttext="H0"><semantics><msub><mi>H</mi><mn>0</mn></msub>' +
        '<annotation encoding="application/x-tex">H_0</annotation></semantics></math> here.</p>',
    );

    expect(normalizedReadableText(element)).toBe("Value of H0 here.");
  });

  it("无 alttext 时只取一次可见 MathML 文本", () => {
    const element = elementFrom(
      "<p>Ratio <math><msub><mi>H</mi><mn>0</mn></msub>" +
        '<annotation encoding="application/x-tex">H_0</annotation></math> set.</p>',
    );

    expect(normalizedReadableText(element)).toBe("Ratio H0 set.");
  });

  it("annotation 与 aria-hidden 辅助文本不与可见公式重复", () => {
    const element = elementFrom(
      '<p>Read <math alttext="H0"><mi>H</mi><mn>0</mn><annotation>H_0</annotation></math>' +
        ' <span class="ltx_MathML" aria-hidden="true">H0</span> today.</p>',
    );

    expect(normalizedReadableText(element)).toBe("Read H0 today.");
  });

  it("独立公式容器只保留单一公式表示", () => {
    const element = elementFrom(
      '<div class="ltx_equation"><math display="block" alttext="p(d | H0)">' +
        "<mi>p</mi><mo>(</mo><mi>d</mi><mo>|</mo><msub><mi>H</mi><mn>0</mn></msub><mo>)</mo></math></div>",
    );

    expect(normalizedReadableText(element)).toBe("p(d | H0)");
  });

  it("内联数学保留为句内原子片段,不删除", () => {
    const element = elementFrom(
      '<p>The goal of reaching a 2% measurement of <math alttext="H0"><mi>H</mi></math> is close.</p>',
    );

    // 删掉内联数学会让英文语法与缓存键失真,必须原位保留。
    expect(normalizedReadableText(element)).toBe(
      "The goal of reaching a 2% measurement of H0 is close.",
    );
  });

  it("折叠 Unicode 空白并去除首尾空白", () => {
    const element = elementFrom("<p>\u00a0\u2003Multi\t\n\u2000space\u00a0value.\u00a0</p>");

    expect(normalizedReadableText(element)).toBe("Multi space value.");
  });

  it("以 math 为根时同样只产出单一表示", () => {
    const element = elementFrom(
      '<math alttext="H0"><msub><mi>H</mi><mn>0</mn></msub><annotation>H_0</annotation></math>',
    );

    expect(normalizedReadableText(element)).toBe("H0");
  });

  it("以 annotation 为根时仍可读出其自身文本供诊断登记", () => {
    const element = elementFrom('<annotation encoding="application/x-tex">H_0</annotation>');

    expect(normalizedReadableText(element)).toBe("H_0");
  });
});
