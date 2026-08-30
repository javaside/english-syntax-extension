# 不变量与陷阱

每一条都是**已经踩过**的坑。格式统一为:规则 → 为什么 → 违反时的症状 → 守护它的测试。

> `AGENTS.md` 是这份清单的权威简版(一页读完)。**两处冲突时以 `AGENTS.md` 为准**,并把这里改掉。

## 跨层协议

### I-1 协议三层校验必须同步

**规则** 新增 / 修改 `ResponseMessage` 成员时,三处缺一不可:`shared/protocol.ts` 的类型、SW 侧的校验与路由、content 侧 `isRuntimeResponse` 的 switch case。

**为什么** 三层各自独立把关,没有任何一处能自动推导出另外两处(只有 SW `route()` 结尾的 `assertNever` 会在漏加请求分支时编译报错)。

**症状** content 层漏 case → SW 的成功响应被守卫静默替换成 `ERROR`。**缓存写对了但计数全错**,一直到真机验收才暴露。

**测试** `chrome-plugin/src/shared/protocol.test.ts`、`chrome-plugin/src/content/session-controller.test.ts` 的 `ContentScriptRouter` 组。

### I-2 流式推送另有一套守卫

**规则** `CORE_STREAM` / `DETAIL_STREAM` 走 `syntax-learning:<documentId>` 端口 `postMessage`,content 侧用 `isCoreStreamPush` / `isDetailStreamPush` 单独把关——`isRuntimeResponse` 的 switch 对它们不适用。但"类型 / SW 侧构造 / content 侧守卫"三处同步的要求照旧。

**测试** `chrome-plugin/src/background/service-worker.test.ts` 的 `provisional core stream push` 组。

### I-3 content script 读不到 `chrome.storage`

**规则** SW 启动时设了 `TRUSTED_CONTEXTS`。任何 content 侧要用的设置,**必须由 SW 在 `START_SESSION` 页面命令上快照下发**。

**症状** 直接读会拿到 undefined 或抛错;更糟的是本地开发时看似能用,打包后失效。

**测试** `chrome-plugin/tests/e2e/extension.spec.ts` 的 "content scripts cannot read the extension's trusted storage"。

### I-4 SW 的会话状态必须持久化到 `storage.session`

**规则** `activeTabs`(tabId → documentId + status)每次变更都 `persistActiveTabs()`;`route()` 里判"是否过期文档"之前必须 `await hydrated`。

**为什么** MV3 的 SW 空闲约 30 秒即被终止,内存状态随之清空。

**症状** 下一次操作生成全新 `documentId`,而页面上已渲染的卡片还攥着旧的——旧 controller 发出的详解 / 纠正请求被判成过期文档拒成 `REQUEST_CANCELLED`,表现为**"点成分报错、点重新解析毫无反应"**。

**测试** `chrome-plugin/src/background/service-worker.test.ts` 的 `documentId 熬过 service worker 重启` 组。

### I-4.1 「忘掉一个标签页」必须同步做完,还要挡住回填

**规则** `cancelTab` 一律**同步**清账(取消调度 → 删 `activeTabs` → 落盘 → 需要时通知页面);回填尚未落地时另外立一块墓碑(`forgottenTabs`),让回填**跳过**这个 tabId——而不是把清理挪到 `await hydrated` 之后。SPA 那一路的墓碑还带「要通知页面」,回填读到时用**存下来的 documentId** 补发 `STOP_SESSION`。

**为什么** 两个方向各有一个坑,只能同时躲开:① 唤醒 SW 的往往正是这次导航 / 关闭本身,那一刻 `activeTabs` 还空着,清理无从下手,紧接着回填又把陈旧记录塞回内存——这个标签页于是**再也忘不掉**;② 反过来,若把清理推到回填之后,紧随导航而来的状态中继会先看到旧 `documentId` 而被判过期文档拒掉,页面的新会话**再也登记不上**(SPA 导航正是这个次序)。

**症状** ① 旧 `documentId` 一直顶着:点成分报错、弹窗回落成「开始学习」;② 新页面整篇解析不出卡片,SW 日志里全是 `REQUEST_CANCELLED`。

**测试** `chrome-plugin/src/background/service-worker.test.ts` 的 `回填落地前就被忘掉的标签页` 组(方向 ①)与 `cancels only the recorded document on tab close and navigation`(方向 ②)。

### I-4.2 「已完成」= 至少落地一句 + 当前无在飞

**规则** `isSessionComplete(status)` 要求 `ready + failed + skipped > 0` 且 `queued === 0` 且 `inFlight === 0`。`SessionStatus.inFlight` 必须与块级在飞判据共用同一张相位表 `IN_FLIGHT_PHASES`(`cache-check` / `requesting` / `validating`)。

**为什么** 口径**不是**「所有 discovered 都出了结果」:屏外句子要滚到可见才入队,按全覆盖要求长页面永远停在「解析中…」。但「没有在飞」单独也不够——扫描登记完、视口回调还没回来时,`queued` 与 `inFlight` 都是 0。而 `transition()` 每换一次相位就上报状态,`cache-check` 漏出相位表就会送出一条假空闲状态。

**症状** 进度胶囊在 t=0 闪一下「✓ 解析完成」再退回「解析中」;弹窗主按钮同时闪成「恢复网页原文」。

**测试** `chrome-plugin/src/shared/protocol.test.ts` 的 `isSessionComplete 与屏外未触发的句子`、`chrome-plugin/src/content/progress-pill.test.ts` 的「句子刚发现、还没派发时不许说完成」。

### I-5 SPA 换页必须通知页面

**规则** `tabs.onUpdated` 里 `changeInfo.url !== undefined` 时调 `cancelTab(tabId, notifyPage = true)`。

**为什么** SPA 走 `history.pushState`:文档不重载、没有 loading 阶段,content script 里的 controller 还活着。

**症状** 只清 SW 侧状态的话,页面里的 `MutationObserver` 会自顾自去解析新页面内容。

**测试** `chrome-plugin/src/background/service-worker.test.ts` 的 `SPA 导航结束会话` 组。

## 模型输出与流式

### I-5.1 IntelliJ Web 源码与注入 bundle 必须同步

**规则** 修改 `intellij-plugin/src/main/resources/web/*.ts` 后必须运行 `npm run bundle-web`，并提交更新后的 `bundle.js`；真机只执行 bundle，不执行 TS 源。

**为什么** Kotlin 桥增加字段而 bundle 仍是旧严格白名单时，模型请求与 Kotlin 校验都成功，但 JCEF 会静默丢弃全部 `CORE_STREAM` / `CORE_RESULT`。

**症状** 日志显示 `dispatch: outcome ready=N`，页面却一张翻译卡都没有，也没有模型错误。

**守护测试** `bootstrap-lifecycle.test.ts` 的 bundle 协议标记断言。

### I-6 分片是未校验的模型输出

