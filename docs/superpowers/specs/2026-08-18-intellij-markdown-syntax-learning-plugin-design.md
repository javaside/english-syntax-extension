# IntelliJ IDEA Markdown 英语句法学习插件设计

**日期：** 2026-08-18  
**状态：** 已批准  
**目标平台：** IntelliJ IDEA Community / Ultimate 2025.1 及以上  
**必需依赖：** JetBrains 官方 Markdown 插件、支持 JCEF 的 JetBrains Runtime

## 1. 产品目标

在现有 Chrome 英语句法学习扩展之外，于同一仓库新增一个 Kotlin 原生 IntelliJ IDEA 插件。插件增强 IntelliJ 官方 Markdown 渲染预览：用户主动开始句法学习后，插件识别预览中可见及附近的英文段落，调用用户配置的 OpenAI-compatible 模型，将原段落就地替换为与 Chrome 扩展一致的三层句法卡片，并支持点击成分查看详细解释。

插件不修改 Markdown 源文件。用户暂停时不再派发新请求，停止时取消当前预览的任务并完整恢复官方 Markdown 预览。Markdown 源码继续编辑、预览重新生成后，会话保持运行，未变化的句子从缓存恢复，变化内容按可见区域重新解析。

首版成功标准是：

- 在 IntelliJ IDEA 2025.1+ 的 Markdown 预览中提供稳定、可逆的就地句法阅读体验；
- 模型行为、输出校验、缓存语义和 Chrome 扩展兼容；
- API Key 不进入 JCEF、日志或缓存交换文件；
- 对 JetBrains Markdown 内部 API 的依赖被隔离，并由 Plugin Verifier 与集成测试守护；
- 不为首版引入 Node 运行时、本地共享服务或第二套 Swing 渲染界面。

## 2. 已确认的产品和技术决策

- 首版只增强 Markdown 渲染预览，不在 Markdown 源码编辑器中显示行内提示。
- IntelliJ 插件使用 Kotlin 原生实现，不在 IDE 中运行现有 TypeScript 模型核心。
- 插件放在当前仓库的 `intellij-plugin/` 子项目中。
- 用户通过 Markdown 预览工具栏或 IDE Action 手动开始；打开预览时不自动请求模型。
- 点击开始后，先解析可见区域及上下各一屏，滚动后增量解析。
- 采用就地替换：隐藏原英文段落，在原位置显示三层句法卡片；停止后恢复原文。
- 通过自定义 `MarkdownHtmlPanelProvider` 接管可控的 JCEF 面板，而不是反射或遍历组件树注入官方默认面板。
- JetBrains 官方 Markdown 插件是必需依赖。
- JCEF 不可用时禁用会话并给出明确、可操作的提示，不维护 Swing 回退渲染。
- 首版包含核心句法卡片、流式展示、点击成分详解、暂停、停止恢复、缓存和失败重试。
- 首版不包含详解预载与带自然语言反馈的纠错重分析。
- 模型配置完整沿用 Chrome 扩展的能力：多 Profile、OpenAI-compatible 端点、自定义请求头、超时、连接测试和能力降级。
- Chrome 与 IDEA 各自维护缓存，通过相同的交换文件格式双向导入导出，不直接共享运行时数据库。
- Markdown 编辑导致预览刷新后保持会话运行，自动重扫并复用缓存。
- 首版正式兼容范围为 IntelliJ IDEA Community / Ultimate 2025.1+，不承诺其他 JetBrains IDE。

## 3. 首版范围

### 3.1 包含

#### Markdown 预览

- 自定义 Markdown Preview Provider；
- 工具栏或 IDE Action：开始、暂停/继续、停止并恢复原文；
- 标题、段落、列表项和引用中的英文正文；
- 可见区域及上下各一屏按需解析；
- 滚动增量解析；
- Markdown 编辑后自动重扫；
- 三层句法卡片；
- 流式暂定成分；
- 点击成分懒加载详细解释；
- 单句失败重试；
- 当前文件的进度和错误摘要。

