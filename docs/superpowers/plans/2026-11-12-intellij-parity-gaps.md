# IntelliJ 功能补齐 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐审计（`.superpowers/recon/idea-vs-chrome-parity.md`）认定的 6 缺失 + 1 部分对等：真实错误上屏（F1）、纠正反馈（F2）、绕缓存整屏重析（F3）、缓存导入导出 UI（F4）、profile 切换即时生效（F5）、AUTH_FAILED 暂停兜底（F6）、cacheOnly 收尾措辞（F7）。

**Architecture:** F1/F7 是 render/Session 小修；F2 走桥新消息 FEEDBACK_REQUEST + Kotlin `analyzeWithFeedback`（克隆 Chrome `reanalyzeWithFeedback`）+ web 内联输入行；F3 是会话级 bypassCache 标志 + requestScan 重驱；F4/F5 是设置/接线一行级；F6 是 Kotlin 侧暂停表 + dispatch 回落。

**Tech Stack:** Kotlin（IntelliJ Platform）+ web TS（vitest，bundle.js 提交）。

**Spec:** `docs/superpowers/specs/2026-11-12-intellij-parity-gaps-design.md`（含评审钉死的六处机制，执行者必须读）。

## Global Constraints

- worktree `.worktrees/ij-parity`（分支 `ij-parity`）；提交信息中文主题；每任务一提交。
- **零 shared-fixtures / contracts.json / PROMPT_FIRST_LINES / ErrorCode 变更**。correction prompt 首行为 Kotlin 函数内字面量，逐字 = Chrome `correctionPrompt`/`correctionRepairPrompt` 首行（先抄准再写测试钉）。
- 桥四地同步对 FEEDBACK_REQUEST 适用（BridgeProtocol ↔ bridge.ts ↔ Connector/Session ↔ bootstrap/render）；CORE_RESULT 复用不加键。
- F2 成功必须经 `applyOutcome` 落账（record.core 更新）；**失败绝不走 CORE_ERROR**（回内联输入行）。
- F1 只有 `INVALID_MODEL_OUTPUT` 上屏真实 message；传输/鉴权 code 保留 ERROR_TEXT；脱敏在 AnalysisService 构造 failures 的边界。
- F3 = invalidate(STALE/core=null) + `blockRequester.requestScan()`（同 generation）+ 会话级 bypassCache 标志插进 onVisibleBlocks→dispatch 路径（一次性消费）。
- F7 终态 SESSION_STATE 用**累计** counts；web `cacheOnly` 分支绕过 allSettled。
- F6 指纹 = `[baseUrl, apiKey, model, sorted headers]`（对齐 Chrome service-worker.ts:340-346）；凭据变更/测试连接成功解除；detail/chat 暂停分支是新接线。
- 门禁：`(cd intellij-plugin && npm ci && npm test && npm run bundle-web)`（bundle 提交）+ 仓库根 `./gradlew :intellij-plugin:test :intellij-plugin:buildPlugin :intellij-plugin:verifyPluginProjectConfiguration`；动 docs 后 `cd chrome-plugin && npm test`。Action/设置 UI 守 EDT 规矩（IO 后台）。

## Review Focus

1. 纠正失败误毁有效卡片（B2）——测试钉「失败后卡片仍在、输入行显示错误」。
2. 纠正成功不落账（B3）——测试钉 detail/chat 读到新 core。
3. F3 bypass 标志静默失效（B5）——测试钉重析后模型被再次调用（FakeServer 计数）且缓存命中不再短路。
4. F7 批计数卡死（B6）——多批 cacheOnly 会话浮层收尾测试。
5. F6 暂停不解除/解除不及时——凭据变更与 TEST 成功两条解除路径测试。
6. F1 走私 provider 原文上屏——传输 code 仍走 ERROR_TEXT 的负向测试。

---

### Task 1: F1 真实校验错误上屏 + F7 cacheOnly 收尾（web/Session 小修）

**Files:**
- Modify: `intellij-plugin/src/main/kotlin/.../analysis/AnalysisService.kt`（invalidOutput 两处调用点 + settle 回落 NETWORK_ERROR 兜底的 message 过 `redactSecrets`——secrets 经 `client.secretsFor(profile)`，chat 先例 :389）
- Modify: `intellij-plugin/src/main/kotlin/.../session/PreviewSession.kt`（cacheOnly 分支 :307-325：miss 句置 **`SentencePhase.STALE`**——保持原文渲染、不计 failed、可被 registerFresh 重派（留 DISCOVERED 会永久滞留,配好 profile 后的重扫救不回来）；发**累计 counts** 终态 SESSION_STATE、state="cacheOnly"）
- Modify: `intellij-plugin/src/main/resources/web/render.ts`（failure 行：code==INVALID_MODEL_OUTPUT 且 message 非空 → 显示原 message；否则 ERROR_TEXT 兜底）
- Modify: `intellij-plugin/src/main/resources/web/bootstrap-entry.ts`（浮层 `state==="cacheOnly"` 分支：「✓ 缓存命中 x/y 句」淡出，绕过 allSettled 公式）
- Test: AnalysisServiceTest / PreviewSessionTest / render.test.ts / bootstrap-lifecycle.test.ts

