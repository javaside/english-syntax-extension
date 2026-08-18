package dev.codetui.englishsyntax.language

import dev.codetui.englishsyntax.domain.Token
import java.security.MessageDigest
import java.text.BreakIterator
import java.util.Locale

private val abbreviations = listOf("Mr.", "Mrs.", "Ms.", "Dr.", "Prof.", "Sr.", "Jr.", "e.g.", "i.e.", "U.S.")
private val tokenPattern = Regex(
  "[\\p{L}\\p{N}]+(?:['’-][\\p{L}\\p{N}]+)*|[^\\s\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]",
)
private val wordStart = Regex("^[\\p{L}\\p{N}]")
private val javascriptWhitespace = Regex("^[\\s\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]$")

data class SegmentedSentence(val text: String, val start: Int, val end: Int)

fun segmentBlock(text: String): List<SegmentedSentence> {
  val iterator = BreakIterator.getSentenceInstance(Locale.ENGLISH)
  iterator.setText(text)
  val raw = buildList {
    var start = iterator.first()
    var end = iterator.next()
    while (end != BreakIterator.DONE) {
      add(start to end)
      start = end
      end = iterator.next()
    }
  }
  val merged = mutableListOf<Pair<Int, Int>>()
  for ((start, end) in raw) {
    val previous = merged.lastOrNull()
    if (previous != null && abbreviations.any { text.substring(previous.first, previous.second).trimEnd().endsWith(it) }) {
      merged[merged.lastIndex] = previous.first to end
    } else {
      merged += start to end
    }
  }
  return merged.mapNotNull { (rawStart, rawEnd) ->
    var start = rawStart
    while (start < rawEnd && javascriptWhitespace.matches(text[start].toString())) start += 1

    var end = rawEnd
    while (end > start && javascriptWhitespace.matches(text[end - 1].toString())) end -= 1

    if (start == end) null else SegmentedSentence(text.substring(start, end), start, end)
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

fun rebuildTokens(tokens: List<Token>): String = tokens.joinToString("") { it.leadingWhitespace + it.text }

fun createSentenceId(sessionId: String, blockId: String, order: Int, normalizedText: String): String {
  val source = "$sessionId\u0000$blockId\u0000$order\u0000$normalizedText"
  return MessageDigest.getInstance("SHA-256")
    .digest(source.toByteArray(Charsets.UTF_8))
    .joinToString("") { "%02x".format(it) }
    .take(24)
}
