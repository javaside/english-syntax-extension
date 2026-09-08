# Spring AI 英文技术文档句法审阅与改进方案

- **日期**：2026-09-08
- **语料**：Spring AI Reference 2.0.1
- **审阅方式**：对 10 个章节串行执行 10 轮独立 subagent 审阅；主审再对照当前代码、共享 fixture 与来源页复核裁决。每轮抽取英文正文，给出局部中文辅助译文，并按本项目角色体系复核顶层句子成分。
- **证据边界**：本报告是语料与规则审计，不是插件或某个生产模型的准确率实测。只有在 2026-09-08 对当前标示为 2.0.1 的参考页再次核验，并记录具体来源页的逐字原文，才作为例句证据；subagent 的改写、概括和无法复核的句子不进入实施样本。实施时还须保存版本化源码 permalink 或带上下文的证据快照，防止官网默认版本漂移。
- **目标排序**：句法边界正确 > 双端口径一致 > validator 不误杀 > 中文辅助译文自然。

## 0. 执行摘要

Spring AI 文档中的系表、被动、祈使、完整从句、名词内部并列等结构，原则上已经能由当前 prompt 与十五条 validator 硬门覆盖。十轮审阅真正暴露的是五个剩余问题：

1. **非句片段中的有限定语从句与当前硬门冲突**：`FRAGMENT_HEAD + ATTRIBUTIVE_CLAUSE` 是语言学上自然、产品上有用的划分，但当前 validator 禁止 `FRAGMENT_HEAD` 与任何从句角色混用。
2. **共享主语的谓语并列已有正确口径，但 prompt 的例子不够显式**：当前权威口径本来就是“整个动词短语之间的 FANBOYS 单列 `CONJUNCTION`”；十轮中多位审阅者仍反复把连词吞入 `PREDICATE` 或误以为只有并列分句才能单列，说明抽象规则不足。
3. **有限从句与非限定短语的分界缺少最小对照**：`when methods are called` 应为 `ADVERBIAL_CLAUSE`，`when performing tool calling` 应为 `ADVERBIAL`。
4. **介词短语依附容易被线性邻接误导**：动词选择的目标、来源、方向 PP 不能仅因紧跟名词就标 `ATTRIBUTE`。
5. **宾语控制、零关系词定语从句和跨块列表上下文缺少专门口径**：前两者可通过 prompt 与黄金集补齐；跨块上下文属于当前逐块分析架构的能力边界，不应靠词表硬门伪解决。

建议分成一个 validator groundwork 批次和一个用户可见行为批次：先让 `FRAGMENT_HEAD + ATTRIBUTIVE_CLAUSE` 成为合法结构，再用 prompt 与黄金集教模型稳定生成它。批次 A 不能独立发布或宣称准确性改善；A、B 必须合并进入同一行为版本。除片段混用门外，本报告不建议新增 validator 词表或句法猜测门。

## 1. 审阅范围与方法

### 1.1 十个章节

1. Introduction / AI Concepts
2. Getting Started
3. Chat Client API
4. Structured Output
5. Prompts
6. Tool Calling
7. Retrieval Augmented Generation
8. MCP Overview
9. Building Effective Agents
10. Observability

### 1.2 评审口径

每条候选句按以下顺序判断：

1. 先判断整个输入是否成句；祈使句算完整分句。
2. 再判断主句、并列分句与五类从句的层级。
3. 有限从句从引导词（或零引导位置后的显式主语）覆盖到从句自己的谓语、宾语、补语和状语末端。
4. 顶层 spans 必须有序、不重叠；父名词短语在先行词处结束，不能包围一个已经单列的定语从句。
5. 系表结构中 `PREDICATE` 只含系动词；被动、完成、进行时的助动词仍属于完整动词组。
6. 介词短语先判依附对象，再映射 `ATTRIBUTE` 或 `ADVERBIAL`，不能用最近名词作唯一判据。
7. 中文 translation 只翻译对应 span，不反向决定英文边界。

### 1.3 证据清洗

十轮输出不是等权事实来源。主审对照当前代码、共享 fixture 和网页原文后执行以下纠正：

- **保留当前权威口径**：`CONJUNCTION` 不只连接两个各有主语的分句，也可连接共享主语的整个动词短语。`shared-fixtures/core-gold-annotations.json` 的 conventions 与 `CLAUSE_FIRST_RULE` 已明确这一点。
- **剔除错误建议**：不能把宾语、主语、形容词或副词短语内部的 `and/or` 单列 `CONJUNCTION`。
- **纠正角色错误**：`If/when + 显式主语 + 限定谓语` 是从句角色，不是普通 `ADVERBIAL`。
- **剔除未核原文**：Effective Agents 审阅中的 `Complex tasks where subtasks can’t be predicted upfront` 与 `Iterative refinement provides measurable value` 未在当前页面复核到，不作实施证据。
- **保留能力边界**：subagent 对列表项的不同解释提示了跨块上下文问题，但不能据此断言某个孤立块的唯一语言学分析。
- **逐字证据保留完整上下文**：删除原句中间成分、截断逗号后的从句或把表格说明改写成完整句时，必须显式标为“节选/改写”，不能继续称为逐字原文。

