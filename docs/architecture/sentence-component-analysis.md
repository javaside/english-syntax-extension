# 句子成分如何划分：原理、流程与优化方法

本文说明项目如何把网页或 Markdown 中的英文划分为可学习的句子成分，以及怎样在不破坏既有句型的前提下优化准确率。它面向三类读者：

- 普通使用者可先读第 1、2、5 节，理解卡片为什么这样拆；
- 语言学或算法研究者应重点读第 3、4、6、7 节；
- 开发维护者还应读第 8–13 节，并结合 [`model-pipeline.md`](./model-pipeline.md) 与 [`build-test-release.md`](./build-test-release.md)。

源码与本文冲突时以 `AGENTS.md` 和当前代码为准，并应立即修正文档。

## 1. 一句话原理

本项目既不是传统规则解析器，也不是让大模型自由输出一段解释，而是一条受约束的混合流水线：

> **先用确定性程序固定句子和 Token 坐标，再让模型按有优先级的语言学规则提出划分，用本地可证明的硬约束拒绝明显错误，最多进行两轮定向修复，最后用人工黄金标注衡量真实准确率。**

可写成：

```text
页面文本
  → 确定性分句
  → 确定性分词与 Token ID
  → 缓存查询
  → 模型按规则生成候选成分
  → 结构、覆盖率、语法粒度、译文质量校验
  → 失败句定向修复（最多两轮）
  → 合格结果写入缓存并渲染
  → 用黄金集和页面语料评估优化效果
```

这套设计把问题拆为三个不同层次：

1. **坐标层**决定“原文到底是哪一句、有哪些 Token”；
2. **语言学层**决定“哪些连续 Token 构成什么角色”；
3. **质量控制层**决定“这个候选能否被信任、缓存和展示”。

三层必须分开定位。分句或分词错了，模型不可能靠更好的角色判断补救；模型划分错了，渲染层不应修改语言学结果；validator 通过只代表没有命中已知硬错误，不代表答案必然正确。

## 2. 最终产物是什么

### 2.1 Core 不是依存树，而是同层连续区间

核心解析（core）把一句话划成若干**有序、互不重叠的连续 Token 区间**。每项包含：

```json
{
  "startToken": 0,
  "endToken": 2,
  "role": "SUBJECT",
  "translation": "这位年轻工程师"
}
```

`startToken` 与 `endToken` 都是闭区间端点。例如 `[0, 2]` 覆盖 Token 0、1、2。Core 不输出完整句法树，也不在一个区间里递归嵌套另一项。它选择读者在卡片上最值得并列看到的**短语级同层成分**。

点击某个 core 成分后，detail 才在该 focus 区间内部继续拆结构。因此：

- core 回答“整句的骨架如何分块”；
- detail 回答“某一块内部如何构成”；
- 不应为了展示内部定语而把 core 机械切成单词碎片。

### 2.2 角色集合

协议保留 17 个枚举值：

| 角色                  | 中文     | 核心边界                                           |
| --------------------- | -------- | -------------------------------------------------- |
| `SUBJECT`             | 主语     | 主句或并列分句在当前层的主语名词短语               |
| `PREDICATE`           | 谓语     | 仅动词组，不吞宾语、表语、补语或可分离状语         |
| `OBJECT`              | 宾语     | 动词直接管辖的名词性成分                           |
| `PREDICATIVE`         | 表语     | 系动词后的性质、身份或状态                         |
| `ATTRIBUTE`           | 定语     | 修饰名词或片段主体的可分离短语                     |
| `ADVERBIAL`           | 状语     | 修饰动作、性质或整句的短语级成分                   |
| `COMPLEMENT`          | 补语     | 对宾语或谓语意义作必要补足的成分                   |
| `APPOSITIVE`          | 同位语   | 对前项重命名或补充说明的名词性成分                 |
| `FRAGMENT_HEAD`       | 片段主体 | 非完整分句的中心部分，每个片段至多一个             |
| `SUBJECT_CLAUSE`      | 主语从句 | 整个从句在上层充当主语                             |
| `OBJECT_CLAUSE`       | 宾语从句 | 整个从句在上层充当宾语                             |
| `PREDICATIVE_CLAUSE`  | 表语从句 | 整个从句在上层充当表语                             |
| `ATTRIBUTIVE_CLAUSE`  | 定语从句 | 整个从句修饰前面的名词中心                         |
| `ADVERBIAL_CLAUSE`    | 状语从句 | 整个从句修饰主句                                   |
| `INDEPENDENT_ELEMENT` | 独立成分 | 评注、短标签等不进入主干配价的成分                 |
| `COORDINATE_CLAUSE`   | 并列分句 | **已废弃，仅为协议兼容保留，任何新结果都不得输出** |
| `CONJUNCTION`         | 并列连词 | 独立连接同层谓语或分句的 FANBOYS                   |

### 2.3 覆盖与标点契约

合格结果必须满足：

1. 每个非标点 Token **恰好被覆盖一次**；
2. 成分按 Token ID 递增排列，区间不得重叠；
3. 标点可以附着在相邻成分，也可以不覆盖；
4. 一个成分不能只包含标点；
5. `translation` 翻译该成分覆盖的完整局部范围，不是只译中心词，也不是整句翻译。

黄金标注总体不覆盖标点。`fragment-portable-api` 的末成分覆盖终止标点是保留的历史验收例外，不能推广成通用口径。

## 3. 为什么必须先固定句子和 Token

### 3.1 分句：先产生候选边界，再撤销错误边界

