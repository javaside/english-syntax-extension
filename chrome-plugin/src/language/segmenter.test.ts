import { readFileSync } from "node:fs";
import vectors from "../../../shared-fixtures/segmenter-vectors.json";
import { describe, expect, it } from "vitest";
import { createSentenceId, rebuildTokens, segmentBlock, tokenize } from "./segmenter";

describe("shared segmenter vectors", () => {
  it.each(vectors)("matches $name", ({ block, sentences }) => {
    expect(segmentBlock(block)).toEqual(
      sentences.map(({ text, start, end }) => ({ text, start, end })),
    );
    for (const sentence of sentences) {
      expect(
        tokenize(sentence.text).map(({ text, start, end, leadingWhitespace, punctuation }) => ({
          text,
          start,
          end,
          leadingWhitespace,
          punctuation,
        })),
      ).toEqual(sentence.tokens);
    }
  });
});

describe("segmentBlock", () => {
  it("does not split an English honorific from its sentence", () => {
    expect(
      segmentBlock("Dr. Smith arrived. He sat down.").map((sentence) => sentence.text),
    ).toEqual(["Dr. Smith arrived.", "He sat down."]);
  });

  it("keeps deterministic UTF-16 offsets while excluding separator whitespace", () => {
    expect(segmentBlock("  First. \n Second!  ")).toEqual([
      { text: "First.", start: 2, end: 8 },
      { text: "Second!", start: 11, end: 18 },
    ]);
  });

  it("preserves inter-sentence and trailing gaps through sentence ranges", () => {
    expect(segmentBlock("First.  Second.  ")).toEqual([
      { text: "First.", start: 0, end: 6 },
      { text: "Second.", start: 8, end: 15 },
    ]);
  });

  it("keeps closing quotes and CJK punctuation with the English sentence", () => {
    expect(segmentBlock('He said, "Go." Next。 Last!').map((sentence) => sentence.text)).toEqual([
      'He said, "Go."',
      "Next。",
      "Last!",
    ]);
  });

  it.each([
    ["Compare React vs. Vue frameworks."],
    ["See p. 12 and pp. 30 for the table."],
    ["The Rev. Green spoke first."],
    ["Capt. Ahab sailed away."],
    ["Lt. Dan returned home."],
    ["Gen. Grant led the army."],
    ["St. Paul wrote the letters."],
    ["The office moved to Acme Corp. last spring."],
  ])("keeps the abbreviation %s inside one sentence", (block) => {
    expect(segmentBlock(block).map((sentence) => sentence.text)).toEqual([block]);
  });

  it.each([
    ["She works in the U.S. She travels often.", ["She works in the U.S.", "She travels often."]],
    ["He earned a Ph.D. He now teaches.", ["He earned a Ph.D.", "He now teaches."]],
    ["The company is Acme Inc. It opened today.", ["The company is Acme Inc.", "It opened today."]],
    [
      "The company is Acme Corp. It opened today.",
      ["The company is Acme Corp.", "It opened today."],
    ],
  ])("treats a context-sensitive abbreviation as sentence-final in %s", (block, expected) => {
    expect(segmentBlock(block).map((sentence) => sentence.text)).toEqual(expected);
  });

  it.each([
    "The U.S. delegation arrived.",
    "She has a Ph.D. in physics.",
    "Acme Inc. reported strong results.",
  ])("keeps a context-sensitive abbreviation inside its sentence in %s", (block) => {
    expect(segmentBlock(block).map((sentence) => sentence.text)).toEqual([block]);
  });

  it.each(["Dr.", "Prof.", "Capt."])(
    "always keeps the title %s with the following name",
    (title) => {
      const block = `${title} Smith arrived. Next sentence.`;
      expect(segmentBlock(block).map((sentence) => sentence.text)).toEqual([
        `${title} Smith arrived.`,
        "Next sentence.",
      ]);
    },
  );

  it("keeps initials attached to the name they introduce", () => {
    expect(
      segmentBlock("J. R. R. Tolkien wrote it. He was British.").map((sentence) => sentence.text),
    ).toEqual(["J. R. R. Tolkien wrote it.", "He was British."]);
  });

  it("merges a leading list marker into the item it numbers", () => {
    expect(
      segmentBlock("1. Install the CLI. 2. Run the setup.").map((sentence) => sentence.text),
    ).toEqual(["1. Install the CLI.", "2. Run the setup."]);
  });

  it("merges a trailing fragment backwards instead of emitting a lone marker", () => {
    expect(segmentBlock("The rule applies. 1.").map((sentence) => sentence.text)).toEqual([
      "The rule applies. 1.",
    ]);
  });

  it("drops a segment that carries no lexical word", () => {
    expect(segmentBlock("Readers understand it. ---").map((sentence) => sentence.text)).toEqual([
      "Readers understand it. ---",
    ]);
  });
});

