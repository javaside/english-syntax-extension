# IntelliJ 插件朗读(design)

日期:2026-11-18
状态:待确认

## 意图

把 Chrome 扩展 1.6.0 的朗读能力(发音查证:句头整句/详解面板条目/面板焦点三层喇叭,打断与接管语义)移植到 IntelliJ 插件。JCEF 不支持 `speechSynthesis`(CEF 无语音合成引擎,调研已核实),朗读必须由 Kotlin 侧执行系统 TTS 命令,经桥协议驱动。

## 方案取舍(对话已定)

| 方案 | 结论 |
| --- | --- |
| A. Kotlin 桥 + 系统 TTS 命令(选定) | 与 Chrome 侧同音源(macOS `say` 即系统语音);三平台零依赖;桥门与取消闭环有 CHAT_ASK 完整先例 |
| B. JCEF 页面内 Web Speech API | CEF 无语音引擎,`getVoices()` 恒空、`speak()` 无声,`--enable-speech-synthesis` 开关无效——不可行 |
| C. 云端 TTS 音频 + `<audio>` 播放 | 需密钥/流量/缓存,与"发音查证"的轻量定位不符,放弃 |

## 交互(镜像 Chrome 侧,已确认)

- **句头整句朗读**:紧跟「问」按钮的小喇叭,读整句(尾标点省略);失败/跳过句不出现。
- **面板条目朗读**:标注是 `<button>`(可下钻),嵌套 button 非法——标注外包 wrapper,朗读按钮是**兄弟**;下钻到词级即单词发音;流式预览不挂。
- **面板焦点朗读**:面板顶部「朗读所选成分」,读当前详解区间;下钻/返回随重画换文本。
- **语义**:按下态走 `aria-pressed`;朗读中再点同一按钮=停,点新按钮=立即接管(跨面板);状态复位按 DOM 现查,不缓存节点。全部在 web 侧本地完成,Kotlin 只负责"出声/停声/报错"。

## 桥协议(防伪造门与 CHAT_ASK 同款)

JS → Kotlin:

- **`TTS_SPEAK`**:六键白名单 `version`/`type`/`previewId`/`generation`/`sentenceId`/`text`;sentenceId 非空;text 经 `trimJsWhitespace`(与 JS `.trim()` 逐字符一致)后 1..2000(与 CHAT_ASK question / FEEDBACK_REQUEST feedback 同值同款)。命中即停旧进程、起新朗读;**与 CHAT_ASK 同款刻意不设 STOPPED 静默门**——页面换代前的最后一击不该把按钮卡在按下态。
- **`TTS_STOP`**:五键白名单(无 text);命中即停。

Kotlin → JS:

- **`TTS_ERROR`**:`{previewId, generation, sentenceId, message}`——朗读失败(命令不存在/进程异常)时复位该句按钮并就地显示一句提示;正常结束**不**发消息(按下态由 web 侧点击时的本地 toggle 语义管理,与 Chrome 侧"stop 同步回调"对齐的简化:系统命令无 onend 流,结束时机不可观测,按钮在再次点击/接管时复位)。

JS 侧 `bridge.ts` 的 parse 与 Kotlin `BridgeProtocol.kt` 镜像(键白名单/守卫/generation 门槛)。**不碰 `contracts.json`**——它只钉 versions/roles/errorCodes/promptFirstLines,没有桥消息段;CHAT_ASK 的真实先例是靠 `BridgeProtocolTest.kt` ↔ `web/bridge.test.ts` 双端平行单测钉形状,TTS 沿用同款。

## Kotlin 侧:SpeechSpeaker

新文件 `tts/SpeechSpeaker.kt`:

- **平台命令**(参数数组传给 ProcessBuilder,不经 shell,无注入面;文本 UTF-8):
  - macOS:`say -v <voice> -- <text>`
  - Windows(PowerShell):`Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak('<escaped>')`(单引号转义;System.Speech 为 .NET 自带)
  - Linux:`spd-say -- <text>`,不存在时回落 `espeak`;都缺则回 `TTS_ERROR`(message 提示安装)
