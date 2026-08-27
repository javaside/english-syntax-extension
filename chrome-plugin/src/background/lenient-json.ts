interface OpenContainer {
  readonly closer: "}" | "]";
  /** 对象容器:冒号之后、下一个逗号之前读到的字符串是值，不是键。 */
  awaitingValue: boolean;
}

interface Cut {
  /** 截断位置(不含),此处之前的文本是完整的若干个值。 */
  readonly index: number;
  /** 该处仍未闭合的容器的收尾括号，由内向外。 */
  readonly closers: string;
}

const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);
const OPENING_FENCE = /^```[A-Za-z]*[\t ]*\r?\n/u;
const TRAILING_FENCE = /\r?\n?```$/u;

function tryParse(candidate: string): unknown {
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * 摘掉 Markdown 围栏。收尾那道围栏正是最先被截掉的东西，所以开头那道要单独摘，
 * 不能只认成对出现的围栏(那是 stripSingleJsonFence 的活)。
 */
function stripFences(text: string): string {
  return text.trim().replace(OPENING_FENCE, "").replace(TRAILING_FENCE, "").trim();
}

/**
 * 按 JSON 词法扫一遍，记住「最后一个已闭合的值」的结束位置与当时未闭合的容器。
 * 截断点只落在值边界上:半截字符串、被截断的数字、只有键没有值的成员都不会留下。
 */
function lastCompleteValue(source: string): Cut | undefined {
  const stack: OpenContainer[] = [];
  let cut: Cut | undefined;
  let inString = false;
  let escaped = false;
  let inScalar = false;
  let started = false;

  const complete = (endExclusive: number): void => {
    const container = stack.at(-1);
    if (container !== undefined) container.awaitingValue = false;
    cut = {
      index: endExclusive,
      closers: stack
        .map(({ closer }) => closer)
        .reverse()
        .join(""),
    };
  };

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;

    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') {
        inString = false;
        const container = stack.at(-1);
        // 对象里的字符串可能是键,只有冒号之后那个才是值。
        if (container === undefined || container.closer === "]" || container.awaitingValue) {
          complete(index + 1);
        }
      }
      continue;
    }

    // 裸标量(数字/true/false/null)在分隔符之前就结束了。
    if (
      inScalar &&
      (WHITESPACE.has(character) || character === "," || character === "}" || character === "]")
    ) {
      inScalar = false;
      complete(index);
    }

    if (!started) {
      // 正文之前的客套话不参与词法(免得把散文里的词当标量或字符串)。
      if (character !== "{" && character !== "[") continue;
      started = true;
    }

    switch (character) {
      case '"':
        inString = true;
        break;
      case "{":
        stack.push({ closer: "}", awaitingValue: false });
        break;
      case "[":
        stack.push({ closer: "]", awaitingValue: false });
        break;
      case "}":
      case "]":
        // 括号对不上:后面的文本不可信，就此收手。
        if (stack.pop() === undefined) return cut;
        complete(index + 1);
        break;
      case ":": {
        const container = stack.at(-1);
        if (container !== undefined) container.awaitingValue = true;
        break;
      }
      case ",": {
        const container = stack.at(-1);
        if (container !== undefined) container.awaitingValue = false;
        break;
      }
      default:
        if (!WHITESPACE.has(character)) inScalar = true;
        break;
    }
  }
  // 结尾的裸标量可能只吐了一半(「12」其实是「123」),不认它，退回上一个完整值。
  return cut;
}

/**
 * 把被截断的 JSON 补成能解析的文本:在最后一个完整值处截断，补齐未闭合的括号。
 * 返回的候选一定能被 JSON.parse 接受；救不回来时返回 undefined。
 *
 * 与 Kotlin 侧 `repairTruncatedJson` 逐字对齐，向量见
 * `shared-fixtures/truncated-json-salvage.json`。
 */
export function repairTruncatedJson(text: string): string | undefined {
  const source = stripFences(text);
  // 只认以容器开头的正文:模型该给的是对象,而「绝不从散文里抠 JSON」是既有不变量
  // (Kotlin 侧的 parseToJsonElement 会把裸词当字符串收下,这道门也让两端判据一致)。
  if (!source.startsWith("{") && !source.startsWith("[")) return undefined;
  if (tryParse(source) !== undefined) return source;
  const cut = lastCompleteValue(source);
  if (cut === undefined) return undefined;
  const candidate = source.slice(0, cut.index) + cut.closers;
  return tryParse(candidate) === undefined ? undefined : candidate;
}

/**
 * 被截断的模型输出里，已经完整的那部分照旧可用。
 *
 * 模型少吐收尾括号是常态:本机 qwen3.5:9b-mlx 每次都少最后一个 `}`，云端模型触到
 * max_tokens 也会断在半句上。此前这类输出让整条请求直接判死(INVALID_MODEL_OUTPUT)，
 * 同一批句子全军覆没——而其中前几句往往是完整的。救回来的对象若缺字段，由上层逐句
 * 校验判无效并进修复轮，那也远好过整块判死。
 *
 * 返回 undefined 表示连一个完整的值都没有，调用方照旧报解析失败。
 */
export function salvageTruncatedJson(text: string): unknown {
  const repaired = repairTruncatedJson(text);
  return repaired === undefined ? undefined : tryParse(repaired);
}
