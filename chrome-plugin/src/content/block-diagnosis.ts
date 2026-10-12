import type {
  BlockDiagnosis,
  DiagnosisExplanation,
  SessionDiagnosisSnapshot,
} from "../shared/protocol";
import { MAX_SENTENCES_PER_REQUEST } from "../shared/protocol";
import type { ExtensionError } from "../shared/errors";
import { CLOUD_SENTENCES_PER_REQUEST_FOR_CONTRACT } from "../background/analysis-service";
import {
  explainElement,
  inventoryReadableUnits,
  MINIMUM_AUTO_TEXT_LENGTH,
  type ReadableUnit,
} from "./page-inventory";
import { nearestSafeBlock } from "./document-scanner";
import { normalizedReadableText } from "./readable-dom-text";
import { segmentBlock, tokenize } from "../language/segmenter";

const SENTENCE_LENGTH_LIMIT = 2_000;
const OUTER_HTML_LIMIT = 200;
// 注意：刻意不含 [data-syntax-learning-extension]——那是 installContentScript 设在
// <html> 上的「已安装」标记（content-script.ts:462），任何元素的 closest 都会命中它；
// 把它算进来会让生产环境所有落点退化成 html.parentElement === null（评审 S4）。
const EXTENSION_OWN_SELECTOR =
  "[data-syntax-learning-block],[data-syntax-learning-selection-anchor],[data-syntax-progress-pill],[data-syntax-diagnosis-panel]";

export type DiagnosisTargetSource = "selection" | "contextmenu" | "body" | "extension-ascended";

export interface ResolvedDiagnosisTarget {
  element: Element | null;
  source: DiagnosisTargetSource;
}

let lastTarget: Element | null = null;

/**
 * contextmenu 捕获监听用：记下右键落点。target 不是 Element（含 null）时清空记录——
 * 「无落点」不能沿用上一处过期落点，必须回落到下一优先级。
 */
export function recordDiagnosisTarget(event: Event): void {
  const target = event.target;
  lastTarget = target instanceof Element ? target : null;
}

/** spec D1 落点优先级：选区锚点 → 右键落点 → body；扩展自身元素上溯。 */
export function resolveDiagnosisTarget(doc: Document = document): ResolvedDiagnosisTarget {
  // ① 选区锚点（getSelection().anchorNode 的 parentElement——真实选区的锚点是文本
  //    节点，parentElement 即所选段落）。锚点已不在文档里的陈旧选区（SPA 换内容、
  //    innerHTML 重设）不算数，落到下一优先级。
  const anchor = doc.getSelection()?.anchorNode?.parentElement ?? null;
  if (anchor !== null && doc.contains(anchor)) return { element: anchor, source: "selection" };
  // ② 右键落点；落点在扩展自身元素（卡片/胶囊/面板 host）上时上溯到其父元素
  if (lastTarget !== null) {
    const own = lastTarget.closest(EXTENSION_OWN_SELECTOR);
    if (own === null) return { element: lastTarget, source: "contextmenu" };
    return { element: own.parentElement, source: "extension-ascended" };
  }
  // ③ 兜底
  return { element: doc.body, source: "body" };
}

function cssPath(element: Element): string {
  // 不引用全局 document：元素可能来自独立 Window 的文档（与 page-inventory 的
  // explainElement 同一取舍）。
  const body = element.ownerDocument.body;
  const parts: string[] = [];
  let current: Element | null = element;
  while (current !== null && current !== body && parts.length < 8) {
    let part = current.tagName.toLowerCase();
    if (current.id) part += `#${current.id}`;
    else if (current.classList.length > 0)
      part += `.${[...current.classList].slice(0, 2).join(".")}`;
    parts.unshift(part);
    current = current.parentElement;
  }
  return parts.join(" > ");
}

