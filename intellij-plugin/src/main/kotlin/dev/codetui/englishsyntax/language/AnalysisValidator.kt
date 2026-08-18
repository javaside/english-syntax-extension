package dev.codetui.englishsyntax.language

import dev.codetui.englishsyntax.domain.CoreAnalysis
import dev.codetui.englishsyntax.domain.CoreComponent
import dev.codetui.englishsyntax.domain.DetailAnalysis
import dev.codetui.englishsyntax.domain.DetailStructure
import dev.codetui.englishsyntax.domain.GrammarRole
import dev.codetui.englishsyntax.domain.SentenceInput
import dev.codetui.englishsyntax.domain.Token
import dev.codetui.englishsyntax.domain.TokenRange
import dev.codetui.englishsyntax.domain.ValidationError
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

private val unsafeText = Regex("<script|<iframe|javascript:|\\u0000", RegexOption.IGNORE_CASE)

private val coreEnvelopeKeys = setOf("sentences")
private val coreSentenceKeys = setOf("sentenceId", "components")
private val coreComponentKeys = setOf("startToken", "endToken", "role", "translation")
private val detailEnvelopeKeys = setOf("sentenceId", "focus", "structures", "grammarPoints", "explanation")
private val detailFocusKeys = setOf("startToken", "endToken")
private val detailStructureKeys = setOf("startToken", "endToken", "role", "explanation", "translation")

/** A validation result never throws for malformed model JSON. */
sealed interface ValidationResult<out T> {
  data class Valid<T>(val value: T) : ValidationResult<T> {
    override val errors: List<ValidationError> = emptyList()
  }
  data class Invalid(override val errors: List<ValidationError>) : ValidationResult<Nothing>

  val ok: Boolean
    get() = this is Valid

  val errors: List<ValidationError>
}

private fun <T> valid(value: T): ValidationResult<T> = ValidationResult.Valid(value)
private fun invalid(errors: List<ValidationError>): ValidationResult<Nothing> = ValidationResult.Invalid(errors)

private fun error(path: String, message: String) = ValidationError(path, message)
private fun JsonObject.hasOnly(expected: Set<String>): Boolean = this.keys.all { it in expected }
private fun JsonElement.asObject(): JsonObject? = this as? JsonObject
private fun JsonElement.safeText(): String? = (this as? JsonPrimitive)
  ?.takeIf { it.isString }
  ?.contentOrNull
  ?.takeUnless { unsafeText.containsMatchIn(it) }

private fun JsonElement.safeInt(): Int? {
  val primitive = this as? JsonPrimitive ?: return null
  if (primitive.isString) return null
  val text = primitive.content
  if (!Regex("-?(0|[1-9][0-9]*)").matches(text)) return null
  return text.toLongOrNull()?.takeIf { it in Int.MIN_VALUE..Int.MAX_VALUE }?.toInt()
}

private fun parseRange(value: JsonObject, path: String, errors: MutableList<ValidationError>): TokenRange? {
  val start = value["startToken"]?.safeInt()
  val end = value["endToken"]?.safeInt()
  if (start == null) errors += error("$path.startToken", "must be a safe integer")
  if (end == null) errors += error("$path.endToken", "must be a safe integer")
  if (start == null || end == null) return null
  if (start < 0) errors += error("$path.startToken", "must be non-negative")
  if (end < 0) errors += error("$path.endToken", "must be non-negative")
  if (start > end) {
    errors += error(path, "token interval is reversed")
    return null
  }
  return TokenRange(start, end)
}

private fun tokenLength(tokens: List<Token>, range: TokenRange): Int = tokens
  .filter { it.id in range.startToken..range.endToken }
  .sumOf { it.leadingWhitespace.length + it.text.length }

