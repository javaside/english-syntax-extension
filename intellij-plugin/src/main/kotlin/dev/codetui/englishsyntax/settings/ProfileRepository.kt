package dev.codetui.englishsyntax.settings

import com.intellij.openapi.components.Service
import java.net.URI

@Service(Service.Level.APP)
class ProfileRepository(
  private val profileState: ProfileState = com.intellij.openapi.components.service(),
  private val credentials: CredentialStore = PasswordSafeCredentialStore(),
) {
  fun list(): List<ModelProfile> = profileState.state.profiles.map(::fromStored)

  suspend fun save(profile: ModelProfile) {
    val validated = validate(profile)
    val stored = toStored(validated)
    val profiles = profileState.state.profiles.toMutableList()
    val index = profiles.indexOfFirst { it.id == stored.id }
    if (index == -1) profiles += stored else profiles[index] = stored
    profileState.state.profiles = profiles
    if (profileState.state.activeProfileId == null) profileState.state.activeProfileId = validated.id
  }

  suspend fun delete(id: String) {
    val profile = list().firstOrNull { it.id == id } ?: return
    credentials.delete(id, CredentialStore.API_KEY_FIELD)
    profile.headerNames.forEach { credentials.delete(id, headerField(it)) }
    profileState.state.profiles = profileState.state.profiles.filterNot { it.id == id }.toMutableList()
    if (profileState.state.activeProfileId == id) profileState.state.activeProfileId = null
  }

  fun active(): ModelProfile? = profileState.state.activeProfileId?.let { id -> list().firstOrNull { it.id == id } }

  fun setActive(id: String) {
    require(list().any { it.id == id }) { "Unknown model profile: $id" }
    profileState.state.activeProfileId = id
  }

  fun updateCapability(id: String, capability: Capability, state: CapabilityState) {
    val profile = list().firstOrNull { it.id == id } ?: throw IllegalArgumentException("Unknown model profile: $id")
    val updated = when (capability) {
      Capability.JSON_SCHEMA -> profile.copy(jsonSchemaSupport = if (state == CapabilityState.SUPPORTED) JsonSchemaSupport.SUPPORTED else JsonSchemaSupport.UNSUPPORTED)
      Capability.STREAM -> if (state == CapabilityState.UNSUPPORTED) profile.copy(streamSupport = state) else profile
      Capability.REASONING_CONTROL -> if (state == CapabilityState.UNSUPPORTED) profile.copy(reasoningControl = state) else profile
    }
    profileState.state.profiles = profileState.state.profiles.map { if (it.id == id) toStored(updated) else it }.toMutableList()
  }

  private fun validate(profile: ModelProfile): ModelProfile {
    require(profile.id.isNotBlank()) { "Model profile id must not be blank" }
    require(profile.name.isNotBlank()) { "Model profile name must not be blank" }
    require(profile.model.isNotBlank()) { "Model profile model must not be blank" }
    require(profile.timeoutMs in 5_000..120_000) { "Model profile timeout must be between 5000 and 120000 milliseconds" }
    require(profile.streamSupport == null || profile.streamSupport == CapabilityState.UNSUPPORTED) { "Model profile streamSupport is invalid" }
    require(profile.reasoningControl == null || profile.reasoningControl == CapabilityState.UNSUPPORTED) { "Model profile reasoningControl is invalid" }
    profile.headerNames.forEach { name ->
      require(name.isNotBlank()) { "Custom header name must not be blank" }
      require(name.trim().lowercase() !in FORBIDDEN_HEADERS) { "Custom header $name is forbidden" }
    }
    return profile.copy(baseUrl = normalizeBaseUrl(profile.baseUrl), headerNames = profile.headerNames.map { it.trim() }.toSet())
  }

  private fun normalizeBaseUrl(value: String): String {
    val uri = try {
      URI(value.trim())
    } catch (exception: Exception) {
      throw IllegalArgumentException("Model profile baseUrl is invalid", exception)
    }
    val host = uri.host?.lowercase()
    require(uri.scheme == "https" || (uri.scheme == "http" && host in LOOPBACK_HOSTS)) { "Model profile baseUrl must use HTTPS or local HTTP" }
    require(host != null) { "Model profile baseUrl must include a host" }
    require(uri.userInfo == null && uri.query == null && uri.fragment == null) { "Model profile baseUrl is invalid" }
    return uri.toString().trimEnd('/')
  }

  private fun toStored(profile: ModelProfile) = StoredProfile(
    id = profile.id,
    name = profile.name,
    baseUrl = profile.baseUrl,
    model = profile.model,
    headers = profile.headerNames.associateWith(::headerField).toMutableMap(),
    timeoutMs = profile.timeoutMs,
    jsonSchemaSupport = profile.jsonSchemaSupport.name,
    streamSupport = profile.streamSupport?.name,
    reasoningControl = profile.reasoningControl?.name,
  )

  private fun fromStored(profile: StoredProfile) = ModelProfile(
    id = profile.id,
    name = profile.name,
    baseUrl = profile.baseUrl,
    model = profile.model,
    headerNames = profile.headers.keys,
    timeoutMs = profile.timeoutMs,
    jsonSchemaSupport = JsonSchemaSupport.valueOf(profile.jsonSchemaSupport),
    streamSupport = profile.streamSupport?.let(CapabilityState::valueOf),
    reasoningControl = profile.reasoningControl?.let(CapabilityState::valueOf),
  )

  companion object {
    private val FORBIDDEN_HEADERS = setOf("authorization", "host", "content-length", "origin", "x-syntax-request-id")
    private val LOOPBACK_HOSTS = setOf("localhost", "127.0.0.1")

    fun headerField(name: String) = "header:$name"
  }
}
