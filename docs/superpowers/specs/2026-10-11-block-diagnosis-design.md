# 段落诊断（为什么这段没被翻译）设计

- **日期**：2026-10-11
- **范围**：`chrome-plugin/` 单端（`content/` + `background/` + `shared/protocol.ts` + 提示词 + 假服务器 + 文档）
- **起因**：用户报告——遇到某段文字识别不出段落、因而没有译文时，缺少可用信息；希望选中该段后能问大模型「为什么翻译不了」，把结论交给 code-tui 一类开发 agent 去修
- **前置阅读**：`AGENTS.md`、`docs/architecture/protocol.md`、`docs/architecture/rendering.md`、`docs/architecture/model-pipeline.md`、本 spec 第 1 节的现状调研（全部带文件行号）

## 0. 一句话

把「这段为什么没被翻译」变成一份**可复制的结构化报告**：本地按生产判定链逐门复算并给出**当时取值**，再让模型基于这份证据解释并给修复建议。判定必须复用生产函数，绝不复制一份——报告是要拿去改代码的，它不能撒谎。

## 1. 现状调研（设计依据）

### 1.1 「翻译不了」的原因几乎全在本地，模型看不见

| 判定 | 实现 | 今天是否留下原因 |
| --- | --- | --- |
| 自动清单 14 种排除原因 | `content/page-inventory.ts:35-49`、`classifyExclusion:425-467`、`scientificExclusion:400-419` | 有 `ReadableUnit.exclusionReason`（`page-inventory.ts:51-58`），但 `scanDocument` 投影时**丢弃**（`document-scanner.ts:32-36`），文件头明写「不进入 SW/JCEF 协议」（`page-inventory.ts:9-11`） |
| 显式手势能否解析 | `document-scanner.ts:44-60` | **只 `return null`，不带原因** |
| 安全门 / 英文占比 / 短块门 | `page-inventory.ts:195-203`、`:222`、`:224-225`（阈值 `:165` ≥0.6、`:88` = 20 字符） | 判完即弃，中间值不外露 |
| 分句 / 分词 | `language/segmenter.ts` | 结果只在会话内存在，页面无出口 |
| 超长句 | `session-controller.ts:178`（2000 规范化字符） | 只在失败句可见 |

结论：**只把选中文字丢给模型，模型只能瞎猜**——它看不见扩展的门、阈值与选择器表。诊断的价值主体是本地证据。

### 1.2 用户今天能看到的反馈

- 唯一页面级反馈是右下角进度胶囊（`content/progress-pill.ts:13-16`，`position: fixed; right:16px; bottom:16px`）。
- 「没被识别」时**页面上什么都没发生**：没有竖条（`block-activity-marker.ts` 只给已登记块打标）、没有文案、控制台无输出（全 `src/` 无 `console.*`）。
- `nearestSafeBlock` 拒绝时只有显式手势的一条中文文案（`session-controller.ts:145-172`），经 `content-script.ts:455-457` 走胶囊——**只说「未找到可解析的段落」，不说为什么**。
- 一个自动块都没有时胶囊永久停在「句法解析中…」（完成要求 `settled > 0`，`shared/protocol.ts:108-111`）。

### 1.3 入口与复制的现状

- 右键菜单三项：`service-worker.ts:862-871` 注册、`:920-946` 处理。选区文字来自 `info.selectionText`（页面拿不到），落点 DOM 来自页面侧 `contextmenu` 监听记录的 `contextTarget`。
- **`recordContextTarget` 只在 `state !== "stopped"` 时记录**（`session-controller.ts:1039-1041`）——而「识别不出段落」的用户多半没启动会话，那时落点是空的。这是新入口必须绕开的坑。
- 页面侧没有任何复制能力（全仓 `clipboard` / 复制按钮零命中）；卡片文本在 open shadow root 内且成分是 `<button>`，所以「拖选卡片文字」这条路成本高、不采用。

## 2. 设计

### D1 入口与落点记录

右键菜单新增第四项，`contexts: ["page", "selection"]`，id `DIAGNOSE_MENU_ID`，title「诊断：这段为什么没解析」。

