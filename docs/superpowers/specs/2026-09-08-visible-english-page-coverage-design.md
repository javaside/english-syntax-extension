# 可见英文页面级句法覆盖设计

## 目标

让 Chrome 扩展与 IntelliJ Markdown 预览在用户阅读英文技术文档和论文时，对主内容区内所有安全、可读、具有语义的可见英文块提供稳定的句子成分划分和对应中文局部释义，而不是只对正文长段落表现良好。

目标输入包括：

- 文档标题与论文标题；
- 章节标题；
- 正文和摘要；
- 完整句或片段式列表项；
- 定义项；
- 表格标题、表头与自然语言单元格；
- callout、警告和提示；
- 图表标题与图注；
- 脚注；
- 参考文献中可阅读的论文题名。

英文句法边界仍是首要目标。中文只作为每个英文成分下方的辅助释义，不新增句级翻译字段，也不允许中文语序反过来决定英文 span。

## 现场证据

### Spring AI Reference

Spring AI 首页包含：

> Spring AI provides the following features:

以及随后的功能列表。列表既包含完整句，也包含名词片段、破折号定义和嵌套说明。只抽查正文段落无法证明该页面可用；页面级验收必须覆盖前导语、每个功能项和内部列表。

### arXiv 论文

目标论文：

> Expanding the scope of dark siren cosmology: Inferring the population properties of gravitational wave-hosting galaxies

真实 DOM 调查确认：

- 标题是主 `article.ltx_document` 内的长 `h1`，长度超过自动扫描的 20 字符门槛，现有 scanner 理论上会选中；标题无法翻译不能归因于短文本漏扫。
- 页面包含 1 个 `h1`、8 个可见 `h2`、8 个 `h3`、2 个 `h4`、1 个 `h6`、约 82 个 `p`、82 个 `li`、8 个 `th`、71 个 `td` 和 8 个 `figcaption`。
- `th` 当前不在 Chrome 自动候选集；`td` 和 `figcaption` 虽已进入候选集，但没有专门 fixture 证明真实科学论文 DOM 下的去重、过滤和替换行为。
- 页面同时含 MathML 可见内容、TeX annotation、公式表格、损坏的 LaTeXML 占位文本（如 `\Acp`）、作者/邮箱元数据和超长参考文献作者列表。
- 当前 `normalizedText()` 遍历所有可见文本节点。对内联 `<math>`，可能把数学渲染文本与 annotation 或辅助节点一起收入；必须用 DOM 语义归一化，不能把科学论文问题简化成增加 selector。

该论文标题不是普通完整句，而是冒号连接的两个非限定活动片段。若模型把它整体标成一个 `FRAGMENT_HEAD`，会超过当前 10 实词的单成分片段上限；现有 prompt 又没有“冒号连接两个非限定标题片段”的明确例子，可能在两轮 repair 后仍失败。

## 成功定义

“整篇正确”不是“页面上任意文本节点都自动替换”，而是一个可审计的页面合同：

1. 主内容区内每个安全、可读的英文语义单元都进入页面 inventory。
2. inventory 中每个单元都有明确结局：自动分析、仅显式分析，或带稳定原因的排除。
3. 应自动分析的单元都被 scanner 发现、在进入视口后实际派发，并最终进入 `ready`；不能静默漏选或停在 `failed/skipped`。
4. 最终 core 的每个非标点 Token 恰好属于一个成分，角色与 span 符合统一口径。
5. 每个可翻译成分都有对应自身 span 的有意义中文局部释义；英文原文回显不能作为成功结果缓存。
6. 页面渲染至少显示一条有信息量的中文 translation；没有句级 translation 不算缺陷，但所有成分都无可见中文算失败。
7. 原文可无损恢复，不重复分析同一语义单元，不破坏链接、图片、表格和页面交互。

页面级报告必须分开统计：

```text
inventoryTotal
expectedAutomatic
scannerDiscovered
modelRequested
ready
failed
skipped
visibleChinese
englishEchoRejected
excludedByReason
```

不得用一个“完成”状态掩盖发现、派发、模型输出和渲染中的不同失败。

## 范围与安全边界

### 自动模式纳入

主内容区内：

- `h1`–`h6`；
- `p`、安全叶子 `li`、安全叶子 `blockquote`；
- 渲染为块的安全叶子 `div/section/span`；
- `dt/dd`；
- `caption/th/td` 中的自然语言单元；
- `figcaption`；
- 语义可识别的 callout、note、warning、abstract；
- 参考文献中的题名子单元，而不是整条作者与链接元数据。

