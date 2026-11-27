// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_CHAT_SURROUNDING_AFTER_CHARS,
  MAX_CHAT_SURROUNDING_BEFORE_CHARS,
  MAX_CHAT_SURROUNDING_CURRENT_CHARS,
} from "./bridge";
import {
  buildChatSurroundings,
  capSurroundingAfter,
  capSurroundingBefore,
  capSurroundingCurrent,
  documentOrderedNeighbors,
} from "./chat-surroundings";
import type { SurroundingCandidate } from "./chat-surroundings";

/**
 * 纯函数模块的边界测试：**逐用例镜像 Chrome 端**
 * `chrome-plugin/src/content/chat-surroundings.test.ts`（同断言、同值——封顶常量全部
 * 引用 bridge.ts 导出的常量 1200/800/4000，边界输入由常量 ±1 构造，不出现第二处字面
 * 数字）。截断标记 `…` 计入各自封顶（2026-11-28 裁决）：截断产出的字段值恒 ≤ cap，与
 * Kotlin 桥门 parseChatAsk 的「length ≤ cap」判据一致——真机长段落的上下文不再被
 * MALFORMED_MESSAGE 拒收。Chrome 侧改这条文件须同步镜像这边（反向亦然）。
 */

describe("capSurroundingBefore", () => {
  it("恰好 1200 原样返回", () => {
    const exact = "b".repeat(MAX_CHAT_SURROUNDING_BEFORE_CHARS);
    expect(capSurroundingBefore(exact)).toBe(exact);
  });

  it("超长(1201)：… + 尾 1199，总长恰 1200(标记计入封顶)", () => {
    const overlong = `y${"b".repeat(MAX_CHAT_SURROUNDING_BEFORE_CHARS)}`;
    const capped = capSurroundingBefore(overlong);
    expect(capped).toBe(`…${"b".repeat(MAX_CHAT_SURROUNDING_BEFORE_CHARS - 1)}`);
    expect(capped[0]).toBe("…");
    expect(capped).toHaveLength(MAX_CHAT_SURROUNDING_BEFORE_CHARS);
  });

  it("首尾空白先 trim 再判封顶", () => {
    const exact = "b".repeat(MAX_CHAT_SURROUNDING_BEFORE_CHARS);
    expect(capSurroundingBefore(`  ${exact}  `)).toBe(exact);
    // trim 后超长：被裁掉的是空白，不占尾部 1199 的预算
    const overlong = `y${"b".repeat(MAX_CHAT_SURROUNDING_BEFORE_CHARS)}`;
    expect(capSurroundingBefore(` ${overlong} `)).toBe(
      `…${"b".repeat(MAX_CHAT_SURROUNDING_BEFORE_CHARS - 1)}`,
    );
  });
});

describe("capSurroundingAfter", () => {
  it("恰好 800 原样返回", () => {
    const exact = "a".repeat(MAX_CHAT_SURROUNDING_AFTER_CHARS);
    expect(capSurroundingAfter(exact)).toBe(exact);
  });

  it("超长(801)：头 799 + …，总长恰 800(标记计入封顶)", () => {
    const overlong = `a${"b".repeat(MAX_CHAT_SURROUNDING_AFTER_CHARS)}`;
    const capped = capSurroundingAfter(overlong);
    expect(capped).toBe(`${overlong.slice(0, MAX_CHAT_SURROUNDING_AFTER_CHARS - 1)}…`);
    expect(capped.at(-1)).toBe("…");
    expect(capped).toHaveLength(MAX_CHAT_SURROUNDING_AFTER_CHARS);
  });
});

