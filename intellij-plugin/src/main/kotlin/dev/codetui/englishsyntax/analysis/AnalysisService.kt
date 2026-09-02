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
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray

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
 * 会话层依赖的分析服务端口（便于测试用假实现替换具体类）。
 */
interface AnalysisServicePort {
  suspend fun analyzeCore(
    profile: ModelProfile,
    documentId: String,
    sentences: List<SentenceInput>,
    priority: SchedulerPriority = SchedulerPriority.ACTIVE_VISIBLE_CORE,
    bypassCache: Boolean = false,
    onStreamedComponent: StreamedComponentSink? = null,
  ): CoreBatchOutcome

  suspend fun lookupCore(sentences: List<SentenceInput>): List<CoreAnalysis>

  suspend fun analyzeDetail(
    profile: ModelProfile,
    documentId: String,
    sentence: SentenceInput,
    core: CoreAnalysis,
    focus: TokenRange,
    onStreamedStructure: StreamedStructureSink? = null,
  ): DetailOutcome

  suspend fun lookupDetail(sentence: SentenceInput, focus: TokenRange): DetailAnalysis?

  suspend fun cancelDocument(documentId: String)
}

/**
 * 核心编排：查缓存 → 按端点分块 → Prompt → 调度 → 校验 → 至多两轮 core 修复 → 写缓存。
 * 与 Chrome 端 `analysis-service.ts` 同一骨架。
 */