## 2. 已核验的代表性结构

以下不是完整黄金标注，只展示本报告要解决的边界。

### 2.1 非句片段中的有限定语从句

来源：Observability 页面中模型参数的说明文本（2026-09-08 核验）。

> List of sequences that the model will use to stop generating further tokens.

语言学上最有教学价值的划分：

- `FRAGMENT_HEAD`：`List of sequences`
- `ATTRIBUTIVE_CLAUSE`：`that the model will use to stop generating further tokens`

当前结果：第二个角色会触发 `FRAGMENT_HEAD` 混用门。整体标一个 `FRAGMENT_HEAD` 又会隐藏从句边界，且长片段可能超过 10 实词的整体豁免上限。

### 2.2 共享主语的整个动词短语并列

来源：Observability（2026-09-08 当前 2.0.1 浮动参考页核验；实施前仍须固定版本证据）。

> They measure the time spent performing the invocation and propagate the related tracing information.

当前权威口径：

- `SUBJECT`：`They`
- `PREDICATE`：`measure`
- `OBJECT`：`the time`
- `ATTRIBUTE`：`spent performing the invocation`
- `CONJUNCTION`：`and`
- `PREDICATE`：`propagate`
- `OBJECT`：`the related tracing information`

`and` 前后是共享主语的两个完整 VP，故单列 `CONJUNCTION`。这不会触发“相邻 `PREDICATE` 合并”门，因为两个谓语之间有宾语、定语和连词，不是 Token 区间直接相邻。

对照（原文节选；完整句后接 `as they can be potentially sensitive`）：

> The input arguments and result from the tool call are not exported by default ...

`The input arguments and result` 是一个并列主语 NP，内部 `and` 留在 `SUBJECT`，不能单列。完整原文中的 `as they can be potentially sensitive` 另为完整 `ADVERBIAL_CLAUSE`。

### 2.3 有限从句与非限定短语

来源：Chat Client API（2026-09-08 当前 2.0.1 浮动参考页核验；实施前仍须固定版本证据）。

> The actual AI model invocation occurs when methods such as `content()`, `chatResponse()`, and `responseEntity()` are called.

`when ... are called` 有显式主语和限定被动谓语，应整体标 `ADVERBIAL_CLAUSE`。

> The `ChatClient` is created using a `ChatClient.Builder` object.

`using ...` 没有显式主语和限定谓语，是方式分词短语，应标 `ADVERBIAL`。

> The spring.ai.tool observations are recorded when performing tool calling in the context of a chat model interaction.

`when performing ...` 同样是非限定结构，应标 `ADVERBIAL`，不能因首词是 `when` 就机械升级为从句。

### 2.4 动词管辖 PP 与名词后置 PP

来源：前两句来自 Getting Started，第三句来自 Observability（均于 2026-09-08 当前 2.0.1 浮动参考页核验；实施前仍须固定版本证据）。

动词管辖：

> This configuration allows Maven to access Spring snapshot repositories directly while still using your mirror for other dependencies.

`allows + Maven + to access ...` 应映射为 `PREDICATE + OBJECT + COMPLEMENT`；`while still using ...` 是非限定 `ADVERBIAL`。

> When using Maven with Spring AI snapshots, pay attention to your Maven mirror configuration.

按当前角色与粒度口径，主句切为 `PREDICATE pay` + `OBJECT attention` + `ATTRIBUTE to your Maven mirror configuration`：`to ...` 紧跟并补足名词 `attention`。固定搭配本身不足以在本报告中预设一条尚未写入 prompt、conventions 和黄金集的 `OBLIQUE` 式映射。

嵌套 PP：

> Spring AI builds upon the observability features in the Spring ecosystem to provide insights into AI-related operations.

按当前顶层、非重叠口径，`PREDICATE` 为 `builds`；`upon the observability features in the Spring ecosystem` 整体为 `ADVERBIAL`，其中 `in the Spring ecosystem` 已嵌在外层 PP 内，不再拆成顶层 `ATTRIBUTE`；`to provide insights into AI-related operations` 整体为目的 `ADVERBIAL`。`upon` 不能独立成分，也不能塞入只覆盖动词组的 `PREDICATE`。独立 NP 后的 `the features` + `in the Spring ecosystem` 才适合作为 `OBJECT + ATTRIBUTE` 对照。

