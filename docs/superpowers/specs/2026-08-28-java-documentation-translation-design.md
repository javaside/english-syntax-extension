# IDEA Java Documentation 自动中文翻译设计

**日期：** 2026-08-28  
**状态：** 已批准  
**目标平台：** IntelliJ IDEA Community / Ultimate 2025.1 及以上  
**前置条件：** 用户已配置活动模型 Profile，并主动开启 Java 文档自动翻译

## 1. 背景与目标

IntelliJ 插件当前只增强官方 Markdown JCEF 预览。新功能增强 IDEA 原生 Java Quick Documentation：当鼠标悬停自动预览、显式打开 Quick Documentation 或固定到 Documentation Tool Window 时，保留 IDEA 原生英文文档，并在下方异步追加简体中文翻译。

功能覆盖项目源码、依赖源码及 IDEA 能通过公开文档 API 取得的外部 Javadoc。翻译 JavaDoc 主说明，以及 `@param`、`@return`、`@throws`、`@exception`、`@deprecated` 等标签后的自然语言；签名、参数名、类型、代码、链接和 URL 保持原样。

成功标准：

- 原生文档立即显示，不等待模型，链接、图片、导航和外部文档能力不受损；
- 英文说明自动查缓存并异步追加中文，悬停与显式文档行为一致；
- 快速切换目标、编辑源码或关闭预览时，迟到结果不得污染其他文档；
- API Key 仍只存在于 PasswordSafe 与 Kotlin HTTP 层；模型只收到目标文档中的自然语言片段；
- 只使用 IntelliJ 2025.1 可公开依赖的 Documentation API，不反射、不修改 UI 组件、不依赖 `ide.impl`；
- 若同页包装无法通过真实 IDE 兼容性探针，停止方案 A并回退到需重新确认交互的独立中文 target 方案。

## 2. 已确认决策

| 问题 | 决策 |
| --- | --- |
| 展示形式 | 保留 IDEA 原文，在下方追加独立中文区；不搬用 Markdown 三层句法卡片 |
| 翻译范围 | 主说明及标签后的自然语言；参数名、类型、代码与链接不翻译 |
| 触发时机 | Documentation 出现后立即查缓存，未命中则异步请求；原文不等待 |
| 文档来源 | 项目源码、依赖源码，以及可通过公开 API取得最终内容的外部 Javadoc |
| 生效入口 | 鼠标悬停、显式 Quick Documentation 和 Documentation Tool Window 均生效 |
| 默认开关 | 新安装和升级均默认关闭，用户在设置页知情开启 |
| 模型配置 | 复用当前活动 `ModelProfile`，不增加独立模型或 API Key |
| UI 流式 | 不逐 token 展示，只更新完整且校验通过的译文 |
| 平台策略 | 先做兼容性探针；不为保持同页展示而引入反射或内部 API |

## 3. 范围与非目标

### 3.1 包含

- Java 类、方法、构造器和字段的 IDEA Documentation；
- 项目源码 JavaDoc、依赖源码 JavaDoc、公开 API可取得的外部 Javadoc；
- 主说明、段落、列表及常见标签说明；
- 英文检测、片段提取、代码占位符、严格 JSON 校验和一次修复；
- 逐片段 SQLite 缓存、统一 LRU、请求去重、取消和失败冷却；
- 独立设置开关、隐私说明和模型费用提示；
- IDEA 2025.1 平台探针、自动化测试和真机验收。

普通 `//`、`/* ... */` 注释仅在 IDEA 原生 Documentation 本身将其作为目标文档展示时处理；插件不自行把任意邻近注释绑定到 Java 元素。

### 3.2 不包含

- 修改 Java 源文件；
- 源码编辑器 Inlay、Code Vision、行内翻译或独立翻译窗口；
- Markdown 句法卡片、成分角色或点击详解；
- 翻译方法体、字符串字面量或完整 Java 文件；
- 自建外部 Javadoc 下载器、代理、认证或 HTML 浏览器；
- 目标语言、悬停延迟、独立模型、自定义 prompt 等高级设置；
- 其他语言或其他 JetBrains IDE 的正式支持；
- 将 translation store 加入现有 Chrome/IDEA 缓存交换格式。

## 4. 平台约束与方案选择