class AnalysisService(
  private val client: OpenAiCompatibleClient,
  private val cache: AnalysisCache,
  private val scheduler: RequestScheduler,
  private val loopbackDetector: (String) -> Boolean = ::isLoopbackBaseUrl,
) : AnalysisServicePort {
  private val coreSchema = JsonSchemaSpec(
    name = "core_analysis",
    schema = buildJsonObject {
      put("type", "object")
      put("additionalProperties", false)
      putJsonArray("required") { add("sentences") }
      put("properties", buildJsonObject {
        put("sentences", buildJsonObject {
          put("type", "array")
          put("items", buildJsonObject {
            put("type", "object")
            put("additionalProperties", false)
            putJsonArray("required") { add("sentenceId"); add("components") }
            put("properties", buildJsonObject {
              put("sentenceId", buildJsonObject { put("type", "string") })
              put("components", buildJsonObject {
                put("type", "array")
                put("minItems", 1)
                put("items", buildJsonObject {
                  put("type", "object")
                  put("additionalProperties", false)
                  putJsonArray("required") {
                    add("startToken"); add("endToken"); add("role"); add("translation")
                  }
                  put("properties", buildJsonObject {
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
      putJsonArray("required") {
        add("sentenceId"); add("focus"); add("structures"); add("grammarPoints"); add("explanation")
      }
      put("properties", buildJsonObject {
        put("sentenceId", buildJsonObject { put("type", "string") })
        put("focus", buildJsonObject {
          put("type", "object")
          put("additionalProperties", false)
          putJsonArray("required") { add("startToken"); add("endToken") }
          put("properties", buildJsonObject {
            put("startToken", buildJsonObject { put("type", "integer"); put("minimum", 0) })
            put("endToken", buildJsonObject { put("type", "integer"); put("minimum", 0) })
          })
        })
        put("structures", buildJsonObject {
          put("type", "array")
          put("items", buildJsonObject {
            put("type", "object")
            put("additionalProperties", false)
            putJsonArray("required") { add("startToken"); add("endToken"); add("role"); add("explanation") }
            put("properties", buildJsonObject {
              put("startToken", buildJsonObject { put("type", "integer"); put("minimum", 0) })
              put("endToken", buildJsonObject { put("type", "integer"); put("minimum", 0) })
              put("role", buildJsonObject { put("type", "string"); put("minLength", 1) })
              put("explanation", buildJsonObject { put("type", "string"); put("minLength", 1) })
              put("translation", buildJsonObject { put("type", "string"); put("minLength", 1); put("maxLength", 120) })
            })
          })
        })
        put("grammarPoints", buildJsonObject {
          put("type", "array")
          put("maxItems", 12)
          put("items", buildJsonObject { put("type", "string"); put("minLength", 1); put("maxLength", 300) })
        })
        put("explanation", buildJsonObject { put("type", "string"); put("minLength", 1) })
      })
    },
  )

  private val serializeMutex = Mutex()
  private val json = Json { prettyPrint = false }

  override suspend fun analyzeCore(
    profile: ModelProfile,
    documentId: String,
    sentences: List<SentenceInput>,
    priority: SchedulerPriority,
    bypassCache: Boolean,
    onStreamedComponent: StreamedComponentSink?,
  ): CoreBatchOutcome {
    val keyed = sentences.map { sentence ->
      sentence to createCoreCacheKey(coreKeyInput(sentence))
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
        validateCoreBatch(cachedCoreEnvelope(raw), listOf(sentence), CACHE_ONLY_PROFILE_ID).let { result ->
          (result as? ValidationResult.Valid)?.value?.firstOrNull()
        }
      }
      if (value == null) missing += sentence to key
      else results[sentence.sentenceId] = value.copy(modelProfileId = profile.id)
    }
    if (missing.isEmpty()) {
      return CoreBatchOutcome(sentences.map { results.getValue(it.sentenceId) }, emptyList(), cacheHit = true)
    }

    val perRequest = if (loopbackDetector(profile.baseUrl)) {
      ContractVersions.MAX_SENTENCES_PER_REQUEST
    } else {
      ContractVersions.CLOUD_SENTENCES_PER_REQUEST
    }
    val chunks = missing.chunked(perRequest)
    val settled = coroutineScope {
      chunks.map { chunk ->
        async { chunk to runCatching { analyzeCoreChunk(profile, documentId, chunk, priority, onStreamedComponent) } }
      }.awaitAll()
    }

    val failuresBySentence = mutableMapOf<String, AnalysisFailure>()
    settled.forEach { (chunk, outcome) ->
      outcome.onSuccess { value ->
        value.valid.forEach { analysis -> results[analysis.sentenceId] = analysis }
        value.invalid.forEach { (sentence, errors) ->
          failuresBySentence[sentence.sentenceId] = AnalysisFailure(sentence.sentenceId, invalidOutput(errors))
        }
      }.onFailure { error ->
        val failure = error as? ExtensionFailure
          ?: ExtensionFailure(ErrorCode.NETWORK_ERROR, error.message ?: "Model request failed", true)
        chunk.forEach { (sentence, _) ->
          failuresBySentence[sentence.sentenceId] = AnalysisFailure(sentence.sentenceId, failure)
        }
      }
    }
    return CoreBatchOutcome(
      result = sentences.mapNotNull { results[it.sentenceId] },
      failures = sentences.mapNotNull { failuresBySentence[it.sentenceId] },
      cacheHit = false,
    )
  }

  override suspend fun lookupCore(sentences: List<SentenceInput>): List<CoreAnalysis> {
    return sentences.mapNotNull { sentence ->
      val key = createCoreCacheKey(coreKeyInput(sentence))
      val raw = cache.getCore(key) ?: return@mapNotNull null
      validateCoreBatch(cachedCoreEnvelope(raw), listOf(sentence), CACHE_ONLY_PROFILE_ID).let { result ->
        (result as? ValidationResult.Valid)?.value?.firstOrNull()
      }
    }
  }

  override suspend fun analyzeDetail(
    profile: ModelProfile,
    documentId: String,
    sentence: SentenceInput,
    core: CoreAnalysis,
    focus: TokenRange,
    onStreamedStructure: StreamedStructureSink?,
  ): DetailOutcome {
    val key = detailKey(sentence, focus)
    val cachedRaw = cache.getDetail(key)
    val cached = cachedRaw?.let { raw ->
      validateDetail(cachedDetailEnvelope(raw), sentence, focus, CACHE_ONLY_PROFILE_ID).let { result ->
        (result as? ValidationResult.Valid)?.value
      }
    }
    if (cached != null) return DetailOutcome(cached.copy(modelProfileId = profile.id), cacheHit = true)

    val provisional = onStreamedStructure?.let { ProvisionalStructures(sentence.tokens.size, focus) }
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

  override suspend fun lookupDetail(sentence: SentenceInput, focus: TokenRange): DetailAnalysis? {
    val raw = cache.getDetail(detailKey(sentence, focus)) ?: return null
    return validateDetail(cachedDetailEnvelope(raw), sentence, focus, CACHE_ONLY_PROFILE_ID).let { result ->
      (result as? ValidationResult.Valid)?.value
    }
  }

  override suspend fun cancelDocument(documentId: String) = scheduler.cancelDocument(documentId)

  private suspend fun analyzeCoreChunk(
    profile: ModelProfile,
    documentId: String,
    chunk: List<Pair<SentenceInput, String>>,
    priority: SchedulerPriority,
    onStreamedComponent: StreamedComponentSink?,
  ): ChunkOutcome {
    val sentences = chunk.map { it.first }
    val provisional = onStreamedComponent?.let {
      ProvisionalComponents(chunk.associate { (sentence, _) -> sentence.sentenceId to sentence.tokens })
    }
    val raw = try {
      request(
        profile,
        documentId,
        priority,
        chunk.joinToString(":") { it.second },
        listOf(ChatMessage("user", buildCorePrompt(sentences))),
        coreSchema,
        sentenceCount = chunk.size,
        onComponent = if (provisional != null) {
          { streamed ->
            val accepted = provisional.accept(streamed)
            if (accepted != null) onStreamedComponent!!.accept(streamed.sentenceId, accepted)
          }
        } else {
          null
        },
      )
    } catch (failure: ExtensionFailure) {
      // 首轮输出连救都救不回来(不是 JSON、或一个完整值都没有)时，别把整块判死:
      // 当成「这一批全无效」交给修复轮再要一次。网络/鉴权/超时/取消照旧上抛——
      // 那类失败重发一次也是白发。与 Chrome 侧 analyzeCoreChunk 同一取舍。
      if (failure.code != ErrorCode.INVALID_MODEL_OUTPUT) throw failure
      EMPTY_CORE_OUTPUT
    }
    val firstPass = validateAndCacheCore(profile, chunk, raw)
    val valid = firstPass.valid.toMutableList()
    var invalid = firstPass.invalid
    var invalidRaw = raw
    val keysById = chunk.associate { (sentence, key) -> sentence.sentenceId to key }
    for (repairRound in 1..2) {
      if (invalid.isEmpty()) break
      val repairRaw = try {
        request(
          profile,
          documentId,
          priority,
          "${chunk.joinToString(":") { it.second }}:repair:$repairRound",
          listOf(
            ChatMessage(
              "user",
              buildRepairPrompt(
                invalid.map { it.first },
                invalid.flatMap { it.second },
                invalidRawSubset(invalidRaw, invalid.map { it.first.sentenceId }.toSet()),
              ),
            ),
          ),
          coreSchema,
          sentenceCount = invalid.size,
          jumpQueue = true,
        )
      } catch (failure: ExtensionFailure) {
        if (failure.code != ErrorCode.INVALID_MODEL_OUTPUT) throw failure
        EMPTY_CORE_OUTPUT
      }
      val repaired = validateAndCacheCore(
        profile,
        invalid.map { it.first to (keysById[it.first.sentenceId] ?: error("missing key")) },
        repairRaw,
      )
      valid += repaired.valid
      invalid = repaired.invalid
      invalidRaw = repairRaw
    }
    return ChunkOutcome(valid, invalid)
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
    sentenceCount: Int = 1,
    jumpQueue: Boolean = false,
    onComponent: ((StreamedComponent) -> Unit)? = null,
    onDetailStreamed: ((kotlinx.serialization.json.JsonObject) -> Unit)? = null,
  ): JsonElement {
    return scheduler.schedule(
      ScheduledRequest(
        cacheKey = cacheKey,
        documentId = documentId,
        priority = priority,
        sentenceCount = sentenceCount,
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
    private val LOGGER = com.intellij.openapi.diagnostic.Logger.getInstance(AnalysisService::class.java)
    private val promptJson = Json { prettyPrint = false; encodeDefaults = true }
    private const val CACHE_ONLY_PROFILE_ID = "cached"

    /** 首轮完全解析不了时充当「这一批全无效」的替身，让 core 修复循环真的会跑。 */
    private val EMPTY_CORE_OUTPUT: JsonElement = buildJsonObject { put("sentences", JsonArray(emptyList())) }

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

    /** core 结果的身份：句子 + schema 版本 + core 提示词版本（提示词一改，旧粒度结果自然失效）。 */
    private fun coreKeyInput(sentence: SentenceInput): CoreCacheKeyInput = CoreCacheKeyInput(
      normalizedSentence = normalize(sentence.text),
      schemaVersion = ContractVersions.CORE_SCHEMA,
      promptVersion = ContractVersions.CORE_PROMPT,
    )

    /** 详解结果只随详解提示词失效，与 core 提示词各自演进。 */
    private fun detailKey(sentence: SentenceInput, focus: TokenRange): String = createCoreCacheKey(
      CoreCacheKeyInput(
        normalizedSentence = normalize(sentence.text),
        schemaVersion = ContractVersions.CORE_SCHEMA,
        promptVersion = ContractVersions.DETAIL_PROMPT,
        focus = focus,
      ),
    )

    private fun invalidOutput(errors: List<ValidationError>): ExtensionFailure {
      val summary = errors.joinToString("; ") { "${it.path.ifEmpty { "output" }}: ${it.message}" }
      LOGGER.warn("Model output remained invalid after two repairs: $summary")
      return ExtensionFailure(
        ErrorCode.INVALID_MODEL_OUTPUT,
        "Model output remained invalid after two repairs${if (summary.isEmpty()) "" else ": $summary"}",
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

    /**
     * 缓存值保持 Chrome 交换格式：CoreAnalysis 领域对象形状（schemaVersion/sentenceId/
     * components/modelProfileId）。读取时由 cachedCoreEnvelope 提取 sentenceId/components
     * 构造校验 envelope；modelProfileId 再改写为当前 profile。
     */
    private fun analysisToJson(analysis: CoreAnalysis): JsonObject = buildJsonObject {
      put("schemaVersion", analysis.schemaVersion)
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
      put("modelProfileId", analysis.modelProfileId)
    }

    private fun cachedCoreEnvelope(cached: JsonObject): JsonObject = buildJsonObject {
      put(
        "sentences",
        buildJsonArray {
          add(
            buildJsonObject {
              put("sentenceId", cached["sentenceId"] ?: JsonPrimitive(""))
              put("components", cached["components"] ?: JsonArray(emptyList()))
            },
          )
        },
      )
    }

    /** DetailAnalysis 同样保持 Chrome 交换格式；读取校验前去掉 modelProfileId。 */
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
      put("modelProfileId", analysis.modelProfileId)
    }

    private fun cachedDetailEnvelope(cached: JsonObject): JsonObject = buildJsonObject {
      put("sentenceId", cached["sentenceId"] ?: JsonPrimitive(""))
      put("focus", cached["focus"] ?: JsonObject(emptyMap()))
      put("structures", cached["structures"] ?: JsonArray(emptyList()))
      put("grammarPoints", cached["grammarPoints"] ?: JsonArray(emptyList()))
      put("explanation", cached["explanation"] ?: JsonPrimitive(""))
    }
  }
}

/** 流式暂定成分的安全过滤：角色在枚举内、区间在界内、非纯标点且与已发成分有序不重叠。 */
private class ProvisionalComponents(private val tokensBySentence: Map<String, List<dev.codetui.englishsyntax.domain.Token>>) {
  private val acceptedBySentence = mutableMapOf<String, MutableList<CoreComponent>>()

  fun accept(streamed: StreamedComponent): List<CoreComponent>? {
    val tokens = tokensBySentence[streamed.sentenceId] ?: return null
    val list = acceptedBySentence.getOrPut(streamed.sentenceId) { mutableListOf() }
    val start = streamed.component["startToken"]?.jsonPrimitiveOrNull?.contentOrNull?.toIntOrNull() ?: return null
    val end = streamed.component["endToken"]?.jsonPrimitiveOrNull?.contentOrNull?.toIntOrNull() ?: return null
    val roleText = streamed.component["role"]?.jsonPrimitiveOrNull?.contentOrNull ?: return null
    val role = runCatching { GrammarRole.valueOf(roleText) }.getOrNull() ?: return null
    val translation = streamed.component["translation"]?.jsonPrimitiveOrNull?.contentOrNull ?: return null
    if (start < 0 || end < start || end >= tokens.size) return null
    if (tokens.subList(start, end + 1).all { it.punctuation }) return null
    if (list.isNotEmpty() && start <= list.last().endToken) return null
    list += CoreComponent(start, end, role, translation)
    return list.toList()
  }
}

/** 流式暂定结构的安全过滤：区间限于 focus、有序不重叠，role/explanation 非空。 */
private class ProvisionalStructures(
  private val tokenCount: Int,
  private val focus: TokenRange,
) {
  private val accepted = mutableListOf<DetailStructure>()
  private var lastEnd = focus.startToken - 1

  fun accept(raw: JsonObject): List<DetailStructure>? {
    val start = raw["startToken"]?.jsonPrimitiveOrNull?.contentOrNull?.toIntOrNull() ?: return null
    val end = raw["endToken"]?.jsonPrimitiveOrNull?.contentOrNull?.toIntOrNull() ?: return null
    val role = raw["role"]?.jsonPrimitiveOrNull?.contentOrNull?.takeUnless { it.trim().isEmpty() } ?: return null
    val explanation = raw["explanation"]?.jsonPrimitiveOrNull?.contentOrNull?.takeUnless { it.trim().isEmpty() } ?: return null
    val translation = raw["translation"]?.jsonPrimitiveOrNull?.contentOrNull
    if (
      start < focus.startToken ||
      end < start ||
      end > focus.endToken ||
      end >= tokenCount ||
      start <= lastEnd
    ) return null
    lastEnd = end
    accepted += DetailStructure(start, end, role, explanation, translation?.takeUnless { it.isEmpty() })
    return accepted.toList()
  }
}

private val JsonElement.jsonPrimitiveOrNull: JsonPrimitive?
  get() = this as? JsonPrimitive