- SW 分支照 `SELECTION_MENU_ID` 分支写（`service-worker.ts:920-938`）：`activeTabs.get(tabId)?.documentId ?? generatedDocumentId(tabId)` → `inject(tabId)` → 记账 → `sendPageCommand({ type: "DIAGNOSE_BLOCK" })`。
- **不要求会话非 `stopped`**（对比「解析此区域」`service-worker.ts:940-946` 会拒）：诊断是只读的，未启动会话恰恰是常见情形。
- 页面侧：诊断自己维护**始终生效**的 `contextmenu` 落点记录（不复用 `SessionController.contextTarget`，它的记录条件受会话状态约束）。落点优先级：选区锚点（`getSelection().anchorNode` 的 `parentElement`）→ 右键落点元素 → `document.body`。三者都记进报告，便于判断用的是哪一个。
- 菜单项对 `chrome://` 等不可注入页面静默失败（既有 `commands` 分支的处理方式，`service-worker.ts:912-914`）。

### D1.5 时序：方向相反的两条消息，各自命名

诊断要同时用到两侧能力：DOM 判定只能在页面算，模型只能在 SW 调。所以有**两条方向相反**的消息，名字必须不同：

| 消息 | 方向 | 作用 |
| --- | --- | --- |
| `DIAGNOSE_BLOCK` | SW → content（页面命令） | 纯触发。像 `PARSE_*` 一样返回 `ack(request)` |
| `EXPLAIN_DIAGNOSIS` | content → SW（模型请求） | 携带本地证据，要回 `DIAGNOSIS_RESULT` |

流程（页面侧是主动的一方，SW 只负责触发与调模型）：

1. SW `contextMenus.onClicked` 命中 `DIAGNOSE_MENU_ID` → `sendPageCommand({type: "DIAGNOSE_BLOCK"})`。
2. content `ContentScriptRouter.route` 的 `case "DIAGNOSE_BLOCK"`：取落点（D1 的优先级）→ 跑 `diagnoseElement()` → **立即 `panel.show(evidence)`**（本地证据不等模型）。返回 `ack(request)`。
3. 同一步里用 `ChromeRuntimeTransport.send()` 发 `EXPLAIN_DIAGNOSIS`（带证据）→ 收到 `DIAGNOSIS_RESULT` → `panel.update(model / modelError)`。
4. 若 `EXPLAIN_DIAGNOSIS` 失败（无 profile、超时、模型非法输出），面板保留本地段并显示 `modelError`。

`EXPLAIN_DIAGNOSIS` 是**出站**请求，但 `RequestMessage` 联合是双向校验的载体，所以要把 `content-script.ts:350-356` 那段「入站即拒」的显式列表一并加上它（该列表今天收 `ANALYZE_CORE` / `ANALYZE_DETAIL` / `REANALYZE_WITH_FEEDBACK`），让误入站的诊断请求返回 `invalidMessage()` 而不是掉进 `default`。

### D2 证据采集：新增只读诊断出口

新增 `chrome-plugin/src/content/block-diagnosis.ts`，导出：

```ts
export function recordDiagnosisTarget(event: Event): void   // content-script 在 capture 阶段装配
export function currentDiagnosisTarget(): Element | null
export function diagnoseElement(target: Element | null, selectionText?: string): BlockDiagnosis
export function formatDiagnosisReport(diagnosis: BlockDiagnosis, model?: DiagnosisExplanation, environment?: DiagnosisEnvironment): string
```

落点记录由 `content-script.ts` 在 `installHoverTracker(document)` 旁边一起装配（`contextmenu` 捕获监听），**与 `SessionController` 无关**，因此不受会话状态影响（D1 那个坑）。

**判定只调用生产函数，绝不复制判据。** 为此在 `page-inventory.ts` 新增一个只读出口：

```ts
export interface CandidateGateResult { gate: string; ok: boolean; value?: string | number }
export function explainElement(element: Element): CandidateGateResult[]
```

