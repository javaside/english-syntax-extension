package dev.codetui.englishsyntax.session

import dev.codetui.englishsyntax.settings.CredentialStore
import dev.codetui.englishsyntax.settings.JsonSchemaSupport
import dev.codetui.englishsyntax.settings.ModelProfile
import dev.codetui.englishsyntax.settings.ProfileRepository
import dev.codetui.englishsyntax.settings.ProfileState
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * F6 暂停表语义（对齐 Chrome pauseProfile/isProfilePaused）：
 * profileId → 暂停时刻的凭据指纹；指纹变化才解除、无条件解除与清空各有入口。
 */
class ProfilePauseRegistryTest {

  private class FakeCredentialStore : CredentialStore {
    private val values = mutableMapOf<Pair<String, String>, String>()

    override suspend fun get(profileId: String, field: String): String? = values[profileId to field]

    override suspend fun put(profileId: String, field: String, value: String) {
      values[profileId to field] = value
    }

    override suspend fun delete(profileId: String, field: String) {
      values.remove(profileId to field)
    }
  }

  @Test
  fun `record auth failed pins the current fingerprint and pauses`() = runBlocking {
    var fingerprint = "fp-1"
    val registry = ProfilePauseRegistry({ fingerprint })

    assertFalse(registry.isPaused("p1"), "未记账的 profile 不得被判暂停")

    registry.recordAuthFailed("p1")
    assertTrue(registry.isPaused("p1"), "AUTH_FAILED 记账后必须可查暂停")

    // 凭据指纹未变（用户只是重试）→ 不解除。
    assertFalse(registry.releaseIfFingerprintChanged("p1"), "指纹相同不得解除")
    assertTrue(registry.isPaused("p1"))
  }

  @Test
  fun `release happens exactly when the fingerprint changed`() = runBlocking {
    var fingerprint = "fp-1"
    val registry = ProfilePauseRegistry({ fingerprint })
    registry.recordAuthFailed("p1")

    fingerprint = "fp-2"
    assertTrue(registry.releaseIfFingerprintChanged("p1"), "指纹变化必须解除")
    assertFalse(registry.isPaused("p1"))
    // 解除是终态：重复调用不得再报「已解除」。
    assertFalse(registry.releaseIfFingerprintChanged("p1"))
  }

  @Test
  fun `recording a vanished profile leaves no entry and a vanished profile releases its dead key`() = runBlocking {
    // profile 已删除时 AUTH_FAILED 无处钉指纹：不记条目（否则永远查不到「当前指纹」）。
    val vanished = ProfilePauseRegistry({ null })
    vanished.recordAuthFailed("p1")
    assertFalse(vanished.isPaused("p1"))

    // 暂停后 profile 被删除（指纹组装返回 null）：清掉死 key，不得把同 id 重建的新
    // profile 继续钉在旧暂停上。
    var fingerprint: String? = "fp-1"
    val registry = ProfilePauseRegistry({ fingerprint })
    registry.recordAuthFailed("p1")
    fingerprint = null
    assertTrue(registry.releaseIfFingerprintChanged("p1"), "profile 已删除必须清掉死 key")
    assertFalse(registry.isPaused("p1"))
  }

  @Test
  fun `release drops one entry and release all clears the table`() = runBlocking {
    val registry = ProfilePauseRegistry({ "fp" })
    registry.recordAuthFailed("p1")
    registry.recordAuthFailed("p2")
    assertTrue(registry.isPaused("p1"))
    assertTrue(registry.isPaused("p2"))

    registry.release("p1")
    assertFalse(registry.isPaused("p1"))
    assertTrue(registry.isPaused("p2"), "release 只清指定 profile")

    registry.releaseAll()
    assertFalse(registry.isPaused("p2"))
  }

  /** 指纹组成对齐 Chrome profileCredentialFingerprint：[baseUrl, apiKey, model, 排序后的 headers]。 */
  @Test
  fun `credential fingerprint covers base url, api key, model and sorted headers`() = runBlocking {
    val repository = ProfileRepository(ProfileState(), FakeCredentialStore())
    val profile = ModelProfile(
      id = "p1",
      name = "Example",
      baseUrl = "https://api.example.com/v1",
      model = "example-model",
      headerNames = setOf("X-B", "X-A"),
      timeoutMs = 30_000,
      jsonSchemaSupport = JsonSchemaSupport.UNKNOWN,
    )
    repository.save(profile, apiKey = "sk-1", headerValues = mapOf("X-B" to "2", "X-A" to "1"))

    val fingerprint = ProfilePauseRegistry.credentialFingerprint(repository, "p1")
    assertNotNull(fingerprint)
    assertTrue("https://api.example.com/v1" in fingerprint, "指纹必须含 baseUrl: $fingerprint")
    assertTrue("sk-1" in fingerprint, "指纹必须含 apiKey（Chrome 同款——密钥在 PasswordSafe，经 repository 读取）: $fingerprint")
    assertTrue("example-model" in fingerprint, "指纹必须含 model: $fingerprint")

    // header 组成相同、保存顺序不同 → 排序后指纹一致（Chrome entries.sort 同款）。
    repository.save(profile, apiKey = "sk-1", headerValues = mapOf("X-A" to "1", "X-B" to "2"))
    assertEquals(fingerprint, ProfilePauseRegistry.credentialFingerprint(repository, "p1"))

    // 任一凭据维度变化（换 key）→ 指纹变化（解除判定的根基）。
    repository.save(profile, apiKey = "sk-2", headerValues = mapOf("X-A" to "1", "X-B" to "2"))
    assertTrue(fingerprint != ProfilePauseRegistry.credentialFingerprint(repository, "p1"))

    // 不存在的 profile 无处组装指纹。
    assertNull(ProfilePauseRegistry.credentialFingerprint(repository, "missing"))
  }
}