**规则** 流式分片**仅用于渲染**:不写缓存、不改句子相位(保持 `requesting`,不计入 `ready`)。双端只放行角色在枚举内、区间在 token 界内、不是纯标点、且与已发成分有序不重叠的成分。纯标点必须读取源 Token 的 `punctuation` 标记判定，不能相信模型给它的角色。

**为什么** `validateCoreBatch` 的整句覆盖率只能等完整响应到齐才判得了。

**症状** 若让分片改相位,会话会被 `isSessionComplete` 误判为已完成,主按钮提前变成"恢复网页原文"。

**测试** `chrome-plugin/src/background/analysis-service.test.ts` 的 `provisional components while a core request streams`、`chrome-plugin/src/content/session-controller.test.ts` 的 `SessionController provisional streaming`。

### I-7 分片也必须脱敏

**规则** `CORE_STREAM` / `DETAIL_STREAM` 的每一片都要过与完整结果同款的 `redactProfileSecrets`。

**为什么** 模型响应里若混入凭据,"只是预览"一样会漏出去。

### I-8 流式用静默超时,读循环自己盯 abort

**规则** 每收到一片就重置 `profile.timeoutMs`,总时长不设限;读循环用 `Promise.race([reader.read(), aborted])`,不依赖 fetch 把中止传播进 body 流。

**症状** 用总时长超时 → 长响应必然被误判超时;不自己盯信号 → 卡死的流永远掐不断。

**测试** `chrome-plugin/src/background/openai-compatible-adapter.test.ts` 的 `streaming core completions` 组。

### I-9 默认关模型思考,被拒再降级

**规则** 请求**默认**带 `reasoning_effort: "none"`;端点拒绝(OpenAI 官方只收 low/medium/high)就记 `reasoningControl = "unsupported"` 并去掉该字段重发一次。**缓冲与流式两条路径都要接线。**

**为什么** 思考模型会为一句话生成上万 token 推理:Qwen3 实测 246 秒、DeepSeek `v4-flash` 实测 153 秒 / 14789 token,远超 `timeoutMs` 的 120 秒上限。

**症状** **整页无译文,而不是变慢**——每句都超时。

**注意** 曾经的约定是"绝不能默认下发,靠用户在选项页勾选",**已废弃**:DeepSeek 现存的两个模型全是思考模型,靠用户自己发现并勾选并不可靠,而降级路径已让默认下发变得安全。`disableReasoning` 字段仅为兼容旧 profile 保留,不再影响请求。Ollama 只认这个参数,`think: false` 与 `chat_template_kwargs.enable_thinking` 都被兼容层忽略。

**测试** `chrome-plugin/src/background/openai-compatible-adapter.test.ts` 的 `默认关闭模型思考` 组。

### I-10 能力位只持久化否定态,且三个写入器都要接线

**规则** `jsonSchemaSupport` / `streamSupport` / `reasoningControl` 探到"不支持"才写回;`undefined` 表示值得一试。`createProfileCapabilityWriters()` 返回的三个写入器**必须全部装配到适配器上**。

**症状** 漏掉任一个 → 每次请求都重复交同一笔学费(被拒的 `response_format` 或 `stream` 各要白费一趟 4xx)。

**测试** `chrome-plugin/src/background/service-worker.test.ts` 的 `profile capability writers` 组。

### I-10.1 双端分句必须从同一批自定义候选边界出发

**规则** TS 与 Kotlin 都按「句末标点串 + 可选收尾引号/括号 + 后随空白」产生候选边界。强非终结缩写（称谓等）始终向后合并；可收句缩写 `U.S.` / `Ph.D.` / `Inc.` / `Ltd.` / `Co.` / `Corp.` 只在下一片段以小写词或数字开头时合并，遇大写新句保留边界。token regex 内部空白统一使用显式 JS Unicode whitespace class（含 NBSP、U+2000–U+200A），不得用平台 `\s+`。initial、编号和无实词片段仍按双端同构规则处理；`rebuildTokens` 只对 segmentBlock 已 trim 的生产句文本无损。不得分别从平台边界后处理。

**为什么** 两个平台的原始边界本来就不一致；例如编号列表文本会分别切成不同段数。后处理只能修当前已知样例，无法把两套上游边界变成同一个算法。规范化句文本、Token ID 与跨端缓存键会随之漂移。

**症状** 同一段文本在 Chrome 与 IntelliJ 产生不同句数/句文本，交换缓存不命中，甚至相同模型结果落到不同 Token 区间。

**守护测试** 双端 Segmenter 测试共同消费 `shared-fixtures/segmenter-vectors.json`。

## 提示词与 token 预算

### I-11 句子走 `serializeSentences`,其余 JSON 走 `serialize`

**规则** prompt 里的句子一律用 `serializeSentences` / `serializeSentence`(只发 `{id, text, punctuation?}`);其余内嵌 JSON(核心结果、focus、校验错误、待修复 JSON)一律用 `prompts.ts` 的 `serialize`——它不缩进。**别再自己 `JSON.stringify(x, null, 2)`。**

**为什么** 模型只按 Token ID 定位。美化完整 Token 记录曾把 prompt 撑到原文的 **35 倍**;缩进的内嵌 JSON 让整句详解 prompt 多付 **9%** 的 prefill。

**测试** `prompts.test.ts` 与 `analysis-service.test.ts` 各有一组 `/\n {2}"/` 断言钉住这点。

### I-12 别改 prompt 首行措辞

**规则** 假模型服务器按 prompt 首行前缀识别请求类型(`chrome-plugin/tests/support/fake-openai-server.ts` 的 `detectKind`)。

**症状** 改了首行 → 该类请求落进 `unknown` 分支 → 一片 E2E 失败,而错误信息完全指不到这里。

### I-13 假服务器里任何模型内容都要过 `writeContent`

**规则** core / detail / sentence-details / compound / probe,一个分支都不能漏。

**症状** 直接 `response.end(completion(...))` 会让流式请求收到 JSON 体,客户端判定不支持流式后回落重发,**依赖 fetch 计数的用例随之错乱**。这条踩过两次。

### I-13.1 脚本化响应的队列长度要覆盖重试轮

**规则** `FakeOpenAiServer.script(model, outcomes)` 是 FIFO 队列,**耗尽即回落默认合法响应**。一条失败路径在生产里要走几轮(首轮 + 修复轮),脚本就得为每一轮各排一个非法响应。

**症状** 「非法输出不再直接判死,整批无效交修复轮」这一版改完,只排了一个 `invalid-json` 的用例就红了:首轮非法交给修复轮,修复轮拿到队列耗尽后的默认合法响应,页面**渲染成功**,`.sentence-failure` 永不出现(20s 超时)。反过来同类改动也能造成**假绿**——本该失败的路径靠默认响应通过。附带线索:两个这样的超时用例能把整轮 E2E 从 45 秒拖到 17.9 分钟,**「E2E 跑得异常久」本身就是有用例在等超时的信号**。

**守护测试** `extension.spec.ts` 的 "an invalid response envelope fails the block visibly instead of hanging" 排两个 `invalid-json`,并断言 `core` 1 次 + `core-repair` 1 次——判死之前必须真的多要过一次。

