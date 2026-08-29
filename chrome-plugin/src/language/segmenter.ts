import type { Token } from "../shared/grammar";

export interface SegmentedSentence {
  text: string;
  start: number;
  end: number;
}

export interface SentenceIdInput {
  sessionId: string;
  blockId: string;
  order: number;
  normalizedText: string;
}

/**
 * 分句边界由**本仓库自己定义**,不用 `Intl.Segmenter`。
 *
 * 两端必须逐字节一致(缓存键取规范化句文本,分叉即互不命中),而 `Intl.Segmenter`
 * 与 JVM `BreakIterator` 对同一段文本给出的原始边界并不相同:实测
 * `1. Install the CLI. 2. Run the setup.` 前者切 4 段、后者切 3 段(它把
 * `Install the CLI. 2.` 并成一段)。只要还从平台边界出发做取舍,这类分叉就补不完。
 *
 * 规则本身很短:句末标点串 + 可选的收尾引号/括号 + 空白,即一处候选边界;
 * 之后再由 `mergesIntoNext` 撤掉不该断的那些(缩写、首字母、无实词片段)。
 */
/** JS whitespace 的显式字符类；不使用两端语义不同的 `\s`。 */
const JS_WHITESPACE =
  "\\u0009-\\u000d\\u0020\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff";
const SENTENCE_BOUNDARY_PATTERN = new RegExp(
  `[.!?…。！？]+["'”’)\\]}»]*(?=[${JS_WHITESPACE}])`,
  "gu",
);
/**
 * `Intl.Segmenter` 只按 UAX#29 判句末,凡「小写字母 + 句点 + 空格 + 大写」都算边界,
 * 所以缩写会被切断。白名单里的每一条都是实测会被切错的(`vs.` / `pp.` / `Capt.` …),
 * 其余如 `etc.` / `Inc.` / `Ph.D.` 是同类风险的预防性补充。
 *
 * 匹配**必须带词首边界**:光用 `endsWith("p.")` 会把 "Please stop." 也当缩写,
 * 于是整段英文只剩一句。
 */
const ABBREVIATIONS = [
  "Mr.",
  "Mrs.",
  "Ms.",
  "Dr.",
  "Prof.",
  "Sr.",
  "Jr.",
  "Rev.",
  "Capt.",
  "Lt.",
  "Sgt.",
  "Col.",
  "Maj.",
  "Gen.",
  "Gov.",
  "Sen.",
  "Rep.",
  "St.",
  "Ave.",
  "Blvd.",
  "Rd.",
  "Inc.",
  "Ltd.",
  "Co.",
  "Corp.",
  "Dept.",
  "Univ.",
  "No.",
  "Fig.",
  "Ch.",
  "Vol.",
  "p.",
  "pp.",
  "vs.",
  "cf.",
  "approx.",
  "et al.",
  "e.g.",
  "i.e.",
  "a.m.",
  "p.m.",
  "U.S.",
  "Ph.D.",
];
/**
 * 有些缩写强烈要求后接名字/内容（称谓等），另一些也常合法收句。后者只有在下一片段
 * 以小写词或数字开头时才撤销边界：`U.S. delegation` 合并，`U.S. She` 保留边界。
 */