Chrome 与 IntelliJ 不分别使用 `Intl.Segmenter` 和 JVM `BreakIterator`。两个平台的原始边界不同，会造成：

- 同一段文字切成不同句子；
- `sentenceId` 和缓存键不一致；
- 同一个 Token span 在两个运行时指向不同文本；
- 导入 Chrome 缓存后 IntelliJ 无法命中。

生产算法由仓库自己定义：

1. 在句末标点串 `. ! ? … 。 ！ ？` 后寻找候选边界；
2. 收尾引号、括号可以包含在候选句末；
3. 只有后面出现显式 Unicode 空白时才形成中间边界；
4. 块末尾永远是最后一个候选边界；
5. 对候选片段重新判断是否应与下一片段合并。

需要撤销的边界包括：

- `Dr.`、`Prof.`、`Capt.` 等强非终结缩写；
- `J. R. R. Tolkien` 里的链式姓名首字母；
- 只有编号或标点、没有实词的片段；
- `U.S.`、`Ph.D.`、`Inc.`、`Ltd.`、`Co.`、`Corp.`、`etc.` 后接小写词或数字的语境。

后一类缩写也可能合法收句，所以采用上下文判断：

```text
U.S. delegation   → 合并，delegation 以小写字母开头
U.S. She returned → 保留边界，She 像新句开头
```

最后若仍留下无实词尾片，则向前合并。整个块只有无实词内容时不发送给模型。

### 3.2 分词：Token ID 是唯一定位坐标

模型不按字符偏移返回成分，只按 Token ID 返回闭区间。生产 tokenizer 的匹配优先级是：

1. URL；
2. 邮箱；
3. 白名单点号缩写；
4. 带字母前缀的点分标识符；
5. 小数、千分位与语义版本号；
6. 普通单词；
7. 单个非空白字符。

优先级不可随意交换。例如：

- `https://example.com/a` 应是一个 Token，而不是十几个符号与单词；
- `Ph.D.` 应是一个 Token；
- `GWTC-5.0`、`II.2.1`、`spring.ai.tool` 应整体化；
- `1.2.3` 应作为数字/版本整体；
- 普通 `stop.` 仍应拆为 `stop` 与 `.`。

每个 Token 同时保存字符起止位置、前导空白和 `punctuation`。`leadingWhitespace + text` 可以无损重建已经 trim 的生产句文本。

### 3.3 Tokenization 变化为什么是破坏性变化

Core span 与 detail focus 都依赖 Token ID。若 `GWTC-5.0` 从三个 Token 改为一个 Token，旧缓存中的 `[3, 8]` 已不再指向原来的短语。因此任何 tokenizer 变化都必须：

- TS 与 Kotlin 同步实现；
- 更新共享 `segmenter-vectors.json`；
- 同时提升 `CORE_PROMPT_VERSION` 与 `DETAIL_PROMPT_VERSION`；
- 用新 tokenizer 重新核对黄金标注区间。

`CORE_SCHEMA_VERSION` 只在 JSON 结构本身变化时提升；单纯坐标或提示词变化不要求提升 schema 版本。

## 4. 模型怎样决定成分：按优先级逐步划分

模型收到句文本以及精简后的 `{id, text, punctuation?}` Token 列表。规则不是互相独立的建议，而是有先后关系的决策过程。先做的判断会改变后续可用角色。

### 4.1 第一步：判断完整分句还是非成句片段

这是最高优先级。

**完整分句**包括：

- 有自己限定谓语的陈述、疑问等分句；
- 省略主语但有祈使谓语的祈使句。

**非成句片段**包括没有自己主句限定谓语的：

- 标题；
- 列表项；
- 名词短语；
- 形容词短语；
- 非限定动词短语。

片段必须使用恰好一个 `FRAGMENT_HEAD`，可分离的后置介词、分词或不定式修饰语标为 `ATTRIBUTE`，不得为了凑主谓宾而虚构 `SUBJECT`、`PREDICATE` 或 `OBJECT`。

正确例：

```text
Portable API support | across AI providers | for Chat, text-to-image, and Embedding models
FRAGMENT_HEAD         | ATTRIBUTE            | ATTRIBUTE
```

祈使句反例：

```text
Install | the CLI
PREDICATE | OBJECT
```

`Install the CLI` 不是片段。没有显式主语不等于不成句。

一个片段内部可以有完整定语从句：

```text
An API | that returns JSON responses
FRAGMENT_HEAD | ATTRIBUTIVE_CLAUSE
```

嵌入定语从句里的限定谓语 `returns` 不会把整个标题变成主句。

### 4.2 第二步：先处理冒号、标签和尾部引用

冒号后的形态必须在分配角色前判定，不能看到冒号就统一标同位语。

#### 情形 A：冒号后是完整分句或问题

整个输入按分句分析；前面的短字段标签可标 `INDEPENDENT_ELEMENT`：

```text
Binary flag: | is | this galaxy | visible | in the catalogue
INDEPENDENT_ELEMENT | PREDICATE | SUBJECT | PREDICATIVE | ADVERBIAL
```

此时不能混入 `FRAGMENT_HEAD`。

#### 情形 B：前缀是章节号或图表标签

编号/标签必须与紧随的标题中心词绑定为一个 `FRAGMENT_HEAD`：

```text
IV.2 Implications | for the future
FRAGMENT_HEAD     | ATTRIBUTE

Figure 2: Comparison
FRAGMENT_HEAD
```

把 `IV.2` 或 `Figure 2:` 单独标为片段主体会制造多个中心。

#### 情形 C：冒号后半对长标题重命名

在冒号处断开；冒号可不覆盖：