function sanitizedOuterHtml(element: Element): string {
  const raw = element.outerHTML
    .replace(/\s(value|checked|placeholder|src|href|data-secret)=("[^"]*"|'[^']*')/giu, "")
    .slice(0, OUTER_HTML_LIMIT);
  return raw.length === OUTER_HTML_LIMIT ? `${raw}…` : raw;
}

export interface DiagnoseElementInput {
  target: Element | null;
  targetSource: DiagnosisTargetSource;
  selectionText?: string;
  document: Document;
  sessionSnapshot?: (element: Element | null) => SessionDiagnosisSnapshot;
  url: string;
  now?: () => Date;
}

export function diagnoseElement(input: DiagnoseElementInput): BlockDiagnosis {
  const { target, document } = input;
  const text = target === null ? "" : normalizedReadableText(target);
  const gates = target === null ? [] : explainElement(target);
  const unit: ReadableUnit | undefined =
    target === null
      ? undefined
      : inventoryReadableUnits(document).find(({ element }) => element === target);
  const explicit = target === null ? null : nearestSafeBlock(target);
  const sentences = text.length === 0 ? [] : segmentBlock(text);
  const sentenceLengths = sentences.map(({ text: sentence }) => sentence.length);
  const tokenCount = sentences.reduce(
    (sum, { text: sentence }) => sum + tokenize(sentence).length,
    0,
  );
  const englishGate = gates.find(({ gate }) => gate === "english-dominant");
  const letterGate = gates.find(({ gate }) => gate === "readable-words");
  let url = input.url;
  try {
    const parsed = new URL(input.url);
    parsed.search = "";
    parsed.hash = "";
    url = parsed.toString().replace(/\/$/u, "");
  } catch {
    /* 保持原值 */
  }
  return {
    target:
      target === null
        ? { tagName: "", className: "", id: "", selectorPath: "", outerHtml: "" }
        : {
            tagName: target.tagName,
            className: [...target.classList].join(" ").slice(0, 120),
            id: target.id,
            selectorPath: cssPath(target),
            outerHtml: sanitizedOuterHtml(target),
          },
    targetSource: input.targetSource,
    ...(input.selectionText === undefined ? {} : { selectionText: input.selectionText }),
    inventory: {
      isUnit: unit !== undefined,
      ...(unit === undefined ? {} : { kind: unit.kind }),
      automatic: unit?.automatic ?? false,
      ...(unit?.exclusionReason === undefined ? {} : { exclusionReason: unit.exclusionReason }),
    },
    explicit: {
      resolvable: explicit !== null,
      ...(explicit === null ? {} : { selectorPath: cssPath(explicit.element) }),
    },
    gates,
    text: {
      length: text.length,
      letterWords: typeof letterGate?.value === "number" ? letterGate.value : 0,
      ...(typeof englishGate?.value === "number" ? { englishRatio: englishGate.value } : {}),
      minAutoTextLength: MINIMUM_AUTO_TEXT_LENGTH,
    },
    segmentation: {
      sentenceCount: sentences.length,
      sentenceLengths,
      tokenCount,
      emptyText: text.length === 0,
    },
    requestFeasibility: {
      maxSentenceLength: sentenceLengths.reduce((max, length) => Math.max(max, length), 0),
      sentenceLengthLimit: SENTENCE_LENGTH_LIMIT,
      maxSentencesPerRequest: MAX_SENTENCES_PER_REQUEST,
      cloudSentencesPerRequest: CLOUD_SENTENCES_PER_REQUEST_FOR_CONTRACT,
    },
    session: input.sessionSnapshot?.(target) ?? {
      state: "stopped",
      registered: false,
      sentences: [],
    },
    page: { url, readyState: document.readyState },
    capturedAt: (input.now ?? (() => new Date()))().toISOString(),
  };
}

export interface DiagnosisReportOptions {
  model?: DiagnosisExplanation;
  modelError?: ExtensionError;
  profileModel?: string;
  extensionVersion?: string;
  generatedAt?: string;
}

export function formatDiagnosisReport(
  diagnosis: BlockDiagnosis,
  options: DiagnosisReportOptions = {},
): string {
  const firstFailing = diagnosis.gates.find(({ ok }) => !ok);
  const overview = firstFailing
    ? `第一个失败门是 \`${firstFailing.gate}\`${firstFailing.value === undefined ? "" : `（当时取值 ${firstFailing.value}）`}。`
    : diagnosis.session.sentences.some(({ phase }) => phase === "failed")
      ? "所有门均通过，但会话中存在失败句——问题在分析链路而非扫描门。"
      : "所有门均通过；该块应可解析。若页面无译文，请检查会话是否启动、视口是否触发。";
  // brief 原文把这段写成「模板套模板套模板」，收尾的连续反引号丢了一个（解析必炸）；
  // 提成变量保持输出逐字一致：`；exclusionReason=\`<reason>\``。
  const exclusion =
    diagnosis.inventory.exclusionReason === undefined
      ? ""
      : `；exclusionReason=\`${diagnosis.inventory.exclusionReason}\``;
  const lines: string[] = [
    "# 段落诊断报告",
    "",
    `## 概述`,
    overview,
    "",
    `## 页面与落点`,
    `- URL: ${diagnosis.page.url}`,
    `- 落点来源: ${diagnosis.targetSource}（选择器路径 \`${diagnosis.target.selectorPath}\`）`,
    `- 目标元素: \`${diagnosis.target.tagName}\` class=\`${diagnosis.target.className}\``,
    `- outerHTML（截断并脱敏）: \`${diagnosis.target.outerHtml}\``,
    `- document.readyState: ${diagnosis.page.readyState}`,
    ...(diagnosis.selectionText === undefined
      ? []
      : [`- 选中文本: ${diagnosis.selectionText.slice(0, 200)}`, ""]),
    `## 本地判定证据`,
    `- inventory: ${diagnosis.inventory.isUnit ? "是语义单元" : "不是语义单元"}；automatic=${diagnosis.inventory.automatic}${exclusion}`,
    `- 显式手势路径: ${diagnosis.explicit.resolvable ? "可解析" : "不可解析"}`,
    "",
    `| 门 | 结果 | 当时取值 |`,
    `| --- | --- | --- |`,
    ...diagnosis.gates.map(
      ({ gate, ok, value }) => `| ${gate} | ${ok ? "✅" : "❌"} | ${value ?? ""} |`,
    ),
    "",
    `## 分句与请求可行性`,
    `- 分句数: ${diagnosis.segmentation.sentenceCount}；token 数: ${diagnosis.segmentation.tokenCount}`,
    `- 最长句: ${diagnosis.requestFeasibility.maxSentenceLength} / 上限 ${diagnosis.requestFeasibility.sentenceLengthLimit}`,
    `- 单请求句数上限: loopback ${diagnosis.requestFeasibility.maxSentencesPerRequest} / 云端 ${diagnosis.requestFeasibility.cloudSentencesPerRequest}`,
    "",
    `## 会话状态`,
    `- state: ${diagnosis.session.state}；registered: ${diagnosis.session.registered}${diagnosis.session.blockId === undefined ? "" : `（blockId \`${diagnosis.session.blockId}\`）`}`,
    ...diagnosis.session.sentences.map(
      ({ text, phase, failureMessage }) =>
        `- [${phase}] ${text.slice(0, 80)}${failureMessage === undefined ? "" : ` — ${failureMessage}`}`,
    ),
    "",
    `## 模型解释`,
    options.model
      ? [
          `likelyCause: ${options.model.likelyCause}`,
          "",
          options.model.explanation,
          "",
          ...options.model.suggestions.map((item) => `- ${item}`),
        ].join("\n")
      : options.modelError
        ? `模型解释不可用：${options.modelError.code}：${options.modelError.message}`
        : "模型解释未返回（可能在途中）。",
    "",
    `## 环境`,
    `- 扩展版本: ${options.extensionVersion ?? "未知"}`,
    `- profile 模型: ${options.profileModel ?? "未返回 / 未配置"}`,
    `- 证据采集时间: ${diagnosis.capturedAt}；报告生成时间: ${options.generatedAt ?? "未知"}`,
  ];
  // 不做 filter：空行是小节分隔符，滤掉会让 markdown 渲染成一坨（评审 次要7）。
  return lines.join("\n").replace(/\n{3,}/gu, "\n\n") + "\n";
}
