package dev.codetui.englishsyntax.bridge

import com.intellij.openapi.actionSystem.KeyboardShortcut
import java.awt.event.InputEvent
import java.awt.event.KeyEvent
import javax.swing.KeyStroke
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class HotkeyDescriptorTest {

  @Test
  fun `alt letter maps to a layout independent code`() {
    // 必须用 event.code 而非 event.key：macOS 上 ⌥T 的 key 是 "†"。
    val stroke = KeyStroke.getKeyStroke(KeyEvent.VK_T, InputEvent.ALT_DOWN_MASK)
    val descriptor = HotkeyDescriptor.from(stroke)
    assertEquals(
      HotkeyDescriptor("KeyT", altKey = true, ctrlKey = false, shiftKey = false, metaKey = false),
      descriptor,
    )
  }

  @Test
  fun `digits and every modifier bit are mapped`() {
    val stroke = KeyStroke.getKeyStroke(
      KeyEvent.VK_5,
      InputEvent.CTRL_DOWN_MASK or InputEvent.SHIFT_DOWN_MASK or InputEvent.META_DOWN_MASK,
    )
    val descriptor = HotkeyDescriptor.from(stroke)
    assertEquals("Digit5", descriptor?.code)
    assertEquals(false, descriptor?.altKey)
    assertEquals(true, descriptor?.ctrlKey)
    assertEquals(true, descriptor?.shiftKey)
    assertEquals(true, descriptor?.metaKey)
  }

  @Test
  fun `non alphanumeric keys are rejected so the page keeps the default`() {
    // 不为罕见键位堆映射表：返回 null，调用方回退 DEFAULT。
    assertNull(HotkeyDescriptor.from(KeyStroke.getKeyStroke(KeyEvent.VK_F7, 0)))
  }

  @Test
  fun `default descriptor matches the chrome extension hotkey`() {
    assertEquals("KeyT", HotkeyDescriptor.DEFAULT.code)
    assertTrue(HotkeyDescriptor.DEFAULT.altKey)
  }

  @Test
  fun `json payload uses the browser event field names`() {
    val json = HotkeyDescriptor.DEFAULT.toJson()
    assertEquals(
      """{"code":"KeyT","altKey":true,"ctrlKey":false,"shiftKey":false,"metaKey":false}""",
      json,
    )
  }

  @Test
  fun `action id constant is the literal that plugin xml must register`() {
    // 这条只钉常量字面值。「plugin.xml 里真的注册了这个 id」由 ActionStateTest 读
    // META-INF/plugin.xml 断言——写歪了 getShortcuts 返回空数组、不抛异常，页面兼底
    // 通道被静默关掉，是本文件里唯一「错了也不报错」的失败模式。
    assertEquals("EnglishSyntax.ParseHoveredBlock", HotkeyDescriptor.PARSE_HOVERED_BLOCK_ACTION_ID)
  }

  @Test
  fun `the plugin xml keystroke literal maps to the default descriptor`() {
    // plugin.xml 写的是 first-keystroke="alt T"，IDEA 按这个字面量解析成 KeyStroke。
    // 这条钉住「plugin.xml 的默认键位」与「下发给预览页的默认判据」一致——两者一旦分叉，
    // IDEA Action 通道与页面 keydown 兼底通道就会认不同的键。
    val stroke = KeyStroke.getKeyStroke("alt T")
    assertNotNull(stroke, "plugin.xml 的键位字面量必须能被 Swing 解析")
    assertEquals(HotkeyDescriptor.DEFAULT, HotkeyDescriptor.from(stroke))
  }

  @Test
  fun `legacy swing modifier masks are still recognised`() {
    // Swing 有两套修饰键位：旧的 InputEvent.ALT_MASK(8) 与新的 ALT_DOWN_MASK(512)。
    // KeyStroke 构造时会把两套位都补齐（实测 modifiers == 520，无论传哪个常量），
    // 所以只查 *_DOWN_MASK 是安全的。这条钉住这个前提，别哪天换成只查旧位就静默失配。
    @Suppress("DEPRECATION")
    val legacy = KeyStroke.getKeyStroke(KeyEvent.VK_T, InputEvent.ALT_MASK)
    assertEquals(HotkeyDescriptor.DEFAULT, HotkeyDescriptor.from(legacy))
  }

  @Test
  fun `letter and digit ranges map at both ends`() {
    // 'A' + (keyCode - VK_A) 这类算术最容易在区间两端出错，而上面的用例只覆盖了中间值。
    fun codeOf(keyCode: Int): String? = HotkeyDescriptor.from(KeyStroke.getKeyStroke(keyCode, 0))?.code
    assertEquals("KeyA", codeOf(KeyEvent.VK_A))
    assertEquals("KeyZ", codeOf(KeyEvent.VK_Z))
    assertEquals("Digit0", codeOf(KeyEvent.VK_0))
    assertEquals("Digit9", codeOf(KeyEvent.VK_9))
  }

  @Test
  fun `a bare letter key has every modifier false`() {
    // F7 那条用例在读 modifiers 之前就 return 了，「四个布尔全 false」这个组合原本没被走到。
    assertEquals(
      HotkeyDescriptor("KeyT", altKey = false, ctrlKey = false, shiftKey = false, metaKey = false),
      HotkeyDescriptor.from(KeyStroke.getKeyStroke(KeyEvent.VK_T, 0)),
    )
  }

  @Test
  fun `chord bindings are dropped instead of matching on their first stroke`() {
    // 两段式（Ctrl+X, Ctrl+P）：IDEA 要按完两段才触发 Action，页面 keydown 会在第一段
    // 就触发并 preventDefault 吃掉它——只取 firstKeyStroke 会让两条通道行为分叉，
    // 还顺手破坏用户的 chord。
    val chord = KeyboardShortcut(
      KeyStroke.getKeyStroke(KeyEvent.VK_X, InputEvent.CTRL_DOWN_MASK),
      KeyStroke.getKeyStroke(KeyEvent.VK_P, InputEvent.CTRL_DOWN_MASK),
    )
    assertNull(HotkeyDescriptor.fromShortcuts(arrayOf(chord)))
  }

  @Test
  fun `the first single stroke alphanumeric binding wins`() {
    val chord = KeyboardShortcut(
      KeyStroke.getKeyStroke(KeyEvent.VK_X, InputEvent.CTRL_DOWN_MASK),
      KeyStroke.getKeyStroke(KeyEvent.VK_P, InputEvent.CTRL_DOWN_MASK),
    )
    val functionKey = KeyboardShortcut(KeyStroke.getKeyStroke(KeyEvent.VK_F7, 0), null)
    val usable = KeyboardShortcut(KeyStroke.getKeyStroke("alt G"), null)
    assertEquals(
      HotkeyDescriptor("KeyG", altKey = true, ctrlKey = false, shiftKey = false, metaKey = false),
      HotkeyDescriptor.fromShortcuts(arrayOf(chord, functionKey, usable)),
    )
  }

  @Test
  fun `no usable binding means no page fallback at all`() {
    // 空数组 = 动作 id 写歪或用户清了绑定。**不能**回退 DEFAULT：那会让页面监听一个
    // 用户根本没绑的 Alt+T（幻影键位），按下去还会 preventDefault。
    assertNull(HotkeyDescriptor.fromShortcuts(emptyArray()))
    assertNull(HotkeyDescriptor.fromShortcuts(arrayOf(KeyboardShortcut(KeyStroke.getKeyStroke(KeyEvent.VK_F7, 0), null))))
  }
}
