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
			"discovered"
		],
		CORE_STREAM: [
			"version",
			"type",
			"previewId",
			"generation",
			"sentenceId",
			"componentsJson"
		],
		CORE_RESULT: [
			"version",
			"type",
			"previewId",
			"generation",
			"sentenceId",
			"analysisJson"
		],
		CORE_ERROR: [
			"version",
			"type",
			"previewId",
			"generation",
			"sentenceId",
			"code",
			"message"
		],
		DETAIL_STREAM: [
			"version",
			"type",
			"previewId",
			"generation",
			"sentenceId",
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
				return {
					version: 1,
					type: "SESSION_STATE",
					previewId: value.previewId,
					generation: value.generation,
					state: value.state,
					ready: value.ready,
					discovered: value.discovered
				};
			case "CORE_STREAM":
				if (!isNonEmptyString(value.sentenceId) || typeof value.componentsJson !== "string") return null;
				return {
					version: 1,
					type: "CORE_STREAM",
					previewId: value.previewId,
					generation: value.generation,
					sentenceId: value.sentenceId,
					componentsJson: value.componentsJson
				};
			case "CORE_RESULT":
			case "DETAIL_RESULT":
				if (!isNonEmptyString(value.sentenceId) || typeof value.analysisJson !== "string") return null;
				return {
					version: 1,
					type: value.type,
					previewId: value.previewId,
					generation: value.generation,
					sentenceId: value.sentenceId,
					analysisJson: value.analysisJson
				};
			case "DETAIL_STREAM":
				if (!isNonEmptyString(value.sentenceId) || typeof value.structuresJson !== "string") return null;
				return {
					version: 1,
					type: "DETAIL_STREAM",
					previewId: value.previewId,
					generation: value.generation,
					sentenceId: value.sentenceId,
					structuresJson: value.structuresJson
				};
			case "CORE_ERROR":
				if (!isNonEmptyString(value.sentenceId) || !isNonEmptyString(value.code)) return null;
				if (typeof value.message !== "string") return null;
				return {
					version: 1,
					type: "CORE_ERROR",
					previewId: value.previewId,
					generation: value.generation,
					sentenceId: value.sentenceId,
					code: value.code,
					message: value.message
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
	const CANDIDATE_SELECTOR = "h1,h2,h3,h4,h5,h6,p,li,blockquote";
	const EXCLUDED_SELECTOR = "pre,code,table,.math,.katex,.mermaid,.footnotes,[role='doc-endnotes'],button,input,textarea,select,iframe,[contenteditable],[data-english-syntax-card]";
	const HIDDEN_ATTRIBUTE$1 = "data-english-syntax-hidden";
	const BLOCK_ID_ATTRIBUTE = "data-english-syntax-block";
	const MIN_TEXT_LENGTH = 20;
	const ENGLISH_RATIO = .6;
	const BLOCK_SELECTOR_PREFIX = "english-syntax-block-";
	let nextBlockId = 0;
	const registeredElements = /* @__PURE__ */ new WeakSet();
	function isExcluded(element) {
		return element.closest(EXCLUDED_SELECTOR) !== null;
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
		for (const element of root.querySelectorAll(CANDIDATE_SELECTOR)) collectCandidates(element, elements);
		return elements.filter((element) => !registeredElements.has(element) && !element.hasAttribute(HIDDEN_ATTRIBUTE$1)).map((element) => {
			registeredElements.add(element);
			const existing = element.getAttribute("data-english-syntax-block");
			const blockId = existing ?? `${BLOCK_SELECTOR_PREFIX}${nextBlockId++}`;
			if (existing === null) element.setAttribute(BLOCK_ID_ATTRIBUTE, blockId);
			return {
				blockId,
				element,
				text: (element.textContent ?? "").trim()
			};
		});
	}
	/**
	* IntersectionObserver（rootMargin 上下各一屏）；环境不支持时退化为
	* rAF 节流的 scroll/resize 检查。
	*/
	function observeBlocks(root, blocks, callback) {
		const visible = /* @__PURE__ */ new Set();
		const emit = () => callback(Array.from(visible));
		if (typeof IntersectionObserver !== "undefined") {
			const observer = new IntersectionObserver((entries) => {
				for (const entry of entries) {
					const block = blocks.find((candidate) => candidate.element === entry.target);
					if (!block) continue;
					if (entry.isIntersecting) visible.add(block);
					else visible.delete(block);
				}
				emit();
			}, { rootMargin: "100% 0px 100% 0px" });
			blocks.forEach(({ element }) => observer.observe(element));
			return {
				start() {
					emit();
				},
				stop() {
					observer.disconnect();
				}
			};
		}
		let raf = 0;
		const check = () => {
			raf = 0;
			const view = root.ownerDocument?.defaultView;
			if (!view) return;
			const viewportTop = -view.innerHeight;
			const viewportBottom = view.innerHeight * 2;
			visible.clear();
			for (const block of blocks) {
				const rect = block.element.getBoundingClientRect();
				if (rect.bottom >= viewportTop && rect.top <= viewportBottom) visible.add(block);
			}
			emit();
		};
		const schedule = () => {
			if (raf === 0) raf = requestAnimationFrame(check);
		};
		return {
			start() {
				viewOf(root)?.addEventListener("scroll", schedule, { passive: true });
				viewOf(root)?.addEventListener("resize", schedule, { passive: true });
				schedule();
			},
			stop() {
				viewOf(root)?.removeEventListener("scroll", schedule);
				viewOf(root)?.removeEventListener("resize", schedule);
				if (raf !== 0) cancelAnimationFrame(raf);
			}
		};
	}
	function viewOf(root) {
		return root.ownerDocument?.defaultView ?? null;
	}
	//#endregion
	//#region src/main/resources/web/render.ts
	const HIDDEN_ATTRIBUTE = "data-english-syntax-hidden";
	const CARD_TAG = "div";
	const CARD_ATTRIBUTE = "data-english-syntax-card";
	var PreviewRenderer = class {
		#blocks = /* @__PURE__ */ new Map();
		#sentences = /* @__PURE__ */ new Map();
		#blockSentenceOrder = /* @__PURE__ */ new Map();
		#currentDetail = null;
		#onDetailRequest;
		constructor(onDetailRequest) {
			this.#onDetailRequest = onDetailRequest;
		}
		registerBlock(blockId, element) {
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
					this.renderCoreStream(message.sentenceId, JSON.parse(message.componentsJson));
					break;
				case "CORE_RESULT":
					this.renderCoreResult(message.sentenceId, JSON.parse(message.analysisJson));
					break;
				case "CORE_ERROR":
					this.renderCoreError(message.sentenceId, message.code, message.message);
					break;
				case "DETAIL_STREAM":
				case "DETAIL_RESULT": {
					const payload = JSON.parse(message.type === "DETAIL_RESULT" ? message.analysisJson : message.structuresJson);
					if (message.type === "DETAIL_RESULT") this.renderDetailResult(payload);
					else this.renderDetailStream(message.sentenceId, payload);
					break;
				}
				case "RESTORE_ALL": this.restoreAll();
			}
		}
		renderCoreStream(sentenceId, components) {
			const entry = this.#sentences.get(sentenceId);
			if (entry === void 0) return;
			entry.record.provisional = components;
			const order = this.#blockSentenceOrder.get(entry.blockId) ?? [];
			if (!order.includes(sentenceId)) order.push(sentenceId);
			this.#blockSentenceOrder.set(entry.blockId, order);
			this.#repaintBlock(entry.blockId);
		}
		renderCoreResult(sentenceId, analysis) {
			const entry = this.#sentences.get(sentenceId);
			if (entry === void 0) return;
			entry.record.analysis = analysis;
			entry.record.provisional = null;
			entry.record.failed = false;
			this.#sentences.set(sentenceId, entry);
			const order = this.#blockSentenceOrder.get(entry.blockId) ?? [];
			if (!order.includes(sentenceId)) order.push(sentenceId);
			this.#blockSentenceOrder.set(entry.blockId, order);
			this.#repaintBlock(entry.blockId);
		}
		renderCoreError(sentenceId, code, message) {
			const entry = this.#sentences.get(sentenceId);
			if (entry === void 0) return;
			entry.record.failed = true;
			entry.record.analysis = null;
			entry.record.provisional = null;
			this.#repaintBlock(entry.blockId, {
				errorSentenceId: sentenceId,
				message
			});
		}
		renderDetailStream(sentenceId, structures) {
			this.#showDetailPanel(sentenceId, structures);
		}
		renderDetailResult(detail) {
			this.#showDetailPanel(detail.sentenceId, detail.structures, detail);
		}
		requestDetail(sentenceId, focusStart, focusEnd) {
			this.#onDetailRequest(sentenceId, focusStart, focusEnd);
		}
		#showDetailPanel(sentenceId, structures, detail) {
			const entry = this.#sentences.get(sentenceId);
			if (entry == null) return;
			this.#currentDetail = {
				sentenceId,
				focusStart: detail?.focus.startToken ?? 0,
				focusEnd: detail?.focus.endToken ?? 0
			};
			this.#repaintBlock(entry.blockId, {
				detailStructures: structures,
				detail
			});
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
			const order = this.#blockSentenceOrder.get(blockId) ?? [];
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
			const container = owner.createElement("div");
			container.className = "english-syntax-sentences";
			for (const sentenceId of order) {
				const sentence = record.sentences.get(sentenceId);
				if (sentence === void 0) continue;
				const section = owner.createElement("section");
				section.className = "english-syntax-sentence";
				section.dataset.sentenceId = sentenceId;
				const components = sentence.analysis?.components ?? sentence.provisional ?? [];
				if (sentenceId === options.errorSentenceId) {
					const error = owner.createElement("div");
					error.className = "english-syntax-error";
					error.textContent = options.message ?? "解析失败";
					const retry = owner.createElement("button");
					retry.className = "english-syntax-retry";
					retry.type = "button";
					retry.textContent = "重试";
					retry.addEventListener("click", () => this.requestDetail(sentenceId, 0, 0));
					section.append(error, retry);
					container.append(section);
					continue;
				}
				for (const component of components) {
					const button = owner.createElement("button");
					button.type = "button";
					button.className = "english-syntax-component";
					button.dataset.startToken = String(component.startToken);
					button.dataset.endToken = String(component.endToken);
					button.addEventListener("click", () => {
						if (this.#currentDetail?.sentenceId === sentenceId) {
							this.closeDetail();
							return;
						}
						this.requestDetail(sentenceId, component.startToken, component.endToken);
					});
					const role = owner.createElement("span");
					role.className = "english-syntax-role";
					role.textContent = component.role;
					const english = owner.createElement("span");
					english.className = "english-syntax-english";
					english.textContent = this.#componentText(record, sentenceId, component);
					const translation = owner.createElement("span");
					translation.className = "english-syntax-translation";
					translation.textContent = component.translation;
					button.append(role, english, translation);
					section.append(button);
				}
				if (sentence.analysis === null && sentence.provisional !== null) section.classList.add("english-syntax-provisional");
				container.append(section);
			}
			if (options.detailStructures !== void 0 || options.detail !== void 0) {
				const panel = owner.createElement("div");
				panel.className = "english-syntax-detail";
				const structures = options.detailStructures ?? options.detail?.structures ?? [];
				for (const structure of structures) {
					const row = owner.createElement("div");
					row.className = "english-syntax-detail-row";
					const role = owner.createElement("span");
					role.className = "english-syntax-detail-role";
					role.textContent = structure.role;
					const english = owner.createElement("span");
					english.className = "english-syntax-detail-english";
					english.textContent = this.#componentText(record, this.#currentDetail?.sentenceId ?? "", structure);
					const translation = owner.createElement("span");
					translation.className = "english-syntax-detail-translation";
					translation.textContent = structure.translation ?? "";
					row.append(role, english, translation);
					panel.append(row);
				}
				if (options.detail?.grammarPoints?.length) {
					const points = owner.createElement("div");
					points.className = "english-syntax-grammar-points";
					points.textContent = options.detail.grammarPoints.join("；");
					panel.append(points);
				}
				if (options.detail?.explanation) {
					const explanation = owner.createElement("div");
					explanation.className = "english-syntax-explanation";
					explanation.textContent = options.detail.explanation;
					panel.append(explanation);
				}
				container.append(panel);
			}
			card.append(container);
		}
		#componentText(record, sentenceId, component) {
			return typeof component.text === "string" ? component.text : "";
		}
		#restoreBlock(record) {
			record.element.removeAttribute(HIDDEN_ATTRIBUTE);
			record.card?.remove();
			record.card = null;
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
		s.visibility = observeBlocks(document.body, blocks, (visible) => {
			if (visible.length === 0) return;
			postToHost({
				version: 1,
				type: "VISIBLE_BLOCKS",
				previewId: s.previewId,
				generation: s.generation,
				blocks: visible.map((block) => ({
					blockId: block.blockId,
					text: block.text
				}))
			});
		});
		s.visibility.start();
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
			visibility: null,
			observer: null
		};
		return state;
	}
	function initialize(previewId, generation) {
		const s = ensureState();
		s.previewId = previewId;
		s.generation = generation;
		if (s.observer !== null) s.observer.disconnect();
		s.observer = new MutationObserver(() => rescan());
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
	const w = window;
	w.__englishSyntaxInitialize = initialize;
	w.__englishSyntaxReload = reload;
	w.__englishSyntaxScrollTo = scrollTo;
	w.__englishSyntaxMessage = handleHostMessage;
	//#endregion
})();
