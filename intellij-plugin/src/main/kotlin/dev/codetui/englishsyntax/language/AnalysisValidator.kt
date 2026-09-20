package dev.codetui.englishsyntax.language

import dev.codetui.englishsyntax.domain.CoreAnalysis
import dev.codetui.englishsyntax.domain.CoreComponent
import dev.codetui.englishsyntax.domain.DetailAnalysis
import dev.codetui.englishsyntax.domain.DetailStructure
import dev.codetui.englishsyntax.domain.GrammarRole
import dev.codetui.englishsyntax.domain.SentenceInput
import dev.codetui.englishsyntax.domain.Token
import dev.codetui.englishsyntax.domain.TokenRange
import dev.codetui.englishsyntax.domain.ValidationError
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import java.text.Normalizer

private val unsafeText = Regex("<script|<iframe|javascript:|\\u0000", RegexOption.IGNORE_CASE)

/**
 * 译文质量硬门:每个最终 component 的 translation 必须至少含一个 Unicode Han 字符,
 * 并且不能在 NFKC + 大小写折叠 + Unicode 空白折叠后仍等于它覆盖的英文 span。
 * 这条是非语法错误:component 照样解析、structureTrusted 不受影响、grammar errors
 * 同轮继续;错误文案原样进修复 prompt。与 Chrome 端逐字一致。
 *
 * `\p{IsHan}` 是 JVM 的 Script=Han 二元属性,与 `\p{script=Han}` 及 TS 的
 * `\p{Script=Han}` 等价;15 个跨脚本/跨区块边界 case 存于
 * `shared-fixtures/translation-quality.json` 的 `hanScriptBoundary` 组
 * (含 astral 平面的 U+2F800 `丽`,代理对),由 AnalysisValidatorTest 与
 * Chrome 端 analysis-validator.test.ts 双端 replay。
 */
internal val hanPattern = Regex("\\p{IsHan}")
internal const val TRANSLATION_QUALITY_MESSAGE =
  "translation must include a meaningful Chinese gloss for the complete covered English span instead of echoing or only copying it"
/** 与 Segmenter 相同的显式 Unicode 空白类,避免 JVM `\s` 与 TS `\s` 语义分叉。 */
private val translationQualityWhitespaceClass =
  "\\u0009-\\u000d\\u0020\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff"
private val translationQualityWhitespaceFold = Regex("[$translationQualityWhitespaceClass]+")

private val coreEnvelopeKeys = setOf("sentences")
private val coreSentenceKeys = setOf("sentenceId", "components")
private val coreComponentKeys = setOf("startToken", "endToken", "role", "translation")
private val detailEnvelopeKeys = setOf("sentenceId", "focus", "structures", "grammarPoints", "explanation")
private val detailFocusKeys = setOf("startToken", "endToken")
private val detailStructureKeys = setOf("startToken", "endToken", "role", "explanation", "translation")

/** A validation result never throws for malformed model JSON. */
sealed interface ValidationResult<out T> {
  data class Valid<T>(val value: T) : ValidationResult<T> {
    override val errors: List<ValidationError> = emptyList()
  }
  data class Invalid(override val errors: List<ValidationError>) : ValidationResult<Nothing>

  val ok: Boolean
    get() = this is Valid

  val errors: List<ValidationError>
}

private fun <T> valid(value: T): ValidationResult<T> = ValidationResult.Valid(value)
private fun invalid(errors: List<ValidationError>): ValidationResult<Nothing> = ValidationResult.Invalid(errors)

private fun error(path: String, message: String) = ValidationError(path, message)
private fun JsonObject.hasOnly(expected: Set<String>): Boolean = this.keys.all { it in expected }
private fun JsonElement.asObject(): JsonObject? = this as? JsonObject
private fun JsonElement.safeText(): String? = (this as? JsonPrimitive)
  ?.takeIf { it.isString }
  ?.contentOrNull
  ?.takeUnless { unsafeText.containsMatchIn(it) }

private fun JsonElement.safeInt(): Int? {
  val primitive = this as? JsonPrimitive ?: return null
  if (primitive.isString) return null
  val text = primitive.content
  if (!Regex("-?(0|[1-9][0-9]*)").matches(text)) return null
  return text.toLongOrNull()?.takeIf { it in Int.MIN_VALUE..Int.MAX_VALUE }?.toInt()
}

private fun parseRange(value: JsonObject, path: String, errors: MutableList<ValidationError>): TokenRange? {
  val start = value["startToken"]?.safeInt()
  val end = value["endToken"]?.safeInt()
  if (start == null) errors += error("$path.startToken", "must be a safe integer")
  if (end == null) errors += error("$path.endToken", "must be a safe integer")
  if (start == null || end == null) return null
  if (start < 0) errors += error("$path.startToken", "must be non-negative")
  if (end < 0) errors += error("$path.endToken", "must be non-negative")
  if (start > end) {
    errors += error(path, "token interval is reversed")
    return null
  }
  return TokenRange(start, end)
}

