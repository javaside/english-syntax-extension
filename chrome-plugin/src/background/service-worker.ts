import type { ExtensionError, ExtensionErrorCode } from "../shared/errors";
import type { CoreAnalysis, DetailAnalysis } from "../shared/grammar";
import { assertNever, isRequestMessage, MAX_SENTENCES_PER_REQUEST } from "../shared/protocol";
import type {
  CacheStats,
  CoreStreamPush,
  DetailStreamPush,
  DiagnosisExplanation,
  RequestMessage,
  ResponseMessage,
  SessionStatus,
} from "../shared/protocol";
import { MESSAGE_VERSION } from "../shared/versions";
import { AnalysisCache } from "./analysis-cache";
import { CachedAnalysisService } from "./analysis-service";
import type {
  AnalysisModelWork,
  AnalysisService,
  StreamedComponentSink,
  StreamedStructureSink,
} from "./analysis-service";
import { hostPermissionPattern } from "./base-url";
import { ConfigRepository } from "./config-repository";
import type { ModelProfile } from "./config-repository";
import { ModelRequestError, OpenAiCompatibleAdapter } from "./openai-compatible-adapter";
import { RequestScheduler } from "./request-scheduler";
import type { RunTask } from "./request-scheduler";

const SELECTION_MENU_ID = "syntax-parse-selection";
const CONTEXT_BLOCK_MENU_ID = "syntax-parse-context-block";
const DIAGNOSE_MENU_ID = "syntax-diagnose-block";
const CONTENT_SCRIPT_FILE = "content-script.js";
const CONTEXT_INSTRUCTION = "请先启动学习模式，或选中文字后解析";
const HOVERED_BLOCK_COMMAND = "parse-hovered-block";

interface ConfigPort {
  getProfile(profileId: string): Promise<ModelProfile | undefined>;
  getActiveProfile(): Promise<ModelProfile | undefined>;
  setActiveProfile(profileId: string): Promise<void>;
  getPrefetchDetail(): Promise<boolean>;
  getStreamRendering(): Promise<boolean>;
}

interface SchedulerPort {
  cancelDocument(documentId: string): void;
}

interface CachePort {
  stats(): Promise<CacheStats>;
  clear(): Promise<void>;
}

export interface ServiceWorkerDependencies {
  configRepository: ConfigPort;
  analysisService: AnalysisService;
  scheduler: SchedulerPort;
  cache: CachePort;
  profileProbe: (
    profile: ModelProfile,
    signal: AbortSignal,
  ) => Promise<"supported" | "unsupported">;
}

interface ActiveDocument {
  documentId: string;
  status: SessionStatus;
}

interface StatusRelay {
  version: typeof MESSAGE_VERSION;
  requestId: string;
  type: "SESSION_STATUS";
  status: SessionStatus;
  tabId?: number;
  documentId?: string;
}

function emptyStatus(state: SessionStatus["state"], profileId?: string): SessionStatus {
  return {
    state,
    discovered: 0,
    queued: 0,
    ready: 0,
    failed: 0,
    ...(profileId === undefined ? {} : { profileId }),
  };
}

function requestIdOf(value: unknown): string {
  if (typeof value !== "object" || value === null) return "invalid-message";
  const requestId = (value as { requestId?: unknown }).requestId;
  return typeof requestId === "string" && requestId.length > 0 ? requestId : "invalid-message";
}

const ERROR_MESSAGES: Record<ExtensionErrorCode, string> = {
  CONFIG_MISSING: "尚未配置可用的模型档案",
  HOST_PERMISSION_DENIED: "未获得该模型地址的访问权限",
  AUTH_FAILED: "模型档案鉴权失败，更新凭据后才会恢复",
  MODEL_NOT_FOUND: "找不到配置里的模型",
  RATE_LIMITED: "模型服务限流了这次请求",
  NETWORK_ERROR: "模型请求失败",
  REQUEST_TIMEOUT: "模型请求超时",
  INVALID_MODEL_OUTPUT: "模型输出不是合法 JSON",
  MALFORMED_MESSAGE: "扩展内部消息不合协议或不受支持",
  UNSUPPORTED_PAGE: "消息来源与目标标签页不一致",
  UNSAFE_CONTENT_BLOCK: CONTEXT_INSTRUCTION,
  SENTENCE_TOO_LONG: "这句话太长",
  REQUEST_CANCELLED: "请求已取消",
  NO_CACHE: "该成分暂无缓存详解，配置模型后可获取",
};

function errorResponse(
  requestId: string,
  code: ExtensionErrorCode,
  details?: Record<string, string | number | boolean>,
): Extract<ResponseMessage, { type: "ERROR" }> {
  return {
    version: MESSAGE_VERSION,
    requestId,
    type: "ERROR",
    error: {
      code,
      message: ERROR_MESSAGES[code],
      retryable: code === "RATE_LIMITED" || code === "NETWORK_ERROR" || code === "REQUEST_TIMEOUT",
      ...(details === undefined ? {} : { details }),
    },
  };
}

function errorCode(value: unknown): ExtensionErrorCode {
  if (typeof value !== "object" || value === null) return "NETWORK_ERROR";
  const code = (value as Partial<ExtensionError>).code;
  return typeof code === "string" && code in ERROR_MESSAGES ? code : "NETWORK_ERROR";
}

function redactProfileSecrets(value: string, profile: ModelProfile): string {
  const secrets = [profile.apiKey, ...Object.values(profile.headers)].filter(
    (secret) => secret.length > 0,
  );
  return secrets.reduce((redacted, secret) => redacted.split(secret).join("[redacted]"), value);
}

function sanitizeCore(analysis: CoreAnalysis, profile: ModelProfile): CoreAnalysis {
  return {
    schemaVersion: analysis.schemaVersion,
    sentenceId: analysis.sentenceId,
    components: analysis.components.map((component) => ({
      startToken: component.startToken,
      endToken: component.endToken,
      role: component.role,
      translation: redactProfileSecrets(component.translation, profile),
    })),
    modelProfileId: analysis.modelProfileId,
  };
}

