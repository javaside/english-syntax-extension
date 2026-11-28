package dev.codetui.englishsyntax.bridge

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject

/** JS → Kotlin 的封闭消息集合。 */
sealed interface PageMessage {
  val previewId: String
  val generation: Int

  data class PreviewReady(
    override val previewId: String,
    override val generation: Int,
  ) : PageMessage

  data class VisibleBlocks(
    override val previewId: String,
    override val generation: Int,
    val blocks: List<BlockText>,
  ) : PageMessage {
    data class BlockText(val blockId: String, val text: String)
  }

  data class DetailRequest(
    override val previewId: String,
    override val generation: Int,
    val sentenceId: String,
    val focusStart: Int,
    val focusEnd: Int,
  ) : PageMessage

  data class RetrySentence(
    override val previewId: String,
    override val generation: Int,
    val sentenceId: String,
  ) : PageMessage

  /** 官方 Markdown 预览整体重渲染（updateDom 重写了 body,插件卡片被清掉）。 */
  data class PreviewRendered(
    override val previewId: String,
    override val generation: Int,
  ) : PageMessage

  /**
   * 显式手势：JS 已经把段落定位好了，只解析这一段（快捷键悬停解析）。
   * 与 [VisibleBlocks] 分开是有意的——后者是自动扫描的批量上报，前者是用户手势，
   * 优先级、合批与暂停语义都不同。
   */
  data class ParseBlock(
    override val previewId: String,
    override val generation: Int,
    val blockId: String,
    val text: String,
  ) : PageMessage

  /**
   * 追问对话（JS→Kotlin）：基于该句已核实分析继续多轮提问。句子锚点上下文不过桥——
   * Kotlin 侧从 SentenceRecord 重建（input + core）；surroundings 是可选的段落级
   * 参考上下文（本段 + 前后邻段原文，web 侧按封顶截断后过桥，桥门只校验不改写）。
   * 桥是唯一防伪造门（IntelliJ 没有 Chrome 式 content 路由第二层），history
   * 数量/字符上限与 question 的 trim 1..2000、surroundings 各键封顶全部在
   * [BridgeProtocol] 的 parse 里结构化校验。
   */
  data class ChatAsk(
    override val previewId: String,
    override val generation: Int,
    val conversationId: String,
    val sentenceId: String,
    val history: List<ChatTurn>,
    val question: String,
    val surroundings: ChatSurroundings?,
  ) : PageMessage {
    /** 一轮历史：用户提问或模型回答（不含 system——系统指令由 Kotlin 侧拼）。 */
    data class ChatTurn(val role: String, val content: String)

    /**
     * 段落级参考上下文：提问句所在段（current）与前后段（before/after）的原文。
     * 三键全部可选，但 parse 门要求至少一键在场；值由 web 侧计算时已封顶截断
     * （… 标记计入上限），过桥只校验不改写。与 web/bridge.ts 的 `ChatSurroundings`
     * 镜像；与 model 层的 `ChatSurroundings` 分立——沿用 [ChatTurn] 的桥/模型分层
     * 先例，connector 做映射。
     */
    data class ChatSurroundings(val before: String?, val current: String?, val after: String?)
  }

  /**
   * 纠正反馈（JS→Kotlin，F2）：对已核实划分的一次性纠正请求。结果不是新消息——
   * 成功复用 CORE_RESULT（blockId = 句所在块），失败回 [HostMessage.FeedbackError]。
   * feedback 的 trim 1..2000 防伪造门与 CHAT_ASK 的 question 同款（结构化进 parse）。
   */
  data class FeedbackRequest(
    override val previewId: String,
    override val generation: Int,
    val sentenceId: String,
    val feedback: String,
  ) : PageMessage

  /** 朗读一句/一个成分（JS→Kotlin）：text 为 trim 后 1..[MAX_TTS_TEXT_CHARACTERS]。 */
  data class TtsSpeak(
    override val previewId: String,
    override val generation: Int,
    val sentenceId: String,
    val text: String,
  ) : PageMessage

  /** 停止当前朗读（JS→Kotlin）。 */
  data class TtsStop(
    override val previewId: String,
    override val generation: Int,
  ) : PageMessage
}

/** Kotlin → JS 的封闭消息集合。 */
sealed interface HostMessage {
  val previewId: String
  val generation: Int

  data class SessionState(
    override val previewId: String,
    override val generation: Int,
    val state: String,
    val ready: Int,
    val discovered: Int,
  ) : HostMessage

