# 后台模型链路

从"content 发来一条 `ANALYZE_CORE`"到"结果进缓存"之间发生的一切。涉及 `analysis-service.ts`、`prompts.ts`、`request-scheduler.ts`、`openai-compatible-adapter.ts`、`sse.ts`、两个 stream parser、`analysis-cache.ts`——都在 `chrome-plugin/src/background/`(文件名就不再逐个带前缀)。

## 1. 全景

```
CachedAnalysisService.analyzeCore(input, signal)
  │
  ├─ 1. 逐句算缓存键 → getCore()
  │     └─ 命中的还要过一遍 validateCoreBatch(缓存里可能是旧结构)
  │
  ├─ 2. 未命中的按端点切块           云 2 句 / 本地(loopback) 6 句
  │
  ├─ 3. 每块并行走 analyzeCoreChunk()   ← Promise.allSettled,一块失败不连坐
  │     ├─ buildCorePrompt(chunk)
  │     ├─ scheduler.schedule({priority, cacheKey, documentId, sentenceCount})
  │     │     └─ adapter.completeJson() 或 completeJsonStreaming()
  │     ├─ dropPunctuationOnlyComponents()   本地修掉纯标点成分
  │     ├─ validateCoreBatch() 逐句判定
  │     ├─ 不合格句 → buildRepairPrompt → 再来一次(jumpQueue)
  │     └─ 合格句 → putCore()
  │
  └─ 4. 汇总 { result[], failures[], cacheHit }
        failures 里的 AUTH_FAILED 会让 SW 暂停该 profile
```

`analyzeDetail` / `analyzeSentenceDetails` / `reanalyzeWithFeedback` 是同一套骨架的变体:**查缓存 → 请求 → 校验 → 至多一次修复 → 写缓存**。

## 2. 提示词(`prompts.ts`)

三类主提示词 + 四类修复提示词:

| 构造函数                                       | 首行前缀(**E2E 假服务器靠它识别请求类型,改了会炸**)              |
| ---------------------------------------------- | ---------------------------------------------------------------- |
| `buildCorePrompt`                              | `Analyze the numbered English sentences`                         |
| `buildRepairPrompt`                            | `Repair only the structure of the invalid core-analysis JSON`    |
| `buildDetailPrompt`                            | `Explain only the selected grammatical component`                |
| `detailRepairPrompt`(在 `analysis-service.ts`) | `Repair only the structure of the invalid detail-analysis JSON`  |
| `buildSentenceDetailsPrompt`                   | `Explain each requested grammatical component`                   |
| `sentenceDetailsRepairPrompt`                  | `Repair only the structure of the invalid sentence-details JSON` |
| `correctionPrompt`                             | `Reanalyze the supplied sentence`                                |
| `correctionRepairPrompt`                       | `Repair only the structure of the invalid correction analysis`   |

### 两条省 token 的硬规则

1. **句子一律走 `serializeSentences` / `serializeSentence`。** 模型只按 Token ID 定位,`start` / `end` / `leadingWhitespace` 是死重量——美化输出完整 Token 记录曾把 prompt 撑到原文的 **35 倍**(一个三字母单词占 145 字符)。现在只发 `{id, text}`,`punctuation` 仅在为真时出现。
2. **其余内嵌 JSON 一律走 `serialize`(不缩进)。** 一个 6 成分长句的核心结果:美化 827 字符 / 紧凑 555;整句详解 prompt 从 4074 降到 3693(**-9%**)。`prompts.test.ts` 与 `analysis-service.test.ts` 各有一组 `/\n {2}"/` 断言钉住这点。

### 输出侧:`MINIFIED_OUTPUT`

每份输出规格都以这条结尾:要求单行紧凑 JSON、无缩进、无 Markdown 围栏。

> 云端 API 的耗时几乎只由**输出** token 决定:实测 TTFT 恒定 ~0.65s 且与输入大小无关,总时 ≈ `0.65s + 输出token/190`。默认缩进 JSON 里,前导空格、换行、重复键名全要逐 token 生成——加这一条实测**省 40% 输出 token、快 36%**。流式解析器是字符级帧解析、不依赖换行,所以不受影响(`core-stream-parser.test.ts` 钉住)。

### 语法规则句