function sanitizeDetail(analysis: DetailAnalysis, profile: ModelProfile): DetailAnalysis {
  return {
    sentenceId: analysis.sentenceId,
    focus: {
      startToken: analysis.focus.startToken,
      endToken: analysis.focus.endToken,
    },
    structures: analysis.structures.map((structure) => ({
      startToken: structure.startToken,
      endToken: structure.endToken,
      role: redactProfileSecrets(structure.role, profile),
      explanation: redactProfileSecrets(structure.explanation, profile),
      ...(structure.translation !== undefined
        ? { translation: redactProfileSecrets(structure.translation, profile) }
        : {}),
    })),
    grammarPoints: analysis.grammarPoints.map((point) => redactProfileSecrets(point, profile)),
    explanation: redactProfileSecrets(analysis.explanation, profile),
    modelProfileId: analysis.modelProfileId,
  };
}

/**
 * 诊断解释的模型回文本出站前逐字段脱敏(spec D3):解释文本是模型自由输出,
 * 与 core/detail 的 translation/explanation 同等可能混入凭据。
 */
function redactDiagnosisExplanation(
  model: DiagnosisExplanation,
  profile: ModelProfile,
): DiagnosisExplanation {
  return {
    likelyCause: redactProfileSecrets(model.likelyCause, profile),
    explanation: redactProfileSecrets(model.explanation, profile),
    suggestions: model.suggestions.map((item) => redactProfileSecrets(item, profile)),
  };
}

function isStatus(value: unknown): value is SessionStatus {
  if (typeof value !== "object" || value === null) return false;
  const status = value as Partial<SessionStatus>;
  return (
    (status.state === "stopped" || status.state === "running" || status.state === "paused") &&
    [status.discovered, status.queued, status.ready, status.failed].every(
      (count) => Number.isSafeInteger(count) && (count as number) >= 0,
    ) &&
    (status.skipped === undefined ||
      (Number.isSafeInteger(status.skipped) && status.skipped >= 0)) &&
    (status.cacheOnly === undefined || status.cacheOnly === true) &&
    (status.detailTotal === undefined ||
      (Number.isSafeInteger(status.detailTotal) && status.detailTotal >= 0)) &&
    (status.detailReady === undefined ||
      (Number.isSafeInteger(status.detailReady) && status.detailReady >= 0)) &&
    (status.detailFailed === undefined ||
      (Number.isSafeInteger(status.detailFailed) && status.detailFailed >= 0)) &&
    (status.profileId === undefined || typeof status.profileId === "string")
  );
}

function isStatusRelay(value: unknown): value is StatusRelay {
  if (typeof value !== "object" || value === null) return false;
  const relay = value as Partial<StatusRelay>;
  return (
    relay.version === MESSAGE_VERSION &&
    typeof relay.requestId === "string" &&
    relay.type === "SESSION_STATUS" &&
    isStatus(relay.status) &&
    (relay.tabId === undefined || Number.isSafeInteger(relay.tabId)) &&
    (relay.documentId === undefined || typeof relay.documentId === "string")
  );
}

function relayDocumentId(relay: StatusRelay): string | undefined {
  if (relay.documentId !== undefined) return relay.documentId;
  const marker = relay.requestId.lastIndexOf(":status:");
  return marker > 0 ? relay.requestId.slice(0, marker) : undefined;
}

const ACTIVE_TABS_KEY = "activeTabs.v1";

interface SessionArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

function generatedDocumentId(tabId: number): string {
  return `tab-${tabId}:${crypto.randomUUID()}`;
}

/**
 * 无 activeTabs 账（未启动会话）的 tab 的诊断 documentId 记忆。诊断刻意不写
 * activeTabs（见菜单分支注释），若每次右键都现生成新 id，content 侧 router 会按
 * 新 id 再建一个 SessionController + ChromeRuntimeTransport（构造即开 watchdog
 * 端口）+ contextmenu 监听，且只在 STOP_SESSION 回收——反复诊断就是按次泄漏。
 * 按 tab 记住 id 即可复用同一个 controller；会话启动后账上有 id，陈旧记忆随之
 * 清除。仅存内存：SW 休眠重启即清空，代价只是下一次诊断新建一个 controller，有界。
 */
const diagnosisDocumentIds = new Map<number, string>();

