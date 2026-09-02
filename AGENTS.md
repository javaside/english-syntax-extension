# 项目指令(english-syntax-extension)

双运行时仓库,根下两个平级子模块:**`chrome-plugin/`** 是 Chrome MV3 英语句法学习扩展(TypeScript + Vite,Vitest(fake-indexeddb / happy-dom)单测,Playwright E2E 假 OpenAI 服务器,自带 package.json 完整 npm 工程);**`intellij-plugin/`** 是 IntelliJ IDEA Markdown 预览插件(Kotlin + Gradle IntelliJ Platform,SQLite 缓存,JCEF 桥接预览页,web 侧 TS 测试有自己的 package.json)。仓库根保留双端共享的东西:`shared-fixtures/` 的向量与 fixture 由 TS/Kotlin 双端测试同时消费,`docs/architecture/` 与 CHANGELOG 也是仓库级。本仓库由 springai-agentdemo 单仓拆出(git filter-repo,历史完整保留)。

**本文件是权威简版,先读完它再动手。** 需要理解全局结构、跨层链路或某条约定的完整来龙去脉时,读 [`docs/architecture/`](docs/architecture/README.md)(总览 / 模块地图 / 协议参考 / 模型链路 / 渲染链路 / 构建发布 / 不变量清单)。两处冲突以本文件为准,并把架构文档改掉。

## 门禁(提交前全部过)

Chrome 扩展(在 `chrome-plugin/` 里跑):

```bash
cd chrome-plugin && npm test && npx playwright test && npm run lint && npm run format:check && npm run build
```

IntelliJ 插件(动了 `intellij-plugin/`、`shared-fixtures/` 或桥协议时;仓库根跑 gradle,子目录跑 npm):

```bash
(cd intellij-plugin && npm ci && npm test) \
  && ./gradlew :intellij-plugin:test :intellij-plugin:buildPlugin :intellij-plugin:verifyPluginProjectConfiguration
```

- **lint 基线:恰好 1 个错误**——`chrome-plugin/src/options/options.test.ts` 的 `no-unnecessary-type-assertion`。不要修它,也不要新增任何错误。
- 提交信息用中文主题。

## IntelliJ 插件的三条硬不变量

- **密钥不进 JCEF**:API key 只存 PasswordSafe(经 `CredentialStore`),永不进 panel 外发脚本、bridge 消息、缓存或日志。`SecretIsolationTest` 钉住。
- **generation 在 Kotlin/JS 双端校验**:Kotlin 侧 `PreviewSession.onGenerationChanged` 取消旧请求并清空记录;JS 侧 `parseHostMessage` 丢弃非当前 generation 的一切回调。任何一端漏掉都会让旧响应污染新 DOM。
- **Markdown 插件内部 API 只留在 `markdown/` 包**:`org.intellij.plugins.markdown` 的类型不泄漏到 session/analysis/actions;不反射访问官方 `MarkdownJCEFHtmlPanel` 私有字段。升级 Markdown 插件时只有这一个包要对着编译。

## 关键工程约定

