import { describe, expect, it } from "vitest";
import { tokenize } from "./segmenter";

/**
 * 带点标识符(事件编号、章节号)必须是一个 Token。
 *
 * 真机失败:`GWTC-5.0: Constraints on the Cosmic Expansion Rate` 被切成
 * `GWTC-5` `.` `0` `:` —— label 与冒号不连贯,模型无法把它和中心词绑成
 * 一个 FRAGMENT_HEAD,于是 `GWTC-5 . 0` 独立成一个片段主体并整句失败
 * (2026-09-14 修复后剩余 14 句失败里 6 句是这类论文标题)。
 * `II.2.1`(章节号)同理。
 */
describe("tokenize 与带字母前缀的点分标识符", () => {
  it("事件编号 GWTC-5.0 是一个 Token", () => {
    expect(tokenize("GWTC-5.0: Constraints").map((t) => t.text)).toEqual([
      "GWTC-5.0",
      ":",
      "Constraints",
    ]);
  });

  it("章节号 II.2.1 是一个 Token", () => {
    expect(tokenize("See Section II.2.1 for details.").map((t) => t.text)).toEqual([
      "See",
      "Section",
      "II.2.1",
      "for",
      "details",
      ".",
    ]);
  });

  it("不再把标识符里的点当标点", () => {
    const tokens = tokenize("GWTC-5.0");
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.punctuation).toBe(false);
  });

  it.each([
    ["The value is 3.14 approximately.", "3.14"],
    ["Apache 2.0 license.", "2.0"],
    ["Version v1.2.3 shipped.", "v1.2.3"],
    ["H0 is the Hubble constant.", "H0"],
  ])("不破坏既有形态:%s", (text, expected) => {
    expect(tokenize(text).map((t) => t.text)).toContain(expected);
  });
});