export function registerServiceWorker(
  dependencies: ServiceWorkerDependencies,
  chromeApi: typeof chrome = chrome,
): void {
  const activeTabs = new Map<number, ActiveDocument>();
  /**
   * MV3 的 service worker 空闲约 30 秒就被终止，内存里的 activeTabs 随之清空。
   * 下一次操作于是生成全新的 documentId，而页面上已渲染的卡片还攥着旧的那个——
   * 旧 controller 发出的详解/纠正请求就被 route() 判成过期文档拒成
   * REQUEST_CANCELLED，表现为「点成分报错、点重新解析毫无反应」。
   *
   * session 存储正是为熬过 SW 重启而设(标签页关闭即清)，用它兜住这份状态。
   * 拿不到该 API 时退回纯内存，行为与从前一致。
   */
  const sessionArea = (chromeApi.storage as { session?: SessionArea } | undefined)?.session;
  let commandCounter = 0;
  const persistActiveTabs = (): void => {
    void sessionArea?.set({ [ACTIVE_TABS_KEY]: [...activeTabs] }).catch(() => undefined);
  };
  const notifyPageStopped = (tabId: number, documentId: string): void => {
    void chromeApi.tabs
      ?.sendMessage(tabId, {
        version: MESSAGE_VERSION,
        requestId: `background:${tabId}:${++commandCounter}`,
        type: "STOP_SESSION",
        tabId,
        documentId,
      })
      // 页面可能已经卸载或没有 content script:静默忽略。
      ?.catch?.(() => undefined);
  };
  /**
   * 回填落地前就被导航 / 关闭忘掉的标签页 → 当时是否要求通知页面停下。
   *
   * 唤醒 SW 的往往正是这次导航或关闭本身,那时 activeTabs 还空着,清理无从下手;
   * 没有墓碑,回填就会把陈旧记录塞回内存,这个标签页于是再也忘不掉——旧 documentId
   * 一直顶着,页面新会话的状态中继全被判成过期文档。
   */
  const forgottenTabs = new Map<number, boolean>();
  let hydrating = sessionArea !== undefined;
  const hydrated = (async () => {
    if (sessionArea === undefined) return;
    try {
      const stored = await sessionArea.get(ACTIVE_TABS_KEY);
      const entries = stored[ACTIVE_TABS_KEY];
      if (!Array.isArray(entries)) return;
      let dropped = false;
      for (const entry of entries) {
        if (!Array.isArray(entry) || typeof entry[0] !== "number") continue;
        const tabId = entry[0];
        const record = entry[1] as ActiveDocument;
        const notifyPage = forgottenTabs.get(tabId);
        if (notifyPage !== undefined) {
          // 已经忘掉了,不许塞回来。SPA 导航还得通知页面里那个仍然活着的 controller
          // 停下——它攥着的正是这条记录里的 documentId。调度器不用管:route 一律先等
          // 回填,回填之前谁也没法把请求排进去,此刻它必然是空的。
          if (notifyPage) notifyPageStopped(tabId, record.documentId);
          dropped = true;
          continue;
        }
        // 已经建立的会话优先:hydrate 只补空缺，绝不覆盖本次运行的现况。
        if (!activeTabs.has(tabId)) activeTabs.set(tabId, record);
      }
      if (dropped) persistActiveTabs();
    } catch {
      // session 不可用:退回纯内存。
    } finally {
      hydrating = false;
      forgottenTabs.clear();
    }
  })();
  const pausedProfiles = new Map<string, string>();
  /** content 侧那条 syntax-learning 端口:流式分片的唯一推送通道。 */
  const documentPorts = new Map<string, chrome.runtime.Port>();

  const profileCredentialFingerprint = (profile: ModelProfile): string =>
    JSON.stringify([
      profile.baseUrl,
      profile.apiKey,
      profile.model,
      Object.entries(profile.headers).sort(([left], [right]) => left.localeCompare(right)),
    ]);

  const pauseProfile = (profile: ModelProfile): void => {
    pausedProfiles.set(profile.id, profileCredentialFingerprint(profile));
  };

  const resumeProfile = (profile: ModelProfile): void => {
    pausedProfiles.delete(profile.id);
  };

  const isProfilePaused = (profile: ModelProfile): boolean => {
    const pausedFingerprint = pausedProfiles.get(profile.id);
    if (pausedFingerprint === undefined) return false;
    if (pausedFingerprint === profileCredentialFingerprint(profile)) return true;
    pausedProfiles.delete(profile.id);
    return false;
  };

  /**
   * @param notifyPage SPA 导航时必须置位:文档没有重载，content script 里的
   *   controller 还活着，只清 SW 侧状态它照样会被 MutationObserver 唤醒去解析
   *   新页面。标签页关闭那条路径不需要，页面已经没了。
   */
  const cancelTab = (tabId: number, notifyPage = false): void => {
    // 回填还没落地时先立墓碑,别的都照旧同步做完。这里不能改成「等回填之后再清」:
    // 紧随导航而来的状态中继会先看到旧 documentId 而被判成过期文档,页面的新会话
    // 就再也登记不上——SPA 导航正是这个次序。
    if (hydrating) forgottenTabs.set(tabId, notifyPage);
    const active = activeTabs.get(tabId);
    if (active === undefined) return;
    dependencies.scheduler.cancelDocument(active.documentId);
    activeTabs.delete(tabId);
    persistActiveTabs();
    if (notifyPage) notifyPageStopped(tabId, active.documentId);
  };

  const inject = async (tabId: number): Promise<void> => {
    await chromeApi.scripting.executeScript({
      target: { tabId },
      files: [CONTENT_SCRIPT_FILE],
    });
  };

  const sendPageCommand = async (
    tabId: number,
    documentId: string,
    body:
      | { type: "START_SESSION"; prefetchDetail?: true }
      | { type: "PARSE_SELECTION"; selectionText: string }
      | { type: "PARSE_CONTEXT_BLOCK" }
      | { type: "PARSE_HOVERED_BLOCK" }
      | { type: "DIAGNOSE_BLOCK"; selectionText?: string },
  ): Promise<unknown> => {
    const message: RequestMessage = {
      ...body,
      version: MESSAGE_VERSION,
      requestId: `background:${tabId}:${++commandCounter}`,
      tabId,
      documentId,
    };
    return chromeApi.tabs.sendMessage(tabId, message);
  };

  const profileFor = async (tabId: number): Promise<ModelProfile | undefined> => {
    const selectedId = activeTabs.get(tabId)?.status.profileId;
    if (selectedId === undefined) return dependencies.configRepository.getActiveProfile();
    // pin 的 profile 可能已被删除:回退当前启用配置,而不是静默降级纯缓存。
    return (
      (await dependencies.configRepository.getProfile(selectedId)) ??
      dependencies.configRepository.getActiveProfile()
    );
  };

  const route = async (
    request: RequestMessage,
    sender: chrome.runtime.MessageSender,
  ): Promise<ResponseMessage> => {
    const trustedExtensionUi =
      sender.tab === undefined &&
      sender.id === chromeApi.runtime.id &&
      sender.url?.startsWith(`chrome-extension://${chromeApi.runtime.id}/`) === true;
    const trustedPageControl =
      trustedExtensionUi &&
      (request.type === "START_SESSION" ||
        request.type === "PAUSE_SESSION" ||
        request.type === "STOP_SESSION" ||
        request.type === "GET_SESSION_STATUS" ||
        request.type === "SWITCH_PROFILE" ||
        request.type === "REANALYZE_VISIBLE");
    // 拒绝判定读的就是 activeTabs:重启后若还没回填就判，会把合法请求当成过期文档。
    await hydrated;
    if ("tabId" in request) {
      if (sender.tab?.id !== request.tabId && !trustedExtensionUi) {
        return errorResponse(request.requestId, "UNSUPPORTED_PAGE");
      }
      const active = activeTabs.get(request.tabId);
      if (
        active !== undefined &&
        active.documentId !== request.documentId &&
        request.type !== "START_SESSION" &&
        !trustedPageControl
      ) {
        return errorResponse(request.requestId, "REQUEST_CANCELLED");
      }
    }

    try {
      switch (request.type) {
        case "ANALYZE_CORE": {
          const profile = await profileFor(request.tabId);
          const streamSink =
            (documentId: string, activeProfile: ModelProfile): StreamedComponentSink =>
            (sentenceId, components) => {
              const port = documentPorts.get(documentId);
              if (port === undefined) return;
              const push: CoreStreamPush = {
                version: MESSAGE_VERSION,
                type: "CORE_STREAM",
                documentId,
                sentenceId,
                // 分片同样是模型输出，脱敏不能因为"只是预览"就跳过。
                components: components.map((component) => ({
                  startToken: component.startToken,
                  endToken: component.endToken,
                  role: component.role,
                  translation: redactProfileSecrets(component.translation, activeProfile),
                })),
              };
              try {
                port.postMessage(push);
              } catch {
                // 页面已走:丢掉这条端口，别把后续分片继续往死通道里塞。
                documentPorts.delete(documentId);
              }
            };
          if (profile === undefined) {
            // 纯缓存查看:只回命中,未命中句子由 content 侧保持原文;无 key 可脱敏,直接返回。
            const analyses = await dependencies.analysisService.lookupCore(request.sentences);
            return {
              version: MESSAGE_VERSION,
              requestId: request.requestId,
              type: "CORE_RESULT",
              analyses,
              cacheOnly: true,
            };
          }
          // 鉴权失败/暂停期间不整批报错：缓存命中照常返回（缓存键与模型无关），
          // 只有未命中句由 content 按批级 error 标失败——换/修模型前译文不消失。
          const cacheWithAuthError = async (): Promise<ResponseMessage> => ({
            version: MESSAGE_VERSION,
            requestId: request.requestId,
            type: "CORE_RESULT",
            analyses: (await dependencies.analysisService.lookupCore(request.sentences)).map(
              (analysis) => sanitizeCore(analysis, profile),
            ),
            error: errorResponse(request.requestId, "AUTH_FAILED").error,
          });
          if (isProfilePaused(profile)) return cacheWithAuthError();
          const streaming =
            documentPorts.has(request.documentId) &&
            (await dependencies.configRepository.getStreamRendering());
          try {
            const outcome = await dependencies.analysisService.analyzeCore(
              {
                profile,
                documentId: request.documentId,
                sentences: request.sentences,
                priority: request.offscreen === true ? "prefetch-core" : "visible-core",
                ...(request.bypassCache === true ? { bypassCache: true } : {}),
                ...(streaming
                  ? { onStreamedComponent: streamSink(request.documentId, profile) }
                  : {}),
              },
              new AbortController().signal,
            );
            const authenticationFailure = outcome.failures.find(
              ({ error }) => error.code === "AUTH_FAILED",
            );
            if (authenticationFailure !== undefined) {
              pauseProfile(profile);
              return {
                version: MESSAGE_VERSION,
                requestId: request.requestId,
                type: "CORE_RESULT",
                analyses: outcome.result.map((analysis) => sanitizeCore(analysis, profile)),
                error: errorResponse(request.requestId, "AUTH_FAILED").error,
              };
            }
            return {
              version: MESSAGE_VERSION,
              requestId: request.requestId,
              type: "CORE_RESULT",
              analyses: outcome.result.map((analysis) => sanitizeCore(analysis, profile)),
              // 逐句失败原因随批下发（消息经 redactProfileSecrets 脱敏）：content 侧
              // 不再只能给「模型未返回此句的解析结果」的笼统文案。
              ...(outcome.failures.length === 0
                ? {}
                : {
                    failures: outcome.failures.map(({ sentenceId, error }) => ({
                      sentenceId,
                      error: {
                        code: errorCode(error),
                        message: redactProfileSecrets(error.message, profile),
                        retryable: error.retryable,
                      },
                    })),
                  }),
            };
          } catch (error) {
            const code = errorCode(error);
            if (code === "AUTH_FAILED") {
              pauseProfile(profile);
              return cacheWithAuthError();
            }
            return errorResponse(request.requestId, code);
          }
        }
        case "ANALYZE_DETAIL": {
          const profile = await profileFor(request.tabId);
          if (profile === undefined) {
            const analysis = await dependencies.analysisService.lookupDetail({
              sentence: request.sentence,
              focus: request.focus,
            });
            return analysis === undefined
              ? errorResponse(request.requestId, "NO_CACHE")
              : {
                  version: MESSAGE_VERSION,
                  requestId: request.requestId,
                  type: "DETAIL_RESULT",
                  analysis,
                };
          }
          if (isProfilePaused(profile)) {
            // 暂停期间详解也先查缓存：命中直接返回，未命中才报鉴权失败。
            const cached = await dependencies.analysisService.lookupDetail({
              sentence: request.sentence,
              focus: request.focus,
            });
            return cached === undefined
              ? errorResponse(request.requestId, "AUTH_FAILED")
              : {
                  version: MESSAGE_VERSION,
                  requestId: request.requestId,
                  type: "DETAIL_RESULT",
                  analysis: sanitizeDetail(cached, profile),
                };
          }
          const detailSink: StreamedStructureSink = (sentenceId, focus, structures) => {
            const port = documentPorts.get(request.documentId);
            if (port === undefined) return;
            const push: DetailStreamPush = {
              version: MESSAGE_VERSION,
              type: "DETAIL_STREAM",
              documentId: request.documentId,
              sentenceId,
              focus: { startToken: focus.startToken, endToken: focus.endToken },
              // 分片同样要脱敏:模型响应里若混入凭据，预览阶段一样不能漏出去。
              structures: structures.map((structure) => ({
                startToken: structure.startToken,
                endToken: structure.endToken,
                role: redactProfileSecrets(structure.role, profile),
                explanation: redactProfileSecrets(structure.explanation, profile),
                ...(structure.translation === undefined
                  ? {}
                  : { translation: redactProfileSecrets(structure.translation, profile) }),
              })),
            };
            try {
              port.postMessage(push);
            } catch {
              documentPorts.delete(request.documentId);
            }
          };
          const detailStreaming =
            documentPorts.has(request.documentId) &&
            (await dependencies.configRepository.getStreamRendering());
          try {
            const outcome = await dependencies.analysisService.analyzeDetail(
              {
                profile,
                documentId: request.documentId,
                sentence: request.sentence,
                core: request.core,
                focus: request.focus,
                ...(detailStreaming ? { onStreamedStructure: detailSink } : {}),
              },
              new AbortController().signal,
            );
            return {
              version: MESSAGE_VERSION,
              requestId: request.requestId,
              type: "DETAIL_RESULT",
              analysis: sanitizeDetail(outcome.result, profile),
            };
          } catch (error) {
            const code = errorCode(error);
            if (code === "AUTH_FAILED") pauseProfile(profile);
            return errorResponse(request.requestId, code);
          }
        }
        case "PREFETCH_SENTENCE_DETAILS": {
          const profile = await profileFor(request.tabId);
          if (profile === undefined) return errorResponse(request.requestId, "CONFIG_MISSING");
          if (isProfilePaused(profile)) return errorResponse(request.requestId, "AUTH_FAILED");
          try {
            const outcome = await dependencies.analysisService.analyzeSentenceDetails(
              {
                profile,
                documentId: request.documentId,
                sentence: request.sentence,
                core: request.core,
              },
              new AbortController().signal,
            );
            return {
              version: MESSAGE_VERSION,
              requestId: request.requestId,
              type: "SENTENCE_DETAILS_RESULT",
              succeeded: outcome.succeeded,
              failed: outcome.failed,
            };
          } catch (error) {
            const code = errorCode(error);
            if (code === "AUTH_FAILED") pauseProfile(profile);
            return errorResponse(request.requestId, code);
          }
        }
        case "REANALYZE_WITH_FEEDBACK": {
          const profile = await profileFor(request.tabId);
          if (profile === undefined) return errorResponse(request.requestId, "CONFIG_MISSING");
          if (isProfilePaused(profile)) return errorResponse(request.requestId, "AUTH_FAILED");
          try {
            const outcome = await dependencies.analysisService.reanalyzeWithFeedback(
              {
                profile,
                documentId: request.documentId,
                sentence: request.sentence,
                core: request.core,
                feedback: request.feedback,
                pageUrl: sender.tab?.url ?? "",
                sentenceInstanceId: request.sentence.sentenceId,
              },
              new AbortController().signal,
            );
            return {
              version: MESSAGE_VERSION,
              requestId: request.requestId,
              type: "CORE_RESULT",
              analyses: [sanitizeCore(outcome.result, profile)],
            };
          } catch (error) {
            const code = errorCode(error);
            if (code === "AUTH_FAILED") pauseProfile(profile);
            return errorResponse(request.requestId, code);
          }
        }
        case "SWITCH_PROFILE": {
          const profile = await dependencies.configRepository.getProfile(request.profileId);
          if (profile === undefined) return errorResponse(request.requestId, "CONFIG_MISSING");
          await dependencies.configRepository.setActiveProfile(profile.id);
          const active = activeTabs.get(request.tabId);
          activeTabs.set(request.tabId, {
            documentId: active?.documentId ?? request.documentId,
            status: { ...(active?.status ?? emptyStatus("stopped")), profileId: profile.id },
          });
          persistActiveTabs();
          return {
            version: MESSAGE_VERSION,
            requestId: request.requestId,
            type: "ACK",
            acknowledgedType: request.type,
          };
        }
        case "GET_SESSION_STATUS":
          return {
            version: MESSAGE_VERSION,
            requestId: request.requestId,
            type: "SESSION_STATUS",
            status: activeTabs.get(request.tabId)?.status ?? emptyStatus("stopped"),
          };
        case "START_SESSION": {
          if (!trustedExtensionUi) return errorResponse(request.requestId, "UNSUPPORTED_PAGE");
          const previous = activeTabs.get(request.tabId);
          const documentId =
            trustedExtensionUi && previous !== undefined ? previous.documentId : request.documentId;
          if (previous !== undefined && previous.documentId !== documentId) {
            dependencies.scheduler.cancelDocument(previous.documentId);
          }
          await inject(request.tabId);
          const profile = await dependencies.configRepository.getActiveProfile();
          const prefetchDetail =
            profile !== undefined && (await dependencies.configRepository.getPrefetchDetail());
          const status = emptyStatus("running", profile?.id);
          activeTabs.set(request.tabId, { documentId, status });
          persistActiveTabs();
          await sendPageCommand(request.tabId, documentId, {
            type: "START_SESSION",
            ...(prefetchDetail ? { prefetchDetail: true } : {}),
          });
          return {
            version: MESSAGE_VERSION,
            requestId: request.requestId,
            type: "SESSION_STATUS",
            status,
          };
        }
        case "PAUSE_SESSION":
        case "STOP_SESSION": {
          if (!trustedExtensionUi) return errorResponse(request.requestId, "UNSUPPORTED_PAGE");
          await inject(request.tabId);
          const previous = activeTabs.get(request.tabId);
          const documentId = previous?.documentId ?? request.documentId;
          await chromeApi.tabs.sendMessage(request.tabId, { ...request, documentId });
          const status = {
            ...(previous?.status ?? emptyStatus("stopped")),
            state: request.type === "PAUSE_SESSION" ? "paused" : "stopped",
          } satisfies SessionStatus;
          activeTabs.set(request.tabId, { documentId, status });
          persistActiveTabs();
          if (request.type === "STOP_SESSION") dependencies.scheduler.cancelDocument(documentId);
          return {
            version: MESSAGE_VERSION,
            requestId: request.requestId,
            type: "SESSION_STATUS",
            status,
          };
        }
        case "REANALYZE_VISIBLE": {
          if (!trustedExtensionUi) return errorResponse(request.requestId, "UNSUPPORTED_PAGE");
          const active = activeTabs.get(request.tabId);
          if (active === undefined || active.status.state === "stopped") {
            return errorResponse(request.requestId, "UNSAFE_CONTENT_BLOCK");
          }
          await chromeApi.tabs.sendMessage(request.tabId, {
            ...request,
            documentId: active.documentId,
          });
          return {
            version: MESSAGE_VERSION,
            requestId: request.requestId,
            type: "SESSION_STATUS",
            status: active.status,
          };
        }
        case "PARSE_SELECTION":
        case "PARSE_HOVERED_BLOCK": {
          if (!trustedExtensionUi) return errorResponse(request.requestId, "UNSUPPORTED_PAGE");
          const previous = activeTabs.get(request.tabId);
          // 扩展页面只会送来占位 documentId(popup-tab-N):照它下发,页面就按这个 id 再建
          // 一个 controller——同一个标签页两套会话,卡片与上游调用都翻倍,而它的状态中继
          // 还会因为与 activeTabs 里的 documentId 不符被判 REQUEST_CANCELLED。
          const documentId = previous?.documentId ?? request.documentId;
          await inject(request.tabId);
          const profile = await dependencies.configRepository.getActiveProfile();
          // 这两个手势在会话未启动时由页面侧自行轻量冷启动,所以「停止」要翻成「进行中」;
          // 已在跑 / 已暂停的原样保留——清零会抹掉真实计数,还会把暂停谎报成进行中。
          // 不落这一笔,SW 眼里这个标签页始终是停止:弹窗回落成「开始学习」,
          //「解析此区域」与「重新解析可见段落」也一律按 stopped 拒掉。
          const status =
            previous === undefined || previous.status.state === "stopped"
              ? emptyStatus("running", profile?.id)
              : previous.status;
          activeTabs.set(request.tabId, { documentId, status });
          persistActiveTabs();
          await chromeApi.tabs.sendMessage(request.tabId, { ...request, documentId });
          return {
            version: MESSAGE_VERSION,
            requestId: request.requestId,
            type: "ACK",
            acknowledgedType: request.type,
          };
        }
        case "PARSE_CONTEXT_BLOCK": {
          if (!trustedExtensionUi) return errorResponse(request.requestId, "UNSUPPORTED_PAGE");
          const active = activeTabs.get(request.tabId);
          if (active === undefined || active.status.state === "stopped") {
            return errorResponse(request.requestId, "UNSAFE_CONTENT_BLOCK");
          }
          await chromeApi.tabs.sendMessage(request.tabId, request);
          return {
            version: MESSAGE_VERSION,
            requestId: request.requestId,
            type: "ACK",
            acknowledgedType: request.type,
          };
        }
        case "TEST_PROFILE": {
          const profile = await dependencies.configRepository.getProfile(request.profileId);
          if (profile === undefined) {
            return {
              version: MESSAGE_VERSION,
              requestId: request.requestId,
              type: "PROFILE_TEST_RESULT",
              profileId: request.profileId,
              success: false,
              error: errorResponse(request.requestId, "CONFIG_MISSING").error,
            };
          }
          // 测试连接是显式的用户自检动作：不被暂停门拦截，真实探测；
          // 成功即解除暂停，用户修好服务端后无需重载扩展即可恢复解析。
          const startedAt = Date.now();
          try {
            const jsonSchemaSupport = await dependencies.profileProbe(
              profile,
              new AbortController().signal,
            );
            resumeProfile(profile);
            return {
              version: MESSAGE_VERSION,
              requestId: request.requestId,
              type: "PROFILE_TEST_RESULT",
              profileId: request.profileId,
              success: true,
              latencyMs: Date.now() - startedAt,
              jsonSchemaSupport,
            };
          } catch (error) {
            const code = errorCode(error);
            if (code === "AUTH_FAILED") pauseProfile(profile);
            // Surface the provider's status and message so the options page
            // can show an actionable failure instead of a generic one.
            const providerDetails =
              error instanceof ModelRequestError
                ? {
                    ...(typeof error.details.status === "number"
                      ? { status: error.details.status }
                      : {}),
                    detail: error.message.slice(0, 300),
                  }
                : undefined;
            return {
              version: MESSAGE_VERSION,
              requestId: request.requestId,
              type: "PROFILE_TEST_RESULT",
              profileId: request.profileId,
              success: false,
              latencyMs: Date.now() - startedAt,
              error: errorResponse(request.requestId, code, providerDetails).error,
            };
          }
        }
        case "EXPLAIN_DIAGNOSIS": {
          const profile = await profileFor(request.tabId);
          // 错误嵌在 modelError 里而不是整包 ERROR:本地采集的诊断证据始终可用,
          // 模型解释只是渐进增强(spec D4)。
          const base = {
            version: MESSAGE_VERSION,
            requestId: request.requestId,
            type: "DIAGNOSIS_RESULT",
            diagnosis: request.diagnosis,
          } as const;
          if (profile === undefined) {
            return {
              ...base,
              modelError: errorResponse(request.requestId, "CONFIG_MISSING").error,
            };
          }
          if (isProfilePaused(profile)) {
            return { ...base, modelError: errorResponse(request.requestId, "AUTH_FAILED").error };
          }
          try {
            const model = await dependencies.analysisService.explainDiagnosis(
              { profile, documentId: request.documentId, diagnosis: request.diagnosis },
              new AbortController().signal,
            );
            return {
              ...base,
              model: redactDiagnosisExplanation(model, profile),
              profile: { model: profile.model },
            };
          } catch (error) {
            // validateDiagnosisExplanation 抛的是普通 Error(形状不符=模型输出非法),
            // 只有真正的模型请求错误才携带可映射的错误码;旧写法会把形状不符错报成
            // NETWORK_ERROR,违反 spec D4「不符就丢 modelError: INVALID_MODEL_OUTPUT」。
            const code =
              error instanceof ModelRequestError ? errorCode(error) : "INVALID_MODEL_OUTPUT";
            if (code === "AUTH_FAILED") pauseProfile(profile);
            return { ...base, modelError: errorResponse(request.requestId, code).error };
          }
        }
        case "DIAGNOSE_BLOCK":
          // 没有合法入站来源(SW 只发不收,右键菜单是唯一下发方);case 仅为满足
          // assertNever 穷尽性。页面侧伪造的入站一律按协议不合规拒绝。
          return errorResponse(request.requestId, "MALFORMED_MESSAGE");
        case "GET_CACHE_STATS":
          return {
            version: MESSAGE_VERSION,
            requestId: request.requestId,
            type: "CACHE_STATS",
            stats: await dependencies.cache.stats(),
          };
        case "CLEAR_CACHE":
          await dependencies.cache.clear();
          return {
            version: MESSAGE_VERSION,
            requestId: request.requestId,
            type: "ACK",
            acknowledgedType: request.type,
          };
        default:
          return assertNever(request);
      }
    } catch (error) {
      return errorResponse(request.requestId, errorCode(error));
    }
  };

  // 右键菜单注册不能只挂在 onInstalled 上：--load-extension 首次加载（E2E 探针实测）
  // 与部分真机场景下该事件不触发，三个菜单全部缺失，右键永远看不到入口。改为
  // SW 每次启动都兜底确保一次（守卫去重，同一生命周期内 onInstalled 再到为 no-op；
  // 扩展升级会换新的 SW 生命周期，自然重建）。
  let contextMenusEnsured = false;
  const ensureContextMenus = (): void => {
    if (contextMenusEnsured) return;
    contextMenusEnsured = true;
    void (async () => {
      await chromeApi.contextMenus.removeAll();
      chromeApi.contextMenus.create({
        id: SELECTION_MENU_ID,
        title: "解析选中文本",
        contexts: ["selection"],
      });
      chromeApi.contextMenus.create({
        id: CONTEXT_BLOCK_MENU_ID,
        title: "解析此区域",
        contexts: ["page"],
      });
      chromeApi.contextMenus.create({
        id: DIAGNOSE_MENU_ID,
        title: "诊断：这段为什么没解析",
        contexts: ["page", "selection"],
      });
    })();
  };

  chromeApi.runtime.onInstalled?.addListener(ensureContextMenus);
  ensureContextMenus();

  chromeApi.action?.onClicked.addListener((tab) => {
    if (tab.id === undefined) return;
    const tabId = tab.id;
    void (async () => {
      await hydrated;
      const documentId = activeTabs.get(tabId)?.documentId ?? generatedDocumentId(tabId);
      await inject(tabId);
      const profile = await dependencies.configRepository.getActiveProfile();
      const prefetchDetail =
        profile !== undefined && (await dependencies.configRepository.getPrefetchDetail());
      activeTabs.set(tabId, {
        documentId,
        status: emptyStatus("running", profile?.id),
      });
      persistActiveTabs();
      await sendPageCommand(tabId, documentId, {
        type: "START_SESSION",
        ...(prefetchDetail ? { prefetchDetail: true } : {}),
      });
    })();
  });

  chromeApi.commands?.onCommand.addListener((command, tab) => {
    if (command !== HOVERED_BLOCK_COMMAND) return;
    const tabId = tab?.id;
    if (tabId === undefined) return;
    void (async () => {
      await hydrated;
      const documentId = activeTabs.get(tabId)?.documentId ?? generatedDocumentId(tabId);
      await inject(tabId);
      const profile = await dependencies.configRepository.getActiveProfile();
      activeTabs.set(tabId, {
        documentId,
        status: emptyStatus("running", profile?.id),
      });
      persistActiveTabs();
      await sendPageCommand(tabId, documentId, { type: "PARSE_HOVERED_BLOCK" });
    })().catch(() => {
      // chrome:// 等不可注入页面：静默忽略。
    });
  });

  chromeApi.contextMenus?.onClicked.addListener((info, tab) => {
    const tabId = tab?.id;
    if (tabId === undefined) return;
    if (info.menuItemId === SELECTION_MENU_ID) {
      void (async () => {
        await hydrated;
        const documentId = activeTabs.get(tabId)?.documentId ?? generatedDocumentId(tabId);
        await inject(tabId);
        const profile = await dependencies.configRepository.getActiveProfile();
        activeTabs.set(tabId, {
          documentId,
          status: emptyStatus("running", profile?.id),
        });
        persistActiveTabs();
        if (typeof info.selectionText === "string" && info.selectionText.trim().length > 0) {
          await sendPageCommand(tabId, documentId, {
            type: "PARSE_SELECTION",
            selectionText: info.selectionText,
          });
        }
      })();
      return;
    }
    if (info.menuItemId === CONTEXT_BLOCK_MENU_ID) {
      const active = activeTabs.get(tabId);
      if (active === undefined || active.status.state === "stopped") {
        return errorResponse(`background:${tabId}:${++commandCounter}`, "UNSAFE_CONTENT_BLOCK");
      }
      void sendPageCommand(tabId, active.documentId, { type: "PARSE_CONTEXT_BLOCK" });
      return;
    }
    if (info.menuItemId === DIAGNOSE_MENU_ID) {
      void (async () => {
        await hydrated;
        // 会话有账优先用账上 id 并清掉诊断记忆；无账则按 tab 复用记忆的 id，首次
        // 才现生成——同一 tab 反复诊断复用 content 侧同一个 controller/transport
        // （见 diagnosisDocumentIds 的注释）。
        const recorded = activeTabs.get(tabId)?.documentId;
        if (recorded !== undefined) {
          diagnosisDocumentIds.delete(tabId);
        }
        let documentId = recorded ?? diagnosisDocumentIds.get(tabId);
        if (documentId === undefined) {
          documentId = generatedDocumentId(tabId);
          diagnosisDocumentIds.set(tabId, documentId);
        }
        await inject(tabId);
        // 诊断是只读手势，刻意不写 activeTabs：记账会把未启动会话的 tab 伪造成
        // running，popup 随即显示不存在的进行中会话，还绕过「解析此区域」的 stopped
        // 门（spec D1）。一致性门无账时放行、有账时此处已复用账上 documentId。
        await sendPageCommand(tabId, documentId, {
          type: "DIAGNOSE_BLOCK",
          ...(typeof info.selectionText === "string" && info.selectionText.trim().length > 0
            ? { selectionText: info.selectionText }
            : {}),
        });
      })().catch(() => {
        // chrome:// 等不可注入页面：静默忽略（与 commands 分支同款）。
      });
    }
  });

  chromeApi.runtime.onMessage.addListener((value, sender, sendResponse) => {
    if (typeof sendResponse !== "function") return undefined;
    void (async () => {
      if (isStatusRelay(value)) {
        const tabId = value.tabId ?? sender.tab?.id;
        const documentId = relayDocumentId(value);
        if (tabId === undefined || sender.tab?.id !== tabId || documentId === undefined) {
          return errorResponse(value.requestId, "UNSUPPORTED_PAGE");
        }
        const active = activeTabs.get(tabId);
        if (active !== undefined && active.documentId !== documentId) {
          return errorResponse(value.requestId, "REQUEST_CANCELLED");
        }
        activeTabs.set(tabId, { documentId, status: value.status });
        persistActiveTabs();
        return {
          version: MESSAGE_VERSION,
          requestId: value.requestId,
          type: "ACK",
          acknowledgedType: "GET_SESSION_STATUS",
        } satisfies ResponseMessage;
      }
      if (!isRequestMessage(value)) {
        return errorResponse(requestIdOf(value), "MALFORMED_MESSAGE");
      }
      return route(value, sender);
      // 返回 true 后必须回包，否则发送方会报 "message channel closed"；
      // route 内部已兜底，这里再兜一层防御意外拒绝。
    })().then(sendResponse, () => sendResponse(errorResponse(requestIdOf(value), "NETWORK_ERROR")));
    return true;
  });

  chromeApi.runtime.onConnect?.addListener((port) => {
    const tabId = port.sender?.tab?.id;
    if (tabId === undefined || !port.name.startsWith("syntax-learning:")) return;
    const documentId = port.name.slice("syntax-learning:".length);
    if (documentId.length === 0) return;
    // 挂端口与断开监听必须同步做完:await 之后再挂会漏掉这中间发生的断开事件。
    documentPorts.set(documentId, port);
    port.onDisconnect.addListener(() => {
      // 读一次 lastError,避免页面进 bfcache 关闭端口时控制台打
      // "Unchecked runtime.lastError"。
      void chromeApi.runtime.lastError;
      // 同一个 documentId 可能已经用新端口重连(SW 重启、bfcache 恢复):陈旧端口的
      // 断开事件不许碰会话,否则会取消刚接上的那条会话并把状态清成 stopped——页面上
      // 卡片还在,弹窗却显示「开始学习」。
      if (documentPorts.get(documentId) !== port) return;
      documentPorts.delete(documentId);
      void (async () => {
        await hydrated;
        if (activeTabs.get(tabId)?.documentId !== documentId) return;
        dependencies.scheduler.cancelDocument(documentId);
        activeTabs.delete(tabId);
        persistActiveTabs();
      })();
    });
    void (async () => {
      // activeTabs 要等 session 回填:抢在回填之前写,会把「进行中」的会话覆盖成
      // stopped(弹窗于是回落成「开始学习」，而页面上卡片一张没少)。
      await hydrated;
      // 这条记录归谁不由端口说了算:已有记录(不论 documentId 是否相同)一律照旧,
      // 状态由 SESSION_STATUS 中继与各启动路径维护。
      if (activeTabs.get(tabId) !== undefined) return;
      activeTabs.set(tabId, { documentId, status: emptyStatus("stopped") });
      persistActiveTabs();
    })();
  });

  chromeApi.tabs?.onRemoved?.addListener((tabId) => cancelTab(tabId));
  chromeApi.tabs?.onUpdated?.addListener((tabId, changeInfo) => {
    // SPA 换页走 history.pushState:不重载文档，没有 loading，只有 url 变化。
    if (changeInfo.url !== undefined) cancelTab(tabId, true);
    else if (changeInfo.status === "loading") cancelTab(tabId);
  });
}

