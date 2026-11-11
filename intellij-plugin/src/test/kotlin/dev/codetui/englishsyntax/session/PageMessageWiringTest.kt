package dev.codetui.englishsyntax.session

import dev.codetui.englishsyntax.markdown.EnglishSyntaxPreviewPanel
import dev.codetui.englishsyntax.markdown.HostMessageTransport
import dev.codetui.englishsyntax.analysis.AnalysisServicePort
import dev.codetui.englishsyntax.analysis.CoreBatchOutcome
import dev.codetui.englishsyntax.analysis.DetailOutcome
import dev.codetui.englishsyntax.domain.CoreAnalysis
import dev.codetui.englishsyntax.domain.CoreComponent
import dev.codetui.englishsyntax.domain.DetailAnalysis
import dev.codetui.englishsyntax.domain.GrammarRole
import dev.codetui.englishsyntax.domain.SentenceInput
import dev.codetui.englishsyntax.domain.TokenRange
import dev.codetui.englishsyntax.scheduler.SchedulerPriority
import dev.codetui.englishsyntax.settings.JsonSchemaSupport
import dev.codetui.englishsyntax.settings.ModelProfile
import dev.codetui.englishsyntax.analysis.StreamedComponentSink
import dev.codetui.englishsyntax.analysis.StreamedStructureSink
import dev.codetui.englishsyntax.analysis.StreamedTextSink
import dev.codetui.englishsyntax.model.ChatTurn
import com.intellij.openapi.util.Disposer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * JS → Kotlin 消息接线回归：模拟预览页回传 VISIBLE_BLOCKS / DETAIL_REQUEST /
 * RETRY_SENTENCE（走 Panel.onPageMessage 桥接入口 + Action 的接线函数），
 * 断言它们真正驱动会话——曾经接线缺失导致一切页面消息无消费者，
 * 「翻译时一点变化都没有」，且无任何报错。
 *
 * 这里用 NoopAnalysisPort（永远无结果），断言只看「消息驱动了会话状态」，
 * 不依赖模型返回。
 */
class PageMessageWiringTest {

  /** 假端口：默认无结果（原 Noop 语义），chat / cancelDocument 记录调用供接线断言。 */
  private class NoopAnalysisPort : AnalysisServicePort {
    var chatCalls = 0
    var lastChatConversationId: String? = null
    var lastChatQuestion: String? = null
    var chatPushes: List<String> = emptyList()
    var chatAnswer = ""
    val cancelledDocuments = mutableListOf<String>()

    override suspend fun analyzeCore(
      profile: ModelProfile,
      documentId: String,
      sentences: List<SentenceInput>,
      priority: SchedulerPriority,
      bypassCache: Boolean,
      onStreamedComponent: StreamedComponentSink?,
    ): CoreBatchOutcome = CoreBatchOutcome(emptyList(), emptyList(), cacheHit = false)

    override suspend fun lookupCore(sentences: List<SentenceInput>): List<CoreAnalysis> = emptyList()

    override suspend fun analyzeDetail(
      profile: ModelProfile,
      documentId: String,
      sentence: SentenceInput,
      core: CoreAnalysis,
      focus: TokenRange,
      onStreamedStructure: StreamedStructureSink?,
    ): DetailOutcome = DetailOutcome(
      DetailAnalysis(sentence.sentenceId, focus, emptyList(), emptyList(), "", profile.id),
      cacheHit = false,
    )

    override suspend fun lookupDetail(sentence: SentenceInput, focus: TokenRange): DetailAnalysis? = null

    override suspend fun chat(
      profile: ModelProfile,
      documentId: String,
      conversationId: String,
      input: SentenceInput,
      core: CoreAnalysis,
      history: List<ChatTurn>,
      question: String,
      onStreamedText: StreamedTextSink?,
    ): String {
      chatCalls += 1
      lastChatConversationId = conversationId
      lastChatQuestion = question
      onStreamedText?.let { sink -> chatPushes.forEach { sink.onText(it) } }
      return chatAnswer
    }

    override suspend fun cancelDocument(documentId: String) {
      cancelledDocuments += documentId
    }
  }

  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
  private lateinit var manager: PreviewSessionManager
  private lateinit var port: NoopAnalysisPort
  private lateinit var panel: EnglishSyntaxPreviewPanel
  private val sentScripts = mutableListOf<String>()

  @BeforeTest
  fun setUp() {
    port = NoopAnalysisPort()
    manager = PreviewSessionManager(scope, port, { null })
    panel = EnglishSyntaxPreviewPanel(transportOverride = HostMessageTransport { sentScripts += it })
  }

  @AfterTest
  fun tearDown() {
    manager.disposeAll()
    scope.cancel()
    panel.dispose()
  }

  @Test
  fun `visible blocks from the page drive the session`() = runBlocking {
    PreviewSessionConnector.start(panel, manager)

    panel.onPageMessage(
      """{"version":1,"type":"VISIBLE_BLOCKS","previewId":"${panel.previewId}","generation":${panel.generation},"blocks":[{"blockId":"b1","text":"The service validates every response today."}]}""",
    )
    delay(150)

    val session = manager.session(panel.previewId)
    assertNotNull(session, "Start 接线后必须存在会话")
    assertEquals(1, session.counts.discovered, "VISIBLE_BLOCKS 必须注册进会话（曾因无消费者而归零）")
  }

