import { describe, expect, it } from "vitest";
import { DetailStreamParser } from "./detail-stream-parser";

const envelope = JSON.stringify({
  sentenceId: "s0",
  focus: { startToken: 0, endToken: 6 },
  structures: [
    { startToken: 0, endToken: 1, role: "冠词", explanation: "特指", translation: "这些" },
    { startToken: 2, endToken: 3, role: "关系代词", explanation: "引导从句", translation: "那些" },
  ],
  grammarPoints: ["定语从句"],
  explanation: "整体说明。",
});

function drain(text: string, chunkSize = text.length): string[] {
  const parser = new DetailStreamParser();
  const seen: string[] = [];
  for (let index = 0; index < text.length; index += chunkSize) {
    for (const s of parser.push(text.slice(index, index + chunkSize))) {
      seen.push(String(s.role));
    }
  }
  return seen;
}

describe("DetailStreamParser", () => {
  it("emits each structure as it closes", () => {
    expect(drain(envelope)).toEqual(["冠词", "关系代词"]);
  });

  it("produces the same structures when fed one character at a time", () => {
    expect(drain(envelope, 1)).toEqual(drain(envelope));
  });

  // focus 也是个对象，且出现在 structures 之前:靠嵌套深度计数会把它算进去。
  it("never mistakes the focus object for a structure", () => {
    const parser = new DetailStreamParser();
    const head = envelope.slice(0, envelope.indexOf('"structures"'));

    expect(parser.push(head)).toEqual([]);
  });

  it("emits a structure exactly once across repeated feeds", () => {
    const parser = new DetailStreamParser();
    const split = envelope.indexOf("关系代词");
    const first = parser.push(envelope.slice(0, split));
    const second = parser.push(envelope.slice(split));

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
  });

  it("keeps braces and quotes inside an explanation from splitting the object", () => {
    const tricky = JSON.stringify({
      sentenceId: "s0",
      focus: { startToken: 0, endToken: 1 },
      structures: [
        { startToken: 0, endToken: 1, role: "主语", explanation: '他说"你好{"，然后停顿' },
      ],
      grammarPoints: [],
      explanation: "x",
    });

    const emitted = new DetailStreamParser().push(tricky);

    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.explanation).toBe('他说"你好{"，然后停顿');
  });

  it("ignores a leading Markdown fence", () => {
    expect(drain("```json\n" + envelope)).toEqual(drain(envelope));
  });

  it("emits nothing for an envelope whose structures array has not opened", () => {
    expect(drain('{"sentenceId":"s0","focus":{"startToken":0,"endToken":6},"struct')).toEqual([]);
  });

  it("ignores objects nested inside a structure", () => {
    const nested = JSON.stringify({
      sentenceId: "s0",
      focus: { startToken: 0, endToken: 1 },
      structures: [{ startToken: 0, endToken: 1, role: "主语", explanation: "x", extra: { a: 1 } }],
      grammarPoints: [],
      explanation: "y",
    });

    expect(new DetailStreamParser().push(nested)).toHaveLength(1);
  });
});
