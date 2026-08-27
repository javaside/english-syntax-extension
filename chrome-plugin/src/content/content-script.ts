import type { ExtensionError } from "../shared/errors";
import { ERROR_CODES } from "../shared/errors";
import { GrammarRole } from "../shared/grammar";
import { isCoreStreamPush, isDetailStreamPush, isRequestMessage } from "../shared/protocol";
import type {
  CoreStreamPush,
  DetailStreamPush,
  RequestMessage,
  ResponseMessage,
  SessionStatus,
} from "../shared/protocol";
import { CORE_SCHEMA_VERSION, MESSAGE_VERSION } from "../shared/versions";
import { installHoverTracker } from "./hover-target";
import { SyntaxProgressPill } from "./progress-pill";
import { SessionController } from "./session-controller";
import type { RuntimeTransport, SessionControllerOptions } from "./session-controller";

interface RoutedController {
  readonly status: SessionStatus;
  start(options?: { prefetchDetail?: boolean }): Promise<void>;
  pause(): void;
  resume(): void;
  stop(): void;
  parseSelection(selectionText: string): Promise<ExtensionError | undefined>;
  parseContextBlock(): Promise<ExtensionError | undefined>;
  parseHoveredBlock(): Promise<ExtensionError | undefined>;
  reanalyzeVisible(): void;
  switchProfile(profileId: string): void;
}

export interface ContentScriptRouterOptions {
  controllerFactory?: (options: SessionControllerOptions) => RoutedController;
  transportFactory?: (tabId: number, documentId: string) => RuntimeTransport;
  relayStatus?: (documentId: string, status: SessionStatus) => void;
  /** 悬停目标解析器:由内容脚本装载时安装(见 hover-target.ts,冷启动前就得记指针位置)。 */
  hoverTarget?: () => Element | null;
}

function invalidMessage(requestId = "invalid-message"): ResponseMessage {
  return {
    version: MESSAGE_VERSION,
    requestId,
    type: "ERROR",
    error: {
      code: "MALFORMED_MESSAGE",
      message: "内容脚本收到不合协议的消息",
      retryable: false,
    },
  };
}

function errorResponse(requestId: string, error: ExtensionError): ResponseMessage {
  return { version: MESSAGE_VERSION, requestId, type: "ERROR", error };
}

function channelError(requestId = "channel-error"): ResponseMessage {
  return errorResponse(requestId, {
    code: "NETWORK_ERROR",
    message: "扩展消息通道中断",
    retryable: true,
  });
}

function statusResponse(requestId: string, status: SessionStatus): ResponseMessage {
  return { version: MESSAGE_VERSION, requestId, type: "SESSION_STATUS", status };
}

function ack(request: RequestMessage): ResponseMessage {
  return {
    version: MESSAGE_VERSION,
    requestId: request.requestId,
    type: "ACK",
    acknowledgedType: request.type,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isRange(
  value: unknown,
): value is Record<string, unknown> & { startToken: number; endToken: number } {
  return (
    isRecord(value) &&
    isSafeInteger(value.startToken) &&
    isSafeInteger(value.endToken) &&
    value.startToken <= value.endToken
  );
}

function isCoreAnalysis(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.schemaVersion === CORE_SCHEMA_VERSION &&
    typeof value.sentenceId === "string" &&
    value.sentenceId.length > 0 &&
    typeof value.modelProfileId === "string" &&
    value.modelProfileId.length > 0 &&
    Array.isArray(value.components) &&
    value.components.every(
      (component) =>
        isRange(component) &&
        typeof component.role === "string" &&
        Object.values(GrammarRole).includes(component.role as GrammarRole) &&
        typeof component.translation === "string",
    )
  );
}

function isDetailAnalysis(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.sentenceId === "string" &&
    value.sentenceId.length > 0 &&
    typeof value.modelProfileId === "string" &&
    value.modelProfileId.length > 0 &&
    isRange(value.focus) &&
    Array.isArray(value.structures) &&
    value.structures.every(
      (structure) =>
        isRange(structure) &&
        isRecord(structure) &&
        typeof structure.role === "string" &&
        typeof structure.explanation === "string",
    ) &&
    Array.isArray(value.grammarPoints) &&
    value.grammarPoints.every((point) => typeof point === "string") &&
    typeof value.explanation === "string"
  );
}

