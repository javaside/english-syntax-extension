(function() {
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
		"BLOCKQUOTE"
	]);
	const EXCLUDED_SELECTOR = "pre,code,table,.math,.katex,.mermaid,.footnotes,[role='doc-endnotes'],button,input,textarea,select,iframe,[contenteditable],[data-english-syntax-card]";
	const BLOCK_ID_ATTRIBUTE = "data-english-syntax-block";
	const MIN_TEXT_LENGTH = 20;
	const ENGLISH_RATIO = .6;
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
		if (isExcluded(element)) return;
		if (element.tagName === "BLOCKQUOTE") {
			for (const child of element.querySelectorAll("p,li")) collectCandidates(child, into);
			return;
		}
		if (!isLeafBlock(element)) return;
		const text = (element.textContent ?? "").trim();
		if (text.length < MIN_TEXT_LENGTH) return;
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
})();
