import { beforeEach, describe, expect, it, vi } from "vitest";
import { GrammarRole } from "../shared/grammar";
import { CORE_SCHEMA_VERSION } from "../shared/versions";
import type {
  BlockDiagnosis,
  ChatStreamPush,
  ChatTurn,
  RequestMessage,
  ResponseMessage,
  SentenceInput,
  SessionStatus,
} from "../shared/protocol";
import type { ModelProfile } from "./config-repository";
import type { AnalysisModelWork, AnalysisService } from "./analysis-service";
import { ModelRequestError } from "./openai-compatible-adapter";
import {
  createModelRequestScheduler,
  createProfileCapabilityWriters,
  registerServiceWorker,
  type ServiceWorkerDependencies,
} from "./service-worker";

function event<T extends (...args: never[]) => unknown>() {
  const listeners: T[] = [];
  return {
    addListener: vi.fn((listener: T) => listeners.push(listener)),
    listeners,
  };
}

function chromeMock(sessionSeed: Record<string, unknown> = {}) {
  const onInstalled = event<(details: chrome.runtime.InstalledDetails) => void>();
  const onMessage =
    event<
      (
        message: unknown,
        sender: chrome.runtime.MessageSender,
        sendResponse: (response: ResponseMessage) => void,
      ) => boolean | undefined
    >();
  const onConnect = event<(port: chrome.runtime.Port) => void>();
  const onClicked = event<(tab: chrome.tabs.Tab) => void>();
  const onContextClicked =
    event<(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab) => void>();
  const onCommand = event<(command: string, tab?: chrome.tabs.Tab) => void>();
  const onRemoved = event<(tabId: number) => void>();
  const onUpdated =
    event<(tabId: number, changeInfo: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => void>();
  // SW 休眠会清空内存态;session 存储专为熬过重启而设，测试要能跨"重启"共享它。
  const sessionData: Record<string, unknown> = sessionSeed;
  const sessionArea = {
    get: (key: string) => Promise.resolve({ [key]: sessionData[key] }),
    set: (items: Record<string, unknown>) => {
      Object.assign(sessionData, items);
      return Promise.resolve();
    },
  };
  const api = {
    runtime: {
      id: "extension-id",
      onInstalled,
      onMessage,
      onConnect,
    },
    action: { onClicked },
    contextMenus: {
      onClicked: onContextClicked,
      removeAll: vi.fn(() => Promise.resolve()),
      create: vi.fn(),
    },
    commands: { onCommand },
    scripting: { executeScript: vi.fn(() => Promise.resolve([])) },
    storage: { session: sessionArea },
    tabs: {
      onRemoved,
      onUpdated,
      sendMessage: vi.fn<(tabId: number, message: unknown) => Promise<unknown>>(() =>
        Promise.resolve(undefined),
      ),
    },
  };
  return { api: api as unknown as typeof chrome, events: api, sessionData };
}

const profiles: ModelProfile[] = [
  {
    id: "profile-a",
    name: "A",
    baseUrl: "https://a.example/v1",
    apiKey: "SECRET-A",
    model: "model-a",
    headers: { "X-Private": "HEADER-A" },
    timeoutMs: 30_000,
    jsonSchemaSupport: "supported",
  },
  {
    id: "profile-b",
    name: "B",
    baseUrl: "https://b.example/v1",
    apiKey: "SECRET-B",
    model: "model-b",
    headers: {},
    timeoutMs: 30_000,
    jsonSchemaSupport: "supported",
  },
];

function dependencies(
  analysisOverrides: Partial<AnalysisService> = {},
  availableProfiles: ModelProfile[] = profiles,
  prefetchDetail = false,
) {
  let activeProfileId = "profile-a";
  const defaultAnalyzeCore: AnalysisService["analyzeCore"] = ({ sentences, profile }) =>
    Promise.resolve({
      result: sentences.map((sentence: SentenceInput) => ({
        schemaVersion: CORE_SCHEMA_VERSION,
        sentenceId: sentence.sentenceId,
        components: [
          {
            startToken: 0,
            endToken: 0,
            role: GrammarRole.SUBJECT,
            translation: "学习者",
          },
        ],
        modelProfileId: profile.id,
      })),
      failures: [],
      cacheHit: false,
    });
  const analysisService: AnalysisService = {
    analyzeCore: vi.fn(defaultAnalyzeCore),
    analyzeDetail: vi.fn<AnalysisService["analyzeDetail"]>(),
    reanalyzeWithFeedback: vi.fn<AnalysisService["reanalyzeWithFeedback"]>(),
    lookupCore: vi.fn<AnalysisService["lookupCore"]>(() => Promise.resolve([])),
    lookupDetail: vi.fn<AnalysisService["lookupDetail"]>(() => Promise.resolve(undefined)),
    analyzeSentenceDetails: vi.fn<AnalysisService["analyzeSentenceDetails"]>(() =>
      Promise.resolve({ succeeded: 0, failed: 0 }),
    ),
    explainDiagnosis: vi.fn<AnalysisService["explainDiagnosis"]>(),
    // Task 3 接口新增后的编译占位:SW 路由与 chat 行为断言是 Task 4 的范围。
    chat: vi.fn<AnalysisService["chat"]>(),
    ...analysisOverrides,
  };
  const deps: ServiceWorkerDependencies = {
    configRepository: {
      getProfile: vi.fn((id: string) =>
        Promise.resolve(availableProfiles.find((profile) => profile.id === id)),
      ),
      getActiveProfile: vi.fn(() =>
        Promise.resolve(availableProfiles.find((profile) => profile.id === activeProfileId)),
      ),
      setActiveProfile: vi.fn((id: string) => {
        activeProfileId = id;
        return Promise.resolve();
      }),
      getPrefetchDetail: vi.fn(() => Promise.resolve(prefetchDetail)),
      getStreamRendering: vi.fn(() => Promise.resolve(true)),
    },
    analysisService,
    scheduler: { cancelDocument: vi.fn() },
    cache: {
      stats: vi.fn(() => Promise.resolve({ entries: 0, estimatedBytes: 0, limitBytes: 1024 })),
      clear: vi.fn(() => Promise.resolve()),
    },
    profileProbe: vi.fn(() => Promise.resolve("supported" as const)),
  };
  return deps;
}

const sentence = {
  sentenceId: "sentence-1",
  text: "Learners read.",
  tokens: [
    {
      id: 0,
      text: "Learners",
      start: 0,
      end: 8,
      leadingWhitespace: "",
      punctuation: false,
    },
  ],
};

const emptyRunningStatus: SessionStatus = {
  state: "running",
  discovered: 0,
  queued: 0,
  ready: 0,
  failed: 0,
  profileId: "profile-a",
};

type PageRequest = Extract<RequestMessage, { tabId: number }>;
type PageRequestBody = PageRequest extends infer Message
  ? Message extends PageRequest
    ? Omit<Message, "version" | "requestId" | "tabId" | "documentId">
    : never
  : never;

function pageRequest(body: PageRequestBody, documentId = "document-1"): RequestMessage {
  return {
    ...body,
    version: 1,
    requestId: "request-1",
    tabId: 7,
    documentId,
  };
}

async function dispatch(
  listener: (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    respond: (response: ResponseMessage) => void,
  ) => boolean | undefined,
  message: unknown,
  sender: chrome.runtime.MessageSender = { tab: { id: 7 } as chrome.tabs.Tab },
): Promise<ResponseMessage> {
  return new Promise((resolve) => {
    expect(listener(message, sender, resolve)).toBe(true);
  });
}

describe("service worker orchestration", () => {
  beforeEach(() => vi.clearAllMocks());

  it("注册第三个右键菜单项——同时更新被钉死的两项注册断言", async () => {
    const subject = chromeMock();
    registerServiceWorker(dependencies(), subject.api);
    subject.events.runtime.onInstalled.listeners[0]!({ reason: "install" });
    await vi.waitFor(() => expect(subject.events.contextMenus.removeAll).toHaveBeenCalledOnce());
    expect(subject.events.contextMenus.create.mock.calls).toEqual([
      [{ id: "syntax-parse-selection", title: "解析选中文本", contexts: ["selection"] }],
      [{ id: "syntax-parse-context-block", title: "解析此区域", contexts: ["page"] }],
      [
        {
          id: "syntax-diagnose-block",
          title: "诊断：这段为什么没解析",
          contexts: ["page", "selection"],
        },
      ],
    ]);
  });

  it("SW 启动本身就要注册三个右键菜单，不依赖 onInstalled 事件", async () => {
    // 2026-10-13 真机探针：--load-extension 首次加载（及部分真机场景）下 onInstalled
    // 不触发，三个菜单全部缺失——右键永远看不到入口。注册必须由 SW 启动兜底保证。
    const subject = chromeMock();
    registerServiceWorker(dependencies(), subject.api);

    await vi.waitFor(() => expect(subject.events.contextMenus.create).toHaveBeenCalledTimes(3));
    expect(subject.events.contextMenus.removeAll).toHaveBeenCalledOnce();
    expect(subject.events.contextMenus.create.mock.calls).toEqual([
      [{ id: "syntax-parse-selection", title: "解析选中文本", contexts: ["selection"] }],
      [{ id: "syntax-parse-context-block", title: "解析此区域", contexts: ["page"] }],
      [
        {
          id: "syntax-diagnose-block",
          title: "诊断：这段为什么没解析",
          contexts: ["page", "selection"],
        },
      ],
    ]);

    // 同一 SW 生命周期内 onInstalled 再到也不重复注册
    subject.events.runtime.onInstalled.listeners[0]!({ reason: "install" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(subject.events.contextMenus.create).toHaveBeenCalledTimes(3);
    expect(subject.events.contextMenus.removeAll).toHaveBeenCalledOnce();
  });

  it("injects only after an explicit action command and then starts the page", async () => {
    const subject = chromeMock();
    registerServiceWorker(dependencies(), subject.api);
    expect(subject.events.scripting.executeScript).not.toHaveBeenCalled();

    subject.events.action.onClicked.listeners[0]!({ id: 7 } as chrome.tabs.Tab);
    await vi.waitFor(() => expect(subject.events.tabs.sendMessage).toHaveBeenCalledOnce());

    expect(subject.events.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 7 },
      files: ["content-script.js"],
    });
    expect(subject.events.tabs.sendMessage).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ type: "START_SESSION", tabId: 7 }),
    );
  });

  it("accepts a popup start command as an explicit extension UI action", async () => {
    const subject = chromeMock();
    registerServiceWorker(dependencies(), subject.api);

    const response = await dispatch(
      subject.events.runtime.onMessage.listeners[0]!,
      pageRequest({ type: "START_SESSION" }),
      { id: "extension-id", url: "chrome-extension://extension-id/src/popup/popup.html" },
    );

    expect(response.type).toBe("SESSION_STATUS");
    expect(subject.events.scripting.executeScript).toHaveBeenCalledOnce();
    expect(subject.events.tabs.sendMessage).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ type: "START_SESSION", documentId: "document-1" }),
    );
  });

  it("forwards an explicit popup visible-area reanalysis to the active document", async () => {
    const subject = chromeMock();
    registerServiceWorker(dependencies(), subject.api);
    const listener = subject.events.runtime.onMessage.listeners[0]!;
    const popup = {
      id: "extension-id",
      url: "chrome-extension://extension-id/src/popup/popup.html",
    };
    await dispatch(listener, pageRequest({ type: "START_SESSION" }), popup);
    subject.events.tabs.sendMessage.mockClear();

    const response = await dispatch(listener, pageRequest({ type: "REANALYZE_VISIBLE" }), popup);

    expect(response).toMatchObject({ type: "SESSION_STATUS" });
    expect(subject.events.tabs.sendMessage).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ type: "REANALYZE_VISIBLE", documentId: "document-1" }),
    );
  });

  it("binds trusted popup status and controls to the document started by another UI", async () => {
    const subject = chromeMock();
    registerServiceWorker(dependencies(), subject.api);
    subject.events.action.onClicked.listeners[0]!({ id: 7 } as chrome.tabs.Tab);
    await vi.waitFor(() => expect(subject.events.tabs.sendMessage).toHaveBeenCalledOnce());
    const activeRequest = subject.events.tabs.sendMessage.mock.calls[0]![1] as PageRequest;
    subject.events.tabs.sendMessage.mockClear();
    const popup = {
      id: "extension-id",
      url: "chrome-extension://extension-id/src/popup/popup.html",
    };

    const status = await dispatch(
      subject.events.runtime.onMessage.listeners[0]!,
      pageRequest({ type: "GET_SESSION_STATUS" }, "popup-tab-7"),
      popup,
    );
    const reanalysis = await dispatch(
      subject.events.runtime.onMessage.listeners[0]!,
      pageRequest({ type: "REANALYZE_VISIBLE" }, "popup-tab-7"),
      popup,
    );

    expect(status).toMatchObject({ type: "SESSION_STATUS", status: { state: "running" } });
    expect(reanalysis).toMatchObject({ type: "SESSION_STATUS" });
    expect(subject.events.tabs.sendMessage).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        type: "REANALYZE_VISIBLE",
        documentId: activeRequest.documentId,
      }),
    );
  });

  it("runs a real profile probe and returns its JSON capability without secrets", async () => {
    const deps = dependencies();
    const subject = chromeMock();
    registerServiceWorker(deps, subject.api);

    const response = await dispatch(subject.events.runtime.onMessage.listeners[0]!, {
      version: 1,
      requestId: "test-profile-1",
      type: "TEST_PROFILE",
      profileId: "profile-a",
    });

    expect(deps.profileProbe).toHaveBeenCalledWith(
      expect.objectContaining({ id: "profile-a", apiKey: "SECRET-A" }),
      expect.any(AbortSignal),
    );
    expect(response).toMatchObject({
      type: "PROFILE_TEST_RESULT",
      success: true,
      jsonSchemaSupport: "supported",
    });
    expect(JSON.stringify(response)).not.toMatch(/SECRET-A|HEADER-A|apiKey|Authorization/);
  });

  it.each(["NETWORK_ERROR", "AUTH_FAILED", "MODEL_NOT_FOUND", "INVALID_MODEL_OUTPUT"] as const)(
    "maps a %s profile probe failure without leaking its message",
    async (code) => {
      const deps = dependencies();
      vi.mocked(deps.profileProbe).mockRejectedValue(
        Object.assign(new Error("SECRET-A HEADER-A"), { code }),
      );
      const subject = chromeMock();
      registerServiceWorker(deps, subject.api);

      const response = await dispatch(subject.events.runtime.onMessage.listeners[0]!, {
        version: 1,
        requestId: "test-profile-error",
        type: "TEST_PROFILE",
        profileId: "profile-a",
      });

      expect(response).toMatchObject({
        type: "PROFILE_TEST_RESULT",
        success: false,
        error: { code },
      });
      expect(JSON.stringify(response)).not.toMatch(/SECRET-A|HEADER-A/);
    },
  );

  it("assigns a fresh background document ID after navigation in the same tab", async () => {
    const subject = chromeMock();
    registerServiceWorker(dependencies(), subject.api);
    const action = subject.events.action.onClicked.listeners[0]!;

    action({ id: 7 } as chrome.tabs.Tab);
    await vi.waitFor(() => expect(subject.events.tabs.sendMessage).toHaveBeenCalledTimes(1));
    const first = subject.events.tabs.sendMessage.mock.calls[0]![1] as PageRequest;
    subject.events.tabs.onUpdated.listeners[0]!(7, { status: "loading" }, {
      id: 7,
    } as chrome.tabs.Tab);
    action({ id: 7 } as chrome.tabs.Tab);
    await vi.waitFor(() => expect(subject.events.tabs.sendMessage).toHaveBeenCalledTimes(2));
    const second = subject.events.tabs.sendMessage.mock.calls[1]![1] as PageRequest;

    expect(second.documentId).not.toBe(first.documentId);
  });

  it.each([
    ["malformed", { type: "ANALYZE_CORE", requestId: "bad" }],
    ["version-mismatched", { version: 2, type: "GET_CACHE_STATS", requestId: "bad" }],
  ])("returns ERROR for a %s message", async (_description, message) => {
    const subject = chromeMock();
    registerServiceWorker(dependencies(), subject.api);

    await expect(
      dispatch(subject.events.runtime.onMessage.listeners[0]!, message),
    ).resolves.toMatchObject({ type: "ERROR", requestId: "bad" });
  });

  it("rejects a page message whose sender tab does not match", async () => {
    const subject = chromeMock();
    registerServiceWorker(dependencies(), subject.api);

    const response = await dispatch(
      subject.events.runtime.onMessage.listeners[0]!,
      pageRequest({ type: "ANALYZE_CORE", sentences: [sentence] }),
      { tab: { id: 8 } as chrome.tabs.Tab },
    );

    expect(response).toMatchObject({ type: "ERROR", error: { code: "UNSUPPORTED_PAGE" } });
  });

  it("rejects a stale document request without disturbing the active document", async () => {
    const subject = chromeMock();
    registerServiceWorker(dependencies(), subject.api);
    const listener = subject.events.runtime.onMessage.listeners[0]!;
    await dispatch(listener, {
      version: 1,
      requestId: "status-1",
      type: "SESSION_STATUS",
      tabId: 7,
      documentId: "document-current",
      status: emptyRunningStatus,
    });

    const response = await dispatch(
      listener,
      pageRequest({ type: "ANALYZE_CORE", sentences: [sentence] }, "document-stale"),
    );

    expect(response).toMatchObject({ type: "ERROR", error: { code: "REQUEST_CANCELLED" } });
  });

  it("rejects a stale status relay instead of replacing the current document", async () => {
    const subject = chromeMock();
    registerServiceWorker(dependencies(), subject.api);
    const listener = subject.events.runtime.onMessage.listeners[0]!;
    await dispatch(listener, {
      version: 1,
      requestId: "status-current",
      type: "SESSION_STATUS",
      tabId: 7,
      documentId: "document-current",
      status: emptyRunningStatus,
    });

    const stale = await dispatch(listener, {
      version: 1,
      requestId: "status-stale",
      type: "SESSION_STATUS",
      tabId: 7,
      documentId: "document-stale",
      status: { ...emptyRunningStatus, discovered: 99 },
    });
    const current = await dispatch(
      listener,
      pageRequest({ type: "GET_SESSION_STATUS" }, "document-current"),
    );

    expect(stale).toMatchObject({ type: "ERROR", error: { code: "REQUEST_CANCELLED" } });
    expect(current).toMatchObject({ type: "SESSION_STATUS", status: { discovered: 0 } });
  });

  it("never exposes profile keys, headers, or surplus service fields in core/detail responses", async () => {
    const leakyCore = {
      schemaVersion: CORE_SCHEMA_VERSION,
      sentenceId: sentence.sentenceId,
      components: [
        {
          startToken: 0,
          endToken: 0,
          role: GrammarRole.SUBJECT,
          translation: "学习者 SECRET-A HEADER-A",
          apiKey: "SECRET-A",
        },
      ],
      modelProfileId: "profile-a",
      headers: { Authorization: "SECRET-A" },
    };
    const requestCore = {
      schemaVersion: CORE_SCHEMA_VERSION,
      sentenceId: sentence.sentenceId,
      components: [
        {
          startToken: 0,
          endToken: 0,
          role: GrammarRole.SUBJECT,
          translation: "学习者",
        },
      ],
      modelProfileId: "profile-a",
    };
    const leakyDetail = {
      sentenceId: sentence.sentenceId,
      focus: { startToken: 0, endToken: 0 },
      structures: [
        {
          startToken: 0,
          endToken: 0,
          role: "subject",
          explanation: "Subject SECRET-A",
          apiKey: "SECRET-A",
        },
      ],
      grammarPoints: ["subject"],
      explanation: "Detail HEADER-A",
      modelProfileId: "profile-a",
      apiKey: "SECRET-A",
    };
    const deps = dependencies({
      analyzeCore: vi.fn(() =>
        Promise.resolve({
          result: [leakyCore],
          failures: [],
          cacheHit: false,
        }),
      ),
      analyzeDetail: vi.fn(() => Promise.resolve({ result: leakyDetail, cacheHit: false })),
    });
    const subject = chromeMock();
    registerServiceWorker(deps, subject.api);
    const listener = subject.events.runtime.onMessage.listeners[0]!;

    const core = await dispatch(
      listener,
      pageRequest({ type: "ANALYZE_CORE", sentences: [sentence] }),
    );
    const detail = await dispatch(
      listener,
      pageRequest({
        type: "ANALYZE_DETAIL",
        sentence,
        core: requestCore,
        focus: { startToken: 0, endToken: 0 },
      }),
    );

    expect(JSON.stringify([core, detail])).not.toMatch(/SECRET-A|Authorization|apiKey|headers/);
  });

  it("injects on first selection-menu use and forwards Chrome selectionText", async () => {
    const subject = chromeMock();
    registerServiceWorker(dependencies(), subject.api);

    subject.events.contextMenus.onClicked.listeners[0]!(
      {
        menuItemId: "syntax-parse-selection",
        selectionText: "Learners read.",
        editable: false,
      },
      { id: 7 } as chrome.tabs.Tab,
    );
    await vi.waitFor(() => expect(subject.events.tabs.sendMessage).toHaveBeenCalledOnce());

    expect(subject.events.scripting.executeScript).toHaveBeenCalledOnce();
    expect(subject.events.tabs.sendMessage).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ type: "PARSE_SELECTION", selectionText: "Learners read." }),
    );
  });

  it("returns Task 11's instruction when region parsing has no active recorded target", () => {
    const subject = chromeMock();
    registerServiceWorker(dependencies(), subject.api);

    const response = subject.events.contextMenus.onClicked.listeners[0]!(
      { menuItemId: "syntax-parse-context-block", editable: false },
      { id: 7 } as chrome.tabs.Tab,
    );

    expect(response).toMatchObject({
      type: "ERROR",
      error: {
        code: "UNSAFE_CONTENT_BLOCK",
        message: "请先启动学习模式，或选中文字后解析",
      },
    });
    expect(subject.events.scripting.executeScript).not.toHaveBeenCalled();
  });

  it("sends only a trigger for region parsing when the content script is active", async () => {
    const subject = chromeMock();
    registerServiceWorker(dependencies(), subject.api);
    await dispatch(subject.events.runtime.onMessage.listeners[0]!, {
      version: 1,
      requestId: "status-active",
      type: "SESSION_STATUS",
      tabId: 7,
      documentId: "document-1",
      status: emptyRunningStatus,
    });

    subject.events.contextMenus.onClicked.listeners[0]!(
      { menuItemId: "syntax-parse-context-block", editable: false },
      { id: 7 } as chrome.tabs.Tab,
    );
    await vi.waitFor(() => expect(subject.events.tabs.sendMessage).toHaveBeenCalledOnce());

    expect(subject.events.scripting.executeScript).not.toHaveBeenCalled();
    expect(subject.events.tabs.sendMessage).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ type: "PARSE_CONTEXT_BLOCK", documentId: "document-1" }),
    );
  });

  it("PARSE_HOVERED_BLOCK：可信 UI 触发时注入并原样转发到页面", async () => {
    const subject = chromeMock();
    registerServiceWorker(dependencies(), subject.api);
    const popupSender = {
      id: "extension-id",
      url: "chrome-extension://extension-id/src/popup/popup.html",
    };

    const response = await dispatch(
      subject.events.runtime.onMessage.listeners[0]!,
      pageRequest({ type: "PARSE_HOVERED_BLOCK" }),
      popupSender,
    );

    expect(response).toMatchObject({ type: "ACK", acknowledgedType: "PARSE_HOVERED_BLOCK" });
    expect(subject.events.scripting.executeScript).toHaveBeenCalledOnce();
    expect(subject.events.tabs.sendMessage).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ type: "PARSE_HOVERED_BLOCK" }),
    );
  });

  it("PARSE_HOVERED_BLOCK：网页侧伪造请求被拒绝", async () => {
    const subject = chromeMock();
    registerServiceWorker(dependencies(), subject.api);

    const response = await dispatch(
      subject.events.runtime.onMessage.listeners[0]!,
      pageRequest({ type: "PARSE_HOVERED_BLOCK" }),
    );

    expect(response).toMatchObject({ type: "ERROR", error: { code: "UNSUPPORTED_PAGE" } });
    expect(subject.events.scripting.executeScript).not.toHaveBeenCalled();
  });

  it("快捷键在冷页面上注入并下发 PARSE_HOVERED_BLOCK", async () => {
    const subject = chromeMock();
    registerServiceWorker(dependencies(), subject.api);

    subject.events.commands.onCommand.listeners[0]!("parse-hovered-block", {
      id: 7,
    } as chrome.tabs.Tab);
    await vi.waitFor(() => expect(subject.events.tabs.sendMessage).toHaveBeenCalledOnce());

    expect(subject.events.scripting.executeScript).toHaveBeenCalledOnce();
    expect(subject.events.tabs.sendMessage).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ type: "PARSE_HOVERED_BLOCK", tabId: 7 }),
    );
  });

  it("快捷键忽略未知命令名与无 tab 的事件", async () => {
    const subject = chromeMock();
    registerServiceWorker(dependencies(), subject.api);

    subject.events.commands.onCommand.listeners[0]!("other-command", { id: 7 } as chrome.tabs.Tab);
    subject.events.commands.onCommand.listeners[0]!("parse-hovered-block", undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(subject.events.scripting.executeScript).not.toHaveBeenCalled();
    expect(subject.events.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it("快捷键在不可注入页面上静默失败", async () => {
    const subject = chromeMock();
    subject.events.scripting.executeScript.mockRejectedValueOnce(
      new Error("Cannot access a chrome:// URL"),
    );
    registerServiceWorker(dependencies(), subject.api);

    subject.events.commands.onCommand.listeners[0]!("parse-hovered-block", {
      id: 7,
    } as chrome.tabs.Tab);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(subject.events.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it("cancels only the recorded document on tab close and navigation", async () => {
    const subject = chromeMock();
    const deps = dependencies();
    registerServiceWorker(deps, subject.api);
    const listener = subject.events.runtime.onMessage.listeners[0]!;
    const status: SessionStatus = {
      state: "running",
      discovered: 1,
      queued: 0,
      ready: 1,
      failed: 0,
      profileId: "profile-a",
    };
    await dispatch(listener, {
      version: 1,
      requestId: "status-1",
      type: "SESSION_STATUS",
      status,
      tabId: 7,
      documentId: "document-1",
    });

    subject.events.tabs.onUpdated.listeners[0]!(7, { status: "loading" }, {
      id: 7,
    } as chrome.tabs.Tab);
    await dispatch(listener, {
      version: 1,
      requestId: "status-2",
      type: "SESSION_STATUS",
      status,
      tabId: 7,
      documentId: "document-2",
    });
    subject.events.tabs.onRemoved.listeners[0]!(7);

    // The injected scheduler port is intentionally represented by a standalone mock function.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const cancelDocument = vi.mocked(deps.scheduler.cancelDocument);
    // 每个记录在账的 documentId 都带一条 `:chat` 命名空间回收(chat 槽位追加点)。
    expect(cancelDocument).toHaveBeenNthCalledWith(1, "document-1");
    expect(cancelDocument).toHaveBeenNthCalledWith(2, "document-1:chat");
    expect(cancelDocument).toHaveBeenNthCalledWith(3, "document-2");
    expect(cancelDocument).toHaveBeenNthCalledWith(4, "document-2:chat");
    expect(cancelDocument).toHaveBeenCalledTimes(4);
  });

  it("binds a content-script Port to its sender tab and cancels that document on disconnect", async () => {
    const subject = chromeMock();
    const deps = dependencies();
    registerServiceWorker(deps, subject.api);
    const onDisconnect = event<() => void>();
    const port = {
      name: "syntax-learning:document-port",
      sender: { tab: { id: 7 } as chrome.tabs.Tab },
      onDisconnect,
    } as unknown as chrome.runtime.Port;

    subject.events.runtime.onConnect.listeners[0]!(port);
    onDisconnect.listeners[0]!();

    // 会话清理排在 session 回填之后:同步断言会跑在回填前。
    await vi.waitFor(() =>
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(deps.scheduler.cancelDocument).toHaveBeenCalledWith("document-port"),
    );
  });

  it("keeps a reconnected session alive when the stale port finally disconnects", async () => {
    // SW 重启/bfcache 恢复后,页面用同一个 documentId 重新连一条端口。旧端口的断开
    // 事件此前会取消这条刚接上的会话并把状态清成 stopped:页面上卡片还在,弹窗却回落
    // 成「开始学习」。
    const subject = chromeMock();
    const deps = dependencies();
    registerServiceWorker(deps, subject.api);
    const connect = subject.events.runtime.onConnect.listeners[0]!;
    const stale = event<() => void>();
    const fresh = event<() => void>();
    const portOf = (onDisconnect: ReturnType<typeof event<() => void>>) =>
      ({
        name: "syntax-learning:document-1",
        sender: { tab: { id: 7 } as chrome.tabs.Tab },
        onDisconnect,
        postMessage: vi.fn(),
      }) as unknown as chrome.runtime.Port;

    connect(portOf(stale));
    connect(portOf(fresh));
    stale.listeners[0]!();
    await dispatch(
      subject.events.runtime.onMessage.listeners[0]!,
      pageRequest({ type: "GET_SESSION_STATUS" }),
    );

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(deps.scheduler.cancelDocument).not.toHaveBeenCalled();
  });

  it("does not reset a hydrated running session when the page reconnects after a restart", async () => {
    // G⑩:SW 回收后页面重连,onConnect 抢在 session 回填之前写 activeTabs,把
    // running 覆盖成 stopped——弹窗于是显示「开始学习」，而页面上卡片一张没少。
    const running: SessionStatus = {
      ...emptyRunningStatus,
      discovered: 3,
      ready: 1,
      queued: 2,
    };
    const subject = chromeMock({
      "activeTabs.v1": [[7, { documentId: "document-1", status: running }]],
    });
    registerServiceWorker(dependencies(), subject.api);

    subject.events.runtime.onConnect.listeners[0]!({
      name: "syntax-learning:document-1",
      sender: { tab: { id: 7 } as chrome.tabs.Tab },
      onDisconnect: event<() => void>(),
      postMessage: vi.fn(),
    } as unknown as chrome.runtime.Port);
    const response = await dispatch(
      subject.events.runtime.onMessage.listeners[0]!,
      pageRequest({ type: "GET_SESSION_STATUS" }),
    );

    expect(response).toMatchObject({ type: "SESSION_STATUS", status: running });
  });

  it("pauses new analysis only for the profile that receives a 401", async () => {
    const analyzeCore = vi.fn(({ profile }: Parameters<AnalysisService["analyzeCore"]>[0]) => {
      if (profile.id === "profile-a") {
        return Promise.reject(
          Object.assign(new Error("SECRET-A"), {
            code: "AUTH_FAILED",
            retryable: false,
            details: { status: 401 },
          }),
        );
      }
      return Promise.resolve({ result: [], failures: [], cacheHit: false });
    });
    const deps = dependencies({ analyzeCore });
    const subject = chromeMock();
    registerServiceWorker(deps, subject.api);
    const listener = subject.events.runtime.onMessage.listeners[0]!;

    await dispatch(listener, pageRequest({ type: "ANALYZE_CORE", sentences: [sentence] }));
    await dispatch(listener, pageRequest({ type: "SWITCH_PROFILE", profileId: "profile-b" }));
    const profileB = await dispatch(
      listener,
      pageRequest({ type: "ANALYZE_CORE", sentences: [sentence] }),
    );
    await dispatch(listener, pageRequest({ type: "SWITCH_PROFILE", profileId: "profile-a" }));
    const profileA = await dispatch(
      listener,
      pageRequest({ type: "ANALYZE_CORE", sentences: [sentence] }),
    );

    // 暂停后不再整批报错：返回缓存命中（此处为空）+ 批级 AUTH_FAILED error。
    expect(profileB.type).toBe("CORE_RESULT");
    expect(profileA).toMatchObject({
      type: "CORE_RESULT",
      analyses: [],
      error: { code: "AUTH_FAILED" },
    });
    expect(analyzeCore).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(profileA)).not.toContain("SECRET-A");
  });

  it("批内出现鉴权失败时仍返回已取得的分析（缓存命中不丢）并附批级 error", async () => {
    const analyzeCore = vi.fn(
      ({ sentences, profile }: Parameters<AnalysisService["analyzeCore"]>[0]) =>
        Promise.resolve({
          result: [
            {
              schemaVersion: CORE_SCHEMA_VERSION,
              sentenceId: sentences[0]!.sentenceId,
              components: [
                { startToken: 0, endToken: 0, role: GrammarRole.SUBJECT, translation: "学习者" },
              ],
              modelProfileId: profile.id,
            },
          ],
          failures: [
            {
              sentenceId: "sentence-miss",
              error: new ModelRequestError("AUTH_FAILED", "HTTP 403", false, { status: 403 }),
            },
          ],
          cacheHit: true,
        }),
    );
    const subject = chromeMock();
    registerServiceWorker(dependencies({ analyzeCore }), subject.api);

    const response = await dispatch(
      subject.events.runtime.onMessage.listeners[0]!,
      pageRequest({ type: "ANALYZE_CORE", sentences: [sentence] }),
    );

    expect(response).toMatchObject({
      type: "CORE_RESULT",
      analyses: [{ sentenceId: "sentence-1" }],
      error: { code: "AUTH_FAILED" },
    });
  });

  // 2026-11-02:两轮修复仍失败的句子,失败原因(含具体校验错误)必须随 CORE_RESULT
  // 下发,否则 content 只能给「模型未返回此句的解析结果」的笼统文案。
  it("非鉴权失败的 outcome.failures 逐句随 CORE_RESULT 下发且消息脱敏", async () => {
    const analyzeCore = vi.fn(({ sentences }: Parameters<AnalysisService["analyzeCore"]>[0]) =>
      Promise.resolve({
        result: [],
        failures: [
          {
            sentenceId: sentences[0]!.sentenceId,
            error: new ModelRequestError(
              "INVALID_MODEL_OUTPUT",
              "模型输出经两轮修复后仍不合格：SECRET-A 泄漏检查",
              false,
            ),
          },
        ],
        cacheHit: false,
      }),
    );
    const subject = chromeMock();
    registerServiceWorker(dependencies({ analyzeCore }), subject.api);

    const response = await dispatch(
      subject.events.runtime.onMessage.listeners[0]!,
      pageRequest({ type: "ANALYZE_CORE", sentences: [sentence] }),
    );

    expect(response.type).toBe("CORE_RESULT");
    const coreResult = response as Extract<ResponseMessage, { type: "CORE_RESULT" }>;
    expect(coreResult.failures).toEqual([
      {
        sentenceId: sentence.sentenceId,
        error: {
          code: "INVALID_MODEL_OUTPUT",
          message: "模型输出经两轮修复后仍不合格：[redacted] 泄漏检查",
          retryable: false,
        },
      },
    ]);
    expect(JSON.stringify(coreResult)).not.toContain("SECRET-A");
  });

  it("暂停期间 ANALYZE_CORE 仍查缓存返回命中，不再无脑整批鉴权失败", async () => {
    const cachedAnalysis = {
      schemaVersion: CORE_SCHEMA_VERSION,
      sentenceId: sentence.sentenceId,
      components: [
        { startToken: 0, endToken: 0, role: GrammarRole.SUBJECT, translation: "学习者" },
      ],
      modelProfileId: "cached",
    };
    const analyzeCore = vi.fn(() =>
      Promise.reject(Object.assign(new Error("auth"), { code: "AUTH_FAILED", retryable: false })),
    );
    const lookupCore = vi.fn<AnalysisService["lookupCore"]>(() =>
      Promise.resolve([cachedAnalysis]),
    );
    const subject = chromeMock();
    registerServiceWorker(dependencies({ analyzeCore, lookupCore }), subject.api);
    const listener = subject.events.runtime.onMessage.listeners[0]!;

    const first = await dispatch(
      listener,
      pageRequest({ type: "ANALYZE_CORE", sentences: [sentence] }),
    );
    const second = await dispatch(
      listener,
      pageRequest({ type: "ANALYZE_CORE", sentences: [sentence] }),
    );

    // 首批失败也回退缓存；暂停后的后续批次不再调用模型，但依旧带回缓存命中。
    expect(first).toMatchObject({
      type: "CORE_RESULT",
      analyses: [{ sentenceId: "sentence-1" }],
      error: { code: "AUTH_FAILED" },
    });
    expect(second).toMatchObject({
      type: "CORE_RESULT",
      analyses: [{ sentenceId: "sentence-1" }],
      error: { code: "AUTH_FAILED" },
    });
    expect(analyzeCore).toHaveBeenCalledTimes(1);
  });

  it("暂停期间 ANALYZE_DETAIL 命中缓存返回详解，未命中才报鉴权失败", async () => {
    const detailAnalysis = {
      sentenceId: sentence.sentenceId,
      focus: { startToken: 0, endToken: 0 },
      structures: [],
      grammarPoints: [],
      explanation: "整体讲解",
      modelProfileId: "cached",
    };
    const analyzeCore = vi.fn(() =>
      Promise.reject(Object.assign(new Error("auth"), { code: "AUTH_FAILED", retryable: false })),
    );
    const lookupDetail = vi.fn<AnalysisService["lookupDetail"]>(() =>
      Promise.resolve(detailAnalysis),
    );
    const subject = chromeMock();
    registerServiceWorker(dependencies({ analyzeCore, lookupDetail }), subject.api);
    const listener = subject.events.runtime.onMessage.listeners[0]!;
    await dispatch(listener, pageRequest({ type: "ANALYZE_CORE", sentences: [sentence] }));

    const hit = await dispatch(
      listener,
      pageRequest({
        type: "ANALYZE_DETAIL",
        sentence,
        core: {
          schemaVersion: CORE_SCHEMA_VERSION,
          sentenceId: sentence.sentenceId,
          components: [],
          modelProfileId: "cached",
        },
        focus: { startToken: 0, endToken: 0 },
      }),
    );
    lookupDetail.mockResolvedValueOnce(undefined);
    const miss = await dispatch(
      listener,
      pageRequest({
        type: "ANALYZE_DETAIL",
        sentence,
        core: {
          schemaVersion: CORE_SCHEMA_VERSION,
          sentenceId: sentence.sentenceId,
          components: [],
          modelProfileId: "cached",
        },
        focus: { startToken: 0, endToken: 0 },
      }),
    );

    expect(hit).toMatchObject({ type: "DETAIL_RESULT", analysis: { explanation: "整体讲解" } });
    expect(miss).toMatchObject({ type: "ERROR", error: { code: "AUTH_FAILED" } });
  });

  it("TEST_PROFILE 绕过暂停真实探测，成功后解除暂停恢复解析", async () => {
    const analyzeCore = vi
      .fn<AnalysisService["analyzeCore"]>()
      .mockRejectedValueOnce(
        Object.assign(new Error("auth"), { code: "AUTH_FAILED", retryable: false }),
      )
      .mockResolvedValue({ result: [], failures: [], cacheHit: false });
    const deps = dependencies({ analyzeCore });
    const subject = chromeMock();
    registerServiceWorker(deps, subject.api);
    const listener = subject.events.runtime.onMessage.listeners[0]!;

    await dispatch(listener, pageRequest({ type: "ANALYZE_CORE", sentences: [sentence] }));
    const test = await dispatch(listener, {
      version: 1,
      requestId: "test-profile-a",
      type: "TEST_PROFILE",
      profileId: "profile-a",
    });
    const afterTest = await dispatch(
      listener,
      pageRequest({ type: "ANALYZE_CORE", sentences: [sentence] }),
    );

    // 测试连接是显式的用户自检动作：必须真实探测（不被暂停门拦截），成功即解除暂停。
    expect(deps.profileProbe).toHaveBeenCalledOnce();
    expect(test).toMatchObject({ type: "PROFILE_TEST_RESULT", success: true });
    expect(afterTest.type).toBe("CORE_RESULT");
    expect(analyzeCore).toHaveBeenCalledTimes(2);
  });

  it("ANALYZE_CORE returns cache hits with cacheOnly instead of CONFIG_MISSING", async () => {
    const cachedAnalysis = {
      schemaVersion: CORE_SCHEMA_VERSION,
      sentenceId: sentence.sentenceId,
      components: [
        { startToken: 0, endToken: 0, role: GrammarRole.SUBJECT, translation: "学习者" },
      ],
      modelProfileId: "cached",
    };
    const lookupCore = vi.fn<AnalysisService["lookupCore"]>(() =>
      Promise.resolve([cachedAnalysis]),
    );
    const subject = chromeMock();
    registerServiceWorker(dependencies({ lookupCore }, []), subject.api);

    const response = await dispatch(
      subject.events.runtime.onMessage.listeners[0]!,
      pageRequest({ type: "ANALYZE_CORE", sentences: [sentence] }),
    );

    expect(response).toMatchObject({ type: "CORE_RESULT", cacheOnly: true });
    expect((response as Extract<ResponseMessage, { type: "CORE_RESULT" }>).analyses).toEqual([
      cachedAnalysis,
    ]);
    expect(lookupCore).toHaveBeenCalledWith([sentence]);
  });

  it("falls back to the active profile when the pinned profile was deleted", async () => {
    const subject = chromeMock();
    registerServiceWorker(dependencies(), subject.api);
    const listener = subject.events.runtime.onMessage.listeners[0]!;
    await dispatch(listener, {
      version: 1,
      requestId: "status-1",
      type: "SESSION_STATUS",
      tabId: 7,
      documentId: "document-1",
      status: { ...emptyRunningStatus, profileId: "profile-deleted" },
    });

    const response = await dispatch(
      listener,
      pageRequest({ type: "ANALYZE_CORE", sentences: [sentence] }),
    );

    expect(response.type).toBe("CORE_RESULT");
    expect(response).not.toHaveProperty("cacheOnly");
    const analyses = (response as Extract<ResponseMessage, { type: "CORE_RESULT" }>).analyses;
    expect(analyses).toHaveLength(1);
    expect(analyses[0]!.modelProfileId).toBe("profile-a");
  });

  it("ANALYZE_DETAIL returns NO_CACHE on a miss and DETAIL_RESULT on a hit", async () => {
    const requestCore = {
      schemaVersion: CORE_SCHEMA_VERSION,
      sentenceId: sentence.sentenceId,
      components: [
        { startToken: 0, endToken: 0, role: GrammarRole.SUBJECT, translation: "学习者" },
      ],
      modelProfileId: "profile-a",
    };
    const cachedDetail = {
      sentenceId: sentence.sentenceId,
      focus: { startToken: 0, endToken: 0 },
      structures: [{ startToken: 0, endToken: 0, role: "subject", explanation: "主语结构" }],
      grammarPoints: ["主谓结构"],
      explanation: "详细说明。",
      modelProfileId: "cached",
    };
    const lookupDetail = vi
      .fn<AnalysisService["lookupDetail"]>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(cachedDetail);
    const subject = chromeMock();
    registerServiceWorker(dependencies({ lookupDetail }, []), subject.api);
    const listener = subject.events.runtime.onMessage.listeners[0]!;
    const request = pageRequest({
      type: "ANALYZE_DETAIL",
      sentence,
      core: requestCore,
      focus: { startToken: 0, endToken: 0 },
    });

    const miss = await dispatch(listener, request);
    const hit = await dispatch(listener, request);

    expect(miss).toMatchObject({ type: "ERROR", error: { code: "NO_CACHE" } });
    expect(hit).toMatchObject({ type: "DETAIL_RESULT" });
  });

  it("REANALYZE_WITH_FEEDBACK still requires a profile", async () => {
    const requestCore = {
      schemaVersion: CORE_SCHEMA_VERSION,
      sentenceId: sentence.sentenceId,
      components: [
        { startToken: 0, endToken: 0, role: GrammarRole.SUBJECT, translation: "学习者" },
      ],
      modelProfileId: "profile-a",
    };
    const subject = chromeMock();
    registerServiceWorker(dependencies({}, []), subject.api);

    const response = await dispatch(
      subject.events.runtime.onMessage.listeners[0]!,
      pageRequest({
        type: "REANALYZE_WITH_FEEDBACK",
        sentence,
        core: requestCore,
        feedback: "Treat read as the predicate.",
      }),
    );

    expect(response).toMatchObject({ type: "ERROR", error: { code: "CONFIG_MISSING" } });
  });

  it("resumes a paused profile after its credentials change", async () => {
    const availableProfiles = profiles.map((profile) => structuredClone(profile));
    const analyzeCore = vi.fn(({ profile }: Parameters<AnalysisService["analyzeCore"]>[0]) =>
      profile.apiKey === "SECRET-A"
        ? Promise.reject(
            Object.assign(new Error("unauthorized"), {
              code: "AUTH_FAILED",
              retryable: false,
              details: { status: 401 },
            }),
          )
        : Promise.resolve({ result: [], failures: [], cacheHit: false }),
    );
    const deps = dependencies({ analyzeCore }, availableProfiles);
    const subject = chromeMock();
    registerServiceWorker(deps, subject.api);
    const listener = subject.events.runtime.onMessage.listeners[0]!;

    await dispatch(listener, pageRequest({ type: "ANALYZE_CORE", sentences: [sentence] }));
    availableProfiles[0] = { ...availableProfiles[0]!, apiKey: "UPDATED-A" };
    const retried = await dispatch(
      listener,
      pageRequest({ type: "ANALYZE_CORE", sentences: [sentence] }),
    );

    expect(retried.type).toBe("CORE_RESULT");
    expect(analyzeCore).toHaveBeenCalledTimes(2);
  });
});

describe("diagnosis 路由", () => {
  beforeEach(() => vi.clearAllMocks());

  function sampleDiagnosis(): BlockDiagnosis {
    return {
      target: {
        tagName: "P",
        className: "content",
        id: "para-1",
        selectorPath: "main > p#para-1",
        outerHtml: '<p id="para-1" class="content">Learners read.</p>',
      },
      targetSource: "contextmenu",
      inventory: { isUnit: true, kind: "p", automatic: true },
      explicit: { resolvable: true, selectorPath: "main > p#para-1" },
      gates: [{ gate: "english-ratio", ok: false, value: 0.2 }],
      text: { length: 15, letterWords: 2, englishRatio: 0.2, minAutoTextLength: 20 },
      segmentation: { sentenceCount: 1, sentenceLengths: [15], tokenCount: 2, emptyText: false },
      requestFeasibility: {
        maxSentenceLength: 15,
        sentenceLengthLimit: 1200,
        maxSentencesPerRequest: 6,
        cloudSentencesPerRequest: 6,
      },
      session: { state: "stopped", registered: false, sentences: [] },
      page: { url: "https://example.com/article", readyState: "complete" },
      capturedAt: "2026-10-11T00:00:00.000Z",
    };
  }

  it("无 profile 时 EXPLAIN_DIAGNOSIS 回 DIAGNOSIS_RESULT 且 modelError=CONFIG_MISSING", async () => {
    const subject = chromeMock();
    registerServiceWorker(dependencies({}, []), subject.api);

    const response = await dispatch(
      subject.events.runtime.onMessage.listeners[0]!,
      pageRequest({ type: "EXPLAIN_DIAGNOSIS", diagnosis: sampleDiagnosis() }),
    );

    expect(response.type).toBe("DIAGNOSIS_RESULT");
    if (response.type !== "DIAGNOSIS_RESULT") return;
    expect(response.model).toBeUndefined();
    expect(response.modelError?.code).toBe("CONFIG_MISSING");
    expect(response.diagnosis).toEqual(sampleDiagnosis());
  });

  it("有 profile 时调 explainDiagnosis 并回填 model 与 profile.model", async () => {
    const explainDiagnosis = vi.fn<AnalysisService["explainDiagnosis"]>().mockResolvedValueOnce({
      likelyCause: "english ratio below threshold",
      explanation: "占比不足",
      suggestions: [],
    });
    const subject = chromeMock();
    registerServiceWorker(dependencies({ explainDiagnosis }), subject.api);

    const response = await dispatch(
      subject.events.runtime.onMessage.listeners[0]!,
      pageRequest({ type: "EXPLAIN_DIAGNOSIS", diagnosis: sampleDiagnosis() }),
    );

    expect(explainDiagnosis).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: "document-1" }),
      expect.any(AbortSignal),
    );
    if (response.type !== "DIAGNOSIS_RESULT") throw new Error("expected DIAGNOSIS_RESULT");
    expect(response.model?.likelyCause).toBe("english ratio below threshold");
    expect(response.profile).toEqual({ model: "model-a" });
  });

  it("explainDiagnosis 抛错时 modelError 带错误码且仍回 DIAGNOSIS_RESULT", async () => {
    const explainDiagnosis = vi
      .fn<AnalysisService["explainDiagnosis"]>()
      .mockRejectedValueOnce(new ModelRequestError("REQUEST_TIMEOUT", "timeout", true));
    const subject = chromeMock();
    registerServiceWorker(dependencies({ explainDiagnosis }), subject.api);

    const response = await dispatch(
      subject.events.runtime.onMessage.listeners[0]!,
      pageRequest({ type: "EXPLAIN_DIAGNOSIS", diagnosis: sampleDiagnosis() }),
    );

    if (response.type !== "DIAGNOSIS_RESULT") throw new Error("expected DIAGNOSIS_RESULT");
    expect(response.modelError?.code).toBe("REQUEST_TIMEOUT");
  });

  it("形状非法的模型输出回 INVALID_MODEL_OUTPUT 而不是 NETWORK_ERROR", async () => {
    // validateDiagnosisExplanation(Task 4)抛的是普通 Error:形状不符=模型输出非法(spec D4),
    // 只有真正的模型请求错误(ModelRequestError)才携带可映射的错误码。
    const explainDiagnosis = vi
      .fn<AnalysisService["explainDiagnosis"]>()
      .mockRejectedValueOnce(new Error("Invalid diagnosis explanation shape"));
    const subject = chromeMock();
    registerServiceWorker(dependencies({ explainDiagnosis }), subject.api);

    const response = await dispatch(
      subject.events.runtime.onMessage.listeners[0]!,
      pageRequest({ type: "EXPLAIN_DIAGNOSIS", diagnosis: sampleDiagnosis() }),
    );

    if (response.type !== "DIAGNOSIS_RESULT") throw new Error("expected DIAGNOSIS_RESULT");
    expect(response.modelError?.code).toBe("INVALID_MODEL_OUTPUT");
  });

  it("DIAGNOSE_BLOCK 入站被拒（无合法入站来源）", async () => {
    const subject = chromeMock();
    registerServiceWorker(dependencies(), subject.api);

    const response = await dispatch(
      subject.events.runtime.onMessage.listeners[0]!,
      pageRequest({ type: "DIAGNOSE_BLOCK" }),
    );

    expect(response.type).toBe("ERROR");
    if (response.type === "ERROR") expect(response.error.code).toBe("MALFORMED_MESSAGE");
  });

  it("菜单点击下发 DIAGNOSE_BLOCK 且不写 activeTabs", async () => {
    const subject = chromeMock();
    registerServiceWorker(dependencies(), subject.api);

    subject.events.contextMenus.onClicked.listeners[0]!(
      { menuItemId: "syntax-diagnose-block", selectionText: "hello", editable: false },
      { id: 7 } as chrome.tabs.Tab,
    );
    await vi.waitFor(() => expect(subject.events.tabs.sendMessage).toHaveBeenCalledOnce());

    expect(subject.events.tabs.sendMessage).toHaveBeenCalledWith(
      expect.any(Number),
      expect.objectContaining({ type: "DIAGNOSE_BLOCK", selectionText: "hello" }),
    );
    // spec D1：不记账、不伪造 running——activeTabs 的每次 set 都会经
    // persistActiveTabs 落到 session 存储，这里必须保持空。
    expect(subject.sessionData["activeTabs.v1"]).toBeUndefined();
  });

  it("无会话时同 tab 两次诊断下发相同 documentId（controller 按记忆复用）", async () => {
    const subject = chromeMock();
    registerServiceWorker(dependencies(), subject.api);

    const click = (): void => {
      subject.events.contextMenus.onClicked.listeners[0]!(
        { menuItemId: "syntax-diagnose-block", editable: false },
        { id: 9 } as chrome.tabs.Tab,
      );
    };
    click();
    await vi.waitFor(() => expect(subject.events.tabs.sendMessage).toHaveBeenCalledTimes(1));
    click();
    await vi.waitFor(() => expect(subject.events.tabs.sendMessage).toHaveBeenCalledTimes(2));

    const first = subject.events.tabs.sendMessage.mock.calls[0]![1] as { documentId?: string };
    const second = subject.events.tabs.sendMessage.mock.calls[1]![1] as { documentId?: string };
    // 反复右键若每次都换新 id，content 侧 router 会按 id 再建一个 controller +
    // watchdog 端口 + contextmenu 监听且永不回收（diagnosisDocumentIds 的注释）。
    expect(first.documentId).toBeTypeOf("string");
    expect(second.documentId).toBe(first.documentId);
    // 记忆不等于记账：activeTabs 仍必须保持空（spec D1）。
    expect(subject.sessionData["activeTabs.v1"]).toBeUndefined();
  });
});

describe("detail prefetch", () => {
  beforeEach(() => vi.clearAllMocks());

  const popup = {
    id: "extension-id",
    url: "chrome-extension://extension-id/src/popup/popup.html",
  };
  const requestCore = {
    schemaVersion: CORE_SCHEMA_VERSION,
    sentenceId: sentence.sentenceId,
    components: [{ startToken: 0, endToken: 0, role: GrammarRole.SUBJECT, translation: "学习者" }],
    modelProfileId: "profile-a",
  };

  function prefetchSentenceDetailsRequest(): RequestMessage {
    return pageRequest({ type: "PREFETCH_SENTENCE_DETAILS", sentence, core: requestCore });
  }

  it("START_SESSION forwards prefetchDetail: true only when the flag is on and a profile exists", async () => {
    const subject = chromeMock();
    registerServiceWorker(dependencies({}, profiles, true), subject.api);

    await dispatch(
      subject.events.runtime.onMessage.listeners[0]!,
      pageRequest({ type: "START_SESSION" }),
      popup,
    );

    expect(subject.events.tabs.sendMessage).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ type: "START_SESSION", prefetchDetail: true }),
    );
  });

  it("START_SESSION omits the flag when disabled or when no profile exists", async () => {
    const disabledSubject = chromeMock();
    registerServiceWorker(dependencies({}, profiles, false), disabledSubject.api);
    await dispatch(
      disabledSubject.events.runtime.onMessage.listeners[0]!,
      pageRequest({ type: "START_SESSION" }),
      popup,
    );
    const disabledCommand = disabledSubject.events.tabs.sendMessage.mock.calls.find(
      ([, message]) => (message as { type?: string }).type === "START_SESSION",
    )![1];
    expect(disabledCommand).not.toHaveProperty("prefetchDetail");

    const profilelessSubject = chromeMock();
    registerServiceWorker(dependencies({}, [], true), profilelessSubject.api);
    await dispatch(
      profilelessSubject.events.runtime.onMessage.listeners[0]!,
      pageRequest({ type: "START_SESSION" }),
      popup,
    );
    const profilelessCommand = profilelessSubject.events.tabs.sendMessage.mock.calls.find(
      ([, message]) => (message as { type?: string }).type === "START_SESSION",
    )![1];
    expect(profilelessCommand).not.toHaveProperty("prefetchDetail");
  });

  it("PREFETCH_SENTENCE_DETAILS routes to the service and echoes counts", async () => {
    const analyzeSentenceDetails = vi.fn<AnalysisService["analyzeSentenceDetails"]>(() =>
      Promise.resolve({ succeeded: 3, failed: 1 }),
    );
    const subject = chromeMock();
    registerServiceWorker(dependencies({ analyzeSentenceDetails }), subject.api);

    const response = await dispatch(
      subject.events.runtime.onMessage.listeners[0]!,
      prefetchSentenceDetailsRequest(),
    );

    expect(response).toMatchObject({
      type: "SENTENCE_DETAILS_RESULT",
      succeeded: 3,
      failed: 1,
    });
    expect(analyzeSentenceDetails).toHaveBeenCalledOnce();
    const [input, signal] = analyzeSentenceDetails.mock.calls[0]!;
    expect(input).toMatchObject({
      profile: { id: "profile-a" },
      documentId: "document-1",
      sentence,
      core: requestCore,
    });
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("PREFETCH_SENTENCE_DETAILS pauses the profile on AUTH_FAILED and stops calling the service", async () => {
    const analyzeSentenceDetails = vi
      .fn<AnalysisService["analyzeSentenceDetails"]>()
      .mockRejectedValue(
        Object.assign(new Error("SECRET-A"), {
          code: "AUTH_FAILED",
          retryable: false,
          details: { status: 401 },
        }),
      );
    const subject = chromeMock();
    registerServiceWorker(dependencies({ analyzeSentenceDetails }), subject.api);
    const listener = subject.events.runtime.onMessage.listeners[0]!;

    const first = await dispatch(listener, prefetchSentenceDetailsRequest());
    const second = await dispatch(listener, prefetchSentenceDetailsRequest());

    expect(first).toMatchObject({ type: "ERROR", error: { code: "AUTH_FAILED" } });
    expect(second).toMatchObject({ type: "ERROR", error: { code: "AUTH_FAILED" } });
    expect(analyzeSentenceDetails).toHaveBeenCalledOnce();
    expect(JSON.stringify([first, second])).not.toContain("SECRET-A");
  });

  it("PREFETCH_SENTENCE_DETAILS without a profile returns CONFIG_MISSING", async () => {
    const subject = chromeMock();
    registerServiceWorker(dependencies({}, []), subject.api);

    const response = await dispatch(
      subject.events.runtime.onMessage.listeners[0]!,
      prefetchSentenceDetailsRequest(),
    );

    expect(response).toMatchObject({ type: "ERROR", error: { code: "CONFIG_MISSING" } });
  });

  it("isStatus accepts and relays detail counters", async () => {
    const subject = chromeMock();
    registerServiceWorker(dependencies(), subject.api);
    const listener = subject.events.runtime.onMessage.listeners[0]!;
    const statusWithDetails: SessionStatus = {
      ...emptyRunningStatus,
      detailTotal: 5,
      detailReady: 3,
      detailFailed: 1,
    };

    const relayed = await dispatch(listener, {
      version: 1,
      requestId: "status-detail",
      type: "SESSION_STATUS",
      tabId: 7,
      documentId: "document-1",
      status: statusWithDetails,
    });
    const fetched = await dispatch(listener, pageRequest({ type: "GET_SESSION_STATUS" }));

    expect(relayed).toMatchObject({ type: "ACK" });
    expect(fetched).toMatchObject({ type: "SESSION_STATUS", status: statusWithDetails });

    for (const detailTotal of [-1, 1.5]) {
      const rejected = await dispatch(listener, {
        version: 1,
        requestId: "status-detail-bad",
        type: "SESSION_STATUS",
        tabId: 7,
        documentId: "document-1",
        status: { ...emptyRunningStatus, detailTotal },
      });
      expect(rejected).toMatchObject({
        type: "ERROR",
        // 形状不对的会话状态是协议问题,不该顶着 INVALID_MODEL_OUTPUT 把人引去换模型。
        error: { code: "MALFORMED_MESSAGE" },
      });
    }
  });
});

