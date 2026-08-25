package dev.codetui.englishsyntax.bridge

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
  fun `action id matches the id registered in plugin xml`() {
    assertEquals("EnglishSyntax.ParseHoveredBlock", HotkeyDescriptor.PARSE_HOVERED_BLOCK_ACTION_ID)
  }

  @Test
  fun `the plugin xml keystroke literal maps to the default descriptor`() {
    // plugin.xml 写的是 first-keystroke="alt T"，IDEA 按这个字面量解析成 KeyStroke。
    // 这条钉住「plugin.xml 的默认键位」与「下发给预览页的默认判据」一致——两者一旦分叉，
    // IDEA Action 通道与页面 keydown 兼底通道就会认不同的键，而 fromKeymap 对认不出的
    // 键位是静默回退 DEFAULT，不会有任何报错。
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
}