  data class CoreStream(
    override val previewId: String,
    override val generation: Int,
    val sentenceId: String,
    val blockId: String,
    val componentsJson: String,
    val tokensJson: String,
  ) : HostMessage

  data class CoreResult(
    override val previewId: String,
    override val generation: Int,
    val sentenceId: String,
    val blockId: String,
    val analysisJson: String,
    val tokensJson: String,
  ) : HostMessage

  data class CoreError(
    override val previewId: String,
    override val generation: Int,
    val sentenceId: String,
    val blockId: String,
    val code: String,
    val message: String,
    val tokensJson: String,
  ) : HostMessage

  data class DetailStream(
    override val previewId: String,
    override val generation: Int,
    val sentenceId: String,
    val focusStart: Int,
    val focusEnd: Int,
    val structuresJson: String,
  ) : HostMessage

  data class DetailResult(
    override val previewId: String,
    override val generation: Int,
    val sentenceId: String,
    val analysisJson: String,
  ) : HostMessage

  data class RestoreAll(
    override val previewId: String,
    override val generation: Int,
  ) : HostMessage

  /** 追问对话的流式分片：text 是「截至目前的完整回答」而非增量——全量替换渲染，调度器静默重试无害。 */
  data class ChatStream(
    override val previewId: String,
    override val generation: Int,
    val conversationId: String,
    val text: String,
  ) : HostMessage

  /** 追问对话的最终全文（以缓冲答案为准收尾，防流式尾片丢失）。 */
  data class ChatResult(
    override val previewId: String,
    override val generation: Int,
    val conversationId: String,
    val answer: String,
  ) : HostMessage

  /** 追问对话失败（无 profile / 请求失败 / 原句失效）：人类可读文案，无 code 字段（ErrorCode 枚举被 contracts 钉死不加值）。 */
  data class ChatError(
    override val previewId: String,
    override val generation: Int,
    val conversationId: String,
    val message: String,
  ) : HostMessage

  /**
   * 纠正反馈失败（F2）：与 CHAT_ERROR 平行、按 sentenceId 关联（不混淆会话）。
   * 纠正失败**绝不**复用 CORE_ERROR——那会把句卡片打成失败行、抹掉已核实的划分；
   * 错误回内联输入行，人类可读文案（message 按 F1 口径带错误码前缀），无 code 字段。
   */
  data class FeedbackError(
    override val previewId: String,
    override val generation: Int,
    val sentenceId: String,
    val message: String,
  ) : HostMessage

  /** 朗读失败（命令不存在/进程异常）：复位该句按下态并提示，无 code 字段。 */
  data class TtsError(
    override val previewId: String,
    override val generation: Int,
    val sentenceId: String,
    val message: String,
  ) : HostMessage
}

/**
 * JCEF 被视为不可信来源：每条消息按类型做键白名单 + 字段守卫，
 * 任何多余键、非法值、越界数量都拒绝（返回 null），未知 JSON 绝不透传。
 */
object BridgeProtocol {
  const val VERSION = 1
  // 一次扫描即上报全文所有英文段（整页翻译）。长文档可达上百段，50 上限会丢弃
  // 整条 VISIBLE_BLOCKS（真机症状：转圈显示「正在解析 N 段」但一张卡片都不出）。
  // 提到 2000 容纳整页全量，同时保留对异常超长消息的防护。
  const val MAX_BLOCKS = 2000
  const val MAX_BLOCK_TEXT = 20_000

  // 追问对话入站上限（与 Chrome 版面板/SW 双层上限同值）：JCEF 页面可直接 post，
  // 桥是唯一校验门，数量/长度上限必须结构化进 parse，不能只靠上游 UI 自律。
  const val MAX_CHAT_HISTORY_TURNS = 6
  const val MAX_CHAT_HISTORY_CHARACTERS = 8000
  const val MAX_CHAT_QUESTION_CHARACTERS = 2000

  // 追问对话段落上下文封顶（与 web/bridge.ts 同步；Chrome protocol.ts 同值，五处同值
  // 见 Chrome 端注释）：current 是提问句所在段、预算最大，before/after 是相邻参考段、
  // 预算依次收紧。… 截断标记计入各自上限——门按裸 length ≤ cap 判，不做标记感知；
  // 值原样透传不 trim（web 侧计算时已封顶，门只兜底把关）。
  const val MAX_CHAT_SURROUNDING_BEFORE_CHARS = 1200
  const val MAX_CHAT_SURROUNDING_CURRENT_CHARS = 4000
  const val MAX_CHAT_SURROUNDING_AFTER_CHARS = 800

