# 协议与数据模型参考

一切定义在 `chrome-plugin/src/shared/`。**这是唯一真相**——`background` 与 `content` 互不 import,只靠这里的类型对齐。

## 1. 版本常量(`shared/versions.ts`)

| 常量                    | 当前值 | 含义                                                         | 改动影响                                               |
| ----------------------- | ------ | ------------------------------------------------------------ | ------------------------------------------------------ |
| `MESSAGE_VERSION`       | `1`    | 消息信封版本;收发两侧都校验                                  | 改了会让旧页面上残留的 content script 与新 SW 互不认账 |
| `CORE_SCHEMA_VERSION`   | `3`    | core / detail 结果的语义契约版本;**参与缓存键**              | 改了等于全量作废缓存;缓存导入也会因版本不符整体拒绝    |
| `CORE_PROMPT_VERSION`   | `8`    | core 提示词/Token 坐标版本;**参与 core / correction 缓存键** | 改了作废全部 core 缓存                                 |
| `DETAIL_PROMPT_VERSION` | `5`    | detail 提示词/focus Token 坐标版本;**参与 detail 缓存键**    | 改了作废全部详解缓存                                   |

> 缓存键**刻意不含** profile / 模型维度——换模型不该让已有译文全部作废;但**含提示词版本**,因为同一句在不同规则下会被切成不同粒度的成分,旧结果继续复用只会让新旧质量混在一屏。`CORE_PROMPT_VERSION = 8` 彻底删除了要求输出 `COORDINATE_CLAUSE` 的残留旧指令，并列句与 validator 一致地按同层成分平铺；Token 坐标未变，所以 `DETAIL_PROMPT_VERSION = 5`，结果 JSON 形状也未变，`CORE_SCHEMA_VERSION` 保持 `3`。

## 2. 请求消息 `RequestMessage`

共同字段:`version`、`requestId`;带页面上下文的另有 `tabId`、`documentId`。

共 16 条。「UI 门」「文档豁免」两列的含义见下一节。

| type                        | 发送方               | 额外字段                                    | SW 侧行为                                                | UI 门 | 文档豁免 |
| --------------------------- | -------------------- | ------------------------------------------- | -------------------------------------------------------- | ----- | -------- |
| `START_SESSION`             | popup / SW 自发      | `prefetchDetail?: true`                     | 注入 content script、读 profile 与预载开关、下发页面命令 | ✅    | ✅(总是) |
| `PAUSE_SESSION`             | popup                | —                                           | 转发页面 + 记状态                                        | ✅    | ✅       |
| `STOP_SESSION`              | popup(见下注)        | —                                           | 转发页面 + `scheduler.cancelDocument`                    | ✅    | ✅       |
| `GET_SESSION_STATUS`        | popup                | —                                           | 回 `activeTabs` 里的快照                                 | ❌    | ✅       |
| `REANALYZE_VISIBLE`         | popup                | —                                           | 转发页面(会话须非 stopped)                               | ✅    | ✅       |
| `SWITCH_PROFILE`            | popup / options      | `profileId`                                 | 设为启用 + pin 到该 tab                                  | ❌    | ✅       |
| `ANALYZE_CORE`              | content              | `sentences[]`、`bypassCache?`、`offscreen?` | 核心解析主路径                                           | ❌    | ❌       |
| `ANALYZE_DETAIL`            | content              | `sentence`、`core`、`focus`                 | 详解                                                     | ❌    | ❌       |
| `PREFETCH_SENTENCE_DETAILS` | content              | `sentence`、`core`                          | 整句预载全部成分详解                                     | ❌    | ❌       |
| `REANALYZE_WITH_FEEDBACK`   | content              | `sentence`、`core`、`feedback`              | 带用户纠正意见重解析                                     | ❌    | ❌       |
| `PARSE_SELECTION`           | 受信任 UI;或 SW 自发 | `selectionText`                             | 转发页面:解析选中文本                                    | ✅    | ❌       |
| `PARSE_CONTEXT_BLOCK`       | 受信任 UI;或 SW 自发 | —                                           | 转发页面:解析右键处的块(会话须非 stopped)                | ✅    | ❌       |
| `PARSE_HOVERED_BLOCK`       | 受信任 UI;或 SW 自发 | —                                           | 转发页面:解析鼠标悬停的块                                | ✅    | ❌       |
| `TEST_PROFILE`              | options              | `profileId`                                 | 探测端点能力;**成功即解除鉴权暂停**                      | —     | —        |
| `GET_CACHE_STATS`           | options              | —                                           | 缓存统计                                                 | —     | —        |
| `CLEAR_CACHE`               | options              | —                                           | 清空三个 store                                           | —     | —        |

