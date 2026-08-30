import { GrammarRole } from "../shared/grammar";
import type {
  CoreAnalysis,
  CoreComponent,
  DetailAnalysis,
  DetailStructure,
  Token,
  TokenRange,
} from "../shared/grammar";
import type { SentenceInput } from "../shared/protocol";
import { CORE_SCHEMA_VERSION } from "../shared/versions";

export interface ValidationError {
  path: string;
  message: string;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: ValidationError[] };

const grammarRoles: ReadonlySet<string> = new Set(Object.values(GrammarRole));
const UNSAFE_TEXT = /<script|<iframe|javascript:|\0/i;

/**
 * 提示词里能本地判定的粒度规则,在这里变成硬校验。
 *
 * 只写在 prompt 里的约束等于没有约束:模型违反了没人拦,坏划分照样写进缓存并长期
 * 显示在页面上(缓存键不带模型维度,一次坏结果所有 profile 共用)。这几条都只看
 * 「成分序列 + Token 文本」就能判,不需要句法分析器,而且判错的代价可控——失败只是
 * 走一次已有的修复轮。**错误文案本身就是发给模型的修复指令**(`buildRepairPrompt`
 * 把它原样塞进 prompt),所以必须写成「该怎么做」而不只是「哪里错」。
 */
const COORDINATING_CONJUNCTIONS: ReadonlySet<string> = new Set([
  "for",
  "and",
  "nor",
  "but",
  "or",
  "yet",
  "so",
]);
/**
 * 保守的单词介词表。只收缺少宾语时几乎不可能独立作副词、表语或连词的词；
 * `after` / `before` / `down` / `off` / `over` / `since` / `until` 以及
 * `around` / `inside` / `outside` / `against` / `beneath` / `beside` 等常见兼类词刻意不收。误放一次只影响粒度，
 * 误拒则会把合法分析送进无意义的修复轮，所以 accuracy 优先于召回率。
 */
const PREPOSITIONS: ReadonlySet<string> = new Set([
  "among",
  "at",
  "between",
  "despite",
  "during",
  "for",
  "from",
  "into",
  "of",
  "onto",
  "throughout",
  "toward",
  "towards",
  "upon",
  "with",
  "within",
]);
/**
 * 主格人称代词。英语的动词组**绝不可能**以它开头,所以 `PREDICATE` 的首个实词命中
 * 这里就说明主语被吞进了谓语——实测 deepseek-chat 把
 * "She kept practicing until…" 整句只标成 `PREDICATE` + `ADVERBIAL_CLAUSE`,
 * 一个主语都没有,而四条旧硬门一条都拦不住。
 *
 * 用「谓语开头」而不是「整句缺主语」判定,是因为祈使句本来就没有主语
 * (`Help turn ideas…` 的黄金标注就是 `PREDICATE` 起头);而文档里
 * "First, install the CLI." 这类副词开头的祈使句更是常见,按缺主语判会大面积误拒。
 */
const SUBJECT_PRONOUNS: ReadonlySet<string> = new Set([
  "i",
  "you",
  "he",
  "she",
  "it",
  "we",
  "they",
]);
/**
 * 限定词 = 名词短语的左边界。动词组内部出现它,说明宾语/ 表语 / 补语被吞了进来
 * (`PEER_COMPONENT_RULE` 要挡的正是这个,但此前只写在提示词里)。
 *
 * `that` 刻意不收:它更常作宾语从句引导词,`announced that` 这种一个词的粒度差
 * 远好过把合法分析送进修复轮。首词判定另算——谓语以 `that` 开头一定是错的。
 */