const CONTEXT_SENSITIVE_ABBREVIATIONS = ["U.S.", "Ph.D.", "Inc.", "Ltd.", "Co.", "Corp."];
const ALWAYS_NON_TERMINAL_ABBREVIATIONS = ABBREVIATIONS.filter(
  (abbreviation) => !CONTEXT_SENSITIVE_ABBREVIATIONS.includes(abbreviation),
);
function abbreviationEndPattern(abbreviations: readonly string[]): RegExp {
  return new RegExp(
    `(?:^|[${JS_WHITESPACE}("'“‘\\[])(?:${abbreviations
      .map((abbreviation) =>
        abbreviation.replaceAll(".", "\\.").replaceAll(" ", `[${JS_WHITESPACE}]+`),
      )
      .join("|")})$`,
    "u",
  );
}
const ALWAYS_NON_TERMINAL_END = abbreviationEndPattern(ALWAYS_NON_TERMINAL_ABBREVIATIONS);
const CONTEXT_SENSITIVE_END = abbreviationEndPattern(CONTEXT_SENSITIVE_ABBREVIATIONS);
const CONTINUATION_START_PATTERN = new RegExp(
  `^[${JS_WHITESPACE}]*["'“‘(\\[]*[\\p{Ll}\\p{N}]`,
  "u",
);
/**
 * 独立的单个大写字母 + 句点 = 姓名首字母缩写("Written by J. R. Smith.")。
 * 代价是 "The answer is A." 会与下一句合并,但散文里首字母缩写远比这种句子常见。
 */
const INITIAL_PATTERN = new RegExp(`(?:^|[${JS_WHITESPACE}("'“‘\\[])\\p{Lu}\\.$`, "u");
/** 至少两个连续字母才算实词。缺了它的片段("1." / "J." / "---")无法解析,只能并入邻句。 */
const LEXICAL_WORD_PATTERN = /\p{L}{2,}/u;

/**
 * Token 是模型定位成分的唯一坐标,所以一个语言学上的整体必须是一个 Token。
 * 拆碎了会直接伤到划分:`U.S.` 曾切成 `U` `.` `S` `.` 四个 Token,模型要么把
 * 主语标成三段、要么把句点吞进主语;URL 一条 `https://example.com/a` 曾散成
 * 10 个 Token,几乎必然出现「非标点 token 未被覆盖」而整句进修复轮。
 *
 * 顺序即优先级:URL / 邮箱 → 缩写 → 带小数点或千分位的数 → 普通词 → 单个非空白字符。
 * 前四条都要求字面上的 `.`,所以不会咬进普通单词("stop." 里的 `p.` 匹配不到,
 * 因为扫描从 `s` 起就被普通词分支吃掉了)。
 */
const URL_SOURCE = `[A-Za-z][A-Za-z0-9+.-]*://[^${JS_WHITESPACE}]*[^${JS_WHITESPACE}.,;:!?)\\]}'"]`;
const EMAIL_SOURCE = "[\\p{L}\\p{N}._%+-]+@[\\p{L}\\p{N}-]+(?:\\.[\\p{L}\\p{N}-]+)+";
/** 小数、千分位、语义化版本号。要求至少一组「分隔符 + 数字」,好让裸数字与 "1." 走普通词分支。 */
const NUMBER_SOURCE = "\\p{N}+(?:[.,]\\p{N}+)+";
const WORD_SOURCE = "[\\p{L}\\p{N}]+(?:['’-][\\p{L}\\p{N}]+)*";

function abbreviationSource(): string {
  // 长的排前面:否则 "Ph.D." 会先被 "p." 咬掉一截。
  return [...ABBREVIATIONS]
    .sort((left, right) => right.length - left.length)
    .map((abbreviation) =>
      abbreviation.replaceAll(".", "\\.").replaceAll(" ", `[${JS_WHITESPACE}]+`),
    )
    .join("|");
}

const TOKEN_PATTERN = new RegExp(
  [
    URL_SOURCE,
    EMAIL_SOURCE,
    abbreviationSource(),
    NUMBER_SOURCE,
    WORD_SOURCE,
    `[^${JS_WHITESPACE}]`,
  ].join("|"),
  "gu",
);
const WORD_START_PATTERN = /^[\p{L}\p{N}]/u;
const LEADING_WHITESPACE_PATTERN = new RegExp(`^[${JS_WHITESPACE}]+`, "u");
const TRAILING_WHITESPACE_PATTERN = new RegExp(`[${JS_WHITESPACE}]+$`, "u");

interface SentenceRange {
  start: number;
  end: number;
}