## 调度与并发

### I-14 优先级与插队边界

**规则** `user-retry(0) > detail-click(1) > visible-core(2) > prefetch-core(3) > prefetch-detail(4)`。同优先级内 `jumpQueue` 先出队,**专供修复 pass,不得跨优先级抬高**。

**症状** 跨优先级抬高 → prefetch 的修复会插到读者正在看的段落前面。

**测试** `chrome-plugin/src/background/request-scheduler.test.ts`、`chrome-plugin/src/background/analysis-service.test.ts` 的 `repair requests jump their own priority queue`。

### I-15 1 请求 = 1 槽位

**规则** `RunTask` 接单个 `ScheduledRequest`,没有批处理、没有 `batchKey`。

**为什么** 早先的设计把整批交给 runner,让它在一个槽位里 `Promise.all` 扇出:配置的 `concurrency` 与真实在飞请求数就脱钩了,兄弟请求要等最慢那个才能结算,单个可重试失败会重发整组。

**推论** `backgroundConcurrency`(默认 `concurrency - 1`)是必需的——**在跑的请求不会被抢占**,光有优先级挡不住两个整句预载占满全部槽位。

### I-16 `MAX_SENTENCES_PER_REQUEST` 三处共用

**规则** content 攒批、`analyzeCore` 切块、调度器上限,三处必须是同一个常量(`shared/protocol.ts` 的 `6`)。

**症状** 超出上限的请求被调度器直接拒成 `SENTENCE_TOO_LONG`,整段拿不到译文。

### I-17 `offscreen` 只由视口判定,显式解析不置位

**规则** content 依视口判定并置位 `ANALYZE_CORE.offscreen`,SW 据此降为 `prefetch-core`。**用户显式发起的解析(选中 / 悬停 / 右键 / 重新解析)一律不置位**——选区锚点这类元素可能压根不在视口里。

**测试** `chrome-plugin/src/content/session-controller.test.ts` 的 `SessionController offscreen marking`。

### I-17.1 一句同时只在飞一趟

**规则** 块是下发单位,每句只属于一个块,所以哨兵挂在块上:`BlockRecord.inFlight` 记着那一趟下发的 Promise,`analyzeBlocks` 只下发 `inFlight === undefined` 的块,其余改挂等待链(`redispatchAfterInFlight`,一个块只挂一根),落地后重走 `queueVisibleBlock` 让终态闸门决定还要不要补发。同一批里重复出现的块只算一份(`queueBlock` 去重),重连计划(`reconnectAndResume`)也不许重入。

**为什么** 同一批句子再发一条请求有两笔代价:白付一次上游调用,且换代会把先到的那条响应整条作废——用户反倒从头再等一轮。实测一句失败要付三次调用(首轮 + 视口重复回调 + 一次 SW 回收带来的重连补发)。

**症状** 上游账单是预期的两三倍;页面上「解析中」竖条久久不散,失败句要等最后一趟才出「重新解析」。

**测试** `chrome-plugin/src/content/session-controller.test.ts` 的 `resubmits after reconnect only once the in-flight round has landed` 与 `spends exactly one upstream round on a sentence a dead worker keeps failing`。

## 缓存

### I-17.2 本地可判的语法粒度规则必须进入双端 validator

**规则** 不能只在 prompt 里要求模型遵守；TS/Kotlin `validateCoreBatch` 必须同步执行九条可判硬门（见 [protocol.md](./protocol.md) 第 6–14 条）。bare-preposition 仅对 role 不是 `CONJUNCTION`、去标点后恰好一个 lexical word 且命中**保守的高把握“必须带宾语”白名单**时生效；`after/before/down/off/over/since/until/around/inside/outside` 等常见副词/表语/连词兼类词不收。grammar 是否执行只看结构可信度（全部 component 都有可用 range/role/translation、区间句内、有序不重叠、非纯标点），不得被 unknown field、translation too long、sentenceId 等非结构错误阻断；两类错误必须可同次报告。错误英文文案逐字一致。

**为什么** prompt 只是生成建议，未被 validator 拒绝的违规结果会直接进入跨 profile 共用缓存。错误文案又会被 repair prompt 原样引用，因此它同时是可执行修复指令。

**症状** 模型偶发把动词链/介词短语切碎或把简单句套成单个并列分句，首轮仍被当作成功缓存；双端若文案不同，同一错误会收到不同 repair 指令。

**守护测试** 双端 `AnalysisValidatorTest` / `analysis-validator.test.ts` 的九类语法粒度用例，正反两侧都要有（每条硬门既有 reject 用例，也有证明它不误拒的 accept 用例：祈使句无主语、以情态动词开头的动词组、`announced that`、有 `CONJUNCTION` 的从属连词起首并列分句、三实词以内的片段）。`core-gold-annotations.test.ts` 的 `passes the production core validator sentence by sentence` 再把整份黄金集压上——新硬门把正确答案判非法比漏判更糟。

### I-18 详解缓存键两侧必须同构

**规则** 详解缓存键 = 规范化句文本 + schema 版本 + `DETAIL_PROMPT_VERSION` + focus 区间(**与 profile / 模型无关**)。预载路径与点击路径共用同一键;core 键同构,只是换成 `CORE_PROMPT_VERSION` 且 focus 为 `null`——两条提示词各自演进,改 core 规则不作废已有详解。

**症状** 改任一侧的键构造而不同步 → 预载全部白跑,点击时仍要发请求,而计数看上去一切正常。改了提示词却不升版本 → 屏幕上新旧粒度的成分混在一起,无从判断哪一句是哪版规则的产物。

**做法** 改完必须**用对方路径读回验证**。

**测试** `chrome-plugin/tests/e2e/extension.spec.ts` 的 "enabling detail prefetch caches every component and a click needs no model call"。

### I-18.1 Tokenization 改动必须同时提升 core 与 detail 提示词版本

**规则** 任何会改变 Token 数量或 ID 的分词改动，都必须同时提升 `CORE_PROMPT_VERSION` 与 `DETAIL_PROMPT_VERSION`；本次值分别为 `6` 与 `5`，而输出契约未变，`CORE_SCHEMA_VERSION` 保持 `3`。

**为什么** core span 与 detail focus 都使用 Token ID。两条缓存键虽各自带提示词版本，但 Token 坐标是共同依赖；只升一条会让另一类旧缓存仍以过期坐标命中新文本。

**症状** core 卡片覆盖错词，或点击一个成分却命中旧 focus 的详解。

**守护测试** `shared-fixtures/contracts.json` 的双端契约测试、缓存键向量与 `architecture-docs.test.ts` 的版本一致性断言。

### I-19 缓存值仍要过校验

**规则** 从 IndexedDB 读出来的 core / detail 都要再过一次 `validateCoreBatch` / `validateDetail`。

**为什么** 库里可能躺着旧结构(schema 升级、导入的外部文件)。

## 页面渲染

### I-20 段落标记必须用 data 属性 + inset box-shadow

