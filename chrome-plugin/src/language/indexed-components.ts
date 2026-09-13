import type { CoreComponent, Token } from "../shared/grammar";

/**
 * 诊断坐标载体:validator 内部用,把「语义成分序列」与「模型所见 JSON 的
 * components 数组下标(rawIndex)」绑定起来。
 *
 * 为什么需要:旧实现先丢弃纯标点成分再重编号,错误路径指向过滤后数组;而
 * repair prompt 里给模型看的 Invalid JSON 是原始数组——错误指向隔壁成分
 * (真机实测 15 例),模型照着 repair 指令改错位置。rawIndex 只进错误路径,
 * 不进返回给渲染与缓存的 CoreAnalysis.components。
 *
 * 刻意不做的事:不把 rawIndex 加进公共 CoreComponent,也不用两个平行数组
 * ——两者都会再次引入对齐风险。
 */

export interface RawComponentEntry {
  readonly rawIndex: number;
  readonly value: unknown;
}

export interface ParsedComponentEntry {
  readonly rawIndex: number;
  readonly component: CoreComponent | undefined;
}

export interface IndexedCoreComponent {
  readonly rawIndex: number;
  readonly component: CoreComponent;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 纯标点区间:区间落在句内、首尾 token 恰好是区间端点、且覆盖的每个 token
 * 都是标点。与旧 `semanticComponents` 过滤判据逐条等价——非对象、非安全整数
 * 区间都不算纯标点(保留给解析阶段报错),模型虚构的 role 不参与判定。
 */
function isPunctuationOnly(value: unknown, tokens: readonly Token[]): boolean {
  if (!isRecord(value)) return false;
  const { startToken, endToken } = value;
  if (!Number.isSafeInteger(startToken) || !Number.isSafeInteger(endToken)) return false;
  const covered = tokens.filter(
    (token) => token.id >= (startToken as number) && token.id <= (endToken as number),
  );
  return (
    covered.length > 0 &&
    covered[0]!.id === startToken &&
    covered.at(-1)!.id === endToken &&
    covered.every((token) => token.punctuation)
  );
}

/**
 * 先记录原始下标,再按纯标点判据排除——顺序不能反,否则 rawIndex 与模型
 * 所见 JSON 的下标失配。返回空数组表示全纯标点,由调用方报
 * "must contain a non-punctuation component"。
 */
export function rawComponentEntries(
  components: readonly unknown[],
  tokens: readonly Token[],
): RawComponentEntry[] {
  return components
    .map((value, rawIndex) => ({ rawIndex, value }))
    .filter((entry) => !isPunctuationOnly(entry.value, tokens));
}

/** 解析尝试序列里只留成功解析的成分;rawIndex 跟着走,失败的留给调用方计数。 */
export function toIndexed(entries: readonly ParsedComponentEntry[]): IndexedCoreComponent[] {
  return entries.flatMap((entry) =>
    entry.component === undefined ? [] : [{ rawIndex: entry.rawIndex, component: entry.component }],
  );
}