### 自动模式排除

- `nav/aside/footer` 等站点导航与模板噪声；
- `pre/code` 与独立展示公式；
- 表单、密码框、编辑区、按钮及含危险交互后代的容器；
- 隐藏内容；
- 纯符号、纯编号、纯作者姓名或纯机构/邮箱元数据；
- MathML annotation、assistive fallback 和与可见公式重复的文本；
- 已知 HTML 转换错误占位符，例如孤立的 `\Acp`；
- 超长参考文献作者列表。

排除必须带稳定 reason code 并进入 inventory 报告，不能静默消失。

### 显式手势

显式手势继续不受 principal root 和普通最短长度限制。用户指向侧栏或导航中的安全英文叶子块时可以解析，但仍拒绝密码框、代码、编辑区、隐藏内容和危险交互容器。

本设计不要求自动替换站点导航、页脚、按钮或所有 ARIA 文本；“可见英文”特指用户阅读内容的安全语义单元。

## 架构设计

### 1. 页面语义 inventory

在现有 `document-scanner` 的候选发现之前增加“语义单元枚举”概念。每个单元至少包含：

```ts
interface ReadableUnit {
  id: string;
  element: Element;
  kind:
    | "heading"
    | "paragraph"
    | "list-item"
    | "definition-term"
    | "definition-body"
    | "table-caption"
    | "table-header"
    | "table-cell"
    | "figure-caption"
    | "callout"
    | "footnote"
    | "reference-title"
    | "loose-block";
  text: string;
  automatic: boolean;
  exclusionReason?: string;
}
```

生产运行时不需要把排除单元全部发送给 session；测试和 acceptance inventory 必须能获得完整分类结果。实现可以采用内部诊断 API，避免把 DOM 元数据加入 SW/JCEF 协议。

### 2. 分类型候选规则

取消“所有自动候选统一至少 20 字符”的单一阈值，改成：

- 标题、`dt`、`th`、`caption` 和短定义项：只要有可读英文实词即可；
- `p/li/dd/td/figcaption`：不以 20 字符作为正确性门，主要依靠语义标签、principal root 和英文占比；
- 松散 `div/section/span`：继续保留 20 字符门槛，防止 UI 标签和模板碎片进入模型；
- 显式手势：不设长度门槛。

`BLOCK_SELECTOR` 增加 `dt,dd,caption,th,td,figcaption`，但不能简单返回所有匹配元素。所有 strict 与 loose 候选统一执行“最小安全语义单元”去重：

- 若父候选的可读文本完全由可分析子候选组成，选择子候选，不再选择父元素；
- `li > p`、`blockquote > p`、`td > p`、`figcaption > p` 不能同时进入 inventory；
- 表格本体和 `tr` 永不作为一个整体文本块；
- 一个文本节点只能属于一个最终可分析单元。

### 3. 科学文档文本归一化

新增纯函数式 DOM 文本提取层，不再直接把所有可见文本节点无差别连接：

1. 普通文本节点保留原顺序与可见空白语义。
2. 内联 `<math>` 使用一个稳定、单一的可见表示：优先 `alttext`，否则使用可见 MathML 文本；忽略 `<annotation>` 与 assistive fallback，防止重复。
3. 独立展示公式不作为英语句子；公式前后的自然语言说明仍分别进入 inventory。
4. 内联数学在句子文本中保留为可重建的原子片段，不能删除，否则英文语法和缓存键失真。
5. LaTeXML 生成的脚注标号、公式编号与浏览器列表序号不重复拼入正文。
6. 参考文献采用题名子元素；若页面没有可靠题名边界，则整条参考文献标为 `unsupported-reference-layout`，不把数千字符作者清单送入模型。
7. 页面提取必须保持元素替换可逆；若语义单元只是父元素中的一段内联文本且不能安全单独隐藏，则暂不自动替换，优先通过显式选择路径处理，不能为了覆盖率破坏 DOM。

这一层先在 Chrome 实现并由 DOM fixture 固定。IntelliJ Markdown 不需要支持 arXiv HTML，但共享的纯文本句法语料与译文校验必须双端一致。

### 4. 句法规则

#### 4.1 片段中的有限定语从句

