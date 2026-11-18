# IntelliJ 插件朗读 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** IntelliJ 插件预览页获得与 Chrome 扩展对等的朗读(句头整句/面板条目/面板焦点三层喇叭),Kotlin 侧经系统 TTS 命令发声,桥协议防伪造门与 CHAT_ASK 同款。

**Architecture:** web 侧 `render.ts` 管喇叭 UI 与按下态(本地 toggle/接管,镜像 Chrome 语义);点击经构造回调 → `bootstrap-entry` 发 `TTS_SPEAK`/`TTS_STOP` 桥消息;Kotlin `BridgeProtocol` 白名单门 → `PreviewSession.launchTts` → `SpeechSpeaker`(每会话一个,`CommandExecutor` seam)执行 `say`/PowerShell/`spd-say`;失败回 `TTS_ERROR` 复位按钮。

**Tech Stack:** Kotlin(IntelliJ Platform, JCEF 桥)、TypeScript(预览页 web 侧, vitest)、Gradle + npm 双门禁。

**Spec:** `docs/superpowers/specs/2026-11-18-intellij-tts-design.md`

## Global Constraints

- **不碰 contracts.json**(spec 裁决:桥形状靠 `BridgeProtocolTest.kt` ↔ `web/bridge.test.ts` 双端镜像单测钉住,CHAT_ASK 先例)。
- 桥门:`TTS_SPEAK` 六键白名单 `version/type/previewId/generation/sentenceId/text`,text 经 `trimJsWhitespace`(Kotlin)/`.trim()`(web,同一字符集)后 1..2000;`TTS_STOP` 五键(无 text);sentenceId 非空。与 CHAT_ASK 同款**不设 STOPPED 静默门**。
- 每个预览会话一个 speaker(多预览各自独立,spec 裁决);会话内新朗读先销毁旧进程。
- 文本超 2000 字符时**不挂喇叭**(spec 裁决,视同文本不可重建,Chrome 同款降级)。
- 正常结束不发 host 消息;失败(`TTS_ERROR`: previewId/generation/sentenceId/message)复位按钮。
- Chrome 扩展侧**零改动**。
- 提交信息中文主题;执行前置:从 main 切 `feature/intellij-tts`(worktree 惯例)。
- Kotlin 测试不真起进程(CommandExecutor seam);web 测试不 mock 语音。
- 门禁:`(cd intellij-plugin && npm test)` + 仓库根 `./gradlew :intellij-plugin:test :intellij-plugin:buildPlugin :intellij-plugin:verifyPluginProjectConfiguration`。

## Review Focus

1. **超长文本(>2000)不挂喇叭** → Task 4 Step 1 钉(长句无 `[data-english-syntax-speak]`)。
2. **桥门伪造向量**(多余键/text 空/超长/sentenceId 空/缺 generation) → Task 1 Step 1 双端同一组向量钉。
3. **换代/停止/关面板三处停声** → Task 3 Step 1 钉(fake executor 断言 `destroy()`)。
4. **同会话新朗读先销毁旧进程** → Task 2 Step 1 钉(speak 两次 → 第一进程 destroyed)。
5. **Linux 无语音命令 → TTS_ERROR 明示**(不留死按钮) → Task 3 Step 1 钉(executor 抛 NotFound → 页面收到 TTS_ERROR)。

---

### Task 1: 桥协议双端镜像(TTS_SPEAK / TTS_STOP / TTS_ERROR)

