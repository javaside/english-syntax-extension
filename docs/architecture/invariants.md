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

### I-5 SPA 换页必须通知页面

**规则** `tabs.onUpdated` 里 `changeInfo.url !== undefined` 时调 `cancelTab(tabId, notifyPage = true)`。

**为什么** SPA 走 `history.pushState`:文档不重载、没有 loading 阶段,content script 里的 controller 还活着。

**症状** 只清 SW 侧状态的话,页面里的 `MutationObserver` 会自顾自去解析新页面内容。

**测试** `chrome-plugin/src/background/service-worker.test.ts` 的 `SPA 导航结束会话` 组。

## 模型输出与流式

### I-6 分片是未校验的模型输出

**规则** 流式分片**仅用于渲染**:不写缓存、不改句子相位(保持 `requesting`,不计入 `ready`)。SW 侧只放行角色在枚举内、区间在 token 界内、且与已发成分有序不重叠的成分。

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

## 缓存

### I-18 详解缓存键两侧必须同构

**规则** 详解缓存键 = 规范化句文本 + schema 版本 + focus 区间(**与 profile / 模型无关**)。预载路径与点击路径共用同一键。

**症状** 改任一侧的键构造而不同步 → 预载全部白跑,点击时仍要发请求,而计数看上去一切正常。

**做法** 改完必须**用对方路径读回验证**。

**测试** `chrome-plugin/tests/e2e/extension.spec.ts` 的 "enabling detail prefetch caches every component and a click needs no model call"。

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

### I-22 合批分桶与定时器顺序

**规则** 待发块按 `${是否屏外}:${是否跳缓存}` 分桶;`enqueueForBatch` 里**先把条目写进 `pendingBatches` 再起定时器**。

**症状** 不分桶 → `bypassCache` 波及同批别的块;顺序反了 → 同步触发的定时器在条目写入前就跑 `flushBatch`,找不到东西直接返回,这一批**永远发不出去**。

**测试** `chrome-plugin/src/content/session-controller.test.ts` 的 `SessionController 跨段落合并请求`。

### I-23 详解面板的行判定需要真实布局

**规则** 用 `rect.height > 0` **显式判断有没有真实布局**,而不是靠数值比较。

**症状** happy-dom 等零尺寸环境里所有矩形都是 0,数值比较会误判成"下面还有成分"而选错插入分支。

**测试** `chrome-plugin/tests/e2e/layout.spec.ts` 的"长句折行时,详解面板出现在被点成分那一行的下方"。

## 测试与验收

### I-24 用探针,不用墙钟

**规则** 判"是否真调了模型"用 fetch 计数 / 请求记录;判"预载成功"断言 `detailReady === detailTotal && detailFailed === 0`,不能只断言"结束了"。

### I-25 教学语料只断言结构不变量

**规则** `chrome-plugin/tests/fixtures/teaching-sentences.json` 的测试只校验分句、无损分词、声明的词元数,**永不断言唯一的模型答案**——不同模型对成分的切分本就可以不同。

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