private fun parseCoreComponent(
  value: JsonElement,
  tokens: List<Token>,
  path: String,
  errors: MutableList<ValidationError>,
): CoreComponent? {
  val objectValue = value.asObject()
  if (objectValue == null) {
    errors += error(path, "must be an object")
    return null
  }
  if (!objectValue.hasOnly(coreComponentKeys)) errors += error(path, "contains unknown fields")
  val range = parseRange(objectValue, path, errors)
  val roleText = objectValue["role"]?.safeText()
  if (roleText == null || runCatching { GrammarRole.valueOf(roleText) }.isFailure) {
    errors += error("$path.role", "must be a known grammar role")
  }
  val translation = objectValue["translation"]?.safeText()
  if (translation == null) {
    errors += error("$path.translation", "must be a safe string")
  } else if (translation.trim().isEmpty()) {
    errors += error("$path.translation", "must not be empty")
  } else if (range != null && translation.length > maxOf(500, tokenLength(tokens, range) * 8)) {
    errors += error("$path.translation", "is too long")
  }
  val role = roleText?.let { runCatching { GrammarRole.valueOf(it) }.getOrNull() }
  return if (range == null || role == null || translation == null || translation.trim().isEmpty()) null
  else CoreComponent(range.startToken, range.endToken, role, translation)
}

private fun parseCoreSentence(
  value: JsonElement,
  request: SentenceInput,
  index: Int,
  profileId: String,
  errors: MutableList<ValidationError>,
): CoreAnalysis? {
  val path = "sentences[$index]"
  val objectValue = value.asObject()
  if (objectValue == null) {
    errors += error(path, "must be an object")
    return null
  }
  if (!objectValue.hasOnly(coreSentenceKeys)) errors += error(path, "contains unknown fields")
  if (objectValue["sentenceId"]?.safeText() != request.sentenceId) {
    errors += error("$path.sentenceId", "does not match the requested sentence")
  }
  val componentsValue = objectValue["components"]
  if (componentsValue !is kotlinx.serialization.json.JsonArray || componentsValue.isEmpty()) {
    errors += error("$path.components", "must be a non-empty array")
    return null
  }
  val parsed = componentsValue.mapIndexed { componentIndex, component ->
    parseCoreComponent(component, request.tokens, "$path.components[$componentIndex]", errors)
  }
  var previousEnd = -1
  parsed.forEachIndexed { componentIndex, component ->
    if (component == null) return@forEachIndexed
    val componentPath = "$path.components[$componentIndex]"
    val covered = request.tokens.filter { it.id in component.startToken..component.endToken }
    if (covered.isEmpty() || covered.first().id != component.startToken || covered.last().id != component.endToken) {
      errors += error(componentPath, "token interval is outside the original sentence")
    }
    if (component.startToken <= previousEnd) {
      errors += error("$path.components", "components must be ordered and non-overlapping")
    }
    previousEnd = component.endToken
  }
  val valid = parsed.filterNotNull()
  request.tokens.forEach { token ->
    val coverage = valid.count { token.id in it.startToken..it.endToken }
    when {
      !token.punctuation && coverage == 0 -> errors += error("$path.components", "non-punctuation token ${token.id} is not covered")
      !token.punctuation && coverage > 1 -> errors += error("$path.components", "non-punctuation token ${token.id} is covered more than once")
      token.punctuation && coverage > 1 -> errors += error("$path.components", "punctuation token ${token.id} is covered more than once")
    }
  }
  return if (errors.any { it.path == path || it.path.startsWith("$path.") } || valid.size != parsed.size) null
  else CoreAnalysis(sentenceId = request.sentenceId, components = valid, modelProfileId = profileId)
}

fun validateCoreBatch(raw: JsonElement, requests: List<SentenceInput>, profileId: String): ValidationResult<List<CoreAnalysis>> {
  return try {
    val errors = mutableListOf<ValidationError>()
    val envelope = raw.asObject() ?: return invalid(listOf(error("", "must be an object")))
  if (!envelope.hasOnly(coreEnvelopeKeys)) errors += error("", "contains unknown fields")
  val sentences = envelope["sentences"]
  if (sentences !is JsonArray) return invalid(errors + error("sentences", "must be an array"))
  val requestById = requests.associateBy { it.sentenceId }
  val seen = mutableSetOf<String>()
  val analyses = mutableMapOf<String, CoreAnalysis>()
  sentences.forEachIndexed { index, value ->
    val objectValue = value.asObject()
    val id = objectValue?.get("sentenceId")?.safeText()
    if (id == null) {
      errors += error("sentences[$index].sentenceId", "must be a safe string")
      return@forEachIndexed
    }
    val request = requestById[id]
    if (request == null) {
      errors += error("sentences[$index].sentenceId", "was not requested")
      return@forEachIndexed
    }
    if (!seen.add(id)) {
      errors += error("sentences[$index].sentenceId", "is duplicated")
      return@forEachIndexed
    }
    parseCoreSentence(objectValue, request, index, profileId, errors)?.let { analysis ->
      analyses[id] = analysis.copy(components = analysis.components.filterNot { component ->
        request.tokens.filter { it.id in component.startToken..component.endToken }.all { it.punctuation }
      })
    }
  }
  requests.forEach { if (it.sentenceId !in seen) errors += error("sentences", "requested sentence ${it.sentenceId} is missing") }
  if (errors.isNotEmpty()) invalid(errors)
  else valid(requests.map { analyses.getValue(it.sentenceId) })
} catch (exception: Exception) {
    invalid(listOf(error("", "invalid JSON structure")))
  }
}