**Files:**
- Modify: `intellij-plugin/src/main/resources/web/bridge.ts`
- Modify: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/bridge/BridgeProtocol.kt`
- Test: `intellij-plugin/src/main/resources/web/bridge.test.ts`、`intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/bridge/BridgeProtocolTest.kt`

**Interfaces:**
- Produces(web): `TtsSpeakPageMessage extends PageMessageBase { type: "TTS_SPEAK"; sentenceId: string; text: string }`、`TtsStopPageMessage extends PageMessageBase { type: "TTS_STOP" }`、`TtsErrorHostMessage extends PageMessageBase { type: "TTS_ERROR"; sentenceId: string; message: string }`;`PAGE_KEYS_BY_TYPE` 增 `TTS_SPEAK: ["version","type","previewId","generation","sentenceId","text"]`、`TTS_STOP: ["version","type","previewId","generation"]`;parse/parseHostMessage 各增 case(trim 后 1..2000,上限常量与 FEEDBACK 同源)。
- Produces(Kotlin): `PageMessage.TtsSpeak(previewId, generation, sentenceId, text)`、`PageMessage.TtsStop(previewId, generation)`、`HostMessage.TtsError(previewId, generation, sentenceId, message)` + toJson;`parsePageMessage` 增 `"TTS_SPEAK" -> parseTtsSpeak(...)`/`"TTS_STOP" -> parseTtsStop(...)`(hasOnlyKeys + trimJsWhitespace + `MAX_TTS_TEXT_CHARACTERS = 2000`)。

- [ ] **Step 1: 写双端失败测试(同一组向量)**

web `bridge.test.ts` 新 describe「TTS 桥门」:合法 TTS_SPEAK parse 成功且 text 为 trim 后值;多余键/空 text/trim 后空/2001 字符/空 sentenceId → null;TTS_STOP 合法/带多余 text 键 → null;TTS_ERROR host parse 成功、generation 不等 → null。Kotlin `BridgeProtocolTest.kt` 镜像同名用例(向量逐条一致,含 trim 边界 U+FEFF)。

- [ ] **Step 2: 跑双侧确认失败**

Run: `cd intellij-plugin && npx vitest run src/main/resources/web/bridge.test.ts`
Expected: FAIL(消息未定义)。`./gradlew :intellij-plugin:test --tests '*BridgeProtocolTest*'` 同 FAIL。

- [ ] **Step 3: 实现双侧消息与门**

照 CHAT_ASK/FEEDBACK_REQUEST 先例:web 侧接口 + 白名单 + parse case;Kotlin 侧 data class + parse 函数 + HostMessage.TtsError + toJson。web 侧 trim 用 `.trim()`(与既有 question/feedback 门同源)。

- [ ] **Step 4: 双侧跑绿**

Run: 上两条命令。Expected: 双侧 PASS。

- [ ] **Step 5: Commit**

```bash
git add intellij-plugin/src/main/resources/web/bridge.ts intellij-plugin/src/main/resources/web/bridge.test.ts intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/bridge/BridgeProtocol.kt intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/bridge/BridgeProtocolTest.kt
git commit -m "feat: TTS 桥协议双端镜像——六/五键门与 TTS_ERROR"
```

---

### Task 2: Kotlin SpeechSpeaker(系统命令 + 进程生命周期)

**Files:**
- Create: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/tts/SpeechSpeaker.kt`
- Test: `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/tts/SpeechSpeakerTest.kt`

**Interfaces:**
- Produces:
  - `interface CommandExecutor { fun start(command: String, args: List<String>): ManagedProcess; fun available(command: String): Boolean }`
  - `interface ManagedProcess { fun destroy(); fun await(): Int }`
  - `class SpeechSpeaker(private val executor: CommandExecutor = ProcessCommandExecutor(), private val osName: String = System.getProperty("os.name"))` with `fun speak(text: String)`(新朗读先 destroy 旧进程;voice 选择仅 macOS)、`fun stop()`、`fun shutdown()`;`speak` 抛 `SpeechUnavailableException`(message 含安装提示)当平台命令不可用。
  - `fun pickMacVoice(voiceLines: List<String>): String?`(纯函数,解析 `say -v ?` 行,档序:白名单命中(Samantha/Ava/Aria/Daniel/Eddy/Flo/Reed/Rocko/Sandy/Shelley…) > 其他 en_US > novelty 黑名单(Albert/Bells/Whisper/Boing…)排除;名单注释指向 `chrome-plugin/src/content/speech.ts` 同源维护)。

- [ ] **Step 1: 写失败测试**

`SpeechSpeakerTest.kt`(fake executor 记录 start/destroy/available):①speak 两次 → 第一进程 destroy 被调、第二进程 start 参数含新文本;②stop/shutdown → 当前进程 destroy;③macOS 平台 speak → 命令 `say`、args 含 `-v` 与选中的 voice;④`available=false` → `SpeechUnavailableException`;⑤`pickMacVoice` 三档排序 + 解析失败(空行/无 en_US)返回 null(回落默认 voice);⑥Windows 平台 → PowerShell 命令,文本单引号转义( `'` → `''` );⑦Linux → `spd-say`,不可用回落 `espeak`,都缺抛异常。