#### 模型、设置与缓存

- 多个 OpenAI-compatible Profile；
- Base URL、模型、API Key、自定义请求头和超时；
- Profile 连接测试；
- JSON Schema、流式和 `reasoning_effort` 能力降级；
- 核心和详解缓存；
- 缓存统计、上限和清空；
- 与 Chrome 扩展双向导入导出缓存。

### 3.2 不包含

- Markdown 源码编辑器中的 Inlay、Code Vision 或行内翻译；
- 非 Markdown 文件；
- PDF、AsciiDoc、HTML Preview；
- 选中文本、右键段落和快捷键局部解析；
- 打开预览后自动开始；
- 详解预载；
- 带自然语言反馈的纠错重分析；
- 跨设备同步缓存或 Profile；
- 非 OpenAI-compatible 原生协议；
- JCEF 不可用时的 Swing Tool Window 回退；
- 对 WebStorm、PyCharm 等其他 JetBrains IDE 的正式兼容承诺。

## 4. 仓库与模块边界

在当前 TypeScript 项目旁新增独立 Gradle 子项目：

```text
english-syntax-extension/
├── src/                              Chrome 扩展，保持现状
├── tests/
├── intellij-plugin/
│   ├── build.gradle.kts
│   ├── settings.gradle.kts
│   ├── gradle.properties
│   ├── src/main/kotlin/.../
│   │   ├── settings/                 Profile、普通设置、PasswordSafe
│   │   ├── markdown/                 Preview Provider、JCEF 面板、生命周期
│   │   ├── bridge/                   JavaScript ↔ Kotlin 协议与运行时守卫
│   │   ├── language/                 分句、分词、领域校验
│   │   ├── model/                    Prompt、HTTP、SSE、流式和能力降级
│   │   ├── cache/                    核心/详解缓存与交换文件
│   │   ├── scheduler/                优先级、并发、重试和取消
│   │   └── actions/                  开始、暂停、继续、停止
│   ├── src/main/resources/
│   │   ├── META-INF/plugin.xml
│   │   └── web/                      预览注入的 JavaScript 与 CSS
│   └── src/test/
└── shared-fixtures/                  跨端契约、教学句和缓存交换样本
```

### 4.1 依赖方向

- `language`、领域模型和缓存键算法不依赖 IntelliJ Platform API。
- `model` 依赖领域模型、配置端口、缓存端口和调度器端口，不依赖 JCEF。
- `bridge` 定义白名单消息类型，连接 Kotlin 会话控制器与 JCEF JavaScript。
- `markdown` 是 JetBrains Markdown/JCEF 适配层，集中承载可能随 IDE 版本变化的 API。
- `settings` 与 `actions` 可依赖 IntelliJ Platform API，但不引用 Markdown 内部实现。
- JavaScript 只负责 DOM 候选识别、可见性观察、可逆渲染和用户点击事件，不持有模型配置、密钥、缓存或最终领域裁决。

### 4.2 跨端共享边界

Kotlin 与 TypeScript 不共享运行时代码，只共享可机器校验的契约：

- 语法角色及中文标签；
- Token 闭区间语义；
- 核心和详解 JSON 结构；
- Prompt 与 Schema 版本；
- 缓存键算法和固定测试向量；
- 缓存交换格式；
- 教学句与合法/非法模型输出 fixture。

根项目增加跨端契约测试，防止两套实现悄悄分叉。两端内部类名、协程模型和存储实现不要求一致。

## 5. Markdown Preview 集成

### 5.1 Preview Provider

插件声明 JetBrains 官方 Markdown 插件为必需依赖，并注册自定义 `MarkdownHtmlPanelProvider`。Provider 使用官方 Markdown 生成的 HTML，但由本插件创建和持有 JCEF 面板，从而稳定掌控：

