# Alt+T 悬停解析的开关循环（设计）

- 日期：2026-11-28
- 状态：已与作者拍板方案，待评审
- 关联：`docs/architecture/rendering.md`（卡片替换/还原）、AGENTS.md「显式手势」段

## 意图与动因

Alt+T 悬停解析（双端同构）翻译完一段后，卡片永久替换原文，用户想再看原文只能停止整个会话（全页还原）。作者要的是：**鼠标停在该段上再按一次 Alt+T，恢复原文**。

裁决（2026-11-28 讨论拍板）：

- **双端同步做**（toggle 逻辑全在各自 web/JS 侧，Kotlin 与桥协议零变更）
- **只有 Alt+T 获得开关语义**——选区解析、右键「解析此区域」维持现状（提示「该段已解析」）
- 解析进行中再按：维持现状提示「该段正在解析中…」，**不做取消**

## 目标

- 完整开关循环：翻译 → 原文 → 重显卡片 → 原文……重显卡片**不调模型、不重新下发**（结果已在内存）
- 还原是精确还原：`BlockReplacement.restore()` / renderer `#restoreBlock` 已有语义（移卡片、解除隐藏、还原 class），直接复用
- 协议零变更：toggle 是纯页面侧行为

## 非目标 / 反目标

- 不改 `parseSelection` / `parseContextBlock` 的「已解析」提示语义
- 不给解析中的块做「按键取消」——卡片可能正在流式预览，中途取消语义纠缠 generation 与修复轮，先不做
- 不动「重新解析」按钮、停止会话全页还原
- 反目标：restore 之后视口滚动/迟到响应把卡片拉回来——终态闸门（ready 句子不重发、`finishBlock` 只在批落地时 show）已挡住，测试钉死

## 方案对比（已选定 1）

1. **显隐 toggle，块记录不动（选定）**：卡片是否在页上就是开关状态（Chrome `replacement.active` / IntelliJ `record.card`）。「已解析」提示分支改为还原动作；鼠标停在已还原的原文上再按 → 重显。句子 phase、缓存、sentenceId、块记录全部不动，没有新状态字段。
2. **restore + 丢弃块记录，下次重新解析**：单块删除记录牵连视口失效、pendingBatches、诊断快照、ephemeral 锚点清理，比 stop 的全清更绕；重走 SW 缓存路径还要重建 sentenceId。否决。
3. **右键菜单「还原此段」**：多一步操作，作者明确要快捷键。放弃。

## Chrome 端（`SessionController.parseHoveredBlock`）

现状两条「已拦截」分支改为 toggle，其余路径（冷启动、去抖、queueVisibleBlock）不动：

1. **鼠标停在卡片上**（`blockShowing` 命中）：
   - 句子有 in-flight → 提示「该段正在解析中…」（不变）
   - 全终态（ready/failed/skipped）→ `replacement.restore()` + `marker.clear()`，返回 `undefined`（ack；卡片消失、原文复现即反馈，不打 pill）
   - 未全终态且无 in-flight（queued 流式间隙）→ 维持现状继续下发
2. **鼠标停在原文上**（卡片已还原，`nearestSafeBlock` 命中、`known` 存在）：
   - in-flight → 提示（不变）
   - 全终态且 `replacement.active === false` → 重显：`replacement.show(element, learningBlock)`，返回 `undefined`
   - 全终态且卡片在页上（hover 链 quirks 命中原文兄弟）→ 等价分支 1 的还原
   - 重显与还原都过 `debounceExplicitParse`（防 400ms 内开关抖动；时间戳照旧不随被挡按键刷新）

`explicitBlockNotice` **不改**——`parseSelection` 继续用它提示「该段已解析」。toggle 逻辑内联在 `parseHoveredBlock`。

### 已核实的边界

- 视口路径：`queueVisibleBlock` 对全 ready 块不重发（终态闸门）→ restore 后滚动不会翻案
- 迟到响应：`finishBlock`/`showPreview` 只在批落地或流式进行中调用，全终态块无流
- 重显可行性：卡片 host DOM 在 restore 后仍由 `learningBlock` 持有，`show()` 重新插入（`#display` 自带先 restore 再插入的幂等）；字体继承按原元素重算
- 追问面板：双端面板都是 `documentElement` 上的 fixed 浮层（**不在卡片子树内**——初稿曾误写「Chrome 端挂在卡片 DOM 子树内」，评审更正）；关卡时若其锚定句属于该块，随停停靠收走（`dispose` 先触发 `onClose` 停靠钩子再摘 host），锚定别的块不误收。Chrome 端此行为在最终评审修复轮补齐（初版漏做）。

