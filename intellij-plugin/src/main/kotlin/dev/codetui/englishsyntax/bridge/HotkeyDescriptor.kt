package dev.codetui.englishsyntax.bridge

import com.intellij.openapi.actionSystem.KeyboardShortcut
import com.intellij.openapi.actionSystem.Shortcut
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.keymap.KeymapManager
import com.intellij.openapi.progress.ProcessCanceledException
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.awt.event.InputEvent
import java.awt.event.KeyEvent
import javax.swing.KeyStroke

private val LOGGER = Logger.getInstance(HotkeyDescriptor::class.java)

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
    /**
     * plugin.xml 里注册的动作 id。
     *
     * **id 写歪是本文件唯一会静默失效的失败模式**：`Keymap.getShortcuts` 是 `@NotNull`，
     * 认不出的 id 返回空数组而不抛异常，于是页面兼底通道被静默关掉，用户只会看到
     * 「我改的键位没生效」。「plugin.xml 里真的注册了这个 id」由 `ActionStateTest`
     * 读 `META-INF/plugin.xml` 断言（随注册 Action 的那个任务落地）；本文件里的用例
     * 只钉常量字面值本身。
     */
    const val PARSE_HOVERED_BLOCK_ACTION_ID = "EnglishSyntax.ParseHoveredBlock"

    /** plugin.xml 声明的默认键位 Alt+T（与 Chrome 扩展的默认键一致，但两端各自演进）。 */
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
     * 从一组 keymap 绑定里挑出可下发给页面的那个：第一个「单段 + 字母数字」的绑定。
     *
     * **两段式（chord，如 `Ctrl+X, Ctrl+P`）必须整条丢掉，不能只取 `firstKeyStroke`**：
     * IDEA 要按完两段才触发 Action，而页面 keydown 会在第一段就触发、还 `preventDefault`
     * 把它吃掉——两条通道行为分叉，顺带破坏用户的 chord。
     *
     * 返回 null 表示**不给页面装兼底监听**（没有绑定、只有两段式、或绑的是非字母数字键）。
     * 这几种情况都不能回退 [DEFAULT]：那会让页面监听一个用户根本没绑的 Alt+T（幻影键位）。
     */
    internal fun fromShortcuts(shortcuts: Array<Shortcut>): HotkeyDescriptor? =
      shortcuts.asSequence()
        .filterIsInstance<KeyboardShortcut>()
        .filter { it.secondKeyStroke == null }
        .mapNotNull { from(it.firstKeyStroke) }
        .firstOrNull()

    /**
     * 读当前 keymap 的实际绑定：用户改了键，页面兼底通道跟着改。null 表示不装监听。
     *
     * 两类失败刻意区别对待：**读得到 keymap 但没有可用绑定**（空数组 / 只有 chord /
     * 非字母数字键）→ null，我们确知它不是 Alt+T，装监听就是幻影键位；**连 keymap 都
     * 读不到**（无 IDE 上下文，如纯协议单测）→ [DEFAULT]，因为那正是 plugin.xml 声明的
     * 默认值，属于「我们不知道，用声明值」而不是猜。
     *
     * 每条返回 null 的路径都留日志——静默回退的症状是「我改的键位没生效」，日志里
     * 什么都没有会很难查。[ProcessCanceledException] 必须重抛（平台契约不许吞），
     * 本函数在 `injectWebResources` 里调用，正好在会被取消的路径上。
     */
    fun fromKeymap(actionId: String = PARSE_HOVERED_BLOCK_ACTION_ID): HotkeyDescriptor? {
      val shortcuts = try {
        KeymapManager.getInstance().activeKeymap.getShortcuts(actionId)
      } catch (cancellation: ProcessCanceledException) {
        throw cancellation
      } catch (error: Throwable) {
        LOGGER.warn("fromKeymap: keymap unavailable for $actionId, falling back to declared default", error)
        return DEFAULT
      }
      if (shortcuts.isEmpty()) {
        LOGGER.info("fromKeymap: nothing bound to $actionId, page keydown fallback disabled")
        return null
      }
      val descriptor = fromShortcuts(shortcuts)
      if (descriptor == null) {
        LOGGER.info(
          "fromKeymap: $actionId is bound only to chords or non-alphanumeric keys " +
            "(${shortcuts.joinToString()}), page keydown fallback disabled",
        )
      }
      return descriptor
    }

    private fun codeOf(keyCode: Int): String? = when (keyCode) {
      in KeyEvent.VK_A..KeyEvent.VK_Z -> "Key" + ('A' + (keyCode - KeyEvent.VK_A))
      in KeyEvent.VK_0..KeyEvent.VK_9 -> "Digit" + (keyCode - KeyEvent.VK_0)
      else -> null
    }
  }
}