describe("model request scheduler wiring", () => {
  function modelWork(): AnalysisModelWork {
    return {
      profile: profiles[0]!,
      messages: [{ role: "user", content: "prompt" }],
      schema: { name: "core_analysis", schema: {} },
      requestedAt: 0,
      run: () => Promise.resolve({}),
    };
  }

  it("keeps four model requests in flight instead of the scheduler default of two", async () => {
    const releases: Array<() => void> = [];
    const runTask = vi.fn(async () => {
      await new Promise<void>((resolve) => releases.push(resolve));
      return {};
    });
    const drain = (): void => {
      while (releases.length > 0) releases.shift()!();
    };
    const scheduler = createModelRequestScheduler(runTask);

    const pending = Array.from({ length: 5 }, (_, index) =>
      scheduler.schedule({
        cacheKey: `key-${index}`,
        documentId: "document-1",
        priority: "visible-core",
        sentenceCount: 1,
        input: modelWork(),
      }),
    );

    await vi.waitFor(() => expect(runTask).toHaveBeenCalledTimes(4));
    expect(runTask).toHaveBeenCalledTimes(4);

    drain();
    await vi.waitFor(() => expect(runTask).toHaveBeenCalledTimes(5));
    drain();
    await expect(Promise.all(pending)).resolves.toHaveLength(5);
  });
});

