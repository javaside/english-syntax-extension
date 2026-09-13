import type { SentenceInput } from "../shared/protocol";
import type { ValidationError } from "../language/analysis-validator";

/**
 * repair 错误的按句分组。
 *
 * 背景:验证器对每句单独调用,错误路径恒以 sentences[0] 起;而 repair 把多句
 * 的错误扁平拼进同一个 prompt(flatMap(errors))——模型收到的 47/108 个多句
 * repair 里所有错误都标着 sentences[0],无从判断该改哪一句。这里把错误
 * 重新按句分组,并给每句一个稳定的 rawOccurrence(该 sentenceId 在 raw 里
 * 的第几个实例)。
 *
 * 这是发给模型的序列化形状,不是浏览器桥协议的一部分。
 */
export interface RepairErrorGroup {
  sentenceId: string;
  /** 该 sentenceId 在 raw sentences 里的第几个实例(零基);missing 时缺省。 */
  rawOccurrence?: number;
  kind: "invalid" | "missing" | "duplicate";
  errors: readonly ValidationError[];
}

function rawSentenceIds(raw: unknown): string[] {
  if (typeof raw !== "object" || raw === null) return [];
  const sentences = (raw as { sentences?: unknown }).sentences;
  if (!Array.isArray(sentences)) return [];
  return sentences.map((entry) => {
    if (typeof entry !== "object" || entry === null) return "";
    const id = (entry as { sentenceId?: unknown }).sentenceId;
    return typeof id === "string" ? id : "";
  });
}

const SENTENCE_PREFIX = /^sentences\[\d+\]\.?/;

/**
 * 关键:出现重复实例时**不能吞掉首实例自身的结构错误**——重复与非法可以
 * 并存,两者必须各出一组。首实例按 invalid 带去掉 sentences[i] 前缀的错误;
 * 每个重复实例各出一条删除指令(指明删第几个)。
 */
export function groupRepairErrors(
  invalid: readonly { sentence: SentenceInput; errors: readonly ValidationError[] }[],
  raw: unknown,
): RepairErrorGroup[] {
  const ids = rawSentenceIds(raw);
  const groups: RepairErrorGroup[] = [];
  for (const { sentence, errors } of invalid) {
    const occurrences = ids.filter((id) => id === sentence.sentenceId).length;
    if (occurrences === 0) {
      groups.push({
        sentenceId: sentence.sentenceId,
        kind: "missing",
        errors: [{ path: "", message: "no output for this sentenceId; emit it" }],
      });
      continue;
    }
    const stripped = errors
      // 「is duplicated」是批级簿记错误,不是该实例的结构错误:不进首实例组。
      .filter(({ message }) => !message.includes("is duplicated"))
      .map(({ path, message }) => ({ path: path.replace(SENTENCE_PREFIX, ""), message }));
    if (stripped.length > 0) {
      groups.push({
        sentenceId: sentence.sentenceId,
        rawOccurrence: 0,
        kind: "invalid",
        errors: stripped,
      });
    }
    for (let occurrence = 1; occurrence < occurrences; occurrence += 1) {
      groups.push({
        sentenceId: sentence.sentenceId,
        rawOccurrence: occurrence,
        kind: "duplicate",
        errors: [{ path: "", message: "remove this duplicate instance" }],
      });
    }
  }
  return groups;
}
