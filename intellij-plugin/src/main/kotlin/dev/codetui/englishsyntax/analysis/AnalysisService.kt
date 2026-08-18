package dev.codetui.englishsyntax.analysis

import dev.codetui.englishsyntax.cache.AnalysisCache
import dev.codetui.englishsyntax.cache.CacheStore
import dev.codetui.englishsyntax.cache.CoreCacheKeyInput
import dev.codetui.englishsyntax.cache.createCoreCacheKey
import dev.codetui.englishsyntax.domain.ContractVersions
import dev.codetui.englishsyntax.domain.CoreAnalysis
import dev.codetui.englishsyntax.domain.CoreComponent
import dev.codetui.englishsyntax.domain.DetailAnalysis
import dev.codetui.englishsyntax.domain.DetailStructure
import dev.codetui.englishsyntax.domain.ErrorCode
import dev.codetui.englishsyntax.domain.ExtensionFailure
import dev.codetui.englishsyntax.domain.GrammarRole
import dev.codetui.englishsyntax.domain.SentenceInput
import dev.codetui.englishsyntax.domain.TokenRange
import dev.codetui.englishsyntax.domain.ValidationError
import dev.codetui.englishsyntax.language.ValidationResult
import dev.codetui.englishsyntax.language.validateCoreBatch
import dev.codetui.englishsyntax.language.validateDetail
import dev.codetui.englishsyntax.model.ChatMessage
import dev.codetui.englishsyntax.model.JsonSchemaSpec
import dev.codetui.englishsyntax.model.OpenAiCompatibleClient
import dev.codetui.englishsyntax.model.StreamedComponent
import dev.codetui.englishsyntax.model.buildCorePrompt
import dev.codetui.englishsyntax.model.buildDetailPrompt
import dev.codetui.englishsyntax.model.buildRepairPrompt
import dev.codetui.englishsyntax.model.isLoopbackBaseUrl
import dev.codetui.englishsyntax.model.serialize
import dev.codetui.englishsyntax.model.serializeSentence
import dev.codetui.englishsyntax.model.toJsonElement
import dev.codetui.englishsyntax.scheduler.RequestScheduler
import dev.codetui.englishsyntax.scheduler.ScheduledRequest
import dev.codetui.englishsyntax.scheduler.SchedulerPriority
import dev.codetui.englishsyntax.settings.ModelProfile
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

data class AnalysisFailure(
  val sentenceId: String,
  val error: ExtensionFailure,
)

data class CoreBatchOutcome(
  val result: List<CoreAnalysis>,
  val failures: List<AnalysisFailure>,
  val cacheHit: Boolean,
)

data class DetailOutcome(
  val result: DetailAnalysis,
  val cacheHit: Boolean,
)

/** 累积上报某句已接受的暂定成分；每次给的都是完整列表，渲染端整句重画即可。 */
fun interface StreamedComponentSink {
  fun accept(sentenceId: String, components: List<CoreComponent>)
}

/** 累积上报本次详解已完成的结构；每次给的都是完整列表。 */
fun interface StreamedStructureSink {
  fun accept(sentenceId: String, focus: TokenRange, structures: List<DetailStructure>)
}

/**
 * 核心编排：查缓存 → 按端点分块 → Prompt → 调度 → 校验 → 一次修复 → 写缓存。
 * 与 Chrome 端 `analysis-service.ts` 同一骨架。
 */