仅从双端 fragment 禁止集合中移出 `ATTRIBUTIVE_CLAUSE`：

```text
An API                                FRAGMENT_HEAD
that returns JSON responses           ATTRIBUTIVE_CLAUSE
```

保留：

- 通用五类 `CLAUSE_ROLES`；
- 从句最小长度门；
- 定语从句 follower 门；
- 从句尾介词豁免；
- `FRAGMENT_HEAD` 至多一个；
- `FRAGMENT_HEAD` 与普通分句级角色、其余四类从句及 `COORDINATE_CLAUSE` 互斥。

这是现有第 15 个代码判据的作用域收窄，十五条硬门总数不变。错误文案必须明确列出仍禁止的角色，不能继续声称禁止全部 clause roles。

完整句可能退化成 `FRAGMENT_HEAD + ATTRIBUTIVE_CLAUSE` 并通过本地门，例如把主句谓语吞进从句。当前扁平 validator 无法可靠识别该语义错误；必须用 prompt、完整句黄金反例和真实模型逐句 transition 守护，不新增高误杀词表门。

#### 4.2 冒号连接的论文标题

本论文标题采用唯一口径：

```text
Expanding the scope                   FRAGMENT_HEAD
of dark siren cosmology               ATTRIBUTE
Inferring the population properties   APPOSITIVE
of gravitational wave-hosting
  galaxies                             ATTRIBUTE
```

冒号保留为未覆盖标点。后半部分是对前半标题研究范围的重新说明，顶层使用 `APPOSITIVE`，不产生第二个 `FRAGMENT_HEAD`，也不虚构限定谓语。

对应中文局部释义：

- `Expanding the scope` → `拓展研究范围`
- `of dark siren cosmology` → `暗标准汽笛宇宙学的`
- `Inferring the population properties` → `推断种群属性`
- `of gravitational wave-hosting galaxies` → `引力波宿主星系的`

该口径必须补至少一个普通技术标题反例，防止所有冒号后文本都机械标 `APPOSITIVE`。若冒号后是完整独立分句，仍按其内部同层角色分析；若是不可拆说明，才使用 `APPOSITIVE/INDEPENDENT_ELEMENT`。

#### 4.3 从句、并列、控制结构与 PP

重写而不是继续堆叠 prompt，消除现有重复规则：

- 顶层或主句内部的完整 VP coordination：FANBOYS 单列 `CONJUNCTION`；五类从句内部结构不向顶层展开。
- 含限定谓语的 `when/if/before` 从句使用 clause role；`when/before + non-finite VP` 在核心层映射为 `ADVERBIAL`。
- `allow/force/let + NP + infinitive` 使用 `PREDICATE + OBJECT + COMPLEMENT`；`let go` 等没有独立中间宾语的裸不定式链仍是一个 `PREDICATE`。
- 显式和零关系词定语从句都从父 NP 截断后单列完整 `ATTRIBUTIVE_CLAUSE`；修正黄金集中同构异标的既有句。
- PP 采用依附优先的现有角色映射：
  - 名词许可或修饰名词 → `ATTRIBUTE`；
  - 直接表达动词或全句的目标、来源、方向、处所等 → `ADVERBIAL`；
  - 外层 PP 内部的 PP 不再顶层拆分；
  - `pay attention to ...` 维持 `OBJECT attention + ATTRIBUTE to ...`；
  - partitive、形容词片段和既有 fragment-specific 标注不得被“动词依附优先”顺带改坏。

黄金集 PP 标注必须先全量人工复核，再修改 convention；不能只改一句文字而保留冲突标注。

### 5. 中文局部译文质量

#### 5.1 最终 core 必须有中文局部释义

当前 validator 只要求 translation 是安全、非空、不过长的字符串。模型可以原样复制英文 span，validator 通过后 renderer 又通过 `isEchoTranslation()` 隐藏该行，形成“成功缓存但用户看不到翻译”。

双端 validator 新增一个**非语法字段校验**：

- 每个最终 component 的 translation 必须至少包含一个 Unicode Han 字符；
- 从 Token 区间重建英文 span；若 translation 与英文 span 经 Unicode 规范化、大小写折叠和空白折叠后完全相同，同样拒绝；
- 错误和 grammar errors 同轮返回，但不阻断同轮 grammar 诊断；
- 非法译文进入现有 repair 配额，不增加第三轮。

错误文案须逐字一致并进入 repair prompt：