- [ ] **Step 2: 跑测试确认失败**

Run: `./gradlew :intellij-plugin:test --tests '*SpeechSpeakerTest*'`
Expected: FAIL(类不存在)。

- [ ] **Step 3: 实现 SpeechSpeaker.kt**

`synchronized(this)` 保护进程引用;macOS voice 惰性解析一次(`executor.start("say", listOf("-v","?"))` 读输出或注入 `voiceListReader: () -> List<String>` seam,测试注入假列表);PowerShell 用 `powershell -NoProfile -Command Add-Type...;Speak('...')` 参数数组。

- [ ] **Step 4: 跑绿** — 同 Step 2 命令,Expected PASS。

- [ ] **Step 5: Commit** — `git add` 两文件,`git commit -m "feat: SpeechSpeaker——分平台系统 TTS 与进程生命周期"`。

---

### Task 3: PreviewSession 接线(launchTts + 三处停声)

**Files:**
- Modify: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/session/PreviewSession.kt`(构造参数 + launchTts + stop()/onGenerationChanged 追加)
- Modify: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/session/PreviewSessionConnector.kt`(when 分派)
- Modify: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/session/PreviewSessionManager.kt`(disposePreview 追加,如 speaker 挂在 session 则经公开方法)
- Test: `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/session/PreviewSessionTest.kt`

**Interfaces:**
- Consumes: Task 1 的 `PageMessage.TtsSpeak/TtsStop`、`HostMessage.TtsError` + toJson;Task 2 的 `SpeechSpeaker`。
- Produces: `PreviewSession` 构造新增 `private val speaker: SpeechSpeaker = SpeechSpeaker()`(测试注入 fake);`fun launchTts(sentenceId: String, text: String)`、`fun stopSpeech()`;connector 增 `is PageMessage.TtsSpeak -> session.launchTts(message.sentenceId, message.text)`、`is PageMessage.TtsStop -> session.stopSpeech()`。

- [ ] **Step 1: 写失败测试**

PreviewSessionTest(fake speaker 记录调用;fake sender 记录 host JSON):①TtsSpeak → speaker.speak(text);②speak 抛 `SpeechUnavailableException` → 页面收到 `TTS_ERROR`(sentenceId 匹配、generation 等值),异常不逸散;③stop() → speaker.shutdown;④onGenerationChanged → shutdown;⑤stopSpeech → speaker.stop;⑥STOPPED 会话发 TtsSpeak 仍执行(launchTts 无状态门,与 launchChatAsk 同款)。

- [ ] **Step 2: 确认失败** — `./gradlew :intellij-plugin:test --tests '*PreviewSessionTest*'` FAIL。

- [ ] **Step 3: 实现**

launchTts 在 scope 外直接调用(同步、轻量),异常 catch 后经 sender 发 Tts_ERROR(照 CHAT_ERROR 的 buildJsonObject 先例);stop()/onGenerationChanged() 各追加一行 `runCatching { speaker.shutdown() }`;manager disposePreview 经 session.stopSpeech()。

- [ ] **Step 4: 跑绿 + Kotlin 全量** — `./gradlew :intellij-plugin:test` PASS。

- [ ] **Step 5: Commit** — `git commit -m "feat: 预览会话 TTS 接线——launchTts 与三处停声"`。

---

### Task 4: web 渲染三层喇叭

**Files:**
- Modify: `intellij-plugin/src/main/resources/web/render.ts`
- Modify: `intellij-plugin/src/main/resources/preview.css`(若样式在别处按实际调整)
- Test: `intellij-plugin/src/main/resources/web/render.test.ts`

**Interfaces:**
- Consumes: 无(消息发送经构造回调,DETIAL_REQUEST 的 `DetailRequestHandler` 先例)。
- Produces: `PreviewRenderer` 构造选项新增 `requestSpeak?: (sentenceId: string, text: string) => void`、`requestStopSpeak?: () => void`;公开方法 `speakFailed(sentenceId: string): void`(复位该句按下态);`#createSpeakButton(owner, getText, label?)`、`#tokensText(tokens, start, end)`(首 token 去前导空白、区间末尾标点省略——Chrome `annotationEnglish` 口径);DOM:`button.english-syntax-speak[data-english-syntax-speak]` + `aria-pressed`;面板条目 wrapper `english-syntax-annotation-item`。