- `JBCefBrowser` 生命周期；
- 注入脚本和样式；
- `JBCefJSQuery` 双向桥接；
- Markdown HTML 重载；
- 滚动、链接和资源处理；
- 面板销毁时的请求取消与资源释放。

不得通过反射、类名匹配或 Swing 组件树遍历获取官方默认面板内部的 JCEF 实例。

Markdown 预览相关 API 可能不属于最稳定的公共 IntelliJ Platform API。所有此类引用集中在 `markdown/` 包，构建时运行 Plugin Verifier，并在目标 IDE 沙箱执行预览集成测试。

### 5.2 JCEF 可用性

创建面板和启用 Action 前检查 `JBCefApp.isSupported()`：

- 支持时正常创建预览会话；
- 不支持时不注入桥接、不发送模型请求；
- UI 提示用户切换到包含 JCEF 的 JetBrains Runtime；
- 首版不创建 Swing 或 JavaFX 备用渲染器。

JCEF Browser、Client、Handler 和 `JBCefJSQuery` 必须遵守 IntelliJ `Disposable` 生命周期。关闭编辑器或项目时移除处理器并释放资源。

### 5.3 HTML 加载顺序

每次官方 Markdown HTML 首次加载或重新生成时：

1. 加载官方 Markdown HTML；
2. 注入固定版本的句法 CSS 和 JavaScript；
3. 建立 JS Query bridge；
4. 通知 Kotlin 当前预览代次已就绪；
5. 若该文件会话处于运行或暂停状态，恢复控制状态；
6. 运行状态下重新扫描 DOM 并注册可见性观察器；
7. 缓存命中的句子恢复卡片，未命中句子等待进入可见范围。

不得将模型生成文本拼接进 HTML 源字符串。所有模型文本均通过 DOM 文本节点或 `textContent` 渲染。

## 6. 段落识别、分句与稳定身份

### 6.1 Markdown DOM 候选

自动扫描支持：

- `h1`–`h6`；
- `p`；
- `li`；
- `blockquote` 内的叶子正文块。

排除：

- `pre`、`code` 和代码高亮容器；
- 表格；
- 数学公式；
- Mermaid 等图表；
- 脚注定义和脚注导航区；
- 表单、按钮、输入控件、iframe 和可编辑内容；
- 插件自己生成的句法卡片和详解面板。

候选必须在布局中可见、以英文词为主，并在自动扫描时至少包含 20 个可见字符。一个候选只选择安全叶子块，避免同时注册外层引用与内层段落。

### 6.2 可见区域

JavaScript 使用 `IntersectionObserver`，根边距为上下各约一个视口。进入范围的候选才通过 bridge 上报 Kotlin。浏览器不支持观察器时，以节流的 scroll/resize 检查回退。

用户主动点击开始后立即扫描当前 DOM，但不一次性解析整篇文档。滚动后新增可见候选进入队列。

### 6.3 分句与分词

Kotlin 实现与 TypeScript 兼容的英文分句和分词：

- 初始分句遵循英语句子边界；
- 合并 `Mr.`、`Dr.`、`e.g.`、`i.e.`、`U.S.` 等固定缩写误切；
- Token 保存连续整数 ID、原文本、UTF-16 起止偏移、前导空白和标点标记；
- 能无损重建规范化前的句子文本；
- 模型 Prompt 只发送精简的 `{id, text, punctuation?}` Token 载荷。

跨端教学句 fixture 钉住 TypeScript 与 Kotlin 的句子数量、Token 文本和标点标记。

### 6.4 段落和句子身份

运行时身份分为两层：

- 预览代次：每次 Markdown HTML 重载生成新代次，旧代次响应不得写入新 DOM；
- 句子实例 ID：由文件会话 ID、候选顺序/结构路径、句内顺序和规范化文本生成，用于当前预览的版本守卫。

持久缓存键不包含文件或运行时身份，只由规范化句文本、Schema 版本和可选 focus 范围构成。

## 7. 会话与渲染数据流