private fun parseDetailStructure(value: JsonElement, tokens: List<Token>, path: String, errors: MutableList<ValidationError>): DetailStructure? {
  val objectValue = value.asObject()
  if (objectValue == null) {
    errors += error(path, "must be an object")
    return null
  }
  if (!objectValue.hasOnly(detailStructureKeys)) errors += error(path, "contains unknown fields")
  val range = parseRange(objectValue, path, errors)
  if (range != null && (tokens.none { it.id == range.startToken } || tokens.none { it.id == range.endToken })) {
    errors += error(path, "token interval is outside the original sentence")
  }
  val role = objectValue["role"]?.safeText()
  if (role == null || role.trim().isEmpty()) errors += error("$path.role", "must be a non-empty safe string")
  val explanation = objectValue["explanation"]?.safeText()
  if (explanation == null || explanation.trim().isEmpty()) errors += error("$path.explanation", "must be a non-empty safe string")
  val translationElement = objectValue["translation"]
  val translation = translationElement?.safeText()
  if (translationElement != null && translation == null) errors += error("$path.translation", "must be a safe string when present")
  if (range == null || role == null || role.trim().isEmpty() || explanation == null || explanation.trim().isEmpty() || (translationElement != null && translation == null)) return null
  return DetailStructure(range.startToken, range.endToken, role, explanation, translation?.takeUnless { it.trim().isEmpty() })
}

fun validateDetail(raw: JsonElement, request: SentenceInput, requestedFocus: TokenRange, profileId: String): ValidationResult<DetailAnalysis> = try {
  val errors = mutableListOf<ValidationError>()
  val envelope = raw.asObject() ?: return invalid(listOf(error("", "must be an object")))
  if (!envelope.hasOnly(detailEnvelopeKeys)) errors += error("", "contains unknown fields")
  if (envelope["sentenceId"]?.safeText() != request.sentenceId) errors += error("sentenceId", "does not match the requested sentence")
  val focusValue = envelope["focus"]
  val focus = if (focusValue is JsonObject && focusValue.hasOnly(detailFocusKeys)) parseRange(focusValue, "focus", errors) else {
    errors += error("focus", "must be a token interval")
    null
  }
  if (focus != null && (focus.startToken != requestedFocus.startToken || focus.endToken != requestedFocus.endToken)) errors += error("focus", "must match the requested focus")
  val structuresValue = envelope["structures"]
  val structures = if (structuresValue is kotlinx.serialization.json.JsonArray) structuresValue.mapIndexedNotNull { i, value -> parseDetailStructure(value, request.tokens, "structures[$i]", errors) } else {
    errors += error("structures", "must be an array")
    emptyList()
  }
  val pointsValue = envelope["grammarPoints"]
  val grammarPoints = if (pointsValue is kotlinx.serialization.json.JsonArray) {
    if (pointsValue.size > 12) errors += error("grammarPoints", "must contain at most 12 items")
    pointsValue.mapIndexedNotNull { i, point ->
      val text = point.safeText()
      if (text == null || text.trim().isEmpty() || text.length > 300) {
        errors += error("grammarPoints[$i]", "must be a non-empty safe string of at most 300 characters")
        null
      } else text
    }
  } else {
    errors += error("grammarPoints", "must be an array")
    emptyList()
  }
  val explanation = envelope["explanation"]?.safeText()
  if (explanation == null || explanation.trim().isEmpty()) errors += error("explanation", "must be a non-empty safe string")
  if (errors.isNotEmpty() || focus == null || explanation == null) invalid(errors)
  else valid(DetailAnalysis(request.sentenceId, focus, structures, grammarPoints, explanation, profileId))
} catch (exception: Exception) {
  invalid(listOf(error("", "invalid JSON structure")))
}