它逐门返回结果与当时取值，内部**复用今天私有的** `isSafeElement` / `baseEligibleText` / `scientificExclusion` / `selectPrincipalRoot` / `isEnglishDominant` / `isBlockCandidate` / `hasBlockChild` / `isRenderedBlock` / `isLayoutVisible` / `excludedRegionAncestor`。门名与取值均为稳定字符串，进报告。**不得改变生产路径的行为**——纯新增导出。

`BlockDiagnosis` 的字段（全部来自生产函数）：

| 字段 | 来源 |
| --- | --- |
| `target`：标签名、类名、`id`、选择器路径、截断 200 字 `outerHTML` | 诊断模块（`outerHTML` 先经脱敏） |
| `inventory`：是否为 unit、`kind`、`automatic`、`exclusionReason` | `inventoryReadableUnits(document)` |
| `explicit`：`nearestSafeBlock(target)` 是否命中、命中元素的路径 | `document-scanner.ts` |
| `gates[]`：逐门 `{gate, ok, value}` | `explainElement` |
| `text`：长度、字母词数、英文占比数值（并列 0.6 阈值）、短块门阈值 20 | `normalizedReadableText` + `page-inventory` 判据 |
| `segmentation`：句数、每句字符数、分词 token 数、空句标记 | `segmentBlock` / `tokenize` |
| `requestFeasibility`：单句最大规范化字符数与 2000 阈值对比、批上限（loopback 6 / 云端 2） | `session-controller.ts:178`、`shared/protocol.ts:27`、`analysis-service.ts:48-53` |
| `session`：会话状态、该块是否已登记、句数与失败句 `code: message` | `SessionController` 只读快照（新增只读方法） |
| `page`：URL（**去 query / fragment**）、`document.readyState` | 诊断模块 |

「识别了但失败」（失败句、超长、校验不过）与「压根没识别」（`exclusionReason`、门拒绝）在报告里是**同一段证据的两个分支**，由上述字段自然覆盖，不需要两条路径。

### D3 协议：三层同步，但不牵动 Kotlin

- 新增 `DIAGNOSE_BLOCK`（页 → SW，携带 `BlockDiagnosis`）与 `DIAGNOSIS_RESULT`（SW → content，回显 `diagnosis` + `model?` / `modelError?`）。
- 三层照 AGENTS.md 规矩同步：① `shared/protocol.ts` 的类型联合 + `isRequestMessage`（`:289-368`）case；② `service-worker.ts` 的 `route()` switch（`:415-852`，漏加由 `:851-852` 的 `assertNever` 编译期拦住）；③ `content-script.ts` 的 `isRuntimeResponse`（`:164-210`）加 case——**漏 case 会把 SW 的成功响应静默替换成 ERROR**（历史事故，见 `protocol.md:141`）。
- **不新增 `ERROR_CODES`**：无可用 profile 复用 `CONFIG_MISSING`；模型调用失败按现有码回（`REQUEST_TIMEOUT` / `INVALID_MODEL_OUTPUT` / `NETWORK_ERROR` / `RATE_LIMITED` …）。理由：`ERROR_CODES` 被 `shared-fixtures/contracts.json` 与 Kotlin `SharedContractTest.kt:61` 双侧钉住，加一个码就要同步 Kotlin，而本批范围是 Chrome-only。
- **不升 `MESSAGE_VERSION`**：additive 变更，`protocol.md:304` 有先例（外部消息结构不变则不升）；旧页面残留的旧 content script 不会发新消息。
- **不升 `CORE_PROMPT_VERSION` / `DETAIL_PROMPT_VERSION`**：诊断是独立提示词，不进 core/detail 缓存键。（本批不改分词，不触发「同时升两条版本」那条约定。）
- **不缓存**：诊断结果与页面实例绑定、一次性，不进 `STORE_NAMES`（`analysis-cache.ts:7`），不动 `DATABASE_VERSION`。
- **调度**：复用 `detail-click` 档（`request-scheduler.ts:84-90`）——语义同为「用户点击后正在等待」，优先于全部 prefetch；优先级表与其 doc/test 钉死一行不改。
- SW 侧必须脱敏：请求/日志走既有 `sanitizeProviderError` 等路径，报告里的 DOM 片段经 `block-diagnosis.ts` 的脱敏（去 `value` / `checked` 等表单内容属性）。

