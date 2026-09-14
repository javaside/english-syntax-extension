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
import {
  rawComponentEntries,
  toIndexed,
  type IndexedCoreComponent,
  type ParsedComponentEntry,
} from "./indexed-components";

export interface ValidationError {
  path: string;
  message: string;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: ValidationError[] };

const grammarRoles: ReadonlySet<string> = new Set(Object.values(GrammarRole));
const UNSAFE_TEXT = /<script|<iframe|javascript:|\0/i;

/**
 * 译文质量硬门:每个最终 component 的 translation 必须至少含一个 Unicode Han 字符,
 * 并且不能在 NFKC + 大小写折叠 + Unicode 空白折叠后仍等于它覆盖的英文 span。
 * 这条是非语法错误:component 照样解析、structureTrusted 不受影响、grammar errors
 * 同轮继续;错误文案原样进修复 prompt。与 Kotlin 端逐字一致。
 *
 * 模式本身导出仅供测试消费 `shared-fixtures/translation-quality.json` 的
 * `hanScriptBoundary` 组;语义等价于 Kotlin 端的 `\p{IsHan}`。
 */
export const HAN_PATTERN = /\p{Script=Han}/u;
const TRANSLATION_QUALITY_MESSAGE =
  "translation must include a meaningful Chinese gloss for the complete covered English span instead of echoing or only copying it";
/** 与 segmenter 相同的显式 Unicode 空白类,避免 TS `\s` 与 JVM `\s` 语义分叉。 */
const TRANSLATION_QUALITY_WHITESPACE =
  "\\u0009-\\u000d\\u0020\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff";
const TRANSLATION_QUALITY_WHITESPACE_FOLD = new RegExp(
  `[${TRANSLATION_QUALITY_WHITESPACE}]+`,
  "gu",
);

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
 * `after` / `before` / `down` / `off` / `over` / `since` / `until` / `throughout` 以及
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
 * 助动词与情态动词白名单。这些词在谓语中与主要动词构成动词组，不应该被拆分。
 * 实测模型常把 "must close" / "can press" / "is stricter" 拆成两个相邻的 PREDICATE。
 * 虽然相邻 PREDICATE 规则能拦截，但这个白名单提供更精确的错误信息。
 *
 * 情态动词: can, could, may, might, must, shall, should, will, would
 * be 动词: am, is, are, was, were, be, been, being (系表结构、被动语态、进行时)
 * have: have, has, had, having (完成时)
 * do: do, does, did (强调、疑问、否定)
 */
