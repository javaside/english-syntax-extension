package dev.codetui.englishsyntax.session

import dev.codetui.englishsyntax.bridge.BridgeProtocol
import dev.codetui.englishsyntax.bridge.PageMessage
import dev.codetui.englishsyntax.markdown.EnglishSyntaxPreviewPanel

/**
 * JS → Kotlin 消息接线：把 Panel 的页面消息派发给对应 preview 的 [PreviewSession]。
 *
 * Start Action 每次经 [connect] 重接（幂等：重复 Start 只保留一个处理器），
 * [kickoff] 触发首轮扫描（PREVIEW_READY）。此前这段接线在「移除自建预览面板」
 * 重构中丢失——VISIBLE_BLOCKS/DETAIL_REQUEST/RETRY_SENTENCE 无任何消费者，
 * 表现为「开始句法学习后一点变化都没有」且无报错。
 *
 * generation 守卫：JS 侧 parseHostMessage 已拦旧代次 host 消息；这里对 page
 * 消息同样校验 previewId/generation（PREVIEW_READY 例外：kickoff 前会话
 * generation 尚为 0，与页面一致）。
 */
object PreviewSessionConnector {

  private val LOGGER = com.intellij.openapi.diagnostic.Logger.getInstance(PreviewSessionConnector::class.java)

  /**
   * Start Action 的完整接线：注册消息分发器 + 启动会话 + 触发首轮扫描。
   * 顺序不可拆——会话初始为 STOPPED，先于 start 到达的 VISIBLE_BLOCKS 会被丢弃。
   */
  fun start(panel: EnglishSyntaxPreviewPanel, manager: PreviewSessionManager) {
    connect(panel, manager)
    manager.start(panel.previewId, HostSender { panel.send(it) }) { kickoff(panel) }
  }

  fun connect(panel: EnglishSyntaxPreviewPanel, manager: PreviewSessionManager) {
    val sender = HostSender { json -> panel.send(json) }
    val session = manager.obtain(panel.previewId, sender) { panel.requestScan() }
    panel.onGenerationChanged = { generation -> manager.onGenerationChanged(panel.previewId, generation) }
    panel.attachPageMessageDispatcher { json ->
      val message = BridgeProtocol.parsePageMessage(json) ?: return@attachPageMessageDispatcher
      if (message.previewId != panel.previewId) return@attachPageMessageDispatcher
      when (message) {
        is PageMessage.VisibleBlocks -> session.onVisibleBlocks(message.blocks.map { it.blockId to it.text })
        is PageMessage.DetailRequest ->
          session.launchDetailRequest(message.sentenceId, message.focusStart, message.focusEnd)
        is PageMessage.RetrySentence -> session.retrySentence(message.sentenceId)
        is PageMessage.PreviewReady, is PageMessage.PreviewRendered -> Unit
      }
    }
    LOGGER.info("connect: dispatcher attached for previewId=${panel.previewId}")
  }

  /** 触发首轮扫描：经 initialize 全局入口驱动 JS 侧 rescan + VISIBLE_BLOCKS 上报。 */
  fun kickoff(panel: EnglishSyntaxPreviewPanel) {
    panel.requestScan()
  }
}
