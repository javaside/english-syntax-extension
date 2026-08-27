package dev.codetui.englishsyntax.cache

import dev.codetui.englishsyntax.contract.FixtureLoader
import dev.codetui.englishsyntax.domain.TokenRange
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals

class CacheKeysTest {
  @Test
  fun `matches shared cache key vectors`() {
    val vectors = Json.parseToJsonElement(FixtureLoader.text("cache-key-vectors.json")).jsonArray
    for (vector in vectors) {
      val item = vector.jsonObject
      val input = item.getValue("input").jsonObject
      val focus = input["focus"]?.jsonObject
      val key = createCoreCacheKey(
        CoreCacheKeyInput(
          normalizedSentence = input.getValue("normalizedSentence").jsonPrimitive.content,
          schemaVersion = input.getValue("schemaVersion").jsonPrimitive.content.toInt(),
          promptVersion = input.getValue("promptVersion").jsonPrimitive.content.toInt(),
          focus = focus?.let { TokenRange(it.getValue("startToken").jsonPrimitive.content.toInt(), it.getValue("endToken").jsonPrimitive.content.toInt()) },
        ),
      )
      assertEquals(item.getValue("expected").jsonPrimitive.content, key, item.getValue("name").jsonPrimitive.content)
    }
  }

  @Test
  fun `detail focus changes the key`() {
    val base = CoreCacheKeyInput("The service validates every response.", 1, 4)
    val withFocus = base.copy(focus = TokenRange(2, 4))
    assertEquals(createCoreCacheKey(base), createCoreCacheKey(base))
    check(createCoreCacheKey(base) != createCoreCacheKey(withFocus))
  }

  /** 提示词版本进键：改了成分粒度规则，旧粒度的缓存必须失效而不是继续显示。 */
  @Test
  fun `prompt version changes the key`() {
    val base = CoreCacheKeyInput("The service validates every response.", 1, 4)
    check(createCoreCacheKey(base) != createCoreCacheKey(base.copy(promptVersion = 5)))
  }
}
