# 朗读逐词进度(research):精确同步在云端路径不可达,功能搁置

日期:2026-11-25
状态:**搁置**(用户裁决,见下)

## 需求与裁决记录

原始需求:朗读英文时,直观看到**当前语句的朗读进度**。

本次对话中的两次裁决:

1. **形态**:逐词高亮(当前读到的词加亮)+ 所属句法成分底色同步点亮(「逐词+成分结合」)。
2. **精确性**:词级进度必须与音频**精确同步**;估算/插值不可接受——「我需要精确同步,否则没什么意义。做不到精确就先放着,功能暂时不做。」

本文档是搁置决策的调研依据与重启条件清单,不是待实施的 design。

## 现状链路(调查快照)

- 朗读两条路径(`chrome-plugin/src/content/speech.ts`):**云端 TTS**(选项页配置,`TTS_SYNTHESIZE` → SW fetch OpenAI 兼容 `/v1/audio/speech` → WebAudio 播放,失败回落本地)与**本地 `speechSynthesis`** 兜底。云端是 1.8.0 主推路径。
- 朗读粒度:一次点击读一句或一个成分(句头整句 / 面板条目 / 面板焦点,`learning-block.ts` 的 `#createSpeakButton`)。
- 进度反馈现状:只有喇叭按钮按下态(`aria-pressed`)+ ☁ 云端来源胶囊,**无任何读到哪里的指示**。
- 朗读文本与卡片 DOM 同源于 token(`annotationEnglish` 重建),`charIndex → token → component` 的映射是确定性可算的——**映射层可行,不是搁置原因**。

## 核心结论:词级精确同步可行性矩阵

| 路径 | 词级时间信息来源 | 精确? |
| --- | --- | --- |
| 本地 `speechSynthesis` + 本地语音(macOS) | `onboundary` 事件(name="word",`charIndex`/`charLength` 精确对齐词边界) | ✅ 真机已验证 |
| 本地 `speechSynthesis` + Chrome 网络语音(Google,海外用户的 Chrome 会列出且当前优选第一档) | 无——Chrome 网络语音不发 boundary 事件 | ❌ |
| 云端 TTS(OpenAI 兼容 `/v1/audio/speech`) | 无——协议只回音频字节,不提供词级时间戳;WebAudio 仅知精确总时长 | ❌ |

**搁置的直接原因**:产品主推的云端路径拿不到词级时间戳,唯一出路是插值估算,已被精确性裁决否决。只在本地路径做 = 云端用户无词级进度,形态不完整,同样不满足裁决。

## 真机实测(2026-11-25,macOS 26.5 / Chrome 158,本机)

方法:空白页探针按钮(真实点击满足 Chrome 71+ 用户激活要求),逐语音朗读测试句,记录 `onboundary`/`onstart`/`onend`。

环境:`getVoices()` 共 41 个英文语音,**全部 `localService=true`,无 Google 网络语音**(国内网络环境,Google 网络语音不列出)。即当前 `pickEnglishVoice` 在本机实际选中 Samantha(白名单第一档、boundary 可用)。

实测样本(逐词事件数 = 句子词数,charIndex/charLength 与词边界逐一吻合):

- "The development of applications requires a systematic approach."(8 词)
  Samantha → 8 个 `word` 事件:`(0,3) (4,11) (16,2) (19,12) (32,8) (41,1) (43,10) (54,9)`,即 The/development/of/applications/requires/a/systematic/approach。
- "The compiler translates the source code into machine instructions."(9 词)
  Eddy(美)→ 9 事件;Daniel → 9 事件;Reed(美)→ 9 事件,样本 `(0,3) (4,8) (13,10) (24,3) …` 即 The/compiler/translates/the。

结论:macOS 本地优质语音(Samantha/Eddy/Daniel/Reed)的 boundary 事件**逐词精确**;本地路径技术上已可精确(至少本机如此)。

## 重启触发条件(满足其一即可重开)

