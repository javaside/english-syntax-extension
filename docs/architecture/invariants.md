# 不变量与陷阱

每一条都是**已经踩过**的坑。格式统一为:规则 → 为什么 → 违反时的症状 → 守护它的测试。

> `AGENTS.md` 是这份清单的权威简版(一页读完)。**两处冲突时以 `AGENTS.md` 为准**,并把这里改掉。

## 跨层协议

### I-1 协议三层校验必须同步

**规则** 新增 / 修改 `ResponseMessage` 成员时,三处缺一不可:`shared/protocol.ts` 的类型、SW 侧的校验与路由、content 侧 `isRuntimeResponse` 的 switch case。

**为什么** 三层各自独立把关,没有任何一处能自动推导出另外两处(只有 SW `route()` 结尾的 `assertNever` 会在漏加请求分支时编译报错)。

**症状** content 层漏 case → SW 的成功响应被守卫静默替换成 `ERROR`。**缓存写对了但计数全错**,一直到真机验收才暴露。

**测试** `src/shared/protocol.test.ts`、`src/content/session-controller.test.ts` 的 `ContentScriptRouter` 组。

### I-2 流式推送另有一套守卫

**规则** `CORE_STREAM` / `DETAIL_STREAM` 走 `syntax-learning:<documentId>` 端口 `postMessage`,content 侧用 `isCoreStreamPush` / `isDetailStreamPush` 单独把关——`isRuntimeResponse` 的 switch 对它们不适用。但"类型 / SW 侧构造 / content 侧守卫"三处同步的要求照旧。

**测试** `src/background/service-worker.test.ts` 的 `provisional core stream push` 组。

### I-3 content script 读不到 `chrome.storage`

**规则** SW 启动时设了 `TRUSTED_CONTEXTS`。任何 content 侧要用的设置,**必须由 SW 在 `START_SESSION` 页面命令上快照下发**。

**症状** 直接读会拿到 undefined 或抛错;更糟的是本地开发时看似能用,打包后失效。

**测试** `tests/e2e/extension.spec.ts` 的 "content scripts cannot read the extension's trusted storage"。

### I-4 SW 的会话状态必须持久化到 `storage.session`

**规则** `activeTabs`(tabId → documentId + status)每次变更都 `persistActiveTabs()`;`route()` 里判"是否过期文档"之前必须 `await hydrated`。

**为什么** MV3 的 SW 空闲约 30 秒即被终止,内存状态随之清空。

**症状** 下一次操作生成全新 `documentId`,而页面上已渲染的卡片还攥着旧的——旧 controller 发出的详解 / 纠正请求被判成过期文档拒成 `REQUEST_CANCELLED`,表现为**"点成分报错、点重新解析毫无反应"**。

**测试** `src/background/service-worker.test.ts` 的 `documentId 熬过 service worker 重启` 组。

### I-5 SPA 换页必须通知页面

**规则** `tabs.onUpdated` 里 `changeInfo.url !== undefined` 时调 `cancelTab(tabId, notifyPage = true)`。

**为什么** SPA 走 `history.pushState`:文档不重载、没有 loading 阶段,content script 里的 controller 还活着。

**症状** 只清 SW 侧状态的话,页面里的 `MutationObserver` 会自顾自去解析新页面内容。

**测试** `src/background/service-worker.test.ts` 的 `SPA 导航结束会话` 组。

## 模型输出与流式

### I-6 分片是未校验的模型输出

**规则** 流式分片**仅用于渲染**:不写缓存、不改句子相位(保持 `requesting`,不计入 `ready`)。SW 侧只放行角色在枚举内、区间在 token 界内、且与已发成分有序不重叠的成分。

**为什么** `validateCoreBatch` 的整句覆盖率只能等完整响应到齐才判得了。

**症状** 若让分片改相位,会话会被 `isSessionComplete` 误判为已完成,主按钮提前变成"恢复网页原文"。

**测试** `src/background/analysis-service.test.ts` 的 `provisional components while a core request streams`、`src/content/session-controller.test.ts` 的 `SessionController provisional streaming`。

### I-7 分片也必须脱敏

**规则** `CORE_STREAM` / `DETAIL_STREAM` 的每一片都要过与完整结果同款的 `redactProfileSecrets`。

**为什么** 模型响应里若混入凭据,"只是预览"一样会漏出去。

### I-8 流式用静默超时,读循环自己盯 abort

**规则** 每收到一片就重置 `profile.timeoutMs`,总时长不设限;读循环用 `Promise.race([reader.read(), aborted])`,不依赖 fetch 把中止传播进 body 流。

**症状** 用总时长超时 → 长响应必然被误判超时;不自己盯信号 → 卡死的流永远掐不断。

**测试** `src/background/openai-compatible-adapter.test.ts` 的 `streaming core completions` 组。

### I-9 默认关模型思考,被拒再降级

**规则** 请求**默认**带 `reasoning_effort: "none"`;端点拒绝(OpenAI 官方只收 low/medium/high)就记 `reasoningControl = "unsupported"` 并去掉该字段重发一次。**缓冲与流式两条路径都要接线。**