**规则** ① 用 data 属性,**不能用 class**;② 竖条用 `inset box-shadow`,**不能用 `border-left`**;③ 重连彻底失败时单独清标记。

**症状** ① `BlockReplacement` 靠"原文本来有没有 class 属性"决定还原时删不删空 `class`,标记先一步加 class 会让它误判,在页面上留下 `<p class="">`(而此时标记已迁到卡片上,清理不到原文)——曾一次弄红三条 E2E;② `border-left` 参与布局计算会让文字位移,推翻折行布局 E2E;③ `reconnectAndResume` 用尽重试后直接返回,相位停在 `requesting`,竖条会常亮。

**测试** `chrome-plugin/src/content/block-activity-marker.test.ts`、`chrome-plugin/src/content/session-controller.test.ts` 的 `段落解析中标记`、`chrome-plugin/tests/e2e/layout.spec.ts`。

### I-21 显式手势不套用自动扫描的取舍

**规则** `scanDocument` 要在整页里躲开边栏与样板文字,所以只在得分最高的正文容器内收块、并要求 20 字符起;`nearestSafeBlock` 只服务用户指到的那一处,**两条都不适用**。

**症状** 套用后表现为"鼠标明明停在段落上,快捷键却报『未找到可解析的段落』"——多 `<article>` 页面、SPA 换内容后缓存失效、短段落全中招。

**两条路径共同的规则**:按渲染盒子而非标签名认块(Mintlify 一类文档站整篇正文都是 `<span data-as="p">`,只按标签名会把这类站点整页判成"未找到");且只认叶子块(否则往上找会撞到包着整篇正文的外层容器)。

**注意** happy-dom 里内联元素的 computed display 是**空串**而非 `"inline"`,判据要把空串算作非块。

**测试** `chrome-plugin/src/content/document-scanner.test.ts` 的 `nearestSafeBlock on an explicit gesture`、`scanDocument 对 CSS 排版的正文`、`自动扫描放宽后仍有的克制`。

### I-21.1 一个元素只许有一条块记录

**规则** `scanDocument` 与 `nearestSafeBlock` 都经 `getBlockId(element)`(模块级 `WeakMap`)认块 id,所以同一个元素永远拿同一个 id。显式手势要先查 `this.blocks.get(candidate.id)`:已登记就**复用那一条**,只有元素完全没登记过时才 `registerCandidates`。跨段选区、或落在没有安全块的位置,才另造一个临时锚点元素(它是新元素,不与页面块抢宿主)。复用时**不为这次选区改写记录里的句子**——按它自己的整段文本重来。

**为什么** 同一个宿主被两条记录各渲染一张卡,两张卡还各自把它 `display:none`,谁 `restore()` 都还不回原样;改写在飞记录的句子则会让响应与卡片对不上(与快捷键连按同一个坑)。

**症状** 选中一段已翻好的文字再「解析选中文本」→ 页面上同一段出现两张卡片,停止后原文不回来。

**测试** `chrome-plugin/src/content/session-controller.test.ts` 的「选区落在已登记的段落上时复用那条记录，不再多渲染一张卡」「扫描跳过的短段落:选区把它登记成正式块，第二次选区不会再造一条」。

### I-21.2 悬停定位查的是 `:is(:hover)`,不是裸 `:hover`

**规则** 两端(`chrome-plugin/src/content/hover-target.ts`、`intellij-plugin/.../web/preview.ts`)的悬停链一律查 `:is(:hover)` 取链尾;链为空时才退到 `document.elementFromPoint(x, y)`,坐标由**内容脚本装载时**就挂上的 capture + passive 的 `pointermove` / `mousemove` 记着。

