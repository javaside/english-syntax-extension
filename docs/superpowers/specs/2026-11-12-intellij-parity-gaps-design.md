# IntelliJ 插件功能补齐（对齐 Chrome 扩展）设计

- 日期：2026-11-12
- 状态：待评审
- 依据：`.superpowers/recon/idea-vs-chrome-parity.md`（逐项证据审计）
- 范围：补 6 个缺失 + 修 1 个部分对等；明确不补的项附裁决

## 意图

审计结论：核心阅读体验两端 19 项对等；缺的是排障反馈（真实错误上屏）、纠错闭环、绕缓存重析、缓存互通入口、设置即时性、鉴权失败兜底、纯缓存模式收尾。全部补齐后，Chrome 有的用户价值功能在 IDEA 侧都有对应物。

## 补齐项

### F1 逐句失败原因上屏（S）

`render.ts#friendlyErrorMessage` 把已知 code 一律覆写成笼统文案，真实校验错误（已在 `CORE_ERROR.message` 桥上）只进 IDEA 日志。改法：**仅 `INVALID_MODEL_OUTPUT`** 优先显示桥上原始 message（真实 validator summary——正是 Chrome 侧逐句失败文案的形态）；传输/鉴权类 code（AUTH/MODEL_NOT_FOUND/NETWORK…）**保留** ERROR_TEXT 友好文案（raw message 是 provider/HTTP 原文，直接上屏既看不懂又可能带内部信息——ERROR_TEXT 存在的理由），未知 code 兜底照旧。脱敏在 **AnalysisService 构造 failures 的边界**做（`invalidOutput` 调用点 + settle 回落的 NETWORK_ERROR 兜底，镜像 Chrome SW 边界脱敏；PreviewSession 不持凭据，桥发送层做不了）。

### F2 纠正反馈（M）

对齐 Chrome `REANALYZE_WITH_FEEDBACK` 闭环：
- **桥**：`FEEDBACK_REQUEST {sentenceId, feedback}`（feedback trim 后 1..2000；防伪造门与 CHAT_ASK 同款结构化校验）。纠正是 core 分析的替换——结果复用 **`CORE_RESULT`** 消息（blockId = 句所在块，tokensJson 照带），不新增结果消息。
- **Kotlin**：`AnalysisService.analyzeWithFeedback(input, core, feedback)`——克隆 Chrome `reanalyzeWithFeedback`：单句、首轮 + **至多一轮修复**（`correctionRepairPrompt` 收**平铺** errors——单句无需 RepairErrorGroup 分组，Chrome 亦如此）；相对 Chrome 刻意去掉 correction 缓存读写（裁决见下）。`buildCorrectionPrompt`/`buildCorrectionPromptRepair` 首行为**函数内字面量**，逐字对齐 Chrome 同名 prompt 首行（Chrome 侧本就不在 PROMPT_FIRST_LINES 表——已核实，表恰 5 键——故**零 contracts 变更**）。
- **不写缓存**（裁决）：Chrome 按反馈文本独立缓存键；IDEA 侧 SQLite 无 correction 槽位，加表要动 schema + cache-transfer-v1 双端钉死格式。纠正是一次性探索输入，重复相同纠正概率低——与 chat 同款无缓存取舍。跨端导入导出格式不动。
- **UI**：失败行的「重新解析」旁加「纠正」小按钮 → 卡片下方内联输入行（textarea + 提交/取消，样式复用 chat 面板既有模式）→ 提交发 `FEEDBACK_REQUEST`；等待中禁用。**成功结果经 `applyOutcome` 落账**（`record.core` 更新 + READY 相位 + SESSION_STATE——Chrome 同款 `located.sentence.core = corrected`；手发消息不更新记录会让后续 detail/chat 对着过期成分讲）；随后按既有 CORE_RESULT 路径重画。**失败绝不走 CORE_ERROR**（那会把句卡片打成失败行、抹掉已核实的划分——Chrome 的纠正失败也不动卡片）：错误回内联输入行（chat-panel 的 CHAT_ERROR 同款形态），message 按 F1 口径（INVALID_MODEL_OUTPUT 显示真实 summary）。原句失效（记录无 core）回笼统提示。

### F3 重新解析全部段落（绕缓存）（M）

Chrome `REANALYZE_VISIBLE` 的 IDE 等价物（IntelliJ 无视口概念，全量扫描本就一次上报）：
- **Tools Action**「重新解析全部段落（绕过缓存）」：仅 RUNNING 可用（stopped 拒，对齐 Chrome）。
- `PreviewSession.reanalyzeAll()` 的可建机制（评审 B5 钉死）：① record invalidate（phase→STALE、core 清空——`registerFresh` 会重派 STALE 句）；② `blockRequester.requestScan()` 重驱 initialize（**同 generation**；指纹重置让页面重新上报 VISIBLE_BLOCKS，requesting 竖条由此重闪——这就是「web 无新消息」成立的原因）；③ **会话级 bypassCache 标志**插进 `onVisibleBlocks → dispatch` 路径（该路径现状不带 bypass，只有 dispatchRetry 带）——reanalyzeAll 置位一次、消费后复位；换代/停止守卫照常。READY+FAILED 一并重派。
- web 侧无新消息（重派走既有 CORE_RESULT/CORE_ERROR）。

