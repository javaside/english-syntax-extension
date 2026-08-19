package dev.codetui.englishsyntax.markdown

import com.intellij.openapi.Disposable
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.util.Key
import com.intellij.openapi.util.UserDataHolderBase
import com.intellij.openapi.vfs.VirtualFile
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.isActive
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.intellij.plugins.markdown.ui.preview.MarkdownHtmlPanel
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger

/** JS → Kotlin 消息回调（BridgeProtocol 解析后的封闭类型由桥接层继续分发）。 */
fun interface PageMessageHandler {
  fun onMessage(json: JsonObject)
}

/** Kotlin → JS 的发送通道抽象：生产环境是 JCEF executeJavaScript，测试用假实现。 */
fun interface HostMessageTransport {
  fun post(script: String)
}

/**
 * 自定义 Markdown 预览面板：持有 previewId/generation、桥接入口与可释放资源。
 *
 * JCEF 的浏览器装配集中在 [transport]；本类只负责协议与生命周期，不反射访问
 * 官方面板内部。generation 在每次 setHtml 完成后递增并通知页面重新初始化。
 */
class EnglishSyntaxPreviewPanel(
  private val projectRef: Project?,
  private val virtualFileRef: VirtualFile?,
  private val transport: HostMessageTransport = HostMessageTransport { },
  parentDisposable: Disposable? = null,
) : MarkdownHtmlPanel, UserDataHolderBase() {

  override fun getProject(): Project? = projectRef

  override fun getVirtualFile(): VirtualFile? = virtualFileRef

  val previewId: String = "preview-${java.util.UUID.randomUUID()}"
  private val generationCounter = AtomicInteger(0)
  val generation: Int get() = generationCounter.get()

  val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

  private val scrollListeners = CopyOnWriteArrayList<MarkdownHtmlPanel.ScrollListener>()
  private val pageHandlers = CopyOnWriteArrayList<PageMessageHandler>()

  @Volatile
  private var disposed = false

  private val json = Json { ignoreUnknownKeys = true }

  init {
    parentDisposable?.let { Disposer.register(it, this) }
  }

  /** 测试辅助：注册页面消息处理器。 */
  fun addPageMessageHandler(handler: PageMessageHandler) {
    pageHandlers += handler
  }

  /**
   * 桥接入口：JS 侧 JSON 文本进入（生产环境由 JBCefJSQuery 调用）。
   * 每条消息先经 BridgeProtocol 键白名单严格校验——含 apiKey/headers/baseUrl
   * 或任何未知键的消息整体丢弃，绝不透传到会话层。
   */
  fun onPageMessage(text: String) {
    if (disposed) return
    val parsed = runCatching { json.parseToJsonElement(text).jsonObject }.getOrNull() ?: return
    if (dev.codetui.englishsyntax.bridge.BridgeProtocol.parsePageMessage(parsed) == null) return
    pageHandlers.forEach { it.onMessage(parsed) }
  }

  override fun getComponent(): javax.swing.JComponent =
    throw UnsupportedOperationException("JCEF component is wired by the JCEF-specific assembly in Task 17")

  override fun setHtml(html: String, offset: Int, file: VirtualFile?) {
    if (disposed) return
    generationCounter.incrementAndGet()
    // 通知页面重新初始化：固定全局入口 + JSON 参数，绝不拼接模型文本。
    val previewIdLiteral = Json.encodeToString(JsonElement.serializer(), JsonPrimitive(previewId))
    transport.post("window.__englishSyntaxInitialize($previewIdLiteral, $generation);")
  }

  override fun reloadWithOffset(offset: Int) {
    if (disposed) return
    generationCounter.incrementAndGet()
    transport.post("window.__englishSyntaxReload($offset);")
  }

  override fun scrollToMarkdownSrcOffset(offset: Int, smooth: Boolean) {
    if (disposed) return
    transport.post("window.__englishSyntaxScrollTo($offset, $smooth);")
  }

  override fun addScrollListener(listener: MarkdownHtmlPanel.ScrollListener) {
    scrollListeners += listener
  }

  override fun removeScrollListener(listener: MarkdownHtmlPanel.ScrollListener) {
    scrollListeners -= listener
  }

  fun notifyScroll(offset: Int) {
    scrollListeners.forEach { it.onScroll(offset) }
  }

  val scopeActive: Boolean get() = scope.isActive

  override fun dispose() {
    if (disposed) return
    disposed = true
    scope.cancel()
    pageHandlers.clear()
    scrollListeners.clear()
  }

  fun isDisposed(): Boolean = disposed

  /** 已释放后再发送必须抛错——调用方依赖这个信号清理会话。 */
  fun send(hostJson: JsonObject) {
    check(!disposed) { "Panel is disposed" }
    transport.post("window.__englishSyntaxMessage(${Json.encodeToString(JsonObject.serializer(), hostJson)});")
  }

  override fun <T : Any> getUserData(key: Key<T>): T? = super<UserDataHolderBase>.getUserData(key)

  override fun <T : Any> putUserData(key: Key<T>, value: T?) = super<UserDataHolderBase>.putUserData(key, value)
}
