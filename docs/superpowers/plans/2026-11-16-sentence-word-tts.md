# 句子与单词朗读 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 卡片句头与详解面板条目各配小喇叭,点击经 content script 本地 `speechSynthesis` 朗读(发音查证),零协议/零权限/零设置。

**Architecture:** 新增独立门面模块 `speech.ts`(挑语音、speak/cancel、依赖注入),`learning-block.ts` 在句头(renderCore)与面板标注条目(#annotations 完整渲染分支)挂小喇叭调用它。朗读打断/停止语义在 block 层用 `aria-pressed` 表达。

**Tech Stack:** TypeScript、Web Speech API(content script isolated world 可用)、Vitest(fake 注入)、Playwright(不 mock 语音,只断言挂载与状态切换)。

**Spec:** `docs/superpowers/specs/2026-11-16-sentence-word-tts-design.md`

## Global Constraints

- **零协议红线**:diff 不得触碰 `src/shared/protocol.ts`、`src/background/service-worker.ts`、`manifest.json`、storage——触碰即方向错误(spec「约束与已知坑」末条)。
- 朗读文本口径:复用 `annotationEnglish(tokens, range)`(前导空白保留、区间末尾标点省略);整句 = `annotationEnglish(tokens, { startToken: 0, endToken: tokens.length - 1 })`。
- E2E 探针不断言墙钟与真实音频(仓库门禁约定);单测环境 happy-dom 无 `speechSynthesis`,一切经依赖注入。
- lint 基线恰好 1 个错误(`options.test.ts` 的 `no-unnecessary-type-assertion`),不新增。
- 提交信息中文主题;每个任务独立提交、独立可测。
- 执行前置:从 `main` 切新分支 `feature/sentence-word-tts`(下钻功能已在 main,基线干净;遵循 using-git-worktrees 惯例)。

## Review Focus

1. **环境无 `speechSynthesis`**(happy-dom、罕见浏览器)→ 喇叭必须不渲染而非死按钮 → Task 2 Step 1 钉(`speakerFactory` 返回 `null` 时无按钮)。
2. **voices 为空/未加载** → `speak` 仍须发声(`utterance.lang = "en-US"` 保底,voice 是增强) → Task 1 Step 1 钉。
3. **旧 utterance 的 onend 晚到**(被 stop/被打断后异步到达) → `onEnd` 回调幂等,不得误清新朗读的按钮态 → Task 1 Step 1 + Task 2 Step 1 钉。
4. **annotation 是 `<button>`(下钻)**,喇叭嵌进去即非法 HTML(nested button) → 喇叭必须是兄弟节点 → Task 3 Step 1 钉(断言 annotation 内无子 button、speak 是 wrapper 下的兄弟)。
5. **面板下钻/返回重画后旧朗读态残留** → 朗读态判定用按钮自身 `aria-pressed` + `speaker.isSpeaking()`,不缓存 DOM 节点引用 → Task 3 Step 1 钉(下钻后重画面板喇叭全部未按下)。

---

### Task 1: speech.ts 朗读门面

**Files:**
- Create: `chrome-plugin/src/content/speech.ts`
- Test: `chrome-plugin/src/content/speech.test.ts`

**Interfaces:**
- Consumes: 无(首个任务)。
- Produces(后续任务按此引用,签名逐字):
  - `interface SpeechSynthesisLike { getVoices(): readonly SpeechSynthesisVoiceLike[]; speak(utterance: SpeechSynthesisUtteranceLike): void; cancel(): void; }`
  - `interface SpeechSynthesisVoiceLike { readonly lang: string; readonly localService: boolean; readonly name: string; }`
  - `interface SpeechSynthesisUtteranceLike { readonly text: string; lang: string; voice?: SpeechSynthesisVoiceLike; onend: (() => void) | null; onerror: (() => void) | null; }`
  - `interface Speaker { speak(text: string): void; stop(): void; isSpeaking(): boolean; }`
  - `interface SpeakerHooks { onEnd?: () => void; }`
  - `function createSpeaker(synth: SpeechSynthesisLike | undefined, hooks?: SpeakerHooks): Speaker | null`(`synth === undefined` → `null`)
  - `function defaultSynthesis(): SpeechSynthesisLike | undefined`(读 `window.speechSynthesis`,结构化兼容即返回)
  - `function pickEnglishVoice(voices: readonly SpeechSynthesisVoiceLike[]): SpeechSynthesisVoiceLike | undefined`(纯函数:`lang === "en-US"` 优先于其他 `en-*`;`localService === true` 优先;同分按 `name` 字典序稳定排序)

- [ ] **Step 1: 写失败测试**

`speech.test.ts` 用一个可编程 fake synth(记录 `speak`/`cancel` 调用、固定 `getVoices()` 返回值、`speak(utterance)` 把 utterance 存起来供测试手动触发 `onend`)。用例:

1. `createSpeaker(undefined)` 返回 `null`。
2. `speak("hello")`:fake 收到一次 `speak`,utterance `.text === "hello"`、`.lang === "en-US"`、**voice 为 undefined**(fake voices 为空——lang 保底,不抛错)。
3. voices 非空:`pickEnglishVoice` 钉三档排序——`en-US` 本地 > `en-US` 网络 > `en-GB` 本地;空数组/无 en → `undefined`,且 `speak` 时 utterance `.voice` 取到首选。
4. 打断:`speak("a")` 后 `speak("b")` → fake 先收到 `cancel()` 再收到第二个 `speak`;`isSpeaking()` 为 true。
5. `stop()`:正在朗读时调用 → `cancel()` 被调、`hooks.onEnd` **同步**触发一次;再调一次 `stop()`(已停)→ `onEnd` 不再触发(幂等)。
6. 晚到的旧 onend:`speak("a")` → `speak("b")`(a 被打断)→ 测试手动触发 a 的 `onend` → `onEnd` 回调**不得**再次触发(b 仍在朗读);随后 b 的 `onend` 自然触发 → `onEnd` 触发一次、`isSpeaking()` 变 false。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd chrome-plugin && npx vitest run src/content/speech.test.ts`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 实现 `speech.ts`**

要点:模块持"当前 utterance"引用,`onend`/`onerror` 统一走一个守卫回调——仅当事件来自**当前** utterance 才清态并触发 `hooks.onEnd`(旧事件直接丢弃);`speak` 先 `cancel()` 再建新 utterance;`stop()` 若 `isSpeaking()` 则同步触发守卫回调后 `cancel()`。真实 `SpeechSynthesisUtterance` 满足 `SpeechSynthesisUtteranceLike`,`defaultSynthesis()` 用 `typeof window !== "undefined" && window.speechSynthesis !== undefined` 判空返回。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd chrome-plugin && npx vitest run src/content/speech.test.ts`
Expected: PASS 全绿。

- [ ] **Step 5: 提交**

```bash
git add chrome-plugin/src/content/speech.ts chrome-plugin/src/content/speech.test.ts
git commit -m "feat: speech.ts 朗读门面——语音挑选与打断语义(依赖注入)"
```

---

### Task 2: 句头整句朗读按钮

**Files:**
- Modify: `chrome-plugin/src/content/learning-block.ts`(renderCore 挂载点 552-559 一带、`#createChatAsk` 同款工厂方法、STYLES)
- Test: `chrome-plugin/src/content/learning-block.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `createSpeaker` / `defaultSynthesis` / `Speaker` / `SpeakerHooks`。
- Produces: `SyntaxLearningBlock` 构造函数新增可选第二参 `options?: { speakerFactory?: (hooks: SpeakerHooks) => Speaker | null }`(默认 `(hooks) => createSpeaker(defaultSynthesis(), hooks)`);按钮挂载约定 `button.speak[data-syntax-speak]`、`aria-pressed` 表达朗读态。

- [ ] **Step 1: 写失败测试**

`learning-block.test.ts` 加一组用例(fake speaker 记录调用、`isSpeaking()` 可控、`hooks` 可捕获):

1. 注入 fake 工厂 + `renderCore`:句区头部出现 `button.speak`(在 `.chat-ask` 之后);`renderFailure`/`renderSkipped` 渲染的句区**无** speak 按钮。
2. 注入返回 `null` 的工厂:全卡片无任何 `.speak` 按钮(降级隐藏,Review Focus 1)。
3. 点击句头喇叭 → fake `speak` 收到**整句文本** = `annotationEnglish(tokens, { startToken: 0, endToken: tokens.length - 1 })` 的结果(测试里用多 token、含句尾句号的句,断言尾标点被省略);按钮 `aria-pressed="true"`。
4. 朗读中再点同一喇叭(`isSpeaking()` 为 true)→ `stop()` 被调、fake 触发捕获的 `onEnd` → `aria-pressed` 回 `"false"`。
5. 点喇叭 A 朗读中点喇叭 B(另一次 renderCore 的句子)→ `speak(B 整句)` 被调,A 的按钮经 `onEnd`(旧守卫丢弃则不触发,由 fake 直接触发当前 hooks)回 `"false"`。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd chrome-plugin && npx vitest run src/content/learning-block.test.ts`
Expected: FAIL(无 speak 按钮)。

- [ ] **Step 3: 实现挂载**

构造函数存 `#speaker = options?.speakerFactory?.(hooks) ?? createSpeaker(defaultSynthesis(), hooks)`(`null` 安全保存);`hooks.onEnd` 实现 `#handleSpeakEnd()`:把 `#sentences` 内所有 `aria-pressed="true"` 的 `.speak` 复位(不缓存节点引用)。`#createSpeakButton(getText: () => string | undefined): HTMLButtonElement | null`——`#speaker` 为 null 或 `getText()` 为 undefined 时返回 null(不挂);点击:按钮 `aria-pressed === "true"` 且 `isSpeaking()` → `stop()`,否则置 `"true"` 后 `speak(getText())`。`renderCore` 里紧随 `#createChatAsk` 之后 `const speak = this.#createSpeakButton(() => annotationEnglish(tokens, { startToken: 0, endToken: tokens.length - 1 })); if (speak) sentenceElement.append(speak);`。句头按钮同时设 `dataset.syntaxSpeak = ""`(与 `data-syntax-chat-ask` 同款命名,E2E 定位用)。STYLES 加 `.speak`(复制 `.chat-ask` 图标按钮族:appearance:none、20px 圆形、opacity 0.45、`.sentence:hover`/`:focus-visible` 全显)+ `aria-pressed="true"` 态(opacity 1 + `color-mix` 背景,同 hover);喇叭用内联 SVG 常量 `SPEAKER_ICON`(简单 speaker 三角+弧线 path,与 `CHAT_ASK_ICON` 同款写法)。

- [ ] **Step 4: 跑测试确认通过(含全量回归)**

Run: `cd chrome-plugin && npm test`
Expected: PASS(现有用例默认路径下 happy-dom 无 `speechSynthesis` → 按钮不渲染,零扰动)。

- [ ] **Step 5: 提交**

```bash
git add chrome-plugin/src/content/learning-block.ts chrome-plugin/src/content/learning-block.test.ts
git commit -m "feat: 句头整句朗读按钮——speechSynthesis 降级隐藏与打断语义"
```

---

### Task 3: 详解面板条目朗读(含下钻面板)

**Files:**
- Modify: `chrome-plugin/src/content/learning-block.ts`(`#annotations` 748-800 一带、STYLES `.annotation` 相关)
- Test: `chrome-plugin/src/content/learning-block.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `#createSpeakButton` 工厂与 `.speak` 约定;`annotationEnglish(tokens, structure)`(已有)。
- Produces: 面板标注条目 DOM 约定 `.detail-annotations > .annotation-item > [.annotation(button 下钻), button.speak(朗读,仅完整渲染)]`;流式预览为 `.annotation-item > .annotation(span)`,无 speak。

- [ ] **Step 1: 写失败测试**

`learning-block.test.ts` 加用例(注入 fake speaker 工厂):

1. `renderDetail` 完整渲染:每个条目是 `.annotation-item` 包 `.annotation`(button)与 `button.speak` **兄弟**;`.annotation` 内部**无任何子 button**(Review Focus 4);点击条目喇叭 → fake `speak` 收到该条目 `annotationEnglish` 的英文文本(与标注块显示文本一致)。
2. `renderDetailStructures` 流式预览:条目是 `.annotation-item > .annotation(span)`,**无** `.speak`(未校验内容不朗读,与流式不下钻同原则)。
3. 下钻(再 `setDetailLoading` + `renderDetail` 子结构)后重画面板:新面板喇叭全部 `aria-pressed="false"`(Review Focus 5);下钻条目的喇叭点击 `speak` 收到子结构区间的文本。
4. 注入返回 `null` 的工厂:面板条目无 `.speak`,`.annotation-item` wrapper 与下钻行为不受影响。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd chrome-plugin && npx vitest run src/content/learning-block.test.ts`
Expected: FAIL(wrapper 不存在)。

- [ ] **Step 3: 实现条目 wrapper 与挂载**

`#annotations` 两个分支统一:每条目先建 `div.annotation-item`;完整渲染分支 `item.append(annotation, speak)`,speak 复用 `#createSpeakButton(() => english)`(`english` 是该条目已有的 `annotationEnglish(tokens, structure)` 结果,闭包捕获);流式分支只 `item.append(annotation)`。`annotations.append(item)`。STYLES:`.annotation-item { display: inline-flex; flex-direction: column; align-items: center; margin-inline-end: 0.75em; }`,`.annotation-item .speak { margin-block-start: 0.15em; }`(在标注英文行下方居中,不与下钻按钮区域重叠;现有 `.annotation` inline-grid 样式不动)。注意 `#annotations` 末尾的空文本条目 `continue` 逻辑不变。

- [ ] **Step 4: 跑测试确认通过(全量)**

Run: `cd chrome-plugin && npm test`
Expected: PASS(现有用例若以 `.annotation` 直查子元素仍命中——wrapper 只加外层)。

- [ ] **Step 5: 提交**

```bash
git add chrome-plugin/src/content/learning-block.ts chrome-plugin/src/content/learning-block.test.ts
git commit -m "feat: 详解面板条目朗读——annotation-item 兄弟喇叭,流式不挂"
```

---

### Task 4: E2E、文档同步与门禁

**Files:**
- Create: `chrome-plugin/tests/e2e/speak.spec.ts`
- Modify: `docs/architecture/modules.md`、`docs/architecture/rendering.md`

**Interfaces:**
- Consumes: Task 2/3 的 `.speak[data-syntax-speak]`?——注意句头与面板共用 `.speak` class,句头按钮加 `data-syntax-speak` 属性(与 `data-syntax-chat-ask` 同款命名)供 E2E 定位;面板喇叭以 `.annotation-item .speak` 定位。
- Produces: 无(收尾任务)。

- [ ] **Step 1: 写 E2E 用例**

`tests/e2e/speak.spec.ts`(沿用 `fixtures.ts` 的假服务器装载方式):core 渲染完成后——

1. 句头 `button.speak[data-syntax-speak]` 可见;点击 → `aria-pressed === "true"`(**点击后立即断言**,不等音频);再点 → `aria-pressed === "false"`(stop 同步回调)。
2. 点成分开面板 → 每条 `.annotation-item` 内有 `.speak`;点第一条 → pressed 切换真;点另一条 → 第一条回 false、第二条为 true。
3. 不 mock 语音、不断言音频与墙钟(真 Chrome 下 speak 真调用,macOS 有系统语音;无卡环境也只是不发声,状态断言不受影响)。

- [ ] **Step 2: 跑 E2E**

Run: `cd chrome-plugin && npx playwright test speak.spec.ts`
Expected: 实现完成后 PASS(本任务代码改文档与测试,E2E 应直接绿;若红,修 UI 实现而非断言)。

- [ ] **Step 3: 文档同步**

`modules.md` 加 `speech.ts` 一行(职责:朗读门面,依赖注入、语音挑选、打断语义);`rendering.md` 卡片结构与详解面板结构各补一句(句头朗读按钮、annotation-item 条目与兄弟喇叭、流式不挂、无 speechSynthesis 降级隐藏)。Run: `cd chrome-plugin && npm run docs:drift`,按输出核对涉及文件;`npm test` 里 `architecture-docs.test.ts` 自动钉新文件进模块地图。

- [ ] **Step 4: 全门禁**

Run: `cd chrome-plugin && npm test && npx playwright test && npm run lint && npm run format:check && npm run build`
Expected: 全绿;lint 恰好 1 个既有错误。

- [ ] **Step 5: 提交**

```bash
git add chrome-plugin/tests/e2e/speak.spec.ts docs/architecture/modules.md docs/architecture/rendering.md
git commit -m "test+docs: 朗读 E2E 探针与架构文档同步"
```
