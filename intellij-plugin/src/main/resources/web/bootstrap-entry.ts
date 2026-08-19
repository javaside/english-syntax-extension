/**
 * JCEF 预览页入口:把模块化的 preview/render/bridge 接到 window 全局。
 *
 * Kotlin 经 executeJavaScript 调四个全局入口;JS→Kotlin 经
 * window.EnglishSyntaxHost.post(jsonText)(JBCefJSQuery 注入)。
 * 由构建(rolldown)打包成单文件 IIFE 注入预览页。
 */
import { BRIDGE_VERSION, parseHostMessage } from "./bridge";
import { observeBlocks, scanMarkdownBlocks } from "./preview";
import { PreviewRenderer } from "./render";

interface RuntimeState {
  renderer: PreviewRenderer;
  previewId: string;
  generation: number;
  visibility: { start(): void; stop(): void } | null;
  observer: MutationObserver | null;
}

let state: RuntimeState | null = null;

// —— 预览页状态浮层（右下角）：开始后立即可见，让用户区分「在解析」与「没反应」。 ——
const STATUS_ID = "english-syntax-status";
let statusEl: HTMLElement | null = null;
let returnedCount = 0;

function ensureStatusElement(): HTMLElement {
  if (statusEl !== null && statusEl.isConnected) return statusEl;
  statusEl = document.createElement("div");
  statusEl.id = STATUS_ID;
  statusEl.hidden = true;
  document.body.appendChild(statusEl);
  return statusEl;
}

function setStatus(text: string, kind: "running" | "paused" | "error"): void {
  const el = ensureStatusElement();
  el.textContent = text;
  el.dataset.kind = kind;
  el.hidden = false;
}

function hideStatus(): void {
  if (statusEl !== null) statusEl.hidden = true;
}

function bumpReturned(): void {
  returnedCount += 1;
  setStatus(`句法学习：解析中…（已处理 ${returnedCount} 句）`, "running");
}

function postToHost(message: Record<string, unknown>): void {
  const host = (window as unknown as Record<string, unknown>).EnglishSyntaxHost as
    | { post(text: string): void }
    | undefined;
  if (host !== undefined && typeof host.post === "function") {
    host.post(JSON.stringify(message));
  }
}

function rescan(): void {
  const s = state;
  if (s === null) return;
  const blocks = scanMarkdownBlocks(document.body);
  for (const block of blocks) s.renderer.registerBlock(block.blockId, block.element);
  if (s.visibility !== null) s.visibility.stop();
  s.visibility = observeBlocks(document.body, blocks, (visible) => {
    if (visible.length === 0) return;
    postToHost({
      version: BRIDGE_VERSION,
      type: "VISIBLE_BLOCKS",
      previewId: s.previewId,
      generation: s.generation,
      blocks: visible.map((block) => ({ blockId: block.blockId, text: block.text })),
    });
    // 开始后的第一反馈：扫描完成、请求已发出（首次模型调用可能较慢）。
    if (statusEl === null || statusEl.hidden) {
      setStatus(`句法学习：正在解析 ${visible.length} 段…`, "running");
    }
  });
  s.visibility.start();
}

let previewHadCards = false;

/**
 * 官方预览整体重渲染检测：官方 updateDom 会重写整个 body，把我们插入的卡片全部清掉。
 * 卡片从「有」到「无」是官方重渲染的可靠信号（我们自己的 DOM 操作只会增卡、不会删光），
 * 借此上报 PREVIEW_RENDERED 让 Kotlin 换代并重发 initialize 重新扫描。
 */
function trackPreviewRendered(): boolean {
  const hasCards = document.querySelector("[data-english-syntax-card]") !== null;
  if (previewHadCards && !hasCards) {
    const s = state;
    if (s !== null) {
      postToHost({
        version: BRIDGE_VERSION,
        type: "PREVIEW_RENDERED",
        previewId: s.previewId,
        generation: s.generation,
      });
    }
    previewHadCards = false;
    return true; // 换代由 Kotlin 侧 initialize(新 generation) 驱动，这里不再 rescan
  }
  if (hasCards) previewHadCards = true;
  return false;
}

function ensureState(): RuntimeState {
  if (state !== null) return state;
  const renderer = new PreviewRenderer((sentenceId, focusStart, focusEnd) => {
    postToHost({
      version: BRIDGE_VERSION,
      type: "DETAIL_REQUEST",
      previewId: state?.previewId ?? "",
      generation: state?.generation ?? 0,
      sentenceId,
      focus: { startToken: focusStart, endToken: focusEnd },
    });
  });
  state = { renderer, previewId: "", generation: 0, visibility: null, observer: null };
  return state;
}

function initialize(previewId: string, generation: number): void {
  const s = ensureState();
  s.previewId = previewId;
  s.generation = generation;
  returnedCount = 0;
  ensureStatusElement(); // 官方 updateDom 重写 body 会清掉浮层，换代后重建。
  if (s.observer !== null) s.observer.disconnect();
  s.observer = new MutationObserver(() => {
    if (trackPreviewRendered()) return;
    rescan();
  });
  s.observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  rescan();
  postToHost({ version: BRIDGE_VERSION, type: "PREVIEW_READY", previewId, generation });
}

function reload(offset: number): void {
  const s = ensureState();
  if (s.observer !== null) {
    s.observer.disconnect();
    s.observer = null;
  }
  rescan();
  if (typeof offset === "number" && offset > 0) window.scrollTo(0, offset);
}

function scrollTo(offset: number, smooth: boolean): void {
  window.scrollTo({ top: offset, behavior: smooth ? "smooth" : "auto" });
}

function handleHostMessage(hostJson: unknown): void {
  const s = ensureState();
  const message = parseHostMessage(hostJson, s.generation);
  if (message === null) return;
  switch (message.type) {
    case "SESSION_STATE": {
      // 暂停/继续等状态变化：浮层同步（renderer 不消费此消息）。
      if (message.state === "paused") {
        setStatus(`句法学习：已暂停（${message.ready}/${message.discovered}）`, "paused");
      } else {
        setStatus(`句法学习：${message.ready}/${message.discovered}`, "running");
      }
      return;
    }
    case "CORE_STREAM":
      break; // 流式分片不计数，交给 renderer 渲染暂定卡。
    case "CORE_RESULT":
    case "CORE_ERROR":
      bumpReturned();
      break;
    case "RESTORE_ALL":
      returnedCount = 0;
      hideStatus();
      break;
    default:
      break;
  }
  s.renderer.handleHostMessage(message);
}

// 重试按钮的补充通道:任何带 data-english-syntax-retry 且带 data-sentence-id
// 的按钮都按 RETRY_SENTENCE 上报。renderer 内部的重试走它自己的监听,不冲突。
document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element) || state === null) return;
  const retry = target.closest("[data-english-syntax-retry]");
  if (retry === null) return;
  const sentenceId = retry.getAttribute("data-sentence-id");
  if (sentenceId === null) return;
  postToHost({
    version: BRIDGE_VERSION,
    type: "RETRY_SENTENCE",
    previewId: state.previewId,
    generation: state.generation,
    sentenceId,
  });
});

const w = window as unknown as Record<string, unknown>;
w.__englishSyntaxInitialize = initialize;
w.__englishSyntaxReload = reload;
w.__englishSyntaxScrollTo = scrollTo;
w.__englishSyntaxMessage = handleHostMessage;
