import { describe, expect, it } from "vitest";
import { segmentBlock } from "./segmenter";

/**
 * 脚注标号形态:句号后面紧跟的数字(无空白),是 LaTeXML 把 `<sup>2</sup>`
 * 文本化后的产物。分句器原先把 `uncertainties.2` 当成小数/版本号而拒绝断句,
 * 于是两句粘成一个畸形长句(2026-09-14 真机 97 词失败句)。
 * 判据必须与真正的小数、章节号、版本号、列表编号区分开。
 */
describe("segmentBlock 与脚注标号", () => {
  it("在句末脚注标号处断句", () => {
    const blocks = segmentBlock(
      "We assume a complete catalogue with spectroscopic-like redshift uncertainties.2 While optimistic, this study highlights the importance.",
    );

    // 标号整体剔除,句号保留;真模型实测保留编号会被编成 FRAGMENT_HEAD 并连带失败。
    expect(blocks.map((b) => b.text)).toEqual([
      "We assume a complete catalogue with spectroscopic-like redshift uncertainties.",
      "While optimistic, this study highlights the importance.",
    ]);
  });

  it("第二个真机形态:recombined.4 This is not anticipated", () => {
    const blocks = segmentBlock(
      "the GW data never gets split and recombined.4 This is not anticipated to cause a systematic.",
    );

    expect(blocks.map((b) => b.text)).toEqual([
      "the GW data never gets split and recombined.",
      "This is not anticipated to cause a systematic.",
    ]);
  });

  it.each([
    ["Section 3.2 explains it.", 1],
    ["The value is 3.14 approximately.", 1],
    ["Version v1.2.3 shipped.", 1],
    ["The result is 2.5 times larger.", 1],
    ["See Table 1.2 for details.", 1],
  ])("不误切真正的小数/编号:%s", (text, expected) => {
    expect(segmentBlock(text).length).toBe(expected);
  });

  it("不误切句中的带点数字", () => {
    const blocks = segmentBlock("The probability is 0.95 for this case.");

    expect(blocks.map((b) => b.text)).toEqual(["The probability is 0.95 for this case."]);
  });
});
