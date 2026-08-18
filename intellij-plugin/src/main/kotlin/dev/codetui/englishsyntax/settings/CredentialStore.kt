package dev.codetui.englishsyntax.settings

import com.intellij.credentialStore.CredentialAttributes
import com.intellij.credentialStore.Credentials
import com.intellij.credentialStore.generateServiceName
import com.intellij.ide.passwordSafe.PasswordSafe
import dev.codetui.englishsyntax.PluginIdentity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

interface CredentialStore {
  suspend fun get(profileId: String, field: String): String?

  suspend fun put(profileId: String, field: String, value: String)

  suspend fun delete(profileId: String, field: String)

  companion object {
    const val API_KEY_FIELD = "api-key"
  }
}

class PasswordSafeCredentialStore : CredentialStore {
  companion object {
    fun attributes(profileId: String, field: String) = CredentialAttributes(
      generateServiceName(PluginIdentity.ID, "$profileId:$field"),
    )
  }

  override suspend fun get(profileId: String, field: String): String? = withContext(Dispatchers.IO) {
    PasswordSafe.instance.get(attributes(profileId, field))?.getPasswordAsString()
  }

  override suspend fun put(profileId: String, field: String, value: String) = withContext(Dispatchers.IO) {
    PasswordSafe.instance.set(attributes(profileId, field), Credentials(null, value))
  }

  override suspend fun delete(profileId: String, field: String) = withContext(Dispatchers.IO) {
    PasswordSafe.instance.set(attributes(profileId, field), null)
  }
}