  // 纠正反馈入站上限（与 CHAT_ASK 的 question 同值同款）：trim 后 1..2000。
  const val MAX_FEEDBACK_CHARACTERS = 2000

  // 朗读文本入站上限（与 web/bridge.ts 的 MAX_TTS_TEXT_CHARACTERS 同步；feedback/question 同值同款）。
  const val MAX_TTS_TEXT_CHARACTERS = 2000

  private val forbiddenKeys = setOf("apiKey", "headers", "baseUrl")

  // JS `String.prototype.trim()` 的显式字符类（与 Segmenter/AnalysisValidator 的
  // jsWhitespaceClass 同一集合）：JVM 的 String.trim/isBlank 会多剥 U+001C–U+001F、
  // 漏剥 U+FEFF，与 web/bridge.ts 的 .trim() 分叉——桥是两端一致的防伪造门，
  // 「什么算空白」必须两端同答案（NBSP 两端恰好都命中，真正分叉的是 FEFF 与 001C–001F）。
  private const val JS_WHITESPACE_CLASS =
    "\\u0009-\\u000d\\u0020\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff"
  private val chatTrimPattern = Regex("^[${JS_WHITESPACE_CLASS}]+|[${JS_WHITESPACE_CLASS}]+\\z")

  /** 与 JS `.trim()` 同一字符集的裁剪；CHAT_ASK 门里所有 trim / 空白判断都走它。 */
  internal fun trimJsWhitespace(text: String): String = chatTrimPattern.replace(text, "")

  fun parsePageMessage(value: JsonObject): PageMessage? {
    // 公共键先做类型级白名单之外的提取；每类型的具体键白名单在各自分支里校验。
    if (value.int("version") != VERSION) return null
    val previewId = value.string("previewId")?.takeIf { it.isNotEmpty() } ?: return null
    val generation = value.int("generation") ?: return null
    if (generation < 0) return null
    if (value.keys.any { it in forbiddenKeys }) return null

    return when (value.string("type")) {
      "PREVIEW_READY" -> {
        if (!hasOnlyKeys(value, "version", "type", "previewId", "generation")) return null
        PageMessage.PreviewReady(previewId, generation)
      }

      "VISIBLE_BLOCKS" -> parseVisibleBlocks(value, previewId, generation)

      "DETAIL_REQUEST" -> {
        if (!hasOnlyKeys(value, "version", "type", "previewId", "generation", "sentenceId", "focus")) return null
        val sentenceId = value.string("sentenceId")?.takeIf { it.isNotEmpty() } ?: return null
        val focus = value["focus"] as? JsonObject ?: return null
        if (!hasOnlyKeys(focus, "startToken", "endToken")) return null
        val start = focus.int("startToken") ?: return null
        val end = focus.int("endToken") ?: return null
        if (start < 0 || end < start) return null
        PageMessage.DetailRequest(previewId, generation, sentenceId, start, end)
      }

      "RETRY_SENTENCE" -> {
        if (!hasOnlyKeys(value, "version", "type", "previewId", "generation", "sentenceId")) return null
        val sentenceId = value.string("sentenceId")?.takeIf { it.isNotEmpty() } ?: return null
        PageMessage.RetrySentence(previewId, generation, sentenceId)
      }

      "PREVIEW_RENDERED" -> {
        if (!hasOnlyKeys(value, "version", "type", "previewId", "generation")) return null
        PageMessage.PreviewRendered(previewId, generation)
      }

      "PARSE_BLOCK" -> {
        if (!hasOnlyKeys(value, "version", "type", "previewId", "generation", "blockId", "text")) return null
        val blockId = value.string("blockId")?.takeIf { it.isNotEmpty() } ?: return null
        val text = value.string("text") ?: return null
        if (text.length > MAX_BLOCK_TEXT) return null
        PageMessage.ParseBlock(previewId, generation, blockId, text)
      }

      "CHAT_ASK" -> parseChatAsk(value, previewId, generation)
      "TTS_SPEAK" -> parseTtsSpeak(value, previewId, generation)
      "TTS_STOP" -> parseTtsStop(value, previewId, generation)

      "FEEDBACK_REQUEST" -> parseFeedbackRequest(value, previewId, generation)

      else -> null
    }
  }

