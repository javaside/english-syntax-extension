package dev.codetui.englishsyntax.markdown

import com.intellij.ui.JBColor
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

  /** 应用层唯一分发器（Start 接线）；测试用的 pageHandlers 仍并行生效。 */
  private val dispatcherRef = java.util.concurrent.atomic.AtomicReference<(JsonObject) -> Unit>()

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
    private val LOGGER = com.intellij.openapi.diagnostic.Logger.getInstance(EnglishSyntaxPreviewPanel::class.java)

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
    val cef = hostPanel?.cefBrowser ?: run {
      LOGGER.warn("attach: no host panel / cefBrowser (test or JCEF-less environment)")
      return
    }
    if (jsQuery == null) {
      // EnglishSyntaxHost.post 会是空函数——JS→Kotlin 通道断掉，一切页面消息出不来。
      LOGGER.warn("attach: JBCefJSQuery.create failed, JS→Kotlin channel is DEAD")
    }
    jsQuery?.addHandler { text -> onPageMessage(text); null }
    val inject = { if (!disposed) injectWebResources() }
    // 页面已加载完成（Action 通常在预览打开后触发）→ 立即注入；
    // 未完成 → 等 onLoadEnd。inject 有 __englishSyntaxLoaded 幂等守卫，双路径安全。
    if (!cef.isLoading() && cef.url.isNotBlank()) {
      LOGGER.info("attach: page ready, injecting now (url=${cef.url})")
      inject()
    } else {
      LOGGER.info("attach: page loading, waiting for onLoadEnd")
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
    val queryInject = jsQuery?.inject("text") ?: "null"
    // ① bootstrap：样式 + JS→Kotlin 通道（受 CSP 约束的 DOM/style 操作，style-src 带 unsafe-inline）。
    execute(
      """
      (function() {
        if (window.__englishSyntaxLoaded) return;
        window.__englishSyntaxLoaded = true;
        var style = document.createElement('style');
        style.textContent = '$injectCss';
        document.head.appendChild(style);
        window.EnglishSyntaxHost = { post: function(text) { $queryInject } };
      })();
      """.trimIndent(),
    )
    // ② bundle 作为顶层脚本直接执行：官方预览页 CSP 的 script-src 只允许官方静态资源、
    // 没有 'unsafe-eval'——页面上下文里 eval('代码') / new Function / 动态 <script> 内联
    // 都会被 CSP 静默拦截（bundle 一行都跑不了，曾表现为「开始后毫无变化」）。
    // executeJavaScript 是浏览器 API 级注入，不受页面 CSP 约束（官方 updateDom 同款路径）。
    execute(loadWebResource("web/bundle.js"))
    // 深色主题下角色字色要用提亮版色板：先告诉 JS 当前 IDEA 主题明暗，再初始化扫描。
    // JBColor.isBright()=true 表示浅色主题（IntelliJ Light / 默认），反之为深色（Darcula）。
    // 纯协议测试无 IDE UI 上下文，isBright 可能不可用——回退浅色（false）。
    val isDark = runCatching { !JBColor.isBright() }.getOrDefault(false)
    // 根 data 属性供 CSS 消费面板背景/字色；__englishSyntaxSetTheme 供 roles.ts 选色板。
    execute("window.__englishSyntaxSetTheme&&window.__englishSyntaxSetTheme($isDark);")
    execute("document.documentElement.setAttribute('data-english-syntax-dark', String($isDark));")
    // 注入完成后页面才有全局入口，再通知初始化扫描。
    LOGGER.info("inject: bootstrap + bundle executed, notifying initialize (generation=$generation)")
    notifyInitialize()
  }

  /** 测试辅助：直接触发注入流程（无需 JCEF）。 */
  internal fun injectForTest() {
    injectWebResources()
  }

  private fun notifyInitialize() {
    val previewIdLiteral = Json.encodeToString(JsonElement.serializer(), JsonPrimitive(previewId))
    execute("window.__englishSyntaxInitialize($previewIdLiteral, $generation);")
  }

  /**
   * 会话层扫描入口：让浏览器重新 initialize（rescan + 上报 VISIBLE_BLOCKS）。
   * 旧代码往 onPageMessage 合成 PREVIEW_READY 只是 Kotlin 侧自言自语，JS 收不到。
   */
  fun requestScan() {
    if (disposed) return
    notifyInitialize()
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
   * 会话接线：注册唯一的应用层消息分发器（重复调用只保留最后一个——
   * Start Action 可重复触发，旧分发器闭包持有旧 session 会造成双派发）。
   * 消息在 [onPageMessage] 里已过 BridgeProtocol 白名单校验。
   */
  fun attachPageMessageDispatcher(dispatcher: (JsonObject) -> Unit) {
    dispatcherRef.set(dispatcher)
  }

  /**
   * 桥接入口：JS 侧 JSON 文本进入（生产环境由 JBCefJSQuery 调用）。
   * 每条消息先经 BridgeProtocol 键白名单严格校验——含 apiKey/headers/baseUrl
   * 或任何未知键的消息整体丢弃，绝不透传到会话层。
   */
  fun onPageMessage(text: String) {
    if (disposed) return
    val parsed = runCatching { json.parseToJsonElement(text).jsonObject }.getOrNull() ?: run {
      LOGGER.warn("onPageMessage: dropped non-JSON (len=${text.length}): ${text.take(120)}")
      return
    }
    when (val message = BridgeProtocol.parsePageMessage(parsed)) {
      null -> LOGGER.warn("onPageMessage: dropped by BridgeProtocol: ${text.take(120)}")
      is PageMessage.PreviewRendered -> handlePageRendered()
      else -> {
        LOGGER.info("onPageMessage: ${message::class.simpleName} generation=${message.generation}")
        dispatcherRef.get()?.invoke(parsed)
        pageHandlers.forEach { it.onMessage(parsed) }
      }
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
    dispatcherRef.set(null)
    pageHandlers.clear()
    onGenerationChanged = null
  }

  fun isDisposed(): Boolean = disposed

  override fun <T : Any> getUserData(key: Key<T>): T? = super<UserDataHolderBase>.getUserData(key)

  override fun <T : Any> putUserData(key: Key<T>, value: T?) = super<UserDataHolderBase>.putUserData(key, value)
}
