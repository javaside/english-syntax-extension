# 快捷键解析悬停段落 设计

日期：2026-07-25

## 目标

用户在页面上把鼠标悬停在某个段落上，按快捷键（默认 `Alt+T`）即可对该段落运行现有的逐句语法解析（成分 + 译文卡片）。等价于「右键 → 解析此区域」的键盘版，但要求在会话未启动的冷页面上也能直接使用，且只解析悬停的那一段，不触发全页分析。

## 决策记录

| 问题 | 决策 |
| --- | --- |
| 「当前行」的含义 | 鼠标悬停所在的段落/块（`p`、`li`、标题等，即现有 `CandidateBlock` 粒度） |
| 翻译形态 | 复用现有语法解析卡片（成分拆解 + 成分译文），不新增整段译文能力 |
| 快捷键 | `Alt+T`（manifest `commands` + `suggested_key`，用户可在 `chrome://extensions/shortcuts` 修改） |
| 悬停定位 | 命令到达时查询 CSS `:hover` 链取最深元素，再交给 `nearestSafeBlock()`；不做常驻 mousemove 追踪（冷启动时无历史位置，且有常驻开销） |
| 冷启动行为 | 轻量启动会话：建立会话基础设施但不做全页扫描，只解析悬停段落；后续点扩展图标可升级为完整会话 |

## 1. 触发链路（manifest + Service Worker）

- `manifest.json` 新增：

  ```json
  "commands": {
    "parse-hovered-block": {
      "suggested_key": { "default": "Alt+T" },
      "description": "解析鼠标悬停的段落"
    }
  }
  ```

- `src/background/service-worker.ts` 新增 `chromeApi.commands.onCommand` 监听（与 `action.onClicked` 相邻）。处理流程镜像右键「解析选中文本」的冷启动分支（`contextMenus.onClicked` 的 `SELECTION_MENU_ID` 分支）：
  1. 过滤命令名 `parse-hovered-block`，取事件携带的 tab；无 tabId 则忽略。
  2. 取/建 `documentId` → `await inject(tabId)` 按需注入内容脚本。
  3. 读取启用的模型配置，`activeTabs.set(tabId, …)` 登记会话状态。
  4. `sendPageCommand(tabId, documentId, { type: "PARSE_HOVERED_BLOCK" })`。
- 按快捷键属于用户手势，Chrome 会随之授予 `activeTab`，注入行为与点击工具栏图标一致。
- `chromeApi` 门面类型补充 `commands`（可选，兼容测试 fake）。
- `src/shared/manifest.test.ts` 更新断言覆盖 `commands` 段。

## 2. 协议改动

- 新增页面命令类型 `PARSE_HOVERED_BLOCK`（无载荷），按 AGENTS.md 约定同步全部点位：
  - `src/shared/protocol.ts` 请求联合类型 + `isRequestMessage`；
  - SW `route()` 新增 case（形态仿 `PARSE_SELECTION`：注入后转发到页面并回 `ACK`）；
  - `sendPageCommand` 的 body 联合类型；
  - content 侧 `ContentScriptRouter.route` switch + `RoutedController` 接口。
- 无新响应类型（复用 `CORE_RESULT` 链路），`isRuntimeResponse` 不改。
- 无新提示词，`tests/support/fake-openai-server.ts` 不改；缓存结构不改。

## 3. 内容脚本（SessionController）

- 新方法 `parseHoveredBlock(): Promise<ExtensionError | undefined>`：
  1. 会话未启动 → 轻量启动 `await this.start({ scan: false })`；
  2. 查询悬停链 `document.querySelectorAll(":hover")`，取最后（最深）一个元素；悬停查询封装为可注入依赖，便于 jsdom 下 stub；
  3. `nearestSafeBlock(deepest)` 定位段落块；null → 返回 `CONTEXT_ERROR` 并触发用户提示（见 §4）；
  4. 未注册则 `registerCandidates([candidate])`，然后 `queueVisibleBlock(candidate.id, true)`（与 `parseContextBlock` 同构）。
- `start()` 增加选项 `{ scan?: boolean }`（默认 `true`）：
  - `scan: false` 时建立监听、transport、MutationObserver 等基础设施，但跳过 `scanDocument` 与 `viewport.observe`；
  - 新增 `scanned` 标记。`start()` 在「已 running 但未 scanned 且本次要求完整扫描」时补做扫描+视口观察（升级路径：轻量会话 → 点图标 `START_SESSION` → 完整会话）；
  - `stop()` 重置 `scanned`。

## 4. 边界情况与用户反馈

- 鼠标不在正文上（悬停在导航/代码块/空白）→ `nearestSafeBlock` 返回 null，用右下角进度胶囊（`SyntaxProgressPill`）短暂提示「未找到可解析的段落」。理由：右键路径有菜单反馈，快捷键没有，静默失败会让用户以为快捷键坏了。
- `chrome://`、商店等不可注入页面 → `inject()` 失败静默忽略，与点图标一致。
- 同一段落重复按键 → 幂等：已注册块重新入队，命中缓存，与右键「解析此区域」一致。
- 无模型配置 / 服务不可用 / 鉴权失败 → 复用现有卡片内错误渲染与暂停机制，不新增逻辑。
- 快捷键与网页自身快捷键冲突 → Chrome 扩展命令优先于页面监听，且用户可改键，不做额外处理。

## 5. 测试

- 单测（vitest）：
  - SW `onCommand` 处理器：fake chromeApi 断言注入 + `sendPageCommand` 载荷；无 tab、不可注入页面的容错。
  - `SessionController.parseHoveredBlock`：悬停命中/未命中、冷启动轻量会话、幂等重复按键（悬停查询通过注入依赖 stub）。
  - `start({ scan: false })` → 后续完整 `start()` 的升级路径。
  - `manifest.test.ts` 的 `commands` 断言。
- E2E（Playwright，无法触发真实扩展快捷键）：通过 background 上下文直接调用命令处理逻辑（或等价入口）验证「悬停段落变卡片、其余段落不动」；具体注入机制在实现计划中确定。
- 门禁：`npm test && npx playwright test && npm run lint && npm run format:check && npm run build`；lint 保持基线（恰好 1 个已知错误），不新增。

## 非目标

- 不做整段/整句连贯中文译文（现有卡片只有成分级译文）。
- 不做视觉行（折行后的行）粒度。
- 不在选项页新增快捷键配置 UI（交给 `chrome://extensions/shortcuts`）。
- 不做常驻 mousemove 追踪。
