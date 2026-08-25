package dev.codetui.englishsyntax.session

import dev.codetui.englishsyntax.markdown.EnglishSyntaxPreviewPanel
import dev.codetui.englishsyntax.markdown.HostMessageTransport
import dev.codetui.englishsyntax.analysis.AnalysisServicePort
import dev.codetui.englishsyntax.analysis.CoreBatchOutcome
import dev.codetui.englishsyntax.analysis.DetailOutcome
import dev.codetui.englishsyntax.domain.CoreAnalysis
import dev.codetui.englishsyntax.domain.DetailAnalysis
import dev.codetui.englishsyntax.domain.SentenceInput
import dev.codetui.englishsyntax.domain.TokenRange
import dev.codetui.englishsyntax.scheduler.SchedulerPriority
import dev.codetui.englishsyntax.settings.ModelProfile
import dev.codetui.englishsyntax.analysis.StreamedComponentSink
import dev.codetui.englishsyntax.analysis.StreamedStructureSink
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

  /** 永不返回结果的假端口：本测试只断言「消息驱动了会话」，不依赖模型返回。 */
  private object NoopAnalysisPort : AnalysisServicePort {
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

    override suspend fun cancelDocument(documentId: String) {}
  }

  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
  private lateinit var manager: PreviewSessionManager
  private lateinit var panel: EnglishSyntaxPreviewPanel
  private val sentScripts = mutableListOf<String>()

  @BeforeTest
  fun setUp() {
    manager = PreviewSessionManager(scope, NoopAnalysisPort, { null })
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
}