### F4 缓存导入/导出入口（S）

`CacheTransfer.kt`（exportJson/importCacheFile）与双端契约测试已就绪，只差 UI：`EnglishSyntaxConfigurable` 加「导出缓存…」「导入缓存…」两按钮 → `FileChooser`（导出 save/导入 open，json 过滤）→ 后台线程执行 IO → 结果 balloon（`已导入 N 条，跳过 M 条` / `已导出 N 条`）。EDT 只做对话框，IO 不占 EDT。

### F5 profile 切换即时生效（S）

`PreviewSessionManager.refreshProfile()` 已实现但无调用方。`ProfileRepository.setActive`（设置页「启用」/Configurable.apply 路径）后调 `PluginServices` 拿 manager → `refreshProfile()`。已开会话的新请求即用新 profile。

### F6 AUTH_FAILED 暂停 + 缓存兜底（S–M）

对齐 Chrome `pauseProfile` 语义：
- Kotlin 侧内存暂停表（profile id → 凭据指纹）；请求结果 AUTH_FAILED 时记入。
- dispatch 前查表：命中 → 整批回落 `lookupCore` 纯缓存 + 未命中句标失败带 `AUTH_FAILED` 文案（命中句照常渲染，键与模型无关——Chrome 同款「换/修模型前译文不消失」）；不再发模型请求。
- 凭据指纹变化（`setActive`/profile 保存时比较）自动解除；「测试连接」成功也解除（对齐 Chrome TEST_PROFILE 解除暂停）。
- detail/chat 的暂停分支是**新接线**（现状无暂停概念）：detail 命中缓存照回、未命中报 AUTH_FAILED（对齐 Chrome paused-detail）；chat 直接 CHAT_ERROR。

### F7 纯缓存模式收尾与措辞（S）

`PreviewSession` cacheOnly 分支：未命中句不再置 FAILED 静默。终态 `SESSION_STATE` 必须**累计会话计数**（`counts.ready/discovered`——现状发的是本批计数，多批会话下 web 的 `ready+failed>=discovered` 永不满足、浮层卡死，正是要修的 bug）；miss 句保持原文（对齐 Chrome `skipped` 语义，不计 failed）。web 浮层加 `state === "cacheOnly"` 专属分支：显示「✓ 缓存命中 x/y 句」并淡出，**绕过**通用 allSettled 公式（协议形状已够：state 自由字符串、failed 可选——零协议变更）。

## 明确不补（裁决）

| 项 | 理由 |
| --- | --- |
| 详解预载（A12） | L；token 成本数倍；需动 contracts 钉死的调度枚举；IDE 点击延迟可容忍 |
| 选中文本解析（A6） | 与 Alt+T 悬停解析重叠度中高；等真实诉求 |
| 诊断流（A14） | 面向网页异构 DOM 的设计；Markdown 预览失败原因集中（英文占比/长度/无 profile），现有错误文案+F1 后 balloon 场景已覆盖 |
| 右键「解析此区域」（A7） | Alt+T 已等价可达 |
| 视口按需入队（B10） | 有意简化（JCEF 几何不可靠的既有真机教训）；Markdown 文档长度现状可接受 |

**附带**（Chrome 侧文档漂移，顺手修）：`overview.md` §3 手势表仍列 popup「重新解析可见段落」，但 `popup.ts` 已无此按钮——查证后改文档。

## 约束

- **零 shared-fixtures / contracts / PROMPT_FIRST_LINES / ErrorCode 变更**（correction 首行函数内字面量；FEEDBACK_REQUEST 是 IntelliJ 桥自有消息）。
- 桥四地同步（BridgeProtocol ↔ bridge.ts ↔ Connector/Session ↔ bootstrap/render）对新消息 FEEDBACK_REQUEST 适用；CORE_RESULT 复用不加键。
- 门禁：`(cd intellij-plugin && npm ci && npm test && npm run bundle-web)`（bundle.js 提交）+ 仓库根 gradle 三任务；动了 docs 后 chrome `npm test`（architecture-docs 钉 modules/protocol 清单）。
- Action/设置 UI 遵循 EDT 规矩（IO 后台）；新文件进 modules.md。

## 留给 builder

- 内联纠正输入的具体 DOM/CSS（复用 chat-panel 视觉语汇即可）。
- F6 暂停表放 PluginServices 还是 AnalysisService 伴生（倾向前者，生命周期与 manager 对齐）。
- F4 FileChooser 的具体 API（idea-open-file / FileSaverDescriptor）。

## 尺寸

项目级：桥 1 新消息 + Kotlin 服务 2 方法 + 2 Action + 设置 UI + web 输入行/措辞 + 6 组测试 + bundle + 文档。估 4–5 任务。
