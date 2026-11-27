import type { ChatSurroundings } from "../shared/protocol";
import {
  MAX_CHAT_SURROUNDING_AFTER_CHARS,
  MAX_CHAT_SURROUNDING_BEFORE_CHARS,
  MAX_CHAT_SURROUNDING_CURRENT_CHARS,
} from "../shared/protocol";

/**
 * 追问对话的段落级上下文(2026-11-28 spec)——纯函数,不碰 DOM 写、不发消息。
 * 封顶常量从 protocol.ts import,本模块不出现第二处数字;截断标记 `…` 是
 * U+2026 单字符,只出现在真截断边界。IntelliJ web 侧
 * (`intellij-plugin/src/main/resources/web/chat-surroundings.ts`)逐函数镜像本
 * 文件,导出名与行为必须一致——改这里要同步那边。
 */

export interface SurroundingCandidate {
  element: HTMLElement;
  text: string;
}

/**
 * 候选按 compareDocumentPosition 排文档序,返回 current 的 ±1;current 脱 DOM
 * 或不在候选里时按并入排序处理,均无邻块则两项 undefined。
 *
 * 文档序是唯一真相:Map 插入序在「轻量→全量升级」(悬停块先注册,扫描其余按
 * fresh 过滤追加)与突变刷新(失效块删后重插到尾部)下都会错位,拿它取邻段会
 * 静默喂错「上一段」——正是本特性要修的失败模式。current 脱 DOM(轻量会话的
 * 选区锚被回收)时没有文档序锚点,两项邻块均不置(prompt 侧按 `none` 占位)。
 */
export function documentOrderedNeighbors(
  candidates: readonly SurroundingCandidate[],
  current: SurroundingCandidate,
): { before?: SurroundingCandidate; after?: SurroundingCandidate } {
  // 过滤已脱 DOM 的元素(current 在内):断开节点没有可比的文档序。
  const pool: SurroundingCandidate[] = [];
  for (const candidate of [...candidates, current]) {
    if (!candidate.element.isConnected) continue;
    // 按 element 身份去重:块候选与一次性扫描清单常含同一元素,重复条目会
    // 让 ±1 取到「同一个块的两份」。保留先到的那份(pool 顺序即并入顺序)。
    if (pool.some(({ element }) => element === candidate.element)) continue;
    pool.push(candidate);
  }
  const ordered = pool.sort((a, b) =>
    a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
  );
  const index = ordered.findIndex(({ element }) => element === current.element);
  if (index === -1) return {};
  const neighbors: { before?: SurroundingCandidate; after?: SurroundingCandidate } = {};
  if (index > 0) neighbors.before = ordered[index - 1]!;
  if (index < ordered.length - 1) neighbors.after = ordered[index + 1]!;
  return neighbors;
}

/** trim 后 ≤1200 原样返回;超长取尾部 1200 字符并前置 "…"(U+2026)。 */
export function capSurroundingBefore(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_CHAT_SURROUNDING_BEFORE_CHARS) return trimmed;
  return `…${trimmed.slice(trimmed.length - MAX_CHAT_SURROUNDING_BEFORE_CHARS)}`;
}

/** trim 后 ≤800 原样返回;超长取头部 800 字符并后置 "…"。 */
export function capSurroundingAfter(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_CHAT_SURROUNDING_AFTER_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_CHAT_SURROUNDING_AFTER_CHARS)}…`;
}

/**
 * current 段封顶:trim 后 ≤4000 原样返回;超长取句锚窗口——以锚句在段内的
 * 命中位置为中心,向前回看至多 1200(与 before 段同一预算,是算法钉死的取值,
 * 引用同一常量而不是写出第二处 1200),窗口共 4000。窗口盖不住整条锚句(锚句
 * 长于窗口)时改从锚句起始处开窗,宁可截掉锚句尾部也不丢起点。两端 `…` 仅在
 * 真截断时出现。锚句不命中(理论到不了:锚句是段文本的子串)回落头部窗口。
 */
export function capSurroundingCurrent(text: string, anchorText: string): string {
  const trimmed = text.trim();
  const idx = trimmed.indexOf(anchorText);
  let start = idx >= 0 ? Math.max(0, idx - MAX_CHAT_SURROUNDING_BEFORE_CHARS) : 0;
  let end = start + MAX_CHAT_SURROUNDING_CURRENT_CHARS;
  if (idx >= 0 && end < idx + anchorText.length) {
    start = idx;
    end = idx + MAX_CHAT_SURROUNDING_CURRENT_CHARS;
  }
  end = Math.min(trimmed.length, end);
  return `${start > 0 ? "…" : ""}${trimmed.slice(start, end)}${end < trimmed.length ? "…" : ""}`;
}

/** 组装 ChatSurroundings:邻段缺省(undefined)不置键,current 恒置。 */
export function buildChatSurroundings(input: {
  neighbors: { before?: string; after?: string };
  currentText: string;
  anchorText: string;
}): ChatSurroundings {
  return {
    ...(input.neighbors.before === undefined
      ? {}
      : { before: capSurroundingBefore(input.neighbors.before) }),
    current: capSurroundingCurrent(input.currentText, input.anchorText),
    ...(input.neighbors.after === undefined
      ? {}
      : { after: capSurroundingAfter(input.neighbors.after) }),
  };
}
