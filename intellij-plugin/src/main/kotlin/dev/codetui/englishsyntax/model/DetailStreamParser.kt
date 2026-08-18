package dev.codetui.englishsyntax.model

import kotlinx.serialization.json.JsonObject

private data class DetailFrame(
  val kind: Kind,
  val key: String? = null,
  var pendingKey: String? = null,
) {
  enum class Kind { OBJECT, ARRAY }
}

/**
 * 在详解 envelope 流式输出时逐出完整 `structures[]` 条目。
 * 与 CoreStreamParser 同构但刻意不合并：core 需要归属句子，详解是扁平的。
 * Key-aware 而不是数括号深度：`focus` 对象在 `structures` 之前，且结构内可能嵌对象。
 * 输出的 structure 是未校验模型输出，调用方负责校验。
 */
class DetailStreamParser {
  private val stack = mutableListOf<DetailFrame>()
  private val buffer = StringBuilder()
  private var cursor = 0
  private var inString = false
  private var escaped = false
  private var started = false
  private var stringStart = 0
  private var structureStart: Int? = null

  fun push(text: String): List<JsonObject> {
    buffer.append(text)
    val emitted = mutableListOf<JsonObject>()
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
        '[' -> stack += DetailFrame(DetailFrame.Kind.ARRAY, key = consumeKey())
        '}' -> closeObject(index, emitted)
        ']' -> stack.removeLastOrNull()
      }
    }
    return emitted
  }

  private fun assignPendingKey() {
    val frame = stack.lastOrNull() ?: return
    if (frame.kind != DetailFrame.Kind.OBJECT) return
    val literal = buffer.substring(stringStart, cursor - 1).trim()
    frame.pendingKey = parseStreamString(literal)
  }

  private fun consumeKey(): String? {
    val frame = stack.lastOrNull() ?: return null
    if (frame.kind != DetailFrame.Kind.OBJECT) return null
    val key = frame.pendingKey
    frame.pendingKey = null
    return key
  }

  private fun openObject(index: Int) {
    val key = consumeKey()
    val parent = stack.lastOrNull()
    stack += DetailFrame(DetailFrame.Kind.OBJECT, key = key)
    if (parent?.kind == DetailFrame.Kind.ARRAY && parent.key == "structures" && structureStart == null) {
      structureStart = index
    }
  }

  private fun closeObject(index: Int, emitted: MutableList<JsonObject>) {
    stack.removeLastOrNull() ?: return
    val start = structureStart ?: return
    if (stack.lastOrNull()?.key != "structures") return
    val structure = parseStreamObject(buffer.substring(start, index + 1))
    structureStart = null
    if (structure != null) emitted += structure
  }
}