IntelliJ Platform 2025.1 提供 `DocumentationTarget`、`DocumentationResult.asyncDocumentation(...)` 和 `DocumentationResult.Documentation.updates(Flow<DocumentationContent>)`，但没有公开的“装饰现有 DocumentationResult”扩展点。`DocumentationTargetProvider` 和 `PsiDocumentationTargetProvider` 是目标选择器，不是 result decorator chain；只要第三方 provider 返回 target，就可能改变默认 PSI fallback。

因此首选方案 A是受控的组合 target：在隔离兼容层取得 IDEA 原生 Java 文档，构造“原生 HTML + 中文状态区”，再通过 `updates(Flow)` 重发完整组合内容。每次 emission 替换完整 browser content，不假设增量 append。

禁止：

- 反射或组件树遍历；
- `com.intellij.*.ide.impl.*` 等内部包；
- 直接实例化标为 `VisibleForTesting` 的 `PsiElementDocumentationTarget`；
- `QuickDocUtil.updateQuickDoc*`、`getActiveDocComponent` 等 Documentation v2 中已失效的 UI更新方式；
- 保存 popup、browser、Swing 或 JCEF 组件引用并主动改写内容。

允许在唯一适配文件中、经 Plugin Verifier 和静态守卫约束，使用 2025.1 仍提供但标记 obsolete 的 `DocumentationProvider` 兼容接口取得 Java 原生内容；该类型不得泄漏到服务、缓存、模型或设置层。

## 5. 总体架构

```text
IDEA Java Documentation 路由
  → JavaTranslationDocumentationTargetProvider
  → JavaTranslationDocumentationTarget
  → NativeJavaDocumentationAdapter
       ├─ 项目/依赖源码文档
       └─ 可公开取得最终内容的外部 Javadoc
  → DocumentationContentExtractor
       ├─ 保留原始 HTML
       ├─ 提取自然语言片段
       └─ 生成 source fingerprint
  → DocumentationTranslationService
       ├─ 英文检测
       ├─ translation SQLite 缓存
       ├─ RequestScheduler
       ├─ OpenAiCompatibleClient
       ├─ 严格校验与一次 repair
       └─ 去重、取消和失败冷却
  → TranslatedDocumentationComposer
  → Documentation.updates(Flow)
```

建议新增包：

```text
dev.codetui.englishsyntax.java.documentation
dev.codetui.englishsyntax.translation
```

边界规则：

- `java.documentation` 集中承载 Java PSI、Documentation API和兼容逻辑；
- `translation` 只认识普通片段、请求、结果、缓存和模型端口；
- `analysis/` 继续负责 Markdown 句法分析，不加入 Java 翻译分支；
- `markdown/`、JCEF bridge 和 web bundle 不因本功能变化；
- Java PSI/Documentation 类型不泄漏到 `analysis/`、`model/`、`cache/` 的通用领域对象。

## 6. 平台兼容性探针

平台探针是正式实现的**阻断决策门**，不是完整功能计划中的普通任务。工作拆为：

1. **A0 平台兼容性探针计划**：只实现可保留的 provider/target骨架，以固定中文验证平台能力，并输出书面决策；
2. **A1 正式功能计划**：仅在 A0确认方案 A可继续后编写，覆盖提取、模型、缓存、调度、设置、测试和文档；
3. **方案 B**：不属于当前已批准实施范围；核心探针失败时先重新确认交互，再另写设计与计划。

A0 注册只命中 Java 的 provider，以固定中文替代模型结果，验证 wrapper target、pointer、原生结果和 `updates(Flow)`。探针还必须确定并记录：Gradle `bundledPlugin(...)`、`plugin.xml` plugin/module dependency、IC/IU依赖是否一致、obsolete API唯一适配文件、Plugin Verifier结果、动态卸载与升级重启行为，以及同步/异步/自带 updates 的原生 `DocumentationResult` 如何通过公开 API组合。

### 6.1 必验矩阵

- 项目类、方法、字段 JavaDoc；
- JDK/依赖源码 JavaDoc；
- 已配置外部 Javadoc；
- 鼠标悬停 popup；
- 显式 Quick Documentation；
- Documentation Tool Window；
- 原生链接、图片、definition details、external URL和导航；
- 快速切换目标、关闭预览、源码编辑后的旧结果隔离。

每项都必须满足：原文保留、固定中文异步追加、链接可用、切换不串页、无 EDT阻塞和 IDEA internal error。

