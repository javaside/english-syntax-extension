package dev.codetui.englishsyntax.language

import dev.codetui.englishsyntax.domain.CoreComponent
import dev.codetui.englishsyntax.domain.Token
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * validator 内部的诊断坐标载体(与 TS `indexed-components.ts` 同构):
 * 「语义成分序列」与「模型所见 JSON 的 components 下标(rawIndex)」分离。
 *
 * rawIndex 只进错误路径,不进返回给渲染与缓存的 CoreAnalysis.components;
 * 否则 repair prompt 的错误会指向隔壁成分。
 */
internal data class RawComponentEntry(
  val rawIndex: Int,
  val value: JsonElement,
)

internal data class IndexedCoreComponent(
  val rawIndex: Int,
  val component: CoreComponent,
)

private fun JsonElement.componentObject(): JsonObject? = this as? JsonObject

/** 纯标点区间判据:与 TS `isPunctuationOnly` 逐条等价(含 safeInt 语义)。 */
private fun isPunctuationOnly(value: JsonElement, tokens: List<Token>): Boolean {
  val candidate = value.componentObject() ?: return false
  val start = candidate["startToken"].safeIndexInt() ?: return false
  val end = candidate["endToken"].safeIndexInt() ?: return false
  val covered = tokens.filter { it.id in start..end }
  return covered.isNotEmpty() && covered.first().id == start && covered.last().id == end &&
    covered.all { it.punctuation }
}

/** 与 AnalysisValidator.safeInt 同语义:拒绝字符串/非整数格式/超 Int 范围。 */
private fun JsonElement?.safeIndexInt(): Int? {
  val primitive = this as? JsonPrimitive ?: return null
  if (primitive.isString) return null
  val text = primitive.content
  if (!Regex("-?(0|[1-9][0-9]*)").matches(text)) return null
  return text.toLongOrNull()?.takeIf { it in Int.MIN_VALUE..Int.MAX_VALUE }?.toInt()
}

/** 先记录原始下标,再排除纯标点成分——顺序不能反。 */
internal fun rawComponentEntries(
  components: List<JsonElement>,
  tokens: List<Token>,
): List<RawComponentEntry> =
  components.mapIndexed { rawIndex, value -> RawComponentEntry(rawIndex, value) }
    .filterNot { isPunctuationOnly(it.value, tokens) }
