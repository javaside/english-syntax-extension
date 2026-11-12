package dev.codetui.englishsyntax.session

import dev.codetui.englishsyntax.settings.ProfileRepository
import java.util.concurrent.ConcurrentHashMap

/**
 * F6 AUTH_FAILED 暂停表（对齐 Chrome `service-worker.ts` 的 `pausedProfiles`）：
 * profileId → 暂停时刻的凭据指纹。
 *
 * - **记账**：请求结果/抛出的 AUTH_FAILED 把 profile 挂起，钉住当前凭据指纹——后续
 *   dispatch 前置查表命中就不再发模型请求（core 回落纯缓存、detail 先查缓存、chat /
 *   feedback 直接报错），白发请求与刷屏报错都止住。
 * - **解除**：凭据指纹变化（设置页保存 / 激活后经 [releaseIfFingerprintChanged] 比较）
 *   或「测试连接」成功（[release]，Chrome TEST_PROFILE 的 resumeProfile 同款）。
 *
 * `ModelProfile` 不携带 apiKey（密钥只进 PasswordSafe），指纹经构造注入的 suspend 组装
 * 函数读取——会话层与设置层都不必知道凭据存取细节。实例放应用级服务
 * （PluginServices 的 PreviewSessionManagerService，与 manager 同生命周期）；条目随
 * profile 删除清理，不随 preview 生灭（暂停是 profile 级事实，不是会话级）。
 */
class ProfilePauseRegistry(
  private val fingerprintOf: suspend (profileId: String) -> String?,
) {
  private val paused = ConcurrentHashMap<String, String>()

  fun isPaused(profileId: String): Boolean = paused.containsKey(profileId)

  /**
   * AUTH_FAILED 落地时记账：钉住**当前**凭据指纹。profile 已删除（组装返回 null）时
   * 无处可暂停——不记条目，否则留下一个永远比不出「指纹已变」的死 key。
   */
  suspend fun recordAuthFailed(profileId: String) {
    val fingerprint = fingerprintOf(profileId) ?: return
    paused[profileId] = fingerprint
  }

  /**
   * 凭据指纹变化时解除（保存/激活 profile 后调用）；返回是否真的解除。指纹相同不解除
   * （凭据没修，暂停仍成立）；profile 已删除同样清掉死 key——同 id 重建的新 profile
   * 不得继承旧暂停。未暂停时短路返回，不做指纹组装（无 PasswordSafe 读）。
   */
  suspend fun releaseIfFingerprintChanged(profileId: String): Boolean {
    val fingerprintAtPause = paused[profileId] ?: return false
    val current = fingerprintOf(profileId)
    if (current == fingerprintAtPause) return false
    paused.remove(profileId)
    return true
  }

  /** 无条件解除：「测试连接」成功（凭据已验证可用）与 profile 删除清理。纯内存操作。 */
  fun release(profileId: String) {
    paused.remove(profileId)
  }

  /** 清空全部条目（停用清理用）。 */
  fun releaseAll() {
    paused.clear()
  }

  companion object {
    /**
     * 指纹组成对齐 Chrome `profileCredentialFingerprint`：`[baseUrl, apiKey, model,
     * 排序后的 headers]`。任一凭据维度变化（换 key / 换模型 / 换地址 / 改自定义头）都
     * 视为「凭据已修」，暂停解除。header 按名称排序——组装与保存顺序无关。profile 不
     * 存在时返回 null（无处组装）。
     */
    suspend fun credentialFingerprint(repository: ProfileRepository, profileId: String): String? {
      val profile = repository.list().firstOrNull { it.id == profileId } ?: return null
      val apiKey = repository.apiKey(profileId).orEmpty()
      val headers = repository.headerValues(profileId)
      return listOf(
        profile.baseUrl,
        apiKey,
        profile.model,
        headers.entries.sortedBy { it.key }.joinToString(";") { "${it.key}=${it.value}" },
      ).joinToString("|")
    }
  }
}