### 6.2 硬回退门槛

任一情况出现即停止方案 A：

1. 只能通过内部 `DocumentationManager` 或反射取得原始 target/result；
2. 必须直接实例化 `VisibleForTesting` target；
3. 必须修改 Documentation browser/UI组件；
4. 原始链接、图片、外部 URL、definition details 或导航无法可靠保留；
5. 同步或异步原生结果的基础组合能力无法通过公开 API成立；
6. provider 路由导致其他插件 target 消失，且无法以公开 API避免；
7. 快速切换时无法可靠取消旧 update；
8. hover、显式文档和 Tool Window 无法统一工作；
9. Plugin Verifier 报告内部或不允许的 API依赖。

回退方案 B提供独立“中文翻译”Documentation target，不复制原生 HTML。由于用户需要在 IDEA 多 target UI切换，不再满足“原文下方自动追加”，必须重新取得用户确认后才能继续。

若核心组合能力通过，但某一种外部 Javadoc 来源只能经平台内部 API取得，则这属于**来源能力降级**，不推翻方案 A：项目源码、依赖源码及公开 API已经取得最终 HTML 的文档继续同页翻译；该外部来源不增强，并在 A0决策记录和用户文档中明确。插件不自行联网下载 Javadoc。

## 7. 原生文档适配与 target 身份

兼容层抽象：

```kotlin
interface NativeDocumentationSource {
  fun load(request: NativeDocumentationRequest): DocumentationResult?
}
```

生产实现仅存在于 `java.documentation`；测试以 fake source 覆盖同步、异步、空结果、异常和失效 PSI。

组合 target 委托原 target 的 presentation、navigation 和 hint。`createPointer()` 保存目标与原始元素的可恢复 pointer、可选 anchor及重建 wrapper 所需的最小数据，不保存活 PSI或 UI引用。任一关键 pointer 无法恢复时返回 `null`。

原生结果为空时插件也返回空，不根据签名或相邻源码自行生成文档。兼容层失败时优先退出增强并交还默认行为；不得用插件错误页替换原生 Quick Documentation。

## 8. HTML 提取与英文检测

### 8.1 领域结构

```kotlin
data class ExtractedDocumentation(
  val originalHtml: String,
  val fragments: List<TranslatableFragment>,
  val sourceFingerprint: String,
)

data class TranslatableFragment(
  val id: String,
  val kind: FragmentKind,
  val sourceText: String,
  val contextLabel: String?,
  val order: Int,
)

enum class FragmentKind {
  DESCRIPTION,
  PARAMETER_DESCRIPTION,
  RETURN_DESCRIPTION,
  THROWS_DESCRIPTION,
  DEPRECATED_DESCRIPTION,
  OTHER_TAG_DESCRIPTION,
}
```

### 8.2 提取规则

提取主说明段落、列表项和以下 allowlist 标签的自然语言说明：

| JavaDoc 标签 | 归一化 kind | 规则 |
| --- | --- | --- |
| `@param` | `PARAMETER_DESCRIPTION` | 参数名只进 context，不进待翻译正文 |
| `@return` | `RETURN_DESCRIPTION` | 只取说明正文 |
| `@throws`、`@exception` | `THROWS_DESCRIPTION` | 异常类型只进 context |
| `@deprecated` | `DEPRECATED_DESCRIPTION` | 翻译弃用原因和替代建议中的自然语言 |

`@since`、`@author`、`@version`、`@serial*`、`@see` 和未知标签首版不翻译，也不生成 `OTHER_TAG_DESCRIPTION`；该枚举值为未来兼容保留。无说明正文的标签不生成 fragment。多段标签说明保持 DOM顺序并作为同一个 fragment提取。

排除：

- definition/signature；
- `<code>`、`<pre>`、snippet；
- 整个 `<a>` 节点（包括可见文字）、URL、图片和 IDEA操作区；
- 参数名、类型、版本号、纯符号引用；
- 插件自己的翻译区。

混合内联代码时，用本地占位符替换：

```text
Returns ⟪CODE_0⟫, or ⟪CODE_1⟫ if unavailable.
```

模型必须逐字保留占位符。映射只在本地存在；恢复后以 escaped `<code>` 文本输出。

