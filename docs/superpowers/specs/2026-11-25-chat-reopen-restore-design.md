# 追问对话重开恢复(design)

日期:2026-11-25
状态:已确认(对话定稿:双端一起修 + 加「新对话」按钮)

## 意图

现状是 2026-11-03 chat-panel spec 的有意取舍:「对话不持久化:面板关闭即丢」——`dispose()` 清空会话、`open()` 无条件重置、每次点「问」都铸新 conversationId。真机反馈:关掉对话面板再点开,聊过的内容不见了,体验上就是丢了。

目标行为:**按句恢复**——关闭/换句之后,同一句再点「问」,气泡与历史原样回来;想重新开始时点面板头部的「新对话」按钮。双端(Chrome / IntelliJ 预览)对等。

## 方案取舍

| 方案 | 结论 |
| --- | --- |
| A. 按句内存存储,重开恢复历史;**conversationId 每次打开照旧新铸**(选定) | 恢复的是内容不是 id:迟到旧轮结果照旧被面板 conversationId guard 丢弃,不存在「旧轮答案盖掉新轮气泡」竞态;SW/桥/协议零改动;「再点图标 id 递增」的既有测试口径原样成立 |
| B. 面板 dispose 不清状态,重开沿用旧 conversationId | 否:同一 id 下「关闭后重开再发新问」与「旧轮迟到结果」会撞车,面板只按 id 把关分不清轮次;且 dispose/open 的重置语义被钉在多条测试里 |
| C. SW/桥侧持久化对话 | 否:chat 的定位是无缓存旁路;动协议触发三层校验同步;跨会话持久不在诉求内 |

## 目标

1. 点「关闭」或换句后,同句再点「问」:气泡、历史、摘要行恢复,输入可用态正确(恢复的会话无在飞轮)。
2. conversationId 每次打开新铸,计数器递增行为不变;恢复的会话对模型可见的连续性由 history 传递(模型只看 history + question)。
3. 面板头部新增「新对话」按钮:当前句立即换新会话(新 conversationId)、清空历史与气泡,补回被移除的「重按同句 = 重置」能力。
4. Chrome 侧存储在 `session-controller`(面板仍是活跃会话的持有者);IntelliJ 侧存储在 `web/bootstrap-entry`(面板 seam 不变)。Kotlin、桥协议、SW、`protocol.ts` **零改动**。
5. store 生命周期:LRU 上限 8 句(Map 删除重插刷新热度);Chrome `stop()` 与 IntelliJ 换代清空——会话死了恢复无意义。

## 非目标

- 跨页面刷新/跨会话持久化(内存内,随 documentId / previewId 生命周期);
- 在飞轮关闭后的答案补落(关闭即快照,迟到答案照旧丢弃;悬空 user 轮在**紧接着的下一轮**请求里被 `#trimmedHistory` 裁掉——该轮答案落定后悬空轮不再是尾部,会作为普通 user 轮随历史如实携带,桥/SW 门不拒);
- 任何 chat 缓存、缓存键、协议字段变化;
- Chrome E2E 新增(chat 历史上只有单测口径,本变更维持)。

## 约束与已知坑

- sentenceId 是内容哈希(`sessionId+blockId+order+normalizedText`),同句重扫 id 稳定——按句恢复不会串句;文本变了的句子 id 自然不同,开新会话。
- SW 的 chat cacheKey(`conversationId:问题哈希`)只做在飞去重,SW 对 conversationId 无会话状态——新铸 id 无副作用。
- 既有钉住口径不得动:「dispose 移除 host 并作废会话」「换锚定句 open 重置会话」「再点一次图标 → 计数器递增出新 conversationId」三条测试原样通过(方案 A 特意保住这三条)。
- 快照取面板**原始** `#history`(未 trim、含完整问答对),请求视图照旧走 `#trimmedHistory` 裁剪——恢复显示保真,SW 兜底边界不变。
- 面板 `onClose` 钩子必须在 `dispose()` 清态**之前**触发(先快照后清);controller 的 `stop()` 也调 `dispose()`,那里 store 随即整体清空,钩子无害。
- 失败轮不入历史(`failAssistantTurn` 撤销悬空 user 轮),快照天然无悬空轮;唯一残留是「在飞时关闭」的悬空 user 轮,属非目标里声明的不补落。
- IntelliJ 侧换代(generation)清空 store,与面板作废同步;Chrome 侧重扫不换代,同句恢复继续用新鲜 core 作上下文(`askChat` 每轮现取 `sentence.core`)。

## 交付物

- `chrome-plugin/src/content/chat-panel.ts`:`onClose` 快照钩子、`activeConversation()`(原始历史快照)、`restoreHistory(history)`(重画气泡+落历史)、「新对话」按钮(内部重置 + 新 id 由控制器铸)。
- `chrome-plugin/src/content/session-controller.ts`:按句 store(LRU 8)、`openChat` 停靠/恢复、`stop()` 清空。
- `intellij-plugin/src/main/resources/web/chat-panel.ts`:同款三件 + 按钮。
- `intellij-plugin/src/main/resources/web/bootstrap-entry.ts`:图标点击监听里的停靠/恢复 + 换代清空。
- 测试:双端 `chat-panel.test.ts` / Chrome `session-controller.test.ts` / IntelliJ `bootstrap-lifecycle.test.ts` 增量。
- 文档:`rendering.md`(双端 chat 面板行为)、CHANGELOG。

## 留给实现者

- 「新对话」按钮文案/排布(与「收起/关闭」并排,复用 `.header button` 样式);IntelliJ 侧 class 命名沿用 `english-syntax-chat-*` 前缀。
- LRU 刷新热度的实现细节。
- Chrome `openChat` 与 IntelliJ 图标点击监听里「停靠旧会话 → 恢复或新开」的代码形状保持双端同构,便于日后对照。