  @Test
  fun `detail request from the page does not throw`() = runBlocking {
    PreviewSessionConnector.start(panel, manager)
    panel.onPageMessage(
      """{"version":1,"type":"VISIBLE_BLOCKS","previewId":"${panel.previewId}","generation":${panel.generation},"blocks":[{"blockId":"b1","text":"The service validates every response today."}]}""",
    )
    delay(150)

    panel.onPageMessage(
      """{"version":1,"type":"DETAIL_REQUEST","previewId":"${panel.previewId}","generation":${panel.generation},"sentenceId":"s-b1-0","focus":{"startToken":0,"endToken":2}}""",
    )
    delay(100)
    assertTrue(manager.session(panel.previewId) != null)
  }

  @Test
  fun `parse block from the page lightweight-starts the session and registers only that block`() = runBlocking {
    PreviewSessionConnector.parseHovered(panel, manager)
    assertEquals(false, panel.autoScan, "按段解析不得打开自动扫描（否则整篇被翻译）")

    panel.onPageMessage(
      """{"version":1,"type":"PARSE_BLOCK","previewId":"${panel.previewId}","generation":${panel.generation},"blockId":"b1","text":"The service validates every response today."}""",
    )
    delay(150)

    val session = manager.session(panel.previewId)
    assertNotNull(session, "parseHovered 接线后必须存在会话")
    assertEquals(SessionState.RUNNING, session.state, "冷启动应轻量启动会话")
    assertEquals(1, session.counts.discovered, "PARSE_BLOCK 必须注册进会话")
  }

  @Test
  fun `start opens auto scan for whole-document sessions`() {
    PreviewSessionConnector.start(panel, manager)
    assertEquals(true, panel.autoScan, "整篇会话必须允许 JS 自动上报全文块")
  }

  @Test
  fun `chat ask from the page streams and settles through the bridge`() = runBlocking {
    // 有 profile 的接线：CHAT_ASK 过桥白名单 → connector 派发 → session 上下文重建 →
    // CHAT_STREAM/CHAT_RESULT 沿 HostSender 回到页面通道。
    port.chatPushes = listOf("回答的", "前半段")
    port.chatAnswer = "完整回答"
    val profile = ModelProfile(
      id = "p1", name = "test", baseUrl = "https://api.example.com/v1", model = "m",
      headerNames = emptySet(), timeoutMs = 30_000, jsonSchemaSupport = JsonSchemaSupport.UNKNOWN,
    )
    val chatManager = PreviewSessionManager(scope, port, { profile })
    PreviewSessionConnector.start(panel, chatManager)

    panel.onPageMessage(
      """{"version":1,"type":"VISIBLE_BLOCKS","previewId":"${panel.previewId}","generation":${panel.generation},"blocks":[{"blockId":"b1","text":"The service validates every response today."}]}""",
    )
    delay(150)
    val session = chatManager.session(panel.previewId) ?: error("no session")
    session.applyOutcome(
      CoreBatchOutcome(
        listOf(
          CoreAnalysis(
            sentenceId = "s-b1-0",
            components = listOf(CoreComponent(0, 1, GrammarRole.SUBJECT, "该服务")),
            modelProfileId = "p1",
          ),
        ),
        emptyList(),
        cacheHit = false,
      ),
    )

    panel.onPageMessage(
      """{"version":1,"type":"CHAT_ASK","previewId":"${panel.previewId}","generation":${panel.generation},"conversationId":"${panel.previewId}:chat:1","sentenceId":"s-b1-0","history":[{"role":"user","content":"上一轮问题"}],"question":"这个短语修饰谁?"}""",
    )
    delay(150)

    assertEquals(1, port.chatCalls, "CHAT_ASK 必须真正派发到会话（Task 1 曾是 Unit 占位）")
    assertEquals("${panel.previewId}:chat:1", port.lastChatConversationId)
    assertEquals("这个短语修饰谁?", port.lastChatQuestion)
    assertTrue(sentScripts.any { it.contains("CHAT_STREAM") && it.contains("前半段") }, "流式分片要回到页面通道")
    assertTrue(sentScripts.any { it.contains("CHAT_RESULT") && it.contains("完整回答") }, "最终全文要回到页面通道")
    assertTrue(sentScripts.none { it.contains("CHAT_ERROR") }, "成功路径不得夹带 CHAT_ERROR")
  }

  @Test
  fun `disposing the preview panel routes to manager disposal and cancels the chat namespace`() = runBlocking {
    // 面板关闭 → 会话回收：EnglishSyntaxPreviewPanel.dispose() 此前不通知 manager，
    // disposePreview 没有生产调用方。Disposer 接线后「预览关走」必须真正触发回收。
    val disposalPort = NoopAnalysisPort()
    val unconfined = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
    try {
      val disposalManager = PreviewSessionManager(unconfined, disposalPort, { null })
      PreviewSessionConnector.connect(panel, disposalManager)
      val chatNamespace = "${panel.previewId}-doc:chat"

      Disposer.dispose(panel)

      assertTrue(chatNamespace in disposalPort.cancelledDocuments, "面板关闭必须取消 chat 命名空间（经 manager 长命 scope）")
      assertEquals(null, disposalManager.session(panel.previewId), "会话必须随面板释放")
    } finally {
      unconfined.cancel()
    }
  }
}