- **协议三层校验必须同步**:新增 `ResponseMessage` 成员时,`src/shared/protocol.ts` 类型、SW 侧校验/路由、content 侧 `isRuntimeResponse` 的 switch case 三处缺一不可。content 层漏 case 会把 SW 的成功响应静默替换成 ERROR(缓存写对但计数全错,曾在真机验收才暴露)。
- **E2E/验收断言用探针,不用墙钟**:判"是否真调了模型"用 fetch 计数/请求记录;判"预载成功"断言 `detailReady === detailTotal && detailFailed === 0`,不能只断言"结束了"。
- **content script 读不到 chrome.storage**(TRUSTED_CONTEXTS):设置必须由 SW 在 START_SESSION 页面命令上快照下发。
- **流式分片走端口推送,不是 sendMessage 响应**:`CORE_STREAM` 由 SW 经 `syntax-learning:<documentId>` 端口 `postMessage`,content 侧用 `isCoreStreamPush` 独立把关(`isRuntimeResponse` 的 switch 对它不适用),但"类型 / SW 侧构造 / content 侧守卫"三处同步的要求照旧。
- **分片是未校验的模型输出**:`validateCoreBatch` 的整句覆盖率只能等完整响应,所以分片仅用于渲染——不写缓存、不改句子相位(保持 `requesting`,不计入 `ready`)。SW 侧过滤只放行 role 在枚举内、区间在 token 界内且与已发成分有序不重叠的成分,并且**必须经 `sanitizeCore` 同款脱敏**。
- **流式用静默超时**:每收到一片就重置 `profile.timeoutMs`,总时长不设限(长响应本来就会超过单次超时)。读循环自己盯 abort 信号,不依赖 fetch 把中止传播进 body 流。
- **默认关模型思考,被拒再降级**:思考模型会为单句生成上万 token 推理(Qwen3 实测 246 秒;DeepSeek `v4-flash` 实测 153 秒 / 14789 token),远超 `timeoutMs` 的 120 秒上限,表现为整页无译文而非变慢。请求**默认**带 `reasoning_effort: "none"`(同句降到 1.4 秒),端点拒绝(OpenAI 官方只收 low/medium/high)就记 `ModelProfile.reasoningControl = "unsupported"` 并去掉该字段重发一次——与 `streamSupport` 只持久化否定态的套路对称,缓冲与流式两条路径都要接线。Ollama 只认这个参数,`think: false` 与 `chat_template_kwargs.enable_thinking` 都被兼容层忽略。**曾经的约定是「绝不能默认下发」并靠用户在选项页勾选,已废弃**:DeepSeek 现存的两个模型全是思考模型,靠用户自己发现并勾选并不可靠,而降级路径已经让默认下发变得安全。`disableReasoning` 字段仅为兼容旧 profile 保留,不再影响请求。
- `ModelProfile.streamSupport` 只持久化否定态(`"unsupported"`),与 `jsonSchemaSupport` 的降级套路对称;`undefined` 表示值得尝试流式。选项页「流式渲染」开关默认开,是 provider 异常时的退路。
- 详解缓存键 = 规范化句文本 + `CORE_SCHEMA_VERSION` + `DETAIL_PROMPT_VERSION` + focus 区间(与 profile/模型无关),core 键同构但用 `CORE_PROMPT_VERSION` 且 focus 位为 `null`,预载与点击路径共用同一键——改任一侧的键构造必须两侧同步并用对方路径读回验证。**两条提示词各自带版本是刻意的**:改 core 粒度规则只作废 core 缓存,不牵连已有详解;反过来也一样。改提示词而不升版本 = 把旧粒度的结果永久钉在缓存里与新结果混着显示。
- 假模型服务器按 prompt 首行前缀识别请求类型(`tests/support/fake-openai-server.ts` 的 `detectKind`),改 prompt 首行措辞会破坏 E2E。**任何「模型内容」都必须经 `writeContent` 出去**(core / detail / sentence-details / compound / probe 一个都不能漏——这条踩过两次:第一次漏了 scripted 分支，第二次漏了详解路径):直接 `response.end(completion(...))` 会让流式请求收到 JSON 体,客户端判定不支持流式后回落重发,依赖 fetch 计数的用例随之错乱。**`script()` 的队列耗尽即回落默认合法响应**:core 失败路径是首轮 + 至多两轮 repair，验证最终失败的脚本队列必须排满三份非法响应——少排任何一轮,用例都会从「验证失败可见」悄悄变成「后续 repair 成功渲染」。
- **一个 role 的判定标准只能有一处定义**:提示词规则、黄金集 `conventions`、黄金标注三处必须说同一件事。`PREPOSITIONAL_PHRASE_RULE` 曾把 `ATTRIBUTE` 限死成「名词短语内部的修饰语」且只给前置修饰的例子,而 conventions 明写「可前置也可后置」——后置介词短语于是无处可归,`the development` + `of applications` 被标成宾语 + 状语,译文退化成单字「的」。`PREDICATE_SCOPE_RULE` 曾举例 `"is independently deployable" is one PREDICATE`,而 `PEER_COMPONENT_RULE` 同时禁止 `PREDICATE` 吸收 `PREDICATIVE`,系表结构于是两种口径混用。**当前口径**:紧跟名词短语的介词短语标 `ATTRIBUTE`(量词与部分结构无例外),嵌在另一个介词短语内的不再拆;系表结构 `PREDICATE` 只含系动词、补足部分标 `PREDICATIVE`(被动/完成/进行时的 be/have 仍在动词组内);五类从句成分从引导词一直延伸到从句自己的宾语与状语。
- **prompt 里的句子一律走 `serializeSentences` / `serializeSentence`**:模型只按 Token ID 定位,`start`/`end`/`leadingWhitespace` 是死重量(曾把 prompt 撑到原文的 35 倍)。新增带句子的 prompt 别再自己 `JSON.stringify(sentence, null, 2)`。**其余内嵌 JSON(核心结果、focus、校验错误、待修复 JSON)一律走 `prompts.ts` 的 `serialize`**——它不缩进:一个 6 成分长句的核心结果美化后 827 字符、紧凑后 555,整句详解 prompt 从 4074 降到 3693(-9%),模型只读结构、排版一个字用不上。`prompts.test.ts` 与 `analysis-service.test.ts` 各有一组 `/\n {2}"/` 断言钉住这点。
- **分句/分词必须双端确定性一致**:TS/Kotlin 都从「句末标点串 + 收尾引号/括号 + 空白」自建候选边界。缩写分两类:称谓等强非终结类(`Dr.` / `Prof.` / `Capt.`)始终向后合并;可合法收句类(`U.S.` / `Ph.D.` / `Inc.` / `Ltd.` / `Co.` / `Corp.`)仅在下一片段以小写词或数字起头时撤销边界,大写新句则保留边界。单字母 initial 与编号/无实词片段另按既有规则合并。token regex 内部空白必须使用 TS/Kotlin 共享的显式 JS whitespace class(NBSP、U+2000–U+200A 等),不得写 `\s+`;`rebuildTokens` 只承诺对 `segmentBlock` 已 trim 的生产句文本无损,句尾 gap 不进 Token schema。不得各自从 `Intl.Segmenter` / `BreakIterator` 后处理。`shared-fixtures/segmenter-vectors.json` 双端钉住。
- **本地可判的语法规则必须进双端 validator**:TS/Kotlin 只同步执行代码实际可判的十二条硬门:组件序列相邻且 Token 区间连续的两个 `PREDICATE` 合并;去掉标点后恰好一个 lexical word、role 不是 `CONJUNCTION` 且命中**保守的高把握“必须带宾语”介词白名单**的成分并入管辖短语(常见副词/表语/连词兼类词 `after/before/down/off/over/since/until/throughout/around/inside/outside` 不收);`COORDINATE_CLAUSE` 数量恰好为 1 时拒绝;`CONJUNCTION` 的 lexical words 至少含一个 FANBOYS;`PREDICATE` 首个 lexical word 是限定词/主格代词/`that` 时拒绝(动词组不可能以它们开头,命中即主语被吞);`PREDICATE` 非首位 lexical words 含限定词时拒绝(限定词是名词短语左边界,`that` 刻意不在这条里);`COORDINATE_CLAUSE` 首词是从属连词且整句无 `CONJUNCTION` 时拒绝(有 `CONJUNCTION` 就放行——`Because A, B, and C` 的第一个并列分句本来就这样开头);单个成分覆盖全部非标点 token 且句子实词数 ≥ 4 时拒绝(不论 role,那等于没有划分);出现 2 个以上 `COORDINATE_CLAUSE` 却既没有 `CONJUNCTION` 成分也没有 `;` token 时拒绝(并列句 = 各分句自带主语 + 并列连词或分号连接)。五类从句角色的成分只有 1 个 lexical word 时拒绝(从句至少是引导词 + 谓语);`ATTRIBUTIVE_CLAUSE` 的下一个成分是 `OBJECT` / `PREDICATIVE` / `COMPLEMENT` 时拒绝(定语从句修饰的名词在从句之前,主句宾语只能在主句谓语之后,紧跟的宾语一定是从句自己的;主句谓语与主句状语跟在从句后面都合法,刻意不判);成分最后一个 lexical word 命中「几乎不可能悬垂」的介词表(`of/into/onto/upon/within/among/between/despite/during/toward/towards`)时拒绝(`for`/`with`/`at`/`from`/`to` 刻意不收,关系从句的介词悬垂让它们合法出现在成分末尾)。这三条从句硬门补的是「`that` 被单独标成定语从句、从句的谓语与宾语平铺到主句层」这一类——那个划分完全通过前九条。**缺主语本身不判**——祈使句本来就没有主语,文档里 `First, install the CLI.` 这类副词开头的祈使句更常见,按缺主语判会大面积误拒;`then` 是副词,不进从属连词表。grammar 判定只由结构可信度把关(每个 component 都有可用 range/role/translation、区间句内、有序不重叠、非纯标点),unknown field、translation too long、sentenceId 等非结构错误不得阻断同轮 grammar 诊断,两类错误必须同次返回。错误英文文案逐字一致并进入 repair prompt。**黄金集必须整份通过这套校验**(`core-gold-annotations.test.ts` 钉住):新硬门把正确答案判非法比漏判更糟,那会把合法分析送进无意义的修复轮。反过来,**过了 validator 不等于标注对**:2026-08-30 那批 32 句自动生成的标注只跑结构校验就并进了黄金集,9-02 复核出 15 处错标(`that` 单独当从句、`developers` 当主语从句、介词悬空、系表两种口径混用),错标注会让评分器奖励线上正在犯的错。新增黄金句必须人工核语言学正确性,并同时补一条能机器判定的口径断言。
- **core repair 至多两轮且逐轮收窄**:TS/Kotlin 每一轮只携带仍失败句、该轮最新非法 JSON 子集与对应 errors，已经修好的兄弟句不得回流；repair prompt 对 `PREDICATE` 吞入限定词开头名词短语必须明确要求在限定词前切开并逐条自检。IntelliJ 每个 `CORE_ERROR` 必带 `tokensJson`，双端 bridge 严格校验，渲染错误时登记句序并用 `leadingWhitespace + text` 重建原句。
- **tokenization 变化同时升两条提示词版本**:core span 与 detail focus 都依赖 Token ID,所以分词改动必须同时提升 `CORE_PROMPT_VERSION` 与 `DETAIL_PROMPT_VERSION`;当前为 `CORE_SCHEMA_VERSION=3`、core `10`、detail `5`。
- **准确性改动用黄金集评分,CI 不联网**:`core-gold-annotations.json` + 纯评分器比较整句 exact、span/labeled span P/R/F1、exact-span role accuracy 与逐句错误,不能只凭单句手测;`.superpowers/acceptance/run-core-gold-evaluation.mjs` 仅手动真模型评测,不进 CI。runner base URL 只接受 HTTP(S),拒绝 username/password/query/fragment；网络请求、日志与 artifact 统一使用去尾斜杠的规范化安全 URL。
- 调度优先级:`user-retry(0) > detail-click(1) > visible-core(2) > prefetch-core(3) > prefetch-detail(4)`。**1 请求 = 1 槽位**(`RunTask`,没有批处理、没有 `batchKey`),所以 `concurrency` 就是真实在飞的模型请求数;`backgroundConcurrency`(默认 `concurrency - 1`)给交互请求留活口,因为在跑的请求不会被抢占。同优先级内 `jumpQueue` 先出队,专供修复 pass——**不得跨优先级抬高**,否则 prefetch 的修复会插到可见段落前面。
- 一次 core 请求最多 `MAX_SENTENCES_PER_REQUEST`(6)句,`analyzeCore` 负责切块;这个常量与调度器的 `maxSentencesPerRequest` 必须一致,超出会被直接拒成 `SENTENCE_TOO_LONG`,整段拿不到译文。
- `ANALYZE_CORE` 的 `offscreen` 由 content 依视口判定并置位,SW 据此降为 `prefetch-core`;**用户显式发起的解析(选中/悬停/右键/重新解析)一律不置位**。
- **段落级进度标记只绑 `requesting` 相位**:打标/撤标统一由 `transition()` 收口刷新(`refreshBlockActivity`),挂载点取 `replacement.currentElement()` 以便流式换卡片后跟随。三条硬约束:①**必须用 data 属性,不能用 class**——`BlockReplacement` 靠「原文本来有没有 class 属性」决定还原时删不删空 `class`,标记先一步加 class 会让它误判,在页面上留下 `<p class="">`(而此时标记已迁到卡片上,清理不到原文),曾一次弄红三条 E2E;②竖条必须用 `inset box-shadow` 而非 `border-left`,后者参与布局计算会让文字位移,推翻折行布局 E2E;③重连彻底失败时 `reconnectAndResume` 直接返回、相位停在 `requesting`,必须单独清标记,否则竖条常亮。
- **显式手势不套用自动扫描的取舍**:`scanDocument` 要在整页里躲开边栏与样板文字,所以只认 `BLOCK_SELECTOR`、限定在得分最高的正文容器内、并要求 20 字符起;`nearestSafeBlock` 只服务用户指到的那一处,两条都不适用——曾经套用后表现为「鼠标明明停在段落上,快捷键却报『未找到可解析的段落』」(多 article 页面、SPA 换内容后缓存失效、短段落全中招)。显式路径**按渲染盒子而非标签名认块**(`isRenderedBlock` 看 computed display,`LOOSE_BLOCK_SELECTOR` 只作兜底)——Mintlify 一类文档站(含 Claude Code 自己的文档)整篇正文都是 `<span data-as="p">`,只按标签名认块会把这类站点整页判成「未找到」。同时**只认叶子块**(`hasBlockChild`),否则往上找会撞到包着整篇正文的外层容器。注意 happy-dom 里内联元素的 computed display 是空串而非 `"inline"`,判据要把空串算作非块。给 `nearestSafeBlock` 加回任何「正文容器/最短长度」限制前,先想清楚它只有显式调用方。