### 2.5 父成分与有限关系从句不重叠

来源：Structured Output（2026-09-08 当前 2.0.1 浮动参考页核验；实施前仍须固定版本证据）。

> All `.entity(...)` (and `.responseEntity(...)`) overloads accept an optional `Consumer<EntityParamSpec>` that enables two independent, composable behaviors.

推荐顶层：

- `SUBJECT`：`All ... overloads`
- `PREDICATE`：`accept`
- `OBJECT`：`an optional Consumer<EntityParamSpec>`
- `ATTRIBUTIVE_CLAUSE`：`that enables two independent, composable behaviors`

父 `OBJECT` 在先行词结束处截断；不能一边让 `OBJECT` 覆盖完整 NP，一边再用重叠 span 单列从句。

### 2.6 零关系词定语从句

来源：Structured Output（2026-09-08 当前 2.0.1 浮动参考页核验；实施前仍须固定版本证据）。

> Structured output bridges that gap: the model is steered to produce text conforming to a schema, and the application parses it back into a typed object the rest of the codebase can treat like any other domain type.

`the rest of the codebase can treat like any other domain type` 是修饰 `a typed object` 的零关系词定语从句。当前 prompt 只用省略 `that` 的宾语从句作例子，没有明确展示零关系词定语从句，模型可能把其中谓语和补足语平铺到外层。

## 3. 问题清单与裁决

### P0-1：片段中的有限定语从句被硬门误杀

**现象**：技术标题、定义和列表项常由“名词主体 + that/which/where 有限定语从句”组成。当前 `FRAGMENT_CLAUSE_ROLES` 包含全部五类从句角色，使语言学上自然的 `FRAGMENT_HEAD + ATTRIBUTIVE_CLAUSE` 必然失败。

**裁决**：本批仅从 `FRAGMENT_CLAUSE_ROLES` 中移出 `ATTRIBUTIVE_CLAUSE`。其余 `SUBJECT_CLAUSE`、`OBJECT_CLAUSE`、`PREDICATIVE_CLAUSE`、`ADVERBIAL_CLAUSE` 本批继续与 `FRAGMENT_HEAD` 互斥。

这是一项由已核验“名词片段 + 有限定语从句”样例支持的受限工程放行，不声称其他从句角色在语言学上绝不可能依附非句片段。例如活动标题 `Retrying requests when the server is unavailable` 也可能包含有限状语从句；当前报告没有足够的已核原文、角色映射和回归样例来安全扩大例外，后续遇到时应单独裁决。

**理由**：

- 当前样例中的定语从句合法修饰名词片段主体；受限放行能保留学习卡片中的从句边界，而不是把长定义退化成整块片段翻译。
- 其余四类本批维持互斥是保守范围控制，不是语言学上的永久否定。
- 仍要求恰好一个 `FRAGMENT_HEAD`、有序不重叠、从句至少两个实词、从句完整覆盖；不会放宽其他结构门。
- 当前整体片段 10 实词上限只作用于单成分；拆出定语从句后不应再用整体上限拒绝合法多成分片段。

**不采用**：把有限从句降格为普通 `ATTRIBUTE`。这虽能绕过 validator，却让完整句和片段对同一种 `that/which/where` 结构显示不同角色，削弱教学一致性。

### P0-2：共享主语 VP coordination 规则存在解释噪声，不存在 validator 冲突

**现象**：十轮审阅中，多位审阅者把 VP coordination 的 FANBOYS 吞入第二个 `PREDICATE`，或误称只有两个完整分句之间才能单列 `CONJUNCTION`。

**裁决**：保持当前权威口径，不改 validator：

- FANBOYS 连接两个完整动词短语时单列 `CONJUNCTION`，即使两个 VP 共享一个显式或省略主语。
- FANBOYS 位于主语、宾语、表语、定语或状语短语内部时，留在该成分中。
- “相邻 `PREDICATE` 必须合并”只处理没有连接词或其他成分隔开的动词组碎片，例如把 `must close` 拆成两个相邻谓语；它不处理由 `CONJUNCTION` 隔开的 VP coordination。

**改进落点**：prompt 最小对照 + conventions 复核 + 黄金集断言，不新增硬门。

### P1-1：有限从句与非限定短语缺少成对例子

**裁决**：对本组最小对照，以“是否含限定谓语”为首要判据，以显式主语为常见但非绝对必要的辅助线索：

- `when methods are called` → `ADVERBIAL_CLAUSE`
- `when calling the methods` → `ADVERBIAL`
- `before the client sends the request` → `ADVERBIAL_CLAUSE`
- `before sending the request` → `ADVERBIAL`

