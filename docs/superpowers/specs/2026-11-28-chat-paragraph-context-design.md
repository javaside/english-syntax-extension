# 追问对话的段落级上下文（设计）

- 日期：2026-11-28
- 状态：方案已与作者拍板；builder check 两项机制裁定（文档序取邻段、只读上下文走查）已并入，待作者批准
- 关联：`2026-11-03-chat-panel-design.md`、`2026-11-10-intellij-chat-panel-design.md`、`2026-11-25-chat-reopen-restore-design.md`

## 意图与动因

追问对话（chat）目前把模型可见的上下文钉死在「本句 + 已核实 core」。指代（this/it/they）、省略、跨句衔接的先行词常常落在别的句子里，模型拿不到，回答就不准确——作者原话：「按句子的话，上下文总是不够清楚。回答问题就不准确。」

裁决（2026-11-28 讨论拍板）：上下文单位从「句」升到「段」——**本句所在段整段 + 前一段 + 后一段**，原文（不分析）注入 chat prompt。

## 目标

- chat 每轮提问都能看到句子所在段落及前后各一段的原文，正确回答指代/省略/衔接类问题
- 双端同构：Chrome 与 IntelliJ 的 prompt 结构逐字一致（既有铁律不变）
- 防伪造门照旧：过桥/过 SW 的载荷有形状 + 字符上限校验
- 体积可控：分段封顶 + 截断标记，最坏总增量约 6k 字符

## 非目标 / 反目标

- 不给邻段做成分分析、不带邻段的 core——邻段可能尚未解析（`requesting`/failed），把上下文可得性耦合解析进度会让回答质量随滚动位置漂移
- 不动详解（detail）路径——detail 有缓存键（句文本 + focus 区间），加上文需重构键构造与预载路径，牵连大，另立项
- 不做用户可配置的窗口大小
- 轻量会话（选中/悬停冷启动）里合成块（`selection-N`）不在扫描清单里，降级为只有本段——不为此做 DOM 回溯
- 反目标：模型开始分析/翻译上下文段落（注意力漂移）——用指令钉死

## 方案对比（已选定 2）

1. **按句窗口**（前 N 句原文）：先行词可落在段中任意位置，截断点靠猜；实现上还要切邻段取尾句。作者否决：「按句子总是不够」。
2. **本段 + 前后各一段（选定）**：段落是完整的连贯单元；实现更简单（邻段不切句、直接拿原文）；后指（cataphora）与「和后文什么关系」类问题也覆盖；成本由封顶控住。
3. **前后各两段**：上下文更全，但注意力漂移风险与截断频率上升，收益递减。放弃。

## 分工（已定，两端对称）

**页面侧脚本算邻段，服务侧只校验 + 拼 prompt。**

- **Chrome**：content（`SessionController.askChat`）取邻段。
  - 清单来源：常规会话用 `this.blocks` 的值集（`performScan` 即全量注册，视口只管派发解析）；轻量会话（未做过全页扫描）首次追问时一次性跑 `this.options.scan(this.document)` 只读取清单（**不注册块、不观察视口、不触发解析**，结果缓存在控制器里，换代作废）。
  - **邻段一律按文档序取，不用 Map 插入序**——插入序在「轻量→全量升级」（悬停/选中块先注册、扫描其余按 fresh 过滤追加，Map 序变成 `[p3,p1,p2,p4,p5]`）与突变刷新（失效块删后重插到尾部）下会错位，静默喂错「上一段」正是本特性要修的失败模式。做法：ask 时把「本块元素 ∪ 清单一众块元素」用 `compareDocumentPosition` 排序，取本块在文档序里的 ±1。本块不在清单（轻量会话的显式手势块、合成 `selection-N` 锚）也同样并入排序——锚元素插在选区位置，DOM 序邻块即真实邻段；本块元素已脱 DOM（锚被回收）时 `before`/`after` 降级为 `none`。
  - `current` 恒取自本块记录的文本（`BlockRecord.candidate.text`），不依赖清单是否命中。
  - 经 `CHAT_ASK.context` 扩展字段发给 SW。