`buildCorePrompt` 里逐条声明:16 值封闭枚举、闭区间 Token 语义、覆盖率规则、**同层成分规则**(`PREDICATE` 不得吞并可单独标注的 `OBJECT` / `PREDICATIVE` / `COMPLEMENT` / `ADVERBIAL`,祈使句也只标谓语中心)、并列句规则(每个能独立成句的分句整体标 `COORDINATE_CLAUSE`,连词单独标 `CONJUNCTION`)、复合句规则(从句整体标五类从句之一,不拆内部)、简单句规则(单主谓不得包成 `COORDINATE_CLAUSE`)、译文要求。

详解 `structures` 只拆当前 focus 内部,必须按 Token ID 有序且互不重叠;完整响应由 `validateDetail` 拒绝越界/重叠,流式 `ProvisionalStructures` 同步过滤,防止先画整段、再重复画内部词组。

## 3. JSON Schema(`analysis-service.ts`)

三份 `JsonSchemaSpec`:`CORE_SCHEMA`、`DETAIL_SCHEMA`、`SENTENCE_DETAILS_SCHEMA`(= `{details: [DETAIL_SCHEMA]}`)。

支持 `response_format: json_schema` 的端点走 schema 约束;不支持的走**兼容模式**——此时输出形状只能靠提示词里的 `*_OUTPUT_SHAPE` 说清楚,所以那几段文字不是冗余。Kotlin 端也必须生成标准 JSON Schema:`required` 是字符串数组,字段定义放在 `properties`;连续 `put("required", "...")` 会相互覆盖,顶层直放字段也不是 Schema 属性。

`DETAIL_SCHEMA` 里 `translation` **刻意不列入 `required`**:兼容模式下模型偶发缺失时降级为两行标注,而不是整次 `INVALID_MODEL_OUTPUT`。

## 4. 调度器(`request-scheduler.ts`)

### 优先级

```
user-retry(0) > detail-click(1) > visible-core(2) > prefetch-core(3) > prefetch-detail(4)
```

排序键:`优先级 → jumpQueue → 入队序号`。

- **`jumpQueue` 专供修复 pass**(读者已经在等这一句),它**只在同优先级内插队,绝不跨优先级抬高**——否则 prefetch 的修复会插到可见段落前面。
- **1 请求 = 1 槽位**(`RunTask` 接单个 `ScheduledRequest`,没有批处理、没有 `batchKey`),所以 `concurrency` 就是真实在飞的模型请求数。
- `MODEL_REQUEST_CONCURRENCY = 4`。早先的 2 把整个扩展卡住:视口 `rootMargin` 100% 一次放出上下各一屏的段落,队尾要干等好几轮完整往返。
- `backgroundConcurrency`(默认 `concurrency - 1` = 3)给交互请求留活口。**正在跑的请求不会被抢占**,所以光有优先级不够:两个整句详解预载(系统里最长的生成)可能占满全部槽位,而读者刚滚到新段落。

### 其它行为

| 机制 | 说明                                                                                                    |
| ---- | ------------------------------------------------------------------------------------------------------- |
| 去重 | key = `documentId + cacheKey`;同 key 在飞时直接返回同一个 Promise                                       |
| 上限 | `sentenceCount > maxSentencesPerRequest`(6)或估算 token 超 `tokenBudget` → 立刻拒成 `SENTENCE_TOO_LONG` |
| 重试 | 仅 `retryable` 错误,最多 2 次;延迟 = `Retry-After` 或 `500 × 2^attempt + jitter(0~100)`                 |
| 取消 | `cancelDocument(documentId)`:队列里的直接 reject,在飞的 abort                                           |

`MAX_SENTENCES_PER_REQUEST = 6` 这个数字在**三处共用**(content 攒批、service 切块、scheduler 上限),任一侧自写常量都会漂移。

## 5. 分块策略

```ts
const CLOUD_SENTENCES_PER_REQUEST = 2;
sentencesPerRequest(baseUrl) = isLoopbackBaseUrl(baseUrl) ? 6 : 2;
```

两类端点的取舍**相反**:

- **云端**:耗时几乎只由输出 token 决定,多句塞一条请求就是让输出串行排队。实测同样 6 句——1 条 6 句 **8.0s**,3 条 2 句并发 **3.1s**。
- **本地(loopback)**:模型串行处理请求,请求数才是杠杆,合并成大块才快(CHANGELOG 1.0.4 记录的收益)。