  private fun parseVisibleBlocks(value: JsonObject, previewId: String, generation: Int): PageMessage.VisibleBlocks? {
    if (!hasOnlyKeys(value, "version", "type", "previewId", "generation", "blocks")) return null
    val blocks = value["blocks"] as? JsonArray ?: return null
    if (blocks.size > MAX_BLOCKS) return null
    val parsed = blocks.map { block ->
      val blockObject = block as? JsonObject ?: return null
      if (!hasOnlyKeys(blockObject, "blockId", "text")) return null
      val blockId = blockObject.string("blockId")?.takeIf { it.isNotEmpty() } ?: return null
      val text = blockObject.string("text") ?: return null
      if (text.length > MAX_BLOCK_TEXT) return null
      PageMessage.VisibleBlocks.BlockText(blockId, text)
    }
    return PageMessage.VisibleBlocks(previewId, generation, parsed)
  }

  /**
   * CHAT_ASK 的防伪造门：Chrome 版由 content 路由（形状）+ SW（数量）双层把关，
   * IntelliJ 的 JCEF 页面可直接 post，这里合并为唯一一层——形状与上限都判。
   */
  private fun parseChatAsk(value: JsonObject, previewId: String, generation: Int): PageMessage.ChatAsk? {
    if (!hasOnlyKeys(value, "version", "type", "previewId", "generation", "conversationId", "sentenceId", "history", "question", "surroundings")) return null
    val conversationId = value.string("conversationId")?.takeIf { it.isNotEmpty() } ?: return null
    val sentenceId = value.string("sentenceId")?.takeIf { it.isNotEmpty() } ?: return null
    val history = value["history"] as? JsonArray ?: return null
    if (history.size > MAX_CHAT_HISTORY_TURNS) return null
    var historyCharacters = 0
    val turns = history.map { item ->
      val turn = item as? JsonObject ?: return null
      if (!hasOnlyKeys(turn, "role", "content")) return null
      val role = turn.string("role") ?: return null
      if (role != "user" && role != "assistant") return null
      val content = turn.string("content") ?: return null
      // 空白判断走 JS 显式字符类（trimJsWhitespace），与 web/bridge.ts 的 content.trim() 同答案。
      if (trimJsWhitespace(content).isEmpty()) return null
      historyCharacters += content.length
      if (historyCharacters > MAX_CHAT_HISTORY_CHARACTERS) return null
      PageMessage.ChatAsk.ChatTurn(role, content)
    }
    // trim 在门里做掉（Chrome SW 同款）：下游拿到的就是规范化文本，1..2000 按 trim 后计。
    // 裁剪字符集与 JS `.trim()` 逐字符一致（U+FEFF 算空白、U+001C–U+001F 不算）。
    val question = trimJsWhitespace(value.string("question") ?: return null)
    if (question.isEmpty() || question.length > MAX_CHAT_QUESTION_CHARACTERS) return null
    // 段落上下文门（与 web/bridge.ts 的 surroundings 分支镜像）：键在场但解析被拒 →
    // 整条拒收；键缺席 → null 下发（无上下文，合法）。
    val rawSurroundings = value["surroundings"]
    val surroundings = parseChatSurroundings(rawSurroundings)
    if (rawSurroundings != null && surroundings == null) return null
    return PageMessage.ChatAsk(previewId, generation, conversationId, sentenceId, turns, question, surroundings)
  }

  /**
   * CHAT_ASK 的段落上下文门（与 web/bridge.ts parse 的 surroundings 分支镜像）：
   * 键缺席 → null（无上下文，合法）；在场 → 须为 JsonObject、键集恰为
   * before/current/after 的子集且至少一键在场、每个在场键为 string 且
   * trimJsWhitespace 后非空、长度 ≤ 对应 [MAX_CHAT_SURROUNDING_BEFORE_CHARS] 等封顶
   * （… 截断标记计入上限，裸长度判）——违规返回 null，调用方以「键在场但结果为
   * null」整条拒收。值原样透传不 trim：surroundings 是 web 侧算好的已封顶文本，
   * question 在门里 trim 的做法刻意不复制——机器输出只校验，用户输入才规范化。
   * 空白判断走 [trimJsWhitespace]，与 JS `.trim()` 同一字符集。
   */
  private fun parseChatSurroundings(element: JsonElement?): PageMessage.ChatAsk.ChatSurroundings? {
    if (element == null) return null
    val raw = element as? JsonObject ?: return null
    if (!hasOnlyKeys(raw, "before", "current", "after")) return null
    var before: String? = null
    var current: String? = null
    var after: String? = null
    if ("before" in raw) {
      before = raw.string("before") ?: return null
      if (trimJsWhitespace(before).isEmpty() || before.length > MAX_CHAT_SURROUNDING_BEFORE_CHARS) return null
    }
    if ("current" in raw) {
      current = raw.string("current") ?: return null
      if (trimJsWhitespace(current).isEmpty() || current.length > MAX_CHAT_SURROUNDING_CURRENT_CHARS) return null
    }
    if ("after" in raw) {
      after = raw.string("after") ?: return null
      if (trimJsWhitespace(after).isEmpty() || after.length > MAX_CHAT_SURROUNDING_AFTER_CHARS) return null
    }
    // 空对象（零键）与三键全缺没有上下文意义——照 web 端同款拒收。
    if (before == null && current == null && after == null) return null
    return PageMessage.ChatAsk.ChatSurroundings(before, current, after)
  }