不使用正则解析 HTML。优先采用可公开依赖的平台 HTML parser；否则选择小型纯 JVM parser，要求不执行脚本、不发网络请求、可处理 HTML fragment、许可证和包体积可接受。原生 HTML不重新序列化，只用于最终组合。

### 8.3 英文判定

每个 fragment 独立判定：

1. 去除占位符、URL、标识符和标点；
2. 至少 3 个拉丁字母单词；
3. 拉丁词占可识别自然语言词比例至少 60%；
4. 中文已占主要部分则跳过；
5. 纯签名、版本、常量列表、`TODO`、`HTTP GET` 等短标签跳过。

整页只要一个 fragment 合格就启用翻译区。

“出现即翻译”的技术触发点是：开关开启且取得第一份**可展示、可提取的原生 HTML**之后立即查缓存，不增加 hover延迟、按钮或点击。同步、异步和原生自带 updates结果的取值/转发方式由 A0探针确认并写回本节；在此之前 A1不得开始。若原生内容后续 update改变 source fingerprint，则关闭旧订阅，以新 HTML重新提取并启动新订阅；fingerprint不变则不重复请求。hover、显式窗口和 Tool Window使用同一规则。

超限按以下固定顺序处理：

1. 原生 HTML超过 1 MiB：整页不解析、不调用模型；
2. 提取后的合格自然语言超过 50,000 字符：整页不调用模型，避免用截断上下文产生不完整翻译；
3. 合格 fragment超过 50 个：按 DOM顺序选取，但先为主说明、参数、返回值、异常和弃用五类各保留首个片段，再按原顺序补足至 50 个；其余标记为未翻译；
4. 单 fragment超过 4,000 字符：按段落边界、句子边界依次确定切点；占位符不可拆开；4,000 字符内找不到安全切点时，该 fragment跳过；
5. 子 fragment ID为 `<原id>-part-<从0开始序号>`，继承 kind/context/order，并以 part序号作为次序；子片段分别计算缓存键，展示时按 part顺序用换行合并；拆分后的子片段计入 50 个上限；
6. 最后按每请求最多 20 fragment、总 sourceText最多 12,000 字符稳定分批。

同一输入的选择、拆分、ID、缓存键和回组必须由固定向量测试钉住。

## 9. 模型请求、Prompt 与校验

### 9.1 独立契约

新增：

```kotlin
DOCUMENTATION_TRANSLATION_SCHEMA_VERSION = 1
DOCUMENTATION_TRANSLATION_PROMPT_VERSION = 1
```

翻译不复用 Markdown core/detail schema、prompt或缓存版本。修改翻译 prompt 必须升 prompt version；修改响应领域结构必须升 schema version。

translation system prompt的精确首行为：

```text
Translate Java documentation fragments to Simplified Chinese.
```

repair system prompt的精确首行为：

```text
Repair invalid Java documentation translation JSON.
```

假模型服务器按这两个不可变前缀识别请求类型。其余 system prompt要求：只翻译英文 Java API自然语言；保留 fragment ID与占位符；不翻译标识符、类型、字面量、URL或代码；不增加解释、示例、Markdown或 HTML；只返回 JSON。

User prompt 发送紧凑 JSON：

```json
{"fragments":[{"id":"description-0","kind":"DESCRIPTION","text":"Returns the current user."},{"id":"param-1","kind":"PARAMETER_DESCRIPTION","context":"parameter: timeout","text":"Maximum time to wait in milliseconds."}]}
```

不发送原始 HTML、完整源码、方法体、项目路径、文档 URL、PSI offset、包名或完整 owner 身份。`context` 只含如 `parameter: timeout`、`throws: IOException`、`return` 的局部消歧信息。

调用 `OpenAiCompatibleClient.completeJson()`，复用 JSON Schema 与 `reasoning_effort: "none"` 的现有降级。不做 UI token流式展示。

### 9.2 响应与校验

响应：

```json
{"translations":[{"id":"description-0","text":"返回当前用户。"}]}
```

严格校验：

- 顶层只含 `translations`；条目只含 `id`、`text`；
- 请求和响应 ID集合完全相同，不重复、不多不少；
- 按请求 order重排，不信任响应顺序；
- 文本 trim后非空，无 NUL/控制字符、HTML、Markdown fence或额外说明前缀；
- 至少含中文，不能是规范化原文回显；
- 先将连续空白规范为单空格再计 UTF-16字符数；译文最多为 `max(200, sourceLength * 4)` 且绝对不超过 8,000 字符，拆分子 fragment使用同一规则；
- 每个 fragment 的占位符多重集合逐字一致，不得跨 fragment移动。

