// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { normalizedReadableText } from "./readable-dom-text";

function elementFrom(markup: string): Element {
  document.body.replaceChildren();
  document.body.insertAdjacentHTML("afterbegin", markup);
  return document.body.firstElementChild!;
}

/**
 * LaTeXML 脚注结构:正文句号后面直接跟 `<span class="ltx_role_footnote">`,
 * 里面是 `<sup class="ltx_note_mark">2</sup>` 与脚注正文。文本提取若原样拼接,
 * 就得到 `uncertainties.2 While optimistic…`——分句器会把它当成小数/版本号而
 * **拒绝在句号处切边界**,两句被粘成一个 97 词的畸形输入,模型只能硬划并失败。
 * 因此脚注内容必须与正文分离,且脚注标号不得粘在正文句末。
 */
describe("normalizedReadableText 与 footnote 结构", () => {
  it("脚注标号不粘在正文句末,脚注正文不进正文文本", () => {
    const element = elementFrom(
      "<p>We assume a complete catalogue with redshift uncertainties." +
        '<span id="footnote2" class="ltx_note ltx_role_footnote">' +
        '<sup class="ltx_note_mark">2</sup>' +
        '<span class="ltx_note_outer"><span class="ltx_note_content">' +
        '<sup class="ltx_note_mark">2</sup><span class="ltx_tag ltx_tag_note">2</span>' +
        "Here complete means containing all possible host galaxies." +
        "</span></span></span>" +
        " While optimistic, this study highlights the importance.</p>",
    );

    const text = normalizedReadableText(element);
    expect(text).not.toContain("uncertainties.2");
    expect(text).not.toContain("containing all possible host galaxies");
    expect(text).toContain("uncertainties.");
    expect(text).toContain("While optimistic, this study highlights the importance.");
  });

  it("保留脚注标记前的空格,不把两句粘成一句", () => {
    const element = elementFrom(
      "<p>First sentence ends here." +
        '<span class="ltx_role_footnote"><sup>4</sup></span>' +
        " Second sentence begins.</p>",
    );

    expect(normalizedReadableText(element)).toBe(
      "First sentence ends here. Second sentence begins.",
    );
  });

  it("脚注容器被整棵跳过(含 aria-hidden 与 role)", () => {
    const element = elementFrom(
      "<p>Before." + '<span role="doc-footnote"><sup>7</sup>note body</span>' + " After.</p>",
    );

    expect(normalizedReadableText(element)).toBe("Before. After.");
  });
});