### 7.1 开始会话

```text
用户点击“开始句法学习”
  → Action 找到当前 Markdown Preview
  → Kotlin 创建或恢复文件会话
  → JCEF 扫描候选并观察可见区域
  → 可见候选文本经白名单 bridge 上报
  → Kotlin 分句、分词、生成句子实例 ID
  → 查询核心缓存
  → 未命中进入模型调度器
  → 流式暂定结果推回 JCEF
  → 完整结果校验并写缓存
  → 原段落就地替换为三层卡片
```

### 7.2 就地替换

- 原 Markdown 节点保留在 DOM 中，仅添加插件专用 `data-*` 标记并隐藏；
- 句法卡片插入原节点之后；
- 卡片使用 Shadow DOM；若目标 Markdown 面板存在无法兼容 Shadow DOM 的限制，允许使用严格前缀的作用域 CSS，但不能向文档添加无前缀通用类；
- 卡片继承原节点的字体、字号、字重、颜色和可用宽度；
- 每个核心成分显示中文角色、英文原文和中文翻译；
- 未覆盖标点按原顺序附着到相邻成分，不创建独立卡片；
- 完整核心结果到达前，原文保持可见；收到安全的流式暂定成分后可提前显示预览卡片；
- 停止时删除卡片、详解和插件标记，恢复所有原节点。

### 7.3 流式结果

```text
OpenAI SSE
  → Kotlin SSE Decoder
  → Core/Detail Stream Parser
  → 暂定结构安全过滤
  → Kotlin 向对应预览代次发送 bridge 回调
  → JavaScript 渲染暂定卡片或详解结构
  → 完整响应到齐
  → Kotlin 最终校验
  → 合法结果覆盖暂定结果并写缓存
```

暂定结果：

- 只用于渲染；
- 不写缓存；
- 不把句子标记为完成；
- 必须先校验角色枚举、Token 边界、顺序、不重叠和危险文本；
- 完整响应非法时撤销暂定卡片并恢复原文或显示可重试错误。

### 7.4 成分详解

用户点击核心成分时，JavaScript 上报：预览代次、句子实例 ID、原句 Token、已验证核心结果和 focus Token 闭区间。

Kotlin：

1. 校验 bridge 消息和当前代次；
2. 查询详解缓存；
3. 未命中时按“成分详解”优先级调用模型；
4. 流式结构可逐项显示；
5. 完整详解通过校验后写缓存；
6. 同一预览同时只展开一个详解面板；
7. 再次点击同一成分关闭面板，不重复请求。

首版不预载详解。

### 7.5 暂停、继续与停止

- 暂停：不再从该预览派发新模型请求；已在飞请求允许完成并可渲染。
- 继续：重新观察并派发当前可见或暂停期间积累的候选。
- 停止：取消该预览排队和在飞请求，关闭详解，删除所有句法节点，恢复原 Markdown 节点，并将会话状态改为 stopped。
- 关闭编辑器：等价于取消该文件全部任务并释放资源，但无须向已经销毁的 DOM执行恢复。
- 关闭项目：取消项目内所有请求，释放协程作用域、HTTP 流和 JCEF 资源。

## 8. Markdown 编辑与预览刷新

Markdown 源码修改会让官方预览重新生成 HTML。插件不得冻结预览，也不得要求用户重新点击开始。

刷新处理：

1. 新 HTML 加载时增加预览代次；
2. 取消或逻辑失效旧代次的排队和在飞任务；
3. 使用约 200ms 的防抖等待本轮预览稳定；
4. 重新注入脚本、扫描候选并恢复观察器；
5. 会话为 running 时继续按可见区域解析；
6. 会话为 paused 时恢复卡片和状态，但不发新请求；
7. 文本未变化的句子使用统一缓存键恢复；
8. 新增或修改句子等待进入可见区域后解析；
9. 旧代次晚到响应必须被 Kotlin 和 JavaScript 双重拒绝。

