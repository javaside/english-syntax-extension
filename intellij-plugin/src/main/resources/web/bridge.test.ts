import { describe, expect, it } from "vitest";
import {
  MAX_BLOCK_TEXT,
  MAX_CHAT_HISTORY_CHARACTERS,
  MAX_CHAT_HISTORY_TURNS,
  MAX_CHAT_QUESTION_CHARACTERS,
  MAX_CHAT_SURROUNDING_AFTER_CHARS,
  MAX_CHAT_SURROUNDING_BEFORE_CHARS,
  MAX_CHAT_SURROUNDING_CURRENT_CHARS,
  MAX_FEEDBACK_CHARACTERS,
  parseHostMessage,
  parsePageMessage,
} from "./bridge";

/** CHAT_ASK 的默认合法载荷（防伪造门测试用）；单测按需覆写单个字段。history/surroundings 为 unknown——测试要喂的就是非法形状。 */
function chatAsk(
  overrides: Partial<{
    conversationId: string;
    sentenceId: string;
    history: unknown;
    question: string;
    surroundings: unknown;
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

// ---- TTS_SPEAK / TTS_STOP / TTS_ERROR：朗读桥门（FEEDBACK_REQUEST 同款；与 Kotlin parseTtsSpeak/parseTtsStop 镜像）----

function ttsSpeak(
  overrides: Partial<{ sentenceId: string; text: string }> = {},
) {
  return {
    version: 1,
    type: "TTS_SPEAK" as const,
    previewId: "p1",
    generation: 2,
    sentenceId: "s-b1-0",
    text: "The part that matters",
    ...overrides,
  };
}

describe("parsePageMessage TTS 桥门", () => {
  it("accepts tts speak within caps and trims the text", () => {
    const message = parsePageMessage(ttsSpeak({ text: "  The part that matters  " }));
    expect(message).toEqual({
      version: 1,
      type: "TTS_SPEAK",
      previewId: "p1",
      generation: 2,
      sentenceId: "s-b1-0",
      text: "The part that matters",
    });
  });

  it("rejects tts speak with blank, oversized, or padded-over-cap text", () => {
    expect(parsePageMessage(ttsSpeak({ text: "" }))).toBeNull();
    expect(parsePageMessage(ttsSpeak({ text: "   " }))).toBeNull();
    expect(parsePageMessage(ttsSpeak({ text: "x".repeat(2001) }))).toBeNull();
    // trim 后在上限内：合法（上限按 trim 后文本计，FEEDBACK 同款）。
    const padded = parsePageMessage(ttsSpeak({ text: `  ${"x".repeat(2000)}  ` }));
    expect(padded && padded.type === "TTS_SPEAK" ? padded.text.length : -1).toBe(2000);
  });

  it("rejects tts speak with extra keys, empty sentenceId, credentials, or direction confusion", () => {
    expect(parsePageMessage({ ...ttsSpeak(), extra: 1 })).toBeNull();
    expect(parsePageMessage({ ...ttsSpeak(), apiKey: "leak" })).toBeNull();
    expect(parsePageMessage(ttsSpeak({ sentenceId: "" }))).toBeNull();
    // 页面伪造的 TTS_ERROR 不是合法 page 消息。
    expect(
      parsePageMessage({
        version: 1,
        type: "TTS_ERROR",
        previewId: "p1",
        generation: 2,
        sentenceId: "s-b1-0",
        message: "m",
      }),
    ).toBeNull();
  });

  it("accepts bare tts stop and rejects it with a forged text payload", () => {
    const message = parsePageMessage({
      version: 1,
      type: "TTS_STOP",
      previewId: "p1",
      generation: 2,
    });
    expect(message).toEqual({ version: 1, type: "TTS_STOP", previewId: "p1", generation: 2 });
    expect(
      parsePageMessage({ version: 1, type: "TTS_STOP", previewId: "p1", generation: 2, text: "x" }),
    ).toBeNull();
  });
});

describe("parseHostMessage TTS_ERROR", () => {
  it("parses tts error with generation gate and sentenceId", () => {
    const message = parseHostMessage(
      {
        version: 1,
        type: "TTS_ERROR",
        previewId: "p1",
        generation: 3,
        sentenceId: "s-b1-0",
        message: "未找到可用的系统语音命令",
      },
      3,
    );
    expect(message).toEqual({
      version: 1,
      type: "TTS_ERROR",
      previewId: "p1",
      generation: 3,
      sentenceId: "s-b1-0",
      message: "未找到可用的系统语音命令",
    });
    expect(
      parseHostMessage(
        {
          version: 1,
          type: "TTS_ERROR",
          previewId: "p1",
          generation: 2,
          sentenceId: "s-b1-0",
          message: "stale",
        },
        3,
      ),
    ).toBeNull();
    // TTS_SPEAK 不是 host 消息（方向混淆）。
    expect(parseHostMessage(ttsSpeak(), 2)).toBeNull();
  });
});

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

  // ---- CHAT_ASK surroundings：段落上下文封顶门（与 Kotlin parseChatAsk 的 surroundings 分支镜像）----

  it("accepts chat ask surroundings with all three fields and passes values through as-is", () => {
    const message = parsePageMessage(
      chatAsk({
        surroundings: {
          before: "…the tail of the previous paragraph",
          current: "  The paragraph with the anchored sentence.  ",
          after: "the head of the next paragraph…",
        },
      }),
    );
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
      surroundings: {
        before: "…the tail of the previous paragraph",
        // 值原样透传：门只校验不改写（question 在门里 trim 的做法刻意不复制——
        // surroundings 是机器算好的已封顶文本，两侧一致只校验）。
        current: "  The paragraph with the anchored sentence.  ",
        after: "the head of the next paragraph…",
      },
    });
  });

  it("accepts chat ask surroundings at exactly the caps for all three fields", () => {
    const message = parsePageMessage(
      chatAsk({
        surroundings: {
          before: "b".repeat(MAX_CHAT_SURROUNDING_BEFORE_CHARS),
          current: "c".repeat(MAX_CHAT_SURROUNDING_CURRENT_CHARS),
          after: "a".repeat(MAX_CHAT_SURROUNDING_AFTER_CHARS),
        },
      }),
    );
    const surroundings = message && message.type === "CHAT_ASK" ? message.surroundings : null;
    // … 截断标记计入各自上限：门按裸 length ≤ cap 判，恰好贴线合法。
    expect(surroundings?.before?.length).toBe(MAX_CHAT_SURROUNDING_BEFORE_CHARS);
    expect(surroundings?.current?.length).toBe(MAX_CHAT_SURROUNDING_CURRENT_CHARS);
    expect(surroundings?.after?.length).toBe(MAX_CHAT_SURROUNDING_AFTER_CHARS);
  });

  it("accepts chat ask surroundings with only current, and without the key", () => {
    const only = parsePageMessage(chatAsk({ surroundings: { current: "Only this paragraph." } }));
    expect(only && only.type === "CHAT_ASK" ? only.surroundings : "missing").toEqual({
      current: "Only this paragraph.",
    });
    // 不带 surroundings 键：纯句子锚点提问照旧合法（字段可选）。
    const absent = parsePageMessage(chatAsk());
    expect(absent && absent.type === "CHAT_ASK" ? absent.surroundings : "present").toBeUndefined();
  });

  it("rejects chat ask surroundings with extra keys or over-cap values", () => {
    // 多余键
    expect(parsePageMessage(chatAsk({ surroundings: { before: "x", extra: "y" } }))).toBeNull();
    // before 超 1200 / current 超 4000 / after 超 800
    expect(
      parsePageMessage(chatAsk({ surroundings: { before: "x".repeat(MAX_CHAT_SURROUNDING_BEFORE_CHARS + 1) } })),
    ).toBeNull();
    expect(
      parsePageMessage(chatAsk({ surroundings: { current: "x".repeat(MAX_CHAT_SURROUNDING_CURRENT_CHARS + 1) } })),
    ).toBeNull();
    expect(
      parsePageMessage(chatAsk({ surroundings: { after: "x".repeat(MAX_CHAT_SURROUNDING_AFTER_CHARS + 1) } })),
    ).toBeNull();
  });

  it("rejects chat ask surroundings with blank or non-string field values", () => {
    // 空串
    expect(parsePageMessage(chatAsk({ surroundings: { current: "" } }))).toBeNull();
    // 纯空白串（web .trim() / Kotlin trimJsWhitespace 同答案）
    expect(parsePageMessage(chatAsk({ surroundings: { current: "   " } }))).toBeNull();
    expect(parsePageMessage(chatAsk({ surroundings: { current: "\uFEFF" } }))).toBeNull();
    // 在场键非 string（数字 / null——null 不是缺席，必须走 string 门）
    expect(parsePageMessage(chatAsk({ surroundings: { before: 5 } }))).toBeNull();
    expect(parsePageMessage(chatAsk({ surroundings: { before: null, current: "t" } }))).toBeNull();
  });

  it("rejects chat ask surroundings that is not an object or is the empty object", () => {
    // 非对象（字符串 / 数组 / null——null 不是缺席，必须走 record 门）
    expect(parsePageMessage(chatAsk({ surroundings: "not an object" }))).toBeNull();
    expect(parsePageMessage(chatAsk({ surroundings: ["current"] }))).toBeNull();
    expect(parsePageMessage(chatAsk({ surroundings: null }))).toBeNull();
    // 空对象（零键——三键全缺没有上下文意义）
    expect(parsePageMessage(chatAsk({ surroundings: {} }))).toBeNull();
  });

  it("rejects chat ask with surroundings alongside a top-level credential leak", () => {
    // 顶层 forbiddenKeys 照旧拒——surroundings 门不放松信封级守卫。
    expect(parsePageMessage({ ...chatAsk({ surroundings: { current: "t" } }), apiKey: "leak" })).toBeNull();
  });

  // ---- FEEDBACK_REQUEST（F2 纠正反馈）：防伪造门与 CHAT_ASK 同款（与 Kotlin parseFeedbackRequest 镜像）----

  it("accepts feedback request within caps and trims the feedback", () => {
    const message = parsePageMessage({
      version: 1,
      type: "FEEDBACK_REQUEST",
      previewId: "p1",
      generation: 2,
      sentenceId: "s-b1-0",
      feedback: "  这个 of 短语应该是定语  ",
    });
    expect(message).toEqual({
      version: 1,
      type: "FEEDBACK_REQUEST",
      previewId: "p1",
      generation: 2,
      sentenceId: "s-b1-0",
      feedback: "这个 of 短语应该是定语",
    });
  });

  it("rejects feedback request with blank or oversized feedback", () => {
    expect(
      parsePageMessage({ version: 1, type: "FEEDBACK_REQUEST", previewId: "p1", generation: 2, sentenceId: "s-b1-0", feedback: "" }),
    ).toBeNull();
    expect(
      parsePageMessage({ version: 1, type: "FEEDBACK_REQUEST", previewId: "p1", generation: 2, sentenceId: "s-b1-0", feedback: "   " }),
    ).toBeNull();
    expect(
      parsePageMessage({
        version: 1,
        type: "FEEDBACK_REQUEST",
        previewId: "p1",
        generation: 2,
        sentenceId: "s-b1-0",
        feedback: "x".repeat(MAX_FEEDBACK_CHARACTERS + 1),
      }),
    ).toBeNull();
    // 原文带空白超长但 trim 后在上限内：合法——上限按 trim 后文本计。
    const padded = `  ${"x".repeat(MAX_FEEDBACK_CHARACTERS)}  `;
    const message = parsePageMessage({
      version: 1,
      type: "FEEDBACK_REQUEST",
      previewId: "p1",
      generation: 2,
      sentenceId: "s-b1-0",
      feedback: padded,
    });
    expect(message && message.type === "FEEDBACK_REQUEST" ? message.feedback.length : -1).toBe(
      MAX_FEEDBACK_CHARACTERS,
    );
  });

  it("rejects feedback request with extra keys, empty sentenceId, credentials, or direction confusion", () => {
    // 多余键
    expect(
      parsePageMessage({
        version: 1,
        type: "FEEDBACK_REQUEST",
        previewId: "p1",
        generation: 2,
        sentenceId: "s-b1-0",
        feedback: "f",
        extra: 1,
      }),
    ).toBeNull();
    // sentenceId 为空 / 缺失
    expect(
      parsePageMessage({ version: 1, type: "FEEDBACK_REQUEST", previewId: "p1", generation: 2, sentenceId: "", feedback: "f" }),
    ).toBeNull();
    expect(
      parsePageMessage({ version: 1, type: "FEEDBACK_REQUEST", previewId: "p1", generation: 2, feedback: "f" }),
    ).toBeNull();
    // forbiddenKeys
    expect(
      parsePageMessage({
        version: 1,
        type: "FEEDBACK_REQUEST",
        previewId: "p1",
        generation: 2,
        sentenceId: "s-b1-0",
        feedback: "f",
        apiKey: "leak",
      }),
    ).toBeNull();
    // 方向混淆：页面伪造的 FEEDBACK_ERROR 不是合法 page 消息
    expect(
      parsePageMessage({
        version: 1,
        type: "FEEDBACK_ERROR",
        previewId: "p1",
        generation: 2,
        sentenceId: "s",
        message: "m",
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

  // ---- FEEDBACK_ERROR（F2）：与 CHAT_ERROR 平行、按 sentenceId 关联，不混淆会话 ----

  it("accepts feedback error for the current generation and drops stale ones", () => {
    const error = parseHostMessage(
      {
        version: 1,
        type: "FEEDBACK_ERROR",
        previewId: "p1",
        generation: 3,
        sentenceId: "s-b1-0",
        message: "INVALID_MODEL_OUTPUT：coverage is incomplete",
      },
      3,
    );
    expect(error).toEqual({
      version: 1,
      type: "FEEDBACK_ERROR",
      previewId: "p1",
      generation: 3,
      sentenceId: "s-b1-0",
      message: "INVALID_MODEL_OUTPUT：coverage is incomplete",
    });

    expect(
      parseHostMessage(
        {
          version: 1,
          type: "FEEDBACK_ERROR",
          previewId: "p1",
          generation: 2,
          sentenceId: "s-b1-0",
          message: "m",
        },
        3,
      ),
    ).toBeNull();
  });

  it("rejects feedback error with extra or missing keys, or direction confusion", () => {
    // sentenceId 为空
    expect(
      parseHostMessage(
        { version: 1, type: "FEEDBACK_ERROR", previewId: "p1", generation: 3, sentenceId: "", message: "m" },
        3,
      ),
    ).toBeNull();
    // 缺 message
    expect(
      parseHostMessage(
        { version: 1, type: "FEEDBACK_ERROR", previewId: "p1", generation: 3, sentenceId: "s" },
        3,
      ),
    ).toBeNull();
    // 多余键（不得混入 conversationId/code）
    expect(
      parseHostMessage(
        {
          version: 1,
          type: "FEEDBACK_ERROR",
          previewId: "p1",
          generation: 3,
          sentenceId: "s",
          message: "m",
          code: "X",
        },
        3,
      ),
    ).toBeNull();
    // 方向混淆：host 侧不存在 FEEDBACK_REQUEST
    expect(
      parseHostMessage(
        {
          version: 1,
          type: "FEEDBACK_REQUEST",
          previewId: "p1",
          generation: 3,
          sentenceId: "s",
          feedback: "f",
        },
        3,
      ),
    ).toBeNull();
  });
});