  /**
   * FEEDBACK_REQUEST 的防伪造门（CHAT_ASK question 同款）：键白名单 + sentenceId 非空 +
   * feedback trim 后 1..2000。trim 同样走 [trimJsWhitespace]（与 web/bridge.ts 的 .trim()
   * 同一字符集——桥是两端一致的门，「什么算空白」必须两端同答案）。
   */
  private fun parseFeedbackRequest(value: JsonObject, previewId: String, generation: Int): PageMessage.FeedbackRequest? {
    if (!hasOnlyKeys(value, "version", "type", "previewId", "generation", "sentenceId", "feedback")) return null
    val sentenceId = value.string("sentenceId")?.takeIf { it.isNotEmpty() } ?: return null
    val feedback = trimJsWhitespace(value.string("feedback") ?: return null)
    if (feedback.isEmpty() || feedback.length > MAX_FEEDBACK_CHARACTERS) return null
    return PageMessage.FeedbackRequest(previewId, generation, sentenceId, feedback)
  }

  /**
   * TTS_SPEAK 的防伪造门（feedback 同款）：六键白名单 + sentenceId 非空 +
   * text trim 后 1..2000（trimJsWhitespace 与 JS .trim() 同一字符集）。
   */
  private fun parseTtsSpeak(value: JsonObject, previewId: String, generation: Int): PageMessage.TtsSpeak? {
    if (!hasOnlyKeys(value, "version", "type", "previewId", "generation", "sentenceId", "text")) return null
    val sentenceId = value.string("sentenceId")?.takeIf { it.isNotEmpty() } ?: return null
    val text = trimJsWhitespace(value.string("text") ?: return null)
    if (text.isEmpty() || text.length > MAX_TTS_TEXT_CHARACTERS) return null
    return PageMessage.TtsSpeak(previewId, generation, sentenceId, text)
  }

  private fun parseTtsStop(value: JsonObject, previewId: String, generation: Int): PageMessage.TtsStop? {
    if (!hasOnlyKeys(value, "version", "type", "previewId", "generation")) return null
    return PageMessage.TtsStop(previewId, generation)
  }