这里的 `-ing` 结构按本项目核心层映射为非限定短语 `ADVERBIAL`；不据此宣称所有没有显式主语的结构都不是从句，也不把“显式主语 + 非限定谓语”机械升级为有限从句。祈使句、关系词充当主语和其他省略结构继续按现有专门口径处理。不新增 `if/when/before` 大词表硬门。

### P1-2：PP 规则强调邻接，未明确动词选择优先

**裁决**：扩写 `PREPOSITIONAL_PHRASE_RULE`，明确三步判断：独立名词成分之后、由该名词许可或修饰该名词的 PP 映射为 `ATTRIBUTE`；直接表达动词来源、目标、方向、处所等关系的 PP 映射为 `ADVERBIAL`；已经嵌入另一 PP 的内部 PP 不再单独拆分。线性邻接必须结合当前所在结构，不能脱离父成分机械判断。

推荐对照：

- `the sequence` + `of their execution` → `ATTRIBUTE`
- `pay` + `attention` + `to the configuration` → `PREDICATE + OBJECT + ATTRIBUTE`
- `remove messages` + `from memory` → `ADVERBIAL`
- `redirect requests` + `to the mirror` → `ADVERBIAL`
- `upon the features in the ecosystem` → 一个外层 `ADVERBIAL`，不再拆内部 `in ...`

不新增动词或介词白名单 validator；依附关系需要句法与语义，无法由保守局部词表稳定判定。

### P1-3：宾语控制和使役补足缺少专门示例

**裁决**：在 `PEER_COMPONENT_RULE` 补一组角色映射：

- `allows you to define a Consumer` → `PREDICATE allows` + `OBJECT you` + `COMPLEMENT to define a Consumer`
- `forces the model to provide a value` → `PREDICATE forces` + `OBJECT the model` + `COMPLEMENT to provide a value`
- `lets you provide text` → `PREDICATE lets` + `OBJECT you` + `COMPLEMENT provide text`

注意与 `PREDICATE_SCOPE_RULE` 中的裸不定式动词链区分：`Help turn`、`let go` 的后续动词没有独立显式宾语控制项；`lets you provide` 中 `you` 把谓语与补足语隔开。

### P1-4：零关系词定语从句没有例子

**裁决**：在 complex-sentence rule 增加零关系词定语从句例，明确父 NP 在先行词处结束，从句剩余部分整体标 `ATTRIBUTIVE_CLAUSE`。不要依赖引导词词表识别。

### P2-1：跨块上下文会改变列表项解释

**现象**：孤立的 `Handle client-side notifications and requests declaratively` 看似祈使句；如果上一块是 `enables developers to:`，它又可能是承接前文的非限定列表项。

**裁决**：记录为能力边界，本轮不改协议和分析输入。当前模型只收到分句后的单块文本，不能可靠恢复未提供的跨块句法宿主。

**当前策略**：按块内可见证据执行 completeness-first；不要为了猜测上文而新增硬门。未来若要解决，必须单独设计“只读相邻标题/冒号前导语上下文，但不改变缓存句文本与 Token ID”的协议，而不是偷偷拼接句子。

## 4. 具体实施方法

### 批次 A：validator groundwork——受限放行片段中的定语从句

本批只证明目标结构能够通过双端 validator，不能单独证明生产模型会生成该结构。当前 `COMPLETENESS_FIRST_RULE` 会把“存在显式限定谓语”视为成句线索；名词片段内部的定语从句也含限定谓语，因此用户可见行为必须等批次 B 补 prompt 后再验收。A 与 B 不得拆成两个发布版本。

1. **先补 RED 测试**
   - TS/Kotlin validator：`FRAGMENT_HEAD + ATTRIBUTIVE_CLAUSE` 合法。
   - 从现有 forbidden-role 参数表中仅移除 `ATTRIBUTIVE_CLAUSE`；`SUBJECT_CLAUSE`、`OBJECT_CLAUSE`、`PREDICATIVE_CLAUSE`、`ADVERBIAL_CLAUSE` 和 `COORDINATE_CLAUSE` 全部继续拒绝。
   - 保留“至多一个 `FRAGMENT_HEAD`”与长单成分片段上限测试。
2. **最小修改 validator**
   - 只从双端 `FRAGMENT_CLAUSE_ROLES` / `fragmentClauseRoles` 禁止集合移出 `ATTRIBUTIVE_CLAUSE`，不得从通用 `CLAUSE_ROLES` / `clauseRoles` 移除；从句最小长度、定语从句 follower、从句尾介词豁免继续生效。
   - 这是同一条 fragment 混用门的作用域收窄，不新增或删除判据，十五条硬门总数不变。
   - 必改文件：双端 validator、双端 `AnalysisValidatorTest`、`shared-fixtures/validator-messages.json`。
   - 共享消息 fixture 保留既有 `FRAGMENT_HEAD + PREDICATE` 拒绝 case，新增 `accepted: true` 的目标 case。fragment 混用门的错误文案必须改为明确列举仍禁止的分句级角色，不得继续笼统声称禁止全部 clause roles；TS、Kotlin 与 `validator-messages.json` 的完整 expected message 必须逐字同步。若保留 `FRAGMENT_HEAD marks a non-clausal fragment` 前缀，`coveredMessageSubstrings` 可不变。
