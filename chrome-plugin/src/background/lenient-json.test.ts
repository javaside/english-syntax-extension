import vectors from "../../../shared-fixtures/truncated-json-salvage.json";
import { describe, expect, it } from "vitest";
import { repairTruncatedJson, salvageTruncatedJson } from "./lenient-json";

describe("shared-fixtures 向量(与 Kotlin 侧同一批)", () => {
  for (const { name, input, expected } of vectors) {
    it(`${name}`, () => {
      expect(repairTruncatedJson(input) ?? null).toBe(expected);
    });
  }

  it("补出来的候选一定能解析", () => {
    for (const { name, expected } of vectors) {
      if (expected === null) continue;
      expect(() => JSON.parse(expected) as unknown, name).not.toThrow();
    }
  });
});

it("救回被截断输出里已完整的句子", () => {
  const truncated =
    '{"sentences":[{"sentenceId":"s1","components":[{"startToken":0,"endToken":1,"role":"SUBJECT","translation":"编辑"}]},{"sentenceId":"s2","components":[{"startToken":0,"endTo';
  expect(salvageTruncatedJson(truncated)).toEqual({
    sentences: [
      {
        sentenceId: "s1",
        components: [{ startToken: 0, endToken: 1, role: "SUBJECT", translation: "编辑" }],
      },
      // 半截的第二句只留下已完整的成员:缺字段的句子由上层判无效并进修复轮。
      { sentenceId: "s2", components: [{ startToken: 0 }] },
    ],
  });
});

it("不把半截字符串当完整值", () => {
  const truncated = '{"sentences":[{"sentenceId":"s1","components":[],"note":"这句还没写完';
  expect(salvageTruncatedJson(truncated)).toEqual({
    sentences: [{ sentenceId: "s1", components: [] }],
  });
});

it("连一个完整值都没有时返回 undefined", () => {
  expect(salvageTruncatedJson('{"sentences":[{"sen')).toBeUndefined();
  expect(salvageTruncatedJson("")).toBeUndefined();
  expect(salvageTruncatedJson("对不起，我不确定怎么拆解这句话。")).toBeUndefined();
});

it("括号对不上时退回最后一个完整值,不把后面的文本当真", () => {
  expect(salvageTruncatedJson('{"sentences":[]}}}{"sentences":[{"sentenceId":"x"}]}')).toEqual({
    sentences: [],
  });
});

it("完整输出原样返回", () => {
  const complete = '{"sentences":[{"sentenceId":"s1","components":[]}]}';
  expect(repairTruncatedJson(complete)).toBe(complete);
  expect(repairTruncatedJson(`\`\`\`json\n${complete}\n\`\`\``)).toBe(complete);
});

it("详解那套结构同样能救", () => {
  const truncated =
    '{"structures":[{"label":"主语","explanation":"整句的动作发出者"},{"label":"谓语","expl';
  expect(salvageTruncatedJson(truncated)).toEqual({
    structures: [{ label: "主语", explanation: "整句的动作发出者" }, { label: "谓语" }],
  });
});