模型输出不允许部分写缓存。首轮非法时执行一次 repair；repair prompt包含紧凑序列化的原请求、非法响应和明确校验错误。repair 只在原优先级内 `jumpQueue`，订阅取消后不 repair。

## 10. 缓存与数据库迁移

### 10.1 逐 fragment 缓存

缓存键：

```text
SHA-256([
  "documentation-translation",
  normalizedSourceText,
  fragmentKind,
  normalizedContextLabel,
  "zh-CN",
  DOCUMENTATION_TRANSLATION_SCHEMA_VERSION,
  DOCUMENTATION_TRANSLATION_PROMPT_VERSION
])
```

不含模型、profile、项目、文件、类、URL或 PSI offset。同一依赖文档可跨项目命中。

缓存值至少包含 `DOCUMENTATION_TRANSLATION_SCHEMA_VERSION`、source hash、译文和占位符集合。读取后重新执行结构、版本、source hash、HTML、回显和占位符校验；损坏值视为未命中。

### 10.2 `translation` store

在现有 `analysis-cache.sqlite` 增加 `translation` store，参与统一容量统计、50MB默认上限、跨 store LRU和“清空缓存”。现有 DDL只允许 `core/detail`，必须事务迁移：创建新表、复制旧数据、替换表、重建索引；失败 rollback，不允许删库重建。

翻译缓存不进入 formatVersion 1 的 Chrome/IDEA缓存交换。导入导出仍只处理 core/detail；统计和清空覆盖三类 store。

### 10.3 查询行为

逐 fragment 查缓存，只请求未命中部分。全部命中时不创建调度任务、不读取凭据。没有活动 profile 时仍显示缓存译文；未命中部分显示“未配置翻译模型”。展示层等待当前文档所有批次结束后一次更新，避免弹窗连续跳高。

## 11. 分批、调度与去重

分片和分批限制统一按第 8.3 节的固定顺序执行。同一文档最多同时运行 2 个批次。每个批次原子校验；一个批次失败不抹掉其他批次的合法结果和缓存，但 UI等全部批次终结后统一组合。

调度优先级调整为：

```text
USER_RETRY
> DOCUMENTATION_TRANSLATION
> DETAIL_CLICK
> ACTIVE_VISIBLE_CORE
> OTHER_VISIBLE_CORE
> ACTIVE_PREFETCH_CORE
```

Documentation 是当前用户等待的交互请求，不算后台请求；它不抢占已运行任务。repair 只能在 `DOCUMENTATION_TRANSLATION` 内插队。

将 `ScheduledRequest.sentenceCount` 泛化为 `workUnits`：Markdown core仍由分析层保证最多 6 句，detail与 Documentation batch传 1。调度器继续限制 `workUnits` 为 1..6，不能借字段改名放宽 core领域上限。

相同的有序 fragment cache key集合共享一个在飞请求。后来的相同预览只增加订阅，不重复调用模型；模型 profile按首个创建共享请求者快照。一个订阅关闭不影响其他订阅；最后一个关闭时取消该共享请求的 scheduler document。

## 12. 订阅、取消与迟到结果隔离

接口：

```kotlin
interface DocumentationTranslationService {
  fun subscribe(request: DocumentationTranslationRequest): TranslationSubscription
}

interface TranslationSubscription : AutoCloseable {
  val updates: Flow<DocumentationTranslationState>
}
```

状态为：

```kotlin
sealed interface DocumentationTranslationState {
  data object Loading : DocumentationTranslationState
  data class Complete(val translations: List<FragmentTranslation>) : DocumentationTranslationState
  data class Partial(
    val translations: List<FragmentTranslation>,
    val failures: List<FragmentFailure>,
  ) : DocumentationTranslationState
  data class Unavailable(val reason: TranslationFailureReason) : DocumentationTranslationState
}
```

初始只发一次 Loading；所有缓存查询与模型批次终结后，只再发一次 Complete、Partial或 Unavailable。缓存命中与请求成功结果都进入 `translations`；无 profile、冷却、超限和批次失败按 fragment进入 `failures`。有至少一条合法译文但仍有失败时为 Partial；没有合法译文时为 Unavailable；取消不发终态。Documentation target把状态映射为完整 `DocumentationContent`。Flow被平台取消时在 `finally` 关闭 subscription。