后三条不带 `tabId` / `documentId`,两道页面级门都不适用(表中记 `—`)。

三个 `PARSE_*` 有两条入口:SW 自己的右键菜单 / 快捷键监听器用 `sendPageCommand()` **直接** `tabs.sendMessage` 给页面(不经 `route()`);而 `route()` 里的同名分支是留给受信任 UI 调用的。

> **注意 `STOP_SESSION` 的一条死路径。** `ChromeRuntimeTransport.cancelDocument()` 也会从 content 发这条消息,但该分支要求受信任 UI,所以它必然被回成 `UNSUPPORTED_PAGE`(调用处 fire-and-forget 吞掉了响应)。真正的取消依赖端口断开与 `tabs.onRemoved` / `onUpdated` 触发的 `cancelTab()`。

关键语义:

- **`offscreen`**:视口观察器带 100% `rootMargin`,一次会放出上下各一屏的段落。content 侧据视口判定并置位,SW 据此把优先级降为 `prefetch-core`。**用户显式发起的解析一律不置位。**
- **`bypassCache`**:「重新解析」用。跳过读缓存,结果照常覆盖写回。这是**请求级**标记,所以合批时按它单独分桶——混进同一条请求会波及别的块。

### 2.1 三道门,别混为一谈

`route()` 开头算出两个布尔量,加上 per-case 检查,一共是三道**互相独立**的门:

```ts
trustedExtensionUi = sender.tab === undefined
                  && sender.id === runtime.id
                  && sender.url?.startsWith(`chrome-extension://${runtime.id}/`)

trustedPageControl = trustedExtensionUi && type ∈ {START_SESSION, PAUSE_SESSION,
                     STOP_SESSION, GET_SESSION_STATUS, SWITCH_PROFILE, REANALYZE_VISIBLE}
