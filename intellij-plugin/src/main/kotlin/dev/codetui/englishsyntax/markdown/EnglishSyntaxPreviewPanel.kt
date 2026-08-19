package dev.codetui.englishsyntax.markdown

import com.intellij.openapi.Disposable
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.TextEditorWithPreview
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.util.Key
import com.intellij.openapi.util.UserDataHolderBase
import com.intellij.ui.jcef.JBCefJSQuery
import dev.codetui.englishsyntax.bridge.BridgeProtocol
import dev.codetui.englishsyntax.bridge.PageMessage
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.cef.browser.CefBrowser
import org.cef.browser.CefFrame
import org.cef.handler.CefLoadHandlerAdapter
import org.intellij.plugins.markdown.ui.preview.jcef.MarkdownJCEFHtmlPanel
import org.intellij.plugins.markdown.ui.preview.MarkdownPreviewFileEditor
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger

/** JS → Kotlin 消息回调（BridgeProtocol 解析后的封闭类型由桥接层继续分发）。 */
fun interface PageMessageHandler {
  fun onMessage(json: JsonObject)
}

/** Kotlin → JS 的发送通道抽象：生产环境是 CEF executeJavaScript，测试用假实现。 */
fun interface HostMessageTransport {
  fun post(script: String)
}

/**
 * 官方 Markdown 预览的能力层包装：**不**自建预览浏览器，而是复用 IDEA 默认的
 * `MarkdownJCEFHtmlPanel`（官方 JCEF 预览）——它继承 `JCEFHtmlPanel` → `JBCefBrowser`，
 * 因此 `executeJavaScript` 与 `JBCefJSQuery.create` 都是公开 API，无需反射、无需让
 * 用户切换 provider。
 *
 * 渲染仍由官方完成（显示问题随官方走）；本包装只负责：向官方面板的页面注入
 * web 资源（CSS + bundle + JS→Kotlin 通道）、维护 previewId/generation、在官方
 * 整体重渲染（JS 侧检测到卡片被清掉后上报 `PREVIEW_RENDERED`）时换代并重扫。
 *
 * 纯协议测试可传 `hostPanel = null` + `transportOverride`，不触碰 JCEF。
 */