describe("core request priority", () => {
  it("routes offscreen blocks to prefetch-core and visible blocks to visible-core", async () => {
    const analyzeCore = vi.fn<AnalysisService["analyzeCore"]>(() =>
      Promise.resolve({ result: [], failures: [], cacheHit: false }),
    );
    const subject = chromeMock();
    registerServiceWorker(dependencies({ analyzeCore }), subject.api);
    const listener = subject.events.runtime.onMessage.listeners[0]!;

    await dispatch(listener, pageRequest({ type: "ANALYZE_CORE", sentences: [sentence] }));
    await dispatch(
      listener,
      pageRequest({ type: "ANALYZE_CORE", sentences: [sentence], offscreen: true }),
    );

    expect(analyzeCore.mock.calls[0]![0].priority).toBe("visible-core");
    expect(analyzeCore.mock.calls[1]![0].priority).toBe("prefetch-core");
  });
});

describe("provisional core stream push", () => {
  it("posts filtered, redacted components to the document's port while analysis streams", async () => {
    const analyzeCore = vi.fn<AnalysisService["analyzeCore"]>((input) => {
      input.onStreamedComponent?.(sentence.sentenceId, [
        {
          startToken: 0,
          endToken: 0,
          role: GrammarRole.SUBJECT,
          translation: "密钥 SECRET-A 与 HEADER-A 混入",
        },
      ]);
      return Promise.resolve({ result: [], failures: [], cacheHit: false });
    });
    const subject = chromeMock();
    registerServiceWorker(dependencies({ analyzeCore }), subject.api);

    const onDisconnect = event<() => void>();
    const postMessage = vi.fn();
    subject.events.runtime.onConnect.listeners[0]!({
      name: "syntax-learning:document-1",
      sender: { tab: { id: 7 } as chrome.tabs.Tab },
      onDisconnect,
      postMessage,
    } as unknown as chrome.runtime.Port);

    await dispatch(
      subject.events.runtime.onMessage.listeners[0]!,
      pageRequest({ type: "ANALYZE_CORE", sentences: [sentence] }),
    );

    expect(postMessage).toHaveBeenCalledTimes(1);
    const push = postMessage.mock.calls[0]![0] as {
      type: string;
      sentenceId: string;
      components: Array<{ translation: string }>;
    };
    expect(push.type).toBe("CORE_STREAM");
    expect(push.sentenceId).toBe(sentence.sentenceId);
    // 分片绝不能绕过脱敏。
    expect(push.components[0]!.translation).toBe("密钥 [redacted] 与 [redacted] 混入");
  });

  it("stops streaming to a document whose port has disconnected", async () => {
    const analyzeCore = vi.fn<AnalysisService["analyzeCore"]>((input) => {
      input.onStreamedComponent?.(sentence.sentenceId, []);
      return Promise.resolve({ result: [], failures: [], cacheHit: false });
    });
    const subject = chromeMock();
    registerServiceWorker(dependencies({ analyzeCore }), subject.api);

    const onDisconnect = event<() => void>();
    const postMessage = vi.fn();
    subject.events.runtime.onConnect.listeners[0]!({
      name: "syntax-learning:document-1",
      sender: { tab: { id: 7 } as chrome.tabs.Tab },
      onDisconnect,
      postMessage,
    } as unknown as chrome.runtime.Port);
    onDisconnect.listeners[0]!();

    await dispatch(
      subject.events.runtime.onMessage.listeners[0]!,
      pageRequest({ type: "ANALYZE_CORE", sentences: [sentence] }),
    );

    expect(postMessage).not.toHaveBeenCalled();
  });
});