- **语音挑选(macOS)**:启动后惰性解析 `say -v ?` 的 en_US 列表,档序复刻 Chrome 侧精神——白名单(Samantha/Ava/Aria/Daniel/Eddy…) > 其他 en_US > novelty 黑名单(Albert/Bells/Whisper…)垫底;名单与 `chrome-plugin/src/content/speech.ts` 各自维护、注释互指。Windows/Linux 用命令默认语音(SAPI/spd 默认通常合理,不做挑选)。
- **进程生命周期**:**每个 PreviewSession 一个 speaker 实例**(多预览编辑器并存时各自独立——两页理论上可同时出声,视为可接受的罕见场景,换来按钮状态永远自洽、无误杀;全局互斥会让另一页按钮永久卡在按下态,协议里没有跨会话通知可救)。会话内至多一个朗读进程,speak 先 `destroy()` 旧进程;`shutdown()` 全停。执行器经构造注入(`CommandExecutor` seam:`start(command, args): ManagedProcess`),测试不真起进程。
- **接线**:`PreviewSession` 处理 `TTS_SPEAK/TTS_STOP`(launchTts 模板照 launchChatAsk:无 STOPPED 门、异常不逸散只回 TTS_ERROR);取消闭环三处追加 `speaker.shutdown()`——`stop()`、`onGenerationChanged()`、面板关闭(`disposePreview`,走 manager 长命 scope 防竞速,chat 同款)。

## web 侧:render.ts

- `#createSpeakButton(owner, getText)` 工厂(CHAT_ASK 同款内联 SVG 喇叭 + `aria-pressed`);点击:同按钮按下且朗读中 → 发 `TTS_STOP`;否则复位其余按下态、置位、发 `TTS_SPEAK`。**文本超 2000 字符(桥门上限)时不挂喇叭**——把超长视同「文本不可重建」(Chrome 侧 getText undefined 不挂的同款降级),不留点了被静默拒收的死按钮。
- 挂载三处:句头(653 行 `#createChatAsk` 之后)、面板条目 wrapper(`#renderDetailPanel` 标注外包 `english-syntax-annotation-item`)、面板焦点(返回按钮后,`#structureText` 按 focus 区间重建)。
- 文本来源:`#structureText`(等价 Chrome 侧 `annotationEnglish`);整句按全 token 区间重建。
- `preview.css` 补喇叭样式(`.english-syntax-speak`,chat-ask 同族:半透明、悬停显现、按下常显)。
- TTS_ERROR:bootstrap-entry 接 `TTS_ERROR` → 复位该句按下态 + 面板就地一行错误(REQUEST_CANCELLED 前缀中性处理,chat notice 先例)。

## 目标

1. 三层喇叭在 IDEA 预览页可用,交互与 Chrome 侧一致。
2. 桥门六/五键白名单 + text 上限,双端镜像,contracts 钉住。
3. 换代/停止/关面板三处停声;新朗读打断旧朗读。
4. Linux 无语音命令时按钮可点但明确报「未安装」,不留死按钮假象。

## 非目标

- 语速/音色设置、中文译文朗读、跟读高亮、Windows/Linux 语音挑选(用默认)、音频缓存。
- Chrome 扩展侧任何改动(朗读已在 1.6.0 就位)。

## 约束与已知坑

- **密钥红线**:TTS 全本地系统命令,不涉网络与凭据。
- **进程竞速**:speak 的 destroy-then-start 与 shutdown 可能交错——ManagedProcess 引用判空后销毁,synchronized 保护(单实例 speaker)。
- **PowerShell 转义**:text 内单引号翻倍;长度上限 2000 已在桥门挡住,不会撑爆命令行。
- **`say -v ?` 解析**:输出列名宽对齐,按行尾 `en_US` 标记过滤;解析失败回落不指定 voice(系统默认)。
- **测试不真起进程**:CommandExecutor seam;web 侧 vitest 断言桥消息形状与 DOM 行为,不 mock 语音。
- 桥新消息**三处同步**:bridge.ts parse、BridgeProtocol.kt parsePageMessage、preview.ts/connector 接线;双端镜像单测钉形状(漏一处对应测试红,CHAT_ASK 先例)。

## 交付物

- `intellij-plugin/src/main/kotlin/.../tts/SpeechSpeaker.kt`(+ CommandExecutor seam)
- `BridgeProtocol.kt`:parseTtsSpeak/parseTtsStop/TTS_ERROR host 守卫
- `PreviewSession.kt`:launchTts + 三处 shutdown 接线;`PreviewSessionConnector.kt` 接线
- `resources/web/`:render.ts 三层喇叭、bridge.ts 消息、preview.css 样式、bootstrap-entry TTS_ERROR 处理(不动 contracts.json)
- 测试:Kotlin(SpeechSpeaker/桥门/取消闭环)、web vitest(挂载/接管/桥形状;与 Kotlin 侧测试互为镜像)
- 文档:`modules.md`、`rendering.md`(IntelliJ 小节)、`protocol.md`(IntelliJ 桥小节)

## 留给实现者

- `say -v ?` 输出的精确解析(实测格式)与语音名单常量放置。
- TTS_ERROR 在面板的就地呈现样式(复用 feedback error 槽先例)。
- E2E/真机验收脚本(`.superpowers/acceptance/`,gitignored):macOS 实测三层喇叭与打断。