```text
translation must include a meaningful Chinese gloss for the complete covered English span instead of echoing or only copying it
```

#### 5.2 专名、标识与数学内容

专名不是省略中文的理由。模型应保留原标识并补充简短中文类型或含义：

- `Spring AI` → `Spring AI 框架`；
- `JSON` → `JSON 数据格式`；
- `GWTC-5.0` → `GWTC-5.0 引力波事件目录`；
- `H0` → `哈勃常数 H0`；
- `gwcosmo` → `gwcosmo 宇宙学推断软件`。

纯符号或独立公式不应成为自然语言语法成分；含内联数学的英文成分仍须给出该完整 span 的中文释义。这样不需要维护无限增长的专名词典，也不会让论文标题因全部由专名组成而合法地显示零中文。

renderer 保留 `isEchoTranslation()` 作为流式预览和旧缓存的显示兜底，但新的最终 core 不应依赖该兜底。

#### 5.3 版本影响

译文判定不改变 JSON 形状，但会使旧缓存中的英文回显结果在读取时失效并重新请求。该行为与 core prompt 修改一起由新的 `CORE_PROMPT_VERSION` 隔离；不新增句级 translation。

## 测试语料设计

### 1. 页面 DOM fixtures

新增两份最小化、可提交、来源明确的 HTML fixture：

1. Spring AI 首页结构 fixture：保留标题、`Spring AI provides the following features:`、完整功能列表、嵌套列表、callout 和必要的表格/定义结构。
2. arXiv 科学论文结构 fixture：保留论文标题、摘要节选、章节标题、正文中的内联数学、列表、定义表、表头/单元格、公式说明、图注、脚注和一条结构化参考文献。

fixture 只保留测试所需的最小原文与 DOM，不镜像整站，也不依赖联网。每段引用记录来源 URL、抓取日期和用途。

### 2. 页面 inventory contract

fixture 为每个语义单元声明：

```json
{
  "id": "paper-title",
  "kind": "heading",
  "text": "...",
  "automatic": true,
  "reason": null
}
```

排除项同样进入预期：

```json
{
  "id": "display-equation",
  "automatic": false,
  "reason": "display-math"
}
```

单测断言 inventory 全等，而不是只断言“包含几个已知块”。新增 DOM 文本未分类时测试必须失败，防止整类内容静默漏出分母。

### 3. 共享句法黄金集

从两个页面中人工复核并加入至少以下类别：

- Spring AI 功能列表前导语；
- 功能名词片段与破折号说明；
- 论文长冒号标题；
- 短章节标题；
- 片段 + 有限定语从句；
- 完整句 + 有限定语从句反例；
- 有限/非限定时间结构；
- VP coordination 与 NP coordination 对照；
- 动词 PP、名词 PP 和嵌套 PP；
- 宾语控制结构；
- 零关系词定语从句；
- 图注和表格定义；
- 含内联数学原子片段的句子。

Token ID 必须由生产 tokenizer 生成并人工核对。TS/Kotlin 各自重建 Token 并全量 replay；每条新口径另有按句 ID 的精确 span/role 断言。新增黄金句不能只证明 validator 合法，必须人工核语言学正确性。

### 4. 译文质量 fixtures

双端共享 case 至少覆盖：

- 普通英语 span 原样回显 → 拒绝；
- 只有大小写/空白差异的回显 → 拒绝；
- 没有任何 Han 字符的 translation → 拒绝；
- 中文局部译文夹带必要英文专名 → 接受；
- `JSON 数据格式`、`Spring AI 框架`、`GWTC-5.0 引力波事件目录`、`哈勃常数 H0` 等专名释义 → 接受；
- 纯 `JSON`、`Spring AI`、`GWTC-5.0`、`H0` → 拒绝；
- 普通词 + 专名整体原样回显 → 拒绝；
- translation 错误与 grammar 错误同次返回；
- repair 后中文译文可见并可缓存。

### 5. 页面级 E2E

使用假模型服务器和请求探针，逐层断言：

1. inventory 中 `automatic=true` 的所有块被 scanner 发现；
2. 滚动完整页面后全部实际进入模型请求；
3. `detailReady/detailTotal` 之外新增 core 页面账目，不能只断言会话“结束”；
4. 所有目标句最终 `ready`，无 `failed/skipped`；
5. 每个目标块至少显示一条有信息量的中文 translation；
6. 英文回显首轮触发 repair，不能被写入缓存；
7. 重载页面从缓存恢复时无模型请求且仍显示中文；
8. 停止后原始标题、表格、图注和链接结构无损恢复；
9. 嵌套 `li > p`、`td > p`、`figcaption > p` 只产生一张卡片。