连续输入期间不得每次 DOM 小变动都启动模型请求。以官方预览完成的一轮 HTML 更新和防抖后的最终 DOM 为准。

## 9. 配置与凭据

### 9.1 Profile

每个模型 Profile 包含：

- 稳定 ID；
- 显示名称；
- Base URL；
- 模型名称；
- 自定义请求头；
- 请求超时；
- `jsonSchemaSupport: unsupported`；
- `streamSupport: unsupported`；
- `reasoningControl: unsupported`。

三个能力位都只持久化否定状态；未记录表示值得尝试。

### 9.2 普通设置

使用应用级 Service + `PersistentStateComponent` 保存：

- Profile 的非敏感字段；
- 当前启用 Profile ID；
- 缓存容量上限；
- 流式渲染开关；
- 各能力否定状态。

设置页使用 Kotlin UI DSL 2。机器相关缓存和凭据不参与 Settings Sync。

### 9.3 敏感信息

API Key 和被标记为敏感的自定义请求头值保存到 IntelliJ `PasswordSafe`：

- 普通 Profile 状态只保存凭据引用；
- Credential key 由插件 ID、Profile ID 和字段用途稳定生成；
- `PasswordSafe` 读写是阻塞操作，必须在 IO 调度器执行，不得阻塞 EDT；
- 更新使用同一 credential key 覆盖；
- 删除 Profile 时删除对应凭据；
- API Key、Authorization 和敏感头值不得进入 JCEF、日志、通知、异常文本或导出文件。

设置页首次保存远程端点时提示：所选英文文本会发送给用户配置的第三方模型服务。

## 10. 模型请求链路

### 10.1 总体流程

```text
句子进入 Kotlin
  → 计算缓存键
  → 缓存命中后重新校验
  → 未命中按端点类型切块
  → 构建紧凑 Prompt
  → 全局优先级调度器
  → OpenAI-compatible HTTP/SSE
  → JSON 解析
  → 领域校验
  → 失败时执行一次结构修复
  → 合法结果写缓存并推送预览
```

### 10.2 分块与并发

- 一次 Preview → Kotlin 核心任务最多携带 6 句；
- 远程端点默认每个实际模型请求 2 句；
- `localhost` 和 `127.0.0.1` 本地端点最多合并 6 句；
- 全局模型请求并发默认 4；
- 同一缓存键在飞时去重；
- 网络类可重试错误最多重试两次；
- 模型结构修复最多一次；
- 批次允许部分成功，一块失败不回滚其他块。

### 10.3 优先级

```text
用户重试
> 成分详解
> 当前活动预览的可见核心解析
> 其他预览的可见核心解析
> 当前预览的附近预取
```

排序键为优先级、同优先级修复插队标记、入队顺序。修复请求只能在原优先级内插队，不能跨优先级抬高。

后台请求不得占满所有槽位，应至少为用户交互或当前活动预览保留一个槽位。已经运行的请求不抢占，只能通过后台并发上限避免饥饿。

### 10.4 请求体和能力降级

默认请求包含：

```json
{
  "model": "...",
  "messages": [],
  "temperature": 0,
  "stream": true,
  "reasoning_effort": "none",
  "response_format": { "type": "json_schema" }
}
```

Provider 明确拒绝某项能力时：

- JSON Schema：记录 `jsonSchemaSupport = unsupported`，移除 `response_format` 后重发；
- 流式：记录 `streamSupport = unsupported`，改走缓冲响应；
- 推理控制：记录 `reasoningControl = unsupported`，移除 `reasoning_effort` 后重发。

能力降级重发不计入普通网络重试次数。三个否定状态写回当前 Profile，避免后续重复试错。

### 10.5 超时和取消

- 缓冲请求：一个超时覆盖完整请求；
- 流式请求：每收到一个内容片段重置静默超时，有持续输出时不设总时长上限；
- 项目、文件会话或预览代次取消时，取消调度队列和 HTTP body 读取；
- 读取循环必须主动监听取消信号，不能只依赖 HTTP 客户端自动传播中止。

