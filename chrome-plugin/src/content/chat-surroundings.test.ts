// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_CHAT_SURROUNDING_AFTER_CHARS,
  MAX_CHAT_SURROUNDING_BEFORE_CHARS,
  MAX_CHAT_SURROUNDING_CURRENT_CHARS,
} from "../shared/protocol";
import {
  buildChatSurroundings,
  capSurroundingAfter,
  capSurroundingBefore,
  capSurroundingCurrent,
  documentOrderedNeighbors,
} from "./chat-surroundings";
import type { SurroundingCandidate } from "./chat-surroundings";

/**
 * 纯函数模块的边界测试:封顶值全部引用 protocol.ts 导出的常量(1200/800/4000,
 * 简报钉死),边界输入由常量 ±1 构造,不出现第二处字面数字。
 */

describe("capSurroundingBefore", () => {
  it("恰好 1200 原样返回", () => {
    const exact = "b".repeat(MAX_CHAT_SURROUNDING_BEFORE_CHARS);
    expect(capSurroundingBefore(exact)).toBe(exact);
  });

  it("超长(1201)取尾部 1200 并前置 …(U+2026)", () => {
    const overlong = `y${"b".repeat(MAX_CHAT_SURROUNDING_BEFORE_CHARS)}`;
    const capped = capSurroundingBefore(overlong);
    expect(capped).toBe(`…${"b".repeat(MAX_CHAT_SURROUNDING_BEFORE_CHARS)}`);
    expect(capped[0]).toBe("…");
    expect(capped).toHaveLength(MAX_CHAT_SURROUNDING_BEFORE_CHARS + 1);
  });

  it("首尾空白先 trim 再判封顶", () => {
    const exact = "b".repeat(MAX_CHAT_SURROUNDING_BEFORE_CHARS);
    expect(capSurroundingBefore(`  ${exact}  `)).toBe(exact);
    // trim 后超长:被裁掉的是空白,不占尾部 1200 的预算
    const overlong = `y${"b".repeat(MAX_CHAT_SURROUNDING_BEFORE_CHARS)}`;
    expect(capSurroundingBefore(` ${overlong} `)).toBe(
      `…${"b".repeat(MAX_CHAT_SURROUNDING_BEFORE_CHARS)}`,
    );
  });
});

describe("capSurroundingAfter", () => {
  it("恰好 800 原样返回", () => {
    const exact = "a".repeat(MAX_CHAT_SURROUNDING_AFTER_CHARS);
    expect(capSurroundingAfter(exact)).toBe(exact);
  });

  it("超长(801)取头部 800 并后置 …", () => {
    const overlong = `a${"b".repeat(MAX_CHAT_SURROUNDING_AFTER_CHARS)}`;
    const capped = capSurroundingAfter(overlong);
    expect(capped).toBe(`${overlong.slice(0, MAX_CHAT_SURROUNDING_AFTER_CHARS)}…`);
    expect(capped.at(-1)).toBe("…");
    expect(capped).toHaveLength(MAX_CHAT_SURROUNDING_AFTER_CHARS + 1);
  });
});