const DETERMINERS: ReadonlySet<string> = new Set([
  "the",
  "a",
  "an",
  "this",
  "these",
  "those",
  "my",
  "your",
  "his",
  "her",
  "its",
  "our",
  "their",
]);
const PREDICATE_HEAD_BLOCKERS: ReadonlySet<string> = new Set([
  ...SUBJECT_PRONOUNS,
  ...DETERMINERS,
  "that",
]);
/**
 * 从属连词引导的分句是从句,不是并列分句。`CLAUSE_FIRST_RULE` 按逗号触发,主从复合句
 * 于是被整成两个「并列分句」——旧硬门只拦「恰好 1 个 `COORDINATE_CLAUSE`」,2 个一律放过,
 * 于是 "Because the road was flooded, the bus took a longer route." 会被标成并列句显示出去。
 *
 * `for` / `so` 属 FANBOYS,`then` 是副词(黄金集的祈使句串第三个分句就以它开头),都不收。
 */
const SUBORDINATING_CONJUNCTIONS: ReadonlySet<string> = new Set([
  "after",
  "although",
  "as",
  "because",
  "before",
  "if",
  "lest",
  "once",
  "since",
  "that",
  "though",
  "till",
  "unless",
  "until",
  "when",
  "whenever",
  "whereas",
  "wherever",
  "whether",
  "while",
  "whilst",
]);
/**
 * 低于这个实词数的片段(标题、列表项、`Detailed usage instructions.`)本来就没有可拆的
 * 同层结构,硬拆只是噪音;到这个长度以上,一个成分包住整句就等于没有划分——卡片退化成
 * 一整块译文,正是「看着像翻译、不像成分分析」的那种输出。
 */
const MIN_SPLITTABLE_LEXICAL_TOKENS = 4;

function lexicalTexts(tokens: readonly Token[], range: TokenRange): string[] {
  return tokens
    .filter((token) => token.id >= range.startToken && token.id <= range.endToken)
    .filter((token) => !token.punctuation)
    .map((token) => token.text.toLowerCase());
}

/**
 * 逐条判定「本地能判的语法约束」。返回的 message 直接进修复 prompt。
 * 只在成分序列已通过结构校验(区间在句内、有序不重叠)之后调用。
 */