const AUXILIARY_MODALS: ReadonlySet<string> = new Set([
  "can",
  "could",
  "may",
  "might",
  "must",
  "shall",
  "should",
  "will",
  "would",
  "am",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "having",
  "do",
  "does",
  "did",
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
const SUBJECT_CLAUSE_INTRODUCERS: ReadonlySet<string> = new Set([
  "that",
  "whether",
  "what",
  "whatever",
  "which",
  "whichever",
  "who",
  "whoever",
  "whom",
  "whomever",
  "whose",
  "how",
  "why",
  "when",
  "where",
]);
const CLAUSE_ONLY_CONJUNCTIONS: ReadonlySet<string> = new Set([
  "although",
  "whereas",
  "unless",
  "lest",
  "whilst",
]);
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
const MAX_WHOLE_SENTENCE_FRAGMENT_LEXICAL_TOKENS = 10;
const WHOLE_SENTENCE_FRAGMENT_ROLES: ReadonlySet<GrammarRole> = new Set([
  GrammarRole.FRAGMENT_HEAD,
  GrammarRole.INDEPENDENT_ELEMENT,
  GrammarRole.APPOSITIVE,
]);

/**
 * 五类从句角色。`Complex-sentence rule` 要求从句整块输出、不拆内部结构,
 * 这几条从句硬门就是那条提示词规则的本地兑现。
 */
const CLAUSE_ROLES: ReadonlySet<GrammarRole> = new Set([
  GrammarRole.SUBJECT_CLAUSE,
  GrammarRole.OBJECT_CLAUSE,
  GrammarRole.PREDICATIVE_CLAUSE,
  GrammarRole.ATTRIBUTIVE_CLAUSE,
  GrammarRole.ADVERBIAL_CLAUSE,
]);
/**
 * `FRAGMENT_HEAD` 存在时仍被禁止的分句级角色。fragment-relative 放行只移出
 * `ATTRIBUTIVE_CLAUSE` 一项:名词片段后跟一个完整定语从句是真实文本里高频的结构
 * (`An API that returns JSON responses`),其余分句级角色与片段主体同现依旧等于
 * 给不成句的输入虚构主谓宾。刻意用显式集合而不是 `...CLAUSE_ROLES` 展开——
 * 从句五类里哪一类被放行必须在这一处一眼可见,后续再放行/收回也只改这里。
 */
const FRAGMENT_FORBIDDEN_ROLES: ReadonlySet<GrammarRole> = new Set([
  GrammarRole.SUBJECT,
  GrammarRole.PREDICATE,
  GrammarRole.OBJECT,
  GrammarRole.PREDICATIVE,
  GrammarRole.COMPLEMENT,
  GrammarRole.SUBJECT_CLAUSE,
  GrammarRole.OBJECT_CLAUSE,
  GrammarRole.PREDICATIVE_CLAUSE,
  GrammarRole.ADVERBIAL_CLAUSE,
  GrammarRole.COORDINATE_CLAUSE,
]);
const FRAGMENT_MIXED_ROLE_MESSAGE =
  "FRAGMENT_HEAD marks a non-clausal fragment and must not be mixed with clause-level " +
  "SUBJECT, PREDICATE, OBJECT, PREDICATIVE, COMPLEMENT, SUBJECT_CLAUSE, OBJECT_CLAUSE, " +
  "PREDICATIVE_CLAUSE, ADVERBIAL_CLAUSE, or the deprecated COORDINATE_CLAUSE; a whole " +
  "ATTRIBUTIVE_CLAUSE is the only clause role allowed beside a FRAGMENT_HEAD";

/**
 * 一个从句至少要有引导词 + 谓语,或主语 + 谓语,所以实词数 1 一定不是从句。
 * 实测线上把 `that` 单独标成 `ATTRIBUTIVE_CLAUSE`、把 `developers` 标成
 * `SUBJECT_CLAUSE`,从句剩下的部分平铺到主句层,页面上出现两个同级"谓语",
 * 引导词底下还挂着整个从句的译文——四条旧硬门一条都拦不住。
 */
const MIN_CLAUSE_LEXICAL_TOKENS = 2;

/**
 * 定语从句修饰的名词在从句之前,主句宾语只能出现在主句谓语之后——所以紧跟在
 * `ATTRIBUTIVE_CLAUSE` 后面的宾语 / 表语一定是从句自己的,说明从句被切开了。
 * 宾补结构 `consider the movie that she directed a masterpiece` 的补语跟在宾语定从之后合法；
 * 双宾结构的低频误杀由这个保守门接受。主句谓语与主句状语跟在从句后面也合法。
 */
const CLAUSE_INTERNAL_FOLLOWERS: ReadonlySet<GrammarRole> = new Set([
  GrammarRole.OBJECT,
  GrammarRole.PREDICATIVE,
]);

/**
 * 「几乎不可能悬垂」的介词。成分以它们收尾就说明介词的宾语被切了出去
 * (实测 `near the frontier of` + 宾语从句)。
 *
 * `for` / `with` / `at` / `from` / `to` 刻意不收:关系从句的介词悬垂
 * (`the tool I work with`、`the place I came from`)让它们合法地出现在成分末尾,
 * 收进来会把正确分析送进修复轮。已有的单词介词硬门只管「整个成分就是一个介词」,
 * 这条补的是「介词在成分末尾」。
 */
const OBJECT_REQUIRING_PREPOSITIONS: ReadonlySet<string> = new Set([
  "among",
  "between",
  "despite",
  "during",
  "into",
  "of",
  "onto",
  "toward",
  "towards",
  "upon",
  "within",
]);

function lexicalTexts(tokens: readonly Token[], range: TokenRange): string[] {
  return tokens
    .filter((token) => token.id >= range.startToken && token.id <= range.endToken)
    .filter((token) => !token.punctuation)
    .map((token) => token.text.toLowerCase());
}

/**
 * 逐条判定「本地能判的语法约束」。返回的 message 直接进修复 prompt。
 * 只在成分序列已通过结构校验(区间在句内、有序不重叠)之后调用。
 *
 * 入参是携带 rawIndex 的包装序列:邻接关系(前后成分)按**语义成分序列**取,
 * 但错误路径用 rawIndex——它是模型所见 JSON 的原始 components 下标,两个
 * 坐标系刻意分离(见 indexed-components.ts)。
 */
function collectGrammarErrors(
  components: readonly IndexedCoreComponent[],
  tokens: readonly Token[],
  path: string,
  errors: ValidationError[],
): void {
  const roles = components.map(({ component }) => component);
  const hasConjunction = roles.some((component) => component.role === GrammarRole.CONJUNCTION);

  components.forEach((entry, index) => {
    const component = entry.component;
    const componentPath = `${path}.components[${entry.rawIndex}]`;
    const previous = components[index - 1]?.component;
    const words = lexicalTexts(tokens, component);
    const head = words[0];

    if (
      component.role === GrammarRole.SUBJECT_CLAUSE &&
      (head === undefined || !SUBJECT_CLAUSE_INTRODUCERS.has(head))
    ) {
      addError(
        errors,
        componentPath,
        "a SUBJECT_CLAUSE must start with a subject-clause introducer (that/whether/what/who/…); retag or extend the component",
      );
    }

    const phraseRole =
      component.role === GrammarRole.ADVERBIAL || component.role === GrammarRole.ATTRIBUTE;
    const startsWithClauseOnlyConjunction =
      head !== undefined &&
      (CLAUSE_ONLY_CONJUNCTIONS.has(head) ||
        (head === "because" && words[1] !== "of") ||
        (head === "though" && words.length >= 2));
    if (phraseRole && startsWithClauseOnlyConjunction) {
      addError(
        errors,
        componentPath,
        "a component that starts with a subordinating conjunction (because/although/…) is a clause and must be tagged with a clause role (ADVERBIAL_CLAUSE/…)",
      );
    }

    // PREDICATE_SCOPE_RULE:并排的动词属于同一个谓语,两个 PREDICATE 不得相邻。
    if (
      component.role === GrammarRole.PREDICATE &&
      previous?.role === GrammarRole.PREDICATE &&
      previous.endToken + 1 === component.startToken
    ) {
      const previousWords = lexicalTexts(tokens, previous);
      const prevHead = previousWords[previousWords.length - 1]; // 前一个谓语的最后一个词

      // 如果前一个谓语只包含助动词/情态动词，给出更精确的错误信息
      if (previousWords.length === 1 && prevHead && AUXILIARY_MODALS.has(prevHead)) {
        addError(
          errors,
          componentPath,
          `auxiliary/modal verb "${prevHead}" must be merged with the following main verb into one PREDICATE covering the complete verb group`,
        );
      } else {
        addError(
          errors,
          componentPath,
          "adjacent PREDICATE components must be merged into one PREDICATE covering the whole verb group",
        );
      }
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

    // Complex-sentence rule 的本地兑现:从句整块输出,实词数 1 不可能是一个从句。
    if (CLAUSE_ROLES.has(component.role) && words.length < MIN_CLAUSE_LEXICAL_TOKENS) {
      addError(
        errors,
        componentPath,
        "a clause component must cover a whole clause: extend it through the clause's own subject, predicate, and any objects or adverbials instead of a single word",
      );
    }

    // 定语从句后面紧跟宾语/表语/补语 = 从句自己的成分被切了出去。
    // 后继按语义成分序列取(不是原数组邻接),被跳过的纯标点成分不算「紧跟」。
    const next = components[index + 1]?.component;
    if (
      component.role === GrammarRole.ATTRIBUTIVE_CLAUSE &&
      next !== undefined &&
      CLAUSE_INTERNAL_FOLLOWERS.has(next.role)
    ) {
      addError(
        errors,
        componentPath,
        "an ATTRIBUTIVE_CLAUSE keeps its whole internal structure in one component; absorb the object or predicative that follows it",
      );
    }

    // 短语成分以「必带宾语的介词」收尾 = 介词的宾语被切了出去。单词介词另有专门的硬门。
    // 从句角色豁免：of/within/between/among 可在关系从句或名词性从句内部合法悬垂
    // (`That's what dreams are made of.`)；短语角色照旧拦截 `near the frontier of`。
    const tail = words.at(-1);
    if (
      component.role !== GrammarRole.CONJUNCTION &&
      !CLAUSE_ROLES.has(component.role) &&
      words.length > 1 &&
      tail !== undefined &&
      OBJECT_REQUIRING_PREPOSITIONS.has(tail)
    ) {
      addError(
        errors,
        componentPath,
        "a component must not end on a preposition; merge the phrase that preposition governs into the same component",
      );
    }
  });

  // 单成分整句的豁免集是片段语义角色；10 是挑战集审阅后的启发式上限，不是语法定律。
  const lexicalTokenCount = tokens.filter((token) => !token.punctuation).length;
  const only = roles.length === 1 ? roles[0] : undefined;
  const onlyLexicalCount = only === undefined ? 0 : lexicalTexts(tokens, only).length;
  const coversWholeSentence = onlyLexicalCount === lexicalTokenCount;
  if (
    only !== undefined &&
    !WHOLE_SENTENCE_FRAGMENT_ROLES.has(only.role) &&
    lexicalTokenCount >= MIN_SPLITTABLE_LEXICAL_TOKENS &&
    coversWholeSentence
  ) {
    addError(
      errors,
      `${path}.components`,
      "one component must not cover the whole sentence; split it into peer components (subject, predicate, object, adverbial, …)",
    );
  }
  if (
    only !== undefined &&
    WHOLE_SENTENCE_FRAGMENT_ROLES.has(only.role) &&
    onlyLexicalCount > MAX_WHOLE_SENTENCE_FRAGMENT_LEXICAL_TOKENS &&
    coversWholeSentence
  ) {
    addError(
      errors,
      `${path}.components`,
      `a whole-sentence fragment component must not exceed ${MAX_WHOLE_SENTENCE_FRAGMENT_LEXICAL_TOKENS} lexical tokens; split it into a fragment head plus its modifiers`,
    );
  }

  // COORDINATE_CLAUSE 已废弃：并列句现在按同层成分平铺（各分句的 subject/predicate/
  // object 等作为句子的顶层成分），并列连词单独标 CONJUNCTION。这样卡片才能显示成分
  // 划分而不是几整块译文。旧的"包成两个 COORDINATE_CLAUSE"约定是「看着像翻译」的
  // 主要来源，在扩展到真实散文后实测退化严重。
  const coordinateClauses = roles.filter(
    (component) => component.role === GrammarRole.COORDINATE_CLAUSE,
  );
  if (coordinateClauses.length >= 1) {
    addError(
      errors,
      `${path}.components`,
      "COORDINATE_CLAUSE is deprecated; analyse compound sentences as peer components (subject, predicate, object, …) with the coordinating conjunction tagged separately as CONJUNCTION",
    );
  }

  const fragmentHeads = roles.filter((component) => component.role === GrammarRole.FRAGMENT_HEAD);
  if (fragmentHeads.length > 1) {
    addError(
      errors,
      `${path}.components`,
      "a non-clausal fragment must contain at most one FRAGMENT_HEAD",
    );
  }
  if (
    fragmentHeads.length > 0 &&
    roles.some((component) => FRAGMENT_FORBIDDEN_ROLES.has(component.role))
  ) {
    addError(errors, `${path}.components`, FRAGMENT_MIXED_ROLE_MESSAGE);
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

/** 从 Token 区间用 leadingWhitespace + text 重建英文 span,供译文回显比对。 */
function rebuildEnglishSpan(tokens: readonly Token[], range: TokenRange): string {
  return tokens
    .filter((token) => token.id >= range.startToken && token.id <= range.endToken)
    .map((token) => token.leadingWhitespace + token.text)
    .join("");
}

function normalizeTranslationQuality(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(TRANSLATION_QUALITY_WHITESPACE_FOLD, " ")
    .trim();
}

function isMeaningfulChineseGloss(
  translation: string,
  tokens: readonly Token[],
  range: TokenRange,
): boolean {
  const span = rebuildEnglishSpan(tokens, range);
  return (
    HAN_PATTERN.test(translation) &&
    normalizeTranslationQuality(translation) !== normalizeTranslationQuality(span)
  );
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
  } else if (range !== undefined && !isMeaningfulChineseGloss(translation, tokens, range)) {
    // 译文质量硬门:无 Han 或与英文 span 等值(回显)都只报这一条,不阻断语法诊断。
    addError(errors, `${path}.translation`, TRANSLATION_QUALITY_MESSAGE);
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

  // 模型常给逗号/句号虚构 PUNCTUATION、CONJUNCTION 等角色。标点本来就允许不覆盖，
  // 所以必须在角色枚举校验前丢掉纯标点区间;rawIndex 先记录再过滤,保证 error path
  // 与模型所见 JSON 的 components 下标一致(TS/Kotlin 双端一致)。
  const entries = rawComponentEntries(value.components, request.tokens);
  if (entries.length === 0) {
    addError(errors, `${path}.components`, "must contain a non-punctuation component");
    return undefined;
  }
  const parsed: ParsedComponentEntry[] = entries.map((entry) => ({
    rawIndex: entry.rawIndex,
    component: parseCoreComponent(
      entry.value,
      request.tokens,
      `${path}.components[${entry.rawIndex}]`,
      errors,
    ),
  }));
  // grammar 只依赖结构可信度，不能被 unknown field、过长译文或 sentenceId 等
  // 非结构错误短路；每个语义成分都成功解析、区间在句内且有序不重叠才可信。
  let structureTrusted = parsed.every((entry) => entry.component !== undefined);
  let previousEnd = -1;
  for (const entry of parsed) {
    const component = entry.component;
    if (component === undefined) {
      structureTrusted = false;
      continue;
    }
    const componentPath = `${path}.components[${entry.rawIndex}]`;
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
    previousEnd = component.endToken;
  }

  const validComponents = toIndexed(parsed);

  if (structureTrusted) {
    collectGrammarErrors(validComponents, request.tokens, path, errors);
  }

  for (const token of request.tokens) {
    const coverage = validComponents.filter(
      ({ component }) => token.id >= component.startToken && token.id <= component.endToken,
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
    validComponents.length !== entries.length
  ) {
    return undefined;
  }
  // 投影为纯 CoreComponent:rawIndex 只是诊断坐标,不得进缓存与渲染。
  return {
    schemaVersion: CORE_SCHEMA_VERSION,
    sentenceId: request.sentenceId,
    components: validComponents.map(({ component }) => component),
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