## IntelliJ 端（`bootstrap-entry.ts` + `render.ts`）

`parseHoveredBlock` 的两条「该段已解析」分支改为 toggle，`registerBlock` 之前拦截重显：

1. **停在卡片里**（`closest("[data-english-syntax-card]")`）：块已 settle → 还原；在解析中（`requestedBlocks` 有、`settledBlocks`/`failedBlocks` 无）→ 提示「该段正在解析中…」
2. **停在已隐藏原文上**（`HIDDEN_ATTRIBUTE`）：原文隐藏 = 卡片在显示，等价分支 1（JCEF hover 链在 DOM 变更后不一定重算，这条与分支 1 是同一用户状态的两个探针）
3. **停在未隐藏原文上 + 该块已 settle**（卡片已还原）→ 重显，**不**走 `registerBlock`（它会丢旧句子映射）也**不**重新下发 `PARSE_BLOCK`

renderer 新增两个公开方法：

- `restoreBlock(blockId): boolean`：`#restoreBlock` 提升。单块语义：纠正行若挂该块则收走（`#closeCorrection` 的块级化）；详解面板/焦点/返回栈仅当 `currentDetail` 属于该块时清空（`restoreAll` 的按块子集）
- `repaintBlock(blockId)`：`#repaintBlock` 提升为公开薄壳，重画已有句子（record/card 复用逻辑原样）

Kotlin、桥协议、PreviewSession：**零变更**。

## 不变的东西

- 协议三层校验（无新消息/字段）、调度、缓存键、prompt
- 「该段已解析」提示在选区/右键路径的原语义
- 停止会话全页还原、换代会话清空
- 双端去抖常量 `PARSE_DEBOUNCE_MS = 400` 及「时间戳不随被挡按键刷新」规则

## 测试

Chrome（`npm test` + Playwright）：

- `session-controller.test.ts`：完整循环（解析→卡片→再按→原文可见且卡片不在→再按→卡片回来、句子 phase 不变）；in-flight 提示；restore 后视口回调不翻案；选区路径仍提示「该段已解析」；去抖窗口内开关只生效一次；部分失败块可开关（失败行随卡复现）
- E2E：Alt+T 三连按循环，**fetch 计数探针**断言重显卡片不调模型；原文恢复断言（原文本可见、卡片节点不在 DOM）

IntelliJ（web `npm test` + gradle `test`）：

- `bootstrap-lifecycle.test.ts`：两处「该段已解析」判据变 toggle（停卡片/停隐藏原文）；重显不重新 `PARSE_BLOCK`（探针：`postToHost` 计数）；正在解析提示
- `render.test.ts`：`restoreBlock` 单块语义（别的块卡片不动、纠正行按块收走、详解面板按块清）；`repaintBlock` 重画已还原块

## 文档同步（实现提交时顺手做）

- AGENTS.md「显式手势」段：Alt+T 的开关语义与「只有快捷键 toggle」裁决
- `docs/architecture/rendering.md`：双端单块还原/重显入口
- CHANGELOG

## 验收口径

- 双端门禁全绿（AGENTS「门禁」命令）
- 真机双端手验：翻译→还原→重显循环，观察无「解析中」闪烁、无重复模型调用

## 留给实现者

- 部分失败块的重显入口选择：`show` 的 `isReadyToReplace()` 闸门对「全失败块」是否放行（若不放行，重显用 `showPartialFailure`，注意 `renderFailure` 重复渲染是否幂等）
- IntelliJ「正在解析中」判据集合（requested/settled/failed 三集的窗口期）与文案
- IntelliJ 追问面板（chat panel 独立于卡片 DOM 时）在 toggle 还原时的收走策略：按锚定句所在块判定，与换句路径同款
- Chrome 端 toggle 成功是否补 pill 提示（默认不加；若实现中发现用户易误解，再议）
