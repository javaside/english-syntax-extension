import { describe, expect, it } from "vitest";
import {
  MAX_BLOCK_TEXT,
  MAX_CHAT_HISTORY_CHARACTERS,
  MAX_CHAT_HISTORY_TURNS,
  MAX_CHAT_QUESTION_CHARACTERS,
  parseHostMessage,
  parsePageMessage,
} from "./bridge";

/** CHAT_ASK 的默认合法载荷（防伪造门测试用）；单测按需覆写单个字段。history 为 unknown——测试要喂的就是非法形状。 */
function chatAsk(
  overrides: Partial<{
    conversationId: string;
    sentenceId: string;
    history: unknown;
    question: string;
  }> = {},
) {
  return {
    version: 1,
    type: "CHAT_ASK" as const,
    previewId: "p1",
    generation: 2,
    conversationId: "p1:chat:1",
    sentenceId: "s-b1-0",
    history: [
      { role: "user", content: "上一轮问题" },
      { role: "assistant", content: "上一轮回答" },
    ],
    question: "这个 of 短语修饰谁?",
    ...overrides,
  };
}

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
    const blocks = Array.from({ length: 2000 }, (_, i) => ({ blockId: `b${i}`, text: `Block ${i}` }));
    const message = parsePageMessage({
      version: 1,
      type: "VISIBLE_BLOCKS",
      previewId: "p1",
      generation: 1,
      blocks,
    });
    expect(message?.type).toBe("VISIBLE_BLOCKS");
    expect(message && message.type === "VISIBLE_BLOCKS" ? message.blocks.length : 0).toBe(2000);
  });

  it("rejects more than max blocks", () => {
    const blocks = Array.from({ length: 2001 }, (_, i) => ({ blockId: `b${i}`, text: "x" }));
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

  it("accepts parse block for the hotkey path", () => {
    const message = parsePageMessage({
      version: 1,
      type: "PARSE_BLOCK",
      previewId: "p1",
      generation: 2,
      blockId: "b7",
      text: "Short line.",
    });

    expect(message).toEqual({
      version: 1,
      type: "PARSE_BLOCK",
      previewId: "p1",
      generation: 2,
      blockId: "b7",
      text: "Short line.",
    });
  });

  it("rejects parse block with extra keys, empty blockId, or oversized text", () => {
    expect(
      parsePageMessage({
        version: 1,
        type: "PARSE_BLOCK",
        previewId: "p1",
        generation: 0,
        blockId: "b1",
        text: "t",
        target: "body",
      }),
    ).toBeNull();
    expect(
      parsePageMessage({
        version: 1,
        type: "PARSE_BLOCK",
        previewId: "p1",
        generation: 0,
        blockId: "",
        text: "t",
      }),
    ).toBeNull();
    expect(
      parsePageMessage({
        version: 1,
        type: "PARSE_BLOCK",
        previewId: "p1",
        generation: 0,
        blockId: "b1",
        text: "a".repeat(MAX_BLOCK_TEXT + 1),
      }),
    ).toBeNull();
  });

  it("accepts chat ask within caps and trims the question", () => {
    const message = parsePageMessage(chatAsk({ question: "  这个 of 短语修饰谁?  " }));
    expect(message).toEqual({
      version: 1,
      type: "CHAT_ASK",
      previewId: "p1",
      generation: 2,
      conversationId: "p1:chat:1",
      sentenceId: "s-b1-0",
      history: [
        { role: "user", content: "上一轮问题" },
        { role: "assistant", content: "上一轮回答" },
      ],
      question: "这个 of 短语修饰谁?",
    });
  });

  it("accepts chat ask with empty history for the first turn", () => {
    const message = parsePageMessage(chatAsk({ history: [] }));
    expect(message && message.type === "CHAT_ASK" ? message.history.length : -1).toBe(0);
  });

  it("rejects chat ask with blank or oversized question", () => {
    expect(parsePageMessage(chatAsk({ question: "" }))).toBeNull();
    expect(parsePageMessage(chatAsk({ question: "   " }))).toBeNull();
    expect(
      parsePageMessage(chatAsk({ question: "x".repeat(MAX_CHAT_QUESTION_CHARACTERS + 1) })),
    ).toBeNull();
    // 原文带空白超长但 trim 后在上限内：合法——上限按 trim 后文本计。
    const padded = `  ${"x".repeat(MAX_CHAT_QUESTION_CHARACTERS)}  `;
    const message = parsePageMessage(chatAsk({ question: padded }));
    expect(message && message.type === "CHAT_ASK" ? message.question.length : -1).toBe(
      MAX_CHAT_QUESTION_CHARACTERS,
    );
  });

  it("rejects chat ask with more than six history turns", () => {
    const seven = Array.from({ length: MAX_CHAT_HISTORY_TURNS + 1 }, (_, i) => ({
      role: "user",
      content: `q${i}`,
    }));
    expect(parsePageMessage(chatAsk({ history: seven }))).toBeNull();
    const six = seven.slice(0, MAX_CHAT_HISTORY_TURNS);
    expect(parsePageMessage(chatAsk({ history: six }))?.type).toBe("CHAT_ASK");
  });

  it("rejects chat ask whose history exceeds the character budget", () => {
    const over = Array.from({ length: 3 }, () => ({
      role: "user",
      content: "x".repeat(2_700),
    }));
    expect(parsePageMessage(chatAsk({ history: over }))).toBeNull();
    // 恰好 8000 字符：合法
    const exact = [
      { role: "user", content: "x".repeat(MAX_CHAT_HISTORY_CHARACTERS / 2) },
      { role: "assistant", content: "y".repeat(MAX_CHAT_HISTORY_CHARACTERS / 2) },
    ];
    expect(parsePageMessage(chatAsk({ history: exact }))?.type).toBe("CHAT_ASK");
  });

  it("rejects chat ask with invalid history shape", () => {
    // role 不在枚举
    expect(
      parsePageMessage(chatAsk({ history: [{ role: "system", content: "hi" }] })),
    ).toBeNull();
    // content 纯空白
    expect(
      parsePageMessage(chatAsk({ history: [{ role: "user", content: "   " }] })),
    ).toBeNull();
    // turn 多余键
    expect(
      parsePageMessage(chatAsk({ history: [{ role: "user", content: "hi", extra: 1 }] })),
    ).toBeNull();
    // history 非数组
    expect(parsePageMessage(chatAsk({ history: { role: "user", content: "hi" } }))).toBeNull();
  });

  it("rejects chat ask carrying credentials or missing envelope fields", () => {
    // forbiddenKeys：CHAT_ASK 同样照拦
    expect(parsePageMessage({ ...chatAsk(), apiKey: "leak" })).toBeNull();
    // 缺 conversationId / conversationId 为空 / sentenceId 为空
    const { conversationId: _ignored, ...withoutConversationId } = chatAsk();
    expect(parsePageMessage(withoutConversationId)).toBeNull();
    expect(parsePageMessage(chatAsk({ conversationId: "" }))).toBeNull();
    expect(parsePageMessage(chatAsk({ sentenceId: "" }))).toBeNull();
    // 方向混淆：页面伪造的 CHAT_RESULT 不是合法 page 消息
    expect(
      parsePageMessage({
        version: 1,
        type: "CHAT_RESULT",
        previewId: "p1",
        generation: 2,
        conversationId: "c",
        answer: "a",
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

  it("accepts core result with blockId and source tokens", () => {
    const message = parseHostMessage(
      {
        version: 1,
        type: "CORE_RESULT",
        previewId: "p1",
        generation: 3,
        sentenceId: "s-b1-0",
        blockId: "b1",
        analysisJson: "{}",
        tokensJson: '[{"id":0,"text":"—","leadingWhitespace":" ","punctuation":true}]',
      },
      3,
    );
    expect(message).toEqual({
      version: 1,
      type: "CORE_RESULT",
      previewId: "p1",
      generation: 3,
      sentenceId: "s-b1-0",
      blockId: "b1",
      analysisJson: "{}",
      tokensJson: '[{"id":0,"text":"—","leadingWhitespace":" ","punctuation":true}]',
    });
  });

  it("accepts core error with source tokens for restoring failed text", () => {
    const tokensJson = '[{"id":0,"text":"Classify","leadingWhitespace":"","punctuation":false}]';
    const message = parseHostMessage(
      {
        version: 1,
        type: "CORE_ERROR",
        previewId: "p1",
        generation: 3,
        sentenceId: "s-b1-0",
        blockId: "b1",
        code: "INVALID_MODEL_OUTPUT",
        message: "invalid",
        tokensJson,
      },
      3,
    );

    expect(message).toMatchObject({ type: "CORE_ERROR", tokensJson });
  });

  it("rejects core result without blockId", () => {
    expect(
      parseHostMessage(
        {
          version: 1,
          type: "CORE_RESULT",
          previewId: "p1",
          generation: 3,
          sentenceId: "s1",
          analysisJson: "{}",
        },
        3,
      ),
    ).toBeNull();
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
          blockId: "b1",
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

  it("accepts chat stream result and error for the current generation", () => {
    const stream = parseHostMessage(
      {
        version: 1,
        type: "CHAT_STREAM",
        previewId: "p1",
        generation: 3,
        conversationId: "p1:chat:1",
        text: "回答的第一段",
      },
      3,
    );
    expect(stream).toEqual({
      version: 1,
      type: "CHAT_STREAM",
      previewId: "p1",
      generation: 3,
      conversationId: "p1:chat:1",
      text: "回答的第一段",
    });

    const result = parseHostMessage(
      {
        version: 1,
        type: "CHAT_RESULT",
        previewId: "p1",
        generation: 3,
        conversationId: "p1:chat:1",
        answer: "完整回答",
      },
      3,
    );
    expect(result).toEqual({
      version: 1,
      type: "CHAT_RESULT",
      previewId: "p1",
      generation: 3,
      conversationId: "p1:chat:1",
      answer: "完整回答",
    });

    const error = parseHostMessage(
      {
        version: 1,
        type: "CHAT_ERROR",
        previewId: "p1",
        generation: 3,
        conversationId: "p1:chat:1",
        message: "原句已失效：请重新解析后再提问",
      },
      3,
    );
    expect(error).toEqual({
      version: 1,
      type: "CHAT_ERROR",
      previewId: "p1",
      generation: 3,
      conversationId: "p1:chat:1",
      message: "原句已失效：请重新解析后再提问",
    });
  });

  it("drops chat messages from stale generations", () => {
    // parseHostMessage 顶部的 generation 等值门槛对新 host 类型自动生效，无需重实现。
    expect(
      parseHostMessage(
        {
          version: 1,
          type: "CHAT_STREAM",
          previewId: "p1",
          generation: 2,
          conversationId: "c",
          text: "t",
        },
        5,
      ),
    ).toBeNull();
    expect(
      parseHostMessage(
        {
          version: 1,
          type: "CHAT_RESULT",
          previewId: "p1",
          generation: 5,
          conversationId: "c",
          answer: "a",
        },
        4,
      ),
    ).toBeNull();
    expect(
      parseHostMessage(
        {
          version: 1,
          type: "CHAT_ERROR",
          previewId: "p1",
          generation: 0,
          conversationId: "c",
          message: "m",
        },
        1,
      ),
    ).toBeNull();
  });

  it("rejects chat host messages with extra or missing keys", () => {
    // 缺 conversationId
    expect(
      parseHostMessage(
        { version: 1, type: "CHAT_STREAM", previewId: "p1", generation: 3, text: "t" },
        3,
      ),
    ).toBeNull();
    // conversationId 为空
    expect(
      parseHostMessage(
        { version: 1, type: "CHAT_STREAM", previewId: "p1", generation: 3, conversationId: "", text: "t" },
        3,
      ),
    ).toBeNull();
    // 多余键
    expect(
      parseHostMessage(
        {
          version: 1,
          type: "CHAT_RESULT",
          previewId: "p1",
          generation: 3,
          conversationId: "c",
          answer: "a",
          extra: true,
        },
        3,
      ),
    ).toBeNull();
    // answer 非字符串
    expect(
      parseHostMessage(
        { version: 1, type: "CHAT_RESULT", previewId: "p1", generation: 3, conversationId: "c", answer: 7 },
        3,
      ),
    ).toBeNull();
    // 方向混淆：host 侧不存在 CHAT_ASK
    expect(
      parseHostMessage(
        {
          version: 1,
          type: "CHAT_ASK",
          previewId: "p1",
          generation: 3,
          conversationId: "c",
          sentenceId: "s",
          history: [],
          question: "q",
        },
        3,
      ),
    ).toBeNull();
  });
});