每个订阅保存：

```kotlin
data class DocumentationRequestIdentity(
  val targetPointerId: String,
  val sourceFingerprint: String,
  val subscriptionId: String,
)
```

身份算法：

- `sourceFingerprint = SHA-256` 对按 order排列的 `[kind, normalizedContextLabel, normalizedSourceText, placeholders]` 紧凑 JSON计算；不含原始 HTML样式和 offset；
- `targetPointerId` 仅作当前进程身份守卫，由 `VirtualFile.url + owner stable JVM signature + pointer创建序号` 的 SHA-256生成，不持久化、不进缓存；
- owner stable JVM signature使用 Java PSI可公开取得的 owner种类、qualified class name、member name和 JVM parameter type erasure；字段无参数；无法稳定生成则该 target不增强；
- “同一 owner”指 pointer恢复后重新计算的 stable JVM signature与创建时完全一致。重载方法因此不会互相复用 UI订阅，但相同文档文本仍可共享内容缓存。

emit前必须同时确认：订阅未关闭、subscription ID匹配、source fingerprint未变、target pointer仍可恢复、恢复后仍是同一文档 owner。不得仅凭文件路径和 offset回填。

最后订阅取消后：排队任务移除，在飞协程和 HTTP future取消；取消不 retry、不 repair、不进入失败冷却。合法结果与取消并发完成时允许写缓存，但只有 active subscription可收到 update。

源码编辑后，新原生 HTML生成新 fingerprint；旧结果不更新新文档。文本相同但 offset移动可继续命中内容缓存。不建立全局 PSI listener或长期 editor session。

## 13. 失败冷却与错误降级

仅内存、按 batch key冷却：

| 失败 | 冷却 |
| --- | ---: |
| 超时、网络错误、限流 | 30 秒 |
| 模型格式持续无效 | 5 分钟 |
| 未配置 profile/API key | 不请求；配置变化后立即恢复 |
| 用户取消/预览关闭 | 不记录 |
| 损坏缓存 | 忽略条目并正常请求 |

冷却期间保留原文并显示稳定错误，不调用模型。首版无可靠公开 HTML action协议时不放“重试”按钮，提示重新悬停或稍后打开。

任何提取、缓存、调度、模型、校验或 Flow异常都只能降级为“原文 + 脱敏提示”或“仅原文”，不得让 Documentation 为空、链接失效、编辑器卡住或反复弹通知。

## 14. 展示与 HTML 安全

初始内容：

```text
IDEA 原生 HTML
────────────────
中文翻译
正在翻译…
```

成功后按“说明、参数、返回值、异常、已弃用、其他”分组。中文不逐句插回原始 DOM，避免破坏不同来源的 JavaDoc结构。加载区保留最小高度；不使用动画、固定宽度、全局 CSS或 Markdown 卡片。

原始 HTML只来自 IDEA provider。模型译文必须 HTML escape；翻译区由 Kotlin固定模板生成。模型不能控制标签、属性、CSS、URL、anchor或 action。占位符恢复后仍以 escaped `<code>` 文本输出。原始 HTML不得交给模型。

`updates(Flow)` 每次 emission发送“原始 HTML + 当前完整中文区”，不只发送新增片段。平台关闭页面后 flow取消，插件不主动访问 UI。

## 15. 设置、隐私与性能

新增应用级设置：

```kotlin
autoTranslateJavaDocumentation: Boolean = false
```

新安装、升级且字段缺失时均为关闭。设置页说明：开启后项目和依赖 JavaDoc中的英文说明会发送到活动模型，可能产生费用；不发送完整源码、方法体、项目路径或凭据。

关闭时：provider不进入增强链，不查 translation缓存、不读 profile/API key、不创建 Flow或请求。Apply关闭后取消所有在途 Documentation订阅；当前已显示中文不强行移除，合法缓存保留。再次开启可命中旧缓存。

首版不新增目标语言、独立模型、延迟、来源过滤、并发或自定义 prompt设置。现有“流式渲染”开关不影响本功能。

