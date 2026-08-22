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
import { setDarkMode } from "./roles";

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
  const spinner = document.createElement("span");
  spinner.className = "english-syntax-status-spinner";
  const label = document.createElement("span");
  label.className = "english-syntax-status-label";
  statusEl.append(spinner, label);
  document.body.appendChild(statusEl);
  return statusEl;
}

function setStatus(text: string, kind: "running" | "paused" | "error", spinning = true): void {
  const el = ensureStatusElement();
  el.querySelector(".english-syntax-status-label")!.textContent = text;
  el.dataset.kind = kind;
  el.hidden = false;
  const spinner = el.querySelector<HTMLElement>(".english-syntax-status-spinner")!;
  spinner.style.display = spinning ? "" : "none";
}

function hideStatus(): void {
  if (statusEl !== null) statusEl.hidden = true;
}

function bumpReturned(sentenceCount: number): void {
  // 进度数字由 SESSION_STATE 的 ready/discovered 统一显示（更准确），这里只记录计数。
  returnedCount += sentenceCount;
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
    // 防环与防抖：卡片渲染也是 DOM 变更，会再次触发 MutationObserver → rescan →
    // 这里的回调。相同可见集合（blockId 拼接指纹）不重复上报——否则 Kotlin 侧反复
    // 收到同一批块，缓存命中 → CORE_RESULT → 再触发渲染 → 循环不止（CPU 狂转）。
    const fingerprint = visible.map((block) => block.blockId).sort().join("\u0000");
    if (fingerprint === lastVisibleFingerprint) return;
    lastVisibleFingerprint = fingerprint;
    postToHost({
      version: BRIDGE_VERSION,
      type: "VISIBLE_BLOCKS",
      previewId: s.previewId,
      generation: s.generation,
      blocks: visible.map((block) => ({ blockId: block.blockId, text: block.text })),
    });
    // 首批反馈：可见块打「解析中」标记（段落左侧竖条呼吸动画），结果回来再撤。
    for (const block of visible) markBlockActive(block.blockId);
    reportedBlockCount = visible.length;
    settledBlocks.clear();
    failedBlocks.clear();
    // 开始后的第一反馈：扫描完成、请求已发出（首次模型调用可能较慢）。
    if (statusEl === null || statusEl.hidden) {
      setStatus(`句法学习：正在解析 ${visible.length} 段…`, "running");
    }
  });
  s.visibility.start();
}

// —— 段落级「解析中」标记：data 属性 + inset box-shadow（Chrome 端同款，不参与布局）。 ——
const ACTIVE_ATTRIBUTE = "data-english-syntax-active";
/** blockId → 标记所在元素。卡片流式出现后标记要跟着移到卡片上。 */
const activeMarkers = new Map<string, HTMLElement>();
/** 已收到结果的 blockId 集合（按块判完成）。 */
const settledBlocks = new Set<string>();
const failedBlocks = new Set<string>();
let reportedBlockCount = 0;
/** 完成浮层淡出定时器。 */
let completeTimer: ReturnType<typeof setTimeout> | undefined;

function markBlockActive(blockId: string): void {
  const s = state;
  if (s === null) return;
  const element = s.renderer.markActive(blockId);
  if (element === null) return;
  const previous = activeMarkers.get(blockId);
  if (previous === element) return;
  previous?.removeAttribute(ACTIVE_ATTRIBUTE);
  element.setAttribute(ACTIVE_ATTRIBUTE, "");
  activeMarkers.set(blockId, element);
}

function unmarkBlockActive(blockId: string): void {
  const element = activeMarkers.get(blockId);
  element?.removeAttribute(ACTIVE_ATTRIBUTE);
  activeMarkers.delete(blockId);
}

function clearAllActive(): void {
  for (const element of activeMarkers.values()) element.removeAttribute(ACTIVE_ATTRIBUTE);
  activeMarkers.clear();
  settledBlocks.clear();
  failedBlocks.clear();
  reportedBlockCount = 0;
}

/** 一个块的结果回来了：撤标记；全部可见块都出结果 → 完成反馈。 */
function settleBlock(blockId: string, failed: boolean): void {
  settledBlocks.add(blockId);
  if (failed) failedBlocks.add(blockId);
  unmarkBlockActive(blockId);
  if (reportedBlockCount > 0 && settledBlocks.size >= reportedBlockCount) {
    clearTimeout(completeTimer);
    const failedText = failedBlocks.size > 0 ? `，${failedBlocks.size} 段失败` : "";
    setStatus(`✓ 句法解析完成${failedText}`, "running");
    completeTimer = setTimeout(hideStatus, 2500);
  }
}

/** 上次上报的可见块指纹；跨代次（initialize）时重置。 */
let lastVisibleFingerprint = "";

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
  lastVisibleFingerprint = ""; // 新代次重新上报可见块
  clearAllActive();
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
      // 进度数字以 Kotlin 侧 ready/discovered 为准；已全部结算（settleBlock 显示过完成）
      // 时不再覆盖，避免「完成」被「X/Y」盖回。
      if (message.state === "paused") {
        setStatus(`⏸ 已暂停（${message.ready}/${message.discovered}）`, "paused", false);
      } else if (settledBlocks.size >= reportedBlockCount && reportedBlockCount > 0) {
        // 已显示完成，不再更新
      } else {
        const failedText = message.failed > 0 ? `，${message.failed} 句失败` : "";
        setStatus(`句法学习：${message.ready}/${message.discovered} 句${failedText}`, "running");
      }
      return;
    }
    case "CORE_STREAM":
      // 流式分片：不计数；卡片已出现，把「解析中」标记从原文块移到卡片上。
      markBlockActive(message.blockId);
      break;
    case "CORE_RESULT":
      bumpReturned(1);
      settleBlock(message.blockId, false);
      break;
    case "CORE_ERROR":
      bumpReturned(1);
      settleBlock(message.blockId, true);
      break;
    case "RESTORE_ALL":
      returnedCount = 0;
      clearAllActive();
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
// 深色主题开关：Kotlin 检测当前 IDEA 主题明暗后注入，角色字色据此选浅/深色板。
w.__englishSyntaxSetTheme = setDarkMode;
