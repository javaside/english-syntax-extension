# 无谓语片段成分支持设计

## 目标

让 Chrome 与 IntelliJ 双端在分析技术文档的标题、功能列表项和其他无谓语片段时，不再虚构主语、谓语、宾语或状语，而是稳定地展示“片段主体 + 修饰成分”的英文句法结构。

中文翻译仅保留为每个英文成分下方的辅助释义，不新增整句翻译字段，也不允许中文语序反过来决定英文成分边界。

## 问题

当前 core prompt 默认输入都能按简单句、并列句或复合句分析，角色枚举也只有句子级角色。遇到以下真实功能列表项时：

> Portable API support across AI providers for Chat, text-to-image, and Embedding models.

模型没有角色表达“整个无谓语名词片段的主体”，只能把 `Portable API support` 或 `support` 近似标成 `SUBJECT`，并在不同调用中把两个后置介词短语随机标成 `ADVERBIAL`、`OBJECT` 或 `ATTRIBUTE`。现有 validator 只校验角色、区间与若干高把握句法错误，这些输出都能通过并进入缓存。

该输入的结构应为：

- `Portable API support`：片段主体；
- `across AI providers`：修饰 `support` 的后置定语；
- `for Chat, text-to-image, and Embedding models`：修饰 `support` 的后置定语。

## 设计原则

1. 英文句法边界优先；中文只作局部辅助释义。
2. core 层继续采用平铺、短语级、互不重叠的成分序列，不引入嵌套语法树。
3. 普通限定词与紧密结合的单词级前置修饰语留在主体短语内，不机械拆成 `ATTRIBUTE`。
4. 只把本地确定可判的约束加入双端 validator；不在没有词性标注器的前提下用词表猜测所有限定谓语。
5. TS/Kotlin 的角色、提示词、validator 错误文案、版本与共享 fixture 必须同步。

## 领域模型

在 `GrammarRole` 中新增：

```text
FRAGMENT_HEAD = "片段主体"
```

定义：标题、列表项或其他不构成分句的输入中，承载核心语义的主要短语。

`FRAGMENT_HEAD` 只用于无完整分句结构的输入。祈使句虽然省略主语，但以原形动词构成谓语，仍按 `PREDICATE` 等现有句子角色分析。

不复用 `INDEPENDENT_ELEMENT`：它表示插入语、话语标记等游离于主干之外的成分，而 `FRAGMENT_HEAD` 恰好是片段的结构中心。

## 模型分析规则

core 与 core repair 共用的规则列表在现有 clause 规则之前增加 completeness-first 规则：

1. 先判断输入是否构成分句；
2. 有显式限定谓语，或是省略主语的祈使句：继续使用现有句子角色；
3. 标题、列表项、名词短语、形容词短语或非限定动词短语若不构成分句：输出恰好一个 `FRAGMENT_HEAD`；
4. 不得为了套用句子角色而虚构 `SUBJECT`、`PREDICATE`、`OBJECT`、`PREDICATIVE` 或 `ADVERBIAL`；
5. 紧密前置修饰语与中心词保留在 `FRAGMENT_HEAD` 中；可独立的后置介词短语、分词短语和不定式修饰语按其真实功能标 `ATTRIBUTE`；
6. 片段内的并列名词、形容词或非限定动词仍遵循现有“短语内部并列不拆 `CONJUNCTION`”口径。

提示词必须包含以下规范示例：

```text
Portable API support                  FRAGMENT_HEAD
across AI providers                   ATTRIBUTE
for Chat, text-to-image, and
Embedding models                      ATTRIBUTE
```

并包含祈使句反例：

```text
Install the CLI.                      PREDICATE + OBJECT
```

## 本地校验

双端 validator 新增逐字一致的高把握约束：

1. 一次分析最多出现一个 `FRAGMENT_HEAD`；出现两个或更多时拒绝。
2. 出现 `FRAGMENT_HEAD` 时，不得同时出现以下分句级角色：
   - `SUBJECT`
   - `PREDICATE`
   - `OBJECT`
   - `PREDICATIVE`
   - `COMPLEMENT`
   - `SUBJECT_CLAUSE`
   - `OBJECT_CLAUSE`
   - `PREDICATIVE_CLAUSE`
   - `ATTRIBUTIVE_CLAUSE`
   - `ADVERBIAL_CLAUSE`
   - 已废弃但仍在协议枚举中的 `COORDINATE_CLAUSE`
