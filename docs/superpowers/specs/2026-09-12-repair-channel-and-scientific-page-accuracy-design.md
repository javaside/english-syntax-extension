# 修复通道与科学页面准确性设计

- **日期**：2026-09-12
- **范围**：`chrome-plugin/` + `intellij-plugin/` 双端分析链路、页面语义清单、提示词与版本、评测语料
- **证据**：真机验收（真 Chrome + 真扩展 + 真 DeepSeek）对 `https://arxiv.org/html/2609.04991v1` 全页两轮
- **前置阅读**：`AGENTS.md`、`docs/architecture/model-pipeline.md`、`docs/superpowers/plans/2026-09-08-visible-english-page-coverage.md`

## 0. 一句话

先修**修复通道本身在指错位置**的缺陷（坐标系），再修科学页面的文本表示与标注口径；否则后续所有提示词教学都建在错坐标上，无效修复会被误记成模型能力不足。

## 1. 现场证据

真机验收报告（gitignored）：`.superpowers/acceptance/arxiv-live-{flash,pro}-20260912.json`
探针：`.superpowers/acceptance/probe-arxiv-live.mjs`、`probe-arxiv-dom.mjs`

| 指标 | deepseek-flash | deepseek-v4-pro |
| --- | ---: | ---: |
| 观测到的学习卡片数 | 184 | 184 |
| 成功渲染句 / 失败句 | 345 / 46 | 348 / 43 |
| 含失败提示的块 | 37（20.1%） | 32（17.4%） |
| core 请求 / repair 请求 | 98 / 108 | 94 / 80 |
| 含反斜杠 `\` 的成分 | 79（5.1%） | 80（4.7%） |

**口径声明**（本批的验证前提，见 D8）：

- 345/348 是**成功渲染句数**，不含失败句；观测到的成功与失败 section 合计 391。**不能称为「全页句数」**——尚未证明扫描完整，也未排除 `skipped`、未终态与流式临时 section。
- 「成功渲染句」是**旧 DOM 统计名称**，不等同于 `ready` 数：流式分片可渲染但仍处于 `requesting`（AGENTS.md 约定）。终态须由状态探针确认。
- 表头「自动解析块」应读作**观测到的学习卡片数**；184 不是已证明完整的 `expectedAutomatic` 分母（脚本依赖数量、胶囊、安静窗口与时间上限收尾，且收尾超时被吞掉）。
- **旧报告的 modelCalls 输出截断在 4 000 字符**，不足以完整重放，故 D8 与 D1 同批先修记录口径。

## 2. 根因（按严重度）

### R1 修复通道坐标缺陷（P0，客观 bug，已实测复现）

**R1a 多句 repair 无法定位到句**。`analysis-service.ts:1007-1011` 对每句单独校验：

```ts
validateCoreBatch({ sentences: matchingRawSentences(raw, sentence.sentenceId) }, [sentence], profile.id)
```

错误路径因此永远从 `sentences[0]` 起；而 `:704-710` 把多句错误扁平拼装：

```ts
remaining.flatMap(({ errors }) => errors),
invalidRawSubset(invalidRaw, failedIds)
```

`InvalidCoreSentence`（`:204-207`）只带 `sentence` 与 `errors`，序列化后不携带 `sentenceId`。
**实测：108 次 repair 中 47 次是多句拼装，其错误路径全部是 `sentences[0]`——模型无法判断该改哪一句。**

**R1b component 索引错位**。验证器 `analysis-validator.ts:703-724` 先丢弃纯标点成分再重新编号，而 `invalidRawSubset`（`:452-461`）只筛句子、不过滤成分。模型看到的 JSON 是原始数组，错误路径却指向过滤后数组。
**实测 15 例**，例如错误指向 `components[10]`，模型 JSON 的实际第 11 个成分才是目标；模型照做即改错成分。

> 这是本批最严重的问题：repair 是唯一的自愈路径，而它在指错位置。**准确表述**是「错误无法唯一指向目标，显著增加误修风险」——模型仍可能结合 raw 内容与错误消息推断目标，因此不能由此推论所有提示词教学无效、也不能断言某个失败必由误导导致。108 次 repair 里有多少是「被误导后仍失败」，此前无法与「模型真错」区分。

### R2 公式文本取 LaTeX 源码（P1）

`readable-dom-text.ts:49-51, 65-66` 的 `<math>` 取 `alttext`。arXiv/LaTeXML 的 `alttext` 是 **TeX 源码**，而真 DOM 可见文本是排版结果：

| `alttext`（现采用） | 真 DOM 可见文本 |
| --- | --- |
| `H_{0}={71.9}_{-7.5}^{+9.1}` | `H0=71.9−7.5+9.1` |
| `5\\sigma` | `5σ` |
| `\Lambda` | `Λ` |
| `x_{\text{GW}}` | `xGW` |

双重后果：页面显示 `\Lambda` 这类源码；**观测到**模型把公式 span 以 LaTeX 回显（`translation: "\vec{\phi}"`）而进译文质量门与 repair——不是「只能回显」，模型也可能给出中文解释或把公式并入邻接成分。

**这不是「原计划本如此」**：plan `2026-09-08-visible-english-page-coverage.md:292-296` 与 `AGENTS.md` 都明确登记过「alttext 优先」，本批是对该策略的**修订**，必须同步文档。

### R3 静默错标未被度量（P1）

`II.2.2 Generating and storing the LOS redshift prior` 最终**通过校验**，但标成：

```
FRAGMENT_HEAD "II.2.2"                          → "II.2.2 节"
ATTRIBUTE     "Generating and storing … prior"  → "生成并存储视线方向红移先验"
```

编号被切成独立片段主体、标题词降级成定语。同类还有 `IV.2 Implications for the future`。
`I Introduction` 最终是**成功**的（`FRAGMENT_HEAD → 第一章 引言`），不是失败——此前统计把它误记为失败句。

**验收只看 failures 会把这类错标算成成功**，必须另立指标（见 §5）。

### R4 遗漏问题

- **邮箱元数据被当正文**：真页面是单个 `<p>`（`show]Rachel.Gray@glasgow.ac.uk ]Daniel.Williams@…`），被自动扫描选中并切成「谓语 show + 三个宾语邮箱」；验收 fixture 同一位置是 `author@example.org` 且 reason 为 `reference-metadata`——**fixture 与真实 DOM 口径不一致**。
- **句末参考文献号被当独立成分**：`[61].` / `[5, 6].` 被标成 `ATTRIBUTE` / `ADVERBIAL` / `APPOSITIVE`，译文退化成「参考文献[61]」。
- **脚注号污染分句**：页面上脚注标记紧贴在句末标点后，把两个独立句子焊成一句。报告里**三例**（去重后）：`…redshift uncertainties.2 While optimistic, this study highlights…`、`…gwcosmo [34, 32, 33, 53].3 In section III we present…`、`…never gets split and recombined.4 This is not anticipated…`。本批**不处理**——理由不是证据不足（此前判断有误），而是它需要单独设计「脚注来源保留 + 分句边界」的处理，属于范围控制。登记为待观察。

### 已排除的方向（不要重走）

- **把标题/图注从自动扫描排除**：`page-inventory.ts:63-66,79-83` 明确纳入 `.ltx_bib_title`，plan 明确要求覆盖标题与图注。排除会背离产品契约。
- **放宽 10 实词整句片段门**：`II.2.2 …` 共 10 个 token、9 个非标点，**根本没触发该门**；此前判断有误。
- **译文质量门按「无实词」正则豁免**：判据不成立——`\p{L}{2,}` 同时匹配中文/西里尔/希腊文，且 `G (\bar{G})` 含 `bar` 本就匹配（该例子只在 R2 修复前成立）。**本批不做**的理由：R2 会改变公式 span 与失败样本分布，**TeX 回显相关失败是否减少须重测后裁决**（不能预设「自动消失」）。此处记录判断依据，避免被误读为「质量门永久不可放宽」。

## 3. 设计

### D1 修复通道坐标系（P0）

**D1a 错误携带句身份。** 句身份在内部并未丢失（`InvalidCoreSentence` 已带 `sentence`），**丢失发生在 `flatMap(errors)` 的序列化边界**。因此不必新增冗余字段，改为按句分组序列化。四类情形各给精确实例（**这是内部 repair 序列化格式，不扩浏览器桥协议**）：

```jsonc
[
  // ① 成分级错误：k = 该句 raw 数组下标
  {"sentenceId":"abc…","rawOccurrence":0,"kind":"invalid",
   "errors":[{"path":"components[10].translation","message":"…"}]},
  // ② 句对象级错误（如 sentenceId 非法）：句级根路径，不带 components[...]
  {"sentenceId":"abc…","rawOccurrence":0,"kind":"invalid",
   "errors":[{"path":"sentenceId","message":"must be a non-empty string"}]},
  // ③ 该句 raw 对象缺失：没有 rawOccurrence，明确要求补齐该请求 ID 的输出
  {"sentenceId":"abc…","kind":"missing","errors":[{"path":"","message":"no output for this sentenceId; emit it"}]},
  // ④ 重复 sentenceId：指明删除第几个实例，不留未解释的 sentences[1]
  {"sentenceId":"abc…","rawOccurrence":1,"kind":"duplicate","errors":[{"path":"","message":"remove this duplicate instance"}]}
]
```

`matchingRawSentences()`（`analysis-service.ts:446-449`）**保留同 ID 的多个对象**，验证器会产出 `sentences[1].sentenceId: is duplicated`，故 `rawOccurrence` 是必需的，不能盲目去掉任意 `sentences[n]` 前缀。

`PROMPT_FIRST_LINES.coreRepair` 首行**保持不变**（假服务器按首行识别请求类型），在规则段追加两句：每组对应一个 sentenceId；repair 可修改 ranges/roles/translations，但不得改动输入句 ID 与 Tokens（消除「Repair only the structure」与要求改译文之间的歧义）。

**D1b 诊断坐标与语义序列分离。** validator 内部使用**私有包装类型**承载坐标（不把 `rawIndex` 加进公共 `CoreComponent`，也不用两个平行数组——后者会再次引入对齐风险）：

| 层次 | 承载 |
| --- | --- |
| 非纯标点 raw 候选 | `{ rawIndex, value }` |
| 解析尝试 | `{ rawIndex, component: CoreComponent \| undefined }` |
| 已解析成分 | `{ rawIndex, component: CoreComponent }` |

`collectGrammarErrors` 接收最后一种序列（签名其余参数 `tokens / path / errors` 不变），邻居按**包装序列的位置**查找再取 `.component`，错误路径取当前元素的 `.rawIndex`。Kotlin 同构，`GrammarRole` 枚举不需要改（包装的是已有类型化 `CoreComponent`）。

**坐标必须贯穿四个阶段**（据此更正此前写的「三处」——coverage 的错误路径本来就是句级，没有成分下标，不该为统一 rawIndex 硬造一个）：

1. `parseCoreComponent` 的 range/role/translation 错误（`analysis-validator.ts:633-678`）；
2. **结构范围与顺序检查**（`:730-750`，`componentPath` 用压缩下标）；
3. **`collectGrammarErrors`**（`:331-332` 生成路径；`:331-367`、`:462-471` 取前后邻居）；
4. coverage（`:762-779`）**保持句级路径与计数逻辑不变**。

第 2、3 阶段的邻接必须是**语义成分邻接**：若按原数组下标取 `index±1`，会因中间夹着被跳过的纯标点成分而漏掉原本会拒绝的 grammar 错误（如定语从句后接 `OBJECT`/`PREDICATIVE`），即**把旧的非法输出变成合法**。

**语义不变量（D1b 的验收契约，须写成测试）**：

- 纯标点成分必须在**角色与译文解析之前**跳过（现行为有意容忍模型给标点虚构角色与错误译文，先解析再跳过会把原本接受的输出判非法）；
- skip 与 parse failure 不可混同：非标点解析失败仍参与 `structureTrusted` 与最终拒绝；
- grammar 的邻接关系仍是**语义成分邻接**，不是原数组邻接；
- coverage 仍只统计成功解析的语义成分，且**保留「标点被语义成分重复覆盖」这条检查**（标点被独立纯标点成分覆盖，与被两个语义成分范围重叠覆盖，是两回事）；
- 返回给渲染与缓存的 `CoreAnalysis.components` 不携带内部元数据。

**契约表述**：接受集合、规范化成功结果、coverage 与 grammar 诊断**完全不变**，仅错误路径的索引改变。（此前 spec 写作「语义不变，索引天然对齐」是不完整的——原始遍历不会自动修好 grammar 下标。）

**双端**：Kotlin 的 `AnalysisValidator.kt:516-564` 同样处理；`AnalysisService.kt:401-404` 的 `invalid.flatMap { it.second }` 与 TS 是同一缺陷，D1a 必须双端同步，不能只改 TS。

**差分测试的口径**：「错误 message 不变」是**各端相对各端旧实现不变**。本轮发现一处既有漂移不能被这个契约掩盖：相邻助动词/情态动词的谓语，TS 产出更具体的 `auxiliary/modal verb "…" must be merged with…`（`analysis-validator.ts:374-380`），Kotlin 仍只产出通用的 `adjacent PREDICATE components must be merged…`（`AnalysisValidator.kt:304-313`），而共享 fixture `validator-messages.json` 的 18 条子串里**没有** auxiliary 那条，故现有守护网抓不到它。

处理：作为**独立登记项**修复（属另一类缺陷，不混进 D1b 后仍宣称「仅索引变化」）；同期把该文案补进 `validator-messages.json` 的 `coveredMessageSubstrings`，因为 AGENTS.md 要求错误文案逐字一致并进入 repair prompt。

**D1c 逐轮收窄不变。** 每轮只携带仍失败句、该轮最新非法 JSON 子集与对应 errors；已修好的兄弟句不回流。分组序列化不得让旧错误或兄弟句回流。

### D2 公式文本表示（P1）

`<math>` **始终**读剔除辅助子树后的可见 MathML 文本，不再优先 `alttext`。

**本页实测的元素分布**（据此把待定项拍成决定，避免实现者临场选择）——`/tmp/arxiv-page.html` 199 个 `<math>`：`mtext` 54、`mfrac` 11、`mphantom` 7、`mspace` 0、`msqrt` 0、`mfenced` 0、`annotation-xml` 0、可见文本为空 0。

**决定**：

1. **表示选择**：取「剔除辅助子树后的 MathML 文本」。`alttext` **完全不再读取**（它在 LaTeXML 下恒为 TeX 源码），因此不需要「选择规则」。
2. **隐藏祖先**：`display:none` / `visibility:hidden` / `hidden` 出现在祖先上时阻断整个子树（不只看 Text 的直接 parent）。
3. **嵌套 `<math>`**：递归读一次，不得既收外层 Text 又单独收内层原子造成重复。
4. **辅助子树**：`annotation` 与 `annotation-xml` 都排除（本页无后者，但 MathML 允许，补测试即可）。
5. **`<mtext>` 保留**：它是自然语言（本页 54 处），必须收；补中英文与前后空白测试。
6. **`<mspace>` 有意忽略**（本页 0 处）：它是布局空白、无 Text 节点，不映射为空格。
7. **`mphantom` 作为辅助子树排除**（本页 7 处）：它的内容按 MathML 语义就是不可见的占位。
8. **math 与 `<span>` 交错**：不得无条件在 math 两侧插空格（会破坏标点与紧密连接），并测试已有空格不丢失。
9. **空表示**：本页为 0，但须定义兜底——产生空文本时**不产出空片段**（避免「inline math 不删除」与「空公式静默消失」自相矛盾）；空片段既不进句文本也不进 Token。

**能力边界（写进注释与文档）**：输出是**选定 MathML 表示树的文本线性化**，不等价于数学语义，也不保证保留由布局或元素语义生成的全部符号（`msqrt`、`mfenced` 等）；Token 重建只保证该线性化文本可逆，**不保证源公式可逆**。

**display math 排除判据本身不受影响**（`page-inventory.ts:323-328,353-354` 不读 alttext），但**自动资格整体仍可能变化**——普通块的归一化文本与英文占比会变，因此不能断言「扫描结果完全不受影响」，D8 的 inventory 计数就是用来观测这一点的。

### D3 邮箱元数据排除（P1）

`page-inventory.ts` 在 `reference-metadata` 下新增可判规则：整块内容由邮箱串与转换残留（`show]`、孤立 `]`、逗号、连接词）构成时排除。

测试必须同时覆盖**两类反例**：
- 正向排除：`show]Rachel.Gray@glasgow.ac.uk ]Daniel.Williams@…`；
- 反向保留：`Contact us at author@example.org for details.` 这类真正文里的邮箱。

### D4 句末参考文献号（P1）

新增 prompt 口径 + 黄金集 conventions：句末紧贴的**书目引用**并入前一个成分一起译，不单独成分。

**不新增基于裸字符串的 validator 硬门。** 仅凭外形无法可靠区分引用与向量/数组/编号/字面量，反例：

- `The vector is [1, 2].` / `Return [1, 2].`
- `The allowed interval is [5, 6].`
- `Use [1–3].`（编号或范围）
- `The marker is [Smith, 2020].`（也可指字面文本）

按 AGENTS.md，要求的是**高把握**的本地硬门，不是用有明显反例的正则强行执法。可靠判据来自**来源语义**（DOM 节点标识为书目引用、链接可解析到页面 bibliography entry、排除公式/代码/脚注/章节交叉引用、且位于句尾附加位置），而 validator 输入不含该元数据，D6 又明确不扩协议——故本批只走 prompt + 黄金集，**如实记录这条属于「本地不可高把握判定」**。

可用于**机器断言**的场合：DOM 验收与固定 gold（来源标注已知）。

**更正此前的一条错误论证**：本 spec 早先把「数字必须覆盖」推成「`[61]` 单独成分本就违规」——**不成立**。coverage 只要求数字被覆盖恰好一次（`analysis-validator.ts:762-779`），并不要求与前一个成分共同覆盖；一个合法范围、译文合格、role 适当的独立 `[61]` 可以通过结构校验，译文门（`:621-630`）也不会自动拒绝「参考文献[61]」。**本次改变的是引用附着口径，不是在修复既有 coverage 违规。**

**golden 边界**：黄金集总体不覆盖终止标点，句号不入 gold；句号按现有评分归一化处理，不混进引用附着指标。

### D5 短标题编号绑定（P1，prompt + 黄金集）

目标是**编号绑定标题主体**，不是笼统「整标题合并成一个成分」：

- 章节编号（`II.2`、`IV.2`、`III.2`）**不得单独作为 `FRAGMENT_HEAD`**，须与其标题中心词同属一个 `FRAGMENT_HEAD`；
- **可分离的后置修饰仍按既有后置修饰拆分规则单独标注**——例如 `IV.2 Implications for the future` 不应为了绑定编号，顺带禁止 `for the future` 成为 `ATTRIBUTE`。具体 gold 由人工裁决。

**图注不适用同一条规则**：`Figure 2:` 的描述含 `of …`、`generated …` 等需要判断的后置结构，整句合并会吞掉结构；`label + 完整陈述句/问句` 的图注更不能强制成片段。图注只登记为错标审计类别（D9），本批不改其划分规则。

**不改** `MAX_WHOLE_SENTENCE_FRAGMENT_LEXICAL_TOKENS`。

### D6 版本与文档

- **版本**：R2 改变 `<math>` 的 token 文本 → 同时升 `CORE_PROMPT_VERSION 13→14`、`DETAIL_PROMPT_VERSION 7→8`（AGENTS.md 明文要求；core span 与 detail focus 都吃 Token ID）。`CORE_SCHEMA_VERSION` 保持 `3`。
- **缓存**：按版本键整体作废、全量重取，是预期行为。
- **双端同步**：`AnalysisValidator.kt` 的 D1b 索引口径；`validator-messages.json` 若涉及错误文案需双端逐字一致。
- **文档**：`model-pipeline.md`（MathML 口径修订 + 版本 + 评测数字）、`modules.md`（`readable-dom-text` 职责修订）、`invariants.md`（新增：repair 坐标系必须与模型所见 JSON 一致；`alttext` 是 TeX 源码）、`rendering.md`（错标度量）、`build-test-release.md`（报告记录口径）、`AGENTS.md` 摘要、CHANGELOG。

### D7 评测语料 v2

按 HEAD 提交 `dffa744` 要求重钉并升版本：`spring-np-coordination` 末成分 `79..116 → 79..115`、`spring-zero-relative` 末成分 `152..214 → 152..213`。
arXiv 三句按可见文本与真页面原文重核（`arxiv-figure-caption` 现为改写正文，真页面是带 `Figure 2:` 前缀与 `(solid line)` 的行）。
**v2 冻结并重跑 baseline 之前，不得把 v14 数字与 v1 快照配对比较。**

### D8 验收记录口径（**P0，与 D1 同批**）

理由：D1 修完若报告仍截断输出、无法按句关联，就无法证明坐标修复有效——记录口径与坐标修复是同一批的验证前提，不能排到 P1。

`probe-arxiv-live.mjs` 补：

- **完整模型输出**（现截断 4 000 字符，见 `probe-arxiv-live.mjs:236`），或至少可按请求重放；
- **稳定关联键**：`generation` / block id / sentenceId / 请求 requestId / 每轮 round（重试必须能与被重试的那次关联）；
- **每轮终态**：该句在该轮结束后的 validator 结果（首轮 / repair 1 / repair 2）与最终终态；
- **inventory 计数**：`inventoryTotal` / `expectedAutomatic` / `scannerDiscovered` / `modelRequested` / `ready` / `failed` / `skipped` / `visibleChinese` / `englishEchoRejected` / `excludedByReason`；
- **终态判定**：必须由状态探针确认，不能只看 DOM 是否有 `section.sentence`——流式分片可渲染但仍处于 `requesting`（AGENTS.md 约定）。「成功渲染句」与 `ready` 数**是两个不同字段**。

**计量契约（此前只写字段清单，不够）**：

- **计量单位必须标注**：`inventoryTotal` / `expectedAutomatic` / `scannerDiscovered` 是**页面语义单元数**；`modelRequested` 是**逻辑请求数**；`ready` / `failed` / `skipped` 是**句数**（与 `SessionStatus` 一致，因为一个逻辑请求可含多句、并可能重试）。三类单位不得混算。
- **聚合规则**：同一块内部分 `ready`、部分 `failed` 时，块级标记为**部分失败**并同时计入两个句级计数——不得只取其一。
- **终态来源**：现有 `SessionStatus` 是聚合量，**不足以给出逐句终态**。逐句状态与最终轮 validator 结果由**测试专用内部观测**（探针注入的消息/端口记录）或离线重放获得，不新增生产协议字段。

### D9 静默错标审计（P1，本批建立）

「通过校验但标错」当前**完全未被度量**，只看 failures 会把它算成成功（`II.2.2` 即实例）。建立固定审计集与可执行 oracle：

每个审计项记录：稳定 caseId、来源块定位、原始与归一化文本、文本与 tokenization 版本、审计类别、人工认可的期望 span/role（或允许的多组答案）、必须满足/不得出现的关系、审阅依据与是否已裁决。

**三类断言**：

1. **短标题编号**：编号不得独立为 `FRAGMENT_HEAD`；编号与标题中心词同属一个 `FRAGMENT_HEAD`；可分离后置修饰仍按 gold 单列（`IV.2 Implications for the future` 的 `for the future` 可仍为 `ATTRIBUTE`）。
2. **图注 label**：分「label + 名词片段」「label + 完整句」「label + 问句」子类，各用人工核准标注；**不得用「Figure 开头就合并」当 oracle**。
3. **句末引用**：先由来源标注确认确为引用；断言引用 token 与指定前驱成分共同覆盖；单独成分为附着错误；句号按评分归一化处理，不混入该指标。

**存储与断言**（沿用现有 corpus 的坐标习惯，见 `core-evaluation.mjs:251-303`）：规范化文本 + UTF-16 字符偏移 `[startChar, endChar)` + 文本指纹 + 归一化/分词版本；运行时按字符边界与 token 边界校验。

```jsonc
{"caseId":"…","category":"heading-number-binding",
 "source":{"page":"…","block":"…"},
 "text":"…","fingerprint":"…","tokenization":"core-14",
 "adjudicationStatus":"adjudicated",          // adjudicated | pending
 "acceptedAnalyses":[ /* 允许的【完整】成分序列，可多组 */ ],
 "constraints":[ /* 带类型的关系断言，指向字符/token 范围，不依赖预测数组下标 */ ],
 "rationale":"…","oracleVersion":1}