export async function requestHostPermission(
  profile: Pick<ModelProfile, "baseUrl">,
): Promise<boolean> {
  return chrome.permissions.request({ origins: [hostPermissionPattern(profile.baseUrl)] });
}

/**
 * 调度器库默认只允许 2 个批次在飞，这把整个扩展卡在了 2 条并发上：视口观察器的
 * rootMargin 是 100%，一次会放出上下各一屏的全部段落，队尾要干等好几轮完整的模型
 * 往返。调度器已改为 1 请求 = 1 槽位，所以这就是真实在飞的模型请求数上限。
 */
export const MODEL_REQUEST_CONCURRENCY = 4;

export function createModelRequestScheduler(
  runTask: RunTask<AnalysisModelWork, unknown>,
): RequestScheduler<AnalysisModelWork, unknown> {
  return new RequestScheduler<AnalysisModelWork, unknown>({
    runTask,
    concurrency: MODEL_REQUEST_CONCURRENCY,
    maxSentencesPerRequest: MAX_SENTENCES_PER_REQUEST,
  });
}

interface ProfileCapabilityPort {
  getProfile(profileId: string): Promise<ModelProfile | undefined>;
  saveProfile(profile: ModelProfile): Promise<void>;
}

/**
 * 把探到的端点能力写回 profile。两者都必须接线:漏掉任一个，扩展就会在每次请求上
 * 重复交同一笔学费(被拒的 response_format 或 stream 各要白费一趟 4xx)。
 */
