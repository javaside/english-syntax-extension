package dev.codetui.englishsyntax

import com.intellij.DynamicBundle
import org.jetbrains.annotations.PropertyKey
import java.util.ResourceBundle

private const val ENGLISH_SYNTAX_BUNDLE = "messages.EnglishSyntaxBundle"

object EnglishSyntaxBundle : DynamicBundle(ENGLISH_SYNTAX_BUNDLE) {

  @JvmStatic
  fun message(@PropertyKey(resourceBundle = ENGLISH_SYNTAX_BUNDLE) key: String, vararg params: Any): String =
    getMessage(key, *params)

  @JvmStatic
  fun bundle(): ResourceBundle = ResourceBundle.getBundle(ENGLISH_SYNTAX_BUNDLE)
}