function collectGrammarErrors(
  components: readonly CoreComponent[],
  tokens: readonly Token[],
  path: string,
  errors: ValidationError[],
): void {
  const hasConjunction = components.some((component) => component.role === GrammarRole.CONJUNCTION);

  components.forEach((component, index) => {
    const componentPath = `${path}.components[${index}]`;
    const previous = components[index - 1];
    const words = lexicalTexts(tokens, component);
    const head = words[0];

    // PREDICATE_SCOPE_RULE:并排的动词属于同一个谓语,两个 PREDICATE 不得相邻。
    if (
      component.role === GrammarRole.PREDICATE &&
      previous?.role === GrammarRole.PREDICATE &&
      previous.endToken + 1 === component.startToken
    ) {
      addError(
        errors,
        componentPath,
        "adjacent PREDICATE components must be merged into one PREDICATE covering the whole verb group",
      );
    }

    // 谓语必须以动词组开头。限定词与主格代词都不可能是动词,命中即说明主语被吞了进来。
    if (
      component.role === GrammarRole.PREDICATE &&
      head !== undefined &&
      PREDICATE_HEAD_BLOCKERS.has(head)
    ) {
      addError(
        errors,
        componentPath,
        "a PREDICATE must begin with the verb group; move the leading subject or noun phrase into its own component",
      );
    }

    // 谓语内部出现限定词 = 宾语 / 表语 / 补语被吞进了动词组。
    if (
      component.role === GrammarRole.PREDICATE &&
      words.slice(1).some((word) => DETERMINERS.has(word))
    ) {
      addError(
        errors,
        componentPath,
        "a PREDICATE must cover only the verb group; emit the noun phrase that starts at the determiner as its own OBJECT, PREDICATIVE, or COMPLEMENT component",
      );
    }

    // 从属连词引导的是从句,不是并列分句。整句已有 CONJUNCTION 时不判——
    // "Because A, B, and C" 里第一个并列分句本来就以从属连词开头。
    if (
      component.role === GrammarRole.COORDINATE_CLAUSE &&
      head !== undefined &&
      SUBORDINATING_CONJUNCTIONS.has(head) &&
      !hasConjunction
    ) {
      addError(
        errors,
        componentPath,
        "a clause introduced by a subordinating conjunction is not a COORDINATE_CLAUSE; tag it with one of the five subordinate clause roles and analyse the main clause as peer components",
      );
    }

    // PREPOSITIONAL_PHRASE_RULE:介词与它管辖的一切是一个成分,介词不得独立成分。
    if (
      component.role !== GrammarRole.CONJUNCTION &&
      words.length === 1 &&
      PREPOSITIONS.has(words[0]!)
    ) {
      addError(
        errors,
        componentPath,
        "a preposition must be merged with the phrase it governs instead of forming its own component",
      );
    }

    // 并列连词以外的词不该标 CONJUNCTION——模型最常拿它套逗号或从属连词。
    if (
      component.role === GrammarRole.CONJUNCTION &&
      !words.some((word) => COORDINATING_CONJUNCTIONS.has(word))
    ) {
      addError(
        errors,
        componentPath,
        "CONJUNCTION must cover a coordinating conjunction (for, and, nor, but, or, yet, so)",
      );
    }
  });

  // 一个成分包住整句 = 没有划分。旧规则只认 COORDINATE_CLAUSE,换成 SUBJECT 就一路通过。
  const lexicalTokenCount = tokens.filter((token) => !token.punctuation).length;
  const only = components.length === 1 ? components[0] : undefined;
  if (
    only !== undefined &&
    lexicalTokenCount >= MIN_SPLITTABLE_LEXICAL_TOKENS &&
    lexicalTexts(tokens, only).length === lexicalTokenCount
  ) {
    addError(
      errors,
      `${path}.components`,
      "one component must not cover the whole sentence; split it into peer components (subject, predicate, object, adverbial, …)",
    );
  }

  // SIMPLE_SENTENCE_RULE:并列需要至少两个分句,单主谓句不得包成 COORDINATE_CLAUSE。
  const coordinateClauses = components.filter(
    (component) => component.role === GrammarRole.COORDINATE_CLAUSE,
  );
  if (coordinateClauses.length === 1) {
    addError(
      errors,
      `${path}.components`,
      "a single clause must be split into peer components instead of one COORDINATE_CLAUSE; COORDINATE_CLAUSE requires at least two coordinate clauses",
    );
  }

  // 并列句的定义就是「各分句自带主语 + 并列连词或分号连接」。逗号串起来的祈使句或
  // 共享主语的并列谓语都不是并列句——把它们包成分句块,读者看到的就是几整块译文
  // 而不是成分划分,而这一条正是「看着像翻译」的主要来源。
  if (
    coordinateClauses.length >= 2 &&
    !hasConjunction &&
    !tokens.some((token) => token.punctuation && token.text === ";")
  ) {
    addError(
      errors,
      `${path}.components`,
      "COORDINATE_CLAUSE is only for clauses joined by a coordinating conjunction tagged as its own CONJUNCTION component or by a semicolon; analyse a comma-joined or shared-subject sequence as peer components inside one clause",
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value);
}

function isSafeText(value: unknown): value is string {
  return typeof value === "string" && !UNSAFE_TEXT.test(value);
}

function addError(errors: ValidationError[], path: string, message: string): void {
  errors.push({ path, message });
}

function parseRange(
  value: Record<string, unknown>,
  path: string,
  errors: ValidationError[],
): TokenRange | undefined {
  const { startToken, endToken } = value;
  if (!isSafeInteger(startToken)) {
    addError(errors, `${path}.startToken`, "must be a safe integer");
  }
  if (!isSafeInteger(endToken)) {
    addError(errors, `${path}.endToken`, "must be a safe integer");
  }
  if (!isSafeInteger(startToken) || !isSafeInteger(endToken)) {
    return undefined;
  }
  if (startToken > endToken) {
    addError(errors, path, "token interval is reversed");
    return undefined;
  }
  return { startToken, endToken };
}

function componentEnglishLength(tokens: readonly Token[], range: TokenRange): number {
  return tokens
    .filter((token) => token.id >= range.startToken && token.id <= range.endToken)
    .reduce((length, token) => length + token.leadingWhitespace.length + token.text.length, 0);
}

function parseCoreComponent(
  value: unknown,
  tokens: readonly Token[],
  path: string,
  errors: ValidationError[],
): CoreComponent | undefined {
  if (!isRecord(value)) {
    addError(errors, path, "must be an object");
    return undefined;
  }
  if (!hasOnlyKeys(value, ["startToken", "endToken", "role", "translation"])) {
    addError(errors, path, "contains unknown fields");
  }

  const range = parseRange(value, path, errors);
  const role = value.role;
  if (typeof role !== "string" || !grammarRoles.has(role)) {
    addError(errors, `${path}.role`, "must be a known grammar role");
  }

  const translation = value.translation;
  if (!isSafeText(translation)) {
    addError(errors, `${path}.translation`, "must be a safe string");
  } else if (translation.trim().length === 0) {
    addError(errors, `${path}.translation`, "must not be empty");
  } else if (
    range !== undefined &&
    translation.length > Math.max(500, componentEnglishLength(tokens, range) * 8)
  ) {
    addError(errors, `${path}.translation`, "is too long");
  }

  if (
    range === undefined ||
    typeof role !== "string" ||
    !grammarRoles.has(role) ||
    !isSafeText(translation) ||
    translation.trim().length === 0
  ) {
    return undefined;
  }
  return { ...range, role: role as GrammarRole, translation };
}

function parseCoreSentence(
  value: unknown,
  request: SentenceInput,
  sentenceIndex: number,
  modelProfileId: string,
  errors: ValidationError[],
): CoreAnalysis | undefined {
  const path = `sentences[${sentenceIndex}]`;
  if (!isRecord(value)) {
    addError(errors, path, "must be an object");
    return undefined;
  }
  if (!hasOnlyKeys(value, ["sentenceId", "components"])) {
    addError(errors, path, "contains unknown fields");
  }
  if (!isSafeText(value.sentenceId) || value.sentenceId !== request.sentenceId) {
    addError(errors, `${path}.sentenceId`, "does not match the requested sentence");
  }
  if (!Array.isArray(value.components) || value.components.length === 0) {
    addError(errors, `${path}.components`, "must be a non-empty array");
    return undefined;
  }

  const components = value.components.map((component, componentIndex) =>
    parseCoreComponent(component, request.tokens, `${path}.components[${componentIndex}]`, errors),
  );
  // grammar 只依赖结构可信度，不能被 unknown field、过长译文或 sentenceId 等
  // 非结构错误短路；每个成分都成功解析、区间在句内、有序不重叠且非纯标点才可信。
  let structureTrusted = components.every((component) => component !== undefined);
  let previousEnd = -1;
  for (const [index, component] of components.entries()) {
    if (component === undefined) {
      structureTrusted = false;
      continue;
    }
    const componentPath = `${path}.components[${index}]`;
    const coveredTokens = request.tokens.filter(
      (token) => token.id >= component.startToken && token.id <= component.endToken,
    );
    if (
      coveredTokens.length === 0 ||
      coveredTokens[0]!.id !== component.startToken ||
      coveredTokens.at(-1)?.id !== component.endToken
    ) {
      addError(errors, componentPath, "token interval is outside the original sentence");
      structureTrusted = false;
    }
    if (component.startToken <= previousEnd) {
      addError(errors, `${path}.components`, "components must be ordered and non-overlapping");
      structureTrusted = false;
    }
    if (coveredTokens.length > 0 && coveredTokens.every((token) => token.punctuation)) {
      addError(errors, componentPath, "component must not contain only punctuation");
      structureTrusted = false;
    }
    previousEnd = component.endToken;
  }

  const validComponents = components.filter(
    (component): component is CoreComponent => component !== undefined,
  );

  if (structureTrusted) {
    collectGrammarErrors(validComponents, request.tokens, path, errors);
  }

  for (const token of request.tokens) {
    const coverage = validComponents.filter(
      (component) => token.id >= component.startToken && token.id <= component.endToken,
    ).length;
    if (!token.punctuation && coverage === 0) {
      addError(errors, `${path}.components`, `non-punctuation token ${token.id} is not covered`);
    } else if (!token.punctuation && coverage > 1) {
      addError(
        errors,
        `${path}.components`,
        `non-punctuation token ${token.id} is covered more than once`,
      );
    } else if (token.punctuation && coverage > 1) {
      addError(
        errors,
        `${path}.components`,
        `punctuation token ${token.id} is covered more than once`,
      );
    }
  }

  if (
    errors.some((error) => error.path === path || error.path.startsWith(`${path}.`)) ||
    validComponents.length !== components.length
  ) {
    return undefined;
  }
  return {
    schemaVersion: CORE_SCHEMA_VERSION,
    sentenceId: request.sentenceId,
    components: validComponents,
    modelProfileId,
  };
}

export function validateCoreBatch(
  raw: unknown,
  requests: readonly SentenceInput[],
  modelProfileId: string,
): ValidationResult<CoreAnalysis[]> {
  const errors: ValidationError[] = [];
  if (!isRecord(raw)) {
    return { ok: false, errors: [{ path: "", message: "must be an object" }] };
  }
  if (!hasOnlyKeys(raw, ["sentences"])) {
    addError(errors, "", "contains unknown fields");
  }
  if (!Array.isArray(raw.sentences)) {
    addError(errors, "sentences", "must be an array");
    return { ok: false, errors };
  }

  const requestById = new Map(requests.map((request) => [request.sentenceId, request]));
  const seen = new Set<string>();
  const analysesById = new Map<string, CoreAnalysis>();
  raw.sentences.forEach((sentence, index) => {
    const path = `sentences[${index}]`;
    if (!isRecord(sentence) || !isSafeText(sentence.sentenceId)) {
      addError(errors, `${path}.sentenceId`, "must be a safe string");
      return;
    }
    const request = requestById.get(sentence.sentenceId);
    if (request === undefined) {
      addError(errors, `${path}.sentenceId`, "was not requested");
      return;
    }
    if (seen.has(sentence.sentenceId)) {
      addError(errors, `${path}.sentenceId`, "is duplicated");
      return;
    }
    seen.add(sentence.sentenceId);
    const analysis = parseCoreSentence(sentence, request, index, modelProfileId, errors);
    if (analysis !== undefined) {
      analysesById.set(sentence.sentenceId, analysis);
    }
  });

  for (const request of requests) {
    if (!seen.has(request.sentenceId)) {
      addError(errors, "sentences", `requested sentence ${request.sentenceId} is missing`);
    }
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: requests.map((request) => analysesById.get(request.sentenceId) as CoreAnalysis),
  };
}

function parseDetailStructure(
  value: unknown,
  tokens: readonly Token[],
  path: string,
  errors: ValidationError[],
): DetailStructure | undefined {
  if (!isRecord(value)) {
    addError(errors, path, "must be an object");
    return undefined;
  }
  if (!hasOnlyKeys(value, ["startToken", "endToken", "role", "explanation", "translation"])) {
    addError(errors, path, "contains unknown fields");
  }
  const range = parseRange(value, path, errors);
  if (
    (range !== undefined && !tokens.some((token) => token.id === range.startToken)) ||
    (range !== undefined && !tokens.some((token) => token.id === range.endToken))
  ) {
    addError(errors, path, "token interval is outside the original sentence");
  }
  const role = value.role;
  if (!isSafeText(role) || role.trim().length === 0) {
    addError(errors, `${path}.role`, "must be a non-empty safe string");
  }
  const explanation = value.explanation;
  if (!isSafeText(explanation) || explanation.trim().length === 0) {
    addError(errors, `${path}.explanation`, "must be a non-empty safe string");
  }
  // 译文是渐进增强：缺失或空串时标注块退回两行；类型/内容不安全才算校验错误。
  const translation = value.translation;
  if (translation !== undefined && !isSafeText(translation)) {
    addError(errors, `${path}.translation`, "must be a safe string when present");
  }
  if (
    range === undefined ||
    !isSafeText(role) ||
    role.trim().length === 0 ||
    !isSafeText(explanation) ||
    explanation.trim().length === 0 ||
    (translation !== undefined && !isSafeText(translation))
  ) {
    return undefined;
  }
  return isSafeText(translation) && translation.trim().length > 0
    ? { ...range, role, explanation, translation }
    : { ...range, role, explanation };
}

export function validateDetail(
  raw: unknown,
  request: SentenceInput,
  requestedFocus: TokenRange,
  modelProfileId: string,
): ValidationResult<DetailAnalysis> {
  const errors: ValidationError[] = [];
  if (!isRecord(raw)) {
    return { ok: false, errors: [{ path: "", message: "must be an object" }] };
  }
  if (!hasOnlyKeys(raw, ["sentenceId", "focus", "structures", "grammarPoints", "explanation"])) {
    addError(errors, "", "contains unknown fields");
  }
  if (!isSafeText(raw.sentenceId) || raw.sentenceId !== request.sentenceId) {
    addError(errors, "sentenceId", "does not match the requested sentence");
  }

  let focus: TokenRange | undefined;
  if (!isRecord(raw.focus) || !hasOnlyKeys(raw.focus, ["startToken", "endToken"])) {
    addError(errors, "focus", "must be a token interval");
  } else {
    focus = parseRange(raw.focus, "focus", errors);
    if (
      focus !== undefined &&
      (focus.startToken !== requestedFocus.startToken || focus.endToken !== requestedFocus.endToken)
    ) {
      addError(errors, "focus", "must match the requested focus");
    }
  }

  let structures: DetailStructure[] = [];
  if (!Array.isArray(raw.structures)) {
    addError(errors, "structures", "must be an array");
  } else {
    structures = raw.structures
      .map((structure, index) =>
        parseDetailStructure(structure, request.tokens, `structures[${index}]`, errors),
      )
      .filter((structure): structure is DetailStructure => structure !== undefined);
  }

  if (focus !== undefined) {
    let previousEnd = focus.startToken - 1;
    structures.forEach((structure, index) => {
      const path = `structures[${index}]`;
      if (structure.startToken < focus.startToken || structure.endToken > focus.endToken) {
        addError(errors, path, "must stay inside the requested focus");
      }
      if (structure.startToken <= previousEnd) {
        addError(errors, "structures", "must be ordered and non-overlapping");
      }
      previousEnd = Math.max(previousEnd, structure.endToken);
    });
  }

  const grammarPoints: string[] = [];
  if (!Array.isArray(raw.grammarPoints)) {
    addError(errors, "grammarPoints", "must be an array");
  } else {
    if (raw.grammarPoints.length > 12) {
      addError(errors, "grammarPoints", "must contain at most 12 items");
    }
    raw.grammarPoints.forEach((point, index) => {
      if (!isSafeText(point) || point.trim().length === 0 || point.length > 300) {
        addError(
          errors,
          `grammarPoints[${index}]`,
          "must be a non-empty safe string of at most 300 characters",
        );
      } else {
        grammarPoints.push(point);
      }
    });
  }

  const explanation = raw.explanation;
  if (!isSafeText(explanation) || explanation.trim().length === 0) {
    addError(errors, "explanation", "must be a non-empty safe string");
  }
  if (errors.length > 0 || focus === undefined || !isSafeText(explanation)) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      sentenceId: request.sentenceId,
      focus,
      structures,
      grammarPoints,
      explanation,
      modelProfileId,
    },
  };
}