private fun tokenLength(tokens: List<Token>, range: TokenRange): Int = tokens
  .filter { it.id in range.startToken..range.endToken }
  .sumOf { it.leadingWhitespace.length + it.text.length }

/** 从 Token 区间用 leadingWhitespace + text 重建英文 span,供译文回显比对。 */
private fun rebuildEnglishSpan(tokens: List<Token>, range: TokenRange): String =
  tokens.filter { it.id in range.startToken..range.endToken }.joinToString("") { it.leadingWhitespace + it.text }

private fun normalizeTranslationQuality(value: String): String =
  Normalizer.normalize(value, Normalizer.Form.NFKC).lowercase().replace(translationQualityWhitespaceFold, " ").trim()

/** 数学式标记(与 TS `MATH_MARKER_PATTERN` 同一字符类)。 */
private val mathMarkerPattern =
  Regex("[=+−×÷<>≤≥→←↔∞∑∫√±∓≈∼∂∈∉⊂∩∪]|\\p{Script=Greek}|[\\u2061\\u2062\\u2063\\u2064]")

/** 含字母即要求中文;与 TS `/[\p{L}]/u` 等价。提升为顶层避免逐 token 重复编译。 */
private val latinLetterPattern = Regex("\\p{L}")

/** 数学式形态:括号内夹逗号或竖线的短表达式(`p(s|I)`),与 TS `MATH_EXPRESSION_PATTERN` 一致。 */
private val mathExpressionPattern = Regex("\\([^()\\s]{1,40}[,|][^()\\s]{0,40}\\)")

/**
 * span 是否含可译内容。不要求中文的只有两类:
 * ①无字母(引用编号与纯标点,译文天然只能是标点);
 * ②含数学标记(运算符、希腊字母、上下标、关系符)。
 * 含字母但无数学标记的仍要求中文——`JSON`/`GWTC-5.0`/`H0`/`GC` 必须补中文类型。
 */
private fun hasTranslatableEnglishWord(tokens: List<Token>, range: TokenRange): Boolean {
  val spanText = rebuildEnglishSpan(tokens, range)
  if (mathMarkerPattern.containsMatchIn(spanText) || mathExpressionPattern.containsMatchIn(spanText)) return false
  return tokens.any { token ->
    !token.punctuation &&
      token.id in range.startToken..range.endToken &&
      latinLetterPattern.containsMatchIn(token.text)
  }
}

private fun isMeaningfulChineseGloss(translation: String, tokens: List<Token>, range: TokenRange): Boolean {
  if (!hasTranslatableEnglishWord(tokens, range)) return true
  val span = rebuildEnglishSpan(tokens, range)
  return hanPattern.containsMatchIn(translation) &&
    normalizeTranslationQuality(translation) != normalizeTranslationQuality(span)
}

/**
 * 提示词里能本地判定的粒度规则，在这里变成硬校验。与 Chrome 端
 * `analysis-validator.ts` 的 `collectGrammarErrors` 逐条对应、错误文案逐字一致。
 *
 * 只写在 prompt 里的约束等于没有约束：模型违反了没人拦，坏划分照样写进缓存并长期
 * 显示（缓存键不带模型维度，一次坏结果所有 profile 共用）。**错误文案本身就是发给
 * 模型的修复指令**（修复 prompt 把它原样塞进去），所以必须写成「该怎么做」。
 * 六张字符串词表保持 internal 仅供测试统计成员数，判定逻辑不变。
 */
internal val coordinatingConjunctions = setOf("for", "and", "nor", "but", "or", "yet", "so")

/**
 * 保守的单词介词表。只收缺少宾语时几乎不可能独立作副词、表语或连词的词；
 * `after` / `before` / `down` / `off` / `over` / `since` / `until` / `throughout` 以及
 * `around` / `inside` / `outside` / `against` / `beneath` / `beside` 等常见兼类词刻意不收。
 * 误放一次只影响粒度，
 * 误拒则会把合法分析送进无意义的修复轮，所以 accuracy 优先于召回率。
 */
internal val prepositions = setOf(
  "among", "at", "between", "despite", "during", "for", "from", "into", "of", "onto",
  "toward", "towards", "upon",
  "with", "within",
)

/**
 * 主格人称代词。英语的动词组**绝不可能**以它开头，所以 `PREDICATE` 的首个实词命中
 * 这里就说明主语被吞进了谓语——实测 deepseek-chat 把
 * "She kept practicing until…" 整句只标成 `PREDICATE` + `ADVERBIAL_CLAUSE`，
 * 一个主语都没有，而四条旧硬门一条都拦不住。
 *
 * 用「谓语开头」而不是「整句缺主语」判定，是因为祈使句本来就没有主语
 * （`Help turn ideas…` 的黄金标注就是 `PREDICATE` 起头）；文档里
 * "First, install the CLI." 这类副词开头的祈使句更常见，按缺主语判会大面积误拒。
 */