describe("capSurroundingCurrent", () => {
  it("≤4000 原样返回(先 trim)，两端无 …", () => {
    const text = "Readers parse this anchor sentence today.";
    expect(capSurroundingCurrent(text, "anchor sentence")).toBe(text);
    expect(capSurroundingCurrent(`  ${text}  `, "anchor sentence")).toBe(text);
    // 锚句离段首超过回看 1200 也一样：不超 4000 的段永远原样，不开窗不加标记
    const farAnchor = `${"a".repeat(MAX_CHAT_SURROUNDING_BEFORE_CHARS + 500)}THE-ANCHOR-SENTENCE`;
    expect(capSurroundingCurrent(farAnchor, "THE-ANCHOR-SENTENCE")).toBe(farAnchor);
  });

  it("超长且锚句命中：窗口完整包含锚句，总长恰 4000(两个 … 计入封顶)", () => {
    const anchor = "THE-ANCHOR-SENTENCE";
    const text = `${"a".repeat(2000)}${anchor}${"b".repeat(3000)}`;
    const capped = capSurroundingCurrent(text, anchor);
    expect(capped).toContain(anchor);
    // 命中位置 2000，回看 1200 → 起点 800；双侧真截断 → 净窗 = 4000 − 2 个标记
    const start = 2000 - MAX_CHAT_SURROUNDING_BEFORE_CHARS;
    const net = MAX_CHAT_SURROUNDING_CURRENT_CHARS - 2;
    expect(capped).toBe(`…${text.slice(start, start + net)}…`);
    expect(capped).toHaveLength(MAX_CHAT_SURROUNDING_CURRENT_CHARS);
  });

  it("锚句贴段尾：尾端没截断就不后置 …，只有前缀一个 …", () => {
    const anchor = "THE-ANCHOR-SENTENCE";
    // 段长须 > 4000 才开窗；锚句贴段尾 → 窗口右端贴到段尾，无右标记
    const head = MAX_CHAT_SURROUNDING_CURRENT_CHARS + 1000;
    const text = `${"a".repeat(head)}${anchor}`;
    const start = head - MAX_CHAT_SURROUNDING_BEFORE_CHARS;
    const capped = capSurroundingCurrent(text, anchor);
    expect(capped).toBe(`…${text.slice(start)}`);
    expect(capped.endsWith("…")).toBe(false);
    expect(capped.length).toBeLessThanOrEqual(MAX_CHAT_SURROUNDING_CURRENT_CHARS);
  });

  it("单侧贴段尾：省下的标记预算还给窗口，总长恰 4000 且无尾标记", () => {
    const anchor = "THE-ANCHOR-SENTENCE";
    // 段尾恰好落在「回看起点 + (4000 − 左标记 1)」上：净窗用满 3999，省下的
    // 右标记预算如数还给窗口，总长恰 4000 且尾端无标记(真截断才标)。
    const start = 2000 - MAX_CHAT_SURROUNDING_BEFORE_CHARS;
    const tailLength = start + MAX_CHAT_SURROUNDING_CURRENT_CHARS - 1 - (2000 + anchor.length);
    const text = `${"a".repeat(2000)}${anchor}${"b".repeat(tailLength)}`;
    const capped = capSurroundingCurrent(text, anchor);
    expect(capped).toBe(`…${text.slice(start)}`);
    expect(capped).toContain(anchor);
    expect(capped).toHaveLength(MAX_CHAT_SURROUNDING_CURRENT_CHARS);
    expect(capped.endsWith("…")).toBe(false);
  });

  it("锚句长于窗口：改从锚句起始处开窗(不再追求完整包含)", () => {
    const anchor = "L".repeat(MAX_CHAT_SURROUNDING_CURRENT_CHARS + 500);
    const text = `${"x".repeat(100)}${anchor}${"y".repeat(100)}`;
    const capped = capSurroundingCurrent(text, anchor);
    // re-anchor 到锚句起点(100)，双侧真截断 → 净窗 = 4000 − 2
    const net = MAX_CHAT_SURROUNDING_CURRENT_CHARS - 2;
    expect(capped).toBe(`…${text.slice(100, 100 + net)}…`);
    expect(capped).not.toContain(anchor);
    expect(capped).toHaveLength(MAX_CHAT_SURROUNDING_CURRENT_CHARS);
  });

  it("锚句差 1 字符装不进回看窗：改从锚句起点开窗后完整保留锚句", () => {
    // 锚句距段首 100(回看盖全前缀，起点 0)，锚句尾 100+3900 比最宽净窗右端
    // 3999 超出 1 字符 → 放弃回看，窗口改从锚句起点开，锚句完整包含。
    const anchor = "A".repeat(3900);
    const text = `${"x".repeat(100)}${anchor}${"y".repeat(1000)}`;
    const capped = capSurroundingCurrent(text, anchor);
    const net = MAX_CHAT_SURROUNDING_CURRENT_CHARS - 2;
    expect(capped).toBe(`…${text.slice(100, 100 + net)}…`);
    expect(capped).toContain(anchor);
    expect(capped).toHaveLength(MAX_CHAT_SURROUNDING_CURRENT_CHARS);
  });

  it("锚句不命中：回落头部窗口，无前缀 …，总长恰 4000", () => {
    const text = "c".repeat(MAX_CHAT_SURROUNDING_CURRENT_CHARS + 1000);
    const capped = capSurroundingCurrent(text, "SENTENCE-NOT-PRESENT");
    // 头部贴边无左标记，右标记占 1 字符预算 → 净窗 3999
    expect(capped).toBe(`${text.slice(0, MAX_CHAT_SURROUNDING_CURRENT_CHARS - 1)}…`);
    expect(capped.startsWith("…")).toBe(false);
    expect(capped).toHaveLength(MAX_CHAT_SURROUNDING_CURRENT_CHARS);
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

  it("三个段落按 DOM 序构造、candidates 乱序传入：before/after 仍是 DOM 序 ±1", () => {
    const first = candidateOf("First paragraph.");
    const middle = candidateOf("Middle paragraph.");
    const last = candidateOf("Last paragraph.");

    const neighbors = documentOrderedNeighbors([last, middle, first], middle);

    expect(neighbors.before).toBe(first);
    expect(neighbors.after).toBe(last);
  });

  it("current 不在候选里：并入排序后仍取到真实邻块", () => {
    const first = candidateOf("First paragraph.");
    const middle = candidateOf("Middle paragraph.");
    const last = candidateOf("Last paragraph.");

    const neighbors = documentOrderedNeighbors([last, first], middle);

    expect(neighbors.before).toBe(first);
    expect(neighbors.after).toBe(last);
  });

  it("current 脱 DOM：两项邻块均不置", () => {
    const first = candidateOf("First paragraph.");
    const middle = candidateOf("Middle paragraph.");
    const last = candidateOf("Last paragraph.");
    middle.element.remove();

    expect(documentOrderedNeighbors([last, first, middle], middle)).toStrictEqual({});
  });
});

describe("buildChatSurroundings", () => {
  it("邻段缺省不置键；在场的键走各自封顶(标记计入)", () => {
    const overlong = `a${"b".repeat(MAX_CHAT_SURROUNDING_AFTER_CHARS)}`;
    const surroundings = buildChatSurroundings({
      neighbors: { after: overlong },
      currentText: "Current paragraph holds the anchor sentence.",
      anchorText: "anchor sentence",
    });
    expect(surroundings).toStrictEqual({
      current: "Current paragraph holds the anchor sentence.",
      after: `${overlong.slice(0, MAX_CHAT_SURROUNDING_AFTER_CHARS - 1)}…`,
    });
  });
});
