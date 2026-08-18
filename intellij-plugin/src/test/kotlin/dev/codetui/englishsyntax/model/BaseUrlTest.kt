package dev.codetui.englishsyntax.model

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class BaseUrlTest {
  @Test
  fun `normalizes a trailing slash from an HTTPS base URL`() {
    assertEquals("https://api.deepseek.com/v1", normalizeBaseUrl("https://api.deepseek.com/v1/"))
  }

  @Test
  fun `appends the chat completions endpoint`() {
    assertEquals(
      "https://api.deepseek.com/v1/chat/completions",
      chatCompletionsUrl("https://api.deepseek.com/v1"),
    )
  }

  @Test
  fun `does not append a duplicate chat completions endpoint`() {
    assertEquals(
      "http://localhost:11434/v1/chat/completions",
      chatCompletionsUrl("http://localhost:11434/v1/chat/completions"),
    )
  }

  @Test
  fun `allows a local HTTP model endpoint`() {
    assertEquals("http://localhost:11434/v1", normalizeBaseUrl("http://localhost:11434/v1"))
    assertEquals("http://127.0.0.1:11434/v1", normalizeBaseUrl("http://127.0.0.1:11434/v1"))
  }

  @Test
  fun `rejects remote HTTP model endpoints`() {
    val error = assertFailsWith<IllegalArgumentException> {
      normalizeBaseUrl("http://api.example.com/v1")
    }
    assertTrue(error.message.orEmpty().contains("HTTPS"))
  }

  @Test
  fun `rejects embedded URL credentials`() {
    val error = assertFailsWith<IllegalArgumentException> {
      normalizeBaseUrl("https://user:pass@example.com/v1")
    }
    assertTrue(error.message.orEmpty().contains("credentials"))
  }

  @Test
  fun `rejects query strings and fragments`() {
    listOf(
      "https://api.example.com/v1?",
      "https://api.example.com/v1?tenant=syntax",
      "https://api.example.com/v1#",
      "https://api.example.com/v1#syntax",
    ).forEach { baseUrl ->
      assertFailsWith<IllegalArgumentException>(baseUrl) { normalizeBaseUrl(baseUrl) }
      assertFailsWith<IllegalArgumentException>(baseUrl) { chatCompletionsUrl(baseUrl) }
    }
  }

  @Test
  fun `normalizes scheme and host case and strips default ports`() {
    assertEquals("https://api.example.com/v1", normalizeBaseUrl("HTTPS://API.EXAMPLE.COM/v1"))
    assertEquals("https://api.example.com/v1", normalizeBaseUrl("https://api.example.com:443/v1"))
    assertEquals("http://localhost/v1", normalizeBaseUrl("http://localhost:80/v1"))
  }

  @Test
  fun `rejects a URL without a host`() {
    assertFailsWith<IllegalArgumentException> { normalizeBaseUrl("https:///path") }
  }

  @Test
  fun `isLoopbackBaseUrl distinguishes local from remote and tolerates malformed input`() {
    assertTrue(isLoopbackBaseUrl("http://localhost:11434/v1"))
    assertTrue(isLoopbackBaseUrl("http://127.0.0.1:1234/v1"))
    assertFalse(isLoopbackBaseUrl("https://api.deepseek.com"))
    assertFalse(isLoopbackBaseUrl("https://api.openai.com/v1"))
    assertFalse(isLoopbackBaseUrl("not a url"))
  }
}