### D4 提示词与模型输出

- 新 `buildDiagnosisPrompt(diagnosis)`（`background/prompts.ts`），首行是**新前缀**，且必须同步加进假服务器 `detectKind`（`tests/support/fake-openai-server.ts:75-94`），否则该类请求落到 `unknown`、E2E 一片红（AGENTS.md 明写「改 prompt 首行 = 破坏 E2E」）。
- 输出走 `writeContent`（`fake-openai-server.ts:671-683`）——AGENTS.md 红线，任何模型内容都不能直接 `response.end`。
- 提示词内容要点：说明「你收到的是一份本地判定门的证据（gate 名、当时取值）；哪一门取值越界就是最可能的原因」，并要求返回小 JSON：

```json
{ "likelyCause": string, "explanation": string, "suggestions": string[] }
```

- 证据与文本一律走 `prompts.ts` 的 `serialize`（紧凑不缩进），不自己 `JSON.stringify(..., null, 2)`。
- SW 侧校验**只做形状**：三个字段存在、类型正确、非空、长度上限、`suggestions` 元素为字符串。**不进 grammar / 译文门、不占 core repair 配额、不做第二轮**；不符就丢 `modelError: INVALID_MODEL_OUTPUT`，本地段照常展示。
- 无 profile / 无 key：**不发请求**，`modelError: CONFIG_MISSING`。

### D5 面板与复制

新增 `chrome-plugin/src/content/diagnosis-panel.ts`（host + open shadow root，与 `learning-block.ts` / `progress-pill.ts` 同款隔离方式）：

- **固定右下角**：`position: fixed; right: 16px; bottom: 64px`（胶囊占 `right/bottom: 16px`、约 40px 高，64px 让两者不叠压）；`pointer-events: auto`（可交互，与胶囊的 `none` 不同）；`z-index: 2147483647`（胶囊是 `2147483646`，面板必须盖在它之上）。
- 结构：标题（「这段为什么没被翻译」）+ 关闭按钮 + 「本地判定证据」段 + 「模型解释」段 + 「复制诊断报告」按钮 + 顶部隐私提示（报告含页面 URL 与截断 HTML，粘贴到外部工具前请自查）。
- 复制：`navigator.clipboard.writeText(report)` → 失败（或非安全上下文）则展开一个**已全选的只读 `<textarea>`**，提示「按 ⌘C / Ctrl+C 复制」。textarea 放在 shadow root 内、不是 `<button>` 内，因此可选可复制（这是不依赖剪贴板权限的兜底）。
- 重复诊断：同一页面只保留一个面板实例，再次诊断就地更新内容（不叠加）。
- 模型段按状态渲染：加载中 / 有结果 / `modelError`（显示错误码与中文说明，本地段不受影响）。
- 页面布局纪律（`rendering.md` 记录过两条真机事故）：面板必须 `position: fixed` 且不改动任何页面元素的样式或 class——不重演「给原文加 class 让 `BlockReplacement` 误判」与「用 `border-left` 推挤文字」那两个坑。

### D6 报告格式（给 code-tui 的输入）

结构化 markdown，固定小节顺序，便于 agent 解析：

1. **概述**：一句话结论（命中哪一门 / 已在会话中失败 / 均可解析）。
2. **页面与落点**：URL（去 query / fragment）、落点来源（选区锚点 / 右键落点 / body）、选择器路径、截断 `outerHTML`。
3. **本地判定证据**：逐门表格 `门 | 结果 | 当时取值`。
4. **分句与请求可行性**：句数、最长句字符数 vs 2000、token 数、批上限（loopback 6 / 云端 2）。
5. **会话状态**：state、该块是否已登记、失败句列表（`code: message`）。
6. **模型解释**（若有）：`likelyCause` / `explanation` / `suggestions`；否则写 `modelError` 及成因。
7. **环境**：扩展版本（`manifest.version`）、当前 profile 的模型名、时间戳。