判定失败时 `isLoopbackBaseUrl` 返回 `false`,退回云端策略——远端才是默认场景。

## 6. 适配器与三种能力降级(`openai-compatible-adapter.ts`)

### 请求体

```json
{
  "model": "...",
  "messages": [...],
  "temperature": 0,
  "stream": true | false,
  "reasoning_effort": "none",          // 默认下发,除非已探到不支持
  "response_format": { "type": "json_schema", ... }   // 除非已探到不支持
}
```

头:`Content-Type` + `Authorization: Bearer <apiKey>` + profile 的自定义头。

### 降级矩阵

| 能力位                             | 触发条件                                                                           | 记录         | 之后的行为                                |
| ---------------------------------- | ---------------------------------------------------------------------------------- | ------------ | ----------------------------------------- |
| `jsonSchemaSupport: "unsupported"` | 400/422 且响应体提到 `response_format` / `json_schema`                             | 写回 profile | 不再发 `response_format`,靠提示词约束形状 |
| `streamSupport: "unsupported"`     | 400/422 且响应体提到 `stream`;或 `response.body === null`;或整流一个内容分片都没有 | 写回 profile | 直接走缓冲路径                            |
| `reasoningControl: "unsupported"`  | 400/422 且响应体提到 `reasoning_effort`                                            | 写回 profile | 去掉该字段重发                            |

三者都**只持久化否定态**,`undefined` 表示值得一试。写回由 `createProfileCapabilityWriters()` 装配——**三个写入器都必须接线**,漏掉任一个就会在每次请求上重复交同一笔学费(一趟白费的 4xx)。

### 为什么默认关模型思考

思考模型会为一句话生成上万 token 推理:**Qwen3 实测单句 246 秒**;**DeepSeek `v4-flash` 实测 153 秒 / 14789 token**——远超 `timeoutMs` 的 120 秒上限,表现为**整页无译文而非变慢**。带 `reasoning_effort: "none"` 后同一句降到 **1.41 秒 / 135 token**。

DeepSeek 现存的两个模型全是思考模型,靠用户自己发现并勾选并不可靠,而降级路径已经让默认下发变得安全。**这条曾经的约定("绝不能默认下发,靠用户在选项页勾选")已废弃**;`disableReasoning` 字段仅为兼容旧 profile 保留,不再影响请求。

> Ollama 只认 `reasoning_effort`;`think: false` 与 `chat_template_kwargs.enable_thinking` 都被其 OpenAI 兼容层忽略。

### 超时策略

| 路径                  | 策略                                                   |
| --------------------- | ------------------------------------------------------ |
| 缓冲(`request`)       | 单次 `setTimeout(profile.timeoutMs)` 覆盖整个请求      |
| 流式(`streamRequest`) | **静默超时**:每收到一片就重置 `timeoutMs`,总时长不设限 |

流式下总时长没有意义——一段长响应本来就会超过单次超时值。另外**读循环自己 `Promise.race` 盯着 abort 信号**,不依赖 fetch 把中止传播进 body 流,卡死的流才会真的被掐断。

### HTTP 错误映射

| 状态                                                | 映射                                                           |
| --------------------------------------------------- | -------------------------------------------------------------- |
| 401 / 403                                           | `AUTH_FAILED`(不可重试)                                        |
| 404,或 400 且响应体匹配 `model…not exist/not found` | `MODEL_NOT_FOUND`                                              |
| 429                                                 | `RATE_LIMITED`(可重试;解析 `Retry-After`,支持秒数与 HTTP 日期) |
| 其它                                                | `NETWORK_ERROR`,`retryable = status >= 500`                    |

响应内容还会经 `stripSingleJsonFence()` 剥掉整块 ` ```json ` 围栏再 `JSON.parse`。

### 能力探测

`probeJsonCapability()` 发一条极小请求(要求返回 `{"ok":true}`),用于选项页的「测试连接」。保存 profile 后也会**静默跑一次**:不探的话,第一次真实解析要拿用户等待的那次请求去试错。

## 7. 流式:SSE → 分片 → 暂定成分

```
fetch(stream:true) → ReadableStream
  → TextDecoder(stream:true)
  → SseDecoder.push()            按空行切事件,只取 data: 字段,跨 chunk 缓冲半行
  → deltaContent()               取 choices[0].delta.content;畸形保活帧静默跳过
  → CoreStreamParser.push()      字符级扫描,抠出闭合的 component 并归属 sentenceId
  → ProvisionalComponents.accept()   过滤:角色在枚举内 / 区间在界内 / 与已发成分有序不重叠
  → SW streamSink → redactProfileSecrets → port.postMessage(CORE_STREAM)
