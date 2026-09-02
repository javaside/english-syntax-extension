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
    val blocks = (1..2000).joinToString(",") { """{"blockId":"b$it","text":"Block $it text"}""" }
    val message = parse(
      """{"version":1,"type":"VISIBLE_BLOCKS","previewId":"p1","generation":1,"blocks":[$blocks]}""",
    ) as PageMessage.VisibleBlocks
    assertEquals(2000, message.blocks.size)
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
  fun `rejects more than max blocks`() {
    val blocks = (1..2001).joinToString(",") { """{"blockId":"b$it","text":"x"}""" }
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

  @Test
  fun `core result carries blockId`() {
    val message = BridgeProtocol.parseHostMessage(
      Json.parseToJsonElement(
        """{"version":1,"type":"CORE_RESULT","previewId":"p1","generation":0,"sentenceId":"s-b1-0","blockId":"b1","analysisJson":"{}","tokensJson":"[]"}""",
      ).jsonObject,
    )
    val core = message as HostMessage.CoreResult
    assertEquals("s-b1-0", core.sentenceId)
    assertEquals("b1", core.blockId)
  }

  @Test
  fun `core error carries source tokens`() {
    val message = BridgeProtocol.parseHostMessage(
      Json.parseToJsonElement(
        """{"version":1,"type":"CORE_ERROR","previewId":"p1","generation":0,"sentenceId":"s-b1-0","blockId":"b1","code":"INVALID_MODEL_OUTPUT","message":"invalid","tokensJson":"[]"}""",
      ).jsonObject,
    ) as HostMessage.CoreError

    assertEquals("[]", message.tokensJson)
  }

  @Test
  fun `core result without blockId is rejected`() {
    val message = BridgeProtocol.parseHostMessage(
      Json.parseToJsonElement(
        """{"version":1,"type":"CORE_RESULT","previewId":"p1","generation":0,"sentenceId":"s1","analysisJson":"{}"}""",
      ).jsonObject,
    )
    assertNull(message)
  }

  @Test
  fun `detail result parses without blockId`() {
    val message = BridgeProtocol.parseHostMessage(
      Json.parseToJsonElement(
        """{"version":1,"type":"DETAIL_RESULT","previewId":"p1","generation":0,"sentenceId":"s1","analysisJson":"{}"}""",
      ).jsonObject,
    )
    assertNotNull(message as HostMessage.DetailResult)
  }

  @Test
  fun `accepts parse block for the hotkey path`() {
    val message = parse(
      """{"version":1,"type":"PARSE_BLOCK","previewId":"p1","generation":2,"blockId":"b7","text":"Short line."}""",
    ) as PageMessage.ParseBlock
    assertEquals("p1", message.previewId)
    assertEquals(2, message.generation)
    assertEquals("b7", message.blockId)
    assertEquals("Short line.", message.text)
  }

  @Test
  fun `rejects parse block with extra or missing fields`() {
    // 多余键
    assertNull(
      parse(
        """{"version":1,"type":"PARSE_BLOCK","previewId":"p1","generation":0,"blockId":"b1","text":"t","target":"body"}""",
      ),
    )
    // 空 blockId
    assertNull(
      parse("""{"version":1,"type":"PARSE_BLOCK","previewId":"p1","generation":0,"blockId":"","text":"t"}"""),
    )
    // 缺 text
    assertNull(parse("""{"version":1,"type":"PARSE_BLOCK","previewId":"p1","generation":0,"blockId":"b1"}"""))
    // 夹带凭据
    assertNull(
      parse(
        """{"version":1,"type":"PARSE_BLOCK","previewId":"p1","generation":0,"blockId":"b1","text":"t","apiKey":"leak"}""",
      ),
    )
  }

  @Test
  fun `rejects parse block whose text exceeds the block limit`() {
    val huge = "a".repeat(BridgeProtocol.MAX_BLOCK_TEXT + 1)
    assertNull(
      parse("""{"version":1,"type":"PARSE_BLOCK","previewId":"p1","generation":0,"blockId":"b1","text":"$huge"}"""),
    )
  }
}
