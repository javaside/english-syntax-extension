package dev.codetui.englishsyntax

import kotlin.test.Test
import kotlin.test.assertEquals

class PluginIdentityTest {
  @Test
  fun `plugin identity stays stable`() {
    assertEquals("dev.codetui.english-syntax-idea", PluginIdentity.ID)
    assertEquals("English Syntax Learning", PluginIdentity.DISPLAY_NAME)
  }
}