class EnglishSyntaxPreviewPanel(
  private val hostPanel: MarkdownJCEFHtmlPanel? = null,
  transportOverride: HostMessageTransport? = null,
  parentDisposable: Disposable? = null,
) : UserDataHolderBase(), Disposable {

  val previewId: String = "preview-${java.util.UUID.randomUUID()}"
  private val generationCounter = AtomicInteger(0)
  val generation: Int get() = generationCounter.get()

  private val pageHandlers = CopyOnWriteArrayList<PageMessageHandler>()

  /** 渲染换代回调：Start 时接上 manager.onGenerationChanged，官方重渲染后清空旧记录。 */
  @Volatile
  var onGenerationChanged: ((Int) -> Unit)? = null

  @Volatile
  private var disposed = false

  private val json = Json { ignoreUnknownKeys = true }

  /** JS→Kotlin 通道：JBCefJSQuery 挂在官方面板的 JBCefBrowser 上（公开 API，不反射）。 */
  private val jsQuery: JBCefJSQuery? =
    hostPanel?.let { runCatching { JBCefJSQuery.create(it) }.getOrNull() }

  /** Kotlin→JS 通道：生产走 CEF executeJavaScript，测试注入假 transport。 */
  private val transport: HostMessageTransport =
    transportOverride ?: HostMessageTransport { script ->
      val cef = hostPanel?.cefBrowser ?: return@HostMessageTransport
      cef.executeJavaScript(script, cef.url, 0)
    }

  companion object {
    /** 包装缓存 key：挂在官方面板上，保证同一面板的 previewId 稳定复用。 */
    private val WRAPPER_KEY = Key.create<EnglishSyntaxPreviewPanel>("english-syntax-wrapper")

    /**
     * 定位当前 Markdown 预览的官方面板并包装。
     *
     * Markdown 插件把 htmlPanel 以 WeakReference 存在 MarkdownPreviewFileEditor 的
     * PREVIEW_BROWSER UserData 里（Companion 公开 Key）；preview editor 可能是裸的
     * MarkdownPreviewFileEditor，也可能包在 MarkdownEditorWithPreview
     * （TextEditorWithPreview）里。面板不是 FileEditor 本身——绝不能对
     * selectedEditor 做 `as? EnglishSyntaxPreviewPanel` 强转（永远 null）。
     * 只认官方 `MarkdownJCEFHtmlPanel`（IDEA 默认预览就是它），其它面板返回 null。
     */
    fun findPanel(project: Project): EnglishSyntaxPreviewPanel? {
      val manager = FileEditorManager.getInstance(project)
      val file = manager.selectedFiles.firstOrNull() ?: return null
      return manager.getAllEditors(file)
        .asSequence()
        .flatMap { editor ->
          if (editor is TextEditorWithPreview) sequenceOf(editor, editor.previewEditor)
          else sequenceOf(editor)
        }
        .filterIsInstance<MarkdownPreviewFileEditor>()
        .firstNotNullOfOrNull { previewEditor ->
          val panel = previewEditor.getUserData(MarkdownPreviewFileEditor.PREVIEW_BROWSER)?.get()
          (panel as? MarkdownJCEFHtmlPanel)?.let(::wrap)
        }
    }

    /** 包装（或复用已有包装）：挂 UserData 保证 previewId 稳定，官方面板 dispose 时释放。 */
    fun wrap(hostPanel: MarkdownJCEFHtmlPanel): EnglishSyntaxPreviewPanel {
      hostPanel.getUserData(WRAPPER_KEY)?.let { return it }
      val wrapper = EnglishSyntaxPreviewPanel(hostPanel = hostPanel)
      hostPanel.putUserData(WRAPPER_KEY, wrapper)
      Disposer.register(hostPanel, wrapper)
      wrapper.attach()
      return wrapper
    }

    private fun loadWebResource(path: String): String {
      val stream = EnglishSyntaxPreviewPanel::class.java.classLoader.getResourceAsStream(path)
        ?: error("Missing bundled web resource: $path")
      return stream.use { it.readBytes().toString(Charsets.UTF_8) }
    }

    private fun String.escapeJsString(): String =
      replace("\\", "\\\\").replace("'", "\\'").replace("\n", "\\n")
  }

  /** 挂 JSQuery 回调 + 等页面 load 完成后注入 web 资源。 */
  private fun attach() {
    val cef = hostPanel?.cefBrowser ?: return
    jsQuery?.addHandler { text -> onPageMessage(text); null }
    val inject = { if (!disposed) injectWebResources() }
    // 页面已加载完成（Action 通常在预览打开后触发）→ 立即注入；
    // 未完成 → 等 onLoadEnd。inject 有 __englishSyntaxLoaded 幂等守卫，双路径安全。
    if (!cef.isLoading() && cef.url.isNotBlank()) {
      inject()
    } else {
      hostPanel.jbCefClient.addLoadHandler(
        object : CefLoadHandlerAdapter() {
          override fun onLoadEnd(browser: CefBrowser?, frame: CefFrame?, httpStatusCode: Int) {
            if (frame?.isMain == true) inject()
          }
        },
        cef,
      )
    }
  }

  /** 注入顺序：样式 → JSQuery 通道 → bundle；bundle 定义的全局入口依赖前两者。 */
  private fun injectWebResources() {
    val injectCss = loadWebResource("web/preview.css").escapeJsString()
    val injectJs = loadWebResource("web/bundle.js").escapeJsString()
    val queryInject = jsQuery?.inject("text") ?: "null"
    execute(
      """
      (function() {
        if (window.__englishSyntaxLoaded) return;
        window.__englishSyntaxLoaded = true;
        var style = document.createElement('style');
        style.textContent = '$injectCss';
        document.head.appendChild(style);
        window.EnglishSyntaxHost = { post: function(text) { $queryInject } };
        eval('$injectJs');
      })();
      """.trimIndent(),
    )
    // 注入完成后页面才有全局入口，再通知初始化扫描。
    notifyInitialize()
  }

  private fun notifyInitialize() {
    val previewIdLiteral = Json.encodeToString(JsonElement.serializer(), JsonPrimitive(previewId))
    execute("window.__englishSyntaxInitialize($previewIdLiteral, $generation);")
  }

  private fun execute(script: String) {
    if (disposed) return
    transport.post(script)
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
    when (val message = BridgeProtocol.parsePageMessage(parsed)) {
      null -> Unit
      is PageMessage.PreviewRendered -> handlePageRendered()
      else -> pageHandlers.forEach { it.onMessage(parsed) }
    }
  }

  /**
   * 官方整体重渲染（JS 侧检测到卡片被官方 updateDom 清掉）→ 递增 generation、
   * 通知会话清空旧记录，并以新 generation 重发 initialize 重新扫描。
   */
  private fun handlePageRendered() {
    if (disposed) return
    val next = generationCounter.incrementAndGet()
    onGenerationChanged?.invoke(next)
    notifyInitialize()
  }

  /** Kotlin→JS 下发模型消息。已释放后再发送必须抛错——调用方依赖这个信号清理会话。 */
  fun send(hostJson: JsonObject) {
    check(!disposed) { "Panel is disposed" }
    transport.post("window.__englishSyntaxMessage(${Json.encodeToString(JsonObject.serializer(), hostJson)});")
  }

  override fun dispose() {
    if (disposed) return
    disposed = true
    runCatching { jsQuery?.let(Disposer::dispose) }
    pageHandlers.clear()
    onGenerationChanged = null
  }

  fun isDisposed(): Boolean = disposed

  override fun <T : Any> getUserData(key: Key<T>): T? = super<UserDataHolderBase>.getUserData(key)

  override fun <T : Any> putUserData(key: Key<T>, value: T?) = super<UserDataHolderBase>.putUserData(key, value)
}