function endsWithNonTerminalAbbreviation(text: string, nextText: string): boolean {
  const trimmed = text.replace(TRAILING_WHITESPACE_PATTERN, "");
  return (
    ALWAYS_NON_TERMINAL_END.test(trimmed) ||
    INITIAL_PATTERN.test(trimmed) ||
    (CONTEXT_SENSITIVE_END.test(trimmed) && CONTINUATION_START_PATTERN.test(nextText))
  );
}

function hasLexicalWord(text: string): boolean {
  return LEXICAL_WORD_PATTERN.test(text);
}

/** 强非终结缩写、语境判为句中缩写、或无实词片段都不能独立成句。 */
function mergesIntoNext(text: string, nextText: string): boolean {
  return endsWithNonTerminalAbbreviation(text, nextText) || !hasLexicalWord(text);
}

function trimSentence(text: string, range: SentenceRange): SegmentedSentence | undefined {
  const raw = text.slice(range.start, range.end);
  const withoutLeadingWhitespace = raw.replace(LEADING_WHITESPACE_PATTERN, "");
  const trimmed = withoutLeadingWhitespace.replace(TRAILING_WHITESPACE_PATTERN, "");

  if (trimmed.length === 0) {
    return undefined;
  }

  const start = range.start + (raw.length - withoutLeadingWhitespace.length);
  return { text: trimmed, start, end: start + trimmed.length };
}

/** 候选边界:每个句末标点串之后的位置(含收尾引号/括号),外加整块末尾。 */
function boundaryOffsets(text: string): number[] {
  const offsets = [...text.matchAll(SENTENCE_BOUNDARY_PATTERN)].map(
    (match) => match.index + match[0].length,
  );
  if (offsets.at(-1) !== text.length) offsets.push(text.length);
  return offsets;
}

export function segmentBlock(text: string): SegmentedSentence[] {
  const merged: SentenceRange[] = [];
  let start = 0;
  for (const end of boundaryOffsets(text)) {
    const previous = merged.at(-1);
    // 合并后的跨度要重新判定,"J. R. R. Tolkien" 这样的链式首字母才能一路并下去。
    if (
      previous !== undefined &&
      mergesIntoNext(text.slice(previous.start, previous.end), text.slice(previous.end, end))
    ) {
      previous.end = end;
    } else {
      merged.push({ start, end });
    }
    start = end;
  }

  // 只有最后一段可能仍缺实词(前面的都在上面并进了下一段),它只能往前并。
  const last = merged.at(-1);
  if (
    merged.length > 1 &&
    last !== undefined &&
    !hasLexicalWord(text.slice(last.start, last.end))
  ) {
    merged[merged.length - 2]!.end = last.end;
    merged.pop();
  }

  return merged.flatMap((range) => {
    const sentence = trimSentence(text, range);
    // 整块只有一个无实词片段:发给模型也只会浪费一次请求。
    return sentence === undefined || !hasLexicalWord(sentence.text) ? [] : [sentence];
  });
}

export function tokenize(sentence: string): Token[] {
  const tokens: Token[] = [];
  let previousEnd = 0;

  for (const match of sentence.matchAll(TOKEN_PATTERN)) {
    const start = match.index;
    const text = match[0];
    const end = start + text.length;
    tokens.push({
      id: tokens.length,
      text,
      start,
      end,
      leadingWhitespace: sentence.slice(previousEnd, start),
      punctuation: !WORD_START_PATTERN.test(text),
    });
    previousEnd = end;
  }

  return tokens;
}

/**
 * 对 `segmentBlock` 已去掉首尾空白的生产句文本无损重建。Token schema 不保存句尾空白；
 * 那类空白属于 block 内句间 gap，而不是生产句输入的一部分。
 */
export function rebuildTokens(tokens: readonly Token[]): string {
  return tokens.map((token) => token.leadingWhitespace + token.text).join("");
}

export async function createSentenceId(input: SentenceIdInput): Promise<string> {
  const source = `${input.sessionId}\0${input.blockId}\0${input.order}\0${input.normalizedText}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 24);
}