internal val subjectPronouns = setOf("i", "you", "he", "she", "it", "we", "they")

/**
 * 限定词 = 名词短语的左边界。动词组内部出现它，说明宾语 / 表语 / 补语被吞了进来
 * （`PEER_COMPONENT_RULE` 要挡的正是这个，但此前只写在提示词里）。
 *
 * `that` 刻意不收：它更常作宾语从句引导词，`announced that` 这种一个词的粒度差
 * 远好过把合法分析送进修复轮。首词判定另算——谓语以 `that` 开头一定是错的。
 */
internal val determiners = setOf(
  "the", "a", "an", "this", "these", "those", "my", "your", "his", "her", "its", "our", "their",
)
private val predicateHeadBlockers = subjectPronouns + determiners + "that"

/**
 * 从属连词引导的分句是从句，不是并列分句。`CLAUSE_FIRST_RULE` 按逗号触发，主从复合句
 * 于是被整成两个「并列分句」——旧硬门只拦「恰好 1 个 `COORDINATE_CLAUSE`」，2 个一律放过，
 * 于是 "Because the road was flooded, the bus took a longer route." 会被标成并列句显示出去。
 *
 * `for` / `so` 属 FANBOYS，`then` 是副词（黄金集的祈使句串第三个分句就以它开头），都不收。
 */
internal val subjectClauseIntroducers = setOf(
  "that", "whether", "what", "whatever", "which", "whichever", "who", "whoever", "whom",
  "whomever", "whose", "how", "why", "when", "where",
)
internal val clauseOnlyConjunctions = setOf(
  "although", "whereas", "unless", "lest", "whilst",
)
internal val subordinatingConjunctions = setOf(
  "after", "although", "as", "because", "before", "if", "lest", "once", "since", "that",
  "though", "till", "unless", "until", "when", "whenever", "whereas", "wherever", "whether",
  "while", "whilst",
)

/**
 * 低于这个实词数的片段（标题、列表项、`Detailed usage instructions.`）本来就没有可拆的
 * 同层结构，硬拆只是噪音；到这个长度以上，一个成分包住整句就等于没有划分——卡片退化成
 * 一整块译文，正是「看着像翻译、不像成分分析」的那种输出。
 */
private const val MIN_SPLITTABLE_LEXICAL_TOKENS = 4
private const val MAX_WHOLE_SENTENCE_FRAGMENT_LEXICAL_TOKENS = 10
private val wholeSentenceFragmentRoles = setOf(
  GrammarRole.FRAGMENT_HEAD,
  GrammarRole.INDEPENDENT_ELEMENT,
  GrammarRole.APPOSITIVE,
)

/**
 * 五类从句角色。`Complex-sentence rule` 要求从句整块输出、不拆内部结构，
 * 下面几条从句硬门就是那条提示词规则的本地兑现。
 */
private val clauseRoles = setOf(
  GrammarRole.SUBJECT_CLAUSE,
  GrammarRole.OBJECT_CLAUSE,
  GrammarRole.PREDICATIVE_CLAUSE,
  GrammarRole.ATTRIBUTIVE_CLAUSE,
  GrammarRole.ADVERBIAL_CLAUSE,
)
/**
 * `FRAGMENT_HEAD` 存在时仍被禁止的分句级角色。fragment-relative 放行只移出
 * `ATTRIBUTIVE_CLAUSE` 一项:名词片段后跟一个完整定语从句是真实文本里高频的结构
 * (`An API that returns JSON responses`),其余分句级角色与片段主体同现依旧等于
 * 给不成句的输入虚构主谓宾。刻意用显式集合而不是 `clauseRoles` 展开——
 * 从句五类里哪一类被放行必须在这一处一眼可见,后续再放行/收回也只改这里。
 * 与 Chrome 端 `FRAGMENT_FORBIDDEN_ROLES` 逐成员一致。
 */
private val fragmentForbiddenRoles = setOf(
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
)
private const val FRAGMENT_MIXED_ROLE_MESSAGE =
  "FRAGMENT_HEAD marks a non-clausal fragment and must not be mixed with clause-level " +
    "SUBJECT, PREDICATE, OBJECT, PREDICATIVE, COMPLEMENT, SUBJECT_CLAUSE, OBJECT_CLAUSE, " +
    "PREDICATIVE_CLAUSE, ADVERBIAL_CLAUSE, or the deprecated COORDINATE_CLAUSE; a whole " +
    "ATTRIBUTIVE_CLAUSE is the only clause role allowed beside a FRAGMENT_HEAD"

/**
 * 一个从句至少要有引导词 + 谓语，或主语 + 谓语，所以实词数 1 一定不是从句。
 * 实测线上把 `that` 单独标成 `ATTRIBUTIVE_CLAUSE`、把 `developers` 标成
 * `SUBJECT_CLAUSE`，从句剩下的部分平铺到主句层，页面上出现两个同级"谓语"，
 * 引导词底下还挂着整个从句的译文——旧硬门一条都拦不住。
 */