class AnalysisService(
  private val client: OpenAiCompatibleClient,
  private val cache: AnalysisCache,
  private val scheduler: RequestScheduler,
) {
  private val coreSchema = JsonSchemaSpec(
    name = "core_analysis",
    schema = buildJsonObject {
      put("type", "object")
      put("additionalProperties", false)
      put("required", "sentences")
      put("sentences", buildJsonObject {
        put("type", "array")
        put("items", buildJsonObject {
          put("type", "object")
          put("additionalProperties", false)
          put("required", "sentenceId")
          put("required", "components")
          put("sentenceId", buildJsonObject { put("type", "string") })
          put("components", buildJsonObject {
            put("type", "array")
            put("minItems", 1)
            put("items", buildJsonObject {
              put("type", "object")
              put("additionalProperties", false)
              put("required", "startToken")
              put("required", "endToken")
              put("required", "role")
              put("required", "translation")
              put("startToken", buildJsonObject { put("type", "integer"); put("minimum", 0) })
              put("endToken", buildJsonObject { put("type", "integer"); put("minimum", 0) })
              put("role", buildJsonObject {
                put("type", "string")
                put("enum", buildJsonArray { GrammarRole.entries.forEach { add(JsonPrimitive(it.name)) } })
              })
              put("translation", buildJsonObject { put("type", "string"); put("minLength", 1) })
            })
          })
        })
      })
    },
  )

  private val detailSchema = JsonSchemaSpec(
    name = "detail_analysis",
    schema = buildJsonObject {
      put("type", "object")
      put("additionalProperties", false)
      put("required", "sentenceId")
      put("required", "focus")
      put("required", "structures")
      put("required", "grammarPoints")
      put("required", "explanation")
      put("sentenceId", buildJsonObject { put("type", "string") })
      put("focus", buildJsonObject {
        put("type", "object")
        put("additionalProperties", false)
        put("required", "startToken")
        put("required", "endToken")
        put("startToken", buildJsonObject { put("type", "integer"); put("minimum", 0) })
        put("endToken", buildJsonObject { put("type", "integer"); put("minimum", 0) })
      })
      put("structures", buildJsonObject {
        put("type", "array")
        put("items", buildJsonObject {
          put("type", "object")
          put("additionalProperties", false)
          put("required", "startToken")
          put("required", "endToken")
          put("required", "role")
          put("required", "explanation")
          put("startToken", buildJsonObject { put("type", "integer"); put("minimum", 0) })
          put("endToken", buildJsonObject { put("type", "integer"); put("minimum", 0) })
          put("role", buildJsonObject { put("type", "string"); put("minLength", 1) })
          put("explanation", buildJsonObject { put("type", "string"); put("minLength", 1) })
          put("translation", buildJsonObject { put("type", "string"); put("minLength", 1); put("maxLength", 120) })
        })
      })
      put("grammarPoints", buildJsonObject {
        put("type", "array")
        put("maxItems", 12)
        put("items", buildJsonObject { put("type", "string"); put("minLength", 1); put("maxLength", 300) })
      })
      put("explanation", buildJsonObject { put("type", "string"); put("minLength", 1) })
    },
  )

  private val serializeMutex = Mutex()
  private val json = Json { prettyPrint = false }

  suspend fun analyzeCore(
    profile: ModelProfile,
    documentId: String,
    sentences: List<SentenceInput>,
    priority: SchedulerPriority = SchedulerPriority.ACTIVE_VISIBLE_CORE,
    bypassCache: Boolean = false,
    onStreamedComponent: StreamedComponentSink? = null,
  ): CoreBatchOutcome {
    val keyed = sentences.map { sentence ->
      sentence to createCoreCacheKey(CoreCacheKeyInput(normalize(sentence.text), ContractVersions.CORE_SCHEMA))
    }
    val cached: List<JsonObject?> = if (bypassCache) {
      keyed.map { null }
    } else {
      keyed.map { (_, key) -> cache.getCore(key) }
    }

    val results = mutableMapOf<String, CoreAnalysis>()
    val missing = mutableListOf<Pair<SentenceInput, String>>()
    keyed.forEachIndexed { index, (sentence, key) ->
      val value = cached[index]?.let { raw ->
        validateCoreBatch(raw, listOf(sentence), CACHE_ONLY_PROFILE_ID).let { result ->
          (result as? ValidationResult.Valid)?.value?.firstOrNull()
        }
      }
      if (value == null) missing += sentence to key
      else results[sentence.sentenceId] = value.copy(modelProfileId = profile.id)
    }
    if (missing.isEmpty()) {
      return CoreBatchOutcome(sentences.map { results.getValue(it.sentenceId) }, emptyList(), cacheHit = true)
    }

    val perRequest = if (isLoopbackBaseUrl(profile.baseUrl)) {
      ContractVersions.MAX_SENTENCES_PER_REQUEST
    } else {
      ContractVersions.CLOUD_SENTENCES_PER_REQUEST
    }
    val chunks = missing.chunked(perRequest)
    val settled = coroutineScope {
      chunks.map { chunk -> async { analyzeCoreChunk(profile, documentId, chunk, priority, onStreamedComponent) } }.awaitAll()
    }

    val failuresBySentence = mutableMapOf<String, AnalysisFailure>()
    settled.forEach { outcome ->
      outcome.valid.forEach { analysis -> results[analysis.sentenceId] = analysis }
      outcome.invalid.forEach { (sentence, errors) ->
        failuresBySentence[sentence.sentenceId] = AnalysisFailure(
          sentence.sentenceId,
          invalidOutput(errors),
        )
      }
    }
    return CoreBatchOutcome(
      result = sentences.mapNotNull { results[it.sentenceId] },
      failures = sentences.mapNotNull { failuresBySentence[it.sentenceId] },
      cacheHit = false,
    )
  }

  suspend fun lookupCore(sentences: List<SentenceInput>): List<CoreAnalysis> {
    return sentences.mapNotNull { sentence ->
      val key = createCoreCacheKey(CoreCacheKeyInput(normalize(sentence.text), ContractVersions.CORE_SCHEMA))
      val raw = cache.getCore(key) ?: return@mapNotNull null
      validateCoreBatch(raw, listOf(sentence), CACHE_ONLY_PROFILE_ID).let { result ->
        (result as? ValidationResult.Valid)?.value?.firstOrNull()
      }
    }
  }

  suspend fun analyzeDetail(
    profile: ModelProfile,
    documentId: String,
    sentence: SentenceInput,
    core: CoreAnalysis,
    focus: TokenRange,
    onStreamedStructure: StreamedStructureSink? = null,
  ): DetailOutcome {
    val key = detailKey(sentence, focus)
    val cachedRaw = cache.getDetail(key)
    val cached = cachedRaw?.let { raw ->
      validateDetail(raw, sentence, focus, CACHE_ONLY_PROFILE_ID).let { result ->
        (result as? ValidationResult.Valid)?.value
      }
    }
    if (cached != null) return DetailOutcome(cached.copy(modelProfileId = profile.id), cacheHit = true)

    val provisional = onStreamedStructure?.let { ProvisionalStructures(sentence.tokens.size) }
    val raw = request(
      profile,
      documentId,
      SchedulerPriority.DETAIL_CLICK,
      key,
      listOf(ChatMessage("user", buildDetailPrompt(sentence, core, focus))),
      detailSchema,
      onDetailStreamed = if (provisional != null) {
        { streamed ->
          val accepted = provisional.accept(streamed)
          if (accepted != null) onStreamedStructure!!.accept(sentence.sentenceId, focus, accepted)
        }
      } else {
        null
      },
    )
    var validation = validateDetail(raw, sentence, focus, profile.id)
    if (validation is ValidationResult.Invalid) {
      val repairRaw = request(
        profile,
        documentId,
        SchedulerPriority.DETAIL_CLICK,
        "${key}:repair",
        listOf(ChatMessage("user", detailRepairPrompt(sentence, core, focus, validation.errors, raw))),
        detailSchema,
        jumpQueue = true,
      )
      validation = validateDetail(repairRaw, sentence, focus, profile.id)
    }
    val valid = validation as? ValidationResult.Valid
      ?: throw invalidOutput((validation as ValidationResult.Invalid).errors)
    serializeMutex.withLock { cache.putDetail(key, profile.id, detailToJson(valid.value)) }
    return DetailOutcome(valid.value, cacheHit = false)
  }

  suspend fun lookupDetail(sentence: SentenceInput, focus: TokenRange): DetailAnalysis? {
    val raw = cache.getDetail(detailKey(sentence, focus)) ?: return null
    return validateDetail(raw, sentence, focus, CACHE_ONLY_PROFILE_ID).let { result ->
      (result as? ValidationResult.Valid)?.value
    }
  }

  suspend fun cancelDocument(documentId: String) = scheduler.cancelDocument(documentId)

  private suspend fun analyzeCoreChunk(
    profile: ModelProfile,
    documentId: String,
    chunk: List<Pair<SentenceInput, String>>,
    priority: SchedulerPriority,
    onStreamedComponent: StreamedComponentSink?,
  ): ChunkOutcome {
    val sentences = chunk.map { it.first }
    val provisional = onStreamedComponent?.let {
      ProvisionalComponents(chunk.associate { (sentence, _) -> sentence.sentenceId to sentence.tokens.size })
    }
    val raw = request(
      profile,
      documentId,
      priority,
      chunk.joinToString(":") { it.second },
      listOf(ChatMessage("user", buildCorePrompt(sentences))),
      coreSchema,
      onComponent = if (provisional != null) {
        { streamed ->
          val accepted = provisional.accept(streamed)
          if (accepted != null) onStreamedComponent!!.accept(streamed.sentenceId, accepted)
        }
      } else {
        null
      },
    )
    val firstPass = validateAndCacheCore(profile, chunk, raw)
    var invalid = firstPass.invalid
    if (invalid.isNotEmpty()) {
      val repairRaw = request(
        profile,
        documentId,
        priority,
        "${chunk.joinToString(":") { it.second }}:repair",
        listOf(
          ChatMessage(
            "user",
            buildRepairPrompt(
              invalid.map { it.first },
              invalid.flatMap { it.second },
              invalidRawSubset(raw, invalid.map { it.first.sentenceId }.toSet()),
            ),
          ),
        ),
        coreSchema,
        jumpQueue = true,
      )
      val keysById = chunk.associate { (sentence, key) -> sentence.sentenceId to key }
      val repaired = validateAndCacheCore(
        profile,
        invalid.map { it.first to (keysById[it.first.sentenceId] ?: error("missing key")) },
        repairRaw,
      )
      return ChunkOutcome(firstPass.valid + repaired.valid, repaired.invalid)
    }
    return ChunkOutcome(firstPass.valid, invalid)
  }

  private data class ChunkOutcome(
    val valid: List<CoreAnalysis>,
    val invalid: List<Pair<SentenceInput, List<ValidationError>>>,
  )

  private suspend fun validateAndCacheCore(
    profile: ModelProfile,
    entries: List<Pair<SentenceInput, String>>,
    raw: JsonElement,
  ): ChunkOutcome {
    val valid = mutableListOf<CoreAnalysis>()
    val invalid = mutableListOf<Pair<SentenceInput, List<ValidationError>>>()
    for ((sentence, key) in entries) {
      // 与 TS 端 matchingRawSentences 相同：按句过滤，批次里其它句不产生
      // "was not requested" 噪音——块内兄弟句本来就共享一个 envelope。
      val sentenceRaw = matchingSentenceRaw(raw, sentence.sentenceId)
      when (val validation = validateCoreBatch(sentenceRaw, listOf(sentence), profile.id)) {
        is ValidationResult.Valid -> {
          valid += validation.value.first()
          cache.putCore(key, profile.id, analysisToJson(validation.value.first()))
        }
        is ValidationResult.Invalid -> invalid += sentence to validation.errors
      }
    }
    return ChunkOutcome(valid, invalid)
  }

  private fun matchingSentenceRaw(raw: JsonElement, sentenceId: String): JsonElement {
    val sentences = (raw as? JsonObject)?.get("sentences") as? JsonArray ?: return buildJsonObject { }
    return buildJsonObject {
      put(
        "sentences",
        buildJsonArray {
          sentences.forEach { candidate ->
            val id = (candidate as? JsonObject)?.get("sentenceId")?.jsonPrimitiveOrNull?.contentOrNull
            if (id == sentenceId) add(candidate)
          }
        },
      )
    }
  }

  /** 与 Chrome 端同款：请求经调度器；流式 sink 存在则走流式路径。 */
  private suspend fun request(
    profile: ModelProfile,
    documentId: String,
    priority: SchedulerPriority,
    cacheKey: String,
    messages: List<ChatMessage>,
    schema: JsonSchemaSpec,
    jumpQueue: Boolean = false,
    onComponent: ((StreamedComponent) -> Unit)? = null,
    onDetailStreamed: ((kotlinx.serialization.json.JsonObject) -> Unit)? = null,
  ): JsonElement {
    return scheduler.schedule(
      ScheduledRequest(
        cacheKey = cacheKey,
        documentId = documentId,
        priority = priority,
        sentenceCount = 1,
        jumpQueue = jumpQueue,
      ),
    ) {
      when {
        onComponent != null ->
          client.completeCoreStreaming(profile, messages, schema) { streamed -> onComponent(streamed) }
        onDetailStreamed != null ->
          client.completeDetailStreaming(profile, messages, schema) { structure -> onDetailStreamed(structure) }
        else -> client.completeJson(profile, messages, schema)
      }
    }
  }

  private fun detailRepairPrompt(
    sentence: SentenceInput,
    core: CoreAnalysis,
    focus: TokenRange,
    errors: List<ValidationError>,
    invalidJson: JsonElement,
  ): String = listOf(
    "Repair only the structure of the invalid detail-analysis JSON.",
    "Keep the sentence ID, Tokens, verified core analysis, and focus unchanged. Return JSON only.",
    "Selected sentence:",
    serializeSentence(sentence),
    "Verified core result:",
    serialize(core.toJsonElement()),
    "Focus:",
    serialize(focus.toJsonElement()),
    "Validation errors:",
    serialize(errors.toJsonElement()),
    "Invalid JSON:",
    serialize(invalidJson),
  ).joinToString("\n\n")

  companion object {
    private val promptJson = Json { prettyPrint = false; encodeDefaults = true }
    private const val CACHE_ONLY_PROFILE_ID = "cached"

    private fun List<ValidationError>.toJsonElement(): JsonElement = buildJsonArray {
      forEach { error ->
        add(
          buildJsonObject {
            put("path", error.path)
            put("message", error.message)
          },
        )
      }
    }

    private fun normalize(text: String): String = text.trim().replace(Regex("\\s+"), " ")

    private fun detailKey(sentence: SentenceInput, focus: TokenRange): String = createCoreCacheKey(
      CoreCacheKeyInput(normalize(sentence.text), ContractVersions.CORE_SCHEMA, focus),
    )

    private fun invalidOutput(errors: List<ValidationError>): ExtensionFailure {
      val summary = errors.joinToString("; ") { "${it.path.ifEmpty { "output" }}: ${it.message}" }
      return ExtensionFailure(
        ErrorCode.INVALID_MODEL_OUTPUT,
        "Model output remained invalid after one repair${if (summary.isEmpty()) "" else ": $summary"}",
        false,
      )
    }

    private fun invalidRawSubset(raw: JsonElement, sentenceIds: Set<String>): JsonElement {
      val sentences = (raw as? JsonObject)?.get("sentences") as? JsonArray ?: return JsonObject(emptyMap())
      return buildJsonObject {
        put(
          "sentences",
          buildJsonArray {
            sentences.forEach { candidate ->
              val id = (candidate as? JsonObject)?.get("sentenceId")?.jsonPrimitive?.contentOrNull
              if (id != null && id in sentenceIds) add(candidate)
            }
          },
        )
      }
    }

    /** 缓存存 envelope 形状：读取时直接经 validateCoreBatch 复检（与 TS 提取路径语义等价）。 */
    private fun analysisToJson(analysis: CoreAnalysis): JsonObject = buildJsonObject {
      put(
        "sentences",
        buildJsonArray {
          add(
            buildJsonObject {
              put("sentenceId", analysis.sentenceId)
              put(
                "components",
                buildJsonArray {
                  analysis.components.forEach { component ->
                    add(
                      buildJsonObject {
                        put("startToken", component.startToken)
                        put("endToken", component.endToken)
                        put("role", component.role.name)
                        put("translation", component.translation)
                      },
                    )
                  }
                },
              )
            },
          )
        },
      )
    }

    /** modelProfileId 不入缓存值——读取时由当前 profile 注入。 */
    private fun detailToJson(analysis: DetailAnalysis): JsonObject = buildJsonObject {
      put("sentenceId", analysis.sentenceId)
      put("focus", buildJsonObject { put("startToken", analysis.focus.startToken); put("endToken", analysis.focus.endToken) })
      put(
        "structures",
        buildJsonArray {
          analysis.structures.forEach { structure ->
            add(
              buildJsonObject {
                put("startToken", structure.startToken)
                put("endToken", structure.endToken)
                put("role", structure.role)
                put("explanation", structure.explanation)
                structure.translation?.let { put("translation", it) }
              },
            )
          }
        },
      )
      put("grammarPoints", buildJsonArray { analysis.grammarPoints.forEach { add(JsonPrimitive(it)) } })
      put("explanation", analysis.explanation)
    }
  }
}