3. `FRAGMENT_HEAD` 可与 `ATTRIBUTE`、`APPOSITIVE`、`INDEPENDENT_ELEMENT` 及必要的 `CONJUNCTION` 共存。
4. validator 不尝试仅凭单词白名单判定任意文本是否缺少限定谓语；“模型漏用 `FRAGMENT_HEAD`”主要由 prompt、黄金集与真实模型评测约束，避免误伤词形兼类和祈使句。

错误文案必须进入 repair prompt，并在 TS/Kotlin 中逐字一致：

```text
a non-clausal fragment must contain at most one FRAGMENT_HEAD
FRAGMENT_HEAD marks a non-clausal fragment and must not be mixed with clause-level SUBJECT, PREDICATE, OBJECT, PREDICATIVE, COMPLEMENT, or clause roles
```

## 翻译口径

不改变 `CoreAnalysis` 和 `CoreComponent` 的数据形状，不增加整句翻译。

每个 `translation` 继续严格对应自己的英文 Token 区间，只提供简短局部释义。本例可显示为：

- `Portable API support` → `可移植 API 支持`
- `across AI providers` → `跨 AI 提供商`
- `for Chat, text-to-image, and Embedding models` → `面向聊天、文生图和嵌入模型`

相邻局部释义不承诺按英文顺序拼成自然中文句子。翻译质量不得影响角色选择和成分边界。

## 缓存与版本

`CORE_PROMPT_VERSION` 从 `10` 升至 `11`，使旧 core 缓存失效并按新口径重算。`DETAIL_PROMPT_VERSION` 不变，因为分词和 detail focus 协议没有变化。

`CORE_SCHEMA_VERSION` 不变。`GrammarRole` 的枚举增加成员，但 core JSON 形状没有变化；共享契约与双端 schema 枚举同步更新。

## 黄金集与测试

黄金集新增并人工复核至少以下类别：

1. 本次真实名词片段：`Portable API support ...`；
2. `Support for synchronous and streaming APIs.` 一类名词片段；
3. `Compatible with all major model providers.` 一类形容词片段；
4. `Building production-ready AI applications at scale.` 一类非限定动词标题；
5. `Install the CLI.` 祈使句反例，必须继续以 `PREDICATE` 开头而不是 `FRAGMENT_HEAD`。

机器测试覆盖：

- 新角色及中文标签进入 TS/Kotlin 枚举和共享 contracts；
- core prompt 与 repair prompt 包含完整性优先规则、本例与祈使句反例；
- TS/Kotlin prompt parity 字节一致；
- 重复 `FRAGMENT_HEAD` 被拒；
- `FRAGMENT_HEAD` 与任一分句级角色混用被拒；
- 合法的 `FRAGMENT_HEAD + ATTRIBUTE + ATTRIBUTE` 通过；
- 整份黄金集继续通过生产 validator；
- 评分器 fixture 能精确比较 `FRAGMENT_HEAD`；
- Chrome 与 IntelliJ 渲染显示“片段主体”。

## 文档同步

- `docs/architecture/protocol.md`：角色枚举与版本；
- `docs/architecture/model-pipeline.md`：完整性优先规则、片段口径、缓存失效；
- `docs/architecture/rendering.md`：新标签的展示语义；
- `docs/architecture/invariants.md`：不得把无谓语片段虚构成主谓宾，以及对应守护测试；
- `AGENTS.md`：把新口径加入“一个 role 的判定标准只能有一处定义”和双端 validator 硬门摘要。

## 验收标准

1. 本例的黄金标注固定为 `FRAGMENT_HEAD + ATTRIBUTE + ATTRIBUTE`。
2. prompt 明确区分分句、祈使句和无谓语片段。
3. 双端 validator 对合法与非法 fragment 结果完全一致。
4. 不新增句级翻译能力，局部翻译不参与句法划分。
5. Chrome 全部门禁、IntelliJ Web/Kotlin 门禁、共享契约测试全部通过；lint 保持恰好一个既有错误且不新增错误。