**为什么** 思考模型会为一句话生成上万 token 推理:Qwen3 实测 246 秒、DeepSeek `v4-flash` 实测 153 秒 / 14789 token,远超 `timeoutMs` 的 120 秒上限。

**症状** **整页无译文,而不是变慢**——每句都超时。

**注意** 曾经的约定是"绝不能默认下发,靠用户在选项页勾选",**已废弃**:DeepSeek 现存的两个模型全是思考模型,靠用户自己发现并勾选并不可靠,而降级路径已让默认下发变得安全。`disableReasoning` 字段仅为兼容旧 profile 保留,不再影响请求。Ollama 只认这个参数,`think: false` 与 `chat_template_kwargs.enable_thinking` 都被兼容层忽略。

**测试** `src/background/openai-compatible-adapter.test.ts` 的 `默认关闭模型思考` 组。

### I-10 能力位只持久化否定态,且三个写入器都要接线

**规则** `jsonSchemaSupport` / `streamSupport` / `reasoningControl` 探到"不支持"才写回;`undefined` 表示值得一试。`createProfileCapabilityWriters()` 返回的三个写入器**必须全部装配到适配器上**。

**症状** 漏掉任一个 → 每次请求都重复交同一笔学费(被拒的 `response_format` 或 `stream` 各要白费一趟 4xx)。

**测试** `src/background/service-worker.test.ts` 的 `profile capability writers` 组。

## 提示词与 token 预算

### I-11 句子走 `serializeSentences`,其余 JSON 走 `serialize`

**规则** prompt 里的句子一律用 `serializeSentences` / `serializeSentence`(只发 `{id, text, punctuation?}`);其余内嵌 JSON(核心结果、focus、校验错误、待修复 JSON)一律用 `prompts.ts` 的 `serialize`——它不缩进。**别再自己 `JSON.stringify(x, null, 2)`。**

**为什么** 模型只按 Token ID 定位。美化完整 Token 记录曾把 prompt 撑到原文的 **35 倍**;缩进的内嵌 JSON 让整句详解 prompt 多付 **9%** 的 prefill。

**测试** `prompts.test.ts` 与 `analysis-service.test.ts` 各有一组 `/\n {2}"/` 断言钉住这点。

### I-12 别改 prompt 首行措辞

**规则** 假模型服务器按 prompt 首行前缀识别请求类型(`tests/support/fake-openai-server.ts` 的 `detectKind`)。

**症状** 改了首行 → 该类请求落进 `unknown` 分支 → 一片 E2E 失败,而错误信息完全指不到这里。

### I-13 假服务器里任何模型内容都要过 `writeContent`

**规则** core / detail / sentence-details / compound / probe,一个分支都不能漏。

**症状** 直接 `response.end(completion(...))` 会让流式请求收到 JSON 体,客户端判定不支持流式后回落重发,**依赖 fetch 计数的用例随之错乱**。这条踩过两次。

## 调度与并发

### I-14 优先级与插队边界

**规则** `user-retry(0) > detail-click(1) > visible-core(2) > prefetch-core(3) > prefetch-detail(4)`。同优先级内 `jumpQueue` 先出队,**专供修复 pass,不得跨优先级抬高**。

**症状** 跨优先级抬高 → prefetch 的修复会插到读者正在看的段落前面。

**测试** `src/background/request-scheduler.test.ts`、`src/background/analysis-service.test.ts` 的 `repair requests jump their own priority queue`。

### I-15 1 请求 = 1 槽位

**规则** `RunTask` 接单个 `ScheduledRequest`,没有批处理、没有 `batchKey`。

**为什么** 早先的设计把整批交给 runner,让它在一个槽位里 `Promise.all` 扇出:配置的 `concurrency` 与真实在飞请求数就脱钩了,兄弟请求要等最慢那个才能结算,单个可重试失败会重发整组。

**推论** `backgroundConcurrency`(默认 `concurrency - 1`)是必需的——**在跑的请求不会被抢占**,光有优先级挡不住两个整句预载占满全部槽位。

### I-16 `MAX_SENTENCES_PER_REQUEST` 三处共用

**规则** content 攒批、`analyzeCore` 切块、调度器上限,三处必须是同一个常量(`shared/protocol.ts` 的 `6`)。

**症状** 超出上限的请求被调度器直接拒成 `SENTENCE_TOO_LONG`,整段拿不到译文。

### I-17 `offscreen` 只由视口判定,显式解析不置位

**规则** content 依视口判定并置位 `ANALYZE_CORE.offscreen`,SW 据此降为 `prefetch-core`。**用户显式发起的解析(选中 / 悬停 / 右键 / 重新解析)一律不置位**——选区锚点这类元素可能压根不在视口里。

**测试** `src/content/session-controller.test.ts` 的 `SessionController offscreen marking`。

## 缓存

### I-18 详解缓存键两侧必须同构

