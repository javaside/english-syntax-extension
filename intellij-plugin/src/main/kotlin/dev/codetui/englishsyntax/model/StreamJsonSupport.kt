package dev.codetui.englishsyntax.model

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

internal val streamJson = Json { ignoreUnknownKeys = true }

internal fun parseStreamString(literal: String): String? {
  if (!literal.startsWith('"') || !literal.endsWith('"') || literal.length < 2) return null
  return try {
    val value = streamJson.parseToJsonElement(literal)
    (value as? JsonPrimitive)?.takeIf { it.isString }?.content
  } catch (_: Exception) {
    null
  }
}

internal fun parseStreamObject(text: String): JsonObject? {
  return try {
    streamJson.parseToJsonElement(text) as? JsonObject
  } catch (_: Exception) {
    null
  }
}
