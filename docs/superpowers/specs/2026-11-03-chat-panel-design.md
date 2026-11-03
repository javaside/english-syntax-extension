# 追问对话面板（Chat Panel）设计

- 日期：2026-11-03
- 状态：待批准
- 范围：Chrome 扩展（IntelliJ 侧本期不动，桥协议不扩展）

## 意图与为什么

用户读完一段翻译和成分划分后，经常**还是看不懂意思**——详解是固定模板（结构/语法点/讲解），
回答不了「这句为什么这么译」「这里的 side by side 到底修饰谁」「用中文再讲一遍整句在说什么」
这类自由问题。需要一个能**基于该句已核实的分析结果继续向模型提问**的对话入口，
支持多轮连续追问，回答流式逐字显示。

## 目标

1. 每个句子卡片旁有「问」入口，打开右下角浮层聊天面板（方案 B，`DiagnosisPanel` 同款工艺）。
2. 多轮连续对话：追问带上之前的问答历史。
3. 流式回答：经现有 `syntax-learning:<documentId>` 端口逐段推送（`CORE_STREAM` 同款通道），
   面板内逐字渲染。
4. 上下文锚定：句子级 = `SentenceInput`（原文 + tokens）+ 该句的 `CoreAnalysis`（成分划分与译文）。
   面板顶部显示锚定句摘要；点击另一句的「问」= 开新会话（历史不跨句携带）。
5. 走当前 profile 的模型；对话**不写缓存**、**不进修复轮**（自由文本，无 schema 校验）。

## 非目标 / 反目标

- 非目标：段落级锚点（入口与上下文构造预留，后续版本）；IntelliJ 同步；
  对话持久化（面板关闭即丢）；markdown 渲染（v1 纯文本 + 换行，避免注入面与解析依赖）。
- 反目标：**不把对话答案写进任何缓存**（对话是探索性内容，不是分析结果）；
  **不让对话改变成分划分**（纠正划分走既有 REANALYZE_WITH_FEEDBACK，两条链路不混）；
  密钥永不进对话消息（沿用 PasswordSafe / SW 侧请求的既有隔离）。

## 约束（来自仓库既有架构）

- 协议三层同步：新 `ResponseMessage` 成员（`CHAT_RESULT`）必须同步 `shared/protocol.ts` 类型、
  SW 侧路由、content 侧 `isRuntimeResponse` switch 三处；`CHAT_ASK` 是**只有 content 会发**的
  `RequestMessage`，必须同步加进 content 页面路由开头的入站拒绝列表（content-script.ts:454 一带），
  否则页面伪造的同名消息可直达 SW。
- 流式推送不走 sendMessage 响应：`CHAT_STREAM` 由 SW 经 `syntax-learning:<documentId>` 端口
  `postMessage`，content 侧独立守卫 `isChatStreamPush`（`isRuntimeResponse` 的 switch 对它不适用）。
- generation 一致性：`CHAT_STREAM` 携带 `conversationId`，面板按 id 匹配会话；SW 换代/
  文档关闭时端口自然失效，不设额外机制。
- 调度：复用 `detail-click` 优先级（不新增枚举值——优先级清单被 architecture-docs 测试钉住）。
- ChatMessage 的 role 需从 `"system" | "user"` 扩成含 `"assistant"`（多轮历史）。
- `AnalysisModelWork.schema` 是必填：chat 无 JSON schema，把 `schema` 改为可选
  （`run()` 直接走纯文本路径），或传哨兵——**采用可选**，类型层如实表达。

## 方案（已摆过三轮，用户选定 B）

- A 卡片内联对话：视线好但多轮撑爆卡片与页面布局 — 弃。
- **B 固定浮层对话面板（选定）**：卡片每句加「问」按钮；浮层 = Shadow DOM + fixed 定位 +
  惰性单例（`DiagnosisPanel` 先例）；聊天体验完整，不动卡片布局，段落级将来直接复用面板。
- C 详解区延伸：依赖详解已打开，仍有内联撑长问题 — 弃。

## 设计细节

### 协议（src/shared/protocol.ts）

```ts
// content → SW
| (PageRequestBase & {
    type: "CHAT_ASK";
    conversationId: string;          // content 生成：`${documentId}:chat:${n}`
    context: {
      kind: "sentence";
      sentence: SentenceInput;       // 原文 + tokens
      core: CoreAnalysis;            // 已核实的成分划分（含译文）
    };
    history: Array<{ role: "user" | "assistant"; content: string }>; // 之前的轮次
    question: string;                // 本轮问题，trim 后 1..2000 字符
  })

// SW → content（响应通道）
| (MessageBase & {
    type: "CHAT_RESULT";
    conversationId: string;
    answer: string;                  // 完整回答（缓冲兜底；流式已渲染时用于校平）
  })

// SW → content（端口推送，未校验的展示态文本）
export interface ChatStreamPush {
  version; type: "CHAT_STREAM"; documentId; conversationId; text: string; // 截至目前的完整回答
}
export function isChatStreamPush(value): value is ChatStreamPush;
```