**规则** 详解缓存键 = 规范化句文本 + schema 版本 + focus 区间(**与 profile / 模型无关**)。预载路径与点击路径共用同一键。

**症状** 改任一侧的键构造而不同步 → 预载全部白跑,点击时仍要发请求,而计数看上去一切正常。

**做法** 改完必须**用对方路径读回验证**。

**测试** `tests/e2e/extension.spec.ts` 的 "enabling detail prefetch caches every component and a click needs no model call"。

### I-19 缓存值仍要过校验

**规则** 从 IndexedDB 读出来的 core / detail 都要再过一次 `validateCoreBatch` / `validateDetail`。

**为什么** 库里可能躺着旧结构(schema 升级、导入的外部文件)。

## 页面渲染

### I-20 段落标记必须用 data 属性 + inset box-shadow

**规则** ① 用 data 属性,**不能用 class**;② 竖条用 `inset box-shadow`,**不能用 `border-left`**;③ 重连彻底失败时单独清标记。

**症状** ① `BlockReplacement` 靠"原文本来有没有 class 属性"决定还原时删不删空 `class`,标记先一步加 class 会让它误判,在页面上留下 `<p class="">`(而此时标记已迁到卡片上,清理不到原文)——曾一次弄红三条 E2E;② `border-left` 参与布局计算会让文字位移,推翻折行布局 E2E;③ `reconnectAndResume` 用尽重试后直接返回,相位停在 `requesting`,竖条会常亮。

**测试** `src/content/block-activity-marker.test.ts`、`src/content/session-controller.test.ts` 的 `段落解析中标记`、`tests/e2e/layout.spec.ts`。

### I-21 显式手势不套用自动扫描的取舍

**规则** `scanDocument` 要在整页里躲开边栏与样板文字,所以只在得分最高的正文容器内收块、并要求 20 字符起;`nearestSafeBlock` 只服务用户指到的那一处,**两条都不适用**。

**症状** 套用后表现为"鼠标明明停在段落上,快捷键却报『未找到可解析的段落』"——多 `<article>` 页面、SPA 换内容后缓存失效、短段落全中招。

**两条路径共同的规则**:按渲染盒子而非标签名认块(Mintlify 一类文档站整篇正文都是 `<span data-as="p">`,只按标签名会把这类站点整页判成"未找到");且只认叶子块(否则往上找会撞到包着整篇正文的外层容器)。

**注意** happy-dom 里内联元素的 computed display 是**空串**而非 `"inline"`,判据要把空串算作非块。

**测试** `src/content/document-scanner.test.ts` 的 `nearestSafeBlock on an explicit gesture`、`scanDocument 对 CSS 排版的正文`、`自动扫描放宽后仍有的克制`。

### I-22 合批分桶与定时器顺序

**规则** 待发块按 `${是否屏外}:${是否跳缓存}` 分桶;`enqueueForBatch` 里**先把条目写进 `pendingBatches` 再起定时器**。

**症状** 不分桶 → `bypassCache` 波及同批别的块;顺序反了 → 同步触发的定时器在条目写入前就跑 `flushBatch`,找不到东西直接返回,这一批**永远发不出去**。

**测试** `src/content/session-controller.test.ts` 的 `SessionController 跨段落合并请求`。

### I-23 详解面板的行判定需要真实布局

**规则** 用 `rect.height > 0` **显式判断有没有真实布局**,而不是靠数值比较。

**症状** happy-dom 等零尺寸环境里所有矩形都是 0,数值比较会误判成"下面还有成分"而选错插入分支。

**测试** `tests/e2e/layout.spec.ts` 的"长句折行时,详解面板出现在被点成分那一行的下方"。

## 测试与验收

### I-24 用探针,不用墙钟

**规则** 判"是否真调了模型"用 fetch 计数 / 请求记录;判"预载成功"断言 `detailReady === detailTotal && detailFailed === 0`,不能只断言"结束了"。

### I-25 教学语料只断言结构不变量

**规则** `tests/fixtures/teaching-sentences.json` 的测试只校验分句、无损分词、声明的词元数,**永不断言唯一的模型答案**——不同模型对成分的切分本就可以不同。

### I-26 lint 基线是恰好 1 个错误

**规则** 那一个是 `src/options/options.test.ts` 的 `no-unnecessary-type-assertion`。不修它,也不新增。用 `npm run lint:baseline` 判定,别看 `eslint .` 末尾那行(它报的是"可自动修复"的计数)。

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

### Markdown 内部 API 不出 `markdown/` 包

**规则**:`org.intellij.plugins.markdown.*` 类型只允许出现在 `markdown/` 包与 `plugin.xml`;不反射访问官方 `MarkdownJCEFHtmlPanel` 私有字段。

**为什么**:Markdown 插件的 API 没有 compat 承诺;泄漏面每多一个包,升级时编译断裂点就多一处。

**症状**:IDEA 版本升级后随机位置编译红。

**守护测试**:无自动化(包依赖约定);`check-docs-drift.mjs` 会把 `markdown/` 的改动路由到 rendering/overview 提醒核对。