3. **补共享黄金句**
   - 候选使用 Observability 页面中经当前网页核验的 `List of sequences that the model will use to stop generating further tokens.`；落地前保存 Spring AI 2.0.1 版本化源码 permalink 或带上下文证据快照。
   - 若现有已核语料中已有 `where` 型名词片段，可作为补充回归句；没有则不阻断本批，且不得用改写句代替来源证据。
   - 写入仓库根 `shared-fixtures/core-gold-annotations.json` 的现有 `fragment-*` 组；不要写入旧的 Chrome fixture 路径，也不要误写进 `core-evaluation-traces.json`。
   - 正式黄金句只保存 `{id,text,components[]}`，component 只含 `{startToken,endToken,role}`。Token ID 由当前生产 `tokenize(text)` 生成后人工核对，不得手算。
4. **补机器口径断言**
   - TS/Kotlin 现有 replay 会各自用生产 tokenizer 重建 Token 并调用生产 validator；新增句必须双端全量通过。
   - TS 另按句 ID 钉住：恰好一个 `FRAGMENT_HEAD`、一个完整 `ATTRIBUTIVE_CLAUSE`、父成分截止于先行词、两者有序不重叠、从句覆盖内部谓语及其宾补/状语。
   - conventions 明确允许修饰名词片段主体的完整 `ATTRIBUTIVE_CLAUSE`，不再只列 PP、分词和不定式修饰语。
5. **同步文档**
   - `AGENTS.md`：修改 FRAGMENT_HEAD 混用门的准确描述。
   - `protocol.md`、`model-pipeline.md`、`invariants.md`、`modules.md`：同步 fragment 混用门的受限例外；在 `protocol.md` 中它对应覆盖率列表第 19 项，即当前第 15 个代码判据。十五条代码判据总数不变。
   - `build-test-release.md`：核对共享黄金集 replay 与 validator-message fixture。
   - `rendering.md`：核对现有卡片能否相邻显示片段主体和定语从句；若无需结构改动，实施记录应明确“已核对”。
   - `CHANGELOG.md` 留到与批次 B 同一用户可见版本记录。

### 批次 B：闭合 prompt、黄金集与用户可见行为

1. **片段内部有限定语从句**
   - 必须在 `COMPLETENESS_FIRST_RULE` 明确：嵌在名词片段内部的限定谓语不使整个输入成为主句。
   - 最小例：`An API that returns JSON responses` → `FRAGMENT_HEAD "An API"` + `ATTRIBUTIVE_CLAUSE "that returns JSON responses"`。
   - 同时保留完整句反例，确保真正的主句仍按 `SUBJECT/PREDICATE/... + ATTRIBUTIVE_CLAUSE` 分析。validator 无法完全判断这一语义退化，主要由 prompt、黄金集和真模型逐句 diff 守护。
2. **VP coordination**
   - 正例：共享主语的两个完整 VP，FANBOYS 单列。
   - 反例：并列主语或并列宾语中的 FANBOYS 留在整体成分。
   - 明写相邻谓语合并门只针对无连接词的动词组碎片。
3. **有限从句 vs 非限定短语**
   - `when methods are called` / `when calling the methods` 成对出现。
4. **动词管辖 PP vs 名词后置 PP**
   - `remove messages from memory` / `the removal of messages` 成对出现，并补“外层 PP 内部不再拆 PP”的反例。
   - 同步收窄 `core-gold-annotations.json` 中“独立名词成分后紧跟 PP 一律为 ATTRIBUTE”的绝对表述：由名词许可或修饰名词的 PP 为 `ATTRIBUTE`；直接表达动词来源、目标、方向、处所等关系的 PP 为 `ADVERBIAL`。两侧各补至少一条人工核验标注和按句 ID 的机器断言。
5. **控制结构与零关系词定语从句**
   - 各补一个最小、无其他歧义的例句。
