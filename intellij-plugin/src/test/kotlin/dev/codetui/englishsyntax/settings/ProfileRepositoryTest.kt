package dev.codetui.englishsyntax.settings

import com.intellij.credentialStore.generateServiceName
import com.intellij.openapi.util.JDOMUtil
import com.intellij.util.xmlb.XmlSerializer
import dev.codetui.englishsyntax.PluginIdentity
import kotlinx.coroutines.runBlocking
import kotlin.io.path.Path
import kotlin.io.path.readText
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
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

  private fun repository(
    credentials: FakeCredentialStore = FakeCredentialStore(),
    state: ProfileState = ProfileState(),
  ) = ProfileRepository(state, credentials)

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
  fun `real persistent state XML contains references but no plaintext credentials`() = runBlocking {
    val credentials = FakeCredentialStore()
    val state = ProfileState()
    val repository = ProfileRepository(state, credentials)

    repository.save(
      profile(headers = mapOf("X-Api-Key" to "secret-header-value")),
      apiKey = "secret-profile-key",
      headerValues = mapOf("X-Api-Key" to "secret-header-value"),
    )

    val serialized = XmlSerializer.serialize(state.state)
    val xml = JDOMUtil.writeElement(serialized)
    val restoredState = ProfileState()
    restoredState.loadState(XmlSerializer.deserialize(serialized, ProfileState.Data::class.java))
    val restored = ProfileRepository(restoredState, credentials)

    assertTrue(xml.contains("header:X-Api-Key"))
    assertFalse(xml.contains("secret-profile-key"))
    assertFalse(xml.contains("secret-header-value"))
    assertEquals("secret-profile-key", restored.apiKey("profile-1"))
    assertEquals(mapOf("X-Api-Key" to "secret-header-value"), restored.headerValues("profile-1"))
  }

  @Test
  fun `profile and credentials survive repository round trip`() = runBlocking {
    val credentials = FakeCredentialStore()
    val state = ProfileState()
    val first = ProfileRepository(state, credentials)
    first.save(
      profile(headers = mapOf("X-Tenant" to "tenant-a")),
      apiKey = "round-trip-key",
      headerValues = mapOf("X-Tenant" to "tenant-a"),
    )

    val restored = ProfileRepository(state, credentials)

    assertEquals("https://api.example.com/v1", restored.list().single().baseUrl)
    assertEquals("round-trip-key", restored.apiKey("profile-1"))
    assertEquals(mapOf("X-Tenant" to "tenant-a"), restored.headerValues("profile-1"))
    restored.setActive("profile-1")
    assertEquals("profile-1", restored.active()?.id)
  }

  @Test
  fun `credential attributes map plugin profile and field deterministically`() {
    val attributes = PasswordSafeCredentialStore.attributes("profile-1", ProfileRepository.headerField("X-Tenant"))

    assertTrue(attributes.serviceName.contains(PluginIdentity.ID))
    assertTrue(attributes.serviceName.contains("profile-1"))
    assertTrue(attributes.serviceName.contains("header:X-Tenant"))
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
    listOf(
      "HTTPS://API.EXAMPLE.COM/v1/",
      "http://localhost:11434/v1",
      "http://127.0.0.1:8080/v1",
      "http://[::1]:11434/v1",
    ).forEach { repository.save(profile(baseUrl = it)) }
  }

  @Test
  fun `rejects malformed URLs and invalid header names`() = runBlocking {
    val repository = repository()
    listOf(
      "http://api.example.com/v1",
      "https://api.example.com:bad/v1",
      "https://api.example.com/v1//",
      "https://api.example.com/v1?token=secret",
      "https://user:secret@api.example.com/v1",
    ).forEach { baseUrl ->
      assertFailsWith<IllegalArgumentException>(baseUrl) { repository.save(profile(baseUrl = baseUrl)) }
    }
    listOf("Bad Header", "X-Test\nInjected", "X-Test:").forEach { header ->
      assertFailsWith<IllegalArgumentException>(header) {
        repository.save(profile(headers = mapOf(header to "value")))
      }
    }
    assertFailsWith<IllegalArgumentException> {
      repository.save(profile(headers = linkedMapOf("X-Tenant" to "one", " x-tenant " to "two")))
    }
  }

  @Test
  fun `configurable has real reset modified and apply behavior with nonempty action status`() = runBlocking {
    val credentials = FakeCredentialStore()
    val repository = repository(credentials)
    repository.save(profile(), apiKey = "old-key")
    val configurable = EnglishSyntaxConfigurable(repository, ProfileState(), EnglishSyntaxConfigurable.ConnectionProbe { _ ->
        EnglishSyntaxConfigurable.ConnectionProbeResult(true, "stub")
      })

    configurable.resetForm()
    assertFalse(configurable.isFormModified())
    configurable.form.name = "Updated"
    configurable.form.apiKey = "new-key"
    assertTrue(configurable.isFormModified())

    configurable.applyForm()
    assertEquals("Updated", repository.list().single().name)
    assertEquals("new-key", repository.apiKey("profile-1"))
    assertFalse(configurable.isFormModified())

    configurable.runConnectionAction()
    assertTrue(configurable.actionStatus.isNotBlank())
  }

  @Test
  fun `plugin XML registers ProfileRepository service exactly once`() {
    val annotationCount = ProfileRepository::class.annotations.count { it.annotationClass.simpleName == "Service" }
    val pluginXml = Path("src/main/resources/META-INF/plugin.xml").readText()
    val xmlCount = Regex("serviceImplementation=\\\"dev\\.codetui\\.englishsyntax\\.settings\\.ProfileRepository\\\"").findAll(pluginXml).count()

    assertEquals(1, annotationCount + xmlCount)
    assertNotNull(Regex("applicationConfigurable[^>]+EnglishSyntaxConfigurable").find(pluginXml))
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

  @Test
  fun `clearing credentials removes values from the credential store`() = runBlocking {
    val credentials = FakeCredentialStore()
    val repository = repository(credentials)
    repository.save(
      profile(headers = mapOf("X-Tenant" to "old")),
      apiKey = "old-key",
      headerValues = mapOf("X-Tenant" to "old"),
    )

    repository.save(
      profile(headers = mapOf("X-Tenant" to "old")),
      apiKey = "",
      headerValues = mapOf("X-Tenant" to ""),
    )

    assertNull(repository.apiKey("profile-1"))
    assertEquals(emptyMap(), repository.headerValues("profile-1"))
  }

  @Test
  fun `connection probe success and failure are surfaced in action status`() = runBlocking {
    val repository = repository()
    repository.save(profile())
    val successProbe = EnglishSyntaxConfigurable.ConnectionProbe { _ ->
      EnglishSyntaxConfigurable.ConnectionProbeResult(true, "Connection OK, JSON schema supported")
    }
    val failureProbe = EnglishSyntaxConfigurable.ConnectionProbe { _ ->
      EnglishSyntaxConfigurable.ConnectionProbeResult(false, "timeout")
    }

    val ok = EnglishSyntaxConfigurable(repository, ProfileState(), successProbe)
    ok.resetForm()
    assertTrue(ok.runConnectionAction())
    assertTrue(ok.actionStatus.contains("OK"))

    val bad = EnglishSyntaxConfigurable(repository, ProfileState(), failureProbe)
    bad.resetForm()
    assertFalse(bad.runConnectionAction())
    assertTrue(bad.actionStatus.contains("failed"))
  }

  @Test
  fun `save with invalid base url reports failure and keeps repository unchanged`() = runBlocking {
    val repository = repository()
    repository.save(profile())
    val configurable = EnglishSyntaxConfigurable(repository, ProfileState(), EnglishSyntaxConfigurable.ConnectionProbe { _ ->
      EnglishSyntaxConfigurable.ConnectionProbeResult(true, "stub")
    })
    configurable.resetForm()
    configurable.form.baseUrl = "http://api.example.com/v1"
    assertFalse(configurable.saveForm())
    assertTrue(configurable.actionStatus.contains("HTTPS"))
    assertEquals("https://api.example.com/v1", repository.active()?.baseUrl)
  }

  @Test
  fun `configurable rejects exact and case insensitive duplicate header lines`() = runBlocking {
    val repository = repository()
    repository.save(profile())
    val configurable = EnglishSyntaxConfigurable(repository, ProfileState(), EnglishSyntaxConfigurable.ConnectionProbe { _ ->
        EnglishSyntaxConfigurable.ConnectionProbeResult(true, "stub")
      })

    listOf(
      "X-Tenant: one\nX-Tenant: two",
      "X-Tenant: one\n x-tenant : two",
    ).forEach { headers ->
      configurable.form.headers = headers
      assertFalse(configurable.saveForm())
      assertTrue(configurable.actionStatus.contains("unique"))
    }
  }

  @Test
  fun `configurable exposes save delete and activate operations`() = runBlocking {
    val credentials = FakeCredentialStore()
    val repository = repository(credentials)
    repository.save(profile())
    repository.save(profile().copy(id = "profile-2", name = "Second"))
    val configurable = EnglishSyntaxConfigurable(repository, ProfileState(), EnglishSyntaxConfigurable.ConnectionProbe { _ ->
        EnglishSyntaxConfigurable.ConnectionProbeResult(true, "stub")
      })

    configurable.selectProfile("profile-2")
    configurable.form.name = "Updated second"
    configurable.saveForm()
    assertEquals("Updated second", repository.list().single { it.id == "profile-2" }.name)

    configurable.activateForm()
    assertEquals("profile-2", repository.active()?.id)

    configurable.deleteForm()
    assertNull(repository.list().find { it.id == "profile-2" })
  }
}
