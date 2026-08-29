package dev.codetui.englishsyntax.domain

import kotlinx.serialization.Serializable

object ContractVersions {
  const val MESSAGE = 1
  const val CORE_SCHEMA = 3
  const val CORE_PROMPT = 6
  const val DETAIL_PROMPT = 5
  const val MAX_SENTENCES_PER_REQUEST = 6
  const val CLOUD_SENTENCES_PER_REQUEST = 2
}

@Serializable
enum class GrammarRole {
  SUBJECT,
  PREDICATE,
  OBJECT,
  PREDICATIVE,
  ATTRIBUTE,
  ADVERBIAL,
  COMPLEMENT,
  APPOSITIVE,
  SUBJECT_CLAUSE,
  OBJECT_CLAUSE,
  PREDICATIVE_CLAUSE,
  ATTRIBUTIVE_CLAUSE,
  ADVERBIAL_CLAUSE,
  INDEPENDENT_ELEMENT,
  COORDINATE_CLAUSE,
  CONJUNCTION,
}

val GRAMMAR_LABELS: Map<GrammarRole, String> = mapOf(
  GrammarRole.SUBJECT to "主语",
  GrammarRole.PREDICATE to "谓语",
  GrammarRole.OBJECT to "宾语",
  GrammarRole.PREDICATIVE to "表语",
  GrammarRole.ATTRIBUTE to "定语",
  GrammarRole.ADVERBIAL to "状语",
  GrammarRole.COMPLEMENT to "补语",
  GrammarRole.APPOSITIVE to "同位语",
  GrammarRole.SUBJECT_CLAUSE to "主语从句",
  GrammarRole.OBJECT_CLAUSE to "宾语从句",
  GrammarRole.PREDICATIVE_CLAUSE to "表语从句",
  GrammarRole.ATTRIBUTIVE_CLAUSE to "定语从句",
  GrammarRole.ADVERBIAL_CLAUSE to "状语从句",
  GrammarRole.INDEPENDENT_ELEMENT to "独立成分",
  GrammarRole.COORDINATE_CLAUSE to "并列分句",
  GrammarRole.CONJUNCTION to "并列连词",
)

@Serializable
enum class ErrorCode {
  CONFIG_MISSING,
  HOST_PERMISSION_DENIED,
  AUTH_FAILED,
  MODEL_NOT_FOUND,
  RATE_LIMITED,
  NETWORK_ERROR,
  REQUEST_TIMEOUT,
  INVALID_MODEL_OUTPUT,
  MALFORMED_MESSAGE,
  UNSUPPORTED_PAGE,
  UNSAFE_CONTENT_BLOCK,
  SENTENCE_TOO_LONG,
  REQUEST_CANCELLED,
  NO_CACHE,
}

@Serializable
data class Token(
  val id: Int,
  val text: String,
  val start: Int,
  val end: Int,
  val leadingWhitespace: String,
  val punctuation: Boolean,
)

@Serializable
data class TokenRange(val startToken: Int, val endToken: Int)

@Serializable
data class SentenceInput(val sentenceId: String, val text: String, val tokens: List<Token>)

@Serializable
data class CoreComponent(
  val startToken: Int,
  val endToken: Int,
  val role: GrammarRole,
  val translation: String,
)

@Serializable
data class CoreAnalysis(
  val schemaVersion: Int = ContractVersions.CORE_SCHEMA,
  val sentenceId: String,
  val components: List<CoreComponent>,
  val modelProfileId: String,
)

@Serializable
data class DetailStructure(
  val startToken: Int,
  val endToken: Int,
  val role: String,
  val explanation: String,
  val translation: String? = null,
)

@Serializable
data class DetailAnalysis(
  val sentenceId: String,
  val focus: TokenRange,
  val structures: List<DetailStructure>,
  val grammarPoints: List<String>,
  val explanation: String,
  val modelProfileId: String,
)

@Serializable
data class ValidationError(val path: String, val message: String)

sealed interface FailureDetail {
  data class StringValue(val value: String) : FailureDetail
  data class NumberValue(val value: Number) : FailureDetail
  data class BooleanValue(val value: Boolean) : FailureDetail
}

data class ExtensionFailure(
  val code: ErrorCode,
  override val message: String,
  val retryable: Boolean,
  val details: Map<String, FailureDetail> = emptyMap(),
) : RuntimeException(message)
