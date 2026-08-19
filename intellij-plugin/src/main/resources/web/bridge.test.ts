import { describe, expect, it } from "vitest";
import { parseHostMessage, parsePageMessage } from "./bridge";

describe("parsePageMessage", () => {
  it("accepts minimal preview ready", () => {
    const message = parsePageMessage({
      version: 1,
      type: "PREVIEW_READY",
      previewId: "p1",
      generation: 0,
    });
    expect(message).toEqual({ version: 1, type: "PREVIEW_READY", previewId: "p1", generation: 0 });
  });

  it("accepts visible blocks within limits", () => {
    const blocks = Array.from({ length: 50 }, (_, i) => ({ blockId: `b${i}`, text: `Block ${i}` }));
    const message = parsePageMessage({
      version: 1,
      type: "VISIBLE_BLOCKS",
      previewId: "p1",
      generation: 1,
      blocks,
    });
    expect(message?.type).toBe("VISIBLE_BLOCKS");
    expect(message && message.type === "VISIBLE_BLOCKS" ? message.blocks.length : 0).toBe(50);
  });

  it("rejects more than fifty blocks", () => {
    const blocks = Array.from({ length: 51 }, (_, i) => ({ blockId: `b${i}`, text: "x" }));
    expect(
      parsePageMessage({
        version: 1,
        type: "VISIBLE_BLOCKS",
        previewId: "p1",
        generation: 0,
        blocks,
      }),
    ).toBeNull();
  });

  it("rejects block text over twenty thousand chars", () => {
    expect(
      parsePageMessage({
        version: 1,
        type: "VISIBLE_BLOCKS",
        previewId: "p1",
        generation: 0,
        blocks: [{ blockId: "b", text: "x".repeat(20_001) }],
      }),
    ).toBeNull();
  });

  it("rejects unknown type", () => {
    expect(
      parsePageMessage({ version: 1, type: "HACK", previewId: "p1", generation: 0 }),
    ).toBeNull();
  });

  it("rejects extra keys", () => {
    expect(
      parsePageMessage({
        version: 1,
        type: "PREVIEW_READY",
        previewId: "p1",
        generation: 0,
        apiKey: "leak",
      }),
    ).toBeNull();
    expect(
      parsePageMessage({
        version: 1,
        type: "PREVIEW_READY",
        previewId: "p1",
        generation: 0,
        headers: {},
      }),
    ).toBeNull();
    expect(
      parsePageMessage({
        version: 1,
        type: "PREVIEW_READY",
        previewId: "p1",
        generation: 0,
        baseUrl: "https://evil",
      }),
    ).toBeNull();
  });

  it("rejects wrong version", () => {
    expect(
      parsePageMessage({ version: 2, type: "PREVIEW_READY", previewId: "p1", generation: 0 }),
    ).toBeNull();
  });

  it("rejects blank previewId and negative generation", () => {
    expect(
      parsePageMessage({ version: 1, type: "PREVIEW_READY", previewId: "", generation: 0 }),
    ).toBeNull();
    expect(
      parsePageMessage({ version: 1, type: "PREVIEW_READY", previewId: "p1", generation: -1 }),
    ).toBeNull();
  });

  it("rejects detail request with negative or reversed focus", () => {
    expect(
      parsePageMessage({
        version: 1,
        type: "DETAIL_REQUEST",
        previewId: "p1",
        generation: 0,
        sentenceId: "s1",
        focus: { startToken: -1, endToken: 2 },
      }),
    ).toBeNull();
    expect(
      parsePageMessage({
        version: 1,
        type: "DETAIL_REQUEST",
        previewId: "p1",
        generation: 0,
        sentenceId: "s1",
        focus: { startToken: 3, endToken: 2 },
      }),
    ).toBeNull();
  });

  it("accepts detail request with non-negative closed interval", () => {
    const message = parsePageMessage({
      version: 1,
      type: "DETAIL_REQUEST",
      previewId: "p1",
      generation: 0,
      sentenceId: "s1",
      focus: { startToken: 2, endToken: 4 },
    });
    expect(message && message.type === "DETAIL_REQUEST" ? message.focus : null).toEqual({
      startToken: 2,
      endToken: 4,
    });
  });

  it("accepts preview rendered with minimal keys", () => {
    const message = parsePageMessage({
      version: 1,
      type: "PREVIEW_RENDERED",
      previewId: "p1",
      generation: 3,
    });
    expect(message).toEqual({
      version: 1,
      type: "PREVIEW_RENDERED",
      previewId: "p1",
      generation: 3,
    });
  });

  it("rejects preview rendered with extra keys", () => {
    expect(
      parsePageMessage({
        version: 1,
        type: "PREVIEW_RENDERED",
        previewId: "p1",
        generation: 3,
        blocks: [],
      }),
    ).toBeNull();
  });
});

describe("parseHostMessage", () => {
  it("accepts session state for the current generation", () => {
    const message = parseHostMessage(
      {
        version: 1,
        type: "SESSION_STATE",
        previewId: "p1",
        generation: 3,
        state: "running",
        ready: 1,
        discovered: 4,
      },
      3,
    );
    expect(message && message.type === "SESSION_STATE" ? message.ready : null).toBe(1);
  });

  it("drops messages from stale generations", () => {
    expect(
      parseHostMessage(
        {
          version: 1,
          type: "CORE_RESULT",
          previewId: "p1",
          generation: 2,
          sentenceId: "s1",
          analysisJson: "{}",
        },
        5,
      ),
    ).toBeNull();
  });

  it("rejects extra keys on host messages", () => {
    expect(
      parseHostMessage(
        {
          version: 1,
          type: "CORE_RESULT",
          previewId: "p1",
          generation: 5,
          sentenceId: "s1",
          analysisJson: "{}",
          extra: true,
        },
        5,
      ),
    ).toBeNull();
  });
});