```

- `SSE_DONE`(`[DONE]`)为结束哨兵。
- **两个 parser 刻意不合并**:core 信封把 component 嵌在 `sentences[]` 里、需要归属到句;detail 信封是扁的。合并就得把归属逻辑穿进两边。
- 两者都是 **key-aware 而非数括号深度**:detail 信封在 `structures` 之前还有一个 `focus` 对象,structure 内部也可能嵌对象,数深度会两头认错。
- 都容忍模型先吐 Markdown 围栏或散文(遇到第一个 `{` 才开始)。
- **分片是未校验输出**,所以 SW 侧的 `ProvisionalComponents` / `ProvisionalStructures` 只放行"能安全画出来"的那些,**并且必须经与完整结果同款的 `sanitizeCore` 脱敏**——不能因为"只是预览"就跳过。

## 8. 校验与修复

```
raw → dropPunctuationOnlyComponents → validateCoreBatch
        ok  → putCore
        !ok → buildRepairPrompt(原句 + 校验错误 + 非法 JSON 子集) → 再请求一次(jumpQueue)
                ok  → putCore
                !ok → INVALID_MODEL_OUTPUT(带错误摘要)
```

- **只修一次。** 第二次仍不合格就作为失败上报。
- 修复请求只带**失败的那几句**(`invalidRawSubset`),不重发整块。
- **修复轮与首轮共享同一份规则清单**(`CORE_ANALYSIS_RULES`)。修复 prompt 曾只带 peer + supplement 两条,覆盖率、角色枚举、并列/复合/简单句和译文要求全丢——一句进了修复轮,剩下的唯一语法指导就是"把成分拆开",实测越修越碎。
- 纯标点成分走本地归一化:覆盖率规则本就允许标点不被覆盖,丢掉它即合法,渲染层会按源 Token 画回原位。Chrome 的 `dropPunctuationOnlyComponents` 与 IntelliJ 的 `validateCoreBatch` 都必须在角色枚举校验前处理，因此即使模型给逗号虚构 `PUNCTUATION` / `CONJUNCTION` 等角色也不会让整句失败；流式暂定成分同样读取原 Token 的 `punctuation` 标记并拒绝纯标点，避免最终校验前短暂显示成“并列连词”。
- core / repair prompt 的 `SUPPLEMENT_RULE` 区分破折号、冒号后的补充说明或列举与真正并列句：补充跨度使用 `APPOSITIVE` / `INDEPENDENT_ELEMENT`，内部可分离谓语、宾语、状语仍按同层成分输出；名词短语不能连同其关系从句整体标成 `ATTRIBUTIVE_CLAUSE`（`the ones that matter` 中只有 `that matter` 是从句）。
- `validateCoreBatch` 还把四条**代码实际可判的语法粒度约束**变成硬门：组件序列相邻且 Token 区间连续的两个 `PREDICATE` 必须合并；成分去掉标点后恰好一个 lexical word、role 不是 `CONJUNCTION` 且命中保守的高把握“必须带宾语”介词白名单时，必须并入其管辖短语（`after/before/down/off/over/since/until/around/inside/outside` 等常见副词、表语或连词兼类词不收）；`COORDINATE_CLAUSE` 数量恰好为 1 时非法；`CONJUNCTION` 至少含一个 FANBOYS。grammar 只在结构可信时执行：所有 component 都有可用 range/role/translation、区间句内、有序不重叠、非纯标点；unknown field、translation too long、sentenceId 等非结构错误不阻止同轮 grammar 诊断，两类错误同次报告。TS/Kotlin 逐条、逐文案一致，错误会原样进入 repair prompt。

### 8.1 成分粒度的三条边界(`CORE_PROMPT_VERSION` 6)

只有"别让谓语吞掉宾语"这类**下界**规则时,指令型文本会被切成词级碎片。同一模型(deepseek-v4-flash,temperature 0,兼容模式)实测:

| 输入                                                                                          | 只有 peer 规则                                                                           | 补齐三条边界后                                                                 |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `Help turn ideas into fully formed designs and specs through natural collaborative dialogue.` | 8–9 成分:`Help` / `turn` 两个 `PREDICATE`、`into` 与其宾语拆开、宾语短语误标 `ATTRIBUTE` | 4 成分:`PREDICATE(Help turn)` + `OBJECT(ideas)` + 两个整体介词短语 `ADVERBIAL` |
| 6 个祈使动词逗号串成的一句                                                                    | 16 成分 / 6 个 `PREDICATE`                                                               | 12 成分 / 0 个 `PREDICATE`(整串按 `COORDINATE_CLAUSE`)                         |

三条边界:

1. `CLAUSE_FIRST_RULE`——**先定分句层级**:两个以上各带谓语、能独立成句的分句(逗号/冒号/分号/破折号/并列连词分隔,含祈使句串)一律一句一个 `COORDINATE_CLAUSE`,不再往分句内部拆。
2. `PREDICATE_SCOPE_RULE`——`PREDICATE` 只覆盖动词组本身(含 `help/let` 后的原形动词链,`Help turn` 是**一个**谓语);两个 `PREDICATE` 不得相邻。
3. `PREPOSITIONAL_PHRASE_RULE`——介词与它管辖的一切(含并列宾语)是**一个**成分;动词或介词管辖的名词短语永远不是 `ATTRIBUTE`。

**顺序是规则的一部分**:分句规则必须排在 `PEER_COMPONENT_RULE` 之前,`PEER_COMPONENT_RULE` 本身也收窄为"在单个分句之内"。两条平列摆着时实测同一句会在两种切法之间跳(同一 prompt 连发两次得到 7 成分 / 0 谓语与 17 成分 / 2 谓语两种结果)。`prompts.test.ts` / `PromptsTest.kt` 用 `indexOf` 钉住这个顺序。

两端提示词逐字一致由 `shared-fixtures/core-prompt-parity.json` 钉住(整段 prompt 存进 fixture,规则文本、章节顺序、分词结果任一处分叉都会红)。改提示词的姿势:两端一起改 → 更新 fixture → 升 `CORE_PROMPT_VERSION`(键会自动作废旧粒度结果)。

### 8.2 Token 坐标变化与版本

`tokenize()` 现在把白名单点号缩写（如 `U.S.` / `Ph.D.`）、小数/千分位/语义版本号、带 scheme 的 URL 与邮箱各作为**一个 Token**。通用姓名 initials 链（如 `J. R. R.`）不会合成一个 Token；它只在 `segmentBlock()` 的分句边界阶段持续向后合并，避免姓名中间误断。这不是显示层细节：core component span 与 detail focus 都以 Token ID 闭区间定位，任何拆分变化都会让旧缓存区间指向错误文本。因此本次 `CORE_PROMPT_VERSION = 6` 同时覆盖 core prompt 粒度规则与 tokenization 的变化；tokenization 又改变 detail focus 坐标，所以 `DETAIL_PROMPT_VERSION = 5`。结果 JSON 形状没有变化，`CORE_SCHEMA_VERSION` 保持 `3`。只升 core 会留下 focus 已漂移的详解缓存，只升 detail 则会复用 span 已漂移的 core 缓存。

### 8.3 黄金集 runner 的 provider 端点

手动真模型 runner 在加载 Vite、输出日志和发送请求前解析 `CORE_EVAL_BASE_URL`：只接受 HTTP(S)，拒绝 URL credentials、query 与 fragment，并把尾斜杠规范化掉。completion URL 从这份已验证 URL 构造，控制台与 candidate artifact 也只记录同一份 safe URL，避免凭据泄露或请求语义与评测记录不一致。该约束不改变 API key/provider error 脱敏，也不改变 `reasoning_effort` 与 `response_format` 的 400/422 降级。

## 9. 缓存(`analysis-cache.ts`)

- 库 `english-syntax-learning-v1`,version 2,三 store。**v1→v2 升级直接清空**:键构成变过(去掉了 profile / 模型 / 提示词维度),旧键永远查不到。
- 每条记录带 `estimatedBytes`(JSON 字节 + 256);每次 `put` 后跨三个 store 按 `lastAccessedAt` 升序淘汰到 `limitBytes` 以内。
- `nextTimestamp()` 保证单调递增,同毫秒内多次写入也不会撞 LRU 顺序。
- 导入导出只涉及 `core` / `detail`;`correction` 绑页面实例,跨人不可命中。导入是**本地优先合并**:已有键跳过,整批一个事务,最后统一执行一次 LRU。
- 选项页与 SW **直连同一个库**(同 `DATABASE_VERSION`),大文件不过消息通道;IndexedDB 事务自身保证并发安全。

## 10. 鉴权暂停机制(`service-worker.ts`)

一旦某 profile 返回 `AUTH_FAILED`,SW 用 `pausedProfiles`(id → 凭据指纹)把它挂起:

- 指纹 = `[baseUrl, apiKey, model, 排序后的 headers]` 的 JSON。**用户改了凭据,指纹变化即自动解除暂停。**
- 暂停期间:`ANALYZE_CORE` 仍返回缓存命中 + 批级 `AUTH_FAILED`;`ANALYZE_DETAIL` 先查缓存,未命中才报错;预载与纠正直接报错。
- 「测试连接」**不受暂停门拦截**(这是用户显式自检),成功即解除——修好服务端后无需重载扩展。

## 11. 脱敏

`redactProfileSecrets(text, profile)` 把 `apiKey` 与所有自定义头的值在文本里替换成 `[redacted]`。覆盖:

- `sanitizeCore()` —— 所有 `CORE_RESULT`;
- `sanitizeDetail()` —— 所有 `DETAIL_RESULT`;
- `CORE_STREAM` / `DETAIL_STREAM` 的每一片;
- `PROFILE_TEST_RESULT` 里回带的 provider 错误详情截断到 300 字符。

纯缓存模式没有 profile,也就没有可脱敏的密钥,直接返回。

## IntelliJ 插件的模型链路(Kotlin 侧)

与 Chrome 端同一骨架,差异点:

- **优先级**:五档同名同序(`USER_RETRY > DETAIL_CLICK > ACTIVE_VISIBLE_CORE > OTHER_VISIBLE_CORE > ACTIVE_PREFETCH_CORE`)。IntelliJ 侧多一档语义:非活动预览的可见块走 `OTHER_VISIBLE_CORE`(Chrome 端只有单文档,用不到)。
- **分块**:`isLoopbackBaseUrl` 判定本地端点(Ollama 等)时每请求 6 句,云端 2 句——与 Chrome 端的 `CLOUD_SENTENCES_PER_REQUEST` 语义一致。
- **缓存**:SQLite(`analysis_cache` 表,跨 core/detail store 的 LRU,键与 Chrome 扩展逐字节一致),导入导出格式与 Chrome 选项页互通(`english-syntax-cache` v1)。设置页显示当前条目数/估算占用,经二次确认可清空 core 与 detail 全部缓存;只删除持久缓存,不停止在途请求、不移除预览页已渲染卡片。连接经 `SQLiteDataSource` 直接实例化,**不用 `DriverManager.getConnection`**——后者依赖 sqlite-jdbc 的 ServiceLoader 自动注册,在 IDEA 插件 classloader 下不可靠,曾抛 `No suitable driver found for jdbc:sqlite:` 导致 Action 点击静默失败;`SQLiteDataSource` 不碰全局驱动注册表,动态卸载也无类加载器泄漏。
- **降级**:`JsonSchemaSupport`/`streamSupport`/reasoningControl 三块与 Chrome 端对称,只持久化否定态。设置页「测试连接」按钮(ConnectionProbe)会先保存 profile、再经 `probeJsonCapability` 打一次真模型探测,把 JSON schema 支持态写回 profile 并在状态栏反馈——与 Chrome 选项页「测试连接」同套路。
- **修复 pass**:整块校验失败只把非法句送修复(`jumpQueue` 同优先级插队),修复后仍失败记 `INVALID_MODEL_OUTPUT`,兄弟句不受连坐。
- **流式**:分片先经 `ProvisionalComponents`/`ProvisionalStructures` 安全过滤(角色枚举、区间界内、有序不重叠)再作为 `CORE_STREAM` 推给页面;分片不写缓存、不改相位——与 Chrome 端约定一致。
