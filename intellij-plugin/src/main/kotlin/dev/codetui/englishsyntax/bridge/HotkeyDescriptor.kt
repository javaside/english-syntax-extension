package dev.codetui.englishsyntax.bridge

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.awt.event.InputEvent
import java.awt.event.KeyEvent
import javax.swing.KeyStroke

/**
 * 预览页 keydown 兼底通道的键位判据：把 IDEA keymap 里的 [KeyStroke] 翻成浏览器
 * `KeyboardEvent` 的字段。
 *
 * 用 `event.code` 而不是 `event.key`：macOS 上 ⌥T 的 `key` 是 `†`（Option 是死键），
 * 只有 `code`（`"KeyT"`）与键盘布局无关。字母数字之外一律返回 null，让页面保持
 * [DEFAULT]——不为罕见键位堆映射表。
 */
data class HotkeyDescriptor(
  val code: String,
  val altKey: Boolean,
  val ctrlKey: Boolean,
  val shiftKey: Boolean,
  val metaKey: Boolean,
) {
  /** 下发给 `window.__englishSyntaxSetHotkey` 的载荷。字段名与浏览器事件一致。 */
  fun toJson(): String = buildJsonObject {
    put("code", code)
    put("altKey", altKey)
    put("ctrlKey", ctrlKey)
    put("shiftKey", shiftKey)
    put("metaKey", metaKey)
  }.toString()

  companion object {
    /** plugin.xml 里注册的动作 id；`HotkeyDescriptorTest` 与 `ActionStateTest` 双侧钉住一致性。 */
    const val PARSE_HOVERED_BLOCK_ACTION_ID = "EnglishSyntax.ParseHoveredBlock"

    /** 与 Chrome 扩展一致的默认键位 Alt+T。 */
    val DEFAULT = HotkeyDescriptor(
      code = "KeyT",
      altKey = true,
      ctrlKey = false,
      shiftKey = false,
      metaKey = false,
    )

    fun from(stroke: KeyStroke): HotkeyDescriptor? {
      val code = codeOf(stroke.keyCode) ?: return null
      val modifiers = stroke.modifiers
      return HotkeyDescriptor(
        code = code,
        altKey = modifiers and InputEvent.ALT_DOWN_MASK != 0,
        ctrlKey = modifiers and InputEvent.CTRL_DOWN_MASK != 0,
        shiftKey = modifiers and InputEvent.SHIFT_DOWN_MASK != 0,
        metaKey = modifiers and InputEvent.META_DOWN_MASK != 0,
      )
    }

    /**
     * 从当前 keymap 读实际绑定：用户改了键，兼底通道跟着改。
     * 无绑定、非字母数字键、无 IDE 上下文（纯协议测试）都回退 [DEFAULT]。
     */
    fun fromKeymap(actionId: String = PARSE_HOVERED_BLOCK_ACTION_ID): HotkeyDescriptor =
      runCatching {
        com.intellij.openapi.keymap.KeymapManager.getInstance()
          .activeKeymap
          .getShortcuts(actionId)
          .asSequence()
          .filterIsInstance<com.intellij.openapi.actionSystem.KeyboardShortcut>()
          .mapNotNull { from(it.firstKeyStroke) }
          .firstOrNull()
      }.getOrNull() ?: DEFAULT

    private fun codeOf(keyCode: Int): String? = when (keyCode) {
      in KeyEvent.VK_A..KeyEvent.VK_Z -> "Key" + ('A' + (keyCode - KeyEvent.VK_A))
      in KeyEvent.VK_0..KeyEvent.VK_9 -> "Digit" + (keyCode - KeyEvent.VK_0)
      else -> null
    }
  }
}