```

| 门                | 适用范围              | 判据                                                      | 不过时              |
| ----------------- | --------------------- | --------------------------------------------------------- | ------------------- |
| **①来源门**       | 所有带 `tabId` 的消息 | `sender.tab.id === request.tabId`,或 `trustedExtensionUi` | `UNSUPPORTED_PAGE`  |
| **②文档新鲜度门** | 所有带 `tabId` 的消息 | `activeTabs` 里该 tab 的 `documentId` 与请求一致          | `REQUEST_CANCELLED` |
| **③UI 门**        | 仅 7 个 case 各自检查 | `trustedExtensionUi`                                      | `UNSUPPORTED_PAGE`  |

- 上表的 **「UI 门」列 = ③**:只有 `START_SESSION` / `PAUSE_SESSION` / `STOP_SESSION` / `REANALYZE_VISIBLE` / `PARSE_SELECTION` / `PARSE_CONTEXT_BLOCK` / `PARSE_HOVERED_BLOCK` 这 7 条有。
- 上表的 **「文档豁免」列 = 能否绕过②**:`trustedPageControl` 集合(6 条)可以豁免,`START_SESSION` 无条件豁免。
- **`GET_SESSION_STATUS` 与 `SWITCH_PROFILE` 只在②里被豁免,并没有③。** 它们在 `trustedPageControl` 集合里,但 case 体内没有 `if (!trustedExtensionUi)` 检查——两件事别搞混。

②的豁免为什么必要:popup 并不知道页面真实的 `documentId`,它一律用占位值 `popup-tab-${tabId}`。没有这条豁免,popup 的每一次启停与状态查询都会被判成过期文档。

**推论:占位 documentId 绝不能原样转发给页面。** 每一条会改会话的分支(含 `PARSE_SELECTION` / `PARSE_CONTEXT_BLOCK` / `PARSE_HOVERED_BLOCK`)都要先解析出真实 id——`activeTabs.get(tabId)?.documentId ?? request.documentId`——改写待转发的消息,并把这次手势记进 `activeTabs`。照占位值下发的话,页面路由按 `documentId` 认 controller,会为同一个标签页再建一套会话:卡片与上游调用都翻倍,而这套会话的状态中继又因与账本里的 id 不符被②拒成 `REQUEST_CANCELLED`。不记账则相反:SW 眼里这个标签页始终是 `stopped`,弹窗回落成「开始学习」,「解析此区域」与「重新解析可见段落」一律按停止态拒掉。已在跑 / 已暂停的状态要原样保留,只把 `stopped` 翻成 `running`(清零会抹掉真实计数,还会把暂停谎报成进行中)。

## 3. 响应消息 `ResponseMessage`

| type                      | 字段                                                                 | 何时出现                                        |
| ------------------------- | -------------------------------------------------------------------- | ----------------------------------------------- |
| `ACK`                     | `acknowledgedType`                                                   | 无返回值的命令                                  |
| `SESSION_STATUS`          | `status: SessionStatus`                                              | 启停 / 查询状态;**也被 content 复用为状态上报** |
| `CORE_RESULT`             | `analyses[]`、`cacheOnly?`、`error?`                                 | core 解析与带反馈重解析                         |
| `DETAIL_RESULT`           | `analysis: DetailAnalysis`                                           | 详解                                            |
| `SENTENCE_DETAILS_RESULT` | `succeeded`、`failed`                                                | 整句预载                                        |
| `CACHE_STATS`             | `stats`                                                              | 缓存统计                                        |
| `PROFILE_TEST_RESULT`     | `profileId`、`success`、`latencyMs?`、`jsonSchemaSupport?`、`error?` | 测试连接                                        |
| `ERROR`                   | `error: ExtensionError`                                              | 任何失败                                        |

`CORE_RESULT` 上的 **`error` 是批级的**:鉴权失败或 profile 被暂停时,缓存命中照常返回(键与模型无关),只有未命中句由 content 按该错误标失败——换 / 修模型前译文不消失。

## 4. 端口推送(不是响应)

流式分片走 content 已建立的 `syntax-learning:<documentId>` 端口,由 SW `postMessage`。**它们不经 `isRuntimeResponse` 的 switch**,content 侧用 `isCoreStreamPush` / `isDetailStreamPush` 单独把关。

```ts
CoreStreamPush   = { version, type: "CORE_STREAM",   documentId, sentenceId, components[] }
DetailStreamPush = { version, type: "DETAIL_STREAM", documentId, sentenceId, focus, structures[] }
```

两者承载的都是**未经整句校验**的模型输出:只用于渲染,**不写缓存、不改相位**。

## 5. `SessionStatus`

| 字段                                              | 含义                                                  |
| ------------------------------------------------- | ----------------------------------------------------- |
| `state`                                           | `stopped` / `running` / `paused`                      |
| `discovered`                                      | 已发现的句数(含屏外尚未入队的)                        |
| `queued`                                          | 相位为 `queued` 的句数                                |
| `ready` / `failed` / `skipped?`                   | 各终态句数(`skipped` = 纯缓存会话未命中)              |
| `inFlight?`                                       | `requesting + validating` 的句数                      |
| `cacheOnly?`                                      | 本次会话没有可用模型,只查缓存(影响所有进度文案的措辞) |
| `detailTotal?` / `detailReady?` / `detailFailed?` | 详解预载的**成分级**计数                              |
| `profileId?`                                      | 本会话 pin 的 profile                                 |

```ts
isSessionComplete(s) =
  s.discovered > 0 && s.queued === 0 && (s.inFlight ?? 0) === 0;