**Interfaces（后续任务无依赖，本任务自洽）**
- [ ] Step 1: 写失败测试——① Kotlin: invalidOutput 的 message 含密钥片段时被脱敏；② Kotlin: cacheOnly 多批（>6 句两批）终态 = 累计 counts、miss 句置 STALE（非 FAILED、非滞留 DISCOVERED——重扫可重派）；③ web: INVALID_MODEL_OUTPUT 行显示原 message；AUTH_FAILED 行仍显示 ERROR_TEXT 文案（负向）；④ web: cacheOnly SESSION_STATE → 浮层「✓ 缓存命中 x/y 句」并淡出（多批下不再卡 x/y）。
- [ ] Step 2: 确认红（gradle + npm 按任务范围）。
- [ ] Step 3: 实现（照 spec F1/F7 的评审钉死机制）。
- [ ] Step 4: 确认绿 + `cd intellij-plugin && npm test`、gradle 全量。
- [ ] Step 5: `git commit -m "真实校验错误上屏与纯缓存模式收尾措辞"`

### Task 2: F2 桥消息 + Kotlin analyzeWithFeedback

**Files:**
- Modify: `intellij-plugin/src/main/kotlin/.../bridge/BridgeProtocol.kt`（FEEDBACK_REQUEST {sentenceId, feedback}：feedback trim 1..2000，防伪造门同 CHAT_ASK 风格）
- Modify: `intellij-plugin/src/main/resources/web/bridge.ts`（类型 + 键表 + parse）
- Modify: `intellij-plugin/src/main/kotlin/.../model/Prompts.kt`（buildCorrectionPrompt/buildCorrectionPromptRepair——首行函数内字面量逐字 = Chrome；结构照 Chrome correctionPrompt/correctionRepairPrompt **原文逐段**（六段 join,非想当然四段——先抄原文;CORE_OUTPUT_SHAPE 双端逐字一致可复用））
- Modify: `intellij-plugin/src/main/kotlin/.../analysis/AnalysisService.kt`（analyzeWithFeedback：克隆 Chrome reanalyzeWithFeedback——首轮+**至多一轮修复**、repair 收**平铺** errors、无缓存、USER_RETRY 档、文本脱敏；**成功经 applyOutcome 落账**；失败以 ExtensionFailure 返回给 session 层——不自发 CORE_ERROR）
- Modify: `PreviewSession.kt`（launchFeedback：记录无 core → 回错误消息给输入行（见 Task 3 的消息形态；本任务先定义 Kotlin 侧回调出口）、成功 applyOutcome 后按既有 CORE_RESULT 路径发消息）
- Modify: Connector 的 when（FEEDBACK_REQUEST → session）
- Test: BridgeProtocolTest / PromptsTest / AnalysisServiceTest / PreviewSessionTest

**Interfaces（Task 3 依赖）:**
- 桥: `FEEDBACK_REQUEST {type, previewId, sentenceId, feedback}`（JS→Kotlin）；纠正**失败**回 `CHAT_ERROR` 形态复用裁决——**不用**：新增 `FEEDBACK_ERROR {type, previewId, generation, sentenceId, message}`（与 CHAT_ERROR 平行、按 sentenceId 关联，不混淆会话）；成功复用 CORE_RESULT（blockId=句所在块）。
- Kotlin: `suspend fun analyzeWithFeedback(profile: ModelProfile, documentId: String, input: SentenceInput, core: CoreAnalysis, feedback: String): CoreAnalysis`（抛 ExtensionFailure 于失败；profile/documentId 必传——镜像 chat() 签名,AnalysisService 无服务定位；调度 cacheKey 掺 feedback 文本哈希（chatCacheKey 先例）,否则不同纠正被调度器去重合并）。
- [ ] Step 1: 写失败测试——① 桥: FEEDBACK_REQUEST 合法/超限/forbiddenKeys；FEEDBACK_ERROR 形状+generation；② Prompts: 两首行逐字=Chrome（先抄 chrome-plugin prompts 原文再断言）、紧凑序列化；③ Service: 无缓存写、单轮修复结构（脚本化首轮非法→修复成功→返回修复后）、修复仍非法→ExtensionFailure、消息脱敏、USER_RETRY 档；④ Session: 成功 → record.core 更新 + CORE_RESULT 发送（applyOutcome）；无 core 记录 → FEEDBACK_ERROR。
- [ ] Step 2: 确认红。
- [ ] Step 3: 实现。
- [ ] Step 4: 确认绿（gradle 全量 + web npm——bridge.ts 改动）。
- [ ] Step 5: `git commit -m "纠正反馈桥消息与 Kotlin 服务：单轮修复、无缓存、applyOutcome 落账"`

