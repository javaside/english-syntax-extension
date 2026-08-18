package dev.codetui.englishsyntax.settings

import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ProfileRepositoryTest {
  private class FakeCredentialStore : CredentialStore {
    private val values = mutableMapOf<Pair<String, String>, String>()
    val deleted = mutableListOf<Pair<String, String>>()

    override suspend fun get(profileId: String, field: String): String? = values[profileId to field]

    override suspend fun put(profileId: String, field: String, value: String) {
      values[profileId to field] = value
    }

    override suspend fun delete(profileId: String, field: String) {
      values.remove(profileId to field)
      deleted += profileId to field
    }
  }

  private fun repository(credentials: FakeCredentialStore = FakeCredentialStore()) =
    ProfileRepository(ProfileState(), credentials)

  private fun profile(
    baseUrl: String = "https://api.example.com/v1/",
    headers: Map<String, String> = emptyMap(),
    timeoutMs: Int = 30_000,
  ) = ModelProfile(
    id = "profile-1",
    name = "Example",
    baseUrl = baseUrl,
    model = "example-model",
    headerNames = headers.keys,
    timeoutMs = timeoutMs,
    jsonSchemaSupport = JsonSchemaSupport.UNKNOWN,
  )

  @Test
  fun `normalizes HTTPS base URL and rejects forbidden headers`() = runBlocking {
    val repository = repository()
    repository.save(profile())
    assertEquals("https://api.example.com/v1", repository.list().single().baseUrl)

    listOf("Authorization", "Host", "Content-Length", "Origin", "X-Syntax-Request-Id").forEach { header ->
      assertFailsWith<IllegalArgumentException> {
        repository.save(profile(headers = mapOf(header to "value")))
      }
    }
  }

  @Test
  fun `timeout is limited to 5000 through 120000 milliseconds`() = runBlocking {
    val repository = repository()
    repository.save(profile(timeoutMs = 5_000))
    repository.save(profile(timeoutMs = 120_000))

    listOf(4_999, 120_001).forEach { timeoutMs ->
      assertFailsWith<IllegalArgumentException> { repository.save(profile(timeoutMs = timeoutMs)) }
    }
  }

  @Test
  fun `api key is never serialized into persistent state`() = runBlocking {
    val credentials = FakeCredentialStore()
    val state = ProfileState()
    val repository = ProfileRepository(state, credentials)
    credentials.put("profile-1", CredentialStore.API_KEY_FIELD, "secret-profile-key")

    repository.save(profile())

    assertFalse(state.state.toString().contains("secret-profile-key"))
    assertEquals("secret-profile-key", credentials.get("profile-1", CredentialStore.API_KEY_FIELD))
  }

  @Test
  fun `deleting profile deletes credentials`() = runBlocking {
    val credentials = FakeCredentialStore()
    val repository = repository(credentials)
    repository.save(profile(headers = mapOf("X-Api-Key" to "secret")))
    credentials.put("profile-1", CredentialStore.API_KEY_FIELD, "key")
    credentials.put("profile-1", "header:X-Api-Key", "secret")

    repository.delete("profile-1")

    assertTrue(credentials.deleted.contains("profile-1" to CredentialStore.API_KEY_FIELD))
    assertTrue(credentials.deleted.contains("profile-1" to "header:X-Api-Key"))
  }

  @Test
  fun `capabilities persist only negative state`() = runBlocking {
    val repository = repository()
    repository.save(profile())

    repository.updateCapability("profile-1", Capability.JSON_SCHEMA, CapabilityState.UNSUPPORTED)
    repository.updateCapability("profile-1", Capability.STREAM, CapabilityState.UNSUPPORTED)
    repository.updateCapability("profile-1", Capability.REASONING_CONTROL, CapabilityState.UNSUPPORTED)
    repository.updateCapability("profile-1", Capability.STREAM, CapabilityState.SUPPORTED)
    repository.updateCapability("profile-1", Capability.REASONING_CONTROL, CapabilityState.SUPPORTED)

    val stored = repository.list().single()
    assertEquals(JsonSchemaSupport.UNSUPPORTED, stored.jsonSchemaSupport)
    assertEquals(CapabilityState.UNSUPPORTED, stored.streamSupport)
    assertEquals(CapabilityState.UNSUPPORTED, stored.reasoningControl)
  }

  @Test
  fun `accepts HTTPS remote and HTTP loopback URLs`() = runBlocking {
    val repository = repository()
    listOf("https://api.example.com/v1", "http://localhost:11434/v1", "http://127.0.0.1:8080/v1").forEach {
      repository.save(profile(baseUrl = it))
    }
  }

  @Test
  fun `rejects insecure remote URLs blank fields and invalid active profile`() = runBlocking {
    val repository = repository()
    assertFailsWith<IllegalArgumentException> { repository.save(profile(baseUrl = "http://api.example.com/v1")) }
    assertFailsWith<IllegalArgumentException> { repository.save(profile().copy(name = " ")) }
    assertFailsWith<IllegalArgumentException> { repository.save(profile().copy(model = " ")) }
    assertFailsWith<IllegalArgumentException> { repository.setActive("missing") }
    assertNull(repository.active())
  }
}