```text
Scope | of X | : | Properties | of Y
FRAGMENT_HEAD | ATTRIBUTE | 未覆盖 | APPOSITIVE | ATTRIBUTE
```

若冒号后不是不可拆的重命名成分，而有自己的可分离谓语、宾语或状语，则继续按同层成分拆，不把整段包成 `APPOSITIVE`。

#### 句末书目引用

真实句末引用如 `[61]`、`[5, 6]` 并入前一成分，不单独成分：

```text
in the 1980s [61] → 一个 ADVERBIAL
```

但 `The vector is [1, 2].` 中 `[1, 2]` 是内容，不是书目引用。纯字符串无法高把握区分二者，因此这条由 prompt 与黄金集约束，不设本地硬门。

### 4.3 第三步：确定分句层级

从属连词引导且带自己限定谓语的结构，应整体标为五类从句之一，从引导位置一直覆盖从句自己的主语、谓语、宾语和状语：

```text
Because the road was flooded | the bus | took | a longer route
ADVERBIAL_CLAUSE             | SUBJECT | PREDICATE | OBJECT
```

以下切法都错：

```text
Because | the road | was flooded
ADVERBIAL_CLAUSE | SUBJECT | PREDICATE
```

因为只把引导词标成从句，把从句内部结构错误地平铺到了主句层。

引导词省略时仍可能是完整从句：

```text
a typed object | the rest of the codebase can treat
OBJECT         | ATTRIBUTIVE_CLAUSE
```

有限定谓语与非限定短语的边界必须区分：

```text
when methods are called → ADVERBIAL_CLAUSE
when performing tool calling → ADVERBIAL
```

前者有自己的限定谓语 `are called`；后者是非限定 `performing` 短语。

### 4.4 第四步：并列结构按当前层级处理

只有两个或更多各自带主语的分句，通过 FANBOYS 或分号连接，才是并列句。但即使是并列句，也不再包成 `COORDINATE_CLAUSE`，而是把两边的主语、谓语、宾语平铺到顶层，仅将 FANBOYS 单独标为 `CONJUNCTION`。

共享主语的多个谓语不是多个并列分句：

```text
They | measure | the time | and | propagate | the results
SUBJECT | PREDICATE | OBJECT | CONJUNCTION | PREDICATE | OBJECT
```

并列发生在一个名词、形容词或副词短语内部时，该短语保持一个成分，内部 `and/or` 不单独标：

```text
a Claude subscription or Anthropic Console account → 一个 OBJECT
calmly and confidently → 一个 ADVERBIAL
```

逗号、冒号、破折号、连续祈使动词或共享主语的动词串本身都不能证明存在并列句。

### 4.5 第五步：确定谓语边界

`PREDICATE` 只覆盖动词组：情态动词、助动词、主要动词以及夹在其中的副词。它不吸收可分离的宾语、表语、补语或状语。

```text
The bridge | was rebuilt | by local craftsmen
SUBJECT    | PREDICATE  | ADVERBIAL
```

被动、完成、进行形式中的 `be/have` 留在同一个谓语：

```text
was rebuilt
have been told
is deflating
```

系表结构必须拆开：

```text
Be | clear
PREDICATE | PREDICATIVE

These instructions | seem | clear enough | for beginners
SUBJECT | PREDICATE | PREDICATIVE | ADVERBIAL
```

两个连续且相邻的 `PREDICATE` 一般说明动词组被错误拆开。例如 `must | close` 应合并为一个谓语。

`help/let` 后不带自己独立宾语的裸不定式链可留在谓语：

```text
Help turn → 一个 PREDICATE
let go → 一个 PREDICATE
```

### 4.6 第六步：切宾语、表语与补语

名词短语由动词直接支配时通常是 `OBJECT`；系动词后的性质、身份或状态是 `PREDICATIVE`；对宾语或谓语作必要补足的是 `COMPLEMENT`。

宾语控制结构：

```text
allows | Maven | to access repositories
PREDICATE | OBJECT | COMPLEMENT
```

非限定补足语自己的宾语留在该补足语内部：

```text
is steered | to produce text
PREDICATE | COMPLEMENT
```

宾补：

```text
We | consider | the tool | essential
SUBJECT | PREDICATE | OBJECT | COMPLEMENT
```

不能看到动词形式就标 `PREDICATE`。非限定动词短语可能整体充当主语、宾语、补语、状语或片段主体。

### 4.7 第七步：判断介词短语依附

介词与它管辖的全部内容形成一个整体成分，包括并列宾语：

```text
into fully formed designs and specs → 一个 ADVERBIAL
```

不能把介词单独成分，也不能让短语成分悬在一个必须带宾语的介词上。

`ATTRIBUTE` 与 `ADVERBIAL` 的区别由**依附对象**决定：

- 修饰动作、性质或整句的介词短语是 `ADVERBIAL`；
- 选择或描述前面名词的介词短语是 `ATTRIBUTE`。

```text
works | directly | with git
PREDICATE | ADVERBIAL | ADVERBIAL

an open standard | for connecting AI tools
PREDICATIVE | ATTRIBUTE

the development | of applications
OBJECT | ATTRIBUTE
```

量词或部分结构没有例外：

```text
a lot | of context
No amount | of firewalls or patches
```

当一个介词短语已经嵌在另一个介词短语中时不再拆内部：

```text
without looking at any of the code → 一个 ADVERBIAL
```

固定动词—名词—介词框架仍按名词中心和后置修饰分开：

```text
pay | attention | to the details
PREDICATE | OBJECT | ATTRIBUTE
```