必须同步 `PRIVACY.md`：功能默认关闭；可能发送项目/依赖文档自然语言；不发送完整文件/路径；可能产生费用；译文存本地 SQLite；关闭不删除缓存；清空缓存可删除；无遥测；凭据在 PasswordSafe。

性能目标：开关检查 <1ms，常规提取/英文检测 <10ms，初始组合 <20ms，中文组合 <5ms；SQLite走 IO，模型走协程，PSI遵守 read action，Flow emission不持有 PSI read lock，所有耗时操作不在 EDT。

## 16. 安全不变量

1. Java Documentation兼容层不反射、不修改 UI组件、不依赖内部实现包。
2. 原生文档优先；增强失败不得破坏原生 Quick Documentation。
3. PSI pointer、source fingerprint、subscription ID三闸共同阻止迟到结果污染。
4. 模型只收到自然语言 fragment和最小 context，不收到 HTML、完整源码、路径或文档 URL。
5. 模型 JSON严格校验，译文 escape后才能进入 Documentation HTML。
6. 自动翻译默认关闭，必须由用户知情开启。
7. 翻译 schema与 prompt独立版本并进入缓存键。
8. translation参与统一 LRU和清空，不进入现有缓存交换格式。
9. API key与自定义 header只在 PasswordSafe和模型客户端，不进入 target、HTML、缓存或日志。
10. 取消不 retry、不 repair、不写失败缓存；只有 active subscription可接收 update。

## 17. 测试策略

### 17.1 平台兼容契约

- provider只匹配 Java且关闭时不拦截默认行为；
- pointer失效返回空；wrapper委托 presentation/navigation/hint；
- 原始 HTML逐字保留，update发送完整组合 HTML；
- Flow取消后无后续 emission；原始结果为空或异常时安全退出；
- 静态守卫禁止 `.ide.impl.`、反射、UI组件更新和直接 target实现实例化；obsolete provider只允许唯一适配文件。

### 17.2 提取器、检测与组合器

fixtures覆盖项目、JDK、依赖、外部 JavaDoc、主说明、列表、标签、内联 code/link、畸形/超大 HTML及中英混合。断言片段顺序、kind、context、占位符、排除区域和 fingerprint。

组合器断言原 HTML保留、中文只追加一次、所有模型文本 escape、loading/success/error合法且无脚本或事件属性。

### 17.3 模型与安全

Fake OpenAI Server增加固定首行识别的 `documentation-translation` 与 repair请求。覆盖合法响应、缺/重/额外 ID、HTML注入、占位符篡改、原文回显、repair成功/失败、schema/reasoning降级、超时/限流/取消。使用请求记录断言只发送目标 fragment，不含源码、路径、HTML或凭据。

扩展 `SecretIsolationTest`：target、extractor、composer、缓存值和 Documentation HTML均不包含 key/header/base URL；错误信息脱敏。

### 17.4 缓存与调度

从旧 DDL开始测试事务迁移、core/detail保留、幂等和 rollback；断言三 store统一 LRU与清空，导入导出仍只有 core/detail。

调度测试固定新优先级、FIFO、同级 repair插队、不抢占、不占后台槽、共享请求与最后订阅取消。缓存全命中时凭据读取和 fetch计数均为零。

### 17.5 集成与竞态

以 fake native source串联 wrapper → extractor → cache → scheduler → fake model → validator → composer → content update。探针断言首次一次请求、二次缓存命中、并发去重、单订阅关闭不影响其他订阅、最后订阅取消、编辑后旧 fingerprint丢弃、开关关闭零调用、恶意输出不进入 HTML、冷却期间 fetch不增加。

所有异步断言使用请求计数、状态记录、subscription/fingerprint和队列探针，不用固定墙钟。

## 18. 真机验收与门禁

真机验收脚本放 `.superpowers/acceptance/` 且不提交；API key只从环境变量读取，日志显示 `key <masked>`。

IDEA 2025.1验收：项目类/方法/字段、标签、inline code/link、中文/超长/无文档；JDK、带 sources依赖、本地/外部 Javadoc；hover、显式窗口、Tool Window、链接导航、快速切换、编辑后重开、关闭开关、无 profile、断网/超时和明暗主题。

提交前门禁：

```bash
(cd intellij-plugin && npm ci && npm test) \
  && ./gradlew :intellij-plugin:test :intellij-plugin:buildPlugin :intellij-plugin:verifyPluginProjectConfiguration
```

