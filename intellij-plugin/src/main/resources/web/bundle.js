var EnglishSyntaxPreview = (function(exports) {
	Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
	const MAX_CHAT_QUESTION_CHARACTERS = 2e3;
	const FORBIDDEN_KEYS = /* @__PURE__ */ new Set([
		"apiKey",
		"headers",
		"baseUrl"
	]);
	function isRecord(value) {
		return typeof value === "object" && value !== null && !Array.isArray(value);
	}
	function hasOnlyKeys(value, allowed) {
		return Object.keys(value).every((key) => allowed.includes(key));
	}
	function isNonEmptyString(value) {
		return typeof value === "string" && value.length > 0;
	}
	function isNonNegativeInt(value) {
		return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
	}
	const HOST_KEYS_BY_TYPE = {
		SESSION_STATE: [
			"version",
			"type",
			"previewId",
			"generation",
			"state",
			"ready",
			"discovered",
			"failed"
		],
		CORE_STREAM: [
			"version",
			"type",
			"previewId",
			"generation",
			"sentenceId",
			"blockId",
			"componentsJson",
			"tokensJson"
		],
		CORE_RESULT: [
			"version",
			"type",
			"previewId",
			"generation",
			"sentenceId",
			"blockId",
			"analysisJson",
			"tokensJson"
		],
		CORE_ERROR: [
			"version",
			"type",
			"previewId",
			"generation",
			"sentenceId",
			"blockId",
			"code",
			"message",
			"tokensJson"
		],
		DETAIL_STREAM: [
			"version",
			"type",
			"previewId",
			"generation",
			"sentenceId",
			"focusStart",
			"focusEnd",
			"structuresJson"
		],
		DETAIL_RESULT: [
			"version",
			"type",
			"previewId",
			"generation",
			"sentenceId",
			"analysisJson"
		],
		RESTORE_ALL: [
			"version",
			"type",
			"previewId",
			"generation"
		],
		CHAT_STREAM: [
			"version",
			"type",
			"previewId",
			"generation",
			"conversationId",
			"text"
		],
		CHAT_RESULT: [
			"version",
			"type",
			"previewId",
			"generation",
			"conversationId",
			"answer"
		],
		CHAT_ERROR: [
			"version",
			"type",
			"previewId",
			"generation",
			"conversationId",
			"message"
		]
	};
	/** Kotlin → JS 方向：同款白名单 + generation 复检。 */
	function parseHostMessage(value, currentGeneration) {
		if (!isRecord(value)) return null;
		if (Object.keys(value).some((key) => FORBIDDEN_KEYS.has(key))) return null;
		if (value.version !== 1) return null;
		if (!isNonEmptyString(value.previewId)) return null;
		if (!isNonNegativeInt(value.generation)) return null;
		if (value.generation !== currentGeneration) return null;
		const allowed = HOST_KEYS_BY_TYPE[value.type];
		if (!allowed || !hasOnlyKeys(value, allowed)) return null;
		switch (value.type) {
			case "SESSION_STATE":
				if (!isNonEmptyString(value.state)) return null;
				if (!isNonNegativeInt(value.ready) || !isNonNegativeInt(value.discovered)) return null;
				if (value.failed !== void 0 && !isNonNegativeInt(value.failed)) return null;
				return {
					version: 1,
					type: "SESSION_STATE",
					previewId: value.previewId,
					generation: value.generation,
					state: value.state,
					ready: value.ready,
					discovered: value.discovered,
					failed: value.failed ?? 0
				};
			case "CORE_STREAM":
			case "CORE_RESULT":
				if (!isNonEmptyString(value.sentenceId) || !isNonEmptyString(value.blockId)) return null;
				if (typeof value.tokensJson !== "string") return null;
				if (value.type === "CORE_STREAM") {
					if (typeof value.componentsJson !== "string") return null;
					return {
						version: 1,
						type: "CORE_STREAM",
						previewId: value.previewId,
						generation: value.generation,
						sentenceId: value.sentenceId,
						blockId: value.blockId,
						componentsJson: value.componentsJson,
						tokensJson: value.tokensJson
					};
				}
				if (typeof value.analysisJson !== "string") return null;
				return {
					version: 1,
					type: "CORE_RESULT",
					previewId: value.previewId,
					generation: value.generation,
					sentenceId: value.sentenceId,
					blockId: value.blockId,
					analysisJson: value.analysisJson,
					tokensJson: value.tokensJson
				};
			case "DETAIL_RESULT":
				if (!isNonEmptyString(value.sentenceId) || typeof value.analysisJson !== "string") return null;
				return {
					version: 1,
					type: "DETAIL_RESULT",
					previewId: value.previewId,
					generation: value.generation,
					sentenceId: value.sentenceId,
					analysisJson: value.analysisJson
				};
			case "DETAIL_STREAM":
				if (!isNonEmptyString(value.sentenceId) || typeof value.structuresJson !== "string") return null;
				if (!isNonNegativeInt(value.focusStart) || !isNonNegativeInt(value.focusEnd)) return null;
				if (value.focusEnd < value.focusStart) return null;
				return {
					version: 1,
					type: "DETAIL_STREAM",
					previewId: value.previewId,
					generation: value.generation,
					sentenceId: value.sentenceId,
					focusStart: value.focusStart,
					focusEnd: value.focusEnd,
					structuresJson: value.structuresJson
				};
			case "CORE_ERROR":
				if (!isNonEmptyString(value.sentenceId) || !isNonEmptyString(value.blockId) || !isNonEmptyString(value.code)) return null;
				if (typeof value.message !== "string" || typeof value.tokensJson !== "string") return null;
				return {
					version: 1,
					type: "CORE_ERROR",
					previewId: value.previewId,
					generation: value.generation,
					sentenceId: value.sentenceId,
					blockId: value.blockId,
					code: value.code,
					message: value.message,
					tokensJson: value.tokensJson
				};
			case "RESTORE_ALL": return {
				version: 1,
				type: "RESTORE_ALL",
				previewId: value.previewId,
				generation: value.generation
			};
			case "CHAT_STREAM":
				if (!isNonEmptyString(value.conversationId)) return null;
				if (typeof value.text !== "string") return null;
				return {
					version: 1,
					type: "CHAT_STREAM",
					previewId: value.previewId,
					generation: value.generation,
					conversationId: value.conversationId,
					text: value.text
				};
			case "CHAT_RESULT":
				if (!isNonEmptyString(value.conversationId)) return null;
				if (typeof value.answer !== "string") return null;
				return {
					version: 1,
					type: "CHAT_RESULT",
					previewId: value.previewId,
					generation: value.generation,
					conversationId: value.conversationId,
					answer: value.answer
				};
			case "CHAT_ERROR":
				if (!isNonEmptyString(value.conversationId)) return null;
				if (typeof value.message !== "string") return null;
				return {
					version: 1,
					type: "CHAT_ERROR",
					previewId: value.previewId,
					generation: value.generation,
					conversationId: value.conversationId,
					message: value.message
				};
			default: return null;
		}
	}
	//#endregion
	//#region src/main/resources/web/preview.ts
	const STANDARD_CANDIDATE_TAGS = /* @__PURE__ */ new Set([
		"H1",
		"H2",
		"H3",
		"H4",
		"H5",
		"H6",
		"P",
		"LI",
		"BLOCKQUOTE",
		"DT",
		"DD",
		"CAPTION",
		"TH",
		"TD",
		"FIGCAPTION"
	]);
	/**
	* 自动扫描的排除区：语义文档块（table/.footnotes/[role='doc-endnotes']）不再整体排除，
	* 改由标签、叶子块与父子去重决定；代码/数学/图表/交互控件/我方卡片仍排除。
	*/
	const AUTO_EXCLUDED_SELECTOR = "pre,code,.math,.katex,.mermaid,button,input,textarea,select,iframe,[contenteditable],[data-english-syntax-card]";
	/**
	* 显式手势（快捷键悬停解析）保持旧口径：表格与脚注仍拒绝（现有 cell→null 语义不变）。
	*/
	const EXCLUDED_SELECTOR = "pre,code,table,.math,.katex,.mermaid,.footnotes,[role='doc-endnotes'],button,input,textarea,select,iframe,[contenteditable],[data-english-syntax-card]";
	const BLOCK_ID_ATTRIBUTE = "data-english-syntax-block";
	const MIN_TEXT_LENGTH = 20;
	const ENGLISH_RATIO = .6;
	/** 短语义标签：标题/定义项/表格标题/表头有英文实词即可，不吃 20 字符门（英文占比仍要求）。 */
	const SHORT_SEMANTIC_TAGS = /* @__PURE__ */ new Set([
		"H1",
		"H2",
		"H3",
		"H4",
		"H5",
		"H6",
		"DT",
		"CAPTION",
		"TH"
	]);
	const BLOCK_SELECTOR_PREFIX = "english-syntax-block-";
	let nextBlockId = 0;
	let registeredElements = /* @__PURE__ */ new WeakSet();
	/** 清空已扫描注册表：用户手动重新点「开始」（初始化）时调用，
	*  让 rescan 能重新扫描并上报全部段（否则 WeakSet 防重扫描会让二次
	*  scanMarkdownBlocks 返回空，失败句永远无法重派——真机「失败后再点开始不动」）。 */
	function resetScanRegistry() {
		registeredElements = /* @__PURE__ */ new WeakSet();
	}
	/**
	* 取或分配 blockId。与 [scanMarkdownBlocks] 共用 `nextBlockId` 计数器——显式路径先给
	* 某元素分配过 id，之后自动扫描会沿用它，不会出现双 id。
	*/
	function ensureBlockId(element) {
		const existing = element.getAttribute(BLOCK_ID_ATTRIBUTE);
		if (existing !== null) return existing;
		const blockId = `${BLOCK_SELECTOR_PREFIX}${nextBlockId++}`;
		element.setAttribute(BLOCK_ID_ATTRIBUTE, blockId);
		return blockId;
	}
	/**
	* 悬停链选择器。
	*
	* `:is()` 不能省：quirks 模式（HTML 没有 doctype）下 Chromium 按 hover/active quirk
	* 只让链接匹配裸 `:hover`，`querySelectorAll(":hover")` 于是**整页恒为空集**，按快捷键
	* 只会得到「未找到可解析的段落」。该 quirk 只在「复合选择器里除伪类之外别无他物」时生效，
	* 塞进 `:is()` 就落进子选择器语境、不再适用（实测同一 quirks 页面：`:hover` → 空，
	* `:is(:hover)` → `html > body > main > p#safe`）；标准模式下两者结果恒等。
	*
	* 预览页 HTML 由 IDEA 生成，doctype 有无不由我们说了算，所以不赌它是标准模式。
	* Chrome 端同一判据在 `chrome-plugin/src/content/hover-target.ts`。
	*/
	const HOVER_CHAIN_SELECTOR = ":is(:hover)";
	/** 悬停链的最深元素。happy-dom 等环境不实现该伪类，查询可能抛错，兜住返回 null。 */
	function deepestHovered(doc) {
		let chain = null;
		try {
			chain = doc.querySelectorAll(HOVER_CHAIN_SELECTOR);
		} catch {
			chain = null;
		}
		if (chain === null || chain.length === 0) return null;
		return chain[chain.length - 1] ?? null;
	}
	/**
	* 显式手势（快捷键悬停解析）的块定位：从悬停元素逐级向上找最近的可解析块。
	*
	* **刻意不套用自动扫描的取舍**：不要求 20 字符、不要求英文占比、不限定候选标签。
	* `scanMarkdownBlocks` 要在整篇里躲开边栏与样板文字，这里只服务用户指到的那一处——
	* 套用后的症状是「鼠标明明停在段落上，快捷键却报『未找到可解析的段落』」（短段落、
	* 术语行、中英混排行全中招）。保留的判据只有四条：排除区、渲染盒子、叶子块、文本非空。
	*
	* 按渲染盒子而非标签名认块：Mintlify 一类文档站整篇正文都是 `<span>`，只按标签名
	* 认块会把这类站点整页判成「未找到」。只认叶子块，否则往上会撞到包着整篇正文的容器。
	*/
	function nearestPreviewBlock(target) {
		const start = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
		if (start === null) return null;
		if (start.closest("input,textarea,[contenteditable]") !== null) return null;
		for (let current = start; current !== null; current = current.parentElement) {
			if (!(current instanceof HTMLElement)) continue;
			if (isExcluded(current)) continue;
			if (!isRendered(current) && !isHyphenatedCustomElement(current)) continue;
			if (!isLeafBlock(current)) continue;
			if ((current.textContent ?? "").trim().length === 0) continue;
			return current;
		}
		return null;
	}
	function isExcluded(element) {
		return element.closest(EXCLUDED_SELECTOR) !== null;
	}
	/** 自动扫描专用排除：表格/脚注不再整体排除，其余与显式路径一致。 */
	function isAutoExcluded(element) {
		return element.closest(AUTO_EXCLUDED_SELECTOR) !== null;
	}
	function isHyphenatedCustomElement(element) {
		return element.localName.includes("-");
	}
	function isRendered(element) {
		const display = element.ownerDocument.defaultView?.getComputedStyle(element).display ?? "";
		return display !== "" && !/^inline($|-)/.test(display);
	}
	function isLeafBlock(element) {
		return !Array.from(element.children).some((child) => isRendered(child));
	}
	function englishRatio(text) {
		const words = text.match(/[\p{L}\p{N}]+/gu) ?? [];
		if (words.length === 0) return 0;
		return words.filter((word) => /^[A-Za-z]/.test(word)).length / words.length;
	}
	/** 收集一个候选的安全叶子块；blockquote 递归取其内部叶子。 */
	function collectCandidates(element, into) {
		if (isAutoExcluded(element)) return;
		if (element.tagName === "BLOCKQUOTE") {
			for (const child of element.querySelectorAll("p,li")) collectCandidates(child, into);
			return;
		}
		if (!isLeafBlock(element)) return;
		const text = (element.textContent ?? "").trim();
		if (!SHORT_SEMANTIC_TAGS.has(element.tagName) && text.length < MIN_TEXT_LENGTH) return;
		if (englishRatio(text) < ENGLISH_RATIO) return;
		into.push(element);
	}
	function scanMarkdownBlocks(root) {
		const elements = [];
		for (const element of root.querySelectorAll("*")) {
			if (!STANDARD_CANDIDATE_TAGS.has(element.tagName) && !isHyphenatedCustomElement(element)) continue;
			collectCandidates(element, elements);
		}
		return elements.filter((element) => !registeredElements.has(element) && !element.hasAttribute("data-english-syntax-hidden")).map((element) => {
			registeredElements.add(element);
			return {
				blockId: ensureBlockId(element),
				element,
				text: (element.textContent ?? "").trim()
			};
		});
	}
	//#endregion
	//#region src/main/resources/web/roles.ts
	/**
	* 语法角色 → 颜色 / 中文标签。与 Chrome 端 `learning-block.ts` / `grammar.ts`
	* 逐值对齐——两端视觉必须一致，改任何一边都要同步另一边。
	*/
	const ROLE_COLORS = {
		SUBJECT: "#2563eb",
		PREDICATE: "#dc2626",
		OBJECT: "#059669",
		PREDICATIVE: "#0891b2",
		ATTRIBUTE: "#7c3aed",
		ADVERBIAL: "#d97706",
		COMPLEMENT: "#be185d",
		APPOSITIVE: "#6b7280",
		FRAGMENT_HEAD: "#0284c7",
		SUBJECT_CLAUSE: "#2563eb",
		OBJECT_CLAUSE: "#059669",
		PREDICATIVE_CLAUSE: "#0891b2",
		ATTRIBUTIVE_CLAUSE: "#7c3aed",
		ADVERBIAL_CLAUSE: "#d97706",
		INDEPENDENT_ELEMENT: "#6b7280",
		COORDINATE_CLAUSE: "#0d9488",
		CONJUNCTION: "#6b7280"
	};
	/**
	* IDEA 深色主题下的提亮色板：保持各角色色相，但提高明度，保证深色背景可读。
	* 只影响 IDEA 端（由 Kotlin 检测 JBColor.isBright() 注入是否深色）；
	* 浅色主题仍走 ROLE_COLORS 与 Chrome 端逐值一致。
	*/
	const ROLE_COLORS_DARK = {
		SUBJECT: "#60a5fa",
		PREDICATE: "#f87171",
		OBJECT: "#34d399",
		PREDICATIVE: "#22d3ee",
		ATTRIBUTE: "#a78bfa",
		ADVERBIAL: "#fbbf24",
		COMPLEMENT: "#f472b6",
		APPOSITIVE: "#9ca3af",
		FRAGMENT_HEAD: "#38bdf8",
		SUBJECT_CLAUSE: "#60a5fa",
		OBJECT_CLAUSE: "#34d399",
		PREDICATIVE_CLAUSE: "#22d3ee",
		ATTRIBUTIVE_CLAUSE: "#a78bfa",
		ADVERBIAL_CLAUSE: "#fbbf24",
		INDEPENDENT_ELEMENT: "#9ca3af",
		COORDINATE_CLAUSE: "#2dd4bf",
		CONJUNCTION: "#9ca3af"
	};
	const GRAMMAR_LABELS = {
		SUBJECT: "主语",
		PREDICATE: "谓语",
		OBJECT: "宾语",
		PREDICATIVE: "表语",
		ATTRIBUTE: "定语",
		ADVERBIAL: "状语",
		COMPLEMENT: "补语",
		APPOSITIVE: "同位语",
		FRAGMENT_HEAD: "片段主体",
		SUBJECT_CLAUSE: "主语从句",
		OBJECT_CLAUSE: "宾语从句",
		PREDICATIVE_CLAUSE: "表语从句",
		ATTRIBUTIVE_CLAUSE: "定语从句",
		ADVERBIAL_CLAUSE: "状语从句",
		INDEPENDENT_ELEMENT: "独立成分",
		COORDINATE_CLAUSE: "并列分句",
		CONJUNCTION: "并列连词"
	};
	const FALLBACK_COLOR = "#6b7280";
	const FALLBACK_COLOR_DARK = "#9ca3af";
	/** IDEA 深色主题开关：由 Kotlin 检测 JBColor.isBright() 后经 bootstrap 设置。默认浅色。 */
	let darkMode = false;
	/** 供 bootstrap / 主题监听设置深色模式；浅色模式恢复与 Chrome 端一致的默认色。 */
	function setDarkMode(dark) {
		darkMode = dark;
	}
	/** core 成分：role 是英文枚举；渲染标签用中文，颜色按枚举查。 */
	function roleLabel(role) {
		return GRAMMAR_LABELS[role] ?? role;
	}
	function paletteFor(dark) {
		return dark ? ROLE_COLORS_DARK : ROLE_COLORS;
	}
	function roleColor(role) {
		return paletteFor(darkMode)[role] ?? (darkMode ? FALLBACK_COLOR_DARK : FALLBACK_COLOR);
	}
	/**
	* 详解 structure 的 role 是模型自由文本：优先中文标签精确匹配，若为已知
	* 英文枚举则映射后查色，否则灰色。与 Chrome 端 structureColor 同构。
	*/
	function structureColor(role) {
		const palette = paletteFor(darkMode);
		const byLabel = Object.entries(GRAMMAR_LABELS).find(([, label]) => label === role);
		if (byLabel !== void 0) return palette[byLabel[0]] ?? (darkMode ? FALLBACK_COLOR_DARK : FALLBACK_COLOR);
		return palette[role] ?? (darkMode ? FALLBACK_COLOR_DARK : FALLBACK_COLOR);
	}
	/** Chrome 端同款圈号：1-20 用 ①…，超出退回普通数字。 */
	function circledNumber(value) {
		return value >= 1 && value <= 20 ? String.fromCodePoint(9312 + value - 1) : `${value}`;
	}
	//#endregion
	//#region src/main/resources/web/render.ts
	const HIDDEN_ATTRIBUTE = "data-english-syntax-hidden";
	const CARD_TAG = "div";
	const CARD_ATTRIBUTE = "data-english-syntax-card";
	/**
	* 句子在卡片里的排列顺序 = 原文出现顺序（源序），而不是消息到达顺序。
	* sentenceId 由 Kotlin 权威生成，形如 `s-{blockId}-{index}`，index（最后一个连字符之后
	* 的数字）就是该句在块内的源序下标。流式分片按模型输出到达，可能先吐后半句——
	* #blockSentenceOrder 若按到达顺序累积，final 卡片就会照此错排（英文和原文对不上）。
	* 渲染前按 index 数值升序重排，无论分片/结果乱序与否都恢复源序（chrome 端
	* setExpectedSentenceIds 同语义，这里直接从 sentenceId 推断，无需宿主额外传序）。
	*/
	function bySourceOrder(sentenceIdA, sentenceIdB) {
		const indexOf = (id) => {
			const match = /(\d+)$/.exec(id);
			return match === null ? Number.MAX_SAFE_INTEGER : Number(match[1]);
		};
		return indexOf(sentenceIdA) - indexOf(sentenceIdB);
	}
	/**
	* 句头追问按钮派发的 DOM 事件名（冒泡 + composed；bootstrap-entry 在 document 级接住，
	* 是 retry 按钮同级的事件委托先例）。点击**不发** CHAT_ASK——那时还没有合法 question。
	*/
	const CHAT_ASK_REQUEST_EVENT = "english-syntax-chat-request";
	/**
	* 句头追问入口的聊天气泡图标（描边 + 三个点，输入指示语义）。内联 SVG、currentColor
	* 描边——跟随句子文字颜色，明暗主题零适配；aria-hidden 让屏幕阅读器只念按钮的
	* aria-label「追问这句」（Chrome 端 CHAT_ASK_ICON 同款）。
	*/
	const CHAT_ASK_ICON = "<svg viewBox=\"0 0 16 16\" width=\"14\" height=\"14\" aria-hidden=\"true\" focusable=\"false\"><path d=\"M2.5 3h11a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H8.4l-3.2 2.6a.5.5 0 0 1-.8-.4V11h-1.9a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.4\" stroke-linejoin=\"round\"/><circle cx=\"5.4\" cy=\"7\" r=\"0.95\" fill=\"currentColor\"/><circle cx=\"8\" cy=\"7\" r=\"0.95\" fill=\"currentColor\"/><circle cx=\"10.6\" cy=\"7\" r=\"0.95\" fill=\"currentColor\"/></svg>";
	const WIDE_TRANSLATION_MIN_CHARS = 17;
	function isEchoTranslation(translation, english) {
		const normalize = (value) => value.toLowerCase().replace(/\s+/gu, " ").trim();
		return normalize(translation) === normalize(english);
	}
	const ERROR_TEXT = {
		AUTH_FAILED: "模型配置鉴权失败，请检查 API Key 或账户状态",
		MODEL_NOT_FOUND: "找不到配置的模型，请检查模型名/服务地址",
		RATE_LIMITED: "模型服务限流，请稍后重试",
		NETWORK_ERROR: "模型请求失败，请检查网络或模型地址",
		REQUEST_TIMEOUT: "模型请求超时",
		INVALID_MODEL_OUTPUT: "模型返回结果无法解析",
		SENTENCE_TOO_LONG: "句子过长，超出单次解析长度上限",
		REQUEST_CANCELLED: "请求已取消",
		CONFIG_MISSING: "尚未配置可用的模型",
		DETAIL_FAILED: "详解解析失败"
	};
	function friendlyErrorMessage(code, fallback) {
		return ERROR_TEXT[code] ?? `${code}：${fallback}`;
	}
	function createElement(owner, name, className, text) {
		const element = owner.createElement(name);
		if (className !== void 0) element.className = className;
		if (text !== void 0) element.textContent = text;
		return element;
	}
	function translationElement(owner, className, text) {
		const element = createElement(owner, "span", className, text);
		if ([...text].length >= WIDE_TRANSLATION_MIN_CHARS) element.classList.add("english-syntax-translation-wide");
		return element;
	}
	var PreviewRenderer = class {
		#blocks = /* @__PURE__ */ new Map();
		#sentences = /* @__PURE__ */ new Map();
		#blockSentenceOrder = /* @__PURE__ */ new Map();
		#currentDetail = null;
		#onDetailRequest;
		constructor(onDetailRequest) {
			this.#onDetailRequest = onDetailRequest;
		}
		/**
		* 注册（或重新注册）一个块。**重新注册必须连旧句子一起丢掉**：`#sentences` 是
		* 全局映射，`#blocks` 里换了新 BlockRecord 而它还留着旧条目时，`#ensureSentence`
		* 会因「这句已存在」提前返回，新记录的 `sentences` 永远拿不到这一句——`#repaintBlock`
		* 于是算出 `hasContent=false` 并走 `#restoreBlock`，卡片一张都画不出来。
		*
		* 「停止并恢复原文 → 再点开始」正是这条路径：`initialize` 清空防重扫描注册表后
		* 重扫同一批元素，blockId 由元素上的 `data-english-syntax-block` 属性沿用，
		* sentenceId（`s-{blockId}-{index}`）也照旧复用，于是新旧条目精确相撞。
		* （官方 updateDom 重渲染不会撞：整个 body 被换掉，blockId 全部重新分配。）
		*/
		registerBlock(blockId, element) {
			const previous = this.#blocks.get(blockId);
			if (previous !== void 0) for (const sentenceId of previous.sentences.keys()) this.#sentences.delete(sentenceId);
			this.#blocks.set(blockId, {
				blockId,
				element,
				card: null,
				sentences: /* @__PURE__ */ new Map()
			});
			this.#blockSentenceOrder.set(blockId, []);
		}
		/** 宿主消息统一入口：旧 generation 已由 bridge 层过滤，这里按类型分发。 */
		handleHostMessage(message) {
			switch (message.type) {
				case "CORE_STREAM":
					this.renderCoreStream(message.sentenceId, message.blockId, JSON.parse(message.componentsJson), JSON.parse(message.tokensJson ?? "[]"));
					break;
				case "CORE_RESULT":
					this.renderCoreResult(message.sentenceId, message.blockId, JSON.parse(message.analysisJson), JSON.parse(message.tokensJson ?? "[]"));
					break;
				case "CORE_ERROR":
					this.renderCoreError(message.sentenceId, message.blockId, message.code, message.message, JSON.parse(message.tokensJson));
					break;
				case "DETAIL_STREAM":
				case "DETAIL_RESULT": {
					const payload = JSON.parse(message.type === "DETAIL_RESULT" ? message.analysisJson : message.structuresJson);
					if (message.type === "DETAIL_RESULT") this.renderDetailResult(payload);
					else this.renderDetailStream(message.sentenceId, message.focusStart, message.focusEnd, payload);
					break;
				}
				case "RESTORE_ALL": this.restoreAll();
			}
		}
		renderCoreStream(sentenceId, blockId, components, tokens = []) {
			this.#ensureSentence(blockId, sentenceId);
			const entry = this.#sentences.get(sentenceId);
			if (entry === void 0) return;
			entry.record.provisional = components;
			if (tokens.length > 0) entry.record.tokens = tokens;
			const order = this.#blockSentenceOrder.get(entry.blockId) ?? [];
			if (!order.includes(sentenceId)) order.push(sentenceId);
			this.#blockSentenceOrder.set(entry.blockId, order);
			this.#repaintBlock(entry.blockId);
		}
		renderCoreResult(sentenceId, blockId, analysis, tokens = []) {
			this.#ensureSentence(blockId, sentenceId);
			const entry = this.#sentences.get(sentenceId);
			if (entry === void 0) return;
			entry.record.analysis = analysis;
			if (tokens.length > 0) entry.record.tokens = tokens;
			entry.record.provisional = null;
			entry.record.failed = false;
			this.#sentences.set(sentenceId, entry);
			const order = this.#blockSentenceOrder.get(entry.blockId) ?? [];
			if (!order.includes(sentenceId)) order.push(sentenceId);
			this.#blockSentenceOrder.set(entry.blockId, order);
			this.#repaintBlock(entry.blockId);
		}
		renderCoreError(sentenceId, blockId, code, message, tokens = []) {
			this.#ensureSentence(blockId, sentenceId);
			const entry = this.#sentences.get(sentenceId);
			if (entry === void 0) return;
			entry.record.failed = true;
			entry.record.analysis = null;
			entry.record.provisional = null;
			if (tokens.length > 0) entry.record.tokens = tokens;
			const order = this.#blockSentenceOrder.get(entry.blockId) ?? [];
			if (!order.includes(sentenceId)) order.push(sentenceId);
			this.#blockSentenceOrder.set(entry.blockId, order);
			this.#repaintBlock(entry.blockId, {
				errorSentenceId: sentenceId,
				message: friendlyErrorMessage(code, message)
			});
		}
		/**
		* 惰性注册句子：sentenceId 由 Kotlin 侧权威生成（s-{blockId}-{index}），
		* JS 端不做分句，CORE_* 消息首次到达时按消息里的 blockId 注册即可渲染。
		* 若 blockId 尚未 registerBlock（极端乱序），则忽略——下一轮 VISIBLE_BLOCKS 会补上。
		*/
		#ensureSentence(blockId, sentenceId) {
			if (this.#sentences.has(sentenceId)) return;
			const record = this.#blocks.get(blockId);
			if (record === void 0) return;
			record.sentences.set(sentenceId, {
				analysis: null,
				provisional: null,
				tokens: [],
				failed: false
			});
			this.#sentences.set(sentenceId, {
				blockId,
				record: record.sentences.get(sentenceId)
			});
		}
		renderDetailStream(sentenceId, focusStart, focusEnd, structures) {
			this.#showDetailPanel(sentenceId, structures, focusStart, focusEnd);
		}
		renderDetailResult(detail) {
			this.#showDetailPanel(detail.sentenceId, detail.structures, detail.focus.startToken, detail.focus.endToken, detail);
		}
		requestDetail(sentenceId, focusStart, focusEnd) {
			this.#onDetailRequest(sentenceId, focusStart, focusEnd);
		}
		/**
		* 点击成分后立即显示「加载中」占位面板（不等模型返回）。
		* 占位一出生就走 #anchorDetail 的行判定,和模型返回后那次落位用的是同一套规则——
		* 曾经占位图省事插在句尾(`sentence.after`),详解回来才精确锚定,于是面板先出现在整句
		* 之后、内容到了又跳到被点成分那一行,回归过一次的老毛病就是这个。
		*/
		#showDetailLoading(sentenceId, focusStart, focusEnd) {
			const entry = this.#sentences.get(sentenceId);
			if (entry == null) return;
			this.#closeAllDetailPanels();
			this.#currentDetail = {
				sentenceId,
				focusStart,
				focusEnd
			};
			const card = this.#blocks.get(entry.blockId)?.card;
			if (card == null) return;
			const sentence = card.querySelector(`.english-syntax-sentence[data-sentence-id="${sentenceId}"]`);
			if (sentence == null) return;
			const panel = createElement(sentence.ownerDocument, "div", "english-syntax-detail english-syntax-detail-loading");
			panel.dataset.sentenceId = sentenceId;
			panel.textContent = "正在加载详解…";
			this.#anchorDetail(sentence, panel, focusStart, focusEnd);
		}
		#showDetailPanel(sentenceId, structures, focusStart, focusEnd, detail) {
			const entry = this.#sentences.get(sentenceId);
			if (entry == null) return;
			this.#closeAllDetailPanels();
			this.#currentDetail = {
				sentenceId,
				focusStart: focusStart ?? detail?.focus.startToken ?? 0,
				focusEnd: focusEnd ?? detail?.focus.endToken ?? 0
			};
			this.#repaintBlock(entry.blockId, {
				detailStructures: structures,
				detail
			});
		}
		/** 关闭预览页里所有已打开的详解面板（含加载占位）,并摘掉句子上的块级标记。 */
		#closeAllDetailPanels() {
			for (const panel of document.querySelectorAll(".english-syntax-detail")) panel.remove();
			for (const marked of document.querySelectorAll(".english-syntax-has-detail")) marked.classList.remove("english-syntax-has-detail");
		}
		closeDetail() {
			if (this.#currentDetail === null) return;
			const entry = this.#sentences.get(this.#currentDetail.sentenceId);
			this.#currentDetail = null;
			if (entry != null) this.#repaintBlock(entry.blockId);
		}
		#repaintBlock(blockId, options = {}) {
			const record = this.#blocks.get(blockId);
			if (record === void 0) return;
			const order = (this.#blockSentenceOrder.get(blockId) ?? []).slice().sort(bySourceOrder);
			if (!order.some((id) => {
				const sentence = record.sentences.get(id);
				return sentence !== void 0 && (sentence.analysis !== null || sentence.provisional !== null);
			}) && options.errorSentenceId === void 0 && options.detailStructures === void 0) {
				this.#restoreBlock(record);
				return;
			}
			if (record.card === null) {
				record.card = record.element.ownerDocument.createElement(CARD_TAG);
				record.card.setAttribute(CARD_ATTRIBUTE, "true");
				record.element.after(record.card);
			}
			record.element.setAttribute(HIDDEN_ATTRIBUTE, "true");
			this.#renderCard(record, order, options);
		}
		#renderCard(record, order, options) {
			const card = record.card;
			const owner = record.element.ownerDocument;
			card.replaceChildren();
			const container = createElement(owner, "div", "english-syntax-sentences");
			for (const sentenceId of order) {
				const sentence = record.sentences.get(sentenceId);
				if (sentence === void 0) continue;
				const section = createElement(owner, "section", "english-syntax-sentence");
				section.dataset.sentenceId = sentenceId;
				const components = sentence.analysis?.components ?? sentence.provisional ?? [];
				if (sentenceId === options.errorSentenceId) {
					const failure = createElement(owner, "div", "english-syntax-sentence-failure");
					failure.append(createElement(owner, "span", "english-syntax-original", this.#originalText(sentenceId)), createElement(owner, "span", "english-syntax-error", options.message ?? "解析失败"));
					failure.append(this.#createRetry(owner, sentenceId));
					container.append(failure);
					continue;
				}
				if (sentence.analysis !== null && components.length > 0) section.append(this.#createChatAsk(owner, sentenceId));
				const coordinateClauseTotal = components.filter((component) => component.role === "COORDINATE_CLAUSE").length;
				let coordinateClauseIndex = 0;
				let nextToken = 0;
				let lastEnglish = null;
				for (const component of components) {
					this.#appendPunctuation(lastEnglish ?? section, sentence.tokens, nextToken, component.startToken - 1);
					let label = roleLabel(component.role);
					if (component.role === "COORDINATE_CLAUSE" && coordinateClauseTotal >= 2) {
						coordinateClauseIndex += 1;
						label = `${label}${circledNumber(coordinateClauseIndex)}`;
					}
					const button = createElement(owner, "button", "english-syntax-component");
					button.type = "button";
					button.dataset.startToken = String(component.startToken);
					button.dataset.endToken = String(component.endToken);
					button.style.setProperty("--english-syntax-role-color", roleColor(component.role));
					const role = createElement(owner, "span", "english-syntax-role", label);
					const english = createElement(owner, "span", "english-syntax-english");
					english.textContent = component.text ?? "";
					button.append(role, english);
					if (!isEchoTranslation(component.translation, english.textContent ?? "")) button.append(translationElement(owner, "english-syntax-translation", component.translation));
					button.style.setProperty("cursor", "pointer", "important");
					for (const child of button.querySelectorAll("*")) child.style.setProperty("cursor", "pointer", "important");
					button.addEventListener("click", () => {
						if (this.#currentDetail?.sentenceId === sentenceId) {
							this.closeDetail();
							return;
						}
						this.#showDetailLoading(sentenceId, component.startToken, component.endToken);
						this.requestDetail(sentenceId, component.startToken, component.endToken);
					});
					section.append(button);
					lastEnglish = english;
					nextToken = component.endToken + 1;
				}
				this.#appendPunctuation(lastEnglish ?? section, sentence.tokens, nextToken, sentence.tokens.length - 1);
				if (sentence.analysis === null && sentence.provisional !== null) section.classList.add("english-syntax-provisional");
				container.append(section);
			}
			card.append(container);
			if (this.#currentDetail !== null && (options.detailStructures !== void 0 || options.detail !== void 0)) this.#placeDetailPanel(card, options.detailStructures ?? options.detail?.structures ?? [], options.detail);
		}
		/**
		* 详解面板落位:模型返回后整卡重建，把面板按行判定放回被点成分那一行下面。
		*/
		#placeDetailPanel(card, structures, detail) {
			const current = this.#currentDetail;
			if (current === null) return;
			const sentence = card.querySelector(`.english-syntax-sentence[data-sentence-id="${current.sentenceId}"]`);
			if (sentence === null) return;
			const panel = this.#renderDetailPanel(sentence.ownerDocument, structures, detail);
			this.#anchorDetail(sentence, panel, current.focusStart, current.focusEnd);
		}
		/**
		* 详解面板行锚定（与 Chrome 端 `learning-block.ts#setDetailLoading` 同一套判定）:
		* 面板落在**被点成分所在视觉行**的正下方,两种插法取决于那一行是不是整句最后一行:
		*  * 不是最后一行（长句折行）:插在句内、该行最后一个成分之后。这种句子已经占满栏宽、
		*    不可能与别的句子共行,所以让它变块级(english-syntax-has-detail)没有视觉代价。
		*  * 是最后一行:插到句外、**该视觉行最后一句之后**。短句常与邻句共行,只插在被点句正
		*    后方会把同行的邻句压到面板下面;这一支也绝不能加块级类,否则被点句自己撑满整行,
		*    同样把邻居挤走——两者的表现都是用户看到的「本来一行,点一下变两行」。
		* 行判定依赖真实布局,零尺寸环境（单测）退化为插在句子之后。
		*/
		#anchorDetail(sentence, panel, focusStart, focusEnd) {
			const component = sentence.querySelector(`.english-syntax-component[data-start-token="${focusStart}"][data-end-token="${focusEnd}"]`);
			const clickedRect = component?.getBoundingClientRect();
			const hasComponentBelow = clickedRect !== void 0 && clickedRect.height > 0 && [...sentence.querySelectorAll(".english-syntax-component")].some((other) => other.getBoundingClientRect().top >= clickedRect.bottom);
			if (component !== null && hasComponentBelow) {
				const clickedBottom = clickedRect.bottom;
				let anchor = component;
				for (let next = anchor.nextElementSibling; next !== null; next = next.nextElementSibling) {
					if (next.getBoundingClientRect().top >= clickedBottom) break;
					anchor = next;
				}
				sentence.classList.add("english-syntax-has-detail");
				anchor.after(panel);
				return;
			}
			sentence.classList.remove("english-syntax-has-detail");
			const sentenceBottom = sentence.getBoundingClientRect().bottom;
			let anchor = sentence;
			for (let next = anchor.nextElementSibling; next !== null; next = next.nextElementSibling) {
				if (!next.classList.contains("english-syntax-sentence")) break;
				if (next.getBoundingClientRect().top >= sentenceBottom) break;
				anchor = next;
			}
			anchor.after(panel);
		}
		/** 详解面板：标注行（①角色 + 英文摘录）+ 解释列表 + 语法点 + 整体说明。 */
		#renderDetailPanel(owner, structures, detail) {
			const panel = createElement(owner, "div", "english-syntax-detail");
			const annotations = createElement(owner, "div", "english-syntax-detail-annotations");
			for (const [index, structure] of structures.entries()) {
				const label = `${circledNumber(index + 1)} ${structure.role}`;
				const annotation = createElement(owner, "span", "english-syntax-annotation");
				annotation.style.setProperty("--english-syntax-role-color", structureColor(structure.role));
				annotation.append(createElement(owner, "span", "english-syntax-annotation-role", label), createElement(owner, "span", "english-syntax-annotation-english", this.#structureText(structure)));
				if (structure.translation !== void 0 && structure.translation.trim().length > 0) annotation.append(translationElement(owner, "english-syntax-annotation-translation", structure.translation));
				annotations.append(annotation);
			}
			panel.append(annotations);
			for (const [index, structure] of structures.entries()) {
				const row = createElement(owner, "div", "english-syntax-detail-structure");
				const strong = createElement(owner, "strong", "english-syntax-detail-role");
				strong.textContent = `${circledNumber(index + 1)} ${structure.role}`;
				row.append(strong, owner.createTextNode("："), createElement(owner, "span", "english-syntax-detail-explanation", structure.explanation));
				panel.append(row);
			}
			if (detail?.grammarPoints?.length) panel.append(createElement(owner, "div", "english-syntax-grammar-points", detail.grammarPoints.join("、")));
			if (detail?.explanation) panel.append(createElement(owner, "div", "english-syntax-detail-summary", detail.explanation));
			return panel;
		}
		#createRetry(owner, sentenceId) {
			const retry = createElement(owner, "button", "english-syntax-retry", "重新解析");
			retry.type = "button";
			retry.dataset.sentenceId = sentenceId;
			retry.dataset.englishSyntaxRetry = "";
			retry.addEventListener("click", () => {
				if (retry.disabled) return;
				retry.disabled = true;
				retry.textContent = "解析中…";
			});
			return retry;
		}
		/**
		* 句头追问入口按钮（Chrome 端 #createChatAsk 同款）：无文字的聊天气泡图标，点击派发
		* CHAT_ASK_REQUEST_EVENT（冒泡 + composed）。锚点取真实点击坐标；键盘激活的 click
		* 坐标是 0，回落到按钮 rect 右下角。注意这里**不发**任何桥消息——开面板是 bootstrap
		* 侧回调的事，CHAT_ASK 要等面板 submit 才由合法 question 驱动。
		*/
		#createChatAsk(owner, sentenceId) {
			const ask = createElement(owner, "button", "english-syntax-chat-ask");
			ask.type = "button";
			ask.setAttribute("aria-label", "追问这句");
			ask.title = "追问这句";
			ask.innerHTML = CHAT_ASK_ICON;
			ask.style.setProperty("cursor", "pointer", "important");
			ask.addEventListener("click", (event) => {
				const rect = ask.getBoundingClientRect();
				const detail = {
					sentenceId,
					anchor: {
						x: event.clientX || rect.right,
						y: event.clientY || rect.bottom
					}
				};
				ask.dispatchEvent(new CustomEvent(CHAT_ASK_REQUEST_EVENT, {
					bubbles: true,
					composed: true,
					detail
				}));
			});
			return ask;
		}
		#originalText(sentenceId) {
			return (this.#sentences.get(sentenceId)?.record.tokens ?? []).map(({ leadingWhitespace, text }) => leadingWhitespace + text).join("");
		}
		#structureText(structure) {
			return typeof structure.text === "string" ? structure.text : "";
		}
		#appendPunctuation(target, tokens, startToken, endToken) {
			for (let index = startToken; index <= endToken; index += 1) {
				const token = tokens[index];
				if (token?.punctuation === true) target.append(createElement(target.ownerDocument, "span", "english-syntax-punctuation", token.leadingWhitespace + token.text));
			}
		}
		#restoreBlock(record) {
			record.element.removeAttribute(HIDDEN_ATTRIBUTE);
			record.card?.remove();
			record.card = null;
		}
		/**
		* 当前呈现元素：已替换为卡片时是卡片，否则是原文块。解析中标记打在它上面，
		* 流式换卡片后标记跟着走（Chrome 端 BlockReplacement.currentElement 同款语义）。
		*/
		currentElement(blockId) {
			const record = this.#blocks.get(blockId);
			if (record === void 0) return null;
			return record.card ?? record.element;
		}
		/** 供 bootstrap 在 VISIBLE_BLOCKS 后对可见块打「解析中」标记。 */
		markActive(blockId) {
			return this.currentElement(blockId);
		}
		/**
		* 句子原文（按 token 的 leadingWhitespace + text 重建,失败句原文行同口径）。
		* 供 bootstrap 在追问面板 open 时取锚定句摘要;未注册句返回空串。
		*/
		sentenceText(sentenceId) {
			return this.#originalText(sentenceId);
		}
		restoreAll() {
			for (const record of this.#blocks.values()) this.#restoreBlock(record);
		}
		/** 测试辅助：注册句子（生产路径由会话层把分词结果喂进来）。 */
		registerSentence(blockId, sentenceId) {
			const record = this.#blocks.get(blockId);
			if (record === void 0) return;
			record.sentences.set(sentenceId, {
				analysis: null,
				provisional: null,
				tokens: [],
				failed: false
			});
			this.#sentences.set(sentenceId, {
				blockId,
				record: record.sentences.get(sentenceId)
			});
		}
		/** 测试辅助：确认某句是否已被替换渲染。 */
		isSentenceRendered(sentenceId) {
			const entry = this.#sentences.get(sentenceId);
			return entry?.record.analysis !== null && entry?.record.analysis !== void 0;
		}
	};
	//#endregion
	//#region src/main/resources/web/chat-panel.ts
	/**
	* 追问对话浮层（Chrome 端 content/chat-panel.ts 平移,DOM/样式适配预览页体系）。
	*
	* 预览页是非 Shadow DOM 环境:类名带 english-syntax- 前缀、视觉规则全部活在
	* preview.css（Kotlin 单独注入,不进 bundle）；host 挂 `document.documentElement`
	* ——官方 Markdown 预览的 updateDom 重写整个 body,挂 body 的浮层会随之消失。
	*
	* 会话状态 = { conversationId, 锚定句摘要, history };conversationId 由 bootstrap
	* 在图标点击时铸好经 open 传入（Task 4 评审钉死的 seam）,所有 assistant 侧方法按
	* 它把关:换句 open 重置会话后,旧会话的迟到流/结果直接丢弃。回答气泡纯文本 +
	* pre-wrap（不引 markdown）,`renderStreamedText` 按「截至目前完整回答」的推送形状
	* **全量替换**当前气泡（调度器静默重试后重画同一段文本,天然无害）。
	*/
	/**
	* 拖动钳制边界:不依赖布局就能算的「至少留一个可抓取的角」——left/top 各自
	* 距视口边 ≥8px,且 left ≤ innerWidth-120 / top ≤ innerHeight-80（面板宽 400、
	* 高 560 以内,保证标题栏总有一截在视口里,拖丢了也拽得回来）。
	*/
	const DRAG_MARGIN = 8;
	const DRAG_MAX_LEFT_RESERVE = 120;
	const DRAG_MAX_TOP_RESERVE = 80;
	/** 锚点弹出的右下偏移:面板左上角落在点击位置右下方 14px（阅读顺序自然）。 */
	const CHAT_POPUP_OFFSET = 14;
	/** 摘要行长度上限（Chrome 端 controller 同款 slice(0, 40)）。 */
	const SUMMARY_MAX_CHARS = 40;
	/**
	* stop()/换代取消在飞的 chat 后,Kotlin 发来的 CHAT_ERROR 以错误码名作前缀
	* （chatFailureText 的 `"$code：$detail"`）。那是用户侧的正常终态,不是失败——
	* 渲染成中性提示,别把「取消」画成红色错误（Task 3 移交的语义）。
	*/
	const CANCELLED_MESSAGE_PREFIX = "REQUEST_CANCELLED";
	const CANCELLED_NOTICE_TEXT = "本轮回答已取消，可重新提问";
	var ChatPanel = class {
		/**
		* 提交回调:bootstrap 的接线（installChatPanel）赋值,输入框 Enter 提交时收到
		* trim 后的问题文本。接线层负责 appendUserTurn/beginAssistantTurn 的时序与
		* CHAT_ASK 的构造发送。
		*/
		onSubmit = () => {};
		host;
		#doc;
		#root;
		#summary;
		#collapse;
		#messages;
		#input;
		#send;
		#conversationId;
		#history = [];
		#assistantBubble;
		/** 拖动状态;pointerup/pointercancel 清空。null = 未在拖。 */
		#drag = null;
		/** 用户拖过之后的位置（像素）;重开面板时沿用,没拖过则保持 CSS 默认右下。 */
		#placedLeft;
		#placedTop;
		constructor(ownerDocument = document) {
			this.#doc = ownerDocument;
			this.host = ownerDocument.createElement("div");
			this.host.dataset.englishSyntaxChatPanel = "";
			this.#root = ownerDocument.createElement("div");
			this.#root.className = "english-syntax-chat-panel";
			this.#root.setAttribute("aria-label", "追问对话");
			this.#summary = ownerDocument.createElement("div");
			this.#summary.className = "english-syntax-chat-summary";
			const collapse = ownerDocument.createElement("button");
			collapse.type = "button";
			collapse.textContent = "收起";
			collapse.addEventListener("click", () => {
				const collapsed = this.#root.toggleAttribute("data-collapsed");
				collapse.textContent = collapsed ? "展开" : "收起";
			});
			this.#collapse = collapse;
			const close = ownerDocument.createElement("button");
			close.type = "button";
			close.textContent = "关闭";
			close.addEventListener("click", () => this.dispose());
			const header = ownerDocument.createElement("div");
			header.className = "english-syntax-chat-header";
			header.append(this.#summary, collapse, close);
			header.addEventListener("pointerdown", (event) => {
				if (event.target instanceof Element && event.target.closest("button")) return;
				const rect = this.#root.getBoundingClientRect();
				this.#drag = {
					startX: event.clientX,
					startY: event.clientY,
					baseLeft: rect.left,
					baseTop: rect.top
				};
				header.style.setProperty("cursor", "grabbing", "important");
				event.preventDefault();
			});
			header.style.setProperty("cursor", "grab", "important");
			collapse.style.setProperty("cursor", "pointer", "important");
			close.style.setProperty("cursor", "pointer", "important");
			ownerDocument.addEventListener("pointermove", (event) => {
				if (this.#drag === null) return;
				this.#applyPosition(this.#drag.baseLeft + event.clientX - this.#drag.startX, this.#drag.baseTop + event.clientY - this.#drag.startY);
			});
			const endDrag = () => {
				if (this.#drag === null) return;
				this.#drag = null;
				header.style.setProperty("cursor", "grab", "important");
			};
			ownerDocument.addEventListener("pointerup", endDrag);
			ownerDocument.addEventListener("pointercancel", endDrag);
			this.#messages = ownerDocument.createElement("div");
			this.#messages.className = "english-syntax-chat-messages";
			this.#input = ownerDocument.createElement("textarea");
			this.#input.className = "english-syntax-chat-input";
			this.#input.setAttribute("maxlength", String(MAX_CHAT_QUESTION_CHARACTERS));
			this.#input.setAttribute("placeholder", "追问这句的翻译或划分…");
			this.#input.setAttribute("aria-label", "追问问题");
			this.#input.addEventListener("keydown", (event) => {
				if (event.isComposing) return;
				if (event.key === "Enter" && !event.shiftKey) {
					event.preventDefault();
					this.#submit();
				}
			});
			this.#send = ownerDocument.createElement("button");
			this.#send.type = "button";
			this.#send.className = "english-syntax-chat-send";
			this.#send.textContent = "发送";
			this.#send.style.setProperty("cursor", "pointer", "important");
			this.#send.addEventListener("click", () => this.#submit());
			const composer = ownerDocument.createElement("div");
			composer.className = "english-syntax-chat-composer";
			composer.append(this.#input, this.#send);
			this.#root.append(header, this.#messages, composer);
			this.host.append(this.#root);
		}
		/**
		* 换锚定句 = 重置会话:历史与气泡清空、摘要行换新、conversationId 换成 bootstrap
		* 新铸的那只,旧会话的迟到流/结果自此全部丢弃。带锚点（点「问」处）弹出:面板跟着
		* 句子走,覆盖此前的拖动落点;不带锚点则保持既有位置（默认右下/上次拖动落点）。
		*/
		open(context) {
			this.#conversationId = context.conversationId;
			this.#history = [];
			this.#assistantBubble = void 0;
			if (context.anchor !== void 0) this.#applyPosition(context.anchor.x + CHAT_POPUP_OFFSET, context.anchor.y + CHAT_POPUP_OFFSET);
			else if (this.#placedLeft !== void 0 && this.#placedTop !== void 0) this.#applyPosition(this.#placedLeft, this.#placedTop);
			this.#messages.replaceChildren();
			this.#summary.textContent = context.summary.slice(0, SUMMARY_MAX_CHARS);
			this.#summary.title = context.summary;
			this.#root.dataset.sentenceId = context.sentenceId;
			this.#root.removeAttribute("data-collapsed");
			this.#collapse.textContent = "收起";
			this.#input.value = "";
			this.#setSending(false);
			if (!this.host.isConnected) this.#doc.documentElement.append(this.host);
		}
		/** 会话 id 的显式轮换（open 已带 id,这只留给测试与潜在的手动作废/续用点）。 */
		setConversationId(id) {
			this.#conversationId = id;
		}
		/**
		* 当前会话的请求视图:history 已按 Kotlin parse 门同单位裁剪（项 ≤ 6、总字符
		* ≤ 8000,从最旧丢起）,且**不含尾部悬空的 user 轮**——已提交未回答的那一问属于
		* 「本轮」,由 CHAT_ASK 的 question 字段单独承载,不重复进 history。返回的是
		* 副本,调用方改动不污染面板状态。
		*/
		currentConversation() {
			if (this.#conversationId === void 0) return null;
			return {
				conversationId: this.#conversationId,
				history: this.#trimmedHistory()
			};
		}
		/**
		* bootstrap 转发来的 CHAT_* 统一入口:按消息类型分发,conversationId 由各方法
		* 自行把关（generation 等值门已在 bridge.parseHostMessage 过滤,这是第二道防线）。
		*/
		handleHostMessage(message) {
			switch (message.type) {
				case "CHAT_STREAM":
					this.renderStreamedText(message.conversationId, message.text);
					return;
				case "CHAT_RESULT":
					this.completeAssistantTurn(message.conversationId, message.answer);
					return;
				case "CHAT_ERROR":
					this.failAssistantTurn(message.conversationId, message.message);
					return;
			}
		}
		appendUserTurn(text) {
			this.#history.push({
				role: "user",
				content: text
			});
			this.#messages.append(this.#bubble("user", text));
			this.#scrollToEnd();
		}
		/** 开始一轮回答:建立 pending 气泡并进入发送中（输入禁用）。旧会话 id 忽略。 */
		beginAssistantTurn(conversationId) {
			if (conversationId !== this.#conversationId) return;
			this.#setSending(true);
			const bubble = this.#bubble("assistant pending", "正在生成回答…");
			this.#assistantBubble = bubble;
			this.#messages.append(bubble);
			this.#scrollToEnd();
		}
		/**
		* 流式分片 = 截至目前的完整回答:全量替换当前气泡文本,不是追加。
		* 无进行中轮次（completeAssistantTurn/failAssistantTurn 已收尾）的迟到分片
		* 直接忽略——此时再建泡会把已结束的一轮又画出一个重复气泡。
		*/
		renderStreamedText(conversationId, text) {
			if (conversationId !== this.#conversationId) return;
			if (this.#assistantBubble === void 0) return;
			const bubble = this.#assistantBubble;
			bubble.classList.remove("english-syntax-chat-message--pending");
			bubble.textContent = text;
			this.#scrollToEnd();
		}
		/**
		* 回答落定:以缓冲答案为准校平气泡（防流式尾片丢失）,push 进历史并解除发送中。
		* 缓冲路径（无分片）同样走这里,气泡整段出现。
		*/
		completeAssistantTurn(conversationId, answer) {
			if (conversationId !== this.#conversationId) return;
			if (this.#assistantBubble === void 0) {
				this.#assistantBubble = this.#bubble("assistant", answer);
				this.#messages.append(this.#assistantBubble);
			}
			const bubble = this.#assistantBubble;
			bubble.classList.remove("english-syntax-chat-message--pending");
			bubble.textContent = answer;
			this.#assistantBubble = void 0;
			this.#history.push({
				role: "assistant",
				content: answer
			});
			this.#setSending(false);
			this.#scrollToEnd();
		}
		/**
		* 失败轮不入历史:撤销悬空 user 轮,history 始终是完整问答对;输入恢复。
		* 无 pending 轮也画错误气泡（Kotlin「原句已失效」路径:提交后记录/core 缺失,
		* 面板里可能没有任何进行中轮次,不能静默吞掉）。REQUEST_CANCELLED 前缀按中性
		* 提示渲染（用户主动取消的正常终态）,原文留在 title 里备查。
		*/
		failAssistantTurn(conversationId, message) {
			if (conversationId !== this.#conversationId) return;
			if (this.#history[this.#history.length - 1]?.role === "user") this.#history.pop();
			const cancelled = message.startsWith(CANCELLED_MESSAGE_PREFIX);
			const text = cancelled ? CANCELLED_NOTICE_TEXT : message;
			const bubble = this.#assistantBubble;
			if (bubble !== void 0) {
				bubble.className = cancelled ? "english-syntax-chat-message english-syntax-chat-message--notice" : "english-syntax-chat-message english-syntax-chat-message--error";
				bubble.textContent = text;
			} else this.#messages.append(this.#bubble(cancelled ? "notice" : "error", text));
			const placed = bubble ?? this.#messages.lastElementChild;
			if (cancelled) placed?.setAttribute("title", message);
			this.#assistantBubble = void 0;
			this.#setSending(false);
			this.#scrollToEnd();
		}
		/**
		* 钳制到视口内并落到 .english-syntax-chat-panel 的内联样式——它才是
		* position:fixed 的元素,host 只是 0×0 的挂载壳,写 host 不动面板。定位后改用
		* left/top（清掉 right/bottom 的 CSS 默认右下锚定）。记下落点供重开沿用。
		*/
		#applyPosition(left, top) {
			const view = this.#doc.defaultView;
			const maxLeft = Math.max(DRAG_MARGIN, (view?.innerWidth ?? 0) - DRAG_MAX_LEFT_RESERVE);
			const maxTop = Math.max(DRAG_MARGIN, (view?.innerHeight ?? 0) - DRAG_MAX_TOP_RESERVE);
			const clampedLeft = Math.min(Math.max(left, DRAG_MARGIN), maxLeft);
			const clampedTop = Math.min(Math.max(top, DRAG_MARGIN), maxTop);
			this.#root.style.left = `${clampedLeft}px`;
			this.#root.style.top = `${clampedTop}px`;
			this.#root.style.right = "auto";
			this.#root.style.bottom = "auto";
			this.#placedLeft = clampedLeft;
			this.#placedTop = clampedTop;
		}
		/** 关闭浮层并作废会话（对话不持久化:面板关闭即丢;对象常驻,下次 open 重开）。 */
		dispose() {
			this.host.remove();
			this.#conversationId = void 0;
			this.#history = [];
			this.#assistantBubble = void 0;
			this.#messages.replaceChildren();
			this.#summary.textContent = "";
			delete this.#root.dataset.sentenceId;
			this.#input.value = "";
			this.#setSending(false);
		}
		#submit() {
			if (this.#input.disabled) return;
			const question = this.#input.value.trim();
			if (question.length === 0) return;
			this.onSubmit(question);
			this.#input.value = "";
		}
		#setSending(sending) {
			this.#input.disabled = sending;
			this.#send.disabled = sending;
		}
		#bubble(variant, text) {
			const bubble = this.#doc.createElement("div");
			bubble.className = ["english-syntax-chat-message", ...variant.split(" ").map((part) => `english-syntax-chat-message--${part}`)].join(" ");
			bubble.textContent = text;
			return bubble;
		}
		#trimmedHistory() {
			let items = this.#history;
			if (items[items.length - 1]?.role === "user") items = items.slice(0, -1);
			items = items.slice(-6);
			let characters = items.reduce((total, turn) => total + turn.content.length, 0);
			while (items.length > 0 && characters > 8e3) {
				characters -= items[0].content.length;
				items = items.slice(1);
			}
			return items.map((turn) => ({
				role: turn.role,
				content: turn.content
			}));
		}
		#scrollToEnd() {
			this.#messages.scrollTop = this.#messages.scrollHeight;
		}
	};
	//#endregion
	//#region src/main/resources/web/bootstrap-entry.ts
	/**
	* JCEF 预览页入口:把模块化的 preview/render/bridge 接到 window 全局。
	*
	* Kotlin 经 executeJavaScript 调四个全局入口;JS→Kotlin 经
	* window.EnglishSyntaxHost.post(jsonText)(JBCefJSQuery 注入)。
	* 由构建(rolldown)打包成单文件 IIFE 注入预览页。
	*/
	let state = null;
	const STATUS_ID = "english-syntax-status";
	let statusEl = null;
	let returnedCount = 0;
	function ensureStatusElement() {
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
	function setStatus(text, kind, spinning = true) {
		const el = ensureStatusElement();
		el.querySelector(".english-syntax-status-label").textContent = text;
		el.dataset.kind = kind;
		el.hidden = false;
		const spinner = el.querySelector(".english-syntax-status-spinner");
		spinner.style.display = spinning ? "" : "none";
	}
	function hideStatus() {
		if (statusEl !== null) statusEl.hidden = true;
	}
	/**
	* 短提示（2.5 秒自动隐藏）。快捷键路径没有菜单反馈，静默失败会让用户以为键坏了。
	* 用独立计时器，避免与「解析完成」的淡出互相取消。
	*/
	let flashTimer;
	function flashStatus(text) {
		clearTimeout(flashTimer);
		setStatus(text, "error", false);
		flashTimer = setTimeout(hideStatus, 2500);
	}
	function bumpReturned(sentenceCount) {
		returnedCount += sentenceCount;
	}
	function postToHost(message) {
		const host = window.EnglishSyntaxHost;
		if (host !== void 0 && typeof host.post === "function") host.post(JSON.stringify(message));
	}
	function rescan() {
		const s = state;
		if (s === null) return;
		const blocks = scanMarkdownBlocks(document.body);
		for (const block of blocks) s.renderer.registerBlock(block.blockId, block.element);
		if (s.visibility !== null) s.visibility.stop();
		s.visibility = null;
		if (blocks.length === 0) return;
		if (!s.autoScan) return;
		const fingerprint = blocks.map((block) => block.blockId).sort().join("\0");
		if (fingerprint === lastVisibleFingerprint) return;
		lastVisibleFingerprint = fingerprint;
		postToHost({
			version: 1,
			type: "VISIBLE_BLOCKS",
			previewId: s.previewId,
			generation: s.generation,
			blocks: blocks.map((block) => ({
				blockId: block.blockId,
				text: block.text
			}))
		});
		for (const block of blocks) markBlockActive(block.blockId);
		requestedBlocks.clear();
		for (const block of blocks) requestedBlocks.add(block.blockId);
		settledBlocks.clear();
		failedBlocks.clear();
		if (statusEl === null || statusEl.hidden) setStatus(`句法学习：正在解析 ${blocks.length} 段…`, "running");
	}
	const ACTIVE_ATTRIBUTE = "data-english-syntax-active";
	/** blockId → 标记所在元素。卡片流式出现后标记要跟着移到卡片上。 */
	const activeMarkers = /* @__PURE__ */ new Map();
	/** 已收到结果的 blockId 集合（按块判完成）。 */
	const settledBlocks = /* @__PURE__ */ new Set();
	const failedBlocks = /* @__PURE__ */ new Set();
	/**
	* 已请求解析的块。按段解析是逐次累加，用计数器会让 settleBlock 的完成判定算错
	* （第二次按快捷键时 settledBlocks.size 已经 ≥ 1）。整篇路径整体替换、显式路径 add。
	*/
	const requestedBlocks = /* @__PURE__ */ new Set();
	/** 完成浮层淡出定时器。 */
	let completeTimer;
	function markBlockActive(blockId) {
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
	function unmarkBlockActive(blockId) {
		activeMarkers.get(blockId)?.removeAttribute(ACTIVE_ATTRIBUTE);
		activeMarkers.delete(blockId);
	}
	function clearAllActive() {
		for (const element of activeMarkers.values()) element.removeAttribute(ACTIVE_ATTRIBUTE);
		activeMarkers.clear();
		settledBlocks.clear();
		failedBlocks.clear();
		requestedBlocks.clear();
	}
	/** 一个块的结果回来了：撤标记；全部可见块都出结果 → 完成反馈。 */
	function settleBlock(blockId, failed) {
		settledBlocks.add(blockId);
		if (failed) failedBlocks.add(blockId);
		unmarkBlockActive(blockId);
		if (requestedBlocks.size > 0 && settledBlocks.size >= requestedBlocks.size) {
			clearTimeout(completeTimer);
			setStatus(`✓ 句法解析完成${failedBlocks.size > 0 ? `，${failedBlocks.size} 段失败` : ""}`, "running");
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
	function trackPreviewRendered() {
		const hasCards = document.querySelector("[data-english-syntax-card]") !== null;
		if (previewHadCards && !hasCards) {
			const s = state;
			if (s !== null) postToHost({
				version: 1,
				type: "PREVIEW_RENDERED",
				previewId: s.previewId,
				generation: s.generation
			});
			previewHadCards = false;
			return true;
		}
		if (hasCards) previewHadCards = true;
		return false;
	}
	function ensureState() {
		if (state !== null) return state;
		state = {
			renderer: new PreviewRenderer((sentenceId, focusStart, focusEnd) => {
				postToHost({
					version: 1,
					type: "DETAIL_REQUEST",
					previewId: state?.previewId ?? "",
					generation: state?.generation ?? 0,
					sentenceId,
					focus: {
						startToken: focusStart,
						endToken: focusEnd
					}
				});
			}),
			previewId: "",
			generation: 0,
			autoScan: true,
			visibility: null,
			observer: null
		};
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
	function parseHoveredBlock(target) {
		const s = state;
		if (s === null || s.previewId === "") return;
		const hovered = target === void 0 ? deepestHovered(document) : target;
		if (hovered !== null && hovered.closest("[data-english-syntax-card]") !== null) {
			flashStatus("该段已解析");
			return;
		}
		const element = nearestPreviewBlock(hovered);
		if (element === null) {
			flashStatus("未找到可解析的段落");
			return;
		}
		if (element.hasAttribute("data-english-syntax-hidden")) {
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
			version: 1,
			type: "PARSE_BLOCK",
			previewId: s.previewId,
			generation: s.generation,
			blockId,
			text: (element.textContent ?? "").trim()
		});
		markBlockActive(blockId);
		setStatus("句法学习：正在解析 1 段…", "running");
	}
	/**
	* 兼底通道键位。由 Kotlin 从 IDEA keymap 读实际绑定后下发；默认与 plugin.xml 声明的一致。
	* `null` = 不装兼底监听（keymap 里没有可下发的单段字母数字绑定）。
	*/
	let hotkey = {
		code: "KeyT",
		altKey: true,
		ctrlKey: false,
		shiftKey: false,
		metaKey: false
	};
	function setHotkey(descriptor) {
		if (descriptor === null) {
			hotkey = null;
			return;
		}
		if (typeof descriptor !== "object") return;
		const candidate = descriptor;
		if (typeof candidate.code !== "string" || candidate.code === "") return;
		hotkey = {
			code: candidate.code,
			altKey: candidate.altKey === true,
			ctrlKey: candidate.ctrlKey === true,
			shiftKey: candidate.shiftKey === true,
			metaKey: candidate.metaKey === true
		};
	}
	function initialize(previewId, generation, autoScan = true) {
		const s = ensureState();
		s.previewId = previewId;
		s.generation = generation;
		s.autoScan = autoScan;
		returnedCount = 0;
		lastVisibleFingerprint = "";
		clearAllActive();
		chatPanelInstance?.dispose();
		chatSentenceId = null;
		resetScanRegistry();
		ensureStatusElement();
		if (s.observer !== null) s.observer.disconnect();
		s.observer = new MutationObserver(() => {
			if (trackPreviewRendered()) return;
			rescan();
		});
		s.observer.observe(document.documentElement, {
			childList: true,
			subtree: true,
			characterData: true
		});
		rescan();
		postToHost({
			version: 1,
			type: "PREVIEW_READY",
			previewId,
			generation
		});
	}
	function reload(offset) {
		const s = ensureState();
		if (s.observer !== null) {
			s.observer.disconnect();
			s.observer = null;
		}
		rescan();
		if (typeof offset === "number" && offset > 0) window.scrollTo(0, offset);
	}
	function scrollTo(offset, smooth) {
		window.scrollTo({
			top: offset,
			behavior: smooth ? "smooth" : "auto"
		});
	}
	function handleHostMessage(hostJson) {
		const s = ensureState();
		const message = parseHostMessage(hostJson, s.generation);
		if (message === null) return;
		switch (message.type) {
			case "SESSION_STATE":
				if (message.state === "paused") {
					setStatus(`⏸ 已暂停（${message.ready}/${message.discovered}）`, "paused", false);
					return;
				}
				if (message.discovered > 0 && message.ready + message.failed >= message.discovered) {
					clearTimeout(completeTimer);
					setStatus(`✓ 句法解析完成${message.failed > 0 ? `，${message.failed} 句失败` : ""}`, "running");
					completeTimer = setTimeout(hideStatus, 2500);
				} else {
					const failedText = message.failed > 0 ? `，${message.failed} 句失败` : "";
					setStatus(`句法学习：${message.ready}/${message.discovered} 句${failedText}`, "running");
				}
				return;
			case "CORE_STREAM":
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
				previewHadCards = false;
				break;
			case "CHAT_STREAM":
			case "CHAT_RESULT":
			case "CHAT_ERROR":
				chatPanel?.handleHostMessage(message);
				return;
		}
		s.renderer.handleHostMessage(message);
	}
	document.addEventListener("click", (event) => {
		const target = event.target;
		if (!(target instanceof Element) || state === null) return;
		const retry = target.closest("[data-english-syntax-retry]");
		if (retry === null) return;
		const sentenceId = retry.getAttribute("data-sentence-id");
		if (sentenceId === null) return;
		postToHost({
			version: 1,
			type: "RETRY_SENTENCE",
			previewId: state.previewId,
			generation: state.generation,
			sentenceId
		});
	});
	let chatPanel = null;
	/**
	* 注册/注销追问面板。生产由 installChatPanel() 在模块载入时自动注册（面板随 bootstrap
	* 常驻）；null = 拆除，供测试隔离，拆除后可再调 installChatPanel() 恢复。
	*/
	function setChatPanel(panel) {
		chatPanel = panel;
	}
	/** conversationId 计数器：模块级持有、单调递增，跨代次不重置（id 含 previewId 仍唯一）。 */
	let chatConversationCounter = 0;
	/** 面板单例（构造不挂载,首次 open 才上 DOM）;installChatPanel 里接线并注册 seam。 */
	let chatPanelInstance = null;
	/** 当前锚定句（open 时记下,submit 时作 CHAT_ASK 的 sentenceId）;换代随面板一起作废。 */
	let chatSentenceId = null;
	/**
	* 面板 submit → 先落用户轮与 pending 回答轮，再经 sendChatAsk 构造发送 CHAT_ASK。
	* history 取面板 currentConversation()（已裁剪、不含本轮悬空 user 轮）；两 turn 的
	* 落账时序与 Chrome 端 askChat 一致。sendChatAsk 拒发（无状态/超限）时给面板终态，
	* 别让输入框永久卡在禁用态。
	*/
	function submitChatQuestion(question) {
		const panel = chatPanelInstance;
		if (panel === null) return;
		const conversation = panel.currentConversation();
		if (conversation === null || chatSentenceId === null) return;
		panel.appendUserTurn(question);
		panel.beginAssistantTurn(conversation.conversationId);
		if (!sendChatAsk({
			conversationId: conversation.conversationId,
			sentenceId: chatSentenceId,
			question,
			history: conversation.history
		})) panel.failAssistantTurn(conversation.conversationId, "发送失败：预览会话尚未就绪，请重新打开追问面板");
	}
	/**
	* 实例化并注册追问面板（幂等：单例只建一次，重复调用只重新注册 seam）。模块载入时
	* 自调一次——生产上面板随 bootstrap 常驻;测试在 setChatPanel(null) 后可再调恢复。
	*/
	function installChatPanel() {
		if (chatPanelInstance === null) {
			chatPanelInstance = new ChatPanel();
			chatPanelInstance.onSubmit = submitChatQuestion;
		}
		setChatPanel(chatPanelInstance);
		return chatPanelInstance;
	}
	installChatPanel();
	/**
	* 面板 submit → 构造并发送 CHAT_ASK。图标点击时**绝不下发**这条消息——那时还没有合法
	* question，Kotlin 侧 parseChatAsk（trim 后 1..2000 + 白名单键集）会直接拒收。history 只做
	* 最浅的防呆（收敛到 {role, content} 键集 + 取最近 6 项）；按字符裁剪是面板职责，硬门在 Kotlin。
	*/
	function sendChatAsk(input) {
		const s = state;
		if (s === null || s.previewId === "") return false;
		const question = input.question.trim();
		if (question.length === 0 || question.length > 2e3) return false;
		postToHost({
			version: 1,
			type: "CHAT_ASK",
			previewId: s.previewId,
			generation: s.generation,
			conversationId: input.conversationId,
			sentenceId: input.sentenceId,
			history: input.history.slice(-6).map((turn) => ({
				role: turn.role,
				content: turn.content
			})),
			question
		});
		return true;
	}
	document.addEventListener(CHAT_ASK_REQUEST_EVENT, (event) => {
		if (state === null || state.previewId === "") return;
		const detail = event.detail;
		if (typeof detail !== "object" || detail === null) return;
		const { sentenceId, anchor } = detail;
		if (typeof sentenceId !== "string" || sentenceId === "") return;
		if (typeof anchor?.x !== "number" || typeof anchor?.y !== "number") return;
		const panel = chatPanel;
		if (panel === null) return;
		chatConversationCounter += 1;
		chatSentenceId = sentenceId;
		panel.open({
			conversationId: `${state.previewId}:chat:${chatConversationCounter}`,
			sentenceId,
			summary: state.renderer.sentenceText(sentenceId).slice(0, 40),
			anchor: {
				x: anchor.x,
				y: anchor.y
			}
		});
	});
	document.addEventListener("keydown", (event) => {
		const bound = hotkey;
		if (bound === null) return;
		if (event.code !== bound.code || event.altKey !== bound.altKey || event.ctrlKey !== bound.ctrlKey || event.shiftKey !== bound.shiftKey || event.metaKey !== bound.metaKey) return;
		event.preventDefault();
		parseHoveredBlock();
	});
	const w = window;
	w.__englishSyntaxInitialize = initialize;
	w.__englishSyntaxReload = reload;
	w.__englishSyntaxScrollTo = scrollTo;
	w.__englishSyntaxMessage = handleHostMessage;
	w.__englishSyntaxSetTheme = setDarkMode;
	w.__englishSyntaxParseHoveredBlock = parseHoveredBlock;
	w.__englishSyntaxSetHotkey = setHotkey;
	//#endregion
	exports.installChatPanel = installChatPanel;
	exports.sendChatAsk = sendChatAsk;
	exports.setChatPanel = setChatPanel;
	return exports;
})({});