function isSessionStatus(value: unknown): value is SessionStatus {
  return (
    isRecord(value) &&
    (value.state === "stopped" || value.state === "running" || value.state === "paused") &&
    isSafeInteger(value.discovered) &&
    isSafeInteger(value.queued) &&
    isSafeInteger(value.ready) &&
    isSafeInteger(value.failed) &&
    (value.cacheOnly === undefined || value.cacheOnly === true) &&
    (value.detailTotal === undefined || isSafeInteger(value.detailTotal)) &&
    (value.detailReady === undefined || isSafeInteger(value.detailReady)) &&
    (value.detailFailed === undefined || isSafeInteger(value.detailFailed)) &&
    (value.profileId === undefined || typeof value.profileId === "string")
  );
}

function isExtensionError(value: unknown): value is ExtensionError {
  return (
    isRecord(value) &&
    typeof value.code === "string" &&
    ERROR_CODES.includes(value.code as ExtensionError["code"]) &&
    typeof value.message === "string" &&
    typeof value.retryable === "boolean" &&
    (value.details === undefined || isRecord(value.details))
  );
}

export function isRuntimeResponse(value: unknown, requestId: string): value is ResponseMessage {
  if (
    !isRecord(value) ||
    value.version !== MESSAGE_VERSION ||
    value.requestId !== requestId ||
    typeof value.type !== "string"
  ) {
    return false;
  }
  switch (value.type) {
    case "ACK":
      return typeof value.acknowledgedType === "string";
    case "SESSION_STATUS":
      return isSessionStatus(value.status);
    case "CORE_RESULT":
      return (
        Array.isArray(value.analyses) &&
        value.analyses.every(isCoreAnalysis) &&
        (value.error === undefined || isExtensionError(value.error))
      );
    case "DETAIL_RESULT":
      return isDetailAnalysis(value.analysis);
    case "SENTENCE_DETAILS_RESULT":
      return isSafeInteger(value.succeeded) && isSafeInteger(value.failed);
    case "CACHE_STATS":
      return (
        isRecord(value.stats) &&
        isSafeInteger(value.stats.entries) &&
        isSafeInteger(value.stats.estimatedBytes) &&
        isSafeInteger(value.stats.limitBytes)
      );
    case "PROFILE_TEST_RESULT":
      return (
        typeof value.profileId === "string" &&
        typeof value.success === "boolean" &&
        (value.latencyMs === undefined || isSafeInteger(value.latencyMs)) &&
        (value.jsonSchemaSupport === undefined ||
          value.jsonSchemaSupport === "supported" ||
          value.jsonSchemaSupport === "unsupported") &&
        (value.error === undefined || isExtensionError(value.error))
      );
    case "ERROR":
      return isExtensionError(value.error);
    default:
      return false;
  }
}

interface RuntimeWatchdogPort {
  onDisconnect: { addListener(listener: () => void): void };
  onMessage: { addListener(listener: (message: unknown) => void): void };
  disconnect(): void;
}

export interface ContentRuntimeApi {
  connect(connectInfo: { name: string }): RuntimeWatchdogPort;
  sendMessage(message: unknown): Promise<unknown>;
}

function chromeRuntimeApi(): ContentRuntimeApi {
  return {
    connect: (connectInfo) => {
      const port = chrome.runtime.connect(connectInfo);
      return {
        disconnect: () => port.disconnect(),
        onMessage: {
          addListener: (listener) => port.onMessage.addListener(listener),
        },
        onDisconnect: {
          addListener: (listener) =>
            port.onDisconnect.addListener(() => {
              // 页面进 bfcache 时 Chrome 会关闭端口并设置 lastError;onDisconnect
              // 回调里不读它就会在控制台打 "Unchecked runtime.lastError"。
              void chrome.runtime.lastError;
              listener();
            }),
        },
      };
    },
    sendMessage: (message) => chrome.runtime.sendMessage(message),
  };
}