export function createProfileCapabilityWriters(configRepository: ProfileCapabilityPort): {
  persistJsonSchemaSupport: (
    profileId: string,
    jsonSchemaSupport: ModelProfile["jsonSchemaSupport"],
  ) => Promise<void>;
  persistStreamSupport: (profileId: string, streamSupport: "unsupported") => Promise<void>;
  persistReasoningControl: (profileId: string, reasoningControl: "unsupported") => Promise<void>;
} {
  const update = async (profileId: string, patch: Partial<ModelProfile>): Promise<void> => {
    const profile = await configRepository.getProfile(profileId);
    if (profile !== undefined) await configRepository.saveProfile({ ...profile, ...patch });
  };
  return {
    persistJsonSchemaSupport: (profileId, jsonSchemaSupport) =>
      update(profileId, { jsonSchemaSupport }),
    persistStreamSupport: (profileId, streamSupport) => update(profileId, { streamSupport }),
    persistReasoningControl: (profileId, reasoningControl) =>
      update(profileId, { reasoningControl }),
  };
}

async function createDefaultRuntime(): Promise<
  Pick<ServiceWorkerDependencies, "analysisService" | "scheduler" | "cache" | "profileProbe">
> {
  const configRepository = new ConfigRepository();
  const cache = await AnalysisCache.open({
    limitBytes: await configRepository.getCacheLimitBytes(),
  });
  const adapter = new OpenAiCompatibleAdapter(createProfileCapabilityWriters(configRepository));
  const scheduler = createModelRequestScheduler((request, signal) => request.input.run(signal));
  return {
    cache,
    scheduler,
    analysisService: new CachedAnalysisService({ cache, adapter, scheduler }),
    profileProbe: (profile, signal) => adapter.probeJsonCapability(profile, signal),
  };
}