/** 助动词/情态动词(与 TS AUXILIARY_MODALS 同集):单独成谓语时给出精确合并指令。 */
private val auxiliaryModals = setOf(
  "am", "are", "be", "been", "being", "can", "could", "did", "do", "does",
  "had", "has", "have", "having", "is", "may", "might", "must", "shall", "should",
  "was", "were", "will", "would",
)

private const val MIN_CLAUSE_LEXICAL_TOKENS = 2

/**
 * 定语从句修饰的名词在从句之前，主句宾语只能出现在主句谓语之后——所以紧跟在
 * `ATTRIBUTIVE_CLAUSE` 后面的宾语 / 表语一定是从句自己的，说明从句被切开了。
 * 宾补结构 `consider the movie that she directed a masterpiece` 的补语跟在宾语定从之后合法；
 * 双宾结构的低频误杀由这个保守门接受。主句谓语与主句状语跟在从句后面也合法。
 */
private val clauseInternalFollowers = setOf(
  GrammarRole.OBJECT,
  GrammarRole.PREDICATIVE,
)
/**
 * 名词性成分中，`of` 紧跟在**高把握名词中心词**之后，表示它吞入了本应单列的后置
 * `of` 短语（`the development of applications` → 宾语只应到 `development`）。
 *
 * 角色集合与黄金集机器断言一致；从句、状语与 `of ...` 自身(index 0)不检查。判据刻意
 * 收窄到「of 前一个实词命中 `ofHeadNouns` 白名单」而不是「成分里出现非首位 of」——
 * 后者会误拒 `made of steel`(分词)、`capable of handling failures`(形容词)、专名
 * `Bank of America` 这类合法结构。与 Chrome 端 `OF_HEAD_NOUNS` 逐词一致。
 */
private val nounPhraseRoles = setOf(
  GrammarRole.SUBJECT,
  GrammarRole.OBJECT,
  GrammarRole.PREDICATIVE,
  GrammarRole.COMPLEMENT,
  GrammarRole.ATTRIBUTE,
  GrammarRole.APPOSITIVE,
)
/**
 * 「几乎总带后置 of 定语」的抽象名词中心词白名单，与 Chrome 端 `OF_HEAD_NOUNS` 逐词一致。
 * 先只收 `development`；扩表须逐词确认它作为 of 前一个词时几乎总是名词中心 + 后置定语。
 */
private val ofHeadNouns = setOf("development")
private const val SWALLOWED_OF_PHRASE_MESSAGE =
  "a noun-phrase component must stop before a postmodifying of-phrase; keep the noun head " +
    "in its current role and emit the span from \"of\" through its object as a separate ATTRIBUTE"

/**
 * 「几乎不可能悬垂」的介词。成分以它们收尾就说明介词的宾语被切了出去
 * （实测 `near the frontier of` + 宾语从句）。
 *
 * `for` / `with` / `at` / `from` / `to` 刻意不收：关系从句的介词悬垂
 * （`the tool I work with`、`the place I came from`）让它们合法地出现在成分末尾，
 * 收进来会把正确分析送进修复轮。已有的单词介词硬门只管「整个成分就是一个介词」，
 * 这条补的是「介词在成分末尾」。
 */
internal val objectRequiringPrepositions = setOf(
  "among", "between", "despite", "during", "into", "of", "onto", "toward", "towards",
  "upon", "within",
)


private fun lexicalTexts(tokens: List<Token>, range: TokenRange): List<String> = tokens
  .filter { it.id in range.startToken..range.endToken }
  .filterNot { it.punctuation }
  .map { it.text.lowercase() }

