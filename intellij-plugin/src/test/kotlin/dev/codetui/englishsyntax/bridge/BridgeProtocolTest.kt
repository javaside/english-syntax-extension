package dev.codetui.englishsyntax.bridge

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class BridgeProtocolTest {
  private fun parse(text: String) = BridgeProtocol.parsePageMessage(Json.parseToJsonElement(text).jsonObject)

  @Test
  fun `accepts minimal preview ready`() {
    val message = parse("""{"version":1,"type":"PREVIEW_READY","previewId":"p1","generation":0}""")
    assertNotNull(message)
    assertEquals("p1", message.previewId)
    assertEquals(0, message.generation)
  }

  @Test
  fun `accepts visible blocks within limits`() {
    val blocks = (1..50).joinToString(",") { """{"blockId":"b$it","text":"Block $it text"}""" }
    val message = parse(
      """{"version":1,"type":"VISIBLE_BLOCKS","previewId":"p1","generation":1,"blocks":[$blocks]}""",
    ) as PageMessage.VisibleBlocks
    assertEquals(50, message.blocks.size)
  }

  @Test
  fun `rejects unknown type`() {
    assertNull(parse("""{"version":1,"type":"HACK","previewId":"p1","generation":0}"""))
  }

  @Test
  fun `rejects extra keys`() {
    assertNull(
      parse(
        """{"version":1,"type":"PREVIEW_READY","previewId":"p1","generation":0,"apiKey":"leak"}""",
      ),
    )
    assertNull(
      parse(
        """{"version":1,"type":"PREVIEW_READY","previewId":"p1","generation":0,"headers":{}}""",
      ),
    )
    assertNull(
      parse(
        """{"version":1,"type":"PREVIEW_READY","previewId":"p1","generation":0,"baseUrl":"https://evil"}""",
      ),
    )
  }

  @Test
  fun `rejects wrong version`() {
    assertNull(parse("""{"version":2,"type":"PREVIEW_READY","previewId":"p1","generation":0}"""))
  }

  @Test
  fun `rejects blank previewId`() {
    assertNull(parse("""{"version":1,"type":"PREVIEW_READY","previewId":"","generation":0}"""))
  }

  @Test
  fun `rejects negative generation`() {
    assertNull(parse("""{"version":1,"type":"PREVIEW_READY","previewId":"p1","generation":-1}"""))
  }

  @Test
  fun `rejects more than fifty blocks`() {
    val blocks = (1..51).joinToString(",") { """{"blockId":"b$it","text":"x"}""" }
    assertNull(
      parse("""{"version":1,"type":"VISIBLE_BLOCKS","previewId":"p1","generation":0,"blocks":[$blocks]}"""),
    )
  }

  @Test
  fun `rejects block text over twenty thousand chars`() {
    val longText = "x".repeat(20_001)
    assertNull(
      parse(
        """{"version":1,"type":"VISIBLE_BLOCKS","previewId":"p1","generation":0,"blocks":[{"blockId":"b","text":"$longText"}]}""",
      ),
    )
  }

  @Test
  fun `rejects detail request with negative or reversed focus`() {
    assertNull(
      parse(
        """{"version":1,"type":"DETAIL_REQUEST","previewId":"p1","generation":0,"sentenceId":"s1","focus":{"startToken":-1,"endToken":2}}""",
      ),
    )
    assertNull(
      parse(
        """{"version":1,"type":"DETAIL_REQUEST","previewId":"p1","generation":0,"sentenceId":"s1","focus":{"startToken":3,"endToken":2}}""",
      ),
    )
  }

  @Test
  fun `accepts detail request with non-negative closed interval`() {
    val message = parse(
      """{"version":1,"type":"DETAIL_REQUEST","previewId":"p1","generation":0,"sentenceId":"s1","focus":{"startToken":2,"endToken":4}}""",
    ) as PageMessage.DetailRequest
    assertEquals(2, message.focusStart)
    assertEquals(4, message.focusEnd)
  }

  @Test
  fun `accepts retry sentence`() {
    val message = parse(
      """{"version":1,"type":"RETRY_SENTENCE","previewId":"p1","generation":2,"sentenceId":"s1"}""",
    )
    assertNotNull(message as PageMessage.RetrySentence)
  }

  @Test
  fun `host messages parse with the same strictness`() {
    val host = Json.parseToJsonElement(
      """{"version":1,"type":"SESSION_STATE","previewId":"p1","generation":0,"state":"running","ready":3,"discovered":5}""",
    ).jsonObject
    val message = BridgeProtocol.parseHostMessage(host)
    assertNotNull(message as HostMessage.SessionState)
    assertEquals(3, message.ready)

    val hostile = Json.parseToJsonElement(
      """{"version":1,"type":"CORE_RESULT","previewId":"p1","generation":0,"sentenceId":"s1","analysisJson":"{}","extra":true}""",
    ).jsonObject
    assertNull(BridgeProtocol.parseHostMessage(hostile))
  }
}