### 4.8 第八步：处理定语、同位语与独立成分

普通限定词和紧密结合的单词级前置修饰语通常留在名词短语中：

```text
The young engineer → 一个 SUBJECT
```

可独立成短语的前置或后置修饰语才在 core 层拆为 `ATTRIBUTE`：

```text
fully formed | designs
ATTRIBUTE | 名词中心所在的同层角色

documents | signed yesterday
名词中心所在的同层角色 | ATTRIBUTE
```

有自己主语和限定谓语的是完整 `ATTRIBUTIVE_CLAUSE`；只有分词或介词短语的是 `ATTRIBUTE`。

逗号夹住、对前项重命名的名词短语是 `APPOSITIVE`：

```text
Claude Code, | an AI coding assistant, | helps
SUBJECT | APPOSITIVE | PREDICATE
```

句首评论性成分可标 `INDEPENDENT_ELEMENT`：

```text
Fortunately, | the deployment | finished
INDEPENDENT_ELEMENT | SUBJECT | PREDICATE
```

## 5. 三个完整例子

### 5.1 普通 SVOA

原句：

```text
The young engineer fixed the broken printer this morning.
```

Token：

```text
0 The
1 young
2 engineer
3 fixed
4 the
5 broken
6 printer
7 this
8 morning
9 . (punctuation)
```

期望 core：

```text
[0,2] SUBJECT    The young engineer      这位年轻工程师
[3,3] PREDICATE  fixed                   修好了
[4,6] OBJECT     the broken printer      那台坏掉的打印机
[7,8] ADVERBIAL  this morning            今天早上
```

句号可不覆盖。`young` 和 `broken` 都是紧密结合的单词级前置修饰，不需要为了展示更多颜色而拆成独立 `ATTRIBUTE`。

### 5.2 片段与完整分句的对照

片段：

```text
An API that returns JSON responses
```

```text
[0,1] FRAGMENT_HEAD       An API
[2,5] ATTRIBUTIVE_CLAUSE  that returns JSON responses
```

整个输入没有主句谓语；`returns` 属于嵌入定语从句。

完整句：

```text
The API that we built passes every test.
```

```text
The API | that we built | passes | every test
SUBJECT | ATTRIBUTIVE_CLAUSE | PREDICATE | OBJECT
```

这里 `passes` 是主句限定谓语，所以整个输入按分句处理，不得使用 `FRAGMENT_HEAD`。

### 5.3 冒号结构的优先级

完整分句型：

```text
Binary flag: is this galaxy visible in the catalogue?
```

先判断冒号后是完整问题，再划分：

```text
Binary flag | is | this galaxy | contained | within the catalogue
INDEPENDENT_ELEMENT | PREDICATE | SUBJECT | PREDICATIVE | ADVERBIAL
```

标题重命名型：

```text
Scope of X: Properties of Y
```

冒号后不是独立分句，而是标题重命名：

```text
Scope | of X | Properties | of Y
FRAGMENT_HEAD | ATTRIBUTE | APPOSITIVE | ATTRIBUTE
```

冒号不覆盖。两例说明“看到冒号就标同位语”或“看到冒号就拆两句”都不可靠，必须先判后半结构。

## 6. 从文本到卡片的真实执行步骤

### 6.1 页面提取与块选择

Chrome 自动模式先由 `document-scanner.ts` 识别正文容器和候选块；显式悬停/选中路径只处理用户指定的叶子渲染块，不套用自动扫描的正文容器与最短长度限制。IntelliJ 从 Markdown JCEF 预览页收集可见块。

这一步的输出是块文本，不是句法结构。脚注、隐藏文本、MathML 替代文本等 DOM 提取错误会污染后续句子，应优先在提取层修复，不能期待 prompt 忽略每一种页面噪声。

### 6.2 分句、分词与句 ID

每个块依次经过：

1. `segmentBlock()` 产生句子文本与块内字符范围；
2. `tokenize()` 产生稳定 Token ID；
3. 规范化句文本；
4. 结合 session、block、顺序和文本生成 `sentenceId`。

TS/Kotlin 由共享向量确保结果一致。

### 6.3 缓存与批处理

Core 缓存键由规范化句文本、`CORE_SCHEMA_VERSION`、`CORE_PROMPT_VERSION` 和空 focus 构成，与模型/profile 无关。读取缓存后仍重新执行 `validateCoreBatch()`，旧缓存若不再符合当前硬门就按 miss 处理。

未命中句按端点切块：

- 云端每请求 2 句，以并发减少输出串行等待；
- loopback 本地端点每请求最多 6 句，以减少本地串行请求次数；
- 任一请求不得超过 `MAX_SENTENCES_PER_REQUEST = 6`。

### 6.4 Prompt 与 Schema 双重约束

`buildCorePrompt()` 发送：

- 角色闭集；
- Token 区间与覆盖规则；
- 本文第 4 节的有序语言学规则；
- 局部中文译文要求；
- 精确 JSON 输出形状；
- 精简后的句子与 Token。

支持 `response_format: json_schema` 的 provider 同时收到 `CORE_SCHEMA`；不支持时自动降级为只靠 prompt 约束形状。Schema 只能限制字段类型和外形，无法证明英语划分正确。

### 6.5 流式暂定成分

流式响应中，每闭合一个 component，parser 就尝试提取并发送。暂定成分只做“是否能安全画出来”的过滤：

- 角色必须在枚举中；
- 区间必须在句内；
- 与已发送成分有序且不重叠；
- 不能只覆盖标点；
- 模型文本必须脱敏。

