package dev.codetui.englishsyntax.language

import dev.codetui.englishsyntax.domain.Token
import java.security.MessageDigest

/**
 * 与 Chrome 端 `segmenter.ts` 的 `ABBREVIATIONS` 逐条一致，由 shared-fixtures/segmenter-vectors.json 钉住。
 * 自定义边界只按句末标点判断，所以缩写必须靠这份白名单撤销误断。
 */
private val abbreviations = listOf(
  "Mr.", "Mrs.", "Ms.", "Dr.", "Prof.", "Sr.", "Jr.",
  "Rev.", "Capt.", "Lt.", "Sgt.", "Col.", "Maj.", "Gen.", "Gov.", "Sen.", "Rep.",
  "St.", "Ave.", "Blvd.", "Rd.",
  "Inc.", "Ltd.", "Co.", "Corp.", "Dept.", "Univ.",
  "No.", "Fig.", "Ch.", "Vol.", "p.", "pp.", "vs.", "cf.", "approx.", "et al.",
  "e.g.", "i.e.", "a.m.", "p.m.", "U.S.", "Ph.D.",
)
/** JS whitespace 的显式字符类；不使用两端语义不同的 `\\s`。 */
private val jsWhitespaceClass =
  "\\u0009-\\u000d\\u0020\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff"

/**
 * 分句边界由**本仓库自己定义**，不用 `BreakIterator`。
 *
 * 两端必须逐字节一致（缓存键取规范化句文本，分叉即互不命中），而 `BreakIterator` 与
 * `Intl.Segmenter` 对同一段文本给出的原始边界并不相同：实测
 * `1. Install the CLI. 2. Run the setup.` JS 侧切 4 段、JVM 侧切 3 段（它把
 * `Install the CLI. 2.` 并成一段）。只要还从平台边界出发做取舍，这类分叉就补不完。
 *
 * 与 `segmenter.ts` 的 `SENTENCE_BOUNDARY_PATTERN` 逐字一致。
 */
private val sentenceBoundary = Regex("[.!?…。！？]+[\"'”’)\\]}»]*(?=[$jsWhitespaceClass])")

/**
 * 有些缩写强烈要求后接名字/内容（称谓等），另一些也常合法收句。后者只有在下一片段
 * 以小写词或数字开头时才撤销边界：`U.S. delegation` 合并，`U.S. She` 保留边界。
 */
private val contextSensitiveAbbreviations = setOf("U.S.", "Ph.D.", "Inc.", "Ltd.", "Co.", "Corp.")
private val alwaysNonTerminalAbbreviations = abbreviations.filterNot { it in contextSensitiveAbbreviations }
private fun abbreviationSource(value: String): String =
  value.replace(".", "\\.").replace(" ", "[$jsWhitespaceClass]+")

private fun abbreviationEndPattern(values: Collection<String>) = Regex(
  "(?:^|[$jsWhitespaceClass(\"'“‘\\[])(?:${values.joinToString("|") { abbreviationSource(it) }})$",
)
private val alwaysNonTerminalEnd = abbreviationEndPattern(alwaysNonTerminalAbbreviations)
private val contextSensitiveEnd = abbreviationEndPattern(contextSensitiveAbbreviations)
private val continuationStart = Regex("^[$jsWhitespaceClass]*[\"'“‘(\\[]*[\\p{Ll}\\p{N}]")
/** 独立的单个大写字母 + 句点 = 姓名首字母缩写（"Written by J. R. Smith."）。 */
private val initialEnd = Regex("(?:^|[$jsWhitespaceClass(\"'“‘\\[])\\p{Lu}\\.$")
/** 至少两个连续字母才算实词。缺了它的片段（"1." / "J." / "---"）无法解析，只能并入邻句。 */
private val lexicalWord = Regex("\\p{L}{2,}")

private val urlSource = "[A-Za-z][A-Za-z0-9+.-]*://[^$jsWhitespaceClass]*[^$jsWhitespaceClass.,;:!?)\\]}'\"]"
private val emailSource = "[\\p{L}\\p{N}._%+-]+@[\\p{L}\\p{N}-]+(?:\\.[\\p{L}\\p{N}-]+)+"
/** 小数、千分位、语义化版本号。要求至少一组「分隔符 + 数字」，好让裸数字与 "1." 走普通词分支。 */
private const val NUMBER_SOURCE = "\\p{N}+(?:[.,]\\p{N}+)+"
private const val WORD_SOURCE = "[\\p{L}\\p{N}]+(?:['’-][\\p{L}\\p{N}]+)*"

