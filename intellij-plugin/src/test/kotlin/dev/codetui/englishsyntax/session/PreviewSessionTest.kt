package dev.codetui.englishsyntax.session

import dev.codetui.englishsyntax.analysis.AnalysisFailure
import dev.codetui.englishsyntax.analysis.AnalysisServicePort
import dev.codetui.englishsyntax.analysis.CoreBatchOutcome
import dev.codetui.englishsyntax.analysis.DetailOutcome
import dev.codetui.englishsyntax.domain.CoreAnalysis
import dev.codetui.englishsyntax.domain.CoreComponent
import dev.codetui.englishsyntax.domain.DetailAnalysis
import dev.codetui.englishsyntax.domain.DetailStructure
import dev.codetui.englishsyntax.domain.ErrorCode
import dev.codetui.englishsyntax.domain.ExtensionFailure
import dev.codetui.englishsyntax.domain.GrammarRole
import dev.codetui.englishsyntax.domain.SentenceInput
import dev.codetui.englishsyntax.domain.TokenRange
import dev.codetui.englishsyntax.scheduler.SchedulerPriority
import dev.codetui.englishsyntax.settings.JsonSchemaSupport
import dev.codetui.englishsyntax.settings.ModelProfile
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class PreviewSessionTest {

  private class FakeAnalysisService : AnalysisServicePort {
    var analyzeCalls = 0
    var lastPriority: SchedulerPriority? = null
    var lastSentences: List<SentenceInput> = emptyList()
    var cancelledDocuments = mutableListOf<String>()
    var lookupResults: MutableMap<String, CoreAnalysis> = mutableMapOf()
    var outcome: CoreBatchOutcome = CoreBatchOutcome(emptyList(), emptyList(), cacheHit = false)
    var authFailure = false
    /** 测试注入：analyzeCore 调用前触发一次流式回调（传 null 则不触发）。 */
    var onStreamOnce: ((dev.codetui.englishsyntax.analysis.StreamedComponentSink) -> Unit)? = null
    /** 测试注入：detail 结果（analyzeDetail 直接返回它）。 */
    var detailOutcome: DetailOutcome? = null
    /** 测试注入：analyzeCore 直接抛异常（模拟模型层崩溃，验证会话兜底给终态）。 */
    var throwOnAnalyzeCore = false

    override suspend fun analyzeCore(
      profile: ModelProfile,
      documentId: String,
      sentences: List<SentenceInput>,
      priority: SchedulerPriority,
      bypassCache: Boolean,
      onStreamedComponent: dev.codetui.englishsyntax.analysis.StreamedComponentSink?,
    ): CoreBatchOutcome {
      analyzeCalls += 1
      lastPriority = priority
      lastSentences = sentences
      if (throwOnAnalyzeCore) throw IllegalStateException("model crash")
      onStreamOnce?.let { it(onStreamedComponent!!) }
      onStreamOnce = null
      if (authFailure) {
        return CoreBatchOutcome(
          emptyList(),
          sentences.map { AnalysisFailure(it.sentenceId, ExtensionFailure(ErrorCode.AUTH_FAILED, "auth", false)) },
          cacheHit = false,
        )
      }
      return outcome
    }

    override suspend fun lookupCore(sentences: List<SentenceInput>): List<CoreAnalysis> {
      return sentences.mapNotNull { lookupResults[it.sentenceId] }
    }

    override suspend fun analyzeDetail(
      profile: ModelProfile,
      documentId: String,
      sentence: SentenceInput,
      core: CoreAnalysis,
      focus: TokenRange,
      onStreamedStructure: dev.codetui.englishsyntax.analysis.StreamedStructureSink?,
    ): DetailOutcome {
      detailOutcome?.let { return it }
      val detail = DetailAnalysis(
        sentenceId = sentence.sentenceId,
        focus = focus,
        structures = emptyList(),
        grammarPoints = emptyList(),
        explanation = "ok",
        modelProfileId = profile.id,
      )
      return DetailOutcome(detail, cacheHit = false)
    }

    override suspend fun lookupDetail(sentence: SentenceInput, focus: TokenRange): DetailAnalysis? = null

    override suspend fun cancelDocument(documentId: String) {
      cancelledDocuments += documentId
    }
  }

  private class RecordingSender : HostSender {
    val sent = mutableListOf<JsonObject>()
    override fun send(json: JsonObject) {
      sent += json
    }

    fun of(type: String): List<JsonObject> = sent.filter { it["type"]?.jsonPrimitive?.contentOrNull == type }
  }

  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
  private lateinit var service: FakeAnalysisService
  private lateinit var manager: PreviewSessionManager
  private lateinit var sender: RecordingSender
  private var scanRequests = 0

  private val profile = ModelProfile(
    id = "p1",
    name = "test",
    baseUrl = "https://api.example.com/v1",
    model = "m",
    headerNames = emptySet(),
    timeoutMs = 30_000,
    jsonSchemaSupport = JsonSchemaSupport.UNKNOWN,
  )

  @BeforeTest
  fun setUp() {
    service = FakeAnalysisService()
    manager = PreviewSessionManager(scope, service, { profile })
    sender = RecordingSender()
    scanRequests = 0
  }

  @AfterTest
  fun tearDown() {
    manager.disposeAll()
    scope.cancel()
  }

  private fun session(): PreviewSession = manager.obtain("pv1", sender) { scanRequests += 1 }

  @Test
  fun `start requests a scan`() {
    val session = session()
    session.start()
    assertEquals(1, scanRequests)
    assertEquals(SessionState.RUNNING, session.state)
  }

  @Test
  fun `visible blocks are batched and dispatched once`() = runBlocking {
    val session = session()
    session.start()
    session.onVisibleBlocks(listOf("b1" to "The service validates every response. Second sentence here too."))

    // 立即 flush（测试不依赖 120ms 窗口）。
    session.flushBatch(offscreen = false)
    kotlinx.coroutines.delay(100)

    assertEquals(1, service.analyzeCalls)
    assertTrue(service.lastSentences.size >= 1)
    assertEquals(SchedulerPriority.ACTIVE_VISIBLE_CORE, service.lastPriority)
  }

  @Test
  fun `repeated visible blocks after ready do not redispatch`() = runBlocking {
    // 防环守卫：渲染也是 DOM 变更，会再次触发 rescan → 重复的 VISIBLE_BLOCKS。
    // READY 句绝不能被重置重派——否则缓存命中 → CORE_RESULT → 再渲染 → 无限循环（CPU 狂转）。
    val session = session()
    session.start()
    val blocks = listOf("b1" to "The service validates every response carefully today.")
    // 让第一轮派发真正产出 READY 句
    service.outcome = CoreBatchOutcome(
      listOf(
        CoreAnalysis(
          sentenceId = "s-b1-0",
          components = listOf(CoreComponent(0, 1, GrammarRole.SUBJECT, "该服务")),
          modelProfileId = "p1",
        ),
      ),
      emptyList(),
      cacheHit = false,
    )
    session.onVisibleBlocks(blocks)
    session.flushBatch(offscreen = false)
    kotlinx.coroutines.delay(100)
    assertEquals(1, service.analyzeCalls)
    assertEquals(SentencePhase.READY, session.sentences["s-b1-0"]?.phase)

    // 模拟渲染后重复上报同一批块
    session.onVisibleBlocks(blocks)
    session.onVisibleBlocks(blocks)
    kotlinx.coroutines.delay(100)

    assertEquals(1, service.analyzeCalls, "READY 句重复上报不得再次派发模型请求")
    assertEquals(SentencePhase.READY, session.sentences["s-b1-0"]?.phase)
  }

  @Test
  fun `dispatch wires the stream sink and forwards streamed components as CORE_STREAM`() = runBlocking {
    // 流式接线守卫：曾漏传 onStreamedComponent → 全程非流式，等整批返回才渲染
    // （真机症状：翻译很慢、页面不动、没有进度）。
    val session = session()
    session.start()
    session.onVisibleBlocks(listOf("b1" to "The service validates every response carefully today."))

    // FakeAnalysisService 在 analyzeCore 里触发流式回调
    service.onStreamOnce = { sink ->
      sink.accept(
        "s-b1-0",
        listOf(CoreComponent(0, 1, GrammarRole.SUBJECT, "该服务")),
      )
    }
    session.flushBatch(offscreen = false)
    kotlinx.coroutines.delay(100)

    val streams = sender.of("CORE_STREAM")
    assertTrue(streams.isNotEmpty(), "dispatch 必须接流式 sink 并回推 CORE_STREAM")
    val payload = streams.first()["componentsJson"]?.jsonPrimitive?.contentOrNull ?: error("no payload")
    assertTrue(payload.contains("\"role\":\"SUBJECT\""), "分片要带角色枚举, got: $payload")
    assertTrue(payload.contains("\"text\":\"The service\""), "分片要回填英文原文, got: $payload")
    assertEquals("b1", streams.first()["blockId"]?.jsonPrimitive?.contentOrNull)
  }

  @Test
  fun `component text is backfilled from tokens for the english row`() = runBlocking {
    // 三行对照的英文行依赖 Kotlin 回填 component.text（渲染层不自己分词）。
    val session = session()
    session.start()
    session.onVisibleBlocks(listOf("b1" to "The service validates every response carefully today."))
    val first = session.sentences.values.firstOrNull()?.input ?: error("no sentence")
    val analysis = CoreAnalysis(
      sentenceId = first.sentenceId,
      components = listOf(CoreComponent(0, 1, GrammarRole.SUBJECT, "该服务")),
      modelProfileId = "p1",
    )
    val sent = mutableListOf<JsonObject>()
    val sender = object : HostSender {
      override fun send(json: JsonObject) {
        sent += json
      }
    }
    // 直接调用 applyOutcome 需要 sender——通过反射太脆，改走内部路径：构造带 sender 的 session
    val wired = PreviewSessionManager(scope, service, { profile }).obtain("pv-en", sender) { }
    wired.start()
    wired.onVisibleBlocks(listOf("b1" to "The service validates every response carefully today."))
    wired.applyOutcome(CoreBatchOutcome(listOf(analysis), emptyList(), cacheHit = false))

    val result = sent.firstOrNull { it["type"]?.jsonPrimitive?.contentOrNull == "CORE_RESULT" }
    assertNotNull(result)
    val payload = result["analysisJson"]?.jsonPrimitive?.contentOrNull ?: error("no analysisJson")
    assertTrue(payload.contains("\"text\":\"The service\""), "成分英文原文应回填, got: $payload")
  }

  @Test
  fun `detail result backfills english text and grammarPoints`() = runBlocking {
    // 详解最终结果必须回填 structure.text（英文摘录）与 grammarPoints——否则点成分后
    // 完整结果覆盖流式时英文对照与语法点消失（Chrome 端两处都有）。
    val session = session()
    session.start()
    session.onVisibleBlocks(listOf("b1" to "The service validates every response carefully today."))
    val first = session.sentences.values.firstOrNull()?.input ?: error("no sentence")
    val focus = TokenRange(0, 1)
    service.detailOutcome = DetailOutcome(
      DetailAnalysis(
        sentenceId = first.sentenceId,
        focus = focus,
        structures = listOf(
          DetailStructure(startToken = 0, endToken = 1, role = "主语", explanation = "名词短语", translation = "该服务"),
        ),
        grammarPoints = listOf("一般现在时"),
        explanation = "整体说明",
        modelProfileId = "p1",
      ),
      cacheHit = false,
    )
    val sent = mutableListOf<JsonObject>()
    val sender = object : HostSender {
      override fun send(json: JsonObject) {
        sent += json
      }
    }
    val wired = PreviewSessionManager(scope, service, { profile }).obtain("pv-detail", sender) { }
    wired.start()
    wired.onVisibleBlocks(listOf("b1" to "The service validates every response carefully today."))
    wired.launchDetailRequest(first.sentenceId, focus.startToken, focus.endToken)
    kotlinx.coroutines.delay(100)

    val result = sent.firstOrNull { it["type"]?.jsonPrimitive?.contentOrNull == "DETAIL_RESULT" }
    assertNotNull(result, "必须回推 DETAIL_RESULT")
    val payload = result["analysisJson"]?.jsonPrimitive?.contentOrNull ?: error("no analysisJson")
    assertTrue(payload.contains("\"text\":\"The service\""), "详解结构应回填英文摘录, got: $payload")
    assertTrue(payload.contains("\"grammarPoints\":[\"一般现在时\"]"), "详解应带语法点, got: $payload")
  }

  @Test
  fun `pause blocks dispatch and resume replays`() = runBlocking {
    val session = session()
    session.start()
    session.pause()
    session.onVisibleBlocks(listOf("b1" to "The service validates every response carefully today."))
    assertEquals(0, service.analyzeCalls)

    session.resume()
    session.flushBatch(offscreen = false)
    kotlinx.coroutines.delay(100)
    assertEquals(1, service.analyzeCalls)
  }

  @Test
  fun `stop cancels document and sends restore all`() = runBlocking {
    val session = session()
    session.start()
    session.stop()
    kotlinx.coroutines.delay(50)
    assertTrue(service.cancelledDocuments.isNotEmpty())
    assertEquals(1, sender.of("RESTORE_ALL").size)
    assertEquals(SessionState.STOPPED, session.state)
  }

  @Test
  fun `generation change bumps and clears sentences`() = runBlocking {
    val session = session()
    session.start()
    session.onVisibleBlocks(listOf("b1" to "The service validates every response carefully today."))
    session.onGenerationChanged(1)
    kotlinx.coroutines.delay(50)
    assertEquals(0, session.counts.discovered)
    assertTrue(service.cancelledDocuments.isNotEmpty())
  }

  @Test
  fun `dispatch surfaces core error when analyzeCore throws`() = runBlocking {
    // 模型层崩溃（非 ExtensionFailure 异常）不能让句子永远无终态——否则 JS 侧
    // settledBlocks 凑不满、浮层永远「解析中」。会话必须兜底发 CORE_ERROR。
    val session = session()
    session.start()
    session.onVisibleBlocks(listOf("b1" to "The service validates every response carefully today."))
    service.throwOnAnalyzeCore = true
    session.flushBatch(offscreen = false)
    kotlinx.coroutines.delay(100)

    val errors = sender.of("CORE_ERROR")
    assertTrue(errors.isNotEmpty(), "模型崩溃时必须发送 CORE_ERROR 收尾")
    assertEquals(SentencePhase.FAILED, session.sentences.values.firstOrNull()?.phase)
  }

  @Test
  fun `core results are forwarded to the page`() = runBlocking {
    val session = session()
    session.start()
    session.onVisibleBlocks(listOf("b1" to "The service validates every response carefully today."))
    val firstSentence = session.sentences.values.firstOrNull()?.input ?: error("no sentence")
    val analysis = CoreAnalysis(
      sentenceId = firstSentence.sentenceId,
      components = listOf(CoreComponent(0, 1, GrammarRole.SUBJECT, "该服务")),
      modelProfileId = "p1",
    )
    session.applyOutcome(CoreBatchOutcome(listOf(analysis), emptyList(), cacheHit = false))

    val results = sender.of("CORE_RESULT")
    assertEquals(1, results.size)
    assertEquals(firstSentence.sentenceId, results[0]["sentenceId"]?.jsonPrimitive?.contentOrNull)
    assertEquals(SentencePhase.READY, session.sentences[firstSentence.sentenceId]?.phase)
  }

  @Test
  fun `failures are forwarded as core error`() {
    val session = session()
    session.start()
    session.onVisibleBlocks(listOf("b1" to "The service validates every response carefully today."))
    val firstSentence = session.sentences.values.firstOrNull()?.input ?: error("no sentence")
    session.applyOutcome(
      CoreBatchOutcome(
        emptyList(),
        listOf(
          AnalysisFailure(firstSentence.sentenceId, ExtensionFailure(ErrorCode.AUTH_FAILED, "auth", false)),
        ),
        cacheHit = false,
      ),
    )
    assertEquals(1, sender.of("CORE_ERROR").size)
    assertEquals(SentencePhase.FAILED, session.sentences[firstSentence.sentenceId]?.phase)
  }

  @Test
  fun `no profile yields cache only with skipped sentences`() = runBlocking {
    val noProfileManager = PreviewSessionManager(scope, service, { null })
    val localSender = RecordingSender()
    val session = noProfileManager.obtain("pv-none", localSender) { }
    session.start()
    session.onVisibleBlocks(listOf("b1" to "The service validates every response carefully today."))
    session.flushBatch(offscreen = false)
    kotlinx.coroutines.delay(100)

    assertEquals(0, service.analyzeCalls)
    val states = localSender.of("SESSION_STATE")
    assertEquals(1, states.size)
    assertEquals("cacheOnly", states[0]["state"]?.jsonPrimitive?.contentOrNull)
  }

  @Test
  fun `priority maps active offscreen and inactive`() {
    val session = session()
    assertEquals(SchedulerPriority.ACTIVE_VISIBLE_CORE, session.priorityFor(active = true, offscreen = false))
    assertEquals(SchedulerPriority.OTHER_VISIBLE_CORE, session.priorityFor(active = false, offscreen = false))
    assertEquals(SchedulerPriority.ACTIVE_PREFETCH_CORE, session.priorityFor(active = true, offscreen = true))
  }

  @Test
  fun `dispose preview releases the session`() {
    manager.start("pv-x", sender) { }
    manager.disposePreview("pv-x")
    assertEquals(null, manager.session("pv-x"))
    assertEquals(null, manager.activePreviewId)
  }
}