export class ChromeRuntimeTransport implements RuntimeTransport {
  private requestCounter = 0;
  private readonly disconnectHandlers = new Set<() => void>();
  private readonly streamHandlers = new Set<(push: CoreStreamPush | DetailStreamPush) => void>();
  private watchdog?: RuntimeWatchdogPort;

  constructor(
    private readonly tabId: number,
    private readonly documentId: string,
    private readonly runtime: ContentRuntimeApi = chromeRuntimeApi(),
  ) {
    this.connectWatchdog();
  }

  async send(message: RequestMessage): Promise<ResponseMessage> {
    let response: unknown;
    try {
      response = await this.runtime.sendMessage(message);
    } catch {
      // Service Worker 被回收或消息通道未回包即关闭（"listener indicated an
      // asynchronous response…"）：转成可重试错误走既有失败/重试路径，
      // 而不是让拒绝沿调用链冒成页面里的未捕获异常。
      return channelError(message.requestId);
    }
    if (!isRuntimeResponse(response, message.requestId)) {
      return invalidMessage(message.requestId);
    }
    return response;
  }

  cancelDocument(): void {
    const message: RequestMessage = {
      version: MESSAGE_VERSION,
      requestId: `${this.documentId}:cancel:${++this.requestCounter}`,
      type: "STOP_SESSION",
      tabId: this.tabId,
      documentId: this.documentId,
    };
    void this.runtime.sendMessage(message).catch(() => undefined);
  }

  onDisconnect(handler: () => void): () => void {
    this.disconnectHandlers.add(handler);
    return () => this.disconnectHandlers.delete(handler);
  }

  /**
   * 流式分片走的是端口推送，不是 sendMessage 的响应，所以 isRuntimeResponse 那套
   * switch 不适用——这里用 isCoreStreamPush 单独把关。
   */
  onStream(handler: (push: CoreStreamPush | DetailStreamPush) => void): () => void {
    this.streamHandlers.add(handler);
    return () => this.streamHandlers.delete(handler);
  }

  reconnect(): void {
    this.connectWatchdog();
  }

  dispose(): void {
    const watchdog = this.watchdog;
    this.watchdog = undefined;
    this.disconnectHandlers.clear();
    this.streamHandlers.clear();
    watchdog?.disconnect();
  }

  private connectWatchdog(): void {
    const watchdog = this.runtime.connect({ name: `syntax-learning:${this.documentId}` });
    this.watchdog = watchdog;
    watchdog.onMessage.addListener((message) => {
      const push = isCoreStreamPush(message)
        ? message
        : isDetailStreamPush(message)
          ? message
          : undefined;
      if (push === undefined || push.documentId !== this.documentId) return;
      for (const handler of this.streamHandlers) handler(push);
    });
    watchdog.onDisconnect.addListener(() => {
      if (this.watchdog !== watchdog) return;
      this.watchdog = undefined;
      for (const handler of this.disconnectHandlers) handler();
    });
  }
}

export class ContentScriptRouter {
  private readonly controllers = new Map<string, RoutedController>();

  constructor(private readonly options: ContentScriptRouterOptions = {}) {}