三层同步清单（实现时逐项打勾）：protocol 类型 + 守卫 ｜ SW `CHAT_ASK` 路由（校验形状、
tab/documentId 归属）｜ content `isRuntimeResponse` 加 `CHAT_RESULT` case ｜
content 入站拒绝列表加 `CHAT_ASK` ｜ 端口推送守卫 `isChatStreamPush`。

### Adapter（openai-compatible-adapter.ts）

新增 `streamText(profile, messages, signal, onDelta): Promise<string>`：
- 请求 `stream: true`，**不带 response_format**（自由文本）；SSE delta 逐段回调并累积，
  返回完整文本。
- 静默超时与读循环盯 abort 的语义与 `streamWithExtractor` 完全同款（每片重置 `timeoutMs`）。
- **流式分支必须自带 `reasoning_effort` 降级探针**：现有 400/422 + `/reasoning[_ ]?effort/i`
  → `UnsupportedReasoningControlError` 的嗅探只在缓冲路径 `request()` 里，`streamRequest`
  没有——照抄会把 reasoning 拒绝映射成不可重试的 `NETWORK_ERROR`，流式默认开启的 chat
  在 OpenAI 官方类端点上永久失败。`streamText` 的重试循环按 `streamWithExtractor` 同款
  捕获该错误 → `persistReasoningControl("unsupported")` → 去掉字段重发（仓库约定
  「缓冲与流式两条路径都要接」在 chat 上才算闭合）。
- `ChatMessage.role` 扩为 `"system" | "user" | "assistant"`。

### AnalysisService（analysis-service.ts）

新增 `chat(input: ChatInput, signal): Promise<{ answer: string }>`：
- prompt 构造（`prompts.ts` 新增 `buildChatPrompt`，**首行为固定英文指令行**
  `"Discuss the verified translation analysis with the reader."`——
  假服务器 `detectKind` 按首行前缀识别请求类型，E2E 依赖此约定。**该首行是
  `buildChatPrompt` 函数内字面量，绝不进 `PROMPT_FIRST_LINES` 表**——那张表被
  `contracts.json` + Kotlin 双侧钉死，动了就破坏 Chrome-only 范围并触发 gradle 门禁
  （`buildDiagnosisPrompt` 同款先例））：
  1. 系统指令：用中文回答；基于给定的已核实分析讲解，**不要重新划分成分**；
     分析若与问题冲突，以分析为准并说明；回答简洁分段。
  2. 上下文：`serializeSentence(sentence)` + `serialize(core)`（紧凑序列化，沿用既有 `serialize`）。
  3. 历史轮次原样拼接（user/assistant 交替）。
  4. 本轮问题。
- 优先级 `detail-click`；无缓存读写；无修复轮；模型错误原样上抛
  （AUTH_FAILED 等照既有 pauseProfile 语义由 SW 处理）。

### SW（service-worker.ts）

`CHAT_ASK` case：取 profile → `analysisService.chat` → 流式推送 → 完成后回 `CHAT_RESULT`。
- **推送形状是「截至目前完整回答」而非增量**：调度器对可重试错误（网络/超时/限流）会静默
  重跑 `run()`，追加式 delta 在重试后会把两段流拼成乱序文本；`CORE_STREAM`/
  `DETAIL_STREAM` 的既有约定就是推**累积全量**（面板整段重画），chat 沿用同一约定，
  重试天然无害。
- 推送条件与既有流式一致：`documentPorts.has(documentId) && getStreamRendering()`；
  profile `streamSupport === "unsupported"` 或选项关闭时走缓冲路径，
  整段回答随 `CHAT_RESULT` 一次性下发（面板「无分片、直接整段出现」是接受的 UX）。
  **缓冲路径同样携带 `reasoning_effort: "none"` 降级接线**（仓库既有约定：两条路径都要接）。