- **IntelliJ**：web 侧（`sendChatAsk`）现算。**取数用新的只读上下文走查，不是重跑 `scanMarkdownBlocks`**——后者过滤已注册元素（`registeredElements` WeakSet）与已挂卡片的块（`HIDDEN_ATTRIBUTE`），而两种模式下 `rescan()` 早已注册完所有合格块、auto 模式下整页都挂着卡片，重跑只会拿到空表（特性静默 no-op）；且它会登记返回的块，重跑扰动增量发现的去重不变量（那套过滤是修「二次 scan 返回空」真 bug 引入的，契约不能碰）。新函数（`preview.ts`，与 `scanMarkdownBlocks` 并排）复用同一套候选/资格门，但**忽略已注册/已隐藏过滤、零副作用**，对原始元素（含被卡片隐藏的）同款提取文本，DOM 先序遍历天然产出文档序清单。本句所在块经 renderer 新增访问器 `sentenceBlockElement(sentenceId)` 定位（`#sentences` 的 blockId → `#blocks` 的 element，不做 sentenceId 字符串反解——避免与 id 格式耦合）；本块若不在走查结果里（显式手势块的 `nearestPreviewBlock` 刻意不套 20 字符/占比门，与自动门不匹配），把本块元素并入文档序排序后再取 ±1。结果经桥 `CHAT_ASK` 新增 `surroundings` 字段发给 Kotlin。**manual 模式（不上报全量清单）因此不降级——这是必须 web 侧算的根本原因：manual 模式下 Kotlin 没有邻段数据。**

**约定修订**：IntelliJ「chat 上下文不过桥」修订为——句子 + 已核实 core 仍不过桥（Kotlin 从 `SentenceRecord` 重建，防伪造面不扩大），**邻段原文过桥，带字符封顶**。理由：manual 模式 Kotlin 侧没有全量清单；且与 Chrome 的 content→SW 分工完全对称。

## 协议与桥（已定）

Chrome `shared/protocol.ts`：

```ts
export interface ChatSurroundings {
  before?: string;
  current?: string;
  after?: string;
}
export interface ChatContext {
  kind: "sentence";
  sentence: SentenceInput;
  core: CoreAnalysis;
  surroundings?: ChatSurroundings;
}
```

- 类型 + `isChatContext` 守卫同步扩展（`hasOnlyKeys` 增 `surroundings`；`before`/`current`/`after` 可选，出现即须 trim 后非空且 ≤ 各自上限）——RequestMessage 成员同步点为「protocol 类型 + SW 侧校验」两处；content 页面路由的入站拒绝列表已含 `CHAT_ASK`（消息类型不变，无需动）；`isRuntimeResponse` 无涉（`CHAT_RESULT` 不变）。
- content 侧计算上限引用 protocol.ts 导出的同一常量，不自己写数字。

IntelliJ 桥 `CHAT_ASK`：键白名单 **8 → 9**（+`surroundings`）。`web/bridge.ts` parse 与 `BridgeProtocol.kt` `parseChatAsk` 双端镜像校验（与 `MAX_CHAT_QUESTION_CHARACTERS` 同款 mirror pair）：`surroundings` 可选；出现时键集恰为 `before`/`current`/`after` 的子集，各为 string、trim 后非空、≤ 各自上限；超限/多余键 → 拒收。

### 封顶常量（五处同步、全同值）

| 常量 | 值 | 截断策略 |
| --- | --- | --- |
| `MAX_CHAT_SURROUNDING_BEFORE_CHARS` | 1200 | 保**尾**，截断处前置 `…`（U+2026） |
| `MAX_CHAT_SURROUNDING_CURRENT_CHARS` | 4000 | 整段；超长取**句锚窗口**，两端按需 `…` |
| `MAX_CHAT_SURROUNDING_AFTER_CHARS` | 800 | 保**头**，截断处后置 `…` |

分布：Chrome `shared/protocol.ts`（守卫）+ content 计算（import 同一常量）；IntelliJ `web/bridge.ts` + `BridgeProtocol.kt`（mirror pair）+ web 侧计算（bridge.ts 常量）。截断前先 trim 块文本首尾空白。

### current 超长的句锚窗口

在块文本里 `indexOf(句文本)`（Chrome 用 `sentence.input.text`——`segmentBlock` 生产句已 trim、是块文本子串；IntelliJ web 用 `renderer.sentenceText(sentenceId)`，`leadingWhitespace + text` 重建、同为子串），以命中位置为中心向两侧扩到上限；找不到（理论到不了）回落头部窗口。

## Prompt（已定，两端逐字一致）

四段 → **五段**。**首行不动**（假服务器 `detectKind`、E2E、contracts.json 的 `promptFirstLines` 全不受牵连；`PROMPT_FIRST_LINES` 仍不含 chat）。段落顺序：

1. 系统指令（首行 + 指令段）
2. `Selected sentence:` + `serializeSentence` 句载荷
3. `Verified core result:` + `serialize` 紧凑 core
4. **新增** `Surrounding context` 段（见下）
5. `Conversation history (oldest first):` + `Conversation question`

指令段追加一句（追加在现有第二行指令尾部，原文如下，双端逐字）：

