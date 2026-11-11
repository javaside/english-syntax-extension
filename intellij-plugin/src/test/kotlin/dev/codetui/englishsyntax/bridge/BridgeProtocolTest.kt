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

  private fun parseHost(text: String) = BridgeProtocol.parseHostMessage(Json.parseToJsonElement(text).jsonObject)

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

  // ---- CHAT_ASK：IntelliJ 没有第二层路由，桥的 parse case 就是防伪造门，上限全部结构化 ----

  private fun chatAskJson(
    conversationId: String = "p1:chat:1",
    sentenceId: String = "s-b1-0",
    history: String = """[{"role":"user","content":"上一轮问题"},{"role":"assistant","content":"上一轮回答"}]""",
    question: String = "这个 of 短语修饰谁?",
  ): String =
    """{"version":1,"type":"CHAT_ASK","previewId":"p1","generation":2,"conversationId":"$conversationId","sentenceId":"$sentenceId","history":$history,"question":"$question"}"""

  @Test
  fun `accepts chat ask within caps and trims the question`() {
    val message = parse(chatAskJson(question = "  这个 of 短语修饰谁?  ")) as PageMessage.ChatAsk
    assertEquals("p1", message.previewId)
    assertEquals(2, message.generation)
    assertEquals("p1:chat:1", message.conversationId)
    assertEquals("s-b1-0", message.sentenceId)
    assertEquals(2, message.history.size)
    assertEquals("user", message.history[0].role)
    assertEquals("上一轮问题", message.history[0].content)
    assertEquals("这个 of 短语修饰谁?", message.question)
  }

  @Test
  fun `accepts chat ask with empty history for the first turn`() {
    val message = parse(chatAskJson(history = "[]")) as PageMessage.ChatAsk
    assertEquals(0, message.history.size)
  }

  @Test
  fun `rejects chat ask with blank or oversized question`() {
    assertNull(parse(chatAskJson(question = "")))
    assertNull(parse(chatAskJson(question = "   ")))
    assertNull(parse(chatAskJson(question = "x".repeat(BridgeProtocol.MAX_CHAT_QUESTION_CHARACTERS + 1))))
    // 原文带空白超长但 trim 后在上限内：合法——上限按 trim 后文本计。
    val padded = "  " + "x".repeat(BridgeProtocol.MAX_CHAT_QUESTION_CHARACTERS) + "  "
    val message = parse(chatAskJson(question = padded)) as PageMessage.ChatAsk
    assertEquals(BridgeProtocol.MAX_CHAT_QUESTION_CHARACTERS, message.question.length)
  }

  @Test
  fun `rejects chat ask with more than six history turns`() {
    val seven = (1..7).joinToString(",") { """{"role":"user","content":"q$it"}""" }
    assertNull(parse(chatAskJson(history = "[$seven]")))
    val six = (1..6).joinToString(",") { """{"role":"user","content":"q$it"}""" }
    assertNotNull(parse(chatAskJson(history = "[$six]")) as PageMessage.ChatAsk)
  }

  @Test
  fun `rejects chat ask whose history exceeds the character budget`() {
    val big = "x".repeat(2_700)
    val over = (1..3).joinToString(",") { """{"role":"user","content":"$big"}""" }
    assertNull(parse(chatAskJson(history = "[$over]")))
    // 恰好 8000 字符：合法
    val half = "x".repeat(4_000)
    val message =
      parse(chatAskJson(history = """[{"role":"user","content":"$half"},{"role":"assistant","content":"$half"}]""")) as
        PageMessage.ChatAsk
    assertEquals(BridgeProtocol.MAX_CHAT_HISTORY_CHARACTERS, message.history.sumOf { it.content.length })
  }

  @Test
  fun `rejects chat ask with invalid history shape`() {
    // role 不在枚举
    assertNull(parse(chatAskJson(history = """[{"role":"system","content":"hi"}]""")))
    // content 纯空白
    assertNull(parse(chatAskJson(history = """[{"role":"user","content":"   "}]""")))
    // turn 多余键
    assertNull(parse(chatAskJson(history = """[{"role":"user","content":"hi","extra":1}]""")))
    // history 非数组
    assertNull(parse(chatAskJson(history = """{"role":"user","content":"hi"}""")))
  }

  @Test
  fun `rejects chat ask carrying credentials or missing envelope fields`() {
    // forbiddenKeys：CHAT_ASK 同样照拦
    assertNull(
      parse(
        """{"version":1,"type":"CHAT_ASK","previewId":"p1","generation":2,"conversationId":"c1","sentenceId":"s1","history":[],"question":"q","apiKey":"leak"}""",
      ),
    )
    // 缺 conversationId
    assertNull(
      parse(
        """{"version":1,"type":"CHAT_ASK","previewId":"p1","generation":2,"sentenceId":"s1","history":[],"question":"q"}""",
      ),
    )
    // conversationId / sentenceId 为空
    assertNull(parse(chatAskJson(conversationId = "")))
    assertNull(parse(chatAskJson(sentenceId = "")))
    // 方向混淆：页面伪造的 CHAT_RESULT 不是合法 page 消息
    assertNull(
      parse("""{"version":1,"type":"CHAT_RESULT","previewId":"p1","generation":2,"conversationId":"c","answer":"a"}"""),
    )
  }

  @Test
  fun `chat host messages parse with generation and conversationId`() {
    val stream = parseHost(
      """{"version":1,"type":"CHAT_STREAM","previewId":"p1","generation":3,"conversationId":"p1:chat:1","text":"回答的第一段"}""",
    ) as HostMessage.ChatStream
    assertEquals(3, stream.generation)
    assertEquals("p1:chat:1", stream.conversationId)
    assertEquals("回答的第一段", stream.text)

    val result = parseHost(
      """{"version":1,"type":"CHAT_RESULT","previewId":"p1","generation":3,"conversationId":"p1:chat:1","answer":"完整回答"}""",
    ) as HostMessage.ChatResult
    assertEquals(3, result.generation)
    assertEquals("p1:chat:1", result.conversationId)
    assertEquals("完整回答", result.answer)

    val error = parseHost(
      """{"version":1,"type":"CHAT_ERROR","previewId":"p1","generation":3,"conversationId":"p1:chat:1","message":"原句已失效：请重新解析后再提问"}""",
    ) as HostMessage.ChatError
    assertEquals(3, error.generation)
    assertEquals("p1:chat:1", error.conversationId)
    assertEquals("原句已失效：请重新解析后再提问", error.message)
  }

  @Test
  fun `rejects malformed chat host messages`() {
    // 缺 conversationId
    assertNull(parseHost("""{"version":1,"type":"CHAT_STREAM","previewId":"p1","generation":0,"text":"t"}"""))
    // conversationId 为空
    assertNull(parseHost("""{"version":1,"type":"CHAT_ERROR","previewId":"p1","generation":0,"conversationId":"","message":"m"}"""))
    // 多余键
    assertNull(parseHost("""{"version":1,"type":"CHAT_RESULT","previewId":"p1","generation":0,"conversationId":"c","answer":"a","extra":1}"""))
    // answer 非字符串
    assertNull(parseHost("""{"version":1,"type":"CHAT_RESULT","previewId":"p1","generation":0,"conversationId":"c","answer":7}"""))
    // 方向混淆：host 侧不存在 CHAT_ASK
    assertNull(
      parseHost(
        """{"version":1,"type":"CHAT_ASK","previewId":"p1","generation":0,"conversationId":"c","sentenceId":"s","history":[],"question":"q"}""",
      ),
    )
  }
}