describe("capSurroundingCurrent", () => {
  it("≤4000 原样返回(先 trim),两端无 …", () => {
    const text = "Readers parse this anchor sentence today.";
    expect(capSurroundingCurrent(text, "anchor sentence")).toBe(text);
    expect(capSurroundingCurrent(`  ${text}  `, "anchor sentence")).toBe(text);
  });

  it("超长且锚句命中:窗口完整包含锚句,总长 ≤4000+2,两端真截断各标一个 …", () => {
    const anchor = "THE-ANCHOR-SENTENCE";
    const text = `${"a".repeat(2000)}${anchor}${"b".repeat(3000)}`;
    const capped = capSurroundingCurrent(text, anchor);
    expect(capped.length).toBeLessThanOrEqual(MAX_CHAT_SURROUNDING_CURRENT_CHARS + 2);
    expect(capped).toContain(anchor);
    // 命中位置 2000,回看 1200 → 窗口 [800, 4800):两端都真截断
    const start = 2000 - MAX_CHAT_SURROUNDING_BEFORE_CHARS;
    const end = start + MAX_CHAT_SURROUNDING_CURRENT_CHARS;
    expect(capped).toBe(`…${text.slice(start, end)}…`);
  });

  it("锚句贴段尾:尾端没截断就不后置 …,只有前缀一个 …", () => {
    const anchor = "THE-ANCHOR-SENTENCE";
    const text = `${"a".repeat(2000)}${anchor}`;
    const start = 2000 - MAX_CHAT_SURROUNDING_BEFORE_CHARS;
    const capped = capSurroundingCurrent(text, anchor);
    expect(capped).toBe(`…${text.slice(start)}`);
    expect(capped.endsWith("…")).toBe(false);
  });

  it("锚句长于窗口:改从锚句起始处开窗(不再追求完整包含)", () => {
    const anchor = "L".repeat(MAX_CHAT_SURROUNDING_CURRENT_CHARS + 500);
    const text = `${"x".repeat(100)}${anchor}${"y".repeat(100)}`;
    const capped = capSurroundingCurrent(text, anchor);
    expect(capped).toBe(`…${text.slice(100, 100 + MAX_CHAT_SURROUNDING_CURRENT_CHARS)}…`);
    expect(capped).not.toContain(anchor);
  });

  it("锚句不命中:回落头部窗口,无前缀 …", () => {
    const text = "c".repeat(MAX_CHAT_SURROUNDING_CURRENT_CHARS + 1000);
    const capped = capSurroundingCurrent(text, "SENTENCE-NOT-PRESENT");
    expect(capped).toBe(`${text.slice(0, MAX_CHAT_SURROUNDING_CURRENT_CHARS)}…`);
    expect(capped.startsWith("…")).toBe(false);
  });
});

describe("documentOrderedNeighbors", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  const candidateOf = (text: string): SurroundingCandidate => {
    const element = document.createElement("p");
    element.textContent = text;
    document.body.append(element);
    return { element, text };
  };

  it("三个段落按 DOM 序构造、candidates 乱序传入:before/after 仍是 DOM 序 ±1", () => {
    const first = candidateOf("First paragraph.");
    const middle = candidateOf("Middle paragraph.");
    const last = candidateOf("Last paragraph.");

    const neighbors = documentOrderedNeighbors([last, middle, first], middle);

    expect(neighbors.before).toBe(first);
    expect(neighbors.after).toBe(last);
  });

  it("current 不在候选里:并入排序后仍取到真实邻块", () => {
    const first = candidateOf("First paragraph.");
    const middle = candidateOf("Middle paragraph.");
    const last = candidateOf("Last paragraph.");

    const neighbors = documentOrderedNeighbors([last, first], middle);

    expect(neighbors.before).toBe(first);
    expect(neighbors.after).toBe(last);
  });

  it("current 脱 DOM:两项邻块均不置", () => {
    const first = candidateOf("First paragraph.");
    const middle = candidateOf("Middle paragraph.");
    const last = candidateOf("Last paragraph.");
    middle.element.remove();

    expect(documentOrderedNeighbors([last, first, middle], middle)).toStrictEqual({});
  });
});

describe("buildChatSurroundings", () => {
  it("邻段缺省不置键;在场的键走各自封顶", () => {
    const overlong = `a${"b".repeat(MAX_CHAT_SURROUNDING_AFTER_CHARS)}`;
    const surroundings = buildChatSurroundings({
      neighbors: { after: overlong },
      currentText: "Current paragraph holds the anchor sentence.",
      anchorText: "anchor sentence",
    });
    expect(surroundings).toStrictEqual({
      current: "Current paragraph holds the anchor sentence.",
      after: `${overlong.slice(0, MAX_CHAT_SURROUNDING_AFTER_CHARS)}…`,
    });
  });
});