## 真机验收

- 脚本放 `.superpowers/acceptance/`(已 gitignore,**永不提交**)。
- API key 只从环境变量读(如 `DEEPSEEK_API_KEY`,在 `~/.secrets`),日志一律脱敏(`key <masked>`)。
- 运行:`source ~/.secrets && node .superpowers/acceptance/<script>.mjs`。

## 文档同步(改代码时顺手做)

`docs/architecture/` 要跟着代码走。两道防线:

1. **`chrome-plugin/src/shared/architecture-docs.test.ts`**(随 chrome-plugin 的 `npm test` 跑)钉住**能机器判定**的部分:枚举/错误码/消息类型/storage 键/调度优先级/相位全覆盖、关键常量数值一致、新增源文件必须进模块地图。它红了就去改文档,**不要放宽断言**。
2. **`npm run docs:drift`**(在 `chrome-plugin/` 里,改完代码、提交前跑一次)按本次改动的文件反查该核对哪几份文档。上面那条测试只认「名字与数字」,改现有文件的内部逻辑它一条都不会红——而「新增功能」多半正是这一类,这个脚本补的就是那一段。它只判断「相关文档有没有被碰过」,改得对不对仍然靠你;确实没有新说法要记(改 typo、纯重构)就忽略。

**两个工具都管不到、只能靠你的**——命中下列任一条就顺手改对应文档:

| 你改了                                     | 同步                                                                 |
| ------------------------------------------ | -------------------------------------------------------------------- |
| 新增/删除源文件,或某模块职责变了           | `modules.md`                                                         |
| 消息的字段、权限门、SW 侧行为              | `protocol.md`                                                        |
| 提示词结构、降级逻辑、超时、分块、缓存策略 | `model-pipeline.md`                                                  |
| 扫描规则、卡片结构、面板锚定、替换/标记    | `rendering.md`                                                       |
| 门禁、测试分层、假服务器契约、发版流程     | `build-test-release.md`                                              |
| 踩了新坑并修好                             | `invariants.md` 加一条(规则/为什么/症状/守护测试),重要的同步进本文件 |
| 运行时上下文、链路时序、状态机             | `overview.md`                                                        |

## 流程

- 新功能先走 brainstorming 出方案确认,再写 spec(`docs/superpowers/specs/`)与实现计划(`docs/superpowers/plans/`),后编码(TDD)。
- git 远端走 gh HTTPS(本环境 SSH 被墙)。