```

- **多组答案必须是多组完整答案**，不得把不同答案中的单个成分拼接，否则会接受人工从未认可的混合结构。
- 预测须**匹配至少一个完整允许答案**，且满足全部适用的 `constraints`。
- oracle 自身也要校验：至少一个答案、区间合法、与 `constraints` 自洽。
- 只有局部 `constraints`、没有完整 gold 的项，只报「该类约束符合率」，**不得标为整句符合 gold**。
- D9 的「正确」限定为 **span/role 审计正确**，不含译文语义正确性（现有中文门不足以证明翻译准确）。
- 句尾标点按固定评分规则归一化。

**报告用两轴，不能并成一栏**（此前把运行状态与裁决状态并排，二者不正交）：

| 轴 | 取值 |
| --- | --- |
| 运行轴 | 未请求 / 未终态 / 失败 / 通过 |
| 裁决轴 | 已裁决 / 待裁决（通过且已裁决再分**符合** / **违反**） |

**分母政策**（冻结）：

- `N` 个**已裁决** case 构成正式固定分母；
- `pending` 进独立待审队列，**不进正式正确率**；
- 新完成裁决须升 oracle/corpus 版本，并在同版本重评双方；
- 静默错标率分母为 0 时报 `N/A`，**不是 0%**；
- 若坚持把 pending 计入「全部固定审计项」，该比率只能命名为**正确率下界**，不得叫端到端正确率（会把人工未完成误算成模型错误）。

**两个比率**：静默错标率 = 通过但错 ÷ 已通过且已裁决；正确率下界 = 通过且对 ÷ 全部固定审计项。只报失败率会掩盖「模型从静默错变成全部失败」，两者必须同时报。

## 4. TDD 顺序

**P0 批次（D1 + D8，先做完并单独验证）**

| # | 步骤 | RED |
| --- | --- | --- |
| 1 | D1b 索引口径 | validator 测试：插入纯标点成分前后**接受/拒绝结果不变、成功 components 不变**，仅后续错误下标平移；插入非法元素（越界 range / 非对象）**不得**被当作 skip；全纯标点仍拒绝 |
| 2 | D1b grammar 路径 | grammar 错误在插入标点后仍出现，且指向原始下标；`ATTRIBUTIVE_CLAUSE` 后接 `OBJECT`/`PREDICATIVE` 仍被拒（钉住「邻接仍是语义邻接」） |
| 3 | D1a 句身份 | `prompts.test.ts`：多句 repair 的 errors 按 `sentenceId` 分组；不再出现裸 `sentences[0]`；缺句/重复句/句级错误三类路径各有断言 |
| 4 | D1c 收窄 | 契约测试：多失败句 + 纯标点成分 + 逐轮收窄不回流 |
| 5 | D8 记录口径 | 探针字段断言（完整输出、round、终态、inventory 计数） |

**P1 批次（顺序按依赖，不按编号）**

先定政策与基准，再改行为——否则会先做一套与 D4/D5 无关的审计，到改 prompt 时又要回头重定答案：

| # | 步骤 | 说明 / RED |
| --- | --- | --- |
| 6 | **先冻结 D7 corpus v2** | 重钉 `spring-np-coordination` / `spring-zero-relative` 边界并升版本；跑对应 baseline。**必须在任何行为改动前完成**，否则新数字与旧快照不可比 |
| 7 | **D9 审计集（含 D4/D5 的目标政策与反例）** | 人工冻结 oracle：编号标题绑定、句末引用附着的**期望答案在此刻确定**。RED 用**已知坏预测**（现网 `II.2.2` 划分）在审计器中**判为不通过**——不能把坏预测夹具改成正确答案来让测试变绿 |
| 8 | D4/D5 prompt 与 conventions | 按已冻结政策改 prompt；**效果由真模型评测回答**，不靠离线 gold 自我断言 |
| 9 | D2 公式文本 | `readable-dom-text.test.ts`：「优先 alttext」用例改为「alttext 不再读取，取可见 MathML 文本」；补隐藏祖先/嵌套 math/`annotation-xml`/`mtext`/`mspace`/`mphantom`/交错/空表示 |
| 10 | D3 邮箱 | `page-inventory.test.ts` + fixture：排除邮箱块，保留正文内邮箱 |
| 11 | D1b 附带的文案漂移 | 补 TS/Kotlin `auxiliary/modal verb …` 一致性 + 补进 `validator-messages.json` |
| 12 | 文档 | `architecture-docs.test.ts` 红 → 改文档（不放宽断言） |

**版本提升（D6）不能排在所有行为改动之后**：D1a 改的是 core repair prompt，D2 改的是 token 文本，两者**必须各自在对应的可独立验收提交里处理版本**，否则中间提交会出现「行为已变、缓存键仍旧」的窗口。若把 D1+D8 作为独立发布单元，它自己的版本处理也要在该单元内完成，不能等 D2。

每步 RED → 确认失败 → 最小 GREEN → 提交（中文提交信息）。

**关于 prompt 类改动的 RED**：prompt 行为无法靠离线 gold「自然变红」——CI 不联网（AGENTS.md）。RED 来自「已知坏预测在审计器中被判不通过」，**真实效果**由真模型评测回答。

**分层验证**

| 层 | 内容 | 依赖 |
| --- | --- | --- |
| **P0 验证** | ① 离线确定性：从现有 repair prompt 提取完整 Invalid JSON 与 Tokens，对新旧 validator 比较接受结果、成功 components、错误 message，**唯一允许差异是索引**；② P0-only 小规模真实配对：固定同一初始非法输出，旧/新通道分别调用模型，选多句、标点错位、二者组合、单句无错位对照组，**不同时改 MathML 与标注教学** | D1、D8 |
| **整批验证** | ③ 一次仪表完整的全页冷缓存运行：固定页面快照/内容指纹，记录终态、每轮原始输入输出与最终 validator 结果，人工审阅全部最终失败与审计集；④ 两套 corpus 各三次配对，作为回归门禁（不用于声称「不存在模型随机退化」） | D9、D7 |

要回答「剩余失败里多少是模型真错」，必须逐项区分：输入损坏 / 网络与截断 / 协议结构错误 / validator 误拒 / 真实标注或译文错误 / 未裁决。**只重跑并看失败总数无法归因。**

## 5. 验收标准

1. **坐标系**：多句 repair 的每条 error 可唯一归属到句；错误路径索引与模型 JSON 索引一致（单测 + 契约测试钉住）；validator 的接受集合与成功 components 不变（差分测试）。
2. **公式**：真机页面中**由 MathML `alttext` 引入的 TeX 泄漏为零**（不是「反斜杠为零」——合法文本也可能含反斜杠）。
3. **覆盖与失败**（三项分别报告，**失败块比例不是覆盖率**）：
   - `expectedAutomatic` 的**发现率与请求率**（D8 分母，目标 100%）；
   - **失败块比例**：≤5% 是**效果目标，不是硬验收门**——真机单页单模型一次运行，不设硬门；未达时逐句给出原因；
   - **未终态比例**。
4. **错标**：D9 的两轴报告与两个比率（静默错标率、正确率下界）与失败率**分开报告**；本批目标是把该类**量化并建立守护**，不谎报为已清零。
5. **邮箱**：真页面邮箱块不再进入自动分析；正文内邮箱仍保留。
6. **黄金集**：整份通过 validator；新增句人工核语言学正确性 + 按 ID 精确断言。
7. **评测**：两套 corpus 各三次 pipeline 配对，`correctToWrongOrFailure = 0`；corpus v2 **冻结并跑 baseline 后**再解读数字。
8. **门禁**：Chrome 与 IntelliJ 测试通过；lint 按**「仅既有指定错误」显式检查**（`options.test.ts` 的 `no-unnecessary-type-assertion` 恰好 1 个），**不能机械用 lint 退出码判全绿**；`npm run docs:drift`。

## 6. 明确不做

- 不放宽译文质量门（`HAN_PATTERN` 与回显判据不动）。
- 不改 `MAX_WHOLE_SENTENCE_FRAGMENT_LEXICAL_TOKENS`。
- 不排除标题、图注、参考文献题名。
- 不新增语法角色、不新增协议字段、不扩 `SessionStatus`。
- 不增加第 3 轮 repair。
- 不处理脚注号分句（3 例已确认，但需单独设计，属范围控制）。

## 7. 待观察（不进本批）

1. **脚注号对分句的污染（3 例）**：需单独设计来源保留与分句边界，属范围控制。（此前写「2 例、证据不足」有误——报告里是 3 例，其中一例只在 pro 报告的 failures 里，只数 flash 的 failures 会漏掉。）
2. 公式改为可见文本后，残留的「纯符号成分无中文」是否仍需符号留后缀契约（须重测后裁决）。
3. `Binary flag: is the GW signal in this section of data detected?` 一类「label + 完整倒装问句」的优先级口径。
4. prompt 另外两处措辞歧义：无条件禁介词结尾 vs validator 允许从句介词悬垂；冒号规则与片段规则的优先级。
   （`Repair only the structure` 与要求改译文并存的歧义由 D1a 的规则段补充解决，不留在待观察。）
5. 原始响应缺句/重复句/不可解析与真正语法错误的区分（D1a 的四类路径语义是其前置）。
6. 已有回归靶：系表合并、`OBJECT` 吞分词后置 `ATTRIBUTE`、非限定 when 短语（AGENTS.md 记载）。
7. 模型通过 validator 与渲染成可见卡片之间的状态差异（D8 的终态字段是其前置）。
