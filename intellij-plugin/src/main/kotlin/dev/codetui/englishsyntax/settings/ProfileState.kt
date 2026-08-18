package dev.codetui.englishsyntax.settings

import com.intellij.openapi.components.BaseState
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.SimplePersistentStateComponent
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage

enum class JsonSchemaSupport {
  UNKNOWN,
  SUPPORTED,
  UNSUPPORTED,
}

enum class Capability {
  JSON_SCHEMA,
  STREAM,
  REASONING_CONTROL,
}

enum class CapabilityState {
  SUPPORTED,
  UNSUPPORTED,
}

data class ModelProfile(
  val id: String,
  val name: String,
  val baseUrl: String,
  val model: String,
  val headerNames: Set<String>,
  val timeoutMs: Int,
  val jsonSchemaSupport: JsonSchemaSupport,
  val streamSupport: CapabilityState? = null,
  val reasoningControl: CapabilityState? = null,
)

data class StoredProfile(
  var id: String = "",
  var name: String = "",
  var baseUrl: String = "",
  var model: String = "",
  var headers: MutableMap<String, String> = mutableMapOf(),
  var timeoutMs: Int = 30_000,
  var jsonSchemaSupport: String = JsonSchemaSupport.UNKNOWN.name,
  var streamSupport: String? = null,
  var reasoningControl: String? = null,
)

@Service(Service.Level.APP)
@State(name = "EnglishSyntaxProfileState", storages = [Storage("english-syntax.xml")])
class ProfileState : SimplePersistentStateComponent<ProfileState.Data>(Data()) {
  class Data : BaseState() {
    var profiles by list<StoredProfile>()
    var activeProfileId by string()
    var cacheLimitMb by property(50)
    var streamRendering by property(true)
  }
}