它没有完整句子的覆盖率信息，因此：

- 只用于提前渲染；
- 不写缓存；
- 不把句子改为 `ready`；
- 完整响应到达后必须被最终校验结果覆盖。

### 6.6 完整校验

`validateCoreBatch()` 依次检查：

1. 顶层和句子信封；
2. 请求句是否缺失、重复或多出；
3. component 字段、角色、区间和安全文本；
4. 过滤纯标点 component，同时保留其余语义 component 在模型原始数组中的下标，作为 repair 错误坐标；
5. 区间是否在句内、有序且不重叠；
6. 在结构可信时执行本地语法粒度硬门；
7. 检查所有 Token 覆盖率；
8. 检查局部中文译文质量。

非结构错误不会提前阻断语法诊断。这样一次 repair 能同时看到字段、语法与译文问题，而不必修完一种才暴露下一种。

### 6.7 最多两轮逐轮收窄修复

首轮某些句子失败后：

1. 已合格句立即保留并写缓存；
2. 只把失败句、这些句的最新非法 JSON 和按 `sentenceId` 分组的错误送入 repair；
3. repair 使用与首轮完全相同的语言学规则；
4. 错误路径指向模型原始 `components[k]`，不会因纯标点项被过滤而偏移；
5. 第一轮修好的句子不进入第二轮；
6. 第二轮仍失败才报告 `INVALID_MODEL_OUTPUT`；
7. 网络、鉴权、超时和取消不属于结构修复，立即按原错误上抛。

这是“定向修复”而不是让模型重新自由分析整批。逐轮收窄减少兄弟句被修坏，也节省输入和输出 token。

## 7. 本地 validator 的能力边界

### 7.1 十六类高置信硬门

当前双端 validator 将以下可由“Token 文本 + 成分序列”高把握判断的约束落为硬门：

1. **相邻谓语**：连续区间的两个 `PREDICATE` 应合成完整动词组；单独助动词给出更精确错误。
2. **单词介词**：高置信必须带宾语的介词不能独立成非连词 component。
3. **废弃并列分句角色**：任何 `COORDINATE_CLAUSE` 都拒绝，要求同层平铺。
4. **并列连词真实性**：`CONJUNCTION` 至少覆盖一个 FANBOYS：`for/and/nor/but/or/yet/so`。
5. **从属连词误作短语**：高置信从属连词开头的 `ADVERBIAL`/`ATTRIBUTE` 应改为从句角色；`because of` 和句尾单词 `though` 有保守豁免。
6. **谓语吞主语**：`PREDICATE` 首个实词是限定词、主格代词或 `that` 时拒绝。
7. **谓语吞名词短语**：谓语非首位出现限定词时，要求在限定词前切出 `OBJECT`、`PREDICATIVE` 或 `COMPLEMENT`。
8. **单成分包整句**：至少 4 个实词的完整句不能只用一个普通成分覆盖。
9. **长片段不拆**：`FRAGMENT_HEAD`、`INDEPENDENT_ELEMENT`、`APPOSITIVE` 单项覆盖整句时，超过 10 个实词要求拆主体和修饰语；10 是经验阈值，不是语法定律。
10. **从属分句误标并列分句**：从属连词开头且整句无 `CONJUNCTION` 时给补充诊断；尽管第 3 条已整体拒绝旧角色，这条保留更具体的修复方向。
11. **单词从句**：五类从句至少含两个实词，不能只标 `that` 或 `developers`。
12. **主语从句首词**：必须命中 15 词闭集；`if`、`however` 刻意不收。
13. **定语从句被截断**：`ATTRIBUTIVE_CLAUSE` 后紧跟 `OBJECT` 或 `PREDICATIVE` 时，要求吸收从句内部后继；`COMPLEMENT` 为宾补结构保留。
14. **名词性成分吞入后置 `of` 短语**：`SUBJECT`、`OBJECT`、`PREDICATIVE`、`COMPLEMENT`、`ATTRIBUTE`、`APPOSITIVE` 的非首位实词出现 `of` 时，要求在 `of` 前截止，并把 `of` 到其宾语单列为 `ATTRIBUTE`；从句、状语和以 `of` 开头的独立定语不检查。
15. **成分尾部悬垂介词**：非从句成分以高置信必带宾语介词结尾时拒绝；完整从句允许 `what dreams are made of` 一类介词悬垂。
16. **片段主体边界**：`FRAGMENT_HEAD` 至多一个，且不得与主语、谓语、宾语、表语、补语及四类非定语从句等分句级角色混用；完整 `ATTRIBUTIVE_CLAUSE` 是唯一允许与片段主体并存的从句角色。

### 7.2 为什么硬门必须保守

硬门的目标不是实现第二套完整英语 parser，而是拦住“几乎肯定错”的候选。误放一个错误候选会影响准确率；误拒一个正确候选不仅影响准确率，还会浪费 repair 请求，并可能把正确答案修坏。因此词表有意保守：

- `after/before/down/off/over/since/until/around/inside/outside` 等可作副词、表语或连词的词，不纳入单词介词硬门；
- `for/with/at/from/to` 可能在关系从句中合法悬垂，不纳入尾介词硬门；
- 不根据“整句没有 SUBJECT”判错，因为祈使句合法无主语；
- 不靠词表硬判“缺限定谓语”，因为英语词形兼类会造成大面积误杀；
- 不把所有 `when/before/after` 都视为从句，必须区分限定与非限定结构。

### 7.3 Validator 通过不等于语言学正确

以下错误可能完全通过结构与十六类硬门：

