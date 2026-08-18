package dev.codetui.englishsyntax.language

import dev.codetui.englishsyntax.domain.Token
import java.security.MessageDigest
import java.text.BreakIterator
import java.util.Locale

private val abbreviations = listOf("Mr.", "Mrs.", "Ms.", "Dr.", "Prof.", "Sr.", "Jr.", "e.g.", "i.e.", "U.S.")
private val tokenPattern = Regex("[\\p{L}\\p{N}]+(?:['’-][\\p{L}\\p{N}]+)*|[^\\s]")
private val wordStart = Regex("^[\\p{L}\\p{N}]")

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
    val source = text.substring(rawStart, rawEnd)
    val leading = source.length - source.trimStart().length
    val value = source.trim()
    if (value.isEmpty()) null else SegmentedSentence(value, rawStart + leading, rawStart + leading + value.length)
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