- [ ] **Step 1: 写失败测试**

render.test.ts 新 describe「朗读」(注入 requestSpeak/requestStopSpeak 记录调用):①core 成功句句头有喇叭(「问」后),失败句无;②点击 → requestSpeak(sentenceId, 整句文本= tokens 重建、尾标点省略),`aria-pressed=true`;③按下时再点 → requestStopSpeak、复位;④点另一喇叭 → 旧复位新置位、无 stop 调用(接管);⑤面板完整渲染条目有兄弟喇叭(wrapper 内 annotation 与 speak 平级,annotation 无嵌套 button)、点击读 structure.text;流式(span)不挂;⑥面板焦点喇叭读 focus 区间 tokens 文本;⑦文本 2001 字符 → 该句无喇叭;⑧`speakFailed` 复位按下态;⑨不传 requestSpeak → 无喇叭(降级)。

- [ ] **Step 2: 确认失败** — `cd intellij-plugin && npx vitest run src/main/resources/web/render.test.ts` FAIL。

- [ ] **Step 3: 实现**

`#createSpeakButton` 镜像 Chrome 侧语义(点击: pressed && speaking → stop 回调;否则全局复位 + 置位 + speak 回调;speaking 状态 = 任一按钮 pressed,本地判定);句头挂载在 `#createChatAsk` append 之后;`#renderDetailPanel` 条目包 wrapper、焦点喇叭在返回按钮后;超长与回调缺失都返回不挂。preview.css 加 `.english-syntax-speak`(chat-ask 同族)与 `.english-syntax-annotation-item`。

- [ ] **Step 4: 跑绿 + web 全量** — `cd intellij-plugin && npm test` PASS。

- [ ] **Step 5: Commit** — `git commit -m "feat: 预览页三层朗读喇叭——按下态与接管语义"`。

---

### Task 5: bootstrap 接线、bundle、文档与全门禁

**Files:**
- Modify: `intellij-plugin/src/main/resources/web/bootstrap-entry.ts`
- Modify: `docs/architecture/modules.md`、`docs/architecture/protocol.md`(IntelliJ 桥小节)、`docs/architecture/rendering.md`(IntelliJ 小节)

**Interfaces:**
- Consumes: Task 3/4 的全部产物;Task 1 的桥 parse(发送侧用既有 page 消息发送通路,CHAT_ASK 同款)。
- Produces: 无(收尾)。

- [ ] **Step 1: 写失败测试**

bootstrap-lifecycle.test.ts(既有形态):initialize 时 renderer 收到 requestSpeak 回调 → 调用它后 bridge 收到 TTS_SPEAK(六键);requestStopSpeak → TTS_STOP;host 推 TTS_ERROR(generation 等值)→ renderer.speakFailed 被调(经 seam/ spy)。

- [ ] **Step 2: 确认失败** — `npx vitest run src/main/resources/web/bootstrap-lifecycle.test.ts` FAIL。

- [ ] **Step 3: 实现接线**

bootstrap 构造 PreviewRenderer 时传两回调(发桥消息:构造 previewId/generation 从 state);host 消息 switch 增 `case "TTS_ERROR":` → `renderer.speakFailed(msg.sentenceId)`(generation 门已由 parseHostMessage 顶部把关)。

- [ ] **Step 4: bundle 重建 + 全门禁**

Run: `cd intellij-plugin && npm run bundle-web && npm test`,仓库根 `./gradlew :intellij-plugin:test :intellij-plugin:buildPlugin :intellij-plugin:verifyPluginProjectConfiguration`。Expected: 全绿。

- [ ] **Step 5: 文档同步**

modules.md 加 `tts/SpeechSpeaker.kt` 行;protocol.md IntelliJ 桥小节补 TTS 三消息与门;rendering.md IntelliJ 小节补三层喇叭与降级。`npm run docs:drift`(chrome-plugin 的,仅参考)、按 AGENTS.md 表格核对 IntelliJ 侧文档。

- [ ] **Step 6: Commit** — `git commit -m "feat+docs: 预览页朗读接线与架构文档同步"`。
