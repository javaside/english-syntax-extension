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

  @Test
  fun `injection never evaluates strings because the official preview CSP has no unsafe-eval`() {
    // 官方 MarkdownJCEFHtmlPanel 的页面 CSP: script-src 只允许官方静态资源, 不含 'unsafe-eval'。
    // 页面上下文里的 eval(...) / new Function(...) / 动态 <script> 内联都会被 CSP 静默拦截,
    // bundle 一行都执行不了——表现为「点了开始毫无变化」。唯一可靠路径是把 bundle 直接
    // 作为顶层脚本经 executeJavaScript 执行(浏览器 API 级注入, 官方 updateDom 同款)。
    val scripts = mutableListOf<String>()
    val panel = EnglishSyntaxPreviewPanel(transportOverride = HostMessageTransport { scripts += it })
    panel.injectForTest()

    val bootstrap = scripts.joinToString("\n")
    assertTrue(!bootstrap.contains("eval("), "注入脚本不得用 eval(): CSP 会拦, bootstrap=$bootstrap")
    assertTrue(!bootstrap.contains("new Function"), "注入脚本不得用 new Function(): CSP 会拦")
    assertTrue(!bootstrap.contains("<script"), "CSP 无 nonce/unsafe-inline, 动态内联 script 也会被拦")
    assertTrue(bootstrap.contains("__englishSyntaxInitialize"), "bootstrap 后必须触发 initialize")

    panel.dispose()
  }

  @Test
  fun `injection sets the theme flag for role palette selection`() {
    // 角色字色深/浅由 IDEA 主题决定：Kotlin 注入 __englishSyntaxSetTheme 与根 data 属性。
    // 纯协议测试无可用的 UI 上下文，isBright 回退浅色（false），但仍须注入主题设置脚本。
    val scripts = mutableListOf<String>()
    val panel = EnglishSyntaxPreviewPanel(transportOverride = HostMessageTransport { scripts += it })
    panel.injectForTest()

    val all = scripts.joinToString("\n")
    assertTrue(all.contains("__englishSyntaxSetTheme"), "须注入角色色板主题开关: $all")

    panel.dispose()
  }
}