function defaultDependencies(): ServiceWorkerDependencies {
  const configRepository = new ConfigRepository();
  let runtime: ReturnType<typeof createDefaultRuntime> | undefined;
  const getRuntime = () => (runtime ??= createDefaultRuntime());
  return {
    configRepository,
    analysisService: {
      analyzeCore: async (...arguments_) =>
        (await getRuntime()).analysisService.analyzeCore(...arguments_),
      analyzeDetail: async (...arguments_) =>
        (await getRuntime()).analysisService.analyzeDetail(...arguments_),
      reanalyzeWithFeedback: async (...arguments_) =>
        (await getRuntime()).analysisService.reanalyzeWithFeedback(...arguments_),
      lookupCore: async (...arguments_) =>
        (await getRuntime()).analysisService.lookupCore(...arguments_),
      lookupDetail: async (...arguments_) =>
        (await getRuntime()).analysisService.lookupDetail(...arguments_),
      analyzeSentenceDetails: async (...arguments_) =>
        (await getRuntime()).analysisService.analyzeSentenceDetails(...arguments_),
      explainDiagnosis: async (...arguments_) =>
        (await getRuntime()).analysisService.explainDiagnosis(...arguments_),
    },
    scheduler: {
      cancelDocument: (documentId) => {
        void getRuntime().then(({ scheduler }) => scheduler.cancelDocument(documentId));
      },
    },
    cache: {
      stats: async () => (await getRuntime()).cache.stats(),
      clear: async () => (await getRuntime()).cache.clear(),
    },
    profileProbe: async (profile, signal) => (await getRuntime()).profileProbe(profile, signal),
  };
}

async function initialize(): Promise<void> {
  if (typeof chrome === "undefined" || chrome.storage?.local === undefined) return;
  await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  registerServiceWorker(defaultDependencies());
}

void initialize();
