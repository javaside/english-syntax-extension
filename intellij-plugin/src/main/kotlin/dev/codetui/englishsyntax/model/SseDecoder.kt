package dev.codetui.englishsyntax.model

/** The sentinel payload OpenAI-compatible endpoints send to close a stream. */
const val SSE_DONE = "[DONE]"

/**
 * 极简 SSE 解码器，只实现模型端点实际用到的部分：`data` 字段、空行事件边界、
 * 注释和 CRLF。跨 chunk 的半行要留在缓冲区，这正是有状态解码器的意义。
 */
class SseDecoder {
  private val buffer = StringBuilder()

  /** Feeds decoded text and returns the payloads of every event it completed. */
  fun push(text: String): List<String> {
    buffer.append(text)
    val payloads = mutableListOf<String>()
    while (true) {
      val boundary = nextBoundary() ?: return payloads
      val block = buffer.substring(0, boundary.index)
      buffer.delete(0, boundary.index + boundary.length)
      dataPayload(block)?.let(payloads::add)
    }
  }

  /** The earliest blank line, tolerating either line ending. */
  private fun nextBoundary(): Boundary? {
    val crlf = buffer.indexOf("\r\n\r\n")
    val lf = buffer.indexOf("\n\n")
    return when {
      crlf == -1 && lf == -1 -> null
      crlf == -1 -> Boundary(lf, 2)
      lf == -1 -> Boundary(crlf, 4)
      crlf < lf -> Boundary(crlf, 4)
      else -> Boundary(lf, 2)
    }
  }

  private data class Boundary(val index: Int, val length: Int)

  private fun dataPayload(block: String): String? {
    val lines = mutableListOf<String>()
    for (rawLine in block.split("\n")) {
      val line = rawLine.removeSuffix("\r")
      if (!line.startsWith("data:")) continue
      val value = line.removePrefix("data:")
      // 规范只剥掉冒号后恰好一个可选空格，其余都属于 payload。
      lines.add(if (value.startsWith(" ")) value.removePrefix(" ") else value)
    }
    return if (lines.isEmpty()) null else lines.joinToString("\n")
  }
}
