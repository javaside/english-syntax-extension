package dev.codetui.englishsyntax.bridge

import java.awt.event.InputEvent
import java.awt.event.KeyEvent
import javax.swing.KeyStroke
import kotlin.test.Test
import kotlin.test.assertEquals
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
}
