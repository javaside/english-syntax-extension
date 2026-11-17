# 句子与单词朗读(design)

日期:2026-11-16
状态:待确认

## 意图

角色经对话确认:朗读是**发音查证**——用户遇到不会读的词、或没把握断句的长句,点一下听正确读音;不是磨耳朵的听力模式。触发方式为点击(不做悬停自动出声)。

两层挂载(用户已选):

- **卡片层 → 读整句**:每个句子的译文行旁加小喇叭按钮,点击朗读整句原文;不碰成分点击(照旧开详解面板)。
- **详解面板层 → 读条目**:面板内每个成分条目、以及下钻后的子结构条目(衔接 `2026-11-16-detail-drill-down`)旁配小喇叭,点谁读谁——下钻到最底层即单词发音。查结构与查发音同一条路径。

## 方案取舍

| 方案 | 结论 |
| --- | --- |
| A. content script 直接用 `speechSynthesis`(选定) | 零权限、零协议、零设置;本地免费;语音可选系统 + Chrome 内置 Google 网络语音 |
| B. `chrome.tts` 经 service worker | 语音实例与页面隔离,但要加 `"tts"` 权限、新增消息(三层校验 + 入站拒绝列表五处同步),且只有系统引擎语音、拿不到 Google 网络语音——付协议的钱换更差的质量,放弃 |
| C. 云端 TTS(`/v1/audio/speech`) | 音质最好但按字符付费、需音频缓存,且用户的 DeepSeek 端点无 audio API,放弃(未来可复议) |

## 目标

1. 卡片每个句子配小喇叭,点击朗读整句原文。
2. 详解面板内每个成分/子结构条目配小喇叭,点击朗读该条目覆盖的原文;下钻面板逐级可用。
3. 点新喇叭 = 打断旧朗读立即换新;朗读中再点同一喇叭 = 停止。
4. 朗读文本按 token 区间重建可见原文(`annotationEnglish` 同款口径:前导空白保留、区间末尾标点省略);句子级用整句文本。
5. `speechSynthesis` 不可用时按钮隐藏降级,不留死按钮。

## 非目标

- 中文译文朗读;语速/音色设置(要设置就得走 SW 的 `START_SESSION` 快照链路,P0 刻意不碰);`onboundary` 跟读高亮;整段连播;popup/选项页试听;IntelliJ 侧移植(JCEF 不支持 speechSynthesis,Kotlin 桥另立项);云端 TTS。

## 约束与已知坑

- Chrome 71+ 要求用户激活才能 `speak()`——点击即手势,天然满足;激活在页面生命周期内持久。
- `getVoices()` 首次常为空:`utterance.lang = "en-US"` 保底可发声,en-US 语音挑选是增强(优先 `localService === true`,Google 网络语音候选;具体排序实现计划里钉)。
- Chrome ~15 秒 utterance 自动中断 bug:句子级朗读远短于 15 秒,不做缓解(这也是整段连播不进范围的原因之一)。
- 与宿主页面共享同一合成器实例:我们的 `cancel()` 会打断页面自身朗读——罕见场景,接受(我们的 UI 优先)。
- happy-dom 无 `speechSynthesis`:speech 模块必须依赖注入合成接口;E2E 用 monkeypatch `speak` 探针计数断言,不断言墙钟与真实音频。
- **零协议红线**:diff 不得触碰 `protocol.ts`、`service-worker.ts`、`manifest.json`、storage——触碰即方向错误。

## 交付物

- 新模块 `chrome-plugin/src/content/speech.ts`:朗读门面(挑语音、voiceschanged、speak/cancel、依赖注入)。
- `chrome-plugin/src/content/learning-block.ts`:句子小喇叭 + 面板条目小喇叭 + 朗读中视觉态。
- 测试:`speech.ts` 单测、`learning-block.test.ts` 小喇叭行为(注入 mock)、E2E 探针一条。
- 文档同步:`modules.md`(新文件)、`rendering.md`(卡片/面板结构)。

## 留给实现者

- 喇叭图标样式与 hover/focus 态(与 `.chat-ask` 等现有按钮一致),朗读中视觉态具体形态(变停止形或脉冲)。
- E2E 探针注入点与断言细节。
- 后续增量(不在 P0):语速切换、跟读高亮、IntelliJ 侧 Kotlin TTS 桥。
