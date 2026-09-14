import { describe, expect, it } from "vitest";
import { segmentBlock } from "./segmenter";

/**
 * 分句器**不做**脚注标号处理——这是刻意的(2026-09-14 审核结论)。
 *
 * 曾试过在文本层把 `uncertainties.2` 的 `.2` 删掉,但纯文本层面
 * 「字母 + 句号 + 数字 + 空格 + 大写」无法区分脚注标号与罗马数字章节号,
 * 结果把 `IV.2 Implications for the future` 腰斩成 `IV.` + `Implications…`,
 * 连 `Appendix B.2` 都被拆坏——而 `IV.2` 正是 Label-binding 规则的规范例子。
 *
 * 脚注标号是 DOM 层产物:`readable-dom-text.ts` 的 `FOOTNOTE_SELECTOR` 已在提取
 * 阶段把 `<sup class="ltx_note_mark">` 整棵剔除,`.2` 到不了分句器。
 * 这个文件守护「分句器不得再引入文本层脚注规则」。
 */
describe("segmentBlock 与罗马数字章节号", () => {
  it.each([
    ["IV.2 Implications for the future", "IV.2 Implications for the future"],
    ["II.2 Overview of the method", "II.2 Overview of the method"],
    ["III.4 Results", "III.4 Results"],
    ["Appendix B.2 The next section", "Appendix B.2 The next section"],
  ])("章节号不被腰斩:%s", (text, expected) => {
    expect(segmentBlock(text).map((s) => s.text)).toEqual([expected]);
  });

  it("脚注标号在提取层被剔除后,分句器只看到正常的句末标点", () => {
    // 提取层产出的是 `uncertainties.` + 空白,不是 `uncertainties.2`。
    const blocks = segmentBlock("uncertainties. While optimistic, this study continues.");

    expect(blocks.map((s) => s.text)).toEqual([
      "uncertainties.",
      "While optimistic, this study continues.",
    ]);
  });

  it("小数与版本号不受影响", () => {
    expect(segmentBlock("The value is 3.14 approximately.").map((s) => s.text)).toEqual([
      "The value is 3.14 approximately.",
    ]);
  });
});