### D7 明确不做

- 不做「拖选卡片文字 → 触发」（卡片文本在 shadow root 内、成分是 `<button>`，成本与风险都高）。
- 不做快捷键（右键菜单已覆盖；第二组 `commands` 会与 Alt+T 靠得太近易误触）。
- 不做历史记录 / 扩展页列表 / 导出文件。
- 不做 IntelliJ 端（桥协议、Kotlin 扫描器与面板都不动）。
- 不新增 error code、不升 `MESSAGE_VERSION`、不新增缓存 store、不新增调度档位。

## 3. TDD 顺序

1. **`page-inventory.ts` 的 `explainElement`**：先写测试——对 14 种 `exclusionReason` 各造一个元素，断言 `explainElement` 给出的门与 `inventoryReadableUnits` 的 `reason` **逐一致**（这是防「诊断逻辑漂移」的核心断言；复用 `page-inventory.test.ts` 的 fixture 与断言风格）。再实现纯新增导出。
2. **`block-diagnosis.ts` 的采集**：断言文本度量（英文占比数值、短块阈值）、分句/分词、请求可行性字段；断言 `gates[]` 覆盖到具体门名。
3. **`formatDiagnosisReport`**：断言七个小节齐全、URL 已去 query / fragment、`outerHTML` 已截断并脱敏。
4. **协议三层**：`protocol.test.ts` 加 `DIAGNOSE_BLOCK` / `DIAGNOSIS_RESULT` 的守卫用例（正例 + 每类非法载荷）；`service-worker.test.ts` 加路由用例（含无 profile → `CONFIG_MISSING`、模型失败 → `modelError`）；`content-script` 侧加 `isRuntimeResponse` case 的用例（含「漏 case 会变 ERROR」的反向断言）。
5. **提示词**：`prompts.test.ts` 钉首行、证据序列化形态（紧凑，`/\n {2}"/` 断言）、三个输出字段的要求；`PromptsTest`-式的双端一致性**不涉及**（Chrome-only）。
6. **假服务器 + E2E**：`detectKind` 加 `diagnosis`；两条用例——①右键诊断 → 面板出现 → 用 fetch 探针断言真的发了请求 → 报告含模型解释；②无 profile → 只出本地段 + `CONFIG_MISSING`。
7. **面板**：`diagnosis-panel.test.ts` 渲染 + 复制成功 / 降级到 textarea 两条。
8. **文档**：`protocol.md`（两个新消息 + `DIAGNOSE_BLOCK` 的门列表）、`rendering.md`（面板与布局纪律）、`model-pipeline.md`（诊断提示词、调度档位、不缓存）、`modules.md`（新文件）、`invariants.md`（新增一条：诊断必须复用生产判定，不得复制判定）。

## 4. 验收标准

- 对「14 种排除原因」中的每一种，报告都指出对应的门与取值，且与生产判定一致（第 3 节第 1 项的单测即验收）。
- 用户报告的那类情形（段落没被识别、右键诊断）能在页面上拿到报告，报告含 URL / 选择器 / 逐个门的取值 / 模型解释，且可一键复制。
- 无 API key 时不发请求、不报错，仍给出完整本地证据。
- 诊断不改变任何现有行为：不写缓存、不动 core/detail 版本、不影响会话相位、不新增错误码。
- 门禁：`npm test`、`npx playwright test`、`npm run lint`（仍恰好 1 个既有基线错误）、`npm run format:check`、`npm run build` 全过；`npm run docs:drift` 无未处理项。

## 5. 待观察（不进本批）

- 报告里的模型解释质量是否稳定（同一证据两次调用是否给出一致原因）——先靠真机手工看几条，不盲加校验。
- 是否值得把诊断入口从右键扩展到「失败卡片的重新解析按钮旁」，让「识别了但失败」也能一键诊断。本批先只做右键。
- IntelliJ 端若要复用，需要先把 `BlockDiagnosis` 的形状下沉成共享契约（届时 `MESSAGE_VERSION` 与 Kotlin 同步才成为真问题）。