### 10.6 Prompt 与序列化

Kotlin Prompt 必须与 Chrome 端共享以下行为：

- 核心、修复、详解和详解修复的首行前缀固定；
- 句子只发送精简 Token 载荷；
- 核心结果、focus、校验错误和待修复 JSON 使用无缩进紧凑 JSON；
- 输出要求单行 JSON、无 Markdown 围栏和额外说明；
- Prompt 版本变化必须同步跨端契约和 Schema 版本策略。

## 11. 输出校验与安全

### 11.1 核心结果

每句必须满足：

- `sentenceId` 属于当前请求；
- 至少一个成分；
- 角色属于固定封闭枚举；
- Token 区间为闭区间且在句内；
- 成分按原文顺序排列且互不重叠；
- 所有非标点 Token 恰好被覆盖一次；
- 纯标点成分在进入最终校验前本地删除；
- 译文去除首尾空白后非空，并受长度上限约束；
- 返回批次不包含请求外句子。

### 11.2 详解结果

- `sentenceId` 和 focus 必须与请求相同；
- 结构区间必须落在原句 Token 范围内；
- 详解不得改变核心成分边界或核心译文；
- 角色说明、翻译、语法点和整体解释受长度限制；
- 缺少可选内部翻译时允许降级为两行标注，但其余结构仍需合法。

### 11.3 危险文本

拒绝包含以下内容的模型文本：

- `<script`；
- `<iframe`；
- `javascript:`；
- NUL；
- 超出字段长度上限的内容。

JCEF 侧仍只使用文本节点渲染。Kotlin 层保留危险文本校验，防止恶意内容进入持久缓存和导出文件。

### 11.4 Bridge 安全

JCEF 被视为不可信消息来源。每类 JS → Kotlin 消息必须：

- 使用封闭联合类型或明确消息类；
- 白名单字段，拒绝额外键；
- 校验插件协议版本、预览代次和句子实例 ID；
- 校验字符串长度、数组数量和 Token 连续性；
- 拒绝 JCEF 传入 Profile、API Key、请求头或任意 URL；
- 只允许 Kotlin 配置层决定模型目标地址。

Kotlin → JavaScript 回调同样带协议版本和预览代次，旧响应不能覆盖新 DOM。

## 12. 缓存与跨端交换

### 12.1 本地缓存

IDEA 插件维护独立于 Chrome IndexedDB 的本地缓存，包含：

- core store；
- detail store。

首版不建立 correction store。

缓存记录保存：

- 类型和键；
- 已校验领域对象；
- 来源 Profile ID；
- 创建时间；
- 最后访问时间；
- 估算字节数。

缓存采用跨 store LRU，默认上限 50 MB，可选 10、50、100、200 MB。缓存属于本机数据，不参与 IDE Settings Sync。

### 12.2 缓存键

核心：

```text
SHA-256(normalizedSentence + schemaVersion)
```

详解：

```text
SHA-256(normalizedSentence + schemaVersion + focusStart + focusEnd)
```

键不包含 Profile、模型、文件路径或 Prompt 版本。读取缓存后必须重新执行领域校验。

Kotlin 与 TypeScript 使用共享固定向量验证相同输入得到完全相同的十六进制键。

### 12.3 交换格式

```json
{
  "format": "english-syntax-cache",
  "formatVersion": 1,
  "schemaVersion": 1,
  "exportedAt": "2026-08-18T00:00:00Z",
  "core": [],
  "detail": []
}
```

交换文件不包含 Profile、API Key、自定义请求头或机器路径。

导入规则：

- 校验格式版本、Schema 版本、键形状和每条领域对象；
- 整份文件先完成结构校验，再开启写事务，避免部分污染；
- 已有键保留本地值；
- 导入完成后统一执行一次 LRU；
- Chrome 导出可由 IDEA 导入，IDEA 导出可由 Chrome 导入；
- 两端测试共同读取固定交换文件 fixture。