- 一个边界合法但依附对象错的介词短语；
- `OBJECT` 与 `PREDICATIVE` 角色互换；
- 两个都合法的粒度选择中选了错误一种；
- 完整句误标为短 `FRAGMENT_HEAD`，但未触发长度阈值；
- `for/with/by` 等不属于当前高置信 `of` 门的后置修饰被并入名词短语。

因此不能用“validator 通过率”替代准确率。2026 年 8 月曾有一批自动标注只过结构校验就进入黄金集，后续人工复核发现多处语言学错标；错误黄金答案会反过来奖励线上错误。

### 7.4 译文质量也是最终门

含可译英文字母的 component，其 `translation` 必须：

- 至少含一个 Unicode Han 字符；
- NFKC、大小写和 Unicode 空白归一后不能等于英文原文；
- 覆盖完整局部短语，而不是只译中心词。

专名应保留英文并补中文类型，例如：

```text
JSON 数据格式
Spring AI 框架
GWTC-5.0 引力波事件目录
哈勃常数 H0
```

纯数字、标点和可靠数学表达式没有可译自然语言内容，可不强制 Han。该门不改变语法结构可信度，但会阻止无意义回显写入缓存。

## 8. 如何定位一次错划分

优化前先把失败归到正确层。推荐按以下顺序排查。

### 8.1 原文是否正确

检查模型实际收到的文本，而不是肉眼看到的网页：

- 隐藏导航文字是否混入；
- 脚注正文是否粘到句中；
- MathML 是否读成 TeX 源码；
- 图注 label 是否遗漏；
- DOM 多节点间是否缺空格。

原文错属于提取层。不要用 prompt 教模型猜 DOM 噪声。

### 8.2 分句是否正确

确认一个 `SentenceInput` 是否过长或过短：

- 缩写是否误断；
- 大写新句是否被缩写规则误合并；
- 列表编号是否独立成句；
- 姓名 initial 是否切断；
- 无实词片段是否粘接方向错误。

分句错应补双端 segmenter 与共享向量。

### 8.3 Token 是否正确

打印 `id/text/punctuation`，确认语言学整体是否被拆碎。点分标识符、URL、邮箱、缩写和数字最常见。若 Token 坐标错，先改 tokenizer，再讨论 prompt span。

### 8.4 首轮候选错还是修复后才错

必须同时保存：

- 首轮 raw；
- 首轮 validator errors；
- 每轮 repair prompt 与 raw；
- 最终成功或失败。

可能出现：

- 首轮错误，repair 修好；
- 首轮结构正确但译文失败，repair 把语法修坏；
- 首轮 JSON 无法解析，repair 恢复；
- 第一轮修好一部分，第二轮只处理剩余句；
- 首轮正确但黄金标注或评分归一化错误。

只看最终卡片无法判断该改主 prompt、validator 还是 repair。

### 8.5 是“硬错误”还是“教学空隙”

问两个问题：

1. 能否只凭 Token 文本和候选成分，以很高置信度证明它错？
2. 能否给出真实合法反例，说明这条判据会误杀？

若第一个答案为是且没有重要反例，可考虑 validator 硬门；否则应优先使用 prompt 中的“正确例 + 最接近错误例”教学，并由黄金集评估。

## 9. 安全优化的标准步骤

### 步骤 1：冻结最小复现与证据

记录：

- 页面来源与逐字原文；
- DOM 提取后的块文本；
- 生产分句和 Token 快照；
- 模型/profile/温度/推理控制/response format；
- 首轮、repair、最终结果；
- 人工判断错在哪里。

若来源会变化，应保存 exact excerpt 与哈希，不能只留 URL。

### 步骤 2：人工写出正确答案

先基于生产 Token ID 写出期望 span/role，再写每一项的标注理由。至少回答：

- 整体是否成句；
- 主句限定谓语在哪里；
- 从句边界到哪里；
- 每个 PP 修饰谁；
- 非限定短语在上层充当什么；
- 并列发生在分句、VP、NP 还是短语内部；
- 标点是否覆盖。

不要让当前模型输出反向决定黄金答案。

### 步骤 3：选择最靠前的真实根因层

优先级是：

```text
DOM 提取 → 分句 → 分词 → prompt 决策 → validator → repair → 评分
```

上游错误会制造大量下游症状。应修最早出错层，而不是在每一层加特例。

### 步骤 4：用对偶例子修改 prompt

一条规则最好同时给：

- 正确目标句；
- 与错误输出最接近的反例；
- 决策依据，而不是仅给标签结论。

例如不能只写“when 从句整体标状语从句”，还要对比：

```text
when methods are called     → ADVERBIAL_CLAUSE（有限定谓语）
when performing tool calling → ADVERBIAL（非限定短语）
```

规则顺序同样需要测试。完整性判断必须早于分句层级，分句层级必须早于同层成分切分。

### 步骤 5：只把高置信规则变成硬门

新增硬门时必须：

- 明确机器可观察条件；
- 搜索并记录合法反例；
- 优先缩小词表或角色范围；
- 错误文案写成模型可执行的修复指令；
- 同轮不阻断其它可诊断错误；
- TS/Kotlin 错误文案逐字一致；
- 整份人工黄金集仍通过生产 validator。

### 步骤 6：同步双运行时与版本

按改动类型同步：

