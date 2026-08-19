package dev.codetui.englishsyntax.session

import dev.codetui.englishsyntax.analysis.AnalysisFailure
import dev.codetui.englishsyntax.analysis.AnalysisServicePort
import dev.codetui.englishsyntax.analysis.CoreBatchOutcome
import dev.codetui.englishsyntax.analysis.DetailOutcome
import dev.codetui.englishsyntax.domain.CoreAnalysis
import dev.codetui.englishsyntax.domain.CoreComponent
import dev.codetui.englishsyntax.domain.DetailAnalysis
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
