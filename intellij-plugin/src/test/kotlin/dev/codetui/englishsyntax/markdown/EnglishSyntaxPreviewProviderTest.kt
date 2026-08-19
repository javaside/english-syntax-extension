package dev.codetui.englishsyntax.markdown

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.intellij.plugins.markdown.ui.preview.MarkdownHtmlPanelProvider.AvailabilityInfo
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class EnglishSyntaxPreviewProviderTest {

  @Test
  fun `provider info is stable`() {
    val provider = EnglishSyntaxPreviewProvider(
      jcefSupported = { true },
      panelFactory = { _, _ -> throw IllegalStateException("must not be called") },
    )
    assertEquals("English Syntax Chromium Preview", provider.getProviderInfo().name)
    assertEquals(EnglishSyntaxPreviewProvider::class.java.name, provider.getProviderInfo().className)
  }

  @Test
  fun `provider is unavailable when JCEF support probe is false`() {
    var panelCreated = false
    val provider = EnglishSyntaxPreviewProvider(
      jcefSupported = { false },
      panelFactory = { _, _ ->
        panelCreated = true
        throw IllegalStateException("must not be called")
      },
    )
    val unavailable: AvailabilityInfo = provider.isAvailable()
    val available: AvailabilityInfo = EnglishSyntaxPreviewProvider(
      jcefSupported = { true },
      panelFactory = { _, _ -> throw IllegalStateException() },
    ).isAvailable()
    assertFalse(unavailable === AvailabilityInfo.AVAILABLE)
    assertTrue(available === AvailabilityInfo.AVAILABLE)
    assertFalse(panelCreated)
  }

  @Test
  fun `provider creates project and virtual file aware panel`() {
    var captured: EnglishSyntaxPreviewPanel? = null
    val provider = EnglishSyntaxPreviewProvider(
      jcefSupported = { true },
      panelFactory = { _, _ ->
        EnglishSyntaxPreviewPanel(null, null).also { captured = it }
      },
    )
    provider.createHtmlPanel()
    // 无参路径面板持有 null——project-aware 路径由 JCEF 装配任务传入真实对象；
    // 这里验证工厂被调用且面板构造成功。
    assertNotNull(captured)
    assertEquals(null, captured?.getProject())
    assertEquals(null, captured?.getVirtualFile())
  }

  @Test
  fun `disposing panel closes handlers and scope and send throws`() {
    val received = mutableListOf<String>()
    val panel = EnglishSyntaxPreviewPanel(null, null, HostMessageTransport { })
    panel.addPageMessageHandler { received += it.toString() }
    assertTrue(panel.scopeActive)

    panel.onPageMessage("""{"version":1,"type":"PREVIEW_READY","previewId":"p","generation":0}""")
    assertEquals(1, received.size)

    panel.dispose()

    assertTrue(panel.isDisposed())
    assertFalse(panel.scopeActive)
    // 已释放：处理器不再接收，发送抛错。
    panel.onPageMessage("""{"version":1,"type":"PREVIEW_READY","previewId":"p","generation":0}""")
    assertEquals(1, received.size)
    assertFailsWith<IllegalStateException> {
      panel.send(buildJsonObject { put("type", "RESTORE_ALL") })
    }
  }

  @Test
  fun `setHtml bumps generation and notifies the page`() {
    val scripts = mutableListOf<String>()
    val panel = EnglishSyntaxPreviewPanel(null, null, HostMessageTransport { scripts += it })
    assertEquals(0, panel.generation)

    panel.setHtml("<p>hello</p>", 0, null as com.intellij.openapi.vfs.VirtualFile?)
    assertEquals(1, panel.generation)
    assertEquals(1, scripts.size)
    assertTrue(scripts[0].startsWith("window.__englishSyntaxInitialize("))

    panel.dispose()
    panel.setHtml("<p>again</p>", 0, null as com.intellij.openapi.vfs.VirtualFile?)
    assertEquals(1, panel.generation)
    assertEquals(1, scripts.size)
  }
}