并在 `chrome-plugin/` 运行 `npm test` 与 `npm run docs:drift`；最终按 `AGENTS.md` 对实际改动执行完整门禁。Plugin Verifier重点检查 Java bundled plugin、obsolete/internal API、动态卸载、since-build 251与 IC/IU兼容性。

## 19. 构建、依赖与发布

阶段 A以最小编译探针确定 Gradle bundled Java plugin与 `plugin.xml` 依赖，二者必须同步；只声明最小 Java模块，不依赖 Ultimate-only API。插件 ID保持 `dev.codetui.english-syntax-idea`，正式范围仍为 IDEA Community/Ultimate 2025.1+。

新增 extension point会使升级需要重启，应写入 CHANGELOG。该功能属于 minor feature，发布时按双运行时同版本流程从 1.2.0升至 1.3.0；设计和实现阶段不提前修改版本。

Release notes说明默认关闭、设置入口、发送内容、项目/依赖范围、费用、重启要求、关闭与清缓存方法。Chrome端没有 Java功能，但同一 Release继续附双端产物。

## 20. 文档同步

实现时同步：

- `README.md`：产品范围、设置和使用方式；
- `PRIVACY.md`：JavaDoc外发范围、费用和本地缓存；
- `CHANGELOG.md`：新增功能与升级重启；
- `docs/architecture/overview.md`：Java Documentation运行链路；
- `modules.md`：所有新增源文件；
- `protocol.md`：明确 Java链路不经过 JCEF bridge；
- `model-pipeline.md`：翻译 prompt/schema、提取、repair、缓存和批次；
- `rendering.md`：原文保留、中文区、updates Flow和身份守卫；
- `build-test-release.md`：平台探针、测试矩阵、依赖和回退；
- `invariants.md`：本设计第 16 节硬不变量；
- `AGENTS.md`：重要兼容、安全和测试门禁。

新增源文件必须进入 `modules.md`；在 `chrome-plugin/` 运行 `npm run docs:drift`，不能仅依赖机器测试发现内部逻辑文档漂移。

## 21. 最终验收标准

功能完成必须同时满足：

1. 默认关闭，设置页知情开启后才产生 Documentation翻译请求；
2. 英文 Java Documentation保留原文并自动追加中文，hover、显式窗口和 Tool Window一致；
3. 项目和依赖文档生效；公开 API无法取得的外部异步文档按明确降级处理；
4. 正文和标签说明翻译，签名、代码、参数名、类型和链接不翻译；
5. 原文立即显示，缓存命中不请求模型，相同内容并发去重；
6. pointer、fingerprint和 subscription三闸阻止切换/编辑后的旧结果污染；
7. 关闭最后订阅取消请求，取消不 retry/repair，失败冷却阻止请求风暴；
8. 不发送完整源码、HTML、路径或文档 URL；凭据不进入 HTML、缓存和日志；
9. 恶意或非法模型输出不能生成 HTML或写入缓存；
10. 数据库迁移保留 core/detail，translation统一 LRU但不进入交换格式；
11. 不反射、不修改 UI组件、不依赖内部 Documentation API，Plugin Verifier通过；
12. 阶段 A探针、自动化门禁和 IDEA 2025.1真机矩阵全部通过；若探针失败则停止并重新确认方案 B。

## 22. 参考资料

- IntelliJ Platform Plugin SDK：Documentation  
  https://plugins.jetbrains.com/docs/intellij/documentation.html
- IntelliJ Community 251：`DocumentationTarget`  
  https://github.com/JetBrains/intellij-community/blob/251/platform/lang-impl/src/com/intellij/platform/backend/documentation/DocumentationTarget.kt
- IntelliJ Community 251：`DocumentationResult`  
  https://github.com/JetBrains/intellij-community/blob/251/platform/lang-impl/src/com/intellij/platform/backend/documentation/DocumentationResult.kt
- IntelliJ Community 251：Documentation target routing  
  https://github.com/JetBrains/intellij-community/blob/251/platform/lang-impl/src/com/intellij/lang/documentation/impl/targets.kt
- IntelliJ Community 251：PSI documentation target routing  
  https://github.com/JetBrains/intellij-community/blob/251/platform/lang-impl/src/com/intellij/lang/documentation/psi/util.kt