describe("tokenize", () => {
  it("keeps straight-apostrophe contractions as one word token", () => {
    expect(
      tokenize("Learners don't stop.").map((token) => [token.text, token.punctuation]),
    ).toEqual([
      ["Learners", false],
      ["don't", false],
      ["stop", false],
      [".", true],
    ]);
  });

  it("keeps curly-apostrophe contractions and hyphenated words intact", () => {
    expect(tokenize("They’re well-prepared.").map((token) => token.text)).toEqual([
      "They’re",
      "well-prepared",
      ".",
    ]);
  });

  it("emits quotes and CJK punctuation as punctuation tokens after English", () => {
    expect(tokenize('Say "hello"。').map((token) => [token.text, token.punctuation])).toEqual([
      ["Say", false],
      ['"', true],
      ["hello", false],
      ['"', true],
      ["。", true],
    ]);
  });

  it("uses exclusive UTF-16 offsets and sequential token IDs", () => {
    expect(tokenize("  A 😊 test")).toEqual([
      { id: 0, text: "A", start: 2, end: 3, leadingWhitespace: "  ", punctuation: false },
      { id: 1, text: "😊", start: 4, end: 6, leadingWhitespace: " ", punctuation: true },
      { id: 2, text: "test", start: 7, end: 11, leadingWhitespace: " ", punctuation: false },
    ]);
  });

  it("reconstructs all whitespace between tokens exactly", () => {
    expect(rebuildTokens(tokenize("Hello,  world!"))).toBe("Hello,  world!");
    expect(rebuildTokens(tokenize("\tHello,\n\nworld!"))).toBe("\tHello,\n\nworld!");
  });

  it("uses the explicit shared JavaScript whitespace class for abbreviation internals", () => {
    const source = readFileSync(new URL("./segmenter.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/const JS_WHITESPACE = [^;]*\\\\s/u);
  });

  it.each([
    ["Dr. Lee arrived.", ["Dr.", "Lee", "arrived", "."]],
    ["The U.S. delegation left.", ["The", "U.S.", "delegation", "left", "."]],
    ["She holds a Ph.D. degree.", ["She", "holds", "a", "Ph.D.", "degree", "."]],
    ["Use it, e.g. here.", ["Use", "it", ",", "e.g.", "here", "."]],
  ])("keeps the abbreviation in %s as one token", (sentence, expected) => {
    expect(tokenize(sentence).map((token) => token.text)).toEqual(expected);
  });

  it.each([
    ["It returns 4.5 items.", ["It", "returns", "4.5", "items", "."]],
    ["It cost 1,920.50 dollars.", ["It", "cost", "1,920.50", "dollars", "."]],
    ["Version 20.5.1 shipped.", ["Version", "20.5.1", "shipped", "."]],
    ["Growth reached 12.5% today.", ["Growth", "reached", "12.5", "%", "today", "."]],
  ])("keeps the number in %s as one token", (sentence, expected) => {
    expect(tokenize(sentence).map((token) => token.text)).toEqual(expected);
  });

  it("keeps a URL and an email address as single tokens", () => {
    expect(tokenize("Read https://example.com/a?b=1 now.").map((token) => token.text)).toEqual([
      "Read",
      "https://example.com/a?b=1",
      "now",
      ".",
    ]);
    expect(tokenize("Mail ada@example.com today.").map((token) => token.text)).toEqual([
      "Mail",
      "ada@example.com",
      "today",
      ".",
    ]);
  });

  it("keeps a trailing sentence period out of the abbreviation token", () => {
    expect(tokenize("They left the U.S.").map((token) => token.text)).toEqual([
      "They",
      "left",
      "the",
      "U.S.",
    ]);
    expect(tokenize("The value is 4.5.").map((token) => token.text)).toEqual([
      "The",
      "value",
      "is",
      "4.5",
      ".",
    ]);
  });

  it("still rebuilds the sentence losslessly with the compound tokens", () => {
    const sentence = "Dr. Lee cited https://example.com/a and 1,920.50 units.";
    expect(rebuildTokens(tokenize(sentence))).toBe(sentence);
  });
});

describe("createSentenceId", () => {
  it("returns the first 24 hex characters of the specified SHA-256 input", async () => {
    await expect(
      createSentenceId({
        sessionId: "session-1",
        blockId: "block-1",
        order: 0,
        normalizedText: "Same text.",
      }),
    ).resolves.toBe("667d275dc95590100189d49b");
  });

  it("distinguishes identical text at different block orders and remains stable", async () => {
    const input = {
      sessionId: "session-1",
      blockId: "block-1",
      order: 0,
      normalizedText: "Same text.",
    };

    const [first, repeated, reordered] = await Promise.all([
      createSentenceId(input),
      createSentenceId(input),
      createSentenceId({ ...input, order: 1 }),
    ]);

    expect(first).toBe(repeated);
    expect(first).toMatch(/^[a-f0-9]{24}$/u);
    expect(reordered).toBe("67499c3f8b3146c094b32179");
    expect(reordered).not.toBe(first);
  });
});