**为什么** 页面没有 doctype 时(`document.compatMode === "BackCompat"`)Chrome 套用 [hover/active 怪癖](https://quirks.spec.whatwg.org/#the-active-and-hover-quirk):裸 `:hover` 只让链接匹配,`querySelectorAll(":hover")` **整页恒为空集**,快捷键在这类页面上全线失灵。怪癖只在「复合选择器里除伪类之外别无他物」时生效,`:is()` 让它落进子选择器语境、不再适用(实测同一 quirks 页面同一位置:`:hover` → 空集,`:is(:hover)` → `html > body > main > p#safe`);标准模式下两者恒等,所以不必先探文档模式。IntelliJ 预览页同一判据:那份 HTML 由 IDEA 生成,doctype 有无不由插件说了算。

坐标兜底**不足以**替代 `:is()`:快捷键常常是冷启动,内容脚本正是被这一按注入的(`service-worker.ts` 先 `inject` 再下发 `PARSE_HOVERED_BLOCK`),此后指针不动就永远等不到第一个 pointer 事件,`point` 恒为 undefined。它守的是另一种情形——引擎压根没建立 hover 状态(如指针已移出窗口)时,最后见到的坐标是唯一线索。装载即挂同理:用户早在按键之前就把鼠标放好了。

**症状** 无 doctype 的页面上按 `Alt+T` 报「未找到可解析的段落」,同一份内容加上 doctype 就正常。

**测试** `chrome-plugin/src/content/hover-target.test.ts`(钉住选择器字面量与两条兜底分支)、`intellij-plugin/.../web/preview.test.ts` 的 `deepestHovered`;真机由 `sweep-d-hotkey` 的「quirks 页面冷启动照样解析」一条钉住(同时断言裸 `:hover` 仍恒空——若哪天不空了,说明 Chrome 改了怪癖,这条不变量该重写)。

### I-22 合批分桶与定时器顺序

**规则** 待发块按 `${是否屏外}:${是否跳缓存}` 分桶;`enqueueForBatch` 里**先把条目写进 `pendingBatches` 再起定时器**。

**症状** 不分桶 → `bypassCache` 波及同批别的块;顺序反了 → 同步触发的定时器在条目写入前就跑 `flushBatch`,找不到东西直接返回,这一批**永远发不出去**。

**测试** `chrome-plugin/src/content/session-controller.test.ts` 的 `SessionController 跨段落合并请求`。

### I-23 详解面板的行判定需要真实布局

**规则** 用 `rect.height > 0` **显式判断有没有真实布局**,而不是靠数值比较。

**症状** happy-dom 等零尺寸环境里所有矩形都是 0,数值比较会误判成"下面还有成分"而选错插入分支。

**测试** `chrome-plugin/tests/e2e/layout.spec.ts` 的"长句折行时,详解面板出现在被点成分那一行的下方"。

### I-23.1 IntelliJ 渲染器的全局句子映射必须随块重注册一起清空

**规则** `PreviewRenderer.registerBlock()` 换掉 `#blocks` 里的记录时,必须把旧记录名下的 sentenceId 从全局 `#sentences` 里删掉。

**症状** 「停止并恢复原文」→ 再点开始:`initialize` 清空防重扫描注册表后重扫同一批元素,blockId 由元素上的 `data-english-syntax-block` 沿用、sentenceId(`s-{blockId}-{index}`)也照旧复用,于是新旧条目精确相撞。`#ensureSentence` 判「这句已存在」提前返回 → 新 `BlockRecord.sentences` 永远拿不到这一句 → `#repaintBlock` 算出 `hasContent=false` → 走 `#restoreBlock`,**卡片一张都画不出来且无任何报错**。官方 `updateDom` 重渲染不会撞(整个 body 被换掉,blockId 全部重新分配),所以只有停止→再开始这条路径会踩。

**测试** `intellij-plugin/src/main/resources/web/render.test.ts` 的 "renders again after restoreAll when the same block is registered a second time";会话侧对应 `PreviewSessionTest` 的 "stop then start dispatches the same blocks again"。

### I-23.2 显式按段解析的每一种「没下发」都必须回一句话

**规则** 三个显式手势(`PARSE_HOVERED_BLOCK` / `PARSE_SELECTION` / `PARSE_CONTEXT_BLOCK`)的返回值是这条路**唯一**的反馈通道——content script 把这三种消息的 ERROR 一律交给 `pill.notice()`(`isExplicitParseCommand`),因为快捷键根本没有反馈渠道、右键菜单只反馈「已触发」,而 SW 会丢弃页面命令的响应。因此:已出卡(悬停命中 `replacement.currentElement()`)或全到终态 → `该段已解析`;任一句处于 `cache-check`/`requesting`/`validating`,或落在同块 `PARSE_DEBOUNCE_MS`(400ms)窗口内 → `该段正在解析中…` **且不下发**;候选被 `registerCandidates` 静默丢掉 → `这一段没有可解析的句子…`。`queued`/`discovered`/`stale` 一律放行(显式手势的本意就是把排队的那段提前发走)。

**为什么** 快捷键没有右键菜单那样的「已触发」反馈,静默返回等于让用户以为键坏了。而放行在飞的第二按会为同一批句子再发一条 `ANALYZE_CORE`,`++operationVersion` 让第一条的响应整条作废——白付一次模型调用、用户从头多等一轮;落在注册句子的 `await`(SHA-256)窗口里的连按更狠:两遍 `registerCandidates` 后一遍整条换掉前一遍的 `BlockRecord`,卡片留在 DOM 上却没人认领(与 `performScan` 过滤已注册 id 防的是同一件事)。

**症状** 第二次按快捷键报「未找到可解析的段落」(卡片宿主在浅 DOM 里没有文本,`nearestSafeBlock` 只会返回 `null`),或什么反馈都没有;连按则同一段被解析两遍。

**守护测试** `chrome-plugin/src/content/session-controller.test.ts` 的 `同一段落重复触发快捷键幂等`、`同一段在飞时再按快捷键`、`连按两次落在注册句子的 await 窗口里`、`去抖只挡住窗口内的重复`、`鼠标停在已替换的卡片上`、`整块解析失败后再按`。IntelliJ 侧同源规则见「按段解析:页面先自曝「解析中」,Kotlin 侧不得静默返回」。

### I-23.3 详解面板:占位与终态同一落点,且插在句外时不许让句子变块级

**规则** 加载占位面板与最终面板必须调用**同一个**落点函数(IntelliJ 侧 `PreviewRenderer.#anchorDetail`)。只有在「句内还有位于点击行下方的成分」时才插在句内并加 `english-syntax-has-detail`;否则插到与点击行**共行的最后一句之后**,并**摘掉**该类(对齐 Chrome 端 `.sentence:has(.detail)` 仅在面板真在句内时命中的语义);`#closeAllDetailPanels` 也要清残留的类。

**症状** 占位若图省事直接 `sentence.after(panel)`,面板先出现在整句末尾、等模型内容回来才跳回点击行(I-23 的行判定修好后,这条后加的占位路径没跟着走同一判据,老 bug 以「先在句尾、后跳回来」的形式复发)。无条件加 `has-detail` 则让句子撑满整栏,本来与它共行的短句被挤到面板下方——用户看到的是「本来一行,点一下变两行」。

**测试** `intellij-plugin/src/main/resources/web/render.test.ts` 的 "anchors the loading placeholder on the clicked line so the panel never jumps when content arrives" 与 "keeps sentences that share a visual line on that line: the panel goes after the last one"(happy-dom 零布局,靠 mock `getBoundingClientRect` 造行)。

## 测试与验收

### I-24 用探针,不用墙钟

**规则** 判"是否真调了模型"用 fetch 计数 / 请求记录;判"预载成功"断言 `detailReady === detailTotal && detailFailed === 0`,不能只断言"结束了"。

### I-25 教学语料只断言结构不变量

**规则** `chrome-plugin/tests/fixtures/teaching-sentences.json` 的测试只校验分句、无损分词、声明的词元数,**永不断言唯一的模型答案**——不同模型对成分的切分本就可以不同。

### I-25.1 准确性修改必须用黄金集评分，CI 保持离线

**规则** core 准确性变化要用 `core-gold-annotations.json` 与纯评分器比较 baseline/candidate，至少看整句 exact、span/labeled span P/R/F1、exact-span role accuracy 和逐句错误；不能只凭某一句手测。CI 只校验黄金 fixture 自洽与 scorer/runner 公共逻辑，不运行 `.superpowers/acceptance/run-core-gold-evaluation.mjs`，也不访问真实模型。

**为什么** 单句手测会把随机性与样例偏差当成整体提升；反过来把真模型评测放 CI 会引入密钥、费用、网络和 provider 波动。

**症状** 修好一个例句却让整体 span F1 下降，或 CI 因外部模型限流/输出漂移随机红。

**守护测试** `core-gold-annotations.test.ts`、`scripts/core-evaluation.test.mjs`、`scripts/core-evaluation-runner.test.mjs`。

### I-25.2 真模型 runner 的 base URL 必须先校验再使用

**规则** `CORE_EVAL_BASE_URL` 只接受 HTTP(S)，拒绝 username/password、query 与 fragment；启动时必须在任何日志、Vite 初始化或网络请求前完成校验。completion 请求、控制台与 candidate artifact 统一使用去尾斜杠的规范化安全 URL。

**为什么** URL credentials、query 或 fragment 可能携带密钥或改变 provider 请求语义；若网络请求与 artifact 记录不同值，评测结果将无法可靠复现，也可能在日志或文件中泄露凭据。

**症状** runner 把秘密写进控制台/candidate JSON，或 artifact 声称请求了一个端点、实际请求却带了额外参数。

**守护测试** `scripts/core-evaluation-runner.test.mjs` 的默认 URL、协议、credentials、query、fragment 与尾斜杠用例。

### I-26 lint 基线是恰好 1 个错误

**规则** 那一个是 `chrome-plugin/src/options/options.test.ts` 的 `no-unnecessary-type-assertion`。不修它,也不新增。在 `chrome-plugin/` 里用 `npm run lint:baseline` 判定,别看 `eslint .` 末尾那行(它报的是"可自动修复"的计数)。

### I-27 验收脚本永不提交

**规则** 放 `.superpowers/acceptance/`(已 gitignore),API key 只从环境变量读,日志一律脱敏。

## IntelliJ 插件

### 密钥不进 JCEF

**规则**:API key 只经 `CredentialStore` 存取(生产实现是 PasswordSafe);任何发往 JCEF 页面的脚本、bridge 消息、缓存值、日志与异常 message 都不得包含它。

**为什么**:预览页运行在 JCEF 渲染进程里,等于把内容暴露给一条不可信信道;一旦 key 混进 JS 可见面,页面注入即可外传。`onPageMessage` 在入口就经 `BridgeProtocol.parsePageMessage` 做键白名单过滤,`apiKey`/`headers`/`baseUrl` 一律整体拒绝。

**症状**:密钥泄漏通常没有功能症状,只在审查/抓包时暴露——所以靠测试钉住而不是靠观察。

**守护测试**:`intellij-plugin/src/test/kotlin/.../integration/SecretIsolationTest.kt`(脚本与桥消息双向断言)。

### generation 双闸

**规则**:预览重渲染(`setHtml`)后 generation 递增;Kotlin 侧 `PreviewSession.onGenerationChanged` 取消旧 document 的在飞请求并清空句子记录,JS 侧 `parseHostMessage` 丢弃 generation 不匹配的一切回调。

**为什么**:Markdown 每次保存都会重建预览 DOM;不设闸的话,旧文档的迟到响应会把新 DOM 渲染成上一版内容(卡片文本与页面文本错位)。只在一端校验不够:Kotlin 漏闸会浪费请求并污染会话,JS 漏闸会污染 DOM。

**症状**:切换文档后短暂出现"不属于这篇文章的译文"。

**守护测试**:`PreviewSessionTest`(`generation change bumps and clears sentences`)+ `bridge.test.ts`(`drops messages from stale generations`)。

### 渲染换代边沿必须排除「我方主动清卡」

**规则**:MutationObserver 用「卡片从有到无」(trackPreviewRendered)判官方 `updateDom` 重渲染、上报 `PREVIEW_RENDERED`。**我方主动清卡(`RESTORE_ALL` 触发 `renderer.restoreAll()` 删卡)必须在 RESTORE_ALL 分支同步把「有卡片」基线 `previewHadCards` 复位为 false**,让它不构成 true→false 边沿。

**为什么**:清卡也是 DOM 变更,同样会触发 MutationObserver。若不清基线,「停止并恢复原文」把自己删的卡误判成官方重渲染,Kotlin 换代重扫后 `rescan()` 又会 `setStatus("正在解析 N 段…")`——表现为点完停止进度浮层反而重现。

**症状**:点「停止并恢复原文」后,预览页右下角又亮起「正在解析」进度浮层(看似又开始翻译)。

**守护测试**:`intellij-plugin/src/main/resources/web/bootstrap-lifecycle.test.ts`(`RESTORE_ALL 清卡后不再把清卡误判成官方重渲染、也不重新亮出进度浮层`)。

### 卡片句子必须按源序排列

**规则**:`#blockSentenceOrder` 只按消息到达顺序累积句子 ID,但 `#repaintBlock` 渲染前**必须**按 sentenceId 末尾的 `index` 数值升序重排(`bySourceOrder`),让卡片里句子顺序等于原文出现顺序。

**为什么**:流式分片按模型输出到达,可能先吐后半句(s2 先于 s1 到)。若不重排,`#blockSentenceOrder` 里就是乱序,最终卡片英文会和原文顺序对不上。Chrome 端用 `setExpectedSentenceIds` 从宿主拿源序;IntelliJ 端 sentenceId 是 `s-{blockId}-{index}`,index 即源序,可直接从 ID 推断。

**症状**:翻译卡片的英文行顺序与原文不一致(常见于一句分多次流式、或多个句子乱序到达)。

**守护测试**:`render.test.ts`(`renders sentences in source order even when streamed messages arrive out of order`)。

### Markdown 内部 API 不出 `markdown/` 包

**规则**:`org.intellij.plugins.markdown.*` 类型只允许出现在 `markdown/` 包与 `plugin.xml`;不反射访问官方 `MarkdownJCEFHtmlPanel` 私有字段。

**为什么**:Markdown 插件的 API 没有 compat 承诺;泄漏面每多一个包,升级时编译断裂点就多一处。

**症状**:IDEA 版本升级后随机位置编译红。

**守护测试**:无自动化(包依赖约定);`check-docs-drift.mjs` 会把 `markdown/` 的改动路由到 rendering/overview 提醒核对。

### 页面消息必须有消费者,接线只有一处

**规则**:JS→Kotlin 的 `VISIBLE_BLOCKS`/`DETAIL_REQUEST`/`RETRY_SENTENCE`/`PARSE_BLOCK` 必须经 `PreviewSessionConnector`(Start Action 调 `PreviewSessionConnector.start`,按段解析走同文件的 `parseHovered`)派发进会话;接线顺序不可拆——先 `connect` 再 `manager.start`,会话初始为 `STOPPED`,先于 start 到达的 `VISIBLE_BLOCKS` 会被 `onVisibleBlocks` 直接丢弃。`PARSE_BLOCK` 是唯一不需要「后启动会话」的一条:`parseExplicitBlock` 在 STOPPED 时自己置 RUNNING,所以 `parseHovered` 只接线、不调 `manager.start`,也不置 `autoScan`。

**为什么**:Panel 的 `onPageMessage` 只做协议校验与转发,自己不认识会话;「移除自建预览面板」重构(ca8b93c)曾把接线整体丢掉,协议、会话、渲染每一层单测全绿,但端到端没有任何一条页面消息到达会话。

**症状**:点「开始句法学习」弹正常提示,预览页毫无变化、无任何报错——每层都以为别的层在消费。另:合成 `PREVIEW_READY` 喂回 `onPageMessage` 只是 Kotlin 侧自言自语,驱动 JS 重扫必须执行 `window.__englishSyntaxInitialize`(经 `panel.requestScan()`)。

**守护测试**:`intellij-plugin/src/test/kotlin/.../session/PageMessageWiringTest.kt`(走 Panel 桥接入口断言 VISIBLE_BLOCKS 真正注册进会话;同文件另有一例走 `PARSE_BLOCK` 断言按段解析同样到达会话)。

### 预览页 CSP 没有不安全 eval——bundle 必须走顶层注入

**规则**:向官方预览页注入的脚本里**禁止** `eval('代码')`、`new Function(...)` 与动态 `<script>` 内联(含 `textContent = code` 的 script 元素)。要执行大段 JS(`web/bundle.js`),把它**原样**作为一次独立的 `executeJavaScript` 调用发出(浏览器 API 级注入,不经过页面 CSP);需要字符串拼进脚本的只有小段字面量(CSS、JSQuery 回调),走 `escapeJsString`。

**为什么**:官方 `MarkdownJCEFHtmlPanel` 的页面带 CSP(`PreviewStaticServer.createCSP`):`script-src` 只允许官方静态服务器 URL、`connect-src 'none'`,**没有 `'unsafe-eval'`**。页面上下文里的字符串求值会被 CSP 静默拦截——bootstrap 那句 `eval('$injectJs')` 使整个 bundle 一行都没执行过,`window.__englishSyntaxInitialize` 从未定义。CEF 的 `executeJavaScript` 与 DevTools 控制台同级,不受页面 CSP 约束(官方 `updateDom` 自己就这么执行 JS)。

**症状**:与前一条接线丢失完全同相——点开始后毫无变化、无报错。两个 bug 叠在一起先后修过,排查时先确认 bundle 是否执行(页面上 `window.__englishSyntaxInitialize` 是否为函数),再看消息是否被消费。

**守护测试**:`EnglishSyntaxPreviewPanelTest` 的 `injection never evaluates strings because the official preview CSP has no unsafe-eval`(断言注入输出里没有 `eval(`/`new Function`/`<script`,且会触发 initialize)。

### 首屏可见性不能依赖 IntersectionObserver 的初始回调

**规则**:`observeBlocks(...).start()` 必须**先用几何判定**(`getBoundingClientRect` 与视口±一屏求交)播种可见集合并立即上报,IntersectionObserver 只负责之后的滚动增量。fallback 分支(rAF/scroll)本来就是几何判定,不受影响。

**为什么**:JCEF 里 IntersectionObserver 的初始回调不可靠——`observe()` 之后可能不产生任何 entries。而 start() 若只重发「当前 Set」,那是个空集,`rescan` 的回调里 `visible.length === 0 → return`,**`VISIBLE_BLOCKS` 永远不会发出**。真机日志证据:注入成功、双向通道正常(`PREVIEW_READY` 两次到达)、然后一片寂静——卡在这一环。

**症状**:与 CSP/接线丢失同相:点开始后毫无翻译、无报错。三层 bug 叠着修过;排查顺序:先看 `onPageMessage: PreviewReady` 有没有(没有=JS 没跑/通道死),再看 `onVisibleBlocks`(没有=本条坑)。

**守护测试**:`preview.test.ts` 的 `reports geometrically visible blocks immediately even if IntersectionObserver never fires its initial callback`(stub 一个永不回调的 IO,断言 start() 仍同步上报非空可见集)。

### 渲染的 DOM 变更会回流成新的 VISIBLE_BLOCKS——两端都要防环

**规则**:Kotlin 侧 `onVisibleBlocks` 只对「首次到达或 FAILED/STALE」的句子注册/入队,**READY 句绝不重置重派**;JS 侧 `rescan` 的可见性回调对「相同可见集合(blockId 指纹)」不重复上报,指纹在 `initialize`(新代次)时重置。

**为什么**:插件自己的卡片渲染也是 DOM 变更,而 MutationObserver 监听整个 document——`CORE_RESULT → 渲染卡片 → mutation → rescan → 再次 VISIBLE_BLOCKS(同一批块)`。若 Kotlin 无条件把句子重置为 DISCOVERED,链路闭合成环:缓存命中 → 再发 CORE_RESULT → 再渲染 → 循环不止。真机症状:**CPU 狂转、请求风暴、卡片反复重建**(实测一轮 10 块 24 句,13 秒一循环)。单端防不够——Kotlin 防环保住模型请求不发,JS 指纹去重保住桥消息不刷屏,两层各自独立生效。

**症状**:开始后翻译出现,但 CPU 持续高占用、日志里 `onVisibleBlocks → dispatch → outcome(cacheHit=true)` 无限重复。

**守护测试**:`PreviewSessionTest` 的 `repeated visible blocks after ready do not redispatch`(同一批块重复上报三次,断言 `analyzeCalls` 恒为 1、相位保持 READY)。

### 详解必须复用已校验的核心分析

**规则**:IntelliJ `PreviewSession` 收到完整 `CoreBatchOutcome` 后,必须把每句 `CoreAnalysis` 保存在对应 `SentenceRecord`;点击成分时只允许把这份权威结果传给 `analyzeDetail`。核心结果尚不存在时不发详解请求;`CORE_STREAM` 的暂定成分只供渲染,不能充当 verified core。

**为什么**:详解提示词明确把 `verifiedCore` 视为不可变输入。若会话临时构造 `components=[]`,模型看不到正文已经确认的成分边界,会重新猜结构;复杂语序下容易把相邻短语重复拆分,局部译文也与正文卡片错位。

**症状**:正文核心卡片看似正常,点击后详解标注却重复/交叠,或把组件级 gloss 按英文语序硬拼成不自然中文。

**守护测试**:`PreviewSessionTest` 的 `detail request reuses the verified core analysis`。

### 详解结构不得越出 focus 或互相重叠

**规则**:`DetailAnalysis.structures` 每项必须完全位于请求 focus 内,按 Token ID 升序且互不重叠;完整响应和缓存读取由双端 `validateDetail` 把关,流式 `ProvisionalStructures` 使用同一范围/顺序规则。提示词同时禁止“先返回整段,再重复拆内部”。

**为什么**:结构只是自由数组,JSON Schema 只能约束字段类型,不能表达跨项区间关系。若不做语义校验,模型会同时返回 `how much process the request needs`、`how much`、`process`、`the request`、`request`、`needs`,渲染层忠实还原后就像把同一句重复了多遍。

**症状**:详解标注英文重复、区间嵌套,圈号解释列表也重复描述同一批词。

**守护测试**:双端 `AnalysisValidatorTest` / `analysis-validator.test.ts` 的 focus/overlap 用例,以及 IntelliJ `AnalysisServiceTest.detail stream drops nested structures before rendering`。

### Action 的 `update()` 绝不能触发 JCEF 注入

**规则**:三个句法学习 Action(`Start`/`TogglePause`/`Stop`)的 `update()` 只允许**只读定位**已存在的面板 wrapper(`EnglishSyntaxPreviewPanel.findWrappedPanel`,内部只 `getUserData(WRAPPER_KEY)`),**禁止**调用会 `wrap`/`attach`/注入的 `findPanel`。`findPanel` 只在用户真正点按钮的 `actionPerformed` 里用。第四个 Action `ParseHoveredBlock` 把这条推得更彻底:它的 `update()` **连面板都不查**,只看「当前文件是 Markdown」与 JCEF 是否可用(`PreviewActionSupport.hoverParseEnabled`)——它挂着快捷键,IDEA 在按键分发与菜单刷新时都会跑 `update()`,查面板的代价比只从菜单进入更高。

**为什么**:IDEA 展开 Tools 菜单、刷新工具栏等高频事件会对菜单内每个子 action 跑一次 `update()`。若 `update()` 里调用 `findPanel`(内部 `wrap → attach → 注入 bundle + __englishSyntaxInitialize`),会导致「点开工具菜单就自动初始化 JS、扫描全文、给每段打解析中标记、显示状态浮层」的**假翻译**——页面看起来像自动翻译了,但 Kotlin 侧从未有过 RUNNING 会话,也就没有真实模型请求,「翻译不出来」,且暂停/停止因无会话而灰色。曾因把定位改成按当前文件面板而在 `update()` 里调用 `findPanel` 触发此回归。

**症状**:点「工具」菜单即出现解析中竖条 + 右下角状态浮层,但无翻译结果;暂停/停止按钮灰色(无会话)。

**守护测试**:依赖设计约定,`findWrappedPanel` 只读 `getUserData`、不创建 wrapper(结构上无法注入);三个会话 Action 的 `update()` 一律走 `findWrappedPanel`。`ActionStateTest` 的 `hover parse availability only depends on file type and runtime` 钉住第四个 Action 的启用判据里不含面板。

### 新增页面消息要同步五处,其中一处漏了不会变红

**规则**:新增一个 JS→Kotlin 页面消息,五处缺一不可——`bridge/BridgeProtocol.kt` 的 `PageMessage` 成员、`parsePageMessage` 分支、`session/PreviewSessionConnector` 的 `when`、`BridgeProtocolTest`,以及 **`resources/web/bridge.ts` 的联合类型 + `PAGE_KEYS_BY_TYPE` + `parsePageMessage` 分支(含 `bridge.test.ts`)**。

**为什么**:JS 侧那份 `parsePageMessage` **运行时并不生效**——`bootstrap-entry.ts` 直接 `postToHost(...)` 构造消息,不经它校验,它只被 `bridge.test.ts` 调用。它存在的意义是让两侧白名单逐字对齐、供后来人照抄。因为不在运行链路上,漏了它**不会有任何测试变红**,Kotlin 侧全绿、功能也正常。

**症状**:没有即时症状。代价在下一次——后来人照着 `bridge.ts` 加消息时,抄到的是一份缺项的样板;或有人误以为页面消息经过 JS 侧校验而把校验逻辑只加在那一侧。`PARSE_BLOCK` 就是这么漏掉的,实现到一半才发现。

**守护测试**:无自动化(结构性约定)。`bridge.test.ts` 只能钉住已加进去的那些消息,钉不住「有没有漏加」。

### 显式手势不套用自动扫描的取舍(IntelliJ 侧)

**规则**:`nearestPreviewBlock` 只保留四条判据——排除区、渲染盒子、叶子块、文本非空。**不得**加上 `scanMarkdownBlocks` 的 20 字符下限与英文占比 60% 门槛,也不得限定候选标签名。

**为什么**:`scanMarkdownBlocks` 要在整篇里躲开边栏与样板文字,那些门槛是为「自动决定翻什么」服务的;快捷键悬停解析是用户已经指明了目标,再拿统计门槛去否决用户就是纯粹的误判。按渲染盒子而非标签名认块的理由同 Chrome 端:Mintlify 一类文档站整篇正文都是 `<span>`。

**症状**:鼠标明明停在段落上,按快捷键却提示「未找到可解析的段落」——短段落、术语行、中英混排行、span 排版的文档站全中招。

**守护测试**:`preview.test.ts`(`accepts short and non-english blocks that the auto scanner would skip`、`accepts a div whose only children are inline`)。

### 手动扫描模式下 rescan 绝不上报

**规则**:`autoScan=false` 时 `rescan()` 只做 `registerBlock`,**不得** `postToHost(VISIBLE_BLOCKS)`。`EnglishSyntaxPreviewPanel.autoScan` 默认 false,只有 `PreviewSessionConnector.start` 置 true。

**为什么**:我们插入卡片本身就是 DOM 变更,会触发 MutationObserver → rescan;保存后官方 `updateDom` 重渲染还会经 `PREVIEW_RENDERED` 换代重发 `initialize`,那一路会 `resetScanRegistry()` 并清空 `lastVisibleFingerprint`,于是全部块重新变成「未注册」。任一条都会把整篇文档送去翻译。

**症状**:按一次快捷键(或按一次后保存文件),整篇文档全部开始翻译——「按段翻译」变成整篇翻译,长文档瞬间几十上百次模型请求。

**守护测试**:`bootstrap-lifecycle.test.ts`(`autoScan=false 时只注册不上报，浮层也不亮`)、`PageMessageWiringTest`(`parse block from the page lightweight-starts the session and registers only that block`,断言 `panel.autoScan == false`)。

### 按段解析:页面先自曝「解析中」,Kotlin 侧不得静默返回

**规则**:`parseHoveredBlock` 在按下的那一刻就打上「解析中」竖条并亮起浮层,撤掉它的**唯一**信号是该 `blockId` 的 `CORE_RESULT` / `CORE_ERROR`。因此 `PreviewSession.parseExplicitBlock` 里 `registerFresh` 返回空集时**不得** `return`,必须走 `replayBlock(blockId)` 把该块已存的 `CoreAnalysis` 经同一个 `applyOutcome` 原样重发一遍。页面侧则要在下发前先挡住「已经出过卡」的段落(`HIDDEN_ATTRIBUTE` 判据),两头各守一道。

**为什么**:`registerFresh` 有反环不变量——已到终态的句子不再注册(我方插卡本身是 DOM 变更 → rescan,否则永远循环),所以「同一段再按一次」必然拿到空集。空集静默返回等于让页面自己许下的承诺无人兑现。重发不构成环:不调模型、按段路径 `autoScan=false` 不上报 `VISIBLE_BLOCKS`、整篇模式下 READY 句同样被 `registerFresh` 挡掉;全部在飞时只记日志,否则同一句会被发两遍。

**症状**:同一段已经翻译好,再按一次快捷键就永远停在「解析中」(竖条呼吸动画 + 右下角浮层不灭);顺带 `renderer.registerBlock` 清空该块的句子映射,卡片还在 DOM 上但点成分毫无反应。

**守护测试**:`PreviewSessionTest`(`parse explicit block replays the stored result instead of going silent`)、`bootstrap-lifecycle.test.ts`(`同一段解析完再按：提示已解析、不重复下发，卡片仍点得动`)。

### 被卡片替换的原文必须真的隐藏

**规则**:`preview.css` 必须有 `[data-english-syntax-hidden] { display: none !important; }`。属性本身只是标记(`restoreBlock` 据它精确删除),隐藏是 CSS 的责任;`!important` 是为了压过官方 Markdown 主题里特异性更高的 `p`/`li` 规则(与 Chrome 端注入 `.<hide-class>{display:none!important}` 同款考虑)。

**为什么**:卡片插在原文**之后**,原文是卡片的兄弟节点。规则缺失时一段翻完屏上有两份文字,而且鼠标本来就停在那份可见原文上——`parseHoveredBlock` 里的 `closest("[data-english-syntax-card]")` 只拦得住「停在卡片里」,拦不住兄弟节点,于是同一段被重复下发(见上一条)。

**症状**:一段翻译完成后原文与卡片同时显示;紧接着再按快捷键就复现「一直显示在翻译状态」。

**守护测试**:`render.test.ts`(`the injected stylesheet really hides the replaced original, not just marks it`——happy-dom 不加载注入的样式表,只能按文本钉住规则)。
