package dev.codetui.englishsyntax

import com.intellij.openapi.application.PathManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import dev.codetui.englishsyntax.analysis.AnalysisService
import dev.codetui.englishsyntax.analysis.AnalysisServicePort
import dev.codetui.englishsyntax.cache.AnalysisCache
import dev.codetui.englishsyntax.model.CapabilityWriter
import dev.codetui.englishsyntax.model.OpenAiCompatibleClient
import dev.codetui.englishsyntax.scheduler.RequestScheduler
import dev.codetui.englishsyntax.settings.Capability
import dev.codetui.englishsyntax.settings.CapabilityState
import dev.codetui.englishsyntax.settings.PasswordSafeCredentialStore
import dev.codetui.englishsyntax.settings.ProfileRepository
import dev.codetui.englishsyntax.settings.ProfileState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import java.nio.file.Files
import java.nio.file.Path

/**
 * 应用级模型客户端服务。CapabilityWriter 把探测到的降级位写回 ProfileState,
 * 与 Chrome 端「只持久化否定态」的套路一致。
 */
@Service(Service.Level.APP)
class ModelClientService {
  val client: OpenAiCompatibleClient by lazy {
    OpenAiCompatibleClient(
      credentials = PasswordSafeCredentialStore(),
      capabilityWriter = RepositoryCapabilityWriter(),
    )
  }

  class RepositoryCapabilityWriter : CapabilityWriter {
    override suspend fun markJsonSchemaUnsupported(profileId: String) =
      mark(profileId, Capability.JSON_SCHEMA, CapabilityState.UNSUPPORTED)

    override suspend fun markStreamUnsupported(profileId: String) =
      mark(profileId, Capability.STREAM, CapabilityState.UNSUPPORTED)

    override suspend fun markReasoningUnsupported(profileId: String) =
      mark(profileId, Capability.REASONING_CONTROL, CapabilityState.UNSUPPORTED)

    private fun mark(profileId: String, capability: Capability, state: CapabilityState) {
      runCatching { service<ProfileRepository>().updateCapability(profileId, capability, state) }
    }
  }
}

/**
 * 应用级分析服务:SQLite 缓存放在 IDE 系统目录下,调度器并发与 Chrome 端默认一致。
 * Profile 快照由 repository.active() 提供,预览会话在 start 时刻取快照。
 */
@Service(Service.Level.APP)
class AnalysisServiceService {
  val cache: AnalysisCache by lazy {
    val cacheDir: Path = PathManager.getSystemDir().resolve("english-syntax-learning")
    Files.createDirectories(cacheDir)
    val profileState = service<ProfileState>()
    AnalysisCache(
      databasePath = cacheDir.resolve("analysis-cache.sqlite"),
      limitBytes = profileState.state.cacheLimitMb * 1024L * 1024L,
    )
  }

  val analysis: AnalysisServicePort by lazy {
    AnalysisService(
      client = service<ModelClientService>().client,
      cache = cache,
      scheduler = RequestScheduler(concurrency = 4),
    )
  }
}

/**
 * 应用级会话管理器。scope 随应用生命周期;每个 preview 的子 Job 在
 * PreviewSessionManager 内部创建与取消。
 */
@Service(Service.Level.APP)
class PreviewSessionManagerService {
  val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

  val manager: dev.codetui.englishsyntax.session.PreviewSessionManager by lazy {
    val repository = service<ProfileRepository>()
    dev.codetui.englishsyntax.session.PreviewSessionManager(
      scope = scope,
      analysis = service<AnalysisServiceService>().analysis,
      profileProvider = { repository.active() },
    )
  }
}