6. **双端 prompt、版本与缓存同步**
   - 同步修改 `prompts.ts`、`Prompts.kt` 及双端 prompt 测试；`CORE_ANALYSIS_RULES` 同时进入首轮 core 与 repair prompt，两条路径都要断言新口径。
   - 同一提交把 `CORE_PROMPT_VERSION` 12→13，并同步 `versions.ts`、`Domain.kt`、`contracts.json`、`core-prompt-parity.json` 四个契约位置。parity 期望只由一端生产实现生成一次，另一端只消费互验。
   - 本批不改 Token、角色枚举或 JSON 形状，因此 `DETAIL_PROMPT_VERSION` 与 `CORE_SCHEMA_VERSION` 不变。
   - core 版本提升会作废 Chrome/IntelliJ core 缓存及 correction 缓存，detail 缓存不受影响；`CHANGELOG.md` 明确记录升级后会重新请求 core 分析。
   - 同步 `protocol.md`、`model-pipeline.md`、`invariants.md` 中写死的 core 版本与规则；`architecture-docs.test.ts` 不钉 prompt 版本，不能依赖它自动发现遗漏。
7. **假服务器契约**
   - 不改 core/core-repair prompt 首行，`detectKind` 无需修改；仍跑 Playwright 全量证明请求类型识别未破坏。
   - 不顺带改 detail 的 `Focus:`、`Focus range:`、`Requested focus ranges:` 标记。
8. **黄金集与评测边界**
   - 新增例句必须人工核语言学正确性，并为每条新口径补机器断言；双端 replay 全量黄金集。
   - 现有 `.superpowers/acceptance/run-core-gold-evaluation.mjs` 名称虽含 `gold`，实际固定消费 `shared-fixtures/core-evaluation-traces.json` 的 versioned 40 句 corpus，不读取正式 `core-gold-annotations.json`。
   - 现有 runner 支持的 A/B 是：改动前保存 baseline artifact，改动后在完全相同 corpus 快照上生成 candidate；比较器会拒绝不同 corpus。它不在一次调用中同时运行旧、新 prompt。本报告所称生产行为 A/B 均指 `--mode pipeline`；默认 `first-pass` 只用于隔离首轮 prompt 输出质量。
   - 若要求新增 Spring AI 句参与真模型 A/B，必须先在未修改 prompt/validator 行为的基线代码上，用扩展后的同一 versioned corpus 快照生成 baseline，再用完全相同快照生成 candidate；同时维护字符区间、split/category/source/rationale、denominator、tokenizer snapshot、traces、hash 和报告。既有 40 句 artifact 不能和扩展 corpus artifact 交给当前比较器；共同句 ID 子集只能另作补充报告，不替代同 corpus 正式配对。

### 批次 C：仅记录能力边界

本轮不实现跨块上下文。单独记录后续设计前置条件：

- 上下文只帮助判断块的交际/句法功能，不参与 Token span。
- API key、缓存键、generation 和现有 bridge 协议不因上下文泄漏或失配。
- 冒号前导语变化时，当前块缓存必须可失效，否则同一块文本可能在不同宿主下复用错误分析。

## 5. 明确不采用的方案

1. **不把 VP coordination 的 `and` 塞进第二个 `PREDICATE`**：这与现有 conventions 和 prompt 冲突，也会让“谓语只覆盖动词组”的含义变脏。
2. **不把宾语或主语 NP 内部的 `and/or` 单列 `CONJUNCTION`**：该角色只服务完整分句或完整 VP 的协调。
3. **不把完整 `If/when + 主语 + 限定谓语` 降为普通 `ADVERBIAL`**。
4. **不靠最近名词或介词白名单决定所有 PP 依附**。
5. **不把片段中的有限定语从句永久降格为 `ATTRIBUTE`**：推荐受限调整混用门，保留真实从句角色。
6. **不在本批偷偷拼接前一 DOM 块**：这会改变输入、缓存和 Token 对齐，必须另立设计。
7. **不把中文译文自然度当作改变英文 span 的理由**。

## 6. 验收标准

### 6.1 静态口径

- prompt、黄金集 conventions、黄金标注三处对五项新口径无矛盾。
- TS/Kotlin prompt 逐字一致。
- TS/Kotlin validator 行为与错误文案一致。
- 文档不再声称 `FRAGMENT_HEAD` 与所有从句角色绝对互斥；只允许受限的 `ATTRIBUTIVE_CLAUSE` 例外。

### 6.2 自动测试

Chrome：

```bash
cd chrome-plugin
npm test
npm run test:contracts # 定向重复核对共享 fixture；已包含在 npm test 中
npx playwright test
npm run lint           # 预期非零；人工确认恰好是既有一错、零 warning
npm run lint:baseline  # 可执行的基线判定必须通过
npm run format:check
npm run build
npm run docs:drift -- --strict
```

`npm run lint` 因仓库刻意保留的一条错误返回非零，不能放入 `&&` 成功链；它用于查看原始输出，随后由 `lint:baseline` 判定“恰好一错”。`docs:drift` 默认仅提醒，本验收使用 `--strict` 才作为阻断门。项目权威门禁仍以 `AGENTS.md` 为准，本报告不借该实现任务扩大为无关的门禁文档重写。

IntelliJ：