```

要求 `discovered > 0` 是因为会话刚启动时 SW 先塞一个空状态占位;少了这道保护会把"还没开始"当成"已完成"。

## 6. 新增一条消息的三层同步清单

漏掉任何一层都会在真机上以离奇方式暴露。**必须同时改这三处**:

1. `shared/protocol.ts`
   - 往 `RequestMessage` / `ResponseMessage` 联合体加成员;
   - 请求消息还要在 `isRequestMessage()` 的 switch 里加 case(用 `hasOnlyKeys` 白名单字段)。
2. `background/service-worker.ts`
   - `route()` 的 switch 加分支(结尾的 `assertNever` 会在漏加时编译报错——**这是唯一自动帮你的一层**);
   - 决定它是否需要 `trustedExtensionUi` 门;
   - 返回页面的模型文本记得走脱敏。
3. `content/content-script.ts`
   - `isRuntimeResponse()` 的 switch 加 case。

> 漏第 3 层是本仓库出过的真实事故:SW 的成功响应被守卫静默替换成 `ERROR`,缓存写对了但计数全错,一直到真机验收才暴露。
>
> 若新增的是**端口推送**而非响应,第 3 层换成"在 `shared/protocol.ts` 加独立的 `isXxxPush` 守卫,并在 `ChromeRuntimeTransport.connectWatchdog()` 的监听器里接线"——`isRuntimeResponse` 对它不适用,但三处同步的要求照旧。

## 7. 数据模型(`shared/grammar.ts`)

```ts
Token         = { id, text, start, end, leadingWhitespace, punctuation }
TokenRange    = { startToken, endToken }               // 闭区间,两端都是 Token.id
CoreComponent = TokenRange & { role: GrammarRole, translation }
CoreAnalysis  = { schemaVersion, sentenceId, components[], modelProfileId }