### Task 3: F2 web 内联纠正输入行

**Files:**
- Modify: `intellij-plugin/src/main/resources/web/render.ts`（失败行「重新解析」旁「纠正」按钮 → 句卡下方内联输入行（textarea maxlength 2000 + 提交/取消）；提交发 FEEDBACK_REQUEST；等待禁用；FEEDBACK_ERROR → 输入行显示 message（INVALID_MODEL_OUTPUT 真实 summary）、卡片**不动**；CORE_RESULT → 既有重画 + 移除输入行）
- Modify: `bootstrap-entry.ts`（FEEDBACK_ERROR case 转发；纠正按钮 document 级委托）
- Modify: `preview.css`（输入行样式，复用 chat 视觉语汇）
- Test: render.test.ts / bootstrap-lifecycle.test.ts
- [ ] Step 1: 写失败测试——① 失败行有「纠正」按钮、成功句详情失败处也可达（保持 record.core 的入口;实现注记:`renderCoreError` 会先把 analysis 置 null——「曾有 core」标志要在置 null 前捕获;输入行状态存 renderer state,**不**依赖只在同帧渲染的 failure 行）；② 提交 → FEEDBACK_REQUEST 形状；③ FEEDBACK_ERROR 后卡片仍在（**无** failure 重画）、输入行显示错误、可重试；④ CORE_RESULT 后输入行移除、卡片重画；⑤ 无 core 句无按钮。
- [ ] Step 2: 确认红（npm test）。
- [ ] Step 3: 实现。
- [ ] Step 4: 确认绿 + `npm run bundle-web`（bundle 提交）。
- [ ] Step 5: `git commit -m "web 内联纠正输入行：失败不动卡片、错误就地显示"`

### Task 4: F3 绕缓存整屏重析

**Files:**
- Modify: `PreviewSession.kt`（reanalyzeAll：**先** bump operationVersion + `analysis.cancelDocument(documentId)`（掐掉在飞批——旧批的 applyOutcome 无守卫,会把已 invalidate 的句标回 READY 而重扫跳过它们,静默漏译;镜像 stop() 的取消但不改 state/不发 RESTORE_ALL）**再** invalidate 全 record（STALE/core=null）+ 置会话级 bypassCacheOnce 标志 + blockRequester.requestScan()（同 generation）；onVisibleBlocks→dispatch 路径消费标志传 analyzeCore(bypassCache=true)，一次性复位；RUNNING 前置）
- Modify: `actions/`（新 Action「重新解析全部段落（绕过缓存）」：RUNNING 才 enable；plugin.xml 注册进 Tools 菜单组）
- Test: PreviewSessionTest / ActionStateTest（或新 Action 测试）
- [ ] Step 1: 写失败测试——① reanalyzeAll 后：FakeServer 收到新一轮请求（缓存命中不再短路——先 start 命中缓存，再 reanalyze，断言模型再次被调）且句重画；② 非 RUNNING 拒；③ bypass 标志一次性（重析后的下一次普通重扫不绕缓存）；④ 在飞批竞速：reanalyze 时一批在飞（脚本化延迟 outcome）→ 旧 outcome 被 version 守卫丢弃,不把句标回 READY;⑤ 停止/换代守卫照常。
- [ ] Step 2: 确认红。
- [ ] Step 3: 实现（照 spec F3 评审钉死机制——requestScan 重驱 initialize/指纹重置是竖条重闪的来源，不新增 Kotlin→JS 消息）。
- [ ] Step 4: 确认绿（gradle 全量）。
- [ ] Step 5: `git commit -m "重新解析全部段落（绕缓存）：会话级 bypass 标志与指纹重扫"`

### Task 5: F4 缓存导入导出 UI + F5 profile 切换接线