/** 只在成分序列已通过结构校验（区间在句内、有序不重叠）之后调用。 */
private fun collectGrammarErrors(
  components: List<IndexedCoreComponent>,
  tokens: List<Token>,
  path: String,
  errors: MutableList<ValidationError>,
) {
  val roles = components.map { it.component }
  val hasConjunction = roles.any { it.role == GrammarRole.CONJUNCTION }

  components.forEachIndexed { index, entry ->
    val component = entry.component
    val componentPath = "$path.components[${entry.rawIndex}]"
    val previous = components.getOrNull(index - 1)?.component
    val next = components.getOrNull(index + 1)?.component
    val words = lexicalTexts(tokens, TokenRange(component.startToken, component.endToken))
    val head = words.firstOrNull()

    if (component.role == GrammarRole.SUBJECT_CLAUSE && head !in subjectClauseIntroducers) {
      errors += error(
        componentPath,
        "a SUBJECT_CLAUSE must start with a subject-clause introducer (that/whether/what/who/…); retag or extend the component",
      )
    }

    val phraseRole = component.role == GrammarRole.ADVERBIAL || component.role == GrammarRole.ATTRIBUTE
    val startsWithClauseOnlyConjunction = head != null && (
      head in clauseOnlyConjunctions ||
        (head == "because" && words.getOrNull(1) != "of") ||
        (head == "though" && words.size >= 2)
      )
    if (phraseRole && startsWithClauseOnlyConjunction) {
      errors += error(
        componentPath,
        "a component that starts with a subordinating conjunction (because/although/…) is a clause and must be tagged with a clause role (ADVERBIAL_CLAUSE/…)",
      )
    }

    // PREDICATE_SCOPE_RULE：并排的动词属于同一个谓语，两个 PREDICATE 不得相邻。
    if (
      component.role == GrammarRole.PREDICATE &&
      previous?.role == GrammarRole.PREDICATE &&
      previous.endToken + 1 == component.startToken
    ) {
      val previousWords = lexicalTexts(tokens, TokenRange(previous.startToken, previous.endToken))
      val prevHead = previousWords.lastOrNull()
      // 前一个谓语只含助动词/情态动词时,给更精确的合并指令(与 TS 逐字一致)。
      if (previousWords.size == 1 && prevHead != null && prevHead in auxiliaryModals) {
        errors += error(
          componentPath,
          "auxiliary/modal verb \"$prevHead\" must be merged with the following main verb into one PREDICATE covering the complete verb group",
        )
      } else {
        errors += error(
          componentPath,
          "adjacent PREDICATE components must be merged into one PREDICATE covering the whole verb group",
        )
      }
    }

    // 谓语必须以动词组开头。限定词与主格代词都不可能是动词，命中即说明主语被吞了进来。
    if (component.role == GrammarRole.PREDICATE && head != null && head in predicateHeadBlockers) {
      errors += error(
        componentPath,
        "a PREDICATE must begin with the verb group; move the leading subject or noun phrase " +
          "into its own component",
      )
    }

    // 谓语内部出现限定词 = 宾语 / 表语 / 补语被吞进了动词组。
    if (component.role == GrammarRole.PREDICATE && words.drop(1).any { it in determiners }) {
      errors += error(
        componentPath,
        "a PREDICATE must cover only the verb group; emit the noun phrase that starts at the " +
          "determiner as its own OBJECT, PREDICATIVE, or COMPLEMENT component",
      )
    }

    // 从属连词引导的是从句，不是并列分句。整句已有 CONJUNCTION 时不判——
    // "Because A, B, and C" 里第一个并列分句本来就以从属连词开头。
    if (
      component.role == GrammarRole.COORDINATE_CLAUSE &&
      head != null &&
      head in subordinatingConjunctions &&
      !hasConjunction
    ) {
      errors += error(
        componentPath,
        "a clause introduced by a subordinating conjunction is not a COORDINATE_CLAUSE; tag it " +
          "with one of the five subordinate clause roles and analyse the main clause as peer components",
      )
    }

    // PREPOSITIONAL_PHRASE_RULE：介词与它管辖的一切是一个成分，介词不得独立成分。
    if (component.role != GrammarRole.CONJUNCTION && words.size == 1 && words.single() in prepositions) {
      errors += error(
        componentPath,
        "a preposition must be merged with the phrase it governs instead of forming its own component",
      )
    }

    // 并列连词以外的词不该标 CONJUNCTION——模型最常拿它套逗号或从属连词。
    if (component.role == GrammarRole.CONJUNCTION && words.none { it in coordinatingConjunctions }) {
      errors += error(
        componentPath,
        "CONJUNCTION must cover a coordinating conjunction (for, and, nor, but, or, yet, so)",
      )
    }

    // Complex-sentence rule 的本地兑现：从句整块输出，实词数 1 不可能是一个从句。
    if (component.role in clauseRoles && words.size < MIN_CLAUSE_LEXICAL_TOKENS) {
      errors += error(
        componentPath,
        "a clause component must cover a whole clause: extend it through the clause's own subject, " +
          "predicate, and any objects or adverbials instead of a single word",
      )
    }

    // 名词性成分吞入后置 of 短语 = 截止位置过晚。of 短语自身以 of 开头，index=0 不判。
    // 只有 of 前一个实词命中高把握名词中心词白名单才拒绝，避免误伤 made of / capable of /
    // Bank of America 这类 of 前不是名词中心的合法结构。
    val ofIndex = words.indexOf("of")
    if (component.role in nounPhraseRoles && ofIndex >= 1 && words[ofIndex - 1] in ofHeadNouns) {
      errors += error(componentPath, SWALLOWED_OF_PHRASE_MESSAGE)
    }

    // 定语从句后面紧跟宾语 / 表语 / 补语 = 从句自己的成分被切了出去。
    // 后继按语义成分序列取(不是原数组邻接),被跳过的纯标点成分不算「紧跟」。
    if (
      component.role == GrammarRole.ATTRIBUTIVE_CLAUSE &&
      next?.role in clauseInternalFollowers
    ) {
      errors += error(
        componentPath,
        "an ATTRIBUTIVE_CLAUSE keeps its whole internal structure in one component; absorb the " +
          "object or predicative that follows it",
      )
    }

    // 短语成分以「必带宾语的介词」收尾 = 介词的宾语被切了出去。单词介词另有专门的硬门。
    // 从句角色豁免：of/within/between/among 可在关系从句或名词性从句内部合法悬垂
    // (`That's what dreams are made of.`)；短语角色照旧拦截 `near the frontier of`。
    if (
      component.role != GrammarRole.CONJUNCTION &&
      component.role !in clauseRoles &&
      words.size > 1 &&
      words.last() in objectRequiringPrepositions
    ) {
      errors += error(
        componentPath,
        "a component must not end on a preposition; merge the phrase that preposition governs " +
          "into the same component",
      )
    }
  }

  // 单成分整句的豁免集是片段语义角色；10 是挑战集审阅后的启发式上限，不是语法定律。
  val lexicalTokenCount = tokens.count { !it.punctuation }
  val only = roles.singleOrNull()
  val onlyLexicalCount = only?.let {
    lexicalTexts(tokens, TokenRange(it.startToken, it.endToken)).size
  } ?: 0
  val coversWholeSentence = onlyLexicalCount == lexicalTokenCount
  if (
    only != null &&
    only.role !in wholeSentenceFragmentRoles &&
    lexicalTokenCount >= MIN_SPLITTABLE_LEXICAL_TOKENS &&
    coversWholeSentence
  ) {
    errors += error(
      "$path.components",
      "one component must not cover the whole sentence; split it into peer components " +
        "(subject, predicate, object, adverbial, …)",
    )
  }
  if (
    only != null &&
    only.role in wholeSentenceFragmentRoles &&
    onlyLexicalCount > MAX_WHOLE_SENTENCE_FRAGMENT_LEXICAL_TOKENS &&
    coversWholeSentence
  ) {
    errors += error(
      "$path.components",
      "a whole-sentence fragment component must not exceed $MAX_WHOLE_SENTENCE_FRAGMENT_LEXICAL_TOKENS lexical tokens; split it into a fragment head plus its modifiers",
    )
  }

  // COORDINATE_CLAUSE 已废弃：并列句现在按同层成分平铺（各分句的 subject/predicate/
  // object 等作为句子的顶层成分），并列连词单独标 CONJUNCTION。这样卡片才能显示成分
  // 划分而不是几整块译文。旧的"包成两个 COORDINATE_CLAUSE"约定是「看着像翻译」的
  // 主要来源，在扩展到真实散文后实测退化严重。
  val coordinateClauses = roles.count { it.role == GrammarRole.COORDINATE_CLAUSE }
  if (coordinateClauses >= 1) {
    errors += error(
      "$path.components",
      "COORDINATE_CLAUSE is deprecated; analyse compound sentences as peer components (subject, predicate, object, …) " +
        "with the coordinating conjunction tagged separately as CONJUNCTION",
    )
  }

  val fragmentHeads = roles.filter { it.role == GrammarRole.FRAGMENT_HEAD }
  if (fragmentHeads.size > 1) {
    errors += error(
      "$path.components",
      "a non-clausal fragment must contain at most one FRAGMENT_HEAD",
    )
  }
  if (fragmentHeads.isNotEmpty() && roles.any { it.role in fragmentForbiddenRoles }) {
    errors += error("$path.components", FRAGMENT_MIXED_ROLE_MESSAGE)
  }
}

