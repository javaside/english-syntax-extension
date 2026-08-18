package dev.codetui.englishsyntax.model

import kotlin.test.Test
import kotlin.test.assertEquals

class SseDecoderTest {
  @Test
  fun `returns the payload of a complete event`() {
    val decoder = SseDecoder()
    assertEquals(listOf("""{"a":1}"""), decoder.push("data: {\"a\":1}\n\n"))
  }

  @Test
  fun `holds an event back until its terminating blank line arrives`() {
    val decoder = SseDecoder()
    assertEquals(emptyList(), decoder.push("data: {\"a\":"))
    assertEquals(emptyList(), decoder.push("1}"))
    assertEquals(listOf("""{"a":1}"""), decoder.push("\n\n"))
  }

  @Test
  fun `joins multiple data lines of one event with newlines`() {
    val decoder = SseDecoder()
    assertEquals(listOf("first\nsecond"), decoder.push("data: first\ndata: second\n\n"))
  }

  @Test
  fun `accepts CRLF line endings`() {
    val decoder = SseDecoder()
    assertEquals(listOf("value"), decoder.push("data: value\r\n\r\n"))
  }

  @Test
  fun `ignores comments and non-data fields`() {
    val decoder = SseDecoder()
    assertEquals(listOf("value"), decoder.push(": keep-alive\nevent: message\nid: 7\ndata: value\n\n"))
  }

  @Test
  fun `keeps a data payload that itself contains a colon and leading spaces`() {
    val decoder = SseDecoder()
    assertEquals(listOf("""{"url":"https://x"}"""), decoder.push("data: {\"url\":\"https://x\"}\n\n"))
  }

  @Test
  fun `surfaces the terminator so the caller can stop reading`() {
    val decoder = SseDecoder()
    assertEquals(listOf(SSE_DONE), decoder.push("data: $SSE_DONE\n\n"))
  }

  @Test
  fun `returns several events that arrive in one chunk in order`() {
    val decoder = SseDecoder()
    assertEquals(
      listOf("one", "two", "three"),
      decoder.push("data: one\n\ndata: two\n\ndata: three\n\n"),
    )
  }

  @Test
  fun `drops an event that carries no data field`() {
    val decoder = SseDecoder()
    assertEquals(listOf("real"), decoder.push("event: ping\n\ndata: real\n\n"))
  }
}