/**
 * Token 是模型定位成分的唯一坐标，所以一个语言学上的整体必须是一个 Token。
 * 顺序即优先级：URL / 邮箱 → 缩写 → 带小数点或千分位的数 → 普通词 → 单个非空白字符。
 * 长缩写排前面，否则 "Ph.D." 会先被 "p." 咬掉一截。
 */
private val tokenPattern = Regex(
  listOf(
    urlSource,
    emailSource,
    abbreviations.sortedByDescending { it.length }.joinToString("|") { abbreviationSource(it) },
    NUMBER_SOURCE,
    WORD_SOURCE,
    "[^$jsWhitespaceClass]",
  ).joinToString("|"),
)
private val wordStart = Regex("^[\\p{L}\\p{N}]")
private val javascriptWhitespace = Regex("^[$jsWhitespaceClass]$")

data class SegmentedSentence(val text: String, val start: Int, val end: Int)

private fun mergesIntoNext(text: String, nextText: String): Boolean {
  val trimmed = text.trimEnd()
  return alwaysNonTerminalEnd.containsMatchIn(trimmed) ||
    initialEnd.containsMatchIn(trimmed) ||
    (contextSensitiveEnd.containsMatchIn(trimmed) && continuationStart.containsMatchIn(nextText)) ||
    !lexicalWord.containsMatchIn(trimmed)
}

/** 候选边界：每个句末标点串之后的位置（含收尾引号/括号），外加整块末尾。 */
private fun boundaryOffsets(text: String): List<Int> {
  val offsets = sentenceBoundary.findAll(text).map { it.range.last + 1 }.toMutableList()
  if (offsets.lastOrNull() != text.length) offsets += text.length
  return offsets
}

fun segmentBlock(text: String): List<SegmentedSentence> {
  val merged = mutableListOf<IntArray>()
  var start = 0
  for (end in boundaryOffsets(text)) {
    val previous = merged.lastOrNull()
    // 合并后的跨度要重新判定，"J. R. R. Tolkien" 这样的链式首字母才能一路并下去。
    if (
      previous != null &&
      mergesIntoNext(text.substring(previous[0], previous[1]), text.substring(previous[1], end))
    ) {
      previous[1] = end
    } else {
      merged += intArrayOf(start, end)
    }
    start = end
  }

  // 只有最后一段可能仍缺实词（前面的都在上面并进了下一段），它只能往前并。
  val last = merged.lastOrNull()
  if (merged.size > 1 && last != null && !lexicalWord.containsMatchIn(text.substring(last[0], last[1]))) {
    merged[merged.lastIndex - 1][1] = last[1]
    merged.removeAt(merged.lastIndex)
  }

  return merged.mapNotNull { (rawStart, rawEnd) ->
    var trimmedStart = rawStart
    while (trimmedStart < rawEnd && javascriptWhitespace.matches(text[trimmedStart].toString())) trimmedStart += 1

    var trimmedEnd = rawEnd
    while (trimmedEnd > trimmedStart && javascriptWhitespace.matches(text[trimmedEnd - 1].toString())) trimmedEnd -= 1

    val sentence = text.substring(trimmedStart, trimmedEnd)
    // 整块只有一个无实词片段：发给模型也只会浪费一次请求。
    if (trimmedStart == trimmedEnd || !lexicalWord.containsMatchIn(sentence)) {
      null
    } else {
      SegmentedSentence(sentence, trimmedStart, trimmedEnd)
    }
  }
}

fun tokenize(sentence: String): List<Token> {
  var previousEnd = 0
  return tokenPattern.findAll(sentence).mapIndexed { index, match ->
    val start = match.range.first
    val end = match.range.last + 1
    Token(
      id = index,
      text = match.value,
      start = start,
      end = end,
      leadingWhitespace = sentence.substring(previousEnd, start),
      punctuation = !wordStart.containsMatchIn(match.value),
    ).also { previousEnd = end }
  }.toList()
}

/**
 * 对 `segmentBlock` 已去掉首尾空白的生产句文本无损重建。Token schema 不保存句尾空白；
 * 那类空白属于 block 内句间 gap，而不是生产句输入的一部分。
 */
fun rebuildTokens(tokens: List<Token>): String = tokens.joinToString("") { it.leadingWhitespace + it.text }

fun createSentenceId(sessionId: String, blockId: String, order: Int, normalizedText: String): String {
  val source = "$sessionId\u0000$blockId\u0000$order\u0000$normalizedText"
  return MessageDigest.getInstance("SHA-256")
    .digest(source.toByteArray(Charsets.UTF_8))
    .joinToString("") { "%02x".format(it) }
    .take(24)
}