private fun parseCoreComponent(
  value: JsonElement,
  tokens: List<Token>,
  path: String,
  errors: MutableList<ValidationError>,
): CoreComponent? {
  val objectValue = value.asObject()
  if (objectValue == null) {
    errors += error(path, "must be an object")
    return null
  }
  if (!objectValue.hasOnly(coreComponentKeys)) errors += error(path, "contains unknown fields")
  val range = parseRange(objectValue, path, errors)
  val roleText = objectValue["role"]?.safeText()
  if (roleText == null || runCatching { GrammarRole.valueOf(roleText) }.isFailure) {
    errors += error("$path.role", "must be a known grammar role")
  }
  val translation = objectValue["translation"]?.safeText()
  if (translation == null) {
    errors += error("$path.translation", "must be a safe string")
  } else if (translation.trim().isEmpty()) {
    errors += error("$path.translation", "must not be empty")
  } else if (range != null && translation.length > maxOf(500, tokenLength(tokens, range) * 8)) {
    errors += error("$path.translation", "is too long")
  } else if (range != null && !isMeaningfulChineseGloss(translation, tokens, range)) {
    // 译文质量硬门:无 Han 或与英文 span 等值(回显)都只报这一条,不阻断语法诊断。
    errors += error("$path.translation", TRANSLATION_QUALITY_MESSAGE)
  }
  val role = roleText?.let { runCatching { GrammarRole.valueOf(it) }.getOrNull() }
  return if (range == null || role == null || translation == null || translation.trim().isEmpty()) null
  else CoreComponent(range.startToken, range.endToken, role, translation)
}