describe("chat 路由", () => {
  beforeEach(() => vi.clearAllMocks());

  const chatCore = {
    schemaVersion: CORE_SCHEMA_VERSION,
    sentenceId: sentence.sentenceId,
    components: [{ startToken: 0, endToken: 0, role: GrammarRole.SUBJECT, translation: "学习者" }],
    modelProfileId: "profile-a",
  };

  function chatAskRequest(
    options: { history?: ChatTurn[]; question?: string; conversationId?: string } = {},
  ): RequestMessage {
    return pageRequest({
      type: "CHAT_ASK",
      conversationId: options.conversationId ?? "document-1:chat:1",
      context: { kind: "sentence" as const, sentence, core: chatCore },
      history: options.history ?? [
        { role: "user" as const, content: "这句为什么这么译？" },
        { role: "assistant" as const, content: "因为主语是复数。" },
      ],
      question: options.question ?? "side by side 修饰谁？",
    });
  }

  function connectPort(subject: ReturnType<typeof chromeMock>): {
    onDisconnect: ReturnType<typeof event<() => void>>;
    postMessage: ReturnType<typeof vi.fn>;
  } {
    const onDisconnect = event<() => void>();
    const postMessage = vi.fn();
    subject.events.runtime.onConnect.listeners[0]!({
      name: "syntax-learning:document-1",
      sender: { tab: { id: 7 } as chrome.tabs.Tab },
      onDisconnect,
      postMessage,
    } as unknown as chrome.runtime.Port);
    return { onDisconnect, postMessage };
  }

  function chatPushes(postMessage: ReturnType<typeof vi.fn>): ChatStreamPush[] {
    return postMessage.mock.calls.map((call) => call[0] as ChatStreamPush);
  }

  it("合法 CHAT_ASK：流式两段全量经端口推送，CHAT_RESULT 带脱敏后的完整回答", async () => {
    const chat = vi.fn<AnalysisService["chat"]>((input) => {
      input.onStreamedText?.("第一段，密钥 SECRET-A 与 HEADER-A 混入。");
      input.onStreamedText?.("第一段，密钥 SECRET-A 与 HEADER-A 混入。第二段。");
      return Promise.resolve({ answer: "第一段，密钥 SECRET-A 与 HEADER-A 混入。第二段。" });
    });
    const subject = chromeMock();
    registerServiceWorker(dependencies({ chat }), subject.api);
    const { postMessage } = connectPort(subject);

    const response = await dispatch(
      subject.events.runtime.onMessage.listeners[0]!,
      chatAskRequest(),
    );

    // documentId 原样下发,:chat 命名空间后缀由 service 内部追加
    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat.mock.calls[0]![0]).toMatchObject({
      documentId: "document-1",
      conversationId: "document-1:chat:1",
      question: "side by side 修饰谁？",
    });
    expect(chat.mock.calls[0]![0].onStreamedText).toBeTypeOf("function");

    const pushes = chatPushes(postMessage);
    expect(pushes).toHaveLength(2);
    expect(pushes[0]).toMatchObject({
      type: "CHAT_STREAM",
      documentId: "document-1",
      conversationId: "document-1:chat:1",
      text: "第一段，密钥 [redacted] 与 [redacted] 混入。",
    });
    expect(pushes[1]).toMatchObject({
      type: "CHAT_STREAM",
      text: "第一段，密钥 [redacted] 与 [redacted] 混入。第二段。",
    });
    expect(JSON.stringify(pushes)).not.toMatch(/SECRET-A|HEADER-A/);

    expect(response.type).toBe("CHAT_RESULT");
    if (response.type !== "CHAT_RESULT") return;
    expect(response.conversationId).toBe("document-1:chat:1");
    expect(response.answer).toBe("第一段，密钥 [redacted] 与 [redacted] 混入。第二段。");
    expect(JSON.stringify(response)).not.toMatch(/SECRET-A|HEADER-A/);
  });

  it("question trim 后为空或超过 2000 字符 → MALFORMED_MESSAGE；恰 2000 放行", async () => {
    const chat = vi.fn<AnalysisService["chat"]>().mockResolvedValue({ answer: "好的" });
    const subject = chromeMock();
    registerServiceWorker(dependencies({ chat }), subject.api);
    const listener = subject.events.runtime.onMessage.listeners[0]!;

    const blank = await dispatch(listener, chatAskRequest({ question: "   " }));
    const overlong = await dispatch(listener, chatAskRequest({ question: "x".repeat(2001) }));
    const boundary = await dispatch(listener, chatAskRequest({ question: "x".repeat(2000) }));

    expect(blank).toMatchObject({ type: "ERROR", error: { code: "MALFORMED_MESSAGE" } });
    expect(overlong).toMatchObject({ type: "ERROR", error: { code: "MALFORMED_MESSAGE" } });
    expect(boundary.type).toBe("CHAT_RESULT");
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("history 超过 6 个 ChatTurn 项或总字符超 8000 → MALFORMED_MESSAGE", async () => {
    const chat = vi.fn<AnalysisService["chat"]>().mockResolvedValue({ answer: "好的" });
    const subject = chromeMock();
    registerServiceWorker(dependencies({ chat }), subject.api);
    const listener = subject.events.runtime.onMessage.listeners[0]!;

    const sevenTurns: ChatTurn[] = Array.from({ length: 7 }, (_, index) =>
      index % 2 === 0
        ? { role: "user" as const, content: `问 ${index}` }
        : { role: "assistant" as const, content: `答 ${index}` },
    );
    const tooManyTurns = await dispatch(listener, chatAskRequest({ history: sevenTurns }));

    const heavyHistory: ChatTurn[] = [
      { role: "user", content: "x".repeat(8000) },
      { role: "assistant", content: "y" },
    ];
    const tooManyCharacters = await dispatch(listener, chatAskRequest({ history: heavyHistory }));

    // 边界：恰 6 项且总字符恰 8000 放行
    const boundaryHistory: ChatTurn[] = [
      { role: "user", content: "x".repeat(7999) },
      { role: "assistant", content: "y" },
    ];
    const boundary = await dispatch(listener, chatAskRequest({ history: boundaryHistory }));

    expect(tooManyTurns).toMatchObject({ type: "ERROR", error: { code: "MALFORMED_MESSAGE" } });
    expect(tooManyCharacters).toMatchObject({
      type: "ERROR",
      error: { code: "MALFORMED_MESSAGE" },
    });
    expect(boundary.type).toBe("CHAT_RESULT");
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("无 profile → CONFIG_MISSING（chat 无缓存兜底语义）", async () => {
    const chat = vi.fn<AnalysisService["chat"]>();
    const subject = chromeMock();
    registerServiceWorker(dependencies({ chat }, []), subject.api);

    const response = await dispatch(
      subject.events.runtime.onMessage.listeners[0]!,
      chatAskRequest(),
    );

    expect(response).toMatchObject({ type: "ERROR", error: { code: "CONFIG_MISSING" } });
    expect(chat).not.toHaveBeenCalled();
  });

  it("chat 抛 AUTH_FAILED → pauseProfile 并回 ERROR；暂停期间不再打模型", async () => {
    const chat = vi.fn<AnalysisService["chat"]>().mockRejectedValueOnce(
      Object.assign(new Error("HTTP 401 SECRET-A"), {
        code: "AUTH_FAILED",
        retryable: false,
        details: { status: 401 },
      }),
    );
    const subject = chromeMock();
    registerServiceWorker(dependencies({ chat }), subject.api);
    const listener = subject.events.runtime.onMessage.listeners[0]!;

    const first = await dispatch(listener, chatAskRequest({ conversationId: "document-1:chat:1" }));
    const second = await dispatch(
      listener,
      chatAskRequest({ conversationId: "document-1:chat:2" }),
    );

    expect(first).toMatchObject({ type: "ERROR", error: { code: "AUTH_FAILED" } });
    expect(second).toMatchObject({ type: "ERROR", error: { code: "AUTH_FAILED" } });
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("端口未注册时不传 onStreamedText，回答随 CHAT_RESULT 整段下发", async () => {
    const chat = vi.fn<AnalysisService["chat"]>().mockResolvedValue({ answer: "整段回答" });
    const subject = chromeMock();
    registerServiceWorker(dependencies({ chat }), subject.api);

    const response = await dispatch(
      subject.events.runtime.onMessage.listeners[0]!,
      chatAskRequest(),
    );

    expect(response.type).toBe("CHAT_RESULT");
    expect(chat.mock.calls[0]![0].onStreamedText).toBeUndefined();
    if (response.type === "CHAT_RESULT") expect(response.answer).toBe("整段回答");
  });

  it("流式开关关闭时不传 onStreamedText，回答只随 CHAT_RESULT 下发", async () => {
    const chat = vi.fn<AnalysisService["chat"]>().mockResolvedValue({ answer: "整段回答" });
    const deps = dependencies({ chat });
    // eslint-disable-next-line @typescript-eslint/unbound-method
    vi.mocked(deps.configRepository.getStreamRendering).mockResolvedValue(false);
    const subject = chromeMock();
    registerServiceWorker(deps, subject.api);
    const { postMessage } = connectPort(subject);

    const response = await dispatch(
      subject.events.runtime.onMessage.listeners[0]!,
      chatAskRequest(),
    );

    expect(response.type).toBe("CHAT_RESULT");
    expect(chat.mock.calls[0]![0].onStreamedText).toBeUndefined();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("端口断开时同时回收 chat 命名空间的调度槽位（documentId:chat）", async () => {
    const subject = chromeMock();
    const deps = dependencies();
    registerServiceWorker(deps, subject.api);
    const { onDisconnect } = connectPort(subject);

    onDisconnect.listeners[0]!();

    await vi.waitFor(() =>
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(deps.scheduler.cancelDocument).toHaveBeenCalledWith("document-1:chat"),
    );
  });

  it("标签页关闭（cancelTab）同样回收 chat 命名空间槽位", async () => {
    const subject = chromeMock();
    const deps = dependencies();
    registerServiceWorker(deps, subject.api);
    const listener = subject.events.runtime.onMessage.listeners[0]!;
    const status: SessionStatus = { ...emptyRunningStatus };
    await dispatch(listener, {
      version: 1,
      requestId: "status-chat-1",
      type: "SESSION_STATUS",
      status,
      tabId: 7,
      documentId: "document-1",
    });

    subject.events.tabs.onRemoved.listeners[0]!(7);

    // eslint-disable-next-line @typescript-eslint/unbound-method
    const cancelDocument = vi.mocked(deps.scheduler.cancelDocument);
    expect(cancelDocument).toHaveBeenCalledWith("document-1");
    expect(cancelDocument).toHaveBeenCalledWith("document-1:chat");
  });
});

describe("profile capability writers", () => {
  function repositoryStub() {
    const stored: ModelProfile = { ...profiles[0]! };
    return {
      stored,
      port: {
        getProfile: vi.fn((id: string) =>
          Promise.resolve(id === stored.id ? { ...stored } : undefined),
        ),
        saveProfile: vi.fn((profile: ModelProfile) => {
          Object.assign(stored, profile);
          return Promise.resolve();
        }),
      },
    };
  }

  it("persists a discovered json-schema downgrade", async () => {
    const repository = repositoryStub();

    await createProfileCapabilityWriters(repository.port).persistJsonSchemaSupport(
      repository.stored.id,
      "unsupported",
    );

    expect(repository.stored.jsonSchemaSupport).toBe("unsupported");
  });

  // 漏接这个的后果:端点每拒绝一次流式就白费一趟 400，且永远不会被记住。
  it("persists a discovered streaming downgrade", async () => {
    const repository = repositoryStub();

    await createProfileCapabilityWriters(repository.port).persistStreamSupport(
      repository.stored.id,
      "unsupported",
    );

    expect(repository.stored.streamSupport).toBe("unsupported");
  });

  it("ignores a capability write for a profile that no longer exists", async () => {
    const repository = repositoryStub();

    await createProfileCapabilityWriters(repository.port).persistStreamSupport(
      "deleted-profile",
      "unsupported",
    );

    expect(repository.port.saveProfile).not.toHaveBeenCalled();
  });
});

/**
 * MV3 的 service worker 空闲约 30 秒即被终止，而 activeTabs 是内存 Map——重启后
 * 下一次操作会生成全新的 documentId，页面上已渲染的卡片却还攥着旧的那个，于是
 * 点成分看详解、点「重新解析」全被判成过期文档拒成 REQUEST_CANCELLED。
 */
describe("documentId 熬过 service worker 重启", () => {
  it("重启后复用 session 里记着的 documentId，而不是另生成一个", async () => {
    const first = chromeMock();
    registerServiceWorker(dependencies(), first.api);
    first.events.commands.onCommand.listeners[0]!("parse-hovered-block", {
      id: 7,
    } as chrome.tabs.Tab);
    await vi.waitFor(() =>
      expect(first.events.tabs.sendMessage).toHaveBeenCalledWith(7, expect.anything()),
    );
    const before = (first.events.tabs.sendMessage.mock.calls[0]![1] as { documentId: string })
      .documentId;

    // 模拟重启:内存全丢，只有 session 存储留下来。
    const restarted = chromeMock(first.sessionData);
    registerServiceWorker(dependencies(), restarted.api);
    restarted.events.commands.onCommand.listeners[0]!("parse-hovered-block", {
      id: 7,
    } as chrome.tabs.Tab);
    await vi.waitFor(() =>
      expect(restarted.events.tabs.sendMessage).toHaveBeenCalledWith(7, expect.anything()),
    );
    const after = (restarted.events.tabs.sendMessage.mock.calls[0]![1] as { documentId: string })
      .documentId;

    expect(after).toBe(before);
  });
});

/**
 * 唤醒 SW 的往往正是这次关闭或导航本身:那一刻 activeTabs 还空着，清理无从下手，
 * 紧接着 session 回填又把陈旧记录塞回内存——这个标签页就再也忘不掉了。旧 documentId
 * 一直顶着，页面新会话的状态中继全被判成过期文档(点成分报错、弹窗回落成「开始学习」)。
 *
 * 反方向由「cancels only the recorded document on tab close and navigation」钉着:
 * 清理不能挪到回填之后——紧随导航而来的状态中继会先看到旧 documentId 而被拒。
 */
describe("回填落地前就被忘掉的标签页", () => {
  const running: SessionStatus = {
    state: "running",
    discovered: 3,
    queued: 0,
    ready: 3,
    failed: 0,
  };
  const seed = (documentId: string) => ({
    "activeTabs.v1": [[7, { documentId, status: running }]],
  });

  it("回填不许把刚关掉的标签页塞回账本", async () => {
    const mock = chromeMock(seed("document-old"));
    registerServiceWorker(dependencies(), mock.api);

    // 回填(await storage.session.get)还挂在微任务队列上，标签页就已经关了。
    mock.events.tabs.onRemoved.listeners[0]!(7);

    await vi.waitFor(() => expect(mock.sessionData["activeTabs.v1"]).toEqual([]));
    // 忘干净了，同一个标签页的新会话才登记得上，而不是撞上旧 documentId 被拒。
    const response = await dispatch(mock.events.runtime.onMessage.listeners[0]!, {
      version: 1,
      requestId: "status-1",
      type: "SESSION_STATUS",
      status: running,
      tabId: 7,
      documentId: "document-new",
    });
    expect(response.type).toBe("ACK");
    expect(mock.sessionData["activeTabs.v1"]).toEqual([
      [7, { documentId: "document-new", status: running }],
    ]);
  });

  it("回填落地前的 SPA 导航照旧通知页面停下，documentId 取自 session", async () => {
    const mock = chromeMock(seed("document-old"));
    registerServiceWorker(dependencies(), mock.api);

    mock.events.tabs.onUpdated.listeners[0]!(7, { url: "https://example.com/next" }, {
      id: 7,
    } as chrome.tabs.Tab);

    // 文档没重载，页面里那个 controller 还活着，攥着的正是 session 里记下的
    // documentId;不通知它，MutationObserver 一看到新内容就把新页面整篇解析了。
    await vi.waitFor(() =>
      expect(mock.events.tabs.sendMessage).toHaveBeenCalledWith(
        7,
        expect.objectContaining({ type: "STOP_SESSION", documentId: "document-old" }),
      ),
    );
    expect(mock.sessionData["activeTabs.v1"]).toEqual([]);
  });
});

/**
 * SPA(Mintlify 一类文档站)切换页面走 history.pushState，不重载文档，因此不会有
 * status === "loading"。会话于是活到下一个页面，MutationObserver 一看到新内容就
 * 自动解析——用户只是点了个链接，却发现新页面被整篇翻译了。
 */
describe("SPA 导航结束会话", () => {
  it("URL 变化即取消该标签页的会话，即使没有重载", async () => {
    const mock = chromeMock();
    registerServiceWorker(dependencies(), mock.api);
    // 先建立会话，否则没有可取消的东西。
    mock.events.commands.onCommand.listeners[0]!("parse-hovered-block", {
      id: 7,
    } as chrome.tabs.Tab);
    await vi.waitFor(() =>
      expect(mock.events.tabs.sendMessage).toHaveBeenCalledWith(7, expect.anything()),
    );
    mock.events.tabs.sendMessage.mockClear();
    const onUpdated = mock.events.tabs.onUpdated.listeners[0]!;

    onUpdated(7, { url: "https://example.com/next" }, {} as chrome.tabs.Tab);

    expect(mock.events.tabs.sendMessage).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ type: "STOP_SESSION" }),
    );
  });
});
