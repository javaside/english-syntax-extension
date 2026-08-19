package dev.codetui.englishsyntax.integration

import dev.codetui.englishsyntax.markdown.EnglishSyntaxPreviewPanel
import dev.codetui.englishsyntax.markdown.HostMessageTransport
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertFalse

/**
 * 密钥隔离：key 只允许出现在发往模型端点的 Authorization。
 * 面板外发消息、异常 message 都不允许包含 key。
 */
class SecretIsolationTest {

  private val secret = "secret-integration-9f3d"

  @Test
  fun `panel outbound scripts never contain the key`() {
    val scripts = mutableListOf<String>()
    val panel = EnglishSyntaxPreviewPanel(null, null, HostMessageTransport { scripts += it })
    panel.setHtml("<p>hello</p>", 0, null as com.intellij.openapi.vfs.VirtualFile?)
    panel.send(buildJsonObject { put("type", "SESSION_STATE"); put("state", "running") })
    panel.dispose()
    scripts.forEach { script -> assertFalse(script.contains(secret), "leaked: $script") }
  }

  @Test
  fun `bridge messages carry no credential fields`() = runBlocking {
    val received = mutableListOf<JsonObject>()
    val panel = EnglishSyntaxPreviewPanel(null, null, HostMessageTransport { })
    panel.addPageMessageHandler { received += it }
    // 恶意页面尝试夹带凭据字段：协议层应整体丢弃。
    panel.onPageMessage("""{"version":1,"type":"PREVIEW_READY","previewId":"p","generation":0,"apiKey":"$secret"}""")
    panel.onPageMessage("""{"version":1,"type":"PREVIEW_READY","previewId":"p","generation":0}""")
    assertEquals(1, received.size)
  }

  private fun assertEquals(expected: Int, actual: Int) {
    kotlin.test.assertEquals(expected, actual)
  }
}
