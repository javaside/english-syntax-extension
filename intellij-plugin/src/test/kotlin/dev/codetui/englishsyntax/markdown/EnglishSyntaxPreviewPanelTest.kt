package dev.codetui.englishsyntax.markdown

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * 包装面板（官方 MarkdownJCEFHtmlPanel 的能力层）纯协议测试：不触碰 JCEF，
 * 用 transportOverride 记录外发脚本、直接投喂页面消息。
 */
class EnglishSyntaxPreviewPanelTest {

  @Test
  fun `rendered event bumps generation and notifies the page`() {
    val scripts = mutableListOf<String>()
    var bumpedTo: Int? = null
    val panel = EnglishSyntaxPreviewPanel(transportOverride = HostMessageTransport { scripts += it })
    panel.onGenerationChanged = { bumpedTo = it }
    assertEquals(0, panel.generation)

    panel.onPageMessage("""{"version":1,"type":"PREVIEW_RENDERED","previewId":"p","generation":0}""")
    assertEquals(1, panel.generation)
    assertEquals(1, bumpedTo)
    assertEquals(1, scripts.size)
    assertTrue(scripts[0].startsWith("window.__englishSyntaxInitialize("))
    assertTrue(scripts[0].contains(", 1)"), "initialize 应带新 generation: ${scripts[0]}")

    panel.dispose()
  }

  @Test
  fun `disposing panel stops dispatch and send throws`() {
    val received = mutableListOf<String>()
    val panel = EnglishSyntaxPreviewPanel(transportOverride = HostMessageTransport { })
    panel.addPageMessageHandler { received += it.toString() }

    panel.onPageMessage("""{"version":1,"type":"PREVIEW_READY","previewId":"p","generation":0}""")
    assertEquals(1, received.size)

    panel.dispose()

    assertTrue(panel.isDisposed())
    // 已释放：处理器不再接收，发送抛错。
    panel.onPageMessage("""{"version":1,"type":"PREVIEW_READY","previewId":"p","generation":0}""")
    assertEquals(1, received.size)
    assertFailsWith<IllegalStateException> {
      panel.send(buildJsonObject { put("type", "RESTORE_ALL") })
    }
  }

  @Test
  fun `preview rendered is not dispatched to regular handlers`() {
    val received = mutableListOf<String>()
    val panel = EnglishSyntaxPreviewPanel(transportOverride = HostMessageTransport { })
    panel.addPageMessageHandler { received += it.toString() }

    panel.onPageMessage("""{"version":1,"type":"PREVIEW_RENDERED","previewId":"p","generation":0}""")
    assertEquals(0, received.size)

    panel.dispose()
  }

  @Test
  fun `malformed page messages are dropped`() {
    val received = mutableListOf<String>()
    val panel = EnglishSyntaxPreviewPanel(transportOverride = HostMessageTransport { })
    panel.addPageMessageHandler { received += it.toString() }

    // 夹带凭据、未知类型、缺字段——一律丢弃。
    panel.onPageMessage("""{"version":1,"type":"PREVIEW_READY","previewId":"p","generation":0,"apiKey":"x"}""")
    panel.onPageMessage("""{"version":1,"type":"NOPE","previewId":"p","generation":0}""")
    panel.onPageMessage("""{"version":1,"type":"PREVIEW_READY","previewId":"p"}""")
    panel.onPageMessage("not json")
    assertEquals(0, received.size)

    panel.dispose()
  }

  @Test
  fun `outbound message is a fixed global entry call with json payload`() {
    val scripts = mutableListOf<String>()
    val panel = EnglishSyntaxPreviewPanel(transportOverride = HostMessageTransport { scripts += it })

    panel.send(buildJsonObject { put("type", "SESSION_STATE"); put("state", "running") })
    assertEquals(1, scripts.size)
    assertTrue(scripts[0].startsWith("window.__englishSyntaxMessage("))
    assertTrue(scripts[0].endsWith(");"))

    panel.dispose()
    assertTrue(panel.isDisposed())
  }
}