| 改动           | 必须同步                                                                                              |
| -------------- | ----------------------------------------------------------------------------------------------------- |
| 分句/分词      | `segmenter.ts`、`Segmenter.kt`、共享向量、core/detail 两个 prompt 版本、全部受影响黄金 span           |
| Core prompt    | `prompts.ts`、`Prompts.kt`、`core-prompt-parity.json`、`CORE_PROMPT_VERSION`                          |
| Core validator | `analysis-validator.ts`、`AnalysisValidator.kt`、共享错误文案/边界 fixture、双端测试                  |
| 角色或输出结构 | TS/Kotlin 领域模型、JSON Schema、协议守卫、渲染、共享 contracts；结构变化还要升 `CORE_SCHEMA_VERSION` |
| Repair 行为    | 双端 AnalysisService、repair prompt、合成生产轨迹 fixture                                             |
| 黄金口径       | `core-gold-annotations.json`、精确机器断言、人工标注理由                                              |
| 页面语料       | 页面 corpus 版本、source evidence、baseline/candidate artifact                                        |

### 步骤 7：先跑离线守护

至少验证：

- segmenter/tokenizer 双端共享向量；
- core prompt 双端逐字一致；
- validator 错误文案双端一致；
- 黄金集全部通过生产 validator；
- 精确句型断言未漂移；
- production trace 能覆盖首轮合法、错到对、三轮失败、多句逐轮收窄；
- 文档链接与架构清单未漂移。

### 步骤 8：做真模型配对评测

准确性改动不能只跑单句，也不能只跑一次。推荐：

1. 固定同一个 corpus、顺序、端点、模型、batch、温度、推理控制、schema 与超时；
2. baseline 与 candidate 分别从冷缓存走真实 `CachedAnalysisService.analyzeCore`，并传入 `bypassCache: true`；
3. 至少运行三对，以观察模型方差；
4. 同时看首轮与生产最终结果；
5. 比较整句 exact、labeled-span F1、role accuracy、最终失败数；
6. 检查逐句 `correct → wrong/failure` 回归，而不是只看均值；
7. 页面挑战集与固定黄金集分别报告，不能因句型分布不同直接比较总分。

### 步骤 9：解释指标，而不是追逐单一数字

- **整句 exact**：整句所有 span 和 role 全对才算对，最严格且最贴近卡片整体质量；
- **span precision/recall/F1**：边界是否正确，不考虑角色；
- **labeled-span F1**：边界和角色同时正确；
- **exact-span role accuracy**：边界已对的成分中角色判断质量；
- **final failure**：生产修复后仍不能展示的句子；
- **逐句转移**：改动实际修好了谁，又伤了谁。

评分前仅归一化预测末尾纯标点差异，避免标点覆盖记账淹没语义变化；真实成分合并或拆分不能被归一化豁免。

## 10. 常见错误优化方式

### 10.1 只改 prompt，不升版本

缓存键带 prompt 版本。不升 `CORE_PROMPT_VERSION` 会让旧结果继续命中，新旧粒度混屏，真机看似“改动没生效”。

### 10.2 只改 Chrome，不改 IntelliJ

两运行时不共享代码。必须用共享 fixture 钉住行为，而不是假设 Kotlin 会自动继承 TS 逻辑。

### 10.3 把所有模型错误都塞进 validator

英语兼类和省略广泛存在。过宽词表会拒绝合法分析、烧掉 repair 配额，并可能降低最终准确率。Validator 应追求高 precision，不追求覆盖所有错法。

### 10.4 用 validator 通过率当准确率

结构合法与语言学正确是两回事。只有人工黄金集和逐句审查能发现静默错标。

### 10.5 为一个失败句写孤立特例

先找它属于哪类可复现结构，并加入正确/反例对偶。孤立词面特例容易只对当前句有效，且污染相邻句型。

### 10.6 只测首轮或只看最终结果

首轮指标衡量 prompt；最终指标还混合 validator 与 repair。两者都要保存，才能判断收益来自哪里以及 repair 是否修坏正确答案。

### 10.7 让修复轮携带整批句子

已正确的兄弟句会被重新解释并可能回归。生产实现只发送仍失败句和对应非法 JSON，第二轮继续收窄。

### 10.8 修改 Token 规则却沿用旧黄金区间

Token ID 已变时，旧 span 数字没有语义。必须用生产 tokenizer 重新导出坐标，并人工确认字符范围和角色不变。

### 10.9 在渲染层纠正语法

渲染只能按 span 还原文本、显示标点和卡片。若它猜测主谓宾或调整边界，缓存、详解 focus 与双端契约会分叉。

## 11. 源码地图

### Chrome

| 关注点                        | 文件                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| 页面正文与候选块提取          | `chrome-plugin/src/content/document-scanner.ts`                                      |
| 会话、分句注册、合批与相位    | `chrome-plugin/src/content/session-controller.ts`                                    |
| 角色、Token、core/detail 类型 | `chrome-plugin/src/shared/grammar.ts`                                                |
| schema/prompt 版本            | `chrome-plugin/src/shared/versions.ts`                                               |
| 分句、分词、重建、句 ID       | `chrome-plugin/src/language/segmenter.ts`                                            |
| 最终 core/detail 校验         | `chrome-plugin/src/language/analysis-validator.ts`                                   |
| 原始 component 下标与语义序列 | `chrome-plugin/src/language/indexed-components.ts`                                   |
| core/detail/repair prompt     | `chrome-plugin/src/background/prompts.ts`                                            |
| 缓存键、IndexedDB 与 LRU      | `chrome-plugin/src/background/analysis-cache.ts`                                     |
| 分块、首轮与 repair loop      | `chrome-plugin/src/background/analysis-service.ts`                                   |
| 请求优先级、并发与重试        | `chrome-plugin/src/background/request-scheduler.ts`                                  |
| JSON Schema、请求与能力降级   | `chrome-plugin/src/background/openai-compatible-adapter.ts` 与 `analysis-service.ts` |
| SW 路由、流式端口与脱敏       | `chrome-plugin/src/background/service-worker.ts`                                     |
| 流式暂定成分                  | `chrome-plugin/src/background/core-stream-parser.ts`、`provisional-components.ts`    |
| 卡片与详解渲染                | `chrome-plugin/src/content/learning-block.ts`                                        |
| 黄金集守护                    | `chrome-plugin/src/language/core-gold-annotations.test.ts`                           |
| 纯评分器                      | `chrome-plugin/scripts/core-evaluation.mjs`                                          |
| 真模型 runner 公共件          | `chrome-plugin/scripts/core-evaluation-runner.mjs`                                   |