**Files:**
- Modify: `settings/EnglishSyntaxConfigurable.kt`（「导出缓存…」「导入缓存…」按钮 → FileSaverDescriptor/FileChooserDescriptor → 后台线程（runBlocking 禁 EDT；用 `service<AnalysisServiceService>().cache` 先例 :35-44）调 CacheTransfer.exportJson/importCacheFile → balloon 结果）
- Modify: `ProfileRepository.kt` 或 Configurable.apply / setActive 路径（调 PluginServices 取 PreviewSessionManager → refreshProfile()；F6 的凭据指纹比较也挂这——见 Task 6，本任务只做 refreshProfile 接线）
- Test: 对应 settings 测试（mock cache/manager）
- [ ] Step 1: 写失败测试——① 导出/导入调 CacheTransfer 且结果文案含 added/skipped；IO 不在 EDT（可测 invokeLater/后台调度形态，按项目既有测试风格）；② setActive 后 refreshProfile 被调（一次，幂等场景不炸）。
- [ ] Step 2: 确认红。
- [ ] Step 3: 实现。
- [ ] Step 4: 确认绿（gradle 全量）。
- [ ] Step 5: `git commit -m "缓存导入导出入口与 profile 切换即时生效"`

### Task 6: F6 AUTH_FAILED 暂停 + 缓存兜底

**Files:**
- Modify: `PluginServices.kt` 或新 `ProfilePauseRegistry`（内存暂停表：profileId → 凭据指纹 `[baseUrl, apiKey, model, sorted headers]`——**`ModelProfile` 不携带 apiKey**（PasswordSafe）,指纹经 `repository.apiKey(id)`/`headerValues(id)`（suspend）组装；暴露 isPaused/recordAuthFailed/releaseIfFingerprintChanged/releaseAll）
- Modify: `PreviewSession.kt` **dispatch 路径**（暂停门在会话层——AnalysisService 无 dispatch;Chrome 也在路由层按消息类型设门）：前置查暂停 → 回落 `lookupCore` + 未命中句 AUTH_FAILED ExtensionFailure（命中句照常产出）；**`launchFeedback` 同样过门并在 AUTH_FAILED 时记账**（漏了它=暂停的死 key 还在收纠正请求,Chrome 对 REANALYZE_WITH_FEEDBACK 同样设门/记账）
- Modify: `PreviewSession.kt`（AUTH_FAILED 结果上报暂停表；detail 未命中回 AUTH_FAILED、chat 暂停回 CHAT_ERROR——新接线）
- Modify: setActive/保存 profile 处（指纹变化解除）+ 测试连接成功处（解除）
- Test: AnalysisServiceTest / PreviewSessionTest / settings 侧
- [ ] Step 1: 写失败测试——① 首批 AUTH_FAILED 后：第二批**不发模型请求**、命中缓存句照常 CORE_RESULT、miss 句 AUTH_FAILED 文案；② 改凭据保存后解除（新请求照发）；③ 测试连接成功解除；④ detail/chat/feedback 暂停分支（detail 回缓存未命中 AUTH_FAILED、chat CHAT_ERROR、feedback FEEDBACK_ERROR）。
- [ ] Step 2: 确认红。
- [ ] Step 3: 实现。
- [ ] Step 4: 确认绿（gradle + web npm 全量）。
- [ ] Step 5: `git commit -m "AUTH_FAILED 暂停与缓存兜底：指纹解除、detail/chat 新接线"`

### Task 7: bundle、文档与门禁收尾

**Files:**
- Rebuild: `bundle.js`（若前序任务未含）
- Modify: `docs/architecture/protocol.md`（FEEDBACK_REQUEST/FEEDBACK_ERROR 条目 + F7 cacheOnly 终态）、`rendering.md`（纠正输入行/重析 Action/浮层措辞）、`overview.md`（手势表补 IntelliJ Action + **修 Chrome 侧漂移**：popup「重新解析可见段落」按钮已不存在，按查证结果改文档）、`model-pipeline.md`（correction prompt/无缓存/单轮修复 + 暂停语义）、`modules.md`（新文件）、`AGENTS.md`（IntelliJ 段一句：纠正无缓存单轮修复、暂停表、bypass 标志）
- [ ] Step 1: `cd chrome-plugin && npm run docs:drift` + `npm test`（architecture-docs 清单）。
- [ ] Step 2: 双门禁全绿（intellij npm + bundle 提交；gradle 三任务）。
- [ ] Step 3: `git commit -m "文档与门禁：IntelliJ 功能补齐同步"`

## 执行注意

- 每任务前读 spec 对应节 + 审计报告对应行；测试命令：Kotlin 在仓库根 gradle，web 在 intellij-plugin/ npm。
- Chrome 参考实现只读不抄运行时耦合（correction prompt 首行逐字、结构照抄；类型/协议按 IntelliJ 桥风格）。
