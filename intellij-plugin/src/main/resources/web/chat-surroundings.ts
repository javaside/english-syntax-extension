import type { ChatSurroundings } from "./bridge";
import {
  MAX_CHAT_SURROUNDING_AFTER_CHARS,
  MAX_CHAT_SURROUNDING_BEFORE_CHARS,
  MAX_CHAT_SURROUNDING_CURRENT_CHARS,
} from "./bridge";

/**
 * 追问对话的段落级上下文(2026-11-28 spec)——纯函数,不碰 DOM 写、不发消息。
 * **逐函数镜像 `chrome-plugin/src/content/chat-surroundings.ts`**(同名导出:
 * SurroundingCandidate / documentOrderedNeighbors / capSurroundingBefore/After/Current /
 * buildChatSurroundings,同行为同语义)——改那边要同步这边,反向亦然;镜像测试
 * `chat-surroundings.test.ts` 同样逐用例镜像 Chrome 的测试文件(同断言同值)。
 *
 * 封顶常量从 bridge.ts import(Chrome 端从 protocol.ts),本模块不出现第二处数字;
 * 截断标记 `…` 是 U+2026 单字符,只出现在真截断边界,且**计入各自封顶**(2026-11-28
 * 裁决):截断产出的字段值恒 ≤ cap,与 Kotlin 桥门 parseChatAsk 的「length ≤ cap」
 * 判据一致,真机长段落的上下文不会被 MALFORMED_MESSAGE 拒收。
 *
 * 镜像契约注意(Task 3 遗留裁决):纯空白输入 trim 后返回 ""——会撞桥门
 * trim-非空判而整条消息被拒。该输入经扫描门(英文占比 ≥ 60%/最短长度)不可达,
 * 镜像刻意保持同构不在此处补防御(与 Chrome 侧行为一字不差),调用方
 * (bootstrap sendChatAsk)以「current 查不到才省键」做优雅降级。
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

/** trim 后 ≤1200 原样返回;超长 = "…"(U+2026) + 尾 1199,总长恰 1200(标记计入)。 */
export function capSurroundingBefore(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_CHAT_SURROUNDING_BEFORE_CHARS) return trimmed;
  return `…${trimmed.slice(trimmed.length - (MAX_CHAT_SURROUNDING_BEFORE_CHARS - 1))}`;
}

/** trim 后 ≤800 原样返回;超长 = 头 799 + "…",总长恰 800(标记计入)。 */
export function capSurroundingAfter(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_CHAT_SURROUNDING_AFTER_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_CHAT_SURROUNDING_AFTER_CHARS - 1)}…`;
}

/**
 * current 段封顶:trim 后 ≤4000 原样返回;超长取句锚窗口——以锚句在段内的
 * 命中位置定窗(命中则向前回看至多 1200,与 before 段同一预算,是算法钉死的
 * 取值,引用同一常量而不是写出第二处 1200;未命中回落头部窗口)。`…` 标记
 * 计入 4000 总预算(2026-11-28 裁决):两侧都真截断时净窗 4000−2;一侧贴到
 * 段尾(无该侧标记)时省下的预算还给窗口;产出总长恒 ≤4000,与 Kotlin 桥门的
 * 「length ≤ cap」判据一致。锚句连同回看前缀装不进从回看起点出发的最宽净窗
 * 时,改从锚句起始处开窗——宁可截掉锚句尾部也不丢起点(锚句允许被截断)。
 * 标记只出现在真截断边界。锚句不命中(理论到不了:锚句是段文本的子串)回落
 * 头部窗口。
 */
export function capSurroundingCurrent(text: string, anchorText: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_CHAT_SURROUNDING_CURRENT_CHARS) return trimmed;
  // 净窗预算 = 4000 − 左侧标记数:起点贴 0 时左侧没真截断,省下的 1 字符还给窗口。
  const budgetFrom = (start: number): number =>
    MAX_CHAT_SURROUNDING_CURRENT_CHARS - (start > 0 ? 1 : 0);
  // 从 start 起的最宽净窗右端:能贴到段尾(无右标记,预算如数还给窗口)就取
  // 段尾,否则给右标记留 1 字符。
  const widestEnd = (start: number): number => {
    const budget = budgetFrom(start);
    return start + budget >= trimmed.length ? trimmed.length : start + budget - 1;
  };
  const idx = trimmed.indexOf(anchorText);
  let start = idx >= 0 ? Math.max(0, idx - MAX_CHAT_SURROUNDING_BEFORE_CHARS) : 0;
  // 锚句装不进回看窗 → 放弃回看,窗口改从锚句起点开(锚句尾部允许截断)。
  if (idx >= 0 && idx + anchorText.length > widestEnd(start)) start = idx;
  const end = widestEnd(start);
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
