# 硅基流动云端朗读集成(design)

日期:2026-11-18
状态:已批准(builder check 四项裁决已并入)

## 意图

朗读增加**可选云端语音源**(硅基流动 SiliconFlow,OpenAI 兼容 `/v1/audio/speech`):神经 TTS 音质远超系统语音;默认关,不配置时行为与现状完全一致。对话已定:独立 TTS 配置(不挂 profile)、失败回落本地、P0 不做音频缓存、Chrome 用 mp3/IDEA 用 wav。

## Chrome 扩展

- **配置**:options 页新增「朗读语音源」节(开关 + baseUrl 预填 `https://api.siliconflow.cn/v1` + apiKey + model 预填 `FunAudioLLM/CosyVoice2-0.5B` + 音色下拉预置 anna/alex/benjamin/charles/david/diana)。存 `chrome.storage.local` 键 `tts-source`;保存时经 `hostPermissionPattern(baseUrl)` 申请 optional host 权限(与 profile 同款现有流程,**零 manifest 改动**——`optional_host_permissions` 已含 `https://*/*`)。
- **协议(新消息,四处同步)**:`TTS_SYNTHESIZE`(content→SW,`{type, text}`,text trim 后 1..2000 拒收门外)→ SW 校验 TTS 配置存在后 `POST /v1/audio/speech`(`{model, input, voice, response_format:"mp3"}`,Authorization 头)→ 成功回 `TTS_AUDIO`(`{audioBase64, mime}`),失败回既有 ERROR。同步点:①`protocol.ts` Request/Response 类型 ②SW 校验路由 ③content `isRuntimeResponse` case ④content 路由开头入站拒绝列表(content-only 发送方)。**apiKey 只存 SW 侧 storage,永不下发 content**。
- **快照**:START_SESSION 的会话快照增 `tts: { enabled: boolean }`——content 只需知道选哪个 Speaker 实现,密钥/URL 细节全在 SW。
- **content**:`CloudSpeaker implements Speaker`——**每 documentId 单例**(builder check 裁决 1:现状每块一个 Speaker,跨块接管靠 speechSynthesis.cancel 的全局副作用,换 Audio 后消失;单例经 learningBlockFactory 注入所有块共享)。`speak(text)` 发 `TTS_SYNTHESIZE`(内部记「当前请求」的 onEnd 回调,新请求作废旧请求),`TTS_AUDIO` 回来后 `Audio(dataUri)` 播放,`onended/onerror → 当前请求的 hooks.onEnd`(跨块接管时旧块按钮同步复位);`stop()` 停 Audio 并作废在途。**失败回落**:ERROR/超时 → 单例内常驻的本地 fallback speaker 出声 + 进度胶囊提示一次。快照 `tts.enabled` 决定 content-script 装配单例与否。
- **显式手势会话(选中/悬停/右键)保持本地语音**(builder check 裁决 2):冷启动不走 START_SESSION 拿不到快照,扩协议面成本不成比例;可感知差异仅为音质,后续有需求再扩。
- **调度/缓存**:云端合成走 SW 内联 fetch,不进模型调度器;P0 无缓存(重复点击现拉)。

## IntelliJ 插件

- **设置**:`EnglishSyntaxConfigurable` 增「朗读语音源」节(同款五字段 + 测试按钮,测试走一次 5 字符合成);持久化进 `ProfileState` 独立键(与 profile 平级,**密钥走 PasswordSafe**,不进 XmlSerializer 明文)。
- **Kotlin**:`CloudSpeechSpeaker(fallback: SpeechSpeaker, onSpeakError: (String) -> Unit) : SpeechSpeaker`——**`speak` 立即返回**(builder check 裁决 3:调用链在 JBCefJSQuery 泵上,阻塞会停摆全部桥消息):内部 `scope.launch { 取消旧任务 → OkHttp POST(`response_format:"wav"`,超时 5s) → 临时文件 → Clip 播放 }`;任何异常回落 `fallback.speak(text)`,双双失败才 `onSpeakError(message)`(异步 TTS_ERROR)。`stop()/shutdown()` cancel 在途协程与 Clip。**配置懒读**(builder check 裁决 4:PasswordSafe 是 suspend+IO 而装配链在 EDT):恒构造 CloudSpeaker 包装本地兜底,首次 speak 于 IO 协程读凭据(5s 级缓存),禁用/无配置直接走 fallback——设置改动下次点击生效,装配链零改动。
- **桥协议零改动**:`TTS_SPEAK/TTS_STOP/TTS_ERROR` 照旧——云端化被封装在 SpeechSpeaker 实现内部。

## 目标

1. 配置硅基流动后,双端喇叭播神经 TTS 音质;未配置时双端与 1.7.0 行为逐字节一致。
2. 云端任何失败(网络/鉴权/超时)自动回落本地语音,朗读永远有声。
3. Chrome 侧新消息四处同步、密钥不进 content;IDEA 侧密钥进 PasswordSafe。
4. 停止/接管/三处停声语义与现状完全一致(实现层替换,状态机不动)。

## 非目标

音频缓存、音色试听流式、语速/音量参数、非 OpenAI 兼容提供商、多 TTS 源切换、Chrome 侧弹层显示云端错误详情(回落提示即可)。

## 约束与已知坑

- **Chrome 协议红线**:新消息四处同步缺一处 = 既知事故模式(isRuntimeResponse 漏 case 会把成功静默换成 ERROR;入站拒绝列表漏了会让页面伪造直达 SW)。
- content 的 CloudSpeaker 异步等 SW 响应:同句连点竞态由既有「点新喇叭先复位」+ Speaker 单实例串行化;`stop()` 时在途请求作废(requestId 匹配,迟到音频丢弃)。
- Kotlin Clip 每次播放需新实例( reuse 会截断);临时文件播完删。
- 硅基流动 voice 字段要带模型前缀(`FunAudioLLM/CosyVoice2-0.5B:anna`)——设置页存短名,请求时拼。
- E2E:假服务器加 `/v1/audio/speech` 端点(返回 1 帧静音 mp3/wav),断言 fetch 计数与回落路径;不 mock 音频解码。

## 交付物

- Chrome:`protocol.ts`/`service-worker.ts`(路由+fetch)/`speech.ts`(CloudSpeaker+回落)/`options.*`(设置节+权限)/快照透传;单测+E2E 各一组
- IDEA:`tts/CloudSpeechSpeaker.kt`、设置页节、PreviewSession 装配;Kotlin 测试(fake OkHttp seam)
- 文档:`protocol.md`(TTS_SYNTHESIZE/TTS_AUDIO)、`model-pipeline.md`(云端语音源)、`rendering.md`/`build-test-release.md` 顺带
- CHANGELOG 1.8.0

## 留给实现者

- 音色下拉的完整枚举(以硅基流动文档为准,预置 6-8 个英文音色)
- CloudSpeaker 的超时常数(与 profile.timeoutMs 对齐还是独立 10s——独立,合成非聊天)
- IDEA 测试按钮的反馈形态(复用连接测试的 balloon 先例)
