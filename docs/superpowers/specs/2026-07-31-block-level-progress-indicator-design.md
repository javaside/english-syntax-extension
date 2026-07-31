# 段落级解析进度指示 设计

日期：2026-07-31

## 目标

解析进行中时，让用户一眼看出**是哪一段在跑**。当前只有右下角进度胶囊给出全局计数，段落本身在「按下快捷键」到「首个成分渲染」之间（可能数秒）没有任何视觉变化，用户无法把进度和具体段落对应起来。

本设计给正在解析的段落加一根左侧竖条 + 极淡底色，进行中出现、结束即撤。

## 决策记录

| 问题     | 决策                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------ |
| 呈现形式 | 左侧竖条 + 微弱底色。原文保持可读，不占布局空间                                                        |
| 覆盖范围 | 所有解析路径（快捷键 / 右键 / 选中 / 自动扫描）一视同仁                                                |
| 绑定相位 | 只绑 `requesting`。成功、失败、跳过、暂停、取消、断连——离开 `requesting` 一律撤                        |
| 失败态   | 不用红竖条。失败本就会把段落换成带错误信息的卡片（`showPartialFailure`），红竖条会与卡片内提示重复表达 |
| 流式期间 | 竖条跟到卡片上继续显示，直到整段 `ready` 才撤（分片不改相位，段落仍在跑，撤掉会让用户误以为完成）      |
| 挂载实现 | 复用 `BlockReplacement` 的「注入 `<style>` + 防冲突随机类名」套路，不引入浮层定位同步                  |
| 竖条实现 | `inset box-shadow` 而非 `border-left`——前者不参与布局计算，文字不位移                                  |

### 未采纳

- **独立浮层**（Shadow DOM 绝对定位 + `getBoundingClientRect`）：对页面零侵入，但要自行同步滚动、重排、`ResizeObserver`，还要处理长段落跨屏与粘性头部遮挡。为一根纯装饰性竖条引入定位同步不划算，且这类实现最易出现「竖条漂移、留在原地」的 bug。
- **骨架屏占位**：反馈最强，但解析期间原文不可读，且失败时要变回原文，会白闪一次。
- **段落下方进度条 / 行尾徽标**：前者撑高段落把下文顶下去，流式时多段同时跑会持续抽动页面；后者插入文本流会改变折行，且长段落的尾部可能在视口外。

## 1. 新组件：BlockActivityMarker

新增 `src/content/block-activity-marker.ts`，形状仿 `BlockReplacement`：

```ts
export class BlockActivityMarker {
  mark(element: HTMLElement): void; // 幂等；目标变了先撤旧的
  clear(): void;
}
```

职责单一：把「解析中」标记打到某个元素上，并精确撤掉。

- 样式走「注入 `<style>` + 防冲突随机类名」，复用 `BlockReplacement.#reserveHiddenClass` 同款探测：检查 `getElementsByClassName` 确认页面上没有同名 class，最多试 100 次，后缀必须匹配 `/^[A-Za-z0-9_-]+$/`。
- 撤销时与 `BlockReplacement.restore()` 同样精确：若原元素本来没有 `class` 属性，移除后不能留下空的 `class=""`。
- 每个 `BlockRecord` 持一个实例（多段可并发解析），经 `SessionControllerOptions.markerFactory?: () => BlockActivityMarker` 注入，默认 `() => new BlockActivityMarker()`，与现有 `replacementFactory` / `learningBlockFactory` 一致。

## 2. 状态判定与数据流

- `SentenceRecord` 增加 `blockId: string`，在 `registerCandidates` 建记录时写入。避免每次相位变更遍历所有块。
- `SessionController` 新增私有方法 `#refreshBlockActivity(blockId)`：
  1. 该块**任一句**处于 `requesting` → `marker.mark(target)`；
  2. 否则 → `marker.clear()`。
- 挂载点 `target = block.replacement.currentElement(block.candidate.element)`：原文期挂原文，流式换卡片后挂卡片。
- 调用时机：
  - `private transition(sentence, phase)` 末尾——**所有**相位变更都收口在这一个函数（session-controller.ts:781），挂在这里即可覆盖全部路径，`ready` / `failed` / `skipped` / `stale` 自动撤标，无需逐路径处理；
  - `showPreview` / `show` / `showPartialFailure` 之后各补调一次，把标记迁到新的呈现元素上。

## 3. 视觉与样式

```css
box-shadow: inset 3px 0 0 rgba(10, 132, 255, 0.9);
background-color: rgba(10, 132, 255, 0.06);
```

- **`inset box-shadow` 不参与布局计算**，文字不会位移，现有折行与紧凑布局 E2E（`tests/e2e/layout.spec.ts`）不受影响。这是选它而不选 `border-left` 的唯一理由，改动时不要退回边框实现。
- 色值取系统蓝的半透明形式，明暗底色上都可见；底色 6% 透明度，不干扰阅读。实现时可微调，但必须保持「明暗两种页面背景下都能看清」这一约束。
- 呼吸/流动动画加 `@media (prefers-reduced-motion: reduce)` 关闭，与 `progress-pill` 现有做法一致。

## 4. 边界与错误处理

- `stop()` / `reset()`：遍历清所有 marker。
- **SW 断连**：最可能泄漏的路径——若相位卡在 `requesting`，竖条会一直转。在现有 disconnect 处理里一并清标记。
- 元素被页面移走（SPA 重渲染）：`clear()` 对已 detached 的元素安全返回，不抛。
- 块失效 / 重新解析：`invalidateBlock` 路径同样经 `transition`，自动收敛。
- 暂停的块：句子相位不是 `requesting`，自然无标记。

## 5. 测试

- `block-activity-marker.test.ts`：打标与撤标精确还原（含空 `class=""` 清理）、幂等、换目标时旧的先撤、类名冲突时换后缀。
- `session-controller.test.ts`：进入 `requesting` 打标；`ready` / `failed` / `skipped` 后撤；流式 preview 后标记迁到卡片；`stop()` 清空；断连清空。
- E2E：按快捷键后该段出现标记、解析完消失。**断言用探针**（查类名是否存在），不用墙钟。

## 非目标

- 不做百分比进度（模型不返回可用的完成度，逐句相位无法折算成有意义的百分比）。
- 不改右下角进度胶囊的现有行为。
- 不给排队中（`queued`）的段落单独状态——自动扫描时整页会同时亮起，偏吵。
- 不改自动扫描的候选判定。
