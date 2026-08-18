package dev.codetui.englishsyntax.model

import kotlinx.serialization.json.JsonObject

data class StreamedComponent(
  val sentenceId: String,
  val component: JsonObject,
)

private data class Frame(
  val kind: Kind,
  val key: String? = null,
  var pendingKey: String? = null,
) {
  enum class Kind { OBJECT, ARRAY }
}

private data class SentenceFrame(
  val start: Int,
  var sentenceId: String? = null,
  var buffered: MutableList<JsonObject> = mutableListOf(),
)

/**
 * 在核心分析 envelope 仍在流式输出时逐出完整 component，让段落提前渲染。
 * 刻意不是通用 JSON 解析器：只跟踪 prompt 要求的固定形状，并在 component 对象
 * 闭合时输出。component 是未校验的模型输出，调用方必须再做最终校验。
 */
class CoreStreamParser {
  private val stack = mutableListOf<Frame>()
  private val sentences = mutableListOf<SentenceFrame>()
  private val buffer = StringBuilder()
  private var cursor = 0
  private var inString = false
  private var escaped = false
  private var started = false
  private var stringStart = 0
  private var componentStart: Int? = null

  /** Feeds more raw JSON text and returns the components it completed. */
  fun push(text: String): List<StreamedComponent> {
    buffer.append(text)
    val emitted = mutableListOf<StreamedComponent>()
    while (cursor < buffer.length) {
      val index = cursor
      val character = buffer[index]
      cursor += 1

      if (inString) {
        when {
          escaped -> escaped = false
          character == '\\' -> escaped = true
          character == '"' -> inString = false
        }
        continue
      }

      if (!started) {
        // 容忍模型先吐 Markdown 围栏或散文。
        if (character != '{') continue
        started = true
      }

      when (character) {
        '"' -> {
          inString = true
          stringStart = index
        }
        ':' -> assignPendingKey()
        '{' -> openObject(index)
        '[' -> stack += Frame(Frame.Kind.ARRAY, key = consumeKey())
        '}' -> closeObject(index, emitted)
        ']' -> stack.removeLastOrNull()
      }
    }
    return emitted
  }

  private fun assignPendingKey() {
    val frame = stack.lastOrNull() ?: return
    if (frame.kind != Frame.Kind.OBJECT) return
    val literal = buffer.substring(stringStart, cursor - 1).trim()
    frame.pendingKey = parseStreamString(literal)
  }

  private fun consumeKey(): String? {
    val frame = stack.lastOrNull() ?: return null
    if (frame.kind != Frame.Kind.OBJECT) return null
    val key = frame.pendingKey
    frame.pendingKey = null
    return key
  }

  private fun openObject(index: Int) {
    val key = consumeKey()
    val parent = stack.lastOrNull()
    stack += Frame(Frame.Kind.OBJECT, key = key)
    if (parent?.kind != Frame.Kind.ARRAY) return
    when (parent.key) {
      "sentences" -> sentences += SentenceFrame(start = index)
      "components" -> if (componentStart == null) componentStart = index
    }
  }

  private fun closeObject(index: Int, emitted: MutableList<StreamedComponent>) {
    stack.removeLastOrNull() ?: return
    val enclosing = stack.lastOrNull()
    val start = componentStart
    if (start != null && enclosing?.key == "components") {
      val component = parseStreamObject(buffer.substring(start, index + 1))
      componentStart = null
      if (component != null) collect(component, emitted)
      return
    }
    if (enclosing?.key == "sentences") flushBuffered(emitted)
  }

  private fun collect(component: JsonObject, emitted: MutableList<StreamedComponent>) {
    val sentence = sentences.lastOrNull() ?: return
    if (sentence.sentenceId == null) {
      sentence.sentenceId = readSentenceId(sentence)
    }
    val sentenceId = sentence.sentenceId
    if (sentenceId == null) {
      sentence.buffered += component
      return
    }
    emitted += StreamedComponent(sentenceId, component)
  }

  private fun readSentenceId(sentence: SentenceFrame): String? {
    val match = SENTENCE_ID_PATTERN.find(buffer.substring(sentence.start)) ?: return null
    return parseStreamString("\"${match.groupValues[1]}\"")
  }

  private fun flushBuffered(emitted: MutableList<StreamedComponent>) {
    val sentence = sentences.lastOrNull() ?: return
    if (sentence.buffered.isEmpty()) return
    val sentenceId = sentence.sentenceId ?: readSentenceId(sentence) ?: return
    for (component in sentence.buffered) emitted += StreamedComponent(sentenceId, component)
    sentence.buffered = mutableListOf()
  }

  companion object {
    private val SENTENCE_ID_PATTERN = Regex("\"sentenceId\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"")
  }
}

