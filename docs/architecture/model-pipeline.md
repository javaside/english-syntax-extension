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

`buildCorePrompt` 里逐条声明:16 值封闭枚举、闭区间 Token 语义、覆盖率规则、并列句规则(每个能独立成句的分句整体标 `COORDINATE_CLAUSE`,连词单独标 `CONJUNCTION`)、复合句规则(从句整体标五类从句之一,不拆内部)、简单句规则(单主谓不得包成 `COORDINATE_CLAUSE`)、译文要求。

## 3. JSON Schema(`analysis-service.ts`)

三份 `JsonSchemaSpec`:`CORE_SCHEMA`、`DETAIL_SCHEMA`、`SENTENCE_DETAILS_SCHEMA`(= `{details: [DETAIL_SCHEMA]}`)。

支持 `response_format: json_schema` 的端点走 schema 约束;不支持的走**兼容模式**——此时输出形状只能靠提示词里的 `*_OUTPUT_SHAPE` 说清楚,所以那几段文字不是冗余。

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
- `dropPunctuationOnlyComponents` 是纯本地修复:覆盖率规则本就允许标点不被覆盖,丢掉纯标点成分即合法,渲染层会把它画回原位。实测每碰上一次就省掉一整轮模型往返(本地 6–23 秒)。

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
- **缓存**:SQLite(`analysis_cache` 表,跨 core/detail store 的 LRU,键与 Chrome 扩展逐字节一致),导入导出格式与 Chrome 选项页互通(`english-syntax-cache` v1)。连接经 `SQLiteDataSource` 直接实例化,**不用 `DriverManager.getConnection`**——后者依赖 sqlite-jdbc 的 ServiceLoader 自动注册,在 IDEA 插件 classloader 下不可靠,曾抛 `No suitable driver found for jdbc:sqlite:` 导致 Action 点击静默失败;`SQLiteDataSource` 不碰全局驱动注册表,动态卸载也无类加载器泄漏。
- **降级**:`JsonSchemaSupport`/`streamSupport`/reasoningControl 三块与 Chrome 端对称,只持久化否定态。设置页「测试连接」按钮(ConnectionProbe)会先保存 profile、再经 `probeJsonCapability` 打一次真模型探测,把 JSON schema 支持态写回 profile 并在状态栏反馈——与 Chrome 选项页「测试连接」同套路。
- **修复 pass**:整块校验失败只把非法句送修复(`jumpQueue` 同优先级插队),修复后仍失败记 `INVALID_MODEL_OUTPUT`,兄弟句不受连坐。
- **流式**:分片先经 `ProvisionalComponents`/`ProvisionalStructures` 安全过滤(角色枚举、区间界内、有序不重叠)再作为 `CORE_STREAM` 推给页面;分片不写缓存、不改相位——与 Chrome 端约定一致。
