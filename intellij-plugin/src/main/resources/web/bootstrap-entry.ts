/**
 * JCEF 预览页入口:把模块化的 preview/render/bridge 接到 window 全局。
 *
 * Kotlin 经 executeJavaScript 调四个全局入口;JS→Kotlin 经
 * window.EnglishSyntaxHost.post(jsonText)(JBCefJSQuery 注入)。
 * 由构建(rolldown)打包成单文件 IIFE 注入预览页。
 */
import { BRIDGE_VERSION, parseHostMessage } from "./bridge";
import {
  deepestHovered,
  ensureBlockId,
  HIDDEN_ATTRIBUTE,
  nearestPreviewBlock,
  resetScanRegistry,
  scanMarkdownBlocks,
} from "./preview";
import { PreviewRenderer } from "./render";
import { setDarkMode } from "./roles";

interface RuntimeState {
  renderer: PreviewRenderer;
  previewId: string;
  generation: number;
  /** 是否自动上报全文块。false = 手动模式（只有快捷键按段解析驱动）。 */
  autoScan: boolean;
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

/**
 * 短提示（2.5 秒自动隐藏）。快捷键路径没有菜单反馈，静默失败会让用户以为键坏了。
 * 用独立计时器，避免与「解析完成」的淡出互相取消。
 */
let flashTimer: ReturnType<typeof setTimeout> | undefined;

function flashStatus(text: string): void {
  clearTimeout(flashTimer);
  setStatus(text, "error", false);
  flashTimer = setTimeout(hideStatus, 2500);
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
  s.visibility = null;
  // 一次扫描即上报全文所有英文段（不按视口过滤）。此前 observeBlocks 按几何可见
  // 上报，JCEF 里 innerHeight 小/滚动增量失效 → 只报首屏若干块，其余段永不翻译
  // （真机日志：onVisibleBlocks 11 blocks，dispatch 只跑一次 cacheHit=true）。
  if (blocks.length === 0) return;
  // 手动模式（快捷键按段解析）：注册照旧（渲染器需要 blockId → element 映射），但绝不
  // 上报全量块。否则我们插入卡片引发的 mutation、以及官方重渲染后的 initialize
  // （会 resetScanRegistry + 清空指纹），都会把整篇文档送去翻译。
  if (!s.autoScan) return;
  const fingerprint = blocks.map((block) => block.blockId).sort().join("\u0000");
  if (fingerprint === lastVisibleFingerprint) return;
  lastVisibleFingerprint = fingerprint;
  postToHost({
    version: BRIDGE_VERSION,
    type: "VISIBLE_BLOCKS",
    previewId: s.previewId,
    generation: s.generation,
    blocks: blocks.map((block) => ({ blockId: block.blockId, text: block.text })),
  });
  // 首批反馈：全部段打「解析中」标记（段落左侧竖条呼吸动画），结果回来再撤。
  for (const block of blocks) markBlockActive(block.blockId);
  requestedBlocks.clear();
  for (const block of blocks) requestedBlocks.add(block.blockId);
  settledBlocks.clear();
  failedBlocks.clear();
  // 开始后的第一反馈：扫描完成、请求已发出（首次模型调用可能较慢）。
  if (statusEl === null || statusEl.hidden) {
    setStatus(`句法学习：正在解析 ${blocks.length} 段…`, "running");
  }
}

// —— 段落级「解析中」标记：data 属性 + inset box-shadow（Chrome 端同款，不参与布局）。 ——
const ACTIVE_ATTRIBUTE = "data-english-syntax-active";
/** blockId → 标记所在元素。卡片流式出现后标记要跟着移到卡片上。 */
const activeMarkers = new Map<string, HTMLElement>();
/** 已收到结果的 blockId 集合（按块判完成）。 */
const settledBlocks = new Set<string>();
const failedBlocks = new Set<string>();
/**
 * 已请求解析的块。按段解析是逐次累加，用计数器会让 settleBlock 的完成判定算错
 * （第二次按快捷键时 settledBlocks.size 已经 ≥ 1）。整篇路径整体替换、显式路径 add。
 */
const requestedBlocks = new Set<string>();
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
  requestedBlocks.clear();
}

