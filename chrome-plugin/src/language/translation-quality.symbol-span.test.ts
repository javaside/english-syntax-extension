import { describe, expect, it } from "vitest";
import { validateCoreBatch } from "./analysis-validator";
import { tokenize } from "./segmenter";

interface RawComponent {
  startToken: number;
  endToken: number;
  role: string;
  translation: string;
}

function check(text: string, components: RawComponent[]) {
  const input = { sentenceId: "s", text, tokens: tokenize(text) };
  const raw = { sentences: [{ sentenceId: "s", components }] };
  return validateCoreBatch(raw, [input], "p");
}

/**
 * 纯符号 span(引用标记、公式、标点、单字母符号)不可能译出中文;
 * Han 硬门要求它含中文 = 必然失败并烧掉两轮 repair。
 * spec §5.2 要求的是「含内联数学的英文成分」给中文释义,不是「公式本身必须中文」。
 */
describe("Han 门与纯符号 span", () => {
  it("引用标记 [24]. 不该被要求中文", () => {
    const r = check("See also [24].", [
      { startToken: 0, endToken: 1, role: "PREDICATE", translation: "参见" },
      { startToken: 2, endToken: 3, role: "OBJECT", translation: "[24]." },
    ]);
    expect(r.ok).toBe(true);
  });

  it("含数学标记的公式 span 不该被要求中文", () => {
    const r = check("The value is p(s|I), where I is given.", [
      { startToken: 0, endToken: 1, role: "SUBJECT", translation: "该值" },
      { startToken: 2, endToken: 2, role: "PREDICATIVE", translation: "为" },
      { startToken: 3, endToken: 8, role: "OBJECT", translation: "p(s|I)" },
      { startToken: 9, endToken: 14, role: "ATTRIBUTIVE_CLAUSE", translation: "其中 I 是给定的" },
    ]);
    expect(r.ok).toBe(true);
  });

  it.each([
    "the TCP/IP stack",
    "100 km/h",
    "A/B testing",
    "and/or",
    "the I/O layer",
    "foo_bar function",
    "x^2 term",
  ])("含 ASCII 歧义字符的英文成分仍要求中文:%s", (span) => {
    // `/ ~ ^ _ | \` 是普通技术英语的高频字符,不是数学标记。
    // 若把它们算作数学式,这些成分的纯英文回显会被放行并写进缓存。
    const r = check(`We use ${span}.`, [
      { startToken: 0, endToken: 1, role: "SUBJECT", translation: "我们使用" },
      { startToken: 2, endToken: 2, role: "OBJECT", translation: span },
    ]);
    expect(r.ok).toBe(false);
  });

  it("裸单字母缩写与专名同样要求中文(spec: 不得以专名为名显示零中文)", () => {
    const r = check("We use M data.", [
      { startToken: 0, endToken: 1, role: "SUBJECT", translation: "我们使用" },
      { startToken: 2, endToken: 3, role: "OBJECT", translation: "M data" },
    ]);
    expect(r.ok).toBe(false);
  });

  it("含实词的 span 仍必须给中文(不放松真正要防的回显)", () => {
    const r = check("See the GWTC-5.0 catalogue.", [
      { startToken: 0, endToken: 0, role: "PREDICATE", translation: "参见" },
      { startToken: 1, endToken: 4, role: "OBJECT", translation: "GWTC-5.0 catalogue" },
    ]);
    expect(r.ok).toBe(false);
  });

  it("专名仍须补中文类型(spec §5.2)", () => {
    const r = check("We use Lasair data.", [
      { startToken: 0, endToken: 1, role: "SUBJECT", translation: "我们使用" },
      { startToken: 2, endToken: 3, role: "OBJECT", translation: "Lasair 数据库的数据" },
    ]);
    expect(r.ok).toBe(true);
  });

  it("专名只有英文回显仍拒绝(spec §5.2:保留英文 + 补中文类型)", () => {
    const r = check("We use Lasair data.", [
      { startToken: 0, endToken: 1, role: "SUBJECT", translation: "我们使用" },
      { startToken: 2, endToken: 3, role: "OBJECT", translation: "Lasair data" },
    ]);
    expect(r.ok).toBe(false);
  });
});