private fun parseCoreSentence(
  value: JsonElement,
  request: SentenceInput,
  index: Int,
  profileId: String,
  errors: MutableList<ValidationError>,
): CoreAnalysis? {
  val path = "sentences[$index]"
  val objectValue = value.asObject()
  if (objectValue == null) {
    errors += error(path, "must be an object")
    return null
  }
  if (!objectValue.hasOnly(coreSentenceKeys)) errors += error(path, "contains unknown fields")
  if (objectValue["sentenceId"]?.safeText() != request.sentenceId) {
    errors += error("$path.sentenceId", "does not match the requested sentence")
  }
  val componentsValue = objectValue["components"]
  if (componentsValue !is kotlinx.serialization.json.JsonArray || componentsValue.isEmpty()) {
    errors += error("$path.components", "must be a non-empty array")
    return null
  }
  // 模型常给逗号/句号虚构 PUNCTUATION、CONJUNCTION 等角色。标点本来就允许不覆盖，
  // 所以必须在角色枚举校验前丢掉纯标点区间；否则未知角色会让整句在 repair 后仍失败。
  val entries = rawComponentEntries(componentsValue, request.tokens)
  if (entries.isEmpty()) {
    errors += error("$path.components", "must contain a non-punctuation component")
    return null
  }
  // 解析尝试保留 rawIndex;component 为 null 表示解析失败,不能用 filterNotNull
  // 提前剔除——结构可信度需要它们参与判定。
  val parsed: List<Pair<Int, CoreComponent?>> = entries.map { (rawIndex, value) ->
    rawIndex to parseCoreComponent(value, request.tokens, "$path.components[$rawIndex]", errors)
  }
  // grammar 只依赖结构可信度，不能被 unknown field、过长译文或 sentenceId 等
  // 非结构错误短路；每个语义成分都成功解析、区间在句内且有序不重叠才可信。
  var structureTrusted = parsed.all { it.second != null }
  var previousEnd = -1
  parsed.forEach { (rawIndex, component) ->
    val safeComponent = component ?: run {
      structureTrusted = false
      return@forEach
    }
    val componentPath = "$path.components[$rawIndex]"
    val covered = request.tokens.filter { it.id in safeComponent.startToken..safeComponent.endToken }
    if (covered.isEmpty() || covered.first().id != safeComponent.startToken || covered.last().id != safeComponent.endToken) {
      errors += error(componentPath, "token interval is outside the original sentence")
      structureTrusted = false
    }
    if (safeComponent.startToken <= previousEnd) {
      errors += error("$path.components", "components must be ordered and non-overlapping")
      structureTrusted = false
    }
    previousEnd = safeComponent.endToken
  }
  val valid: List<IndexedCoreComponent> = parsed.mapNotNull { (rawIndex, component) ->
    component?.let { IndexedCoreComponent(rawIndex, it) }
  }
  if (structureTrusted) {
    collectGrammarErrors(valid, request.tokens, path, errors)
  }
  request.tokens.forEach { token ->
    val coverage = valid.count { token.id in it.component.startToken..it.component.endToken }
    when {
      !token.punctuation && coverage == 0 -> errors += error("$path.components", "non-punctuation token ${token.id} is not covered")
      !token.punctuation && coverage > 1 -> errors += error("$path.components", "non-punctuation token ${token.id} is covered more than once")
      token.punctuation && coverage > 1 -> errors += error("$path.components", "punctuation token ${token.id} is covered more than once")
    }
  }
  return if (errors.any { it.path == path || it.path.startsWith("$path.") } || valid.size != entries.size) null
  // 投影为纯 CoreComponent:rawIndex 只是诊断坐标,不得进缓存与渲染。
  else CoreAnalysis(
    sentenceId = request.sentenceId,
    components = valid.map { it.component },
    modelProfileId = profileId,
  )
}

fun validateCoreBatch(raw: JsonElement, requests: List<SentenceInput>, profileId: String): ValidationResult<List<CoreAnalysis>> {
  return try {
    val errors = mutableListOf<ValidationError>()
    val envelope = raw.asObject() ?: return invalid(listOf(error("", "must be an object")))
  if (!envelope.hasOnly(coreEnvelopeKeys)) errors += error("", "contains unknown fields")
  val sentences = envelope["sentences"]
  if (sentences !is JsonArray) return invalid(errors + error("sentences", "must be an array"))
  val requestById = requests.associateBy { it.sentenceId }
  val seen = mutableSetOf<String>()
  val analyses = mutableMapOf<String, CoreAnalysis>()
  sentences.forEachIndexed { index, value ->
    val objectValue = value.asObject()
    val id = objectValue?.get("sentenceId")?.safeText()
    if (id == null) {
      errors += error("sentences[$index].sentenceId", "must be a safe string")
      return@forEachIndexed
    }
    val request = requestById[id]
    if (request == null) {
      errors += error("sentences[$index].sentenceId", "was not requested")
      return@forEachIndexed
    }
    if (!seen.add(id)) {
      errors += error("sentences[$index].sentenceId", "is duplicated")
      return@forEachIndexed
    }
    parseCoreSentence(objectValue, request, index, profileId, errors)?.let { analysis ->
      analyses[id] = analysis.copy(components = analysis.components.filterNot { component ->
        request.tokens.filter { it.id in component.startToken..component.endToken }.all { it.punctuation }
      })
    }
  }
  requests.forEach { if (it.sentenceId !in seen) errors += error("sentences", "requested sentence ${it.sentenceId} is missing") }
  if (errors.isNotEmpty()) invalid(errors)
  else valid(requests.map { analyses.getValue(it.sentenceId) })
} catch (exception: Exception) {
    invalid(listOf(error("", "invalid JSON structure")))
  }
}