  async route(value: unknown): Promise<ResponseMessage> {
    if (!isRequestMessage(value) || !("documentId" in value) || !("tabId" in value)) {
      const requestId =
        typeof value === "object" &&
        value !== null &&
        typeof (value as { requestId?: unknown }).requestId === "string"
          ? (value as { requestId: string }).requestId
          : undefined;
      return invalidMessage(requestId);
    }
    const request = value;
    if (
      request.type === "ANALYZE_CORE" ||
      request.type === "ANALYZE_DETAIL" ||
      request.type === "REANALYZE_WITH_FEEDBACK"
    ) {
      return invalidMessage(request.requestId);
    }
    // 处理中抛异常也必须回包：route 的调用方（onMessage 监听器）已向发送方承诺
    // 异步响应，悬空会让 SW 侧报 "message channel closed"、页面侧留未捕获拒绝。
    try {
      const controller = this.controller(request.tabId, request.documentId);
      switch (request.type) {
        case "START_SESSION":
          await controller.start({ prefetchDetail: request.prefetchDetail === true });
          return statusResponse(request.requestId, controller.status);
        case "PAUSE_SESSION":
          controller.pause();
          return statusResponse(request.requestId, controller.status);
        case "STOP_SESSION":
          controller.stop();
          this.controllers.delete(request.documentId);
          return statusResponse(request.requestId, controller.status);
        case "GET_SESSION_STATUS":
          return statusResponse(request.requestId, controller.status);
        case "PARSE_SELECTION": {
          const error = await controller.parseSelection(request.selectionText);
          return error === undefined ? ack(request) : errorResponse(request.requestId, error);
        }
        case "PARSE_CONTEXT_BLOCK": {
          const error = await controller.parseContextBlock();
          return error === undefined ? ack(request) : errorResponse(request.requestId, error);
        }
        case "PARSE_HOVERED_BLOCK": {
          const error = await controller.parseHoveredBlock();
          return error === undefined ? ack(request) : errorResponse(request.requestId, error);
        }
        case "REANALYZE_VISIBLE":
          controller.reanalyzeVisible();
          return statusResponse(request.requestId, controller.status);
        case "SWITCH_PROFILE":
          controller.switchProfile(request.profileId);
          return ack(request);
        default:
          return invalidMessage();
      }
    } catch {
      return channelError(request.requestId);
    }
  }

  private controller(tabId: number, documentId: string): RoutedController {
    const existing = this.controllers.get(documentId);
    if (existing !== undefined) return existing;
    const transport = (
      this.options.transportFactory ??
      ((nextTabId, nextDocumentId) => new ChromeRuntimeTransport(nextTabId, nextDocumentId))
    )(tabId, documentId);
    const controller = (
      this.options.controllerFactory ??
      ((controllerOptions) => new SessionController(controllerOptions))
    )({
      tabId,
      documentId,
      transport,
      hoverTarget: this.options.hoverTarget,
      onStatus: (status) => this.options.relayStatus?.(documentId, status),
      requestFeedback: () => window.prompt("请描述需要纠正的语法解析；取消则重试详细解析"),
    });
    this.controllers.set(documentId, controller);
    return controller;
  }
}

function isExplicitParseCommand(message: unknown): boolean {
  const type = isRecord(message) ? message.type : undefined;
  return (
    type === "PARSE_HOVERED_BLOCK" || type === "PARSE_SELECTION" || type === "PARSE_CONTEXT_BLOCK"
  );
}

function installContentScript(): void {
  if (typeof chrome === "undefined" || chrome.runtime?.onMessage === undefined) return;
  if (document.documentElement.dataset.syntaxLearningExtension === "ready") return;
  let statusCounter = 0;
  const pill = new SyntaxProgressPill();
  // 先挂指针追踪:快捷键冷启动时会话还不存在,那时才开始记就晚了。
  const hoverTarget = installHoverTracker(document);
  const router = new ContentScriptRouter({
    hoverTarget,
    relayStatus: (documentId, status) => {
      pill.update(status);
      const message: ResponseMessage = {
        version: MESSAGE_VERSION,
        requestId: `${documentId}:status:${++statusCounter}`,
        type: "SESSION_STATUS",
        status,
      };
      void chrome.runtime.sendMessage(message).catch(() => undefined);
    },
  });
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    void router.route(message).then((response) => {
      // 三个显式手势(快捷键 / 解析选中文本 / 解析此区域)的失败都只能在页面里就地说:
      // 快捷键根本没有反馈渠道,右键菜单也只反馈「已触发」,而 SW 会丢弃页面命令的响应。
      // 于是「该段已解析」「未找到可解析的段落」「请先启动学习模式」全都要走胶囊。
      if (isExplicitParseCommand(message) && response.type === "ERROR") {
        pill.notice(response.error.message);
      }
      sendResponse(response);
    });
    return true;
  });
  document.documentElement.dataset.syntaxLearningExtension = "ready";
}

installContentScript();