## 13. 错误与用户反馈

### 13.1 预览状态

Markdown 预览工具栏显示当前状态和进度，例如：

```text
句法学习：18/24
[暂停] [停止并恢复]
```

完成后显示成功、失败和缓存命中摘要。状态 UI 不遮挡 Markdown 正文。

### 13.2 Profile 级错误

鉴权失败、模型不存在或端点配置无效时：

- 暂停该 Profile 的新模型请求；
- 已有缓存仍可读取和显示；
- 使用 IDE Notification 显示脱敏错误；
- 提供“打开设置”和“测试连接”操作；
- Profile 凭据变化或连接测试成功后解除暂停。

### 13.3 句子级错误

无效模型输出、句子过长或单句请求失败时：

- 原英文保持或恢复可见；
- 在原位置显示轻量错误提示；
- 提供重试按钮；
- 不影响同批其他句子和段落。

### 13.4 预览级错误

JCEF 不可用、bridge 初始化失败或预览销毁时：

- 不继续发送模型请求；
- 清理当前会话；
- 保证官方 Markdown 内容仍可阅读；
- 显示可操作的 IDE 提示；
- 不把异常堆栈直接显示给普通用户。

## 14. 测试策略

### 14.1 Kotlin 单元测试

覆盖：

- 分句、分词、缩写和原文重建；
- 语法角色与中文标签；
- 核心和详解校验；
- 危险文本拒绝；
- Prompt 首行、输出形状和紧凑序列化；
- 缓存键固定向量；
- LRU 和导入导出；
- HTTP 错误映射；
- 三种能力降级；
- SSE 解码和流式解析；
- 调度优先级、去重、重试和取消；
- Profile 持久化与 PasswordSafe 外围服务。

PasswordSafe 测试使用端口替身，不在普通单元测试中访问真实系统钥匙串。

### 14.2 JavaScript 与 DOM 测试

预览 JavaScript 尽量实现为无框架纯模块，覆盖：

- Markdown DOM 候选识别；
- 代码块、表格、公式、图表和脚注排除；
- 可见区域观察；
- 原节点可逆隐藏和恢复；
- 暂定卡片到最终卡片；
- 详解展开与关闭；
- 预览重新加载后的清理和重扫；
- 旧代次响应不得污染新 DOM；
- 模型文本始终作为文本节点处理。

### 14.3 Bridge 契约测试

- 每个消息类型接受合法最小/完整消息；
- 拒绝额外键、未知类型、错误版本、过长字段和畸形 Token；
- Kotlin 与 JavaScript 的消息 fixture 一致；
- API Key 和请求头字段不允许出现在 bridge 协议中。

### 14.4 IDE 集成测试

在 IntelliJ IDEA 2025.1 沙箱中验证：

- 必需 Markdown 插件依赖正确加载；
- Preview Provider 可创建和释放；
- Action 只在 Markdown 预览上下文启用；
- 开始、暂停、继续和停止；
- Markdown 编辑后预览刷新、自动重扫和缓存恢复；
- 关闭编辑器和项目后资源释放；
- JCEF 不支持时的提示；
- 设置页、Profile 切换和 PasswordSafe 流程。

### 14.5 假模型端到端测试

复用与 Chrome 端兼容的本地假 OpenAI 服务器契约，覆盖：

- 核心、修复、详解和连接探测；
- JSON Schema 成功与降级；
- 流式成功、无内容流和缓冲回退；
- `reasoning_effort` 拒绝后的重发；
- 401、403、404、429、5xx、断网、超时和取消；
- 部分成功；
- 非 JSON、Markdown 围栏、Token 越界、重叠、缺口、未知角色和危险文本；
- 缓存命中不发模型请求；
- 密钥不出现在请求记录之外的日志、bridge 或错误 UI。

判断是否真实调用模型使用请求计数和请求记录，不使用固定等待时间。