private fun parseDetailStructure(value: JsonElement, tokens: List<Token>, path: String, errors: MutableList<ValidationError>): DetailStructure? {
  val objectValue = value.asObject()
  if (objectValue == null) {
    errors += error(path, "must be an object")
    return null
  }
  if (!objectValue.hasOnly(detailStructureKeys)) errors += error(path, "contains unknown fields")
  val range = parseRange(objectValue, path, errors)
  if (range != null && (tokens.none { it.id == range.startToken } || tokens.none { it.id == range.endToken })) {
    errors += error(path, "token interval is outside the original sentence")
  }
  val role = objectValue["role"]?.safeText()
  if (role == null || role.trim().isEmpty()) errors += error("$path.role", "must be a non-empty safe string")
  val explanation = objectValue["explanation"]?.safeText()
  if (explanation == null || explanation.trim().isEmpty()) errors += error("$path.explanation", "must be a non-empty safe string")
  val translationElement = objectValue["translation"]
  val translation = translationElement?.safeText()
  if (translationElement != null && translation == null) errors += error("$path.translation", "must be a safe string when present")
  if (range == null || role == null || role.trim().isEmpty() || explanation == null || explanation.trim().isEmpty() || (translationElement != null && translation == null)) return null
  return DetailStructure(range.startToken, range.endToken, role, explanation, translation?.takeUnless { it.trim().isEmpty() })
}

fun validateDetail(raw: JsonElement, request: SentenceInput, requestedFocus: TokenRange, profileId: String): ValidationResult<DetailAnalysis> = try {
  val errors = mutableListOf<ValidationError>()
  val envelope = raw.asObject() ?: return invalid(listOf(error("", "must be an object")))
  if (!envelope.hasOnly(detailEnvelopeKeys)) errors += error("", "contains unknown fields")
  if (envelope["sentenceId"]?.safeText() != request.sentenceId) errors += error("sentenceId", "does not match the requested sentence")
  val focusValue = envelope["focus"]
  val focus = if (focusValue is JsonObject && focusValue.hasOnly(detailFocusKeys)) parseRange(focusValue, "focus", errors) else {
    errors += error("focus", "must be a token interval")
    null
  }
  if (focus != null && (focus.startToken != requestedFocus.startToken || focus.endToken != requestedFocus.endToken)) errors += error("focus", "must match the requested focus")
  val structuresValue = envelope["structures"]
  val structures = if (structuresValue is kotlinx.serialization.json.JsonArray) structuresValue.mapIndexedNotNull { i, value -> parseDetailStructure(value, request.tokens, "structures[$i]", errors) } else {
    errors += error("structures", "must be an array")
    emptyList()
  }
  if (focus != null) {
    var previousEnd = focus.startToken - 1
    structures.forEachIndexed { index, structure ->
      val path = "structures[$index]"
      if (structure.startToken < focus.startToken || structure.endToken > focus.endToken) {
        errors += error(path, "must stay inside the requested focus")
      }
      if (structure.startToken <= previousEnd) {
        errors += error("structures", "must be ordered and non-overlapping")
      }
      previousEnd = maxOf(previousEnd, structure.endToken)
    }
  }
  val pointsValue = envelope["grammarPoints"]
  val grammarPoints = if (pointsValue is kotlinx.serialization.json.JsonArray) {
    if (pointsValue.size > 12) errors += error("grammarPoints", "must contain at most 12 items")
    pointsValue.mapIndexedNotNull { i, point ->
      val text = point.safeText()
      if (text == null || text.trim().isEmpty() || text.length > 300) {
        errors += error("grammarPoints[$i]", "must be a non-empty safe string of at most 300 characters")
        null
      } else text
    }
  } else {
    errors += error("grammarPoints", "must be an array")
    emptyList()
  }
  val explanation = envelope["explanation"]?.safeText()
  if (explanation == null || explanation.trim().isEmpty()) errors += error("explanation", "must be a non-empty safe string")
  if (errors.isNotEmpty() || focus == null || explanation == null) invalid(errors)
  else valid(DetailAnalysis(request.sentenceId, focus, structures, grammarPoints, explanation, profileId))
} catch (exception: Exception) {
  invalid(listOf(error("", "invalid JSON structure")))
}