> The surrounding paragraphs are reference context only: use them to resolve references that point outside the sentence (for example what a pronoun refers to), but keep every answer about the selected sentence — do not analyze, divide, or translate the context paragraphs.

新增段骨架（位置在 `Verified core result` 之后、`Conversation history` 之前；三行恒在，缺省写 `none`）：

```
Surrounding context (reference only; not the topic):
Paragraph before: <before 或 "none">
Paragraph containing the selected sentence: <current>
Paragraph after: <after 或 "none">
```

- 上下文原文**直排**，不走 `serialize`/`serializeSentence`——该规则针对需要 Token ID 定位的句载荷；上下文无需定位，紧凑直文已是最省。此豁免理由写进本文即视为口径。
- 骨架固定（含 `none` 占位）保证双端逐字比对可测。
- `current` 与 `Selected sentence` 重复出现是有意的（锚定更稳，代价小）。

Kotlin 签名变化：`buildChatPrompt(input, core, surroundings, history, question)`，新增 `ChatSurroundings(before/current/after: String?)` 模型类型；`AnalysisService.chat` 与 `PreviewSession.onChatAsk` 增参透传。

## 不变的东西

- conversationId 机制（每次打开新铸）、按句停靠恢复、LRU、「新对话」——上下文只影响 prompt 内容，不影响会话语义
- 调度（`${documentId}:chat` 命名空间、`DETAIL_CLICK` 档、按轮 cacheKey）、流式全量重画、脱敏——全不动
- chat 无缓存：天然无缓存键牵连（这是把本特性只挂 chat、不挂 detail 的主要原因之一）
- 停靠条目不带 surroundings（恢复的是历史文本，上下文每次 ask 现取现发）

## 测试

Chrome（`chrome-plugin` `npm test` + Playwright）：

- `prompts.test.ts`：五段骨架逐字断言（含 `none` 占位、`…` 截断标记位）；指令新句存在；首行不变。
- 协议守卫（`content-script-diagnosis.test.ts` 及 protocol 相关用例）：`isChatContext` 对 `surroundings` 合法/非法（多余键、超上限、空串）全覆盖。
- `session-controller.test.ts`：`askChat` 携带邻段，且**断言文档序**——专门构造「轻量→全量升级」的错序场景（悬停块先注册、Map 序 ≠ 文档序）钉住 ±1 取的是 DOM 序邻块；轻量会话首次追问触发一次性扫描且结果缓存；合成 `selection-N` 锚并入排序、脱 DOM 时降级 `none`。
- E2E：假服务器收到的 chat prompt 含 `Surrounding context`（现有 chat 用例同步扩展，不为截断细节加墙钟断言）。

IntelliJ（web `npm test` + gradle `test`）：

- `PromptsTest.kt`：与 TS 五段逐字一致（镜像断言）。
- `BridgeProtocolTest.kt`：`parseChatAsk` 的 `surroundings` 门（合法/多余键/超上限/多余顶层键拒收）。
- `bridge.test.ts`：`PAGE_KEYS_BY_TYPE` 与 parse 镜像。
- `preview.test.ts`：只读上下文走查——忽略已注册/已隐藏过滤、零副作用（不登记、不扰动去重不变量）、DOM 先序即文档序。
- bootstrap web 测试：`sendChatAsk` 经走查现算邻段（文档序、`s-{blockId}-{index}` 反解、本块不在走查结果时并入排序、封顶与截断、manual 模式同路径）。
- `PageMessageWiringTest.kt` / PreviewSession 测试：`surroundings` 从桥一路流到 `chat()` 调用。

## 文档同步（实现提交时顺手做）

- `AGENTS.md`：chat 旁路段落补「段落上下文」规则；「八键白名单」→ 九键
- `docs/architecture/protocol.md`：`CHAT_ASK` 字段与门
- `docs/architecture/model-pipeline.md`：chat prompt 五段 + 封顶常量
- `CHANGELOG`

## 验收口径

- 单测/门禁全绿（双端命令见 AGENTS「门禁」）
- 双端 `buildChatPrompt` 对同一输入产出逐字节相同的 prompt（结构断言互为镜像）
- 真机抽查：含跨句指代的段落，问「这个 it 指什么」能得到基于邻段的正确回答（`.superpowers/acceptance/` 脚本，不入 CI）

## 留给实现者

- 封顶数值（1200/4000/800）已钉死；若实现中发现长段占大头，`current` 上限可在 3000–5000 间微调，但**五处必须同值**
- 轻量会话一次性扫描缓存的失效时机（换代/重扫后丢弃）按现有 session 生命周期裁定
- E2E 用例是新增还是扩展现有 chat 用例
- `…` 截断标记在截断边界恰好落在空白处时的去留（建议保留，双端同判即可）
