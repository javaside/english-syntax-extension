package dev.codetui.englishsyntax.actions

import dev.codetui.englishsyntax.analysis.AnalysisServicePort
import dev.codetui.englishsyntax.analysis.CoreBatchOutcome
import dev.codetui.englishsyntax.analysis.DetailOutcome
import dev.codetui.englishsyntax.domain.CoreAnalysis
import dev.codetui.englishsyntax.domain.DetailAnalysis
import dev.codetui.englishsyntax.domain.SentenceInput
import dev.codetui.englishsyntax.domain.TokenRange
import dev.codetui.englishsyntax.session.HostSender
import dev.codetui.englishsyntax.session.PreviewSessionManager
import dev.codetui.englishsyntax.session.SessionState
import dev.codetui.englishsyntax.settings.JsonSchemaSupport
import dev.codetui.englishsyntax.settings.ModelProfile
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.serialization.json.JsonObject
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ActionStateTest {

  private object NoopService : AnalysisServicePort {
    override suspend fun analyzeCore(
      profile: ModelProfile,
      documentId: String,
      sentences: List<SentenceInput>,
      priority: dev.codetui.englishsyntax.scheduler.SchedulerPriority,
      bypassCache: Boolean,
      onStreamedComponent: dev.codetui.englishsyntax.analysis.StreamedComponentSink?,
    ): CoreBatchOutcome = CoreBatchOutcome(emptyList(), emptyList(), cacheHit = false)

    override suspend fun lookupCore(sentences: List<SentenceInput>): List<CoreAnalysis> = emptyList()

    override suspend fun analyzeDetail(
      profile: ModelProfile,
      documentId: String,
      sentence: SentenceInput,
      core: CoreAnalysis,
      focus: TokenRange,
      onStreamedStructure: dev.codetui.englishsyntax.analysis.StreamedStructureSink?,
    ): DetailOutcome = DetailOutcome(
      DetailAnalysis(sentence.sentenceId, focus, emptyList(), emptyList(), "", profile.id),
      cacheHit = false,
    )

    override suspend fun lookupDetail(sentence: SentenceInput, focus: TokenRange): DetailAnalysis? = null

    override suspend fun cancelDocument(documentId: String) {}
  }

  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
  private lateinit var manager: PreviewSessionManager
  private val sender = object : HostSender {
    override fun send(json: JsonObject) {}
  }

  @BeforeTest
  fun setUp() {
    manager = PreviewSessionManager(scope, NoopService, { null })
  }

  @AfterTest
  fun tearDown() {
    manager.disposeAll()
    scope.cancel()
  }

  @Test
  fun `no session means only start is available`() {
    val availability = PreviewActionSupport.availability(null)
    assertTrue(availability.startEnabled)
    assertFalse(availability.pauseEnabled)
    assertFalse(availability.stopEnabled)
  }

  @Test
  fun `stopped session re-enables start only`() {
    val session = manager.obtain("pv1", sender) {}
    session.start()
    session.stop()
    val availability = PreviewActionSupport.availability(session)
    assertTrue(availability.startEnabled)
    assertFalse(availability.pauseEnabled)
    assertFalse(availability.stopEnabled)
  }

  @Test
  fun `running session enables pause and stop`() {
    val session = manager.obtain("pv1", sender) {}
    session.start()
    val availability = PreviewActionSupport.availability(session)
    assertFalse(availability.startEnabled)
    assertTrue(availability.pauseEnabled)
    assertTrue(availability.stopEnabled)
  }

  @Test
  fun `paused session shows resume text`() {
    val session = manager.obtain("pv1", sender) {}
    session.start()
    session.pause()
    assertEquals(SessionState.PAUSED, session.state)
    assertEquals("继续", PreviewActionSupport.togglePauseText(session.state))
    assertEquals("暂停", PreviewActionSupport.togglePauseText(SessionState.RUNNING))
  }

  @Test
  fun `progress text reflects counts and pause`() {
    val session = manager.obtain("pv1", sender) {}
    session.start()
    val running = PreviewActionSupport.progressText(manager, "pv1")
    assertTrue(running.startsWith("句法学习：0/0"))

    session.pause()
    val paused = PreviewActionSupport.progressText(manager, "pv1")
    assertTrue(paused.contains("已暂停"))
  }

  @Test
  fun `missing preview yields empty progress text`() {
    assertEquals("", PreviewActionSupport.progressText(manager, "missing"))
  }

  @Test
  fun `dispose releases the active preview`() {
    manager.start("pv2", sender) {}
    manager.disposePreview("pv2")
    assertNull(manager.activePreviewId)
    assertNull(manager.session("pv2"))
  }
}
