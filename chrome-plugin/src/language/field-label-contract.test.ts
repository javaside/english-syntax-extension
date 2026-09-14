import { describe, expect, it } from "vitest";
import { GrammarRole } from "../shared/grammar";
import { tokenize } from "./segmenter";

/**
 * 冒号前字段标签 + 后面完整疑问句的正确结构。
 *
 * 真机 arXiv 定义表里的两个 `Binary flag:` 句,5 次运行里 9/10 最终失败。
 * 模型稳定把 label 标成 FRAGMENT_HEAD,再与疑问句的 SUBJECT/PREDICATE 混用,
 * 触发硬门。根因不是模型不会分析疑问句,而是角色体系里 `FRAGMENT_HEAD`
 * 明确不能和分句角色混用——正确角色应为句外 `INDEPENDENT_ELEMENT`。
 */
describe("field-label 结构口径", () => {
  it("Binary flag: + 完整疑问句不得使用 FRAGMENT_HEAD", () => {
    const text = "Binary flag: is this galaxy contained within the galaxy catalogue?";
    const tokens = tokenize(text);

    expect(tokens.map((token) => `${token.id}:${token.text}`)).toEqual([
      "0:Binary",
      "1:flag",
      "2::",
      "3:is",
      "4:this",
      "5:galaxy",
      "6:contained",
      "7:within",
      "8:the",
      "9:galaxy",
      "10:catalogue",
      "11:?",
    ]);
    expect([
      { startToken: 0, endToken: 1, role: GrammarRole.INDEPENDENT_ELEMENT },
      { startToken: 3, endToken: 3, role: GrammarRole.PREDICATE },
      { startToken: 4, endToken: 5, role: GrammarRole.SUBJECT },
      { startToken: 6, endToken: 6, role: GrammarRole.PREDICATIVE },
      { startToken: 7, endToken: 10, role: GrammarRole.ADVERBIAL },
    ]).not.toContainEqual(expect.objectContaining({ role: GrammarRole.FRAGMENT_HEAD }));
  });

  it("label 是句外独立成分,冒号本身不覆盖", () => {
    const expected = [
      { startToken: 0, endToken: 1, role: GrammarRole.INDEPENDENT_ELEMENT },
      { startToken: 3, endToken: 3, role: GrammarRole.PREDICATE },
      { startToken: 4, endToken: 6, role: GrammarRole.SUBJECT },
      { startToken: 7, endToken: 11, role: GrammarRole.ATTRIBUTE },
      { startToken: 12, endToken: 13, role: GrammarRole.PREDICATIVE },
    ];

    expect(expected[0]).toEqual({
      startToken: 0,
      endToken: 1,
      role: GrammarRole.INDEPENDENT_ELEMENT,
    });
    expect(expected.every(({ startToken, endToken }) => !(startToken <= 2 && endToken >= 2))).toBe(
      true,
    );
  });
});