1. **云端 TTS 提供词级时间戳**:换/加支持时间戳的合成服务(Azure Speech 的 word boundary 事件、Amazon Polly speech marks、ElevenLabs with-timestamps 一类),协议从「只回音频」扩为「音频 + 词时间戳」(`TTS_AUDIO` 增可选字段,协议三层校验同步)。绑定特定供应商或需能力探测,改动面大——2026-11-25 对话中方案 C(换云端服务)已因此被否决过一次,重启时按新供应商能力重新评估。
2. **浏览器端 forced alignment 轻量化成熟**:用 WASM/ONNX 对齐器把已知文本对齐到云端音频。技术可行但对句法学习扩展不成比例(模型体积 + 每句计算),当前列为理论出路。
3. **Chrome 网络语音开始发 boundary 事件**(Chromium 长期缺陷,见参考):只影响海外用户的本地路径优选语音,不解决云端,**单独不构成重启条件**;若将来本地路径独立立项(接受「云端无词级进度」的割裂形态),它或「把 Google 语音降档(音质换进度)」是前置条件。

## 若重启:本次已想清楚的设计资产

- **映射层**:`onboundary` 的 `charIndex` 相对 utterance 文本(= `annotationEnglish` 重建文本);按同款口径逐 token 累计字符偏移(首 token 去前导空白、区间末标点省略)即得每 token 的字符区间;命中 token → `.component[data-start-token…data-end-token]` 包含即成分。词高亮需在 `.english`/`.annotation-english` **渲染时**逐词包 span(现为纯文本节点;词 span 不是 button,不破坏 E2E 的 `.annotation button` 计数断言)。
- **Speaker seam**:`SpeakerHooks` 增 `onWord(charIndex, charLength)`;`SpeechSynthesisUtteranceLike` 增 `onboundary`;本地路径事件直发,云端路径(触发条件 1 达成后)按响应时间戳 + 播放时钟驱动。**裁决禁插值,不实现估算兜底。**
- **CloudSpeaker 单例的 hooks 定向坑**:`createCloudSpeaker` 的 `hooksSet` 广播是「结束复位所有块」语义;进度消费必须定向到**发起朗读的那个块**(如复用 aria-pressed 按下态 DOM 查询定位进度宿主),不能照抄广播。
- **测试口径**:单测经 `speakerFactory`/`SpeechSynthesisLike` 注入 fake 合成器驱动 `onboundary`(happy-dom 无 `speechSynthesis`,seam 已在);E2E 不赌真机语音环境(headless CI 无 macOS 本地语音保证),沿用「挂载 + 按下态」断言,进度逻辑由单测钉住。
- **衔接**:`2026-11-16-sentence-word-tts-design.md` 当年把「onboundary 跟读高亮」列为非目标(本地-only 时代);`2026-11-18-cloud-tts-design.md` 引入云端后,本文档是对该形态的正式复核结论。
- 独立小改进(与本功能解耦,可单独做):云端合成等待期(点喇叭到出声 1–8s)目前只有按钮亮着,可加「合成中…」微反馈避免被误读为卡死。

## 参考

- [issues.chromium.org/issues/40715888](https://issues.chromium.org/issues/40715888) — SpeechSynthesisUtterance.onboundary does not fire(网络语音不发事件;含「为省带宽有意不带 boundary 数据」的猜测)
- [crbug.com/521666](https://crbug.com/521666) — 同主题历史 issue(SO 答案引用)
- [MDN: SpeechSynthesisUtterance boundary_event](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesisUtterance/boundary_event)
- [SO: onboundary event not firing properly](https://stackoverflow.com/questions/51645956/speechsynthesisutterance-onboundary-event-not-firing-properly) — 「Chrome 的 Google 语音不发 boundary」的一手出处
- [SO: onBoundary doesn't fire on Ubuntu](https://stackoverflow.com/questions/75177288/onboundary-event-doesnt-fire-in-chrome-on-ubuntu-20-04-and-above) — 全网络语音平台上事件全缺
- 本机实测:本文档「真机实测」节,2026-11-25。