/** 一个块的结果回来了：撤标记；全部可见块都出结果 → 完成反馈。 */
function settleBlock(blockId: string, failed: boolean): void {
  settledBlocks.add(blockId);
  if (failed) failedBlocks.add(blockId);
  unmarkBlockActive(blockId);
  if (requestedBlocks.size > 0 && settledBlocks.size >= requestedBlocks.size) {
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
  state = { renderer, previewId: "", generation: 0, autoScan: true, visibility: null, observer: null };
  return state;
}

/** 同一块的重复触发去抖：两条快捷键通道（IDEA Action + 本页 keydown）可能同时到达。 */
const PARSE_DEBOUNCE_MS = 400;
let lastParsedBlockId = "";
let lastParsedAt = 0;

/**
 * 解析一段并上报 `PARSE_BLOCK`。
 *
 * `target` 省略时查悬停链取最深元素（`deepestHovered`，判据见 `preview.ts`）——这是 Kotlin 的
 * 调用方式（`executeJavaScript` 里不传参）。测试与将来可能的右键路径可以显式传入目标元素。
 */
function parseHoveredBlock(target?: Element | null): void {
  const s = state;
  if (s === null || s.previewId === "") return;
  const hovered = target === undefined ? deepestHovered(document) : target;
  if (hovered !== null && hovered.closest("[data-english-syntax-card]") !== null) {
    // 已经是卡片了：落到下面的「未找到」提示会误导用户。
    flashStatus("该段已解析");
    return;
  }
  const element = nearestPreviewBlock(hovered);
  if (element === null) {
    flashStatus("未找到可解析的段落");
    return;
  }
  if (element.hasAttribute(HIDDEN_ATTRIBUTE)) {
    // 已出过卡的原文。上面那条 closest 只拦得住「鼠标停在卡片里」——原文是卡片的**兄弟**
    // 节点，停在原文上照样会走到这里（CSS 隐藏后仍可能命中：JCEF 的 `:hover` 链在 DOM 变
    // 更后不一定重算，测试与右键路径还会显式传元素）。放行的后果是对同一段重复下发
    // PARSE_BLOCK，而 Kotlin 侧那段句子已全部 READY，没有任何 CORE_RESULT 回来撤掉
    // 「解析中」竖条与浮层；顺带 `registerBlock` 还会清空该块的句子映射，卡片虽在却点不动。
    flashStatus("该段已解析");
    return;
  }
  const blockId = ensureBlockId(element);
  const now = Date.now();
  if (blockId === lastParsedBlockId && now - lastParsedAt < PARSE_DEBOUNCE_MS) return;
  lastParsedBlockId = blockId;
  lastParsedAt = now;

  s.renderer.registerBlock(blockId, element);
  requestedBlocks.add(blockId);
  settledBlocks.delete(blockId);
  failedBlocks.delete(blockId);
  postToHost({
    version: BRIDGE_VERSION,
    type: "PARSE_BLOCK",
    previewId: s.previewId,
    generation: s.generation,
    blockId,
    text: (element.textContent ?? "").trim(),
  });
  markBlockActive(blockId);
  setStatus("句法学习：正在解析 1 段…", "running");
}

interface PageHotkey {
  code: string;
  altKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

/**
 * 兼底通道键位。由 Kotlin 从 IDEA keymap 读实际绑定后下发；默认与 plugin.xml 声明的一致。
 * `null` = 不装兼底监听（keymap 里没有可下发的单段字母数字绑定）。
 */
let hotkey: PageHotkey | null = {
  code: "KeyT",
  altKey: true,
  ctrlKey: false,
  shiftKey: false,
  metaKey: false,
};

function setHotkey(descriptor: unknown): void {
  // 显式 null：keymap 里绑的是两段式 chord、F7 之类的非字母数字键，或用户清了绑定。
  // 关掉监听，而不是保留一个用户根本没绑的幻影键位——它还会 preventDefault 吃掉按键。
  if (descriptor === null) {
    hotkey = null;
    return;
  }
  if (typeof descriptor !== "object") return;
  const candidate = descriptor as Partial<PageHotkey>;
  if (typeof candidate.code !== "string" || candidate.code === "") return;
  hotkey = {
    code: candidate.code,
    altKey: candidate.altKey === true,
    ctrlKey: candidate.ctrlKey === true,
    shiftKey: candidate.shiftKey === true,
    metaKey: candidate.metaKey === true,
  };
}

function initialize(previewId: string, generation: number, autoScan = true): void {
  const s = ensureState();
  s.previewId = previewId;
  s.generation = generation;
  // 默认 true 兼容既有调用方；Kotlin 侧总是显式下发（EnglishSyntaxPreviewPanel.autoScan）。
  s.autoScan = autoScan;
  returnedCount = 0;
  lastVisibleFingerprint = ""; // 新代次重新上报可见块
  clearAllActive();
  resetScanRegistry(); // 重新扫描全文：清空防重扫描注册表，否则二次 scan 返回空、失败句无法重派
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
      // 进度数字以 Kotlin 侧 ready/discovered/failed 为准（句级权威计数）。
      // 当 ready + failed >= discovered 说明全部句子都有终态 → 显示完成并隐藏，
      // 而不是一直停在「X/Y 句」——否则接口失败时浮层永远转圈。
      if (message.state === "paused") {
        setStatus(`⏸ 已暂停（${message.ready}/${message.discovered}）`, "paused", false);
        return;
      }
      const allSettled =
        message.discovered > 0 && message.ready + message.failed >= message.discovered;
      if (allSettled) {
        clearTimeout(completeTimer);
        const failedText = message.failed > 0 ? `，${message.failed} 句失败` : "";
        setStatus(`✓ 句法解析完成${failedText}`, "running");
        completeTimer = setTimeout(hideStatus, 2500);
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
      // 清卡是「我方主动 restore」，不是官方 updateDom 重渲染：把「有卡片」基线复位，
      // 否则 renderer.restoreAll() 删除卡片这个 DOM 变更会让 MutationObserver 的
      // trackPreviewRendered() 看到「卡片从有到无」误判成 PREVIEW_RENDERED → Kotlin
      // 换代重扫 → rescan() 又亮出「正在解析」进度浮层（停止后进度重现的回归）。
      // 复位要赶在 MutationObserver 微任务回调之前（同步、同一 JS task 内即可满足）。
      previewHadCards = false;
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

// 焦点在 JCEF 预览里时 IDEA Action 可能收不到按键（取决于 JCEF 是否跑在离屏渲染模式），
// 预览页自己兜住。修饰键逐位相等，避免 Alt+Shift+T 误触发绑定为 Alt+T 的入口。
document.addEventListener("keydown", (event) => {
  const bound = hotkey;
  if (bound === null) return;
  if (
    event.code !== bound.code ||
    event.altKey !== bound.altKey ||
    event.ctrlKey !== bound.ctrlKey ||
    event.shiftKey !== bound.shiftKey ||
    event.metaKey !== bound.metaKey
  ) {
    return;
  }
  event.preventDefault();
  parseHoveredBlock();
});

const w = window as unknown as Record<string, unknown>;
w.__englishSyntaxInitialize = initialize;
w.__englishSyntaxReload = reload;
w.__englishSyntaxScrollTo = scrollTo;
w.__englishSyntaxMessage = handleHostMessage;
// 深色主题开关：Kotlin 检测当前 IDEA 主题明暗后注入，角色字色据此选浅/深色板。
w.__englishSyntaxSetTheme = setDarkMode;
// 快捷键按段解析：Kotlin 的 Action 通道与本页 keydown 兼底通道共用这个入口。
w.__englishSyntaxParseHoveredBlock = parseHoveredBlock;
w.__englishSyntaxSetHotkey = setHotkey;