/** 流式暂定成分的安全过滤：角色在枚举内、区间在界内、与已发成分有序不重叠。 */
private class ProvisionalComponents(private val tokenCounts: Map<String, Int>) {
  private val acceptedBySentence = mutableMapOf<String, MutableList<CoreComponent>>()

  fun accept(streamed: StreamedComponent): List<CoreComponent>? {
    val tokenCount = tokenCounts[streamed.sentenceId] ?: return null
    val list = acceptedBySentence.getOrPut(streamed.sentenceId) { mutableListOf() }
    val start = streamed.component["startToken"]?.jsonPrimitiveOrNull?.contentOrNull?.toIntOrNull() ?: return null
    val end = streamed.component["endToken"]?.jsonPrimitiveOrNull?.contentOrNull?.toIntOrNull() ?: return null
    val roleText = streamed.component["role"]?.jsonPrimitiveOrNull?.contentOrNull ?: return null
    val role = runCatching { GrammarRole.valueOf(roleText) }.getOrNull() ?: return null
    val translation = streamed.component["translation"]?.jsonPrimitiveOrNull?.contentOrNull ?: return null
    if (start < 0 || end < start || end >= tokenCount) return null
    if (list.isNotEmpty() && start <= list.last().endToken) return null
    list += CoreComponent(start, end, role, translation)
    return list.toList()
  }
}

/** 流式暂定结构的安全过滤：区间在句内、role/explanation 非空且安全。 */
private class ProvisionalStructures(private val tokenCount: Int) {
  private val accepted = mutableListOf<DetailStructure>()

  fun accept(raw: JsonObject): List<DetailStructure>? {
    val start = raw["startToken"]?.jsonPrimitiveOrNull?.contentOrNull?.toIntOrNull() ?: return null
    val end = raw["endToken"]?.jsonPrimitiveOrNull?.contentOrNull?.toIntOrNull() ?: return null
    val role = raw["role"]?.jsonPrimitiveOrNull?.contentOrNull?.takeUnless { it.trim().isEmpty() } ?: return null
    val explanation = raw["explanation"]?.jsonPrimitiveOrNull?.contentOrNull?.takeUnless { it.trim().isEmpty() } ?: return null
    val translation = raw["translation"]?.jsonPrimitiveOrNull?.contentOrNull
    if (start < 0 || end < start || end >= tokenCount) return null
    accepted += DetailStructure(start, end, role, explanation, translation?.takeUnless { it.isEmpty() })
    return accepted.toList()
  }
}

private val JsonElement.jsonPrimitiveOrNull: JsonPrimitive?
  get() = this as? JsonPrimitive
