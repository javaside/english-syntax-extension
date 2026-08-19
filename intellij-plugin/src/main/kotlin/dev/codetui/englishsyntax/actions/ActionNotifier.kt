package dev.codetui.englishsyntax.actions

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.notification.Notifications
import com.intellij.openapi.project.Project

/**
 * Action 的用户可见反馈：服务未就绪 / 面板缺失时弹 BALLOON 通知，
 * 避免「点了没反应」的静默失败（通知组在 plugin.xml 注册为 EnglishSyntax）。
 */
object ActionNotifier {

  fun info(project: Project?, content: String) {
    val group = NotificationGroupManager.getInstance().getNotificationGroup("EnglishSyntax") ?: return
    Notifications.Bus.notify(group.createNotification(content, NotificationType.INFORMATION), project)
  }

  fun warn(project: Project?, content: String) {
    val group = NotificationGroupManager.getInstance().getNotificationGroup("EnglishSyntax") ?: return
    Notifications.Bus.notify(group.createNotification(content, NotificationType.WARNING), project)
  }
}