```bash
cd intellij-plugin && npm ci && npm test
cd ..
./gradlew :intellij-plugin:test :intellij-plugin:buildPlugin :intellij-plugin:verifyPluginProjectConfiguration
```

其中 lint 仍须恰好保留既有的 `options.test.ts` 一条错误，不得新增。

### 6.3 准确性验收

- 新增 Spring AI 句全部通过双端 validator。
- 原共享黄金集整份通过，不因新规则产生合法标注误杀。
- 真模型准确性验收使用固定 40 句 evaluation corpus，在 `--mode pipeline` 下按同一配置、同一 corpus 快照执行三次 baseline/candidate 配对；以上线前后的最终整句 exact 与 labeled-span F1 均值为主，并同时检查 split/category 指标、最终失败及逐句 `correctToWrongOrFailure`。单次运行只能作为诊断记录。新增到正式黄金集、但未进入 evaluation corpus 的 Spring AI 句，只能报告双端 validator replay 与人工逐句结果，不得声称已由现有 runner 完成真模型 A/B。
- 重点逐句检查：
  - 片段中的完整定语从句不再退化为整块 `FRAGMENT_HEAD`。
  - VP coordination 的 `CONJUNCTION` 不被吞入谓语。
  - NP 内部 `and/or` 不被上提。
  - 有限 `when/if` 与非限定 `when/before + -ing` 不混用。
  - 动词管辖 PP 不因线性邻接误标 `ATTRIBUTE`。

## 7. 风险与回滚边界

| 风险                                                             | 后果                       | 缓解                                                                        |
| ---------------------------------------------------------------- | -------------------------- | --------------------------------------------------------------------------- |
| 放行 `FRAGMENT_HEAD + ATTRIBUTIVE_CLAUSE` 后模型把完整句误标片段 | 退化分析通过 validator     | 仅放行定语从句；黄金集加入完整句反例；真模型逐句 diff                       |
| prompt 一次加入太多规则                                          | token 增长、模型注意力稀释 | 使用五组最小对照，删除重复解释；记录 prompt 字符/token 增量                 |
| 新黄金句 span 手算错误                                           | 评分器奖励错误             | 生产 tokenizer 生成 Token ID，人工复核并补机器断言                          |
| 把正式黄金集误当真模型 corpus                                    | 新增句从未实际请求模型     | 明确两套 fixture；固定 40 句配对 A/B，新增句另报 replay，扩 corpus 另立任务 |
| 不同句集总分直接比较                                             | 虚假提升或退步             | 固定共同句 ID 比较，新增句只看逐句与分组指标                                |
| PP 规则写成新词表                                                | 误杀兼类词和合法悬垂       | 只改 prompt/黄金集，不新增局部 validator 猜测                               |

提交可按 A、B 保持独立 TDD 边界，但发布与准确性结论必须合并：A 只提供 validator groundwork，B 才改变 prompt 并提升 core 版本。任一批真模型回归时不得用放宽评分器掩盖，应回滚对应改动并保留失败 artifact。

本轮不修改 JCEF web TS、bridge 消息或角色枚举，因此无需运行 `npm run bundle-web`，已提交的 `bundle.js` 不受影响。若实施中实际触碰 `intellij-plugin/src/main/resources/web/*.ts`，`buildPlugin` 不会自动重建 bundle，必须先运行 `npm run bundle-web` 并提交产物。

## 8. 三轮审核记录

本节在每轮 subagent 审核后更新，记录“反馈—采纳/否决—文档修改”，不只保留最终结论。

### 第 1 轮：语言学与现行口径一致性

审核结论：核心方向通过，采纳 4 项修正并部分采纳证据建议。

- **采纳**：`builds upon ... in ...` 中内部 `in` PP 已位于外层 `upon` PP 内，按现行口径不得再拆顶层 `ATTRIBUTE`；改为整个 `upon ...` 标 `ADVERBIAL`。
- **采纳**：`pay attention to ...` 不作为“紧跟名词但仍是 ADVERBIAL”的反例；按当前粒度写成 `PREDICATE pay + OBJECT attention + ATTRIBUTE to ...`。
- **采纳**：只放行 `ATTRIBUTIVE_CLAUSE` 是本批保守范围，不宣称其余四类从句在语言学上永远不能依附片段。
- **采纳**：有限/非限定对照以限定谓语为首要线索，不把“显式主语 + 限定谓语”写成覆盖所有英语结构的充分必要条件。
- **部分采纳**：补强逐字证据的版本与上下文要求，恢复 Structured Output 原句中 `(and .responseEntity(...))`，并把截断句明确标为节选。
- **否决审核中的事实判断**：审核者称 `List of sequences ...` 未在来源页复核到；主审已通过 WebFetch 在 Observability 当前 2.0.1 页面逐字核验。该句保留，但实施前仍须固定版本化 permalink 或证据快照。
- **确认通过**：VP coordination 的 `CONJUNCTION` 口径、相邻谓语门作用域、父 NP 截断、零关系词定语从句、`allow + OBJECT + COMPLEMENT` 以及不新增 PP 词表硬门。