  /** Kotlin → JS 侧同样守卫：host 消息也可能被篡改后回注，generation 必须非负。 */
  fun parseHostMessage(value: JsonObject): HostMessage? {
    val previewId = value.string("previewId")?.takeIf { it.isNotEmpty() } ?: return null
    val generation = value.int("generation") ?: return null
    if (generation < 0) return null
    return when (value.string("type")) {
      "SESSION_STATE" -> {
        if (!hasOnlyKeys(value, "version", "type", "previewId", "generation", "state", "ready", "discovered", "failed")) return null
        HostMessage.SessionState(
          previewId, generation,
          value.string("state") ?: return null,
          value.int("ready") ?: return null,
          value.int("discovered") ?: return null,
        )
      }
      "CORE_STREAM", "CORE_RESULT" -> {
        val type = value.string("type") ?: return null
        val sentenceKey = if (type == "CORE_STREAM") "componentsJson" else "analysisJson"
        if (!hasOnlyKeys(value, "version", "type", "previewId", "generation", "sentenceId", "blockId", sentenceKey, "tokensJson")) return null
        val sentenceId = value.string("sentenceId")?.takeIf { it.isNotEmpty() } ?: return null
        val blockId = value.string("blockId")?.takeIf { it.isNotEmpty() } ?: return null
        val payload = value.string(sentenceKey) ?: return null
        val tokensJson = value.string("tokensJson") ?: return null
        if (type == "CORE_STREAM") HostMessage.CoreStream(previewId, generation, sentenceId, blockId, payload, tokensJson)
        else HostMessage.CoreResult(previewId, generation, sentenceId, blockId, payload, tokensJson)
      }
      "DETAIL_RESULT" -> {
        if (!hasOnlyKeys(value, "version", "type", "previewId", "generation", "sentenceId", "analysisJson")) return null
        val sentenceId = value.string("sentenceId")?.takeIf { it.isNotEmpty() } ?: return null
        HostMessage.DetailResult(previewId, generation, sentenceId, value.string("analysisJson") ?: return null)
      }
      "DETAIL_STREAM" -> {
        if (!hasOnlyKeys(value, "version", "type", "previewId", "generation", "sentenceId", "focusStart", "focusEnd", "structuresJson")) return null
        val sentenceId = value.string("sentenceId")?.takeIf { it.isNotEmpty() } ?: return null
        val focusStart = value.int("focusStart") ?: return null
        val focusEnd = value.int("focusEnd") ?: return null
        if (focusStart < 0 || focusEnd < focusStart) return null
        HostMessage.DetailStream(previewId, generation, sentenceId, focusStart, focusEnd, value.string("structuresJson") ?: return null)
      }
      "CORE_ERROR" -> {
        if (!hasOnlyKeys(value, "version", "type", "previewId", "generation", "sentenceId", "blockId", "code", "message", "tokensJson")) return null
        val sentenceId = value.string("sentenceId")?.takeIf { it.isNotEmpty() } ?: return null
        val blockId = value.string("blockId")?.takeIf { it.isNotEmpty() } ?: return null
        HostMessage.CoreError(
          previewId, generation, sentenceId, blockId,
          value.string("code") ?: return null,
          value.string("message") ?: return null,
          value.string("tokensJson") ?: return null,
        )
      }
      "RESTORE_ALL" -> {
        if (!hasOnlyKeys(value, "version", "type", "previewId", "generation")) return null
        HostMessage.RestoreAll(previewId, generation)
      }
      "CHAT_STREAM" -> {
        if (!hasOnlyKeys(value, "version", "type", "previewId", "generation", "conversationId", "text")) return null
        val conversationId = value.string("conversationId")?.takeIf { it.isNotEmpty() } ?: return null
        HostMessage.ChatStream(previewId, generation, conversationId, value.string("text") ?: return null)
      }
      "CHAT_RESULT" -> {
        if (!hasOnlyKeys(value, "version", "type", "previewId", "generation", "conversationId", "answer")) return null
        val conversationId = value.string("conversationId")?.takeIf { it.isNotEmpty() } ?: return null
        HostMessage.ChatResult(previewId, generation, conversationId, value.string("answer") ?: return null)
      }
      "CHAT_ERROR" -> {
        if (!hasOnlyKeys(value, "version", "type", "previewId", "generation", "conversationId", "message")) return null
        val conversationId = value.string("conversationId")?.takeIf { it.isNotEmpty() } ?: return null
        HostMessage.ChatError(previewId, generation, conversationId, value.string("message") ?: return null)
      }
      "FEEDBACK_ERROR" -> {
        if (!hasOnlyKeys(value, "version", "type", "previewId", "generation", "sentenceId", "message")) return null
        val sentenceId = value.string("sentenceId")?.takeIf { it.isNotEmpty() } ?: return null
        HostMessage.FeedbackError(previewId, generation, sentenceId, value.string("message") ?: return null)
      }
      "TTS_ERROR" -> {
        if (!hasOnlyKeys(value, "version", "type", "previewId", "generation", "sentenceId", "message")) return null
        val sentenceId = value.string("sentenceId")?.takeIf { it.isNotEmpty() } ?: return null
        HostMessage.TtsError(previewId, generation, sentenceId, value.string("message") ?: return null)
      }
      else -> null
    }
  }

  private fun hasOnlyKeys(value: JsonObject, vararg allowed: String?): Boolean {
    val allowedSet = allowed.filterNotNull().toSet()
    return value.keys.all { it in allowedSet }
  }

  private fun JsonObject.string(key: String): String? =
    (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

  private fun JsonObject.int(key: String): Int? {
    val primitive = (this[key] as? JsonPrimitive) ?: return null
    if (primitive.isString) return null
    return primitive.content.toIntOrNull()
  }
}
