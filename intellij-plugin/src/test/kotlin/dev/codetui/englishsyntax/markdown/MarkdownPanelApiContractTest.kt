package dev.codetui.englishsyntax.markdown

import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * 源码契约：官方 Markdown JCEF 面板只经**平台**类型 `com.intellij.ui.jcef.JCEFHtmlPanel`
 * 引用，绝不引用 Markdown 插件的具体面板类。
 *
 * 2026-11 真机：IDEA 2026.2 把 Markdown 插件模块化，`MarkdownJCEFHtmlPanel` 从
 * `org.intellij.plugins.markdown.ui.preview.jcef` 迁到 `com.intellij.markdown.jcef.preview`
 * （intellij.markdown.jcef content module）。插件按 2025.1 编译时旧 FQN 存在、
 * 运行时已消失 → Option+T 直接 NoClassDefFoundError（actions → findPanel 的
 * `as? MarkdownJCEFHtmlPanel` 处）。我们对面板的全部用法（getUserData/putUserData、
 * Disposer、jbCefClient、cefBrowser）都在平台基类上——新旧官方面板都继承它，
 * 引用具体类本身就是多余的编译期耦合。此测试红 = 有人又把具体类引回来了。
 */
class MarkdownPanelApiContractTest {

  @Test
  fun `panel is referenced only via the platform JCEFHtmlPanel supertype`() {
    val source = readPanelSource()
    assertTrue(
      "import com.intellij.ui.jcef.JCEFHtmlPanel" in source,
      "应 import 平台 JCEFHtmlPanel 作为面板接缝",
    )
    assertFalse(
      "org.intellij.plugins.markdown.ui.preview.jcef" in source,
      "禁止引用 Markdown 插件具体面板类的旧包名（IDEA 2026.2 已迁走，运行时 NoClassDefFoundError）",
    )
    assertFalse(
      "com.intellij.markdown.jcef.preview" in source,
      "也不引用新包名——绑定任一具体 FQN 都会在下一次模块化时再断",
    )
  }

  private fun readPanelSource(): String {
    val start = Path.of(System.getProperty("user.dir")).toAbsolutePath().normalize()
    val root = generateSequence(start) { it.parent }
      .firstOrNull { Files.isRegularFile(it.resolve("intellij-plugin/build.gradle.kts")) }
      ?: error("Could not locate repository root from $start")
    return Files.readString(
      root.resolve("intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/markdown/EnglishSyntaxPreviewPanel.kt"),
    )
  }
}
