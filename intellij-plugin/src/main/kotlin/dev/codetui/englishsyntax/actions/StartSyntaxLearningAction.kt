package dev.codetui.englishsyntax.actions

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.project.Project
import com.intellij.ui.jcef.JBCefApp
import dev.codetui.englishsyntax.markdown.EnglishSyntaxPreviewPanel
import dev.codetui.englishsyntax.session.PreviewSessionConnector
import dev.codetui.englishsyntax.session.PreviewSessionManager

/**
 * 开始句法学习。JCEF 不支持时不可用（由 notification 提示切换运行时）。
 * 面板定位只走 FileEditorManager 的 selected editor，不做 Swing 全局扫描。
 */
class StartSyntaxLearningAction(
  private val managerProvider: (Project) -> PreviewSessionManager? = { _ ->
      com.intellij.openapi.components.service<dev.codetui.englishsyntax.PreviewSessionManagerService>().manager
    },
  private val jcefSupported: () -> Boolean = JBCefApp::isSupported,
) : AnAction() {

  override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

  override fun update(event: AnActionEvent) {
    val project = event.project
    val file = event.getData(CommonDataKeys.VIRTUAL_FILE)
    val presentation = event.presentation
    val fileOk = project != null && file != null && file.fileType.name.equals("Markdown", ignoreCase = true) && jcefSupported()
    // 每个 markdown 文件独立会话：只看「当前文件自己的面板」是否已在进行中，
    // 不再被其它文件的会话（activePreviewId）阻塞——多文件可并行翻译。
    val manager = project?.let { runCatching { managerProvider(it) }.getOrNull() }
    val currentSession = project?.let {
      runCatching { currentPanel(it) }.getOrNull()?.let { panel -> manager?.session(panel.previewId) }
    }
    val startEnabled = PreviewActionSupport.availability(currentSession).startEnabled
    presentation.isEnabledAndVisible = fileOk && startEnabled
  }

  override fun actionPerformed(event: AnActionEvent) {
    val project = event.project ?: return
    val panel = currentPanel(project)
    if (panel == null) {
      LOGGER.warn("start: no preview panel found for project")
      ActionNotifier.warn(
        project,
        "未找到 Markdown 预览面板：请先打开一个 .md 文件的 Markdown 预览（IDEA 默认 JCEF 预览即可）",
      )
      return
    }
    val manager = runCatching { managerProvider(project) }.getOrNull()
    if (manager == null) {
      LOGGER.warn("start: manager unavailable (SQLite cache init failure lands here too)")
      ActionNotifier.warn(project, "句法学习服务不可用：请检查设置页配置（SQLite 缓存初始化失败时也会走到这里）")
      return
    }
    // JS→Kotlin 消息接线：VISIBLE_BLOCKS/DETAIL_REQUEST/RETRY_SENTENCE 派发进会话。
    // 曾在移除自建预览面板的重构中丢失此接线，页面消息无消费者，翻译毫无变化。
    PreviewSessionConnector.start(panel, manager)
    LOGGER.info("start: session wired for previewId=${panel.previewId} generation=${panel.generation}")
    // 即时反馈：点击生效 + 首次模型请求可能较慢（尤其云端端点），预览页右下角有进度浮层。
    ActionNotifier.info(project, "句法学习已开始，正在解析可见段落…（进度见预览页右下角）")
  }

  /** 经 Markdown 插件的 PREVIEW_BROWSER UserData 定位当前预览面板（面板不是 FileEditor 本身）。 */
  internal fun currentPanel(project: Project): EnglishSyntaxPreviewPanel? =
    EnglishSyntaxPreviewPanel.findPanel(project)

  private companion object {
    private val LOGGER = com.intellij.openapi.diagnostic.Logger.getInstance(StartSyntaxLearningAction::class.java)
  }
}