## 准确性评测

### 两套语料职责

- `core-gold-annotations.json`：正式人工标注定义，供 TS/Kotlin validator replay 和机器口径断言。
- `core-evaluation-traces.json`：versioned 生产链路评测 corpus 与 synthetic trace 契约。

两者不能混称。把句子加入正式黄金集不会自动让真模型 runner 请求它。

### 固定 40 句回归

现有 40 句 corpus 保留，用 `--mode pipeline` 做同配置、同 corpus 的三次 baseline/candidate 配对，检查：

- 最终整句 exact；
- labeled-span F1；
- split/category；
- 最终失败；
- `correctToWrongOrFailure`。

它只证明一般非回归，不能证明页面覆盖和本设计新增句型已经改善。

### 页面目标 corpus

新增一个包含 Spring AI 与 arXiv 目标结构的 versioned corpus，或扩展现有 corpus；无论选择哪一种，都必须：

1. 在修改 prompt/validator 前，以最终目标 corpus 快照生成三份 pipeline baseline；
2. 修改后用完全相同 corpus、模型、endpoint、batch size、temperature、reasoning/schema 参数和 timeout 策略生成三份 candidate；
3. 每一对 artifact 的 corpus 与运行配置必须机器校验一致；
4. 比较最终指标均值，并逐句审查修好、修坏和失败转移；
5. 页面扫描覆盖率另由 DOM inventory/E2E 报告，不能混入模型 span F1。

现有比较器只强制 corpus 相同，尚未强制 model/parameters/mode/batch size 等配置一致；正式实施需补 artifact 可比性校验，不能仅靠人工记忆。

## 版本与缓存

本设计分阶段落地，但作为同一个用户可见版本发布：

1. 页面 inventory 和 scanner；
2. 科学 DOM 文本归一化；
3. fragment validator groundwork 与译文回显校验；
4. prompt、黄金集和真实模型评测；
5. 页面级 E2E 与文档收口。

版本规则：

- 科学 DOM 归一化会改变发送给模型的句文本，并可能改变内联数学附近的 Token 边界；按项目硬约束，tokenization 输入变化必须同时提升两条提示词版本。
- 本版本最终把 `CORE_PROMPT_VERSION` 12 → 13、`DETAIL_PROMPT_VERSION` 6 → 7；一个发布内各只提升一次。
- 不增删角色、不改 JSON 字段：`CORE_SCHEMA_VERSION` 保持 3。
- core 与 correction 缓存随 core 版本失效；detail 缓存随 detail 版本失效。全量重取是预期行为，必须写入 CHANGELOG 和验收说明。

版本同步位置：

- Chrome `versions.ts`；
- Kotlin `Domain.kt`；
- `shared-fixtures/contracts.json`；
- `shared-fixtures/core-prompt-parity.json`。

## 双运行时边界

### Chrome

负责网页 DOM inventory、科学文本归一化、自动/显式扫描、视口派发和页面级 E2E。

### IntelliJ

不需要模拟 arXiv DOM，但必须同步：

- core/repair prompt；
- validator 的 fragment 例外；
- translation 英文回显校验；
- 共享黄金集和 validator-message fixture；
- 版本与缓存键。

若 Markdown 预览中也存在短标题、表格或图注漏扫，则按同一页面合同另补 `preview.ts` DOM fixture；不能假设 Chrome 修复自动覆盖 IntelliJ。

本设计不修改角色枚举、bridge 消息或 JCEF web 映射，因此原则上不需要重建 `bundle.js`。若实施时修改 `web/*.ts` 的扫描逻辑，则必须运行 `npm run bundle-web` 并提交产物。

## 错误处理与可观测性

页面级状态需要区分：

- `excluded`：带 reason，不进入模型；
- `discovered`：已进入 scanner；
- `requesting`：实际请求中；
- `ready`：结构和译文均通过最终校验；
- `failed`：首轮及最多两轮 repair 后仍失败；
- `skipped`：仅缓存模式未命中等明确路径。