### 第 2 轮：工程可实施性、回归风险与测试闭环

审核结论：方向可实施，采纳 3 项阻断修正和 6 项闭环补强。

- **阻断修正**：批次 A 降为 validator groundwork；仅放宽硬门不能教模型识别“名词片段内部有限定语从句”，批次 B 新增该 prompt 例后才能做用户可见验收，A/B 不拆开发版。
- **阻断修正**：明确正式黄金集与 40 句 production evaluation corpus 是两套 fixture；现有 runner 不会自动评测新增黄金句，只支持固定 corpus 的前后 artifact 配对。
- **阻断修正**：验收同时运行原始 `lint` 查看恰好一错和 `lint:baseline` 作可执行判定，避免把预期非零命令放入成功链；不借本任务扩张修改权威门禁文档。
- **闭环补强**：写死双端 forbidden-role 参数测试、accepted 消息 fixture、通用 `CLAUSE_ROLES` 不得修改，以及十五条门数不变的理由。
- **闭环补强**：写死正式黄金句 schema、放置位置、生产 tokenizer 生成 Token ID、双端 replay 与 TS 句 ID 精确断言。
- **闭环补强**：写死 core 版本四文件、双端 core/repair prompt、缓存作废、schema/detail 版本保持不变、架构文档和 CHANGELOG。
- **闭环补强**：记录 fake server 首行与 detail 中段标记不得改，Playwright 负责回归。
- **闭环补强**：`docs:drift` 使用 `--strict` 才阻断，并扩充人工文档核对清单。
- **闭环补强**：确认本轮不触碰 JCEF web/bridge/角色枚举，无需重建 `bundle.js`；实际越界时才补 `bundle-web`。

### 第 3 轮：矛盾、越界硬门与遗漏终审

审核结论：技术方向通过；采纳 2 项阻断修正、5 项重要补漏和 1 项范围收窄后可定稿。

- **阻断修正**：生产准确性验收改为固定 corpus、`--mode pipeline`、同配置三次 baseline/candidate 配对，检查最终 exact、labeled-span F1、split/category、最终失败与 `correctToWrongOrFailure`；单次只作诊断。
- **阻断修正**：扩展 evaluation corpus 时，必须先在旧行为上为扩展后的同一 corpus 生成 baseline，再生成 candidate；既有 40 句 artifact 不能与扩展 corpus artifact 正式比较。
- **重要补漏**：fragment 混用错误文案从“若修改”改为“必须修改”，避免 repair prompt 继续声称禁止全部从句角色。
- **重要补漏**：架构同步加入 `modules.md`，并明确 `protocol.md` 覆盖率列表第 19 项对应当前第 15 个代码判据。
- **重要补漏**：批次 B 明确同步收窄黄金集 PP convention，并为名词依附、动词依附各补人工标注和机器断言。
- **重要补漏**：文首如实改为 10 轮 subagent 审阅 + 主审复核，不再称作 10 轮人工审阅。
- **重要补漏**：每个代表句绑定具体来源页，同时保留“浮动页已核验、实施前固定版本证据”的限定。
- **范围收窄**：`where` 型片段降为可选补充，没有已核原文时不阻断，也不得用改写句替代。
- **确认闭合**：A/B 发布边界、版本与缓存、fake server、validator 作用域、fixture 分工、lint/docs 命令及 JCEF bundle 边界均通过。未声称已完成插件实测或新增句已进入真模型 runner。

## Sources

- [Spring AI Introduction](https://docs.spring.io/spring-ai/reference/index.html)
- [AI Concepts](https://docs.spring.io/spring-ai/reference/concepts.html)
- [Getting Started](https://docs.spring.io/spring-ai/reference/getting-started.html)
- [Chat Client API](https://docs.spring.io/spring-ai/reference/api/chatclient.html)
- [Structured Output](https://docs.spring.io/spring-ai/reference/api/structured-output.html)
- [Prompts](https://docs.spring.io/spring-ai/reference/api/prompt.html)
- [Tool Calling](https://docs.spring.io/spring-ai/reference/api/tools.html)
- [Retrieval Augmented Generation](https://docs.spring.io/spring-ai/reference/api/retrieval-augmented-generation.html)
- [MCP Overview](https://docs.spring.io/spring-ai/reference/api/mcp/mcp-overview.html)
- [Building Effective Agents](https://docs.spring.io/spring-ai/reference/api/effective-agents.html)
- [Observability](https://docs.spring.io/spring-ai/reference/observability/index.html)