- 文本经 `redactProfileSecrets` 以防模型回显 profile 泄漏物（与 CORE_STREAM 同款）。
- **调度命名空间用 `${documentId}:chat` 后缀**（diagnosis 的 `:diagnosis` 先例）：
  chat 请求的 abort 绝不连坐取消该页正在跑的 core/detail；反之亦然。
  **该命名空间同时带来一个必须补的回收点**：`cancelDocument` 是精确匹配，现有的
  STOP_SESSION / 标签页关闭 / 端口 `onDisconnect` 取消链全都够不到 `${documentId}:chat`，
  而流式是静默超时（总时长不设限），页面关走后回答会无限期占住全局并发槽
  （仅 4 个）。因此 SW 的端口 `onDisconnect` 与 `cancelTab` 处必须**追加**
  `scheduler.cancelDocument(`${documentId}:chat`)`。面板收起/展开不触发取消——
  只有消费方真正消失（端口断开/标签页关）才回收。
- `cacheKey` 必须按轮次唯一（`conversationId + ":" + 本轮问题哈希`）：调度器按
  `documentId\0cacheKey` 合并在飞请求，同会话第二问若共用 key 会直接拿到第一问的
  在飞 promise（串答案 + fetch 计数错乱）。
- 入站校验失败（question trim 后为空 / 超 2000 / history 形状非法）回 `MALFORMED_MESSAGE`
  ——不新增错误码（`ERROR_CODES` 闭集改一处要动五端）；空问题在 UI 侧本就发不出去，
  SW 校验只作兜底。
- 无 profile 时回 ERROR `CONFIG_MISSING`（对话没有缓存兜底语义）。

### Content（新文件 src/content/chat-panel.ts + 接线）

- `ChatPanel`：Shadow DOM 浮层（右下，可收起/展开/关闭），惰性单例；
  会话状态 = { conversationId, context 摘要行, history[] }；
  气泡流 + 底部输入框（Enter 发送 / Shift+Enter 换行 / 发送中禁用）；
  `onStreamText(conversationId, text)` 以**全量替换**渲染当前回答气泡
  （与推送形状配套，重试安全）；
  `onResult(conversationId, answer)` 收尾（以缓冲答案为准渲染，防流式尾片丢失）。
- **历史裁剪**：面板构造 `history` 时只带**最近 6 轮**且总字符 ≤ 8000
  （超出丢最旧轮；`CHAT_ASK` 的 SW 校验同步拒绝超限）——无界增长会在多轮后撞
  provider 上下文上限。
- `learning-block.ts`：每个句子区头部加「问」按钮（`data-syntax-chat-ask`），
  点击派发 `syntax-chat-request` CustomEvent（detail 带 sentenceId）——
  与 `syntax-detail-request` 同款事件模式。按钮计入 `EXTENSION_OWN_SELECTOR`
  语义（在扩展卡片内，天然不被扫描器枚举）。
- `session-controller.ts`：`askChat(sentenceId, question)` —— 取该句 `SentenceInput` +
  已落地的 `sentence.core`（无 core 时按钮置灰），生成 conversationId，发 `CHAT_ASK`；
  `onStream` 分发 `CHAT_STREAM` → 面板。
- 换句开新会话：面板顶部摘要行换成新句，历史清空，conversationId 重新生成。

### E2E（tests/e2e + fake-openai-server）

- 服务器 `detectKind` 加 `chat`（首行前缀匹配），`writeContent` 流式输出两段中文文本。
- 用例：fixture 页 → 等卡片 → 点某句「问」→ 面板出现 → 输入问题回车 →
  断言**流式分段到齐**（探针式：最终文本 === 完整答案 + fetch 计数 === 1）→
  再问第二轮 → 断言请求体携带第一轮问答历史（服务器侧记录请求）→ fetch 计数 === 2。

### 文档与门禁

- `docs/architecture/`：protocol.md（两条新消息 + 端口推送）、model-pipeline.md（chat prompt、
  无缓存、detail-click 优先级）、rendering.md（浮层与问按钮）、modules.md（新文件）、
  overview.md（链路一句话）、build-test-release.md（E2E 约定）。
- architecture-docs.test.ts：`CHAT_RESULT`/`CHAT_ASK`/`CHAT_STREAM` 进消息类型全覆盖断言。
- 门禁照常：chrome 五件套（动的是 chrome-plugin + docs，不动 shared-fixtures/intellij，
  无需 gradle）。

## 留给 builder 的决定

- 面板视觉细节（宽度、配色、气泡样式）——顺 DiagnosisPanel 的暗色系即可。
- 输入框长度上限的 UI 反馈方式（截断提示 vs 计数）。
- `conversationId` 计数器的存放位置（模块级 vs panel 实例字段）。
- 测试桩的会话历史构造细节。

## 尺寸

项目级：协议三层 + 端口流式 + adapter 文本流式 + service/SW 路由 + 新 UI 面板 + prompt +
E2E + 六份文档。估 6–8 个提交。
