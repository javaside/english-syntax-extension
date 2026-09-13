import { describe, expect, it } from "vitest";
import { rawComponentEntries, toIndexed } from "./indexed-components";
import { tokenize } from "./segmenter";

const tokens = tokenize("The service works well.");

// "The service works well." tokenize 后：0 The / 1 service / 2 works / 3 well / 4 .(p)
describe("rawComponentEntries", () => {
  it("记录原始下标后再排除纯标点成分", () => {
    const entries = rawComponentEntries(
      [
        { startToken: 0, endToken: 1, role: "SUBJECT", translation: "服务" },
        { startToken: 4, endToken: 4, role: "PUNCTUATION", translation: "。" }, // token 4 才是句号
        { startToken: 2, endToken: 3, role: "PREDICATE", translation: "运转良好" },
      ],
      tokens,
    );
    expect(entries.map((entry) => entry.rawIndex)).toEqual([0, 2]);
  });

  it("非法元素保留原始下标、不当作可跳过", () => {
    const entries = rawComponentEntries(["not-an-object"], tokens);
    expect(entries.map((entry) => entry.rawIndex)).toEqual([0]);
  });

  it("按 token 内容判纯标点,不看模型虚构的角色", () => {
    // 角色写成 PUNCTUATION 但区间覆盖实词时,不能被跳过。
    const entries = rawComponentEntries(
      [{ startToken: 2, endToken: 3, role: "PUNCTUATION", translation: "。" }],
      tokens,
    );
    expect(entries.map((entry) => entry.rawIndex)).toEqual([0]);
  });

  it("越界或非整数区间不算纯标点,保留原始下标", () => {
    const entries = rawComponentEntries(
      [
        { startToken: 99, endToken: 99, role: "PUNCTUATION", translation: "。" },
        { startToken: "0", endToken: 1, role: "SUBJECT", translation: "服务" },
      ],
      tokens,
    );
    expect(entries.map((entry) => entry.rawIndex)).toEqual([0, 1]);
  });

  it("全纯标点时结果为空(由调用方报 must contain a non-punctuation component)", () => {
    const entries = rawComponentEntries([{ startToken: 4, endToken: 4, role: "X", translation: "" }], tokens);
    expect(entries).toEqual([]);
  });
});

describe("toIndexed", () => {
  it("只保留成功解析的成分并携带 rawIndex", () => {
    const indexed = toIndexed([
      { rawIndex: 0, component: { startToken: 0, endToken: 1, role: "SUBJECT", translation: "服务" } },
      { rawIndex: 1, component: undefined },
      { rawIndex: 2, component: { startToken: 2, endToken: 3, role: "PREDICATE", translation: "运转良好" } },
    ]);
    expect(indexed).toEqual([
      { rawIndex: 0, component: { startToken: 0, endToken: 1, role: "SUBJECT", translation: "服务" } },
      { rawIndex: 2, component: { startToken: 2, endToken: 3, role: "PREDICATE", translation: "运转良好" } },
    ]);
  });
});