### 14.6 跨端契约测试

Vitest 和 Kotlin 测试共同读取 `shared-fixtures/`，至少钉住：

- 语法角色和中文标签；
- 错误码；
- 核心与详解 Schema 版本；
- 最大句数和远程/本地分块常量；
- Prompt 首行；
- 缓存键固定向量；
- 缓存交换格式；
- 危险文本样本；
- 教学句分句与 Token；
- 合法/非法模型结果的最终判定。

## 15. 构建、门禁与 CI

Chrome 现有门禁保持不变：

```bash
npm test && npx playwright test && npm run lint && npm run format:check && npm run build
npm run docs:drift
```

IDEA 子项目门禁至少包含：

- Kotlin 单元测试；
- JavaScript DOM/bridge 测试；
- Gradle 插件构建；
- Plugin Verifier；
- IDEA 2025.1 沙箱集成测试；
- Kotlin 格式和静态检查。

根仓库增加跨端契约门禁。CI 拆为三个可并行 Job：

1. Chrome；
2. IntelliJ；
3. Cross-platform contracts。

合并前全部通过。Plugin Verifier 至少验证最低支持版本和当前稳定 IDEA 版本。

## 16. 发布

- IDEA 插件使用独立 Plugin ID 和版本号；
- `since-build` 对应 IntelliJ IDEA 2025.1；
- JetBrains 官方 Markdown 插件为必需依赖；
- 使用 IntelliJ Platform Gradle Plugin 2.x 和 Java 21；
- 构建产出 JetBrains 插件 ZIP；
- 发布前运行完整门禁和 Plugin Verifier；
- 初期通过 GitHub Release 提供 ZIP，稳定后发布 JetBrains Marketplace；
- Chrome 扩展与 IDEA 插件版本号不要求同步；
- 共享 Schema、Prompt 和缓存交换格式必须保持兼容，破坏性变化需要明确提高对应契约版本。

## 17. 首版验收标准

首版完成必须满足：

1. 用户可在 IntelliJ IDEA 2025.1+ 的 Markdown 预览中手动开始句法学习；
2. 仅可见及附近英文段落按需请求，滚动后增量解析；
3. 原文被三层句法卡片就地替换，停止后完整恢复；
4. 点击任一核心成分可加载并显示详解；
5. 流式暂定结果不写缓存、不计完成，完整结果非法时能安全回退；
6. Markdown 编辑并刷新预览后，会话继续，旧响应不污染新 DOM，未变化句子走缓存；
7. 多 Profile、PasswordSafe、连接测试和三种能力降级可用；
8. 核心/详解缓存、容量管理和 Chrome ↔ IDEA 双向导入导出可用；
9. API Key 和敏感请求头不会进入 JCEF、日志、通知或导出文件；
10. JCEF 不支持时不发模型请求，并显示明确提示；
11. 假模型 E2E、IDE 集成测试、Plugin Verifier 和跨端契约测试全部通过。

## 18. 参考资料

- IntelliJ Platform SDK：Embedded Browser (JCEF)  
  https://plugins.jetbrains.com/docs/intellij/embedded-browser-jcef.html
- IntelliJ Platform SDK：Persisting State of Components  
  https://plugins.jetbrains.com/docs/intellij/persisting-state-of-components.html
- IntelliJ Platform SDK：Persisting Sensitive Data  
  https://plugins.jetbrains.com/docs/intellij/persisting-sensitive-data.html
- IntelliJ Platform SDK：IntelliJ Platform Gradle Plugin 2.x  
  https://plugins.jetbrains.com/docs/intellij/tools-intellij-platform-gradle-plugin.html
- IntelliJ Platform SDK：2025 API Changes  
  https://plugins.jetbrains.com/docs/intellij/api-changes-list-2025.html
- JetBrains Markdown 插件依赖说明  
  https://plugins.jetbrains.com/docs/intellij/plugin-dependencies.html
