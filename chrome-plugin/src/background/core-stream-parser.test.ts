import { describe, expect, it } from "vitest";
import { CoreStreamParser } from "./core-stream-parser";

const envelope = JSON.stringify({
  sentences: [
    {
      sentenceId: "s1",
      components: [
        { startToken: 0, endToken: 1, role: "SUBJECT", translation: "主语" },
        { startToken: 2, endToken: 3, role: "PREDICATE", translation: "谓语" },
      ],
    },
    {
      sentenceId: "s2",
      components: [{ startToken: 0, endToken: 2, role: "OBJECT", translation: "宾语" }],
    },
  ],
});

function drain(text: string, chunkSize = text.length): Array<[string, string]> {
  const parser = new CoreStreamParser();
  const seen: Array<[string, string]> = [];
  for (let index = 0; index < text.length; index += chunkSize) {
    for (const { sentenceId, component } of parser.push(text.slice(index, index + chunkSize))) {
      seen.push([sentenceId, String(component.role)]);
    }
  }
  return seen;
}

describe("CoreStreamParser", () => {
  it("emits every component paired with its sentence", () => {
    expect(drain(envelope)).toEqual([
      ["s1", "SUBJECT"],
      ["s1", "PREDICATE"],
      ["s2", "OBJECT"],
    ]);
  });

  it("produces the same components when fed one character at a time", () => {
    expect(drain(envelope, 1)).toEqual(drain(envelope));
  });

  it("emits a component exactly once across repeated feeds", () => {
    const parser = new CoreStreamParser();
    const head = envelope.slice(0, envelope.indexOf("PREDICATE"));
    const first = parser.push(head);
    const second = parser.push(envelope.slice(head.length));

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(2);
  });

  it("keeps braces and quotes inside a translation from splitting the object", () => {
    const tricky = JSON.stringify({
      sentences: [
        {
          sentenceId: "s1",
          components: [
            { startToken: 0, endToken: 1, role: "SUBJECT", translation: '他说"你好{" 然后' },
          ],
        },
      ],
    });

    const parser = new CoreStreamParser();
    const emitted = parser.push(tricky);

    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.component.translation).toBe('他说"你好{" 然后');
  });

  it("attributes components that stream before their sentenceId", () => {
    const reordered = JSON.stringify({
      sentences: [
        {
          components: [{ startToken: 0, endToken: 1, role: "SUBJECT", translation: "主语" }],
          sentenceId: "s9",
        },
      ],
    });

    expect(drain(reordered)).toEqual([["s9", "SUBJECT"]]);
  });

  it("ignores a leading Markdown fence and any prose before the object", () => {
    expect(drain("```json\n" + envelope)).toEqual(drain(envelope));
  });

  it("emits nothing for an envelope that has no components yet", () => {
    expect(drain('{"sentences":[{"sentenceId":"s1","components":[')).toEqual([]);
  });
});

/**
 * prompt 现在要求模型吐单行紧凑 JSON（实测省 40% 输出 token,而输出 token 就是
 * 耗时的全部来源）。解析器是字符级帧解析、不依赖换行,这里把这个前提钉住。
 */
describe("CoreStreamParser 对紧凑输出", () => {
  const minified =
    '{"sentences":[{"sentenceId":"s-1","components":' +
    '[{"startToken":0,"endToken":2,"role":"SUBJECT","translation":"主语"},' +
    '{"startToken":3,"endToken":4,"role":"PREDICATE","translation":"谓语"}]}]}';

  it("从单行无空白的 JSON 里提取每个成分", () => {
    expect(drain(minified)).toEqual([
      ["s-1", "SUBJECT"],
      ["s-1", "PREDICATE"],
    ]);
  });

  it("逐字符喂入也能提取——分片边界落在任何位置都不丢成分", () => {
    expect(drain(minified, 1)).toEqual([
      ["s-1", "SUBJECT"],
      ["s-1", "PREDICATE"],
    ]);
  });
});
