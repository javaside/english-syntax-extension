# 设计：重试按钮交互反馈 + 预载开关状态可见（2026-07-24）

## 背景

用户反馈两个 UX 问题：

1. 「预载成分详解」开关在选项页配置后，日常使用中无处可见其开/关状态（只有预载进行中时弹窗与进度胶囊才显示「详解预载中 n/m」）。
2. 学习卡片上的「重新解析」按钮没有任何交互反馈：无手型光标、无 hover/按下样式；点击后到结果返回前界面原样不动，按钮还可反复点击；且会话暂停时点击被静默忽略（`session-controller.retryCore` 在 `state !== "running"` 时直接 return），用户完全无法判断点击是否生效。

## 改动一：弹窗副标题显示预载开关状态

- 弹窗依赖注入（`popup.ts` 的 dependencies）新增 `getPrefetchDetail(): Promise<boolean>`，读取与选项页同一份配置（config-repository 已有存取逻辑）。
- 副标题模型信息行：开关**开启**时追加「 · 预载详解已开启」，如 `DeepSeek · deepseek-v4-flash · 预载详解已开启`；**关闭**时不追加任何文字。
- 优先级不变：运行中若预载未完成，副标题仍被「详解预载中 n/m」覆盖；未配置模型（cacheOnly）时的引导文案也不受影响（无模型行则不追加）。
- 配置的生效时机不变（下次「开始学习」生效），弹窗显示的是**当前配置值**，与选项页勾选框一致。

## 改动二：「重新解析」按钮交互反馈

学习卡片（Shadow DOM）内共两处「重新解析」按钮：整句失败区（`renderFailure`）与成分详解失败区（`renderError`），行为保持一致。

### 样式（learning-block 内联样式表）

- `.retry` 增加 `cursor: pointer`。
- `:hover` 底色高亮（半透明 currentColor 底色，适配任意宿主页配色）。
- `:active` 轻微下沉（如 `transform: translateY(1px)`）；`prefers-reduced-motion: reduce` 时禁用 transform 过渡，与现有约定一致。
- `:disabled` 置灰且恢复默认光标。

### 状态机

1. 点击 → 按钮立即 `disabled`，文案变「解析中…」，然后派发现有 `syntax-reanalyze-request` 事件（行为不变）。
2. 成功 → `renderCore` / 详解渲染整体替换该区域，按钮自然消失。
3. 再次失败 → `renderFailure` / `renderError` 重新渲染失败区，按钮恢复「重新解析」可再试。
4. 会话已暂停/停止 → session-controller 原本静默 return 的分支改为通知卡片：按钮文案短暂显示「会话已暂停」约 2 秒后恢复「重新解析」并重新启用。LearningBlock 新增公开方法（如 `resetRetry(sentenceId, hint?)`）供 controller 调用；不改变重试语义本身。

### 边界

- 纯缓存会话重试未命中转 `renderSkipped` 的现有语义不变（该路径整块替换，无按钮残留）。
- `operationVersion` 竞态保护不变；按钮禁用只是防抖增强，不替代版本校验。

## 测试

- `learning-block.test.ts`：点击后按钮禁用且文案为「解析中…」；`resetRetry` 恢复文案与可用态；「会话已暂停」提示在约 2 秒后复原（fake timers）。
- `session-controller.test.ts`：暂停态触发重试时调用 `resetRetry` 且不发请求；失败→重试→再失败后按钮可再次点击。
- `popup.test.ts`：开关开启时副标题含「预载详解已开启」；关闭时不含；「详解预载中 n/m」仍优先覆盖。
- 不新增 E2E；若现有 E2E 对「重新解析」文案有断言则同步更新。

## 非目标

- 不改变预载配置的生效时机与预载调度逻辑。
- 不在进度胶囊中常显预载开关状态。
- 不为暂停态提供"点重试自动恢复会话"的能力。
