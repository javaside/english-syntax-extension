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
    assertTrue(scripts[0].contains(", 1, "), "initialize 应带新 generation: ${scripts[0]}")

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

  @Test
  fun `initialize carries the auto scan flag so manual mode never reports the whole document`() {
    // 默认手动模式：只要 findPanel 走过 wrap，注入末尾就会 notifyInitialize——默认自动扫描
    // 会让「点开工具菜单」或按一次快捷键就把整篇文档送去翻译。
    val scripts = mutableListOf<String>()
    val panel = EnglishSyntaxPreviewPanel(transportOverride = HostMessageTransport { scripts += it })

    panel.injectForTest()
    assertTrue(
      scripts.any { it.startsWith("window.__englishSyntaxInitialize(") && it.endsWith(", false);") },
      "默认 autoScan 应为 false: $scripts",
    )

    scripts.clear()
    panel.autoScan = true
    panel.requestScan()
    assertTrue(
      scripts.any { it.startsWith("window.__englishSyntaxInitialize(") && it.endsWith(", true);") },
      "整篇会话应下发 autoScan=true: $scripts",
    )

    panel.dispose()
  }

  @Test
  fun `parse hovered request before injection is deferred and flushed exactly once`() {
    // 冷启动第一次按键：bundle 还没注入，window.__englishSyntaxParseHoveredBlock 不存在，
    // 直接外发会静默丢失这一次按键。
    val scripts = mutableListOf<String>()
    val panel = EnglishSyntaxPreviewPanel(transportOverride = HostMessageTransport { scripts += it })

    panel.requestParseHoveredBlock()
    assertEquals(0, scripts.size, "未注入时不得外发: $scripts")

    panel.injectForTest()
    assertEquals(
      1,
      scripts.count { it.startsWith("window.__englishSyntaxParseHoveredBlock&&") },
      "注入后应补发一次: $scripts",
    )

    scripts.clear()
    panel.injectForTest()
    assertEquals(
      0,
      scripts.count { it.startsWith("window.__englishSyntaxParseHoveredBlock&&") },
      "标记已清，不得重复补发: $scripts",
    )

    panel.dispose()
  }

  @Test
  fun `injection pushes the fallback hotkey descriptor to the page`() {
    // 焦点在 JCEF 里时 IDEA Action 可能收不到按键，页面自带 keydown 兼底——键位要跟 keymap。
    val scripts = mutableListOf<String>()
    val panel = EnglishSyntaxPreviewPanel(transportOverride = HostMessageTransport { scripts += it })

    panel.injectForTest()

    val pushed = scripts.filter { it.startsWith("window.__englishSyntaxSetHotkey&&") }
    assertEquals(1, pushed.size, "须下发一次兼底键位: $scripts")
    assertTrue(
      pushed[0].contains("\"code\":\"KeyT\""),
      "读不到 keymap（纯协议测试无 IDE 上下文）时回退 plugin.xml 声明的默认值: ${pushed[0]}",
    )

    panel.dispose()
  }
}
