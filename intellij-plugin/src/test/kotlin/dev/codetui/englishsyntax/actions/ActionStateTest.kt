package dev.codetui.englishsyntax.actions

import dev.codetui.englishsyntax.analysis.AnalysisServicePort
import dev.codetui.englishsyntax.analysis.CoreBatchOutcome
import dev.codetui.englishsyntax.analysis.DetailOutcome
import dev.codetui.englishsyntax.bridge.HotkeyDescriptor
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

  @Test
  fun `hover parse availability only depends on file type and runtime`() {
    // 冷启动、RUNNING、PAUSED 都应可按——所以签名里刻意没有 session/panel 参数：
    // Action 的 update() 一旦去 findPanel 就会 wrap + 注入 JCEF，那正是「点开工具菜单
    // 即假翻译」的成因。
    assertTrue(PreviewActionSupport.hoverParseEnabled(isMarkdownFile = true, jcefSupported = true))
    assertFalse(PreviewActionSupport.hoverParseEnabled(isMarkdownFile = false, jcefSupported = true))
    assertFalse(PreviewActionSupport.hoverParseEnabled(isMarkdownFile = true, jcefSupported = false))
  }

  @Test
  fun `plugin xml registers the hover parse action with the default alt T shortcut`() {
    // 兼底通道靠这个 id 去 keymap 读实际绑定；id 写歪了就永远拿不到用户改的键位。
    val xml = ActionStateTest::class.java.classLoader
      .getResourceAsStream("META-INF/plugin.xml")!!
      .use { it.readBytes().toString(Charsets.UTF_8) }

    assertTrue(
      xml.contains("id=\"${HotkeyDescriptor.PARSE_HOVERED_BLOCK_ACTION_ID}\""),
      "plugin.xml 的 action id 必须与 HotkeyDescriptor 用来读 keymap 的 id 一致",
    )
    assertTrue(xml.contains("first-keystroke=\"alt T\""), "默认键位应为 Alt+T")
  }
}