DetailStructure = TokenRange & { role: string, explanation, translation? }
DetailAnalysis  = { sentenceId, focus, structures[], grammarPoints[], explanation, modelProfileId }
```

- `CoreComponent.role` 取自 **16 值封闭枚举**;`DetailStructure.role` 是**模型自由文本**(提示词要求中文语法术语),渲染时按中文标签查配色、英文枚举兜底、都不中则灰色。
- `DetailStructure.translation` 是**渐进增强**:缺失时标注块退回两行,不算校验错误。
- 发给模型的 Token 载荷**只有 `{id, text, punctuation?}`**——`start` / `end` / `leadingWhitespace` 是死重量(见 `prompts.ts`)。

### 16 个语法角色

| 枚举          | 中文   |     | 枚举                  | 中文     |
| ------------- | ------ | --- | --------------------- | -------- |
| `SUBJECT`     | 主语   |     | `SUBJECT_CLAUSE`      | 主语从句 |
| `PREDICATE`   | 谓语   |     | `OBJECT_CLAUSE`       | 宾语从句 |
| `OBJECT`      | 宾语   |     | `PREDICATIVE_CLAUSE`  | 表语从句 |
| `PREDICATIVE` | 表语   |     | `ATTRIBUTIVE_CLAUSE`  | 定语从句 |
| `ATTRIBUTE`   | 定语   |     | `ADVERBIAL_CLAUSE`    | 状语从句 |
| `ADVERBIAL`   | 状语   |     | `INDEPENDENT_ELEMENT` | 独立成分 |
| `COMPLEMENT`  | 补语   |     | `COORDINATE_CLAUSE`   | 并列分句 |
| `APPOSITIVE`  | 同位语 |     | `CONJUNCTION`         | 并列连词 |

### 核心解析的覆盖率规则

`validateCoreBatch()` 强制:

1. 每个成分的 `[startToken, endToken]` 必须落在句内且两端命中真实 token;
2. 成分之间**有序、不重叠**;
3. **每个非标点 token 恰好被覆盖一次**;标点可以不被覆盖,但不得被覆盖两次;
4. 成分**不得只含标点**(模型偶发把逗号单切成一个成分——这条由 `dropPunctuationOnlyComponents()` 在本地直接丢掉,省一整轮模型往返);
5. `translation` 非空、无危险文本、长度不超过 `max(500, 英文长度 × 8)`；
6. 组件序列相邻且 Token 区间连续的两个 `PREDICATE` 必须合并；
7. 成分去掉标点后恰好一个 lexical word、role 不是 `CONJUNCTION`，且该词命中**保守的高把握介词白名单**时，不得独立成分，必须并入其管辖短语；`after/before/down/off/over/since/until/around/inside/outside` 等常见副词、表语或连词兼类词不收；
8. `COORDINATE_CLAUSE` 数量恰好为 1 时非法；0 或至少 2 个不触发这条门；
9. `CONJUNCTION` 的 lexical words 必须至少含一个 FANBOYS(`for/and/nor/but/or/yet/so`)；可以同时含其他词，并非只能含 FANBOYS。
10. `PREDICATE` 的**首个 lexical word** 不得是限定词、主格人称代词或 `that`——动词组不可能以它们开头，命中即说明主语被吞进了谓语；
11. `PREDICATE` 的**非首位 lexical words** 不得含限定词（`the/a/an/this/these/those/my/your/his/her/its/our/their`）——限定词是名词短语的左边界，出现在动词组内部说明宾语/表语/补语被吞了进来。`that` 刻意不在这一条里，它更常作宾语从句引导词；
12. `COORDINATE_CLAUSE` 的首个 lexical word 是从属连词（`because/although/as/if/when/while/since/until/that/…`）且整句**没有** `CONJUNCTION` 成分时非法——从属连词引导的是从句，不是并列分句。有 `CONJUNCTION` 时放行，因为 `Because A, B, and C` 里第一个并列分句本来就以从属连词开头；
13. 单个成分覆盖了句子**全部**非标点 token 且句子实词数 ≥ 4 时非法（不论 role）——那等于没有划分，卡片会退化成一整块译文。三个实词以内的片段（标题、列表项）没有可拆的同层结构，不触发。
14. 出现 2 个以上 `COORDINATE_CLAUSE` 时，整句必须另有一个 `CONJUNCTION` 成分或一个 `;` token——并列句的定义就是「各分句自带主语 + 并列连词或分号连接」。逗号串起来的祈使句、共享主语的并列谓语都不是并列句，包成分句块只会让卡片变成几整块译文。

后九条是 TS/Kotlin validator 逐条同步的代码判据，不是 prompt 中一般语言学要求的完整实现。都只看「成分序列 + Token 文本」，不需要句法分析器；词表刻意保守（`then` 是副词不算从属连词，祈使句串的第三个分句就以它开头；缺主语本身不判，祈使句本来就没有主语，`First, install the CLI.` 这类副词开头的祈使句更常见）。grammar 诊断只要求所有 component 都有可用 range/role/translation、区间句内、有序不重叠且非纯标点；unknown field、translation too long、sentenceId 等非结构错误不阻止同轮 grammar 诊断。校验错误文案会被 repair prompt 原样引用，因此两端不仅判据要一致，英文文案也要一致；否则同一个模型输出会得到不同修复指令与缓存结果。

## 8. 错误码(`shared/errors.ts`)

| code                     | 可重试   | 典型来源                                               | 用户可见处理                                               |
| ------------------------ | -------- | ------------------------------------------------------ | ---------------------------------------------------------- |
| `CONFIG_MISSING`         | ✗        | 没有可用 profile                                       | 引导去选项页                                               |
| `HOST_PERMISSION_DENIED` | ✗        | 用户拒绝了 host 权限                                   | 提示重新授权                                               |
| `AUTH_FAILED`            | ✗        | HTTP 401/403                                           | **暂停该 profile**;403 额外提示 Ollama 的 `OLLAMA_ORIGINS` |
| `MODEL_NOT_FOUND`        | ✗        | HTTP 404,或 400 且响应体含 "model not exist"(DeepSeek) | 提示检查 model 名                                          |
| `RATE_LIMITED`           | ✓        | HTTP 429                                               | 按 `Retry-After` 透明重试                                  |
| `NETWORK_ERROR`          | 5xx 时 ✓ | 其它 HTTP 错误 / fetch 失败 / 消息通道中断             | 重试或提示检查网络                                         |
| `REQUEST_TIMEOUT`        | ✓        | 超过 `profile.timeoutMs`                               | 重试                                                       |
| `INVALID_MODEL_OUTPUT`   | ✗        | 非法 JSON(截断抢救也救不回)、或修复后仍不合格          | 标红该句 + 重试按钮                                        |
| `MALFORMED_MESSAGE`      | ✗        | 消息不合协议(扩展内部消息形状不对/不受支持)            | 静默丢弃;与模型输出无关,不要引向「换模型」                 |
| `UNSUPPORTED_PAGE`       | ✗        | 发送方与目标 tab 不符                                  | —                                                          |
| `UNSAFE_CONTENT_BLOCK`   | ✗        | 无会话时用右键菜单 / 悬停未命中段落                    | 页面内胶囊提示                                             |
| `SENTENCE_TOO_LONG`      | ✗        | 句子超 2000 规范化字符,或超调度器上限                  | 标红该句                                                   |
| `REQUEST_CANCELLED`      | ✗        | 会话停止 / 文档换代 / 显式 abort                       | 静默                                                       |
| `NO_CACHE`               | ✗        | 纯缓存模式下该成分没有缓存详解                         | 面板给中文引导语,**不带错误码前缀**                        |

## 9. 缓存键

```
core 键        = SHA-256(["core", 规范化句文本, CORE_SCHEMA_VERSION, CORE_PROMPT_VERSION, null])
detail 键      = SHA-256(["core", 规范化句文本, CORE_SCHEMA_VERSION, DETAIL_PROMPT_VERSION, [focus.start, focus.end]])
correction 键  = SHA-256(["correction", …同上(用 CORE_PROMPT_VERSION)…, pageUrl, sentenceInstanceId, feedback])
```

规范化 = `text.trim().replace(/\s+/gu, " ")`。

- **detail 与 core 共用同一个工厂**,只多一个 focus 维度——所以**预载路径与点击路径天然同键**。
- 提示词版本进键,且 core / detail **各传自己那条**:两条提示词各自演进,改 core 规则不该作废已有详解。少了这一维,改提示词等于把旧粒度的成分永久钉在缓存里,新旧质量混着显示。
- correction 绑定页面实例与反馈文本,跨人不可命中,因此**不参与导入导出**。

## 10. 存储清单

### `chrome.storage.local`(SW 启动时设为 `TRUSTED_CONTEXTS`,content script 读不到)

| 键                   | 内容                                               |
| -------------------- | -------------------------------------------------- |
| `profiles.v1`        | `ModelProfile[]`                                   |
| `activeProfileId.v1` | 当前启用的 profile id                              |
| `cacheLimitMb.v1`    | 缓存上限,只接受 10/50/100/200,默认 50              |
| `prefetchDetail.v1`  | 预载详解开关,默认关(非 `true` 一律按 false)        |
| `streamRendering.v1` | 流式渲染开关,**默认开**(只有显式存过 `false` 才关) |

### `chrome.storage.session`(标签页关闭即清)

| 键              | 内容                                                       |
| --------------- | ---------------------------------------------------------- |
| `activeTabs.v1` | `[tabId, {documentId, status}][]`,用来熬过 SW 的 30 秒回收 |

### IndexedDB `english-syntax-learning-v1`(version 2)

三个 object store:`core` / `detail` / `correction`,`keyPath: "key"`,各带 `lastAccessedAt` 索引。

记录形状:`{ key, profileId, value, createdAt, lastAccessedAt, estimatedBytes }`。
每次 `get` 会顺手刷新 `lastAccessedAt`;每次 `put` 后执行一次全库 LRU 淘汰到 `limitBytes` 以内。

### `ModelProfile`(`background/config-repository.ts`)

```ts
{
  id, name, baseUrl, apiKey, model,
  headers: Record<string, string>,     // 禁用 authorization/host/content-length/origin/x-syntax-request-id
  timeoutMs,                            // 5_000 ~ 120_000
  jsonSchemaSupport: "unknown" | "supported" | "unsupported",
  streamSupport?: "unsupported",        // 只持久化否定态
  reasoningControl?: "unsupported",     // 只持久化否定态
  disableReasoning?: true,              // 已废弃,仅为兼容旧 profile 保留,不再影响请求
}
```

`PublicModelProfile` = 去掉 `apiKey` 与 `headers`,给 popup / options 列表用。

## IntelliJ 预览桥协议(JCEF)

Chrome 端协议(SW↔content)之外,IntelliJ 端定义 JCEF 页面↔Kotlin 的独立协议,两侧镜像实现(`BridgeProtocol.kt` / `web/bridge.ts`):

- **JS→Kotlin**:`PREVIEW_READY`、`VISIBLE_BLOCKS`(≤2000 块,每块 ≤20,000 字符)、`DETAIL_REQUEST`(focus 非负闭区间)、`RETRY_SENTENCE`、`PREVIEW_RENDERED`(官方预览整体重渲染,带 previewId/generation,四键白名单)、`PARSE_BLOCK`(显式手势按段解析)。
- **`PARSE_BLOCK`**:六键白名单 `version` / `type` / `previewId` / `generation` / `blockId` / `text`,`blockId` 非空、`text` 长度受 `MAX_BLOCK_TEXT`(20,000)限制。由 `PreviewSessionConnector` 的 `when` 派发到 `PreviewSession.parseExplicitBlock(blockId, text)`。**与 `VISIBLE_BLOCKS` 刻意分开**:后者是自动扫描的批量上报(进 120ms 合批窗口、`PAUSED` 时进 `pausedBlocks` 等 resume);前者是用户手势——单块直派不合批、`offscreen = false` 拿 `ACTIVE_VISIBLE_CORE` 最高可见优先级、`allowPaused = true` 穿透暂停、会话 `STOPPED` 时置 `RUNNING` 轻量启动(不触发全文扫描)。两者共用 `registerFresh`,已出结果的句子照旧被过滤掉,所以对同一段连按快捷键不会重复请求。`bypassCache` 不置位:按段解析要的是"翻这一段",不是"重新翻这一段"。
- **Kotlin→JS**:`SESSION_STATE`、`CORE_STREAM`、`CORE_RESULT`、`CORE_ERROR`、`DETAIL_STREAM`、`DETAIL_RESULT`、`RESTORE_ALL`。`CORE_STREAM`/`CORE_RESULT` 必带 `blockId` 与精简 `tokensJson`；JS 侧靠 `blockId` **惰性注册句子**，靠 Token 的 `text` / `leadingWhitespace` / `punctuation` 恢复模型未覆盖的破折号、逗号和句末标点。`CORE_ERROR` 只需 `blockId`；`DETAIL_*` 不带 blockId(句子在详解前必已注册)。
- 公共字段:`version=1`、`previewId`、`generation`;句子消息再加 `sentenceId`。
- **键白名单**:每类型一组允许键,多余键整体拒绝;`apiKey`/`headers`/`baseUrl` 永远禁止。JS 侧对 Kotlin 回调复检 generation,旧代次丢弃。
- **新增一条页面消息要同步五处,缺一不可**:① `bridge/BridgeProtocol.kt` 的 `PageMessage` 成员;② 同文件 `parsePageMessage` 的分支(键白名单);③ `session/PreviewSessionConnector` 里 `when (message)` 的分支;④ `BridgeProtocolTest`;⑤ **`resources/web/bridge.ts` 的联合类型 + `PAGE_KEYS_BY_TYPE` + `parsePageMessage` 分支(含 `bridge.test.ts`)**。第⑤处运行时并不生效——`bootstrap-entry.ts` 直接构造消息 `postToHost`,不经它校验——所以漏了**不会有任何测试变红**,Kotlin 侧全绿、功能也正常,代价是两侧白名单就此分叉、后来人照抄的是残缺样板。`PARSE_BLOCK` 就是这么漏掉的,实现到一半才发现(见 [invariants.md](./invariants.md))。
- **Kotlin → JS 的全局入口**(不走消息信封,由 `executeJavaScript` 直接调,参数一律 JSON 序列化,绝不拼接模型文本):

| 全局入口                                                     | 何时调                        | 说明                                                                                                                                                 |
| ------------------------------------------------------------ | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `__englishSyntaxInitialize(previewId, generation, autoScan)` | 注入末尾 / requestScan / 换代 | 第三参数决定 `rescan()` 要不要上报 `VISIBLE_BLOCKS`(手动模式只注册不上报);JS 侧默认 `true` 只为兼容既有调用方,Kotlin 侧总是显式下发 `panel.autoScan` |
| `__englishSyntaxReload(offset)`                              | 重新载入                      | 停可见性观察 + 重扫,再恢复滚动位置                                                                                                                   |
| `__englishSyntaxScrollTo(offset, smooth)`                    | 滚动同步                      | 官方预览滚动联动                                                                                                                                     |
| `__englishSyntaxMessage(json)`                               | 每条 Kotlin→JS 消息           | 唯一的 host 消息入口,内部走 `parseHostMessage`                                                                                                       |
| `__englishSyntaxSetTheme(isDark)`                            | 注入时与主题变化              | 供 `roles.ts` 选色板                                                                                                                                 |
| `__englishSyntaxParseHoveredBlock(target?)`                  | 快捷键按段解析                | 省略 `target` 时查 `:is(:hover)` 取最深元素(Kotlin 就是这么调的;裸 `:hover` 在 quirks 页面恒为空集);定位成功即回传 `PARSE_BLOCK`                     |
| `__englishSyntaxSetHotkey(descriptor)`                       | 注入时(读 keymap 之后)        | 下发页面兼底 keydown 的键位判据;**传 `null` 表示关掉兼底监听**(keymap 里没有可下发的单段字母数字绑定)                                                |