自动模式不能把 `excluded` 当失败，也不能把未发现项从分母删除。生产 UI 不必展示完整诊断表；测试探针和 gitignored acceptance artifact 必须保存这些计数与 reason。

模型返回英文回显时走现有 repair 配额，不增加第三轮。最终失败保持原文、错误提示和用户重试入口，不能显示为成功卡片。

## 不采用的方案

1. **只修 prompt/validator**：标题、表头和参考文献题名可能仍未进入模型，无法达成页面目标。
2. **扫描页面所有文本节点**：会处理导航、按钮、作者列表、公式和重复辅助文本，破坏交互并浪费请求。
3. **新增句级 translation**：偏离“通过句子成分辅助阅读”的核心目标，也会让中文语序干扰英文边界。
4. **把专名强制改写成纯中文或维护专名词典**：会损失 API、缩写和数学标识；本设计保留英文标识，并要求补充简短中文类型或含义。
5. **新增 `OBLIQUE` 角色**：会扩大 schema、协议、缓存和渲染变更；现有 `ATTRIBUTE/ADVERBIAL` 足以按项目口径表达。
6. **只靠 selector 适配 arXiv class 名**：脆弱且不能解决 MathML 重复、参考文献边界和通用科学文档结构。
7. **用固定 40 句宣称页面目标达成**：该 corpus 不覆盖扫描与大部分新句型。
8. **把前一 DOM 块偷偷拼入当前句**：会改变 Token、缓存与 span；跨块上下文若后续需要，必须另立协议设计。

## 验收标准

### 页面覆盖

- Spring AI fixture 的标题、功能前导语、每个功能项、嵌套说明和 callout 全部有预期 inventory 结局。
- arXiv fixture 的论文标题、章节标题、摘要、正文、列表、定义表、表头、自然语言单元格、图注、脚注和参考文献题名全部有预期结局。
- inventory 全等测试不存在未分类新增块。
- 应自动处理的块在完整滚动后 100% discovered、requested、ready，并显示有信息量的中文局部译文。
- 排除项 100% 带稳定 reason；公式、作者列表、导航和转换占位符不会进入模型。

### 句法与翻译

- 论文标题按本设计四个 span 固定，不再整块失败。
- `FRAGMENT_HEAD + ATTRIBUTIVE_CLAUSE` 双端合法，其余 fragment/分句级混用继续拒绝。
- 完整句不会因受限放行退化成 fragment。
- VP/NP coordination、有限/非限定、控制结构、零关系词和 PP 依附的 prompt、conventions、黄金标注一致。
- 普通英文回显 translation 被双端拒绝并 repair；纯专名/标识合理保留。
- 所有新增黄金句通过双端生产 tokenizer 与 validator replay。

### 评测与门禁

- 固定 40 句与页面目标 corpus 均完成三次 `pipeline` 配对；配置和 corpus 可比性由机器校验。
- 不出现新的 `correctToWrongOrFailure`，最终失败不增加；目标题型逐句改善。
- Chrome 全量单测、Playwright、lint 基线、format、build、严格 docs drift 全部满足项目门禁。
- IntelliJ web 测试及 Gradle test/buildPlugin/verify 全部通过。
- 文档同步 `AGENTS.md`、`overview.md`、`modules.md`、`protocol.md`、`model-pipeline.md`、`rendering.md`、`build-test-release.md`、`invariants.md` 和 `CHANGELOG.md`。

## 实施前置条件

1. 从真实 Spring AI 与 arXiv 页面生成最小 DOM fixture 和完整 inventory 期望。
2. 对论文标题及所有新增黄金句完成人工语言学标注。
3. 冻结页面目标 evaluation corpus，并在旧行为上先生成三份 baseline。
4. 统计现有黄金集中所有零关系词与 PP 标注，先解决同构异标再改 conventions。
5. 测量当前 core/core-repair prompt 的字符与 token 预算，后续通过重写去重控制增量。

满足以上条件后，再进入实现计划与 TDD，不允许边改 prompt 边补 baseline。

## Sources

- [Spring AI Reference 2.0.1](https://docs.spring.io/spring-ai/reference/index.html)
- [arXiv HTML: Expanding the scope of dark siren cosmology](https://arxiv.org/html/2609.04991v1)
- [arXiv abstract record](https://arxiv.org/abs/2609.04991)
- [Spring AI 句法审阅与三轮审核记录](../audits/2026-09-08-spring-ai-grammar-review.md)