### IntelliJ

| 关注点                     | 文件                                                                                           |
| -------------------------- | ---------------------------------------------------------------------------------------------- |
| 预览页块采集与显式解析     | `intellij-plugin/src/main/resources/web/preview.ts`                                            |
| JCEF 消息桥                | `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/session/PreviewSessionConnector.kt` |
| 会话、合批、相位与结果推送 | `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/session/PreviewSession.kt`          |
| 领域模型与版本             | `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/domain/Domain.kt`                   |
| 分句分词                   | `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/language/Segmenter.kt`              |
| 校验                       | `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/language/AnalysisValidator.kt`      |
| Prompt                     | `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/model/Prompts.kt`                   |
| SQLite 缓存与缓存键        | `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/cache/AnalysisCache.kt`             |
| 请求优先级、并发与重试     | `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/scheduler/RequestScheduler.kt`      |
| 模型请求与 repair          | `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/analysis/AnalysisService.kt`        |
| 卡片与详解渲染             | `intellij-plugin/src/main/resources/web/render.ts`                                             |

### 双端共享事实

| 契约                   | 文件                                                       |
| ---------------------- | ---------------------------------------------------------- |
| 版本、角色、常量       | `shared-fixtures/contracts.json`                           |
| 分句分词向量           | `shared-fixtures/segmenter-vectors.json`                   |
| Core prompt 全文一致性 | `shared-fixtures/core-prompt-parity.json`                  |
| Validator 错误文案     | `shared-fixtures/validator-messages.json`                  |
| 黄金标注与 conventions | `shared-fixtures/core-gold-annotations.json`               |
| 翻译质量边界           | `shared-fixtures/translation-quality.json`                 |
| 页面挑战语料           | `shared-fixtures/visible-page-core-evaluation-corpus.json` |
| 生产链路合成轨迹       | `shared-fixtures/core-evaluation-traces.json`              |

## 12. 优化前后的检查清单

### 动手前

- [ ] 已确认模型收到的原文无 DOM 污染；
- [ ] 已核对生产分句和 Token；
- [ ] 已保存首轮、每轮 repair 和最终结果；
- [ ] 已人工写出 token span、role 与理由；
- [ ] 已找到至少一个正确目标例和一个最近错误例；
- [ ] 已判断根因属于提取、分句、分词、prompt、validator、repair 还是评分。

### 实现时

- [ ] Prompt 规则顺序符合“完整性 → 特殊结构 → 分句 → 粒度”的决策顺序；
- [ ] 新硬门有高置信机器条件并审查过合法反例；
- [ ] TS/Kotlin 同步；
- [ ] 错误文案可直接指导 repair 且双端逐字一致；
- [ ] prompt/tokenization 变化已正确升级版本；
- [ ] 黄金标注由人工复核，并有精确机器断言；
- [ ] 没有把语法纠错下沉到渲染层。

### 合并前

- [ ] 双端分句、prompt、validator、黄金集契约通过；
- [ ] Chrome 和 IntelliJ 全门禁通过；
- [ ] 固定黄金集无 `correct → wrong/failure`；
- [ ] 页面挑战集至少三对同配置评测；
- [ ] 同时报告首轮和生产最终指标；
- [ ] 逐句检查回归与 repair 修坏；
- [ ] 架构文档、`AGENTS.md` 和 CHANGELOG 中受影响说法已同步。

## 13. 当前契约摘要

截至当前实现：

- `CORE_SCHEMA_VERSION = 3`；
- `CORE_PROMPT_VERSION = 17`；
- `DETAIL_PROMPT_VERSION = 10`；
- 单请求最多 6 句，云端默认每块 2 句、本地 loopback 每块 6 句；
- core 首轮失败后最多两轮逐轮收窄 repair；
- 角色协议含 17 个值，但 `COORDINATE_CLAUSE` 已废弃并由 validator 拒绝；
- 非标点 Token 必须恰好覆盖一次；
- `FRAGMENT_HEAD` 表示非成句片段主体，不能用于祈使句；
- 五类从句必须整体覆盖其内部结构；
- 系表结构拆成 `PREDICATE + PREDICATIVE`；
- 介词短语按依附对象判 `ATTRIBUTE` 或 `ADVERBIAL`；
- 最终自然语言成分必须提供有意义的局部中文译文；
- Chrome 与 IntelliJ 通过共享 fixture 保持同一坐标、规则、错误文案和评测口径；
- 名词性成分不得吞入非首位 `of` 后置短语，`the development` 与 `of applications` 分别译为“开发过程”与“应用程序的”。

理解并维护这些约束的关键不是记住更多零散句型，而是始终遵守同一个方法：**先固定输入坐标，按优先级判断结构，只硬编码可证明的错误，用人工黄金答案评价最终划分。**
