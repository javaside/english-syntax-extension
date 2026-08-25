# IDEA 插件：快捷键按段翻译 设计

日期：2026-08-25

## 目标

在 IntelliJ 插件里补上 Chrome 端已有的「快捷键解析悬停段落」能力：鼠标停在官方 Markdown 预览的某一段上，按快捷键（默认 `Alt+T`）即对该段运行现有的逐句语法解析（成分 + 译文卡片）。

IDEA 端此前只有「整篇翻译」一种模式（`Tools → 开始句法学习` 一次上报全文所有英文段），长文档一开就是上百次模型请求。本功能同时补上「按需只翻一段」：会话未启动时快捷键自己轻量启动，只解析悬停那一段，**不触发全文扫描**。

## 决策记录

| 问题                     | 决策                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| 「哪一段」               | 鼠标悬停在预览页里的那一段（与 Chrome 端一致），不做编辑器光标定位、不依赖官方预览 HTML 的 `md-src-pos`                   |
| 快捷键送达               | IDEA Action（可在 Keymap 改键）+ 预览页 `keydown` 兼底；两条通道汇入同一个 JS 入口                                        |
| 两通道键位一致           | 注入时 Kotlin 从 keymap 读实际绑定，转成描述符下发 JS；改 keymap 后兼底通道跟随                                           |
| 默认键                   | `alt T`（Chrome 端同款）。macOS 下 ⌥T 被 IDEA 截获，不再打出 `†`；用户可改键                                              |
| 翻译形态                 | 复用现有卡片（成分拆解 + 成分译文），不新增整段连贯译文                                                                   |
| 冷启动                   | 会话未启动时置 `RUNNING` 但不扫描全文；后续点「开始句法学习」升级为整篇会话                                               |
| 暂停语义                 | 显式手势穿透暂停（Chrome 端 `queueVisibleBlock(id, force = true)` 同款）                                                  |
| 悬停定位判据             | 只保留排除区 + 渲染盒子 + 叶子块 + 文本非空；**不套用**自动扫描的 20 字符与英文占比 60% 门槛                              |
| 保存重渲染后             | 已翻译段落不自动恢复，重按快捷键即可（命中缓存，瞬时）                                                                    |

## 1. 触发链路（双通道）

新增 Action `EnglishSyntax.ParseHoveredBlock`，放在 `Tools → 句法学习` 组里「开始句法学习」之后，`plugin.xml` 内联中文文案（与三个兄弟 Action 一致），并附 `<keyboard-shortcut first-keystroke="alt T" keymap="$default"/>`。`EnglishSyntaxBundle.properties` 补 `action.EnglishSyntaxParseHoveredBlock.text/description` 两个键，与兄弟保持同构。

- **通道 A（IDEA Action）**：`actionPerformed` → `EnglishSyntaxPreviewPanel.findPanel` → `PreviewSessionConnector.parseHovered(panel, manager)`（接线 + `panel.requestParseHoveredBlock()`）→ `executeJavaScript("window.__englishSyntaxParseHoveredBlock&&window.__englishSyntaxParseHoveredBlock();")`。焦点在编辑器时走这条。面板/服务缺失时经 `ActionNotifier.warn` 提示，文案与 Start 对齐。
- **通道 B（预览页 keydown）**：bundle 在 `document` 上挂 `keydown` 监听，命中描述符就调同一个入口。焦点在 JCEF 浏览器里时走这条（离屏渲染关闭时按键根本不上交 IDE，只有这条能用）。匹配用 `event.code`（如 `"KeyT"`）而非 `event.key`——macOS 上 ⌥T 的 `key` 是 `†`。
- **`update()` 只判「有 project + 当前文件是 Markdown + JCEF 可用」，不查面板。** `findPanel` 会 `wrap` + 注入 JCEF，放进高频 `update()` 就是「点开工具菜单即假翻译」那个坑（见 `invariants.md`）。
- **防双发**：离屏渲染模式下同一次按键可能既到 IDE Action 又到 CEF。Kotlin 侧本身幂等（`onVisibleBlocks` 的 `fresh` 过滤丢弃已注册句，`pendingBatch` 也会合并），JS 再加一道 400ms 同 `blockId` 去抖，避免重复桥消息与浮层闪烁。

### 键位描述符同步

注入阶段（`injectWebResources`）从 `KeymapManager.getInstance().activeKeymap.getShortcuts("EnglishSyntax.ParseHoveredBlock")` 取第一个 `KeyboardShortcut`，转成 `{ altKey, ctrlKey, shiftKey, metaKey, code }` 下发 `window.__englishSyntaxSetHotkey(descriptor)`。

转换是纯函数（`HotkeyDescriptor.from(keyStroke): HotkeyDescriptor?`），单测钉住：

- `VK_A..VK_Z` → `"KeyA".."KeyZ"`；`VK_0..VK_9` → `"Digit0".."Digit9"`；
- 其余 keyCode 返回 `null`，JS 侧保持默认 `Alt+T`（并落一条 `LOGGER.info`）——不为罕见键位堆映射表；
- `InputEvent.ALT_DOWN_MASK` / `CTRL_DOWN_MASK` / `SHIFT_DOWN_MASK` / `META_DOWN_MASK` 逐位映射到布尔字段。

JS 侧匹配要求四个修饰键**逐一相等**（不是「包含」），避免 `Alt+Shift+T` 误触发绑定为 `Alt+T` 的入口。

## 2. 协议改动

新增一条 JS → Kotlin 消息 `PARSE_BLOCK`：JS 已经把段落定位好了，消息直接带 `blockId` 与 `text`。

```kotlin
data class ParseBlock(
  override val previewId: String,
  override val generation: Int,
  val blockId: String,
  val text: String,
) : PageMessage
```

按 AGENTS.md 的「协议三层校验必须同步」，四处缺一不可：

1. `bridge/BridgeProtocol.kt` 的 `PageMessage` 新成员；
2. `parsePageMessage` 新分支，键白名单 `version/type/previewId/generation/blockId/text`，`blockId` 非空、`text` 长度不超过复用的 `MAX_BLOCK_TEXT`；
3. `session/PreviewSessionConnector.connect` 的 `when` 新 case → `session.parseExplicitBlock(...)`；
4. `BridgeProtocolTest` 断言白名单（多余键、缺键、超长文本、含 `apiKey`/`headers`/`baseUrl` 全拒）。

`EnglishSyntaxPreviewPanel.onPageMessage` 的 `when` 有 `else` 分支，无需改。**不新增 `HostMessage` 类型**，`parseHostMessage` 不动。

Kotlin → JS 的全局入口改动三处：

| 入口                                                    | 变化                                                        |
| ------------------------------------------------------- | ----------------------------------------------------------- |
| `__englishSyntaxInitialize(previewId, generation, autoScan)` | 新增第三参数：是否自动上报全文块                        |
| `__englishSyntaxParseHoveredBlock()`                    | 新增：定位悬停段并上报 `PARSE_BLOCK`                        |
| `__englishSyntaxSetHotkey(descriptor)`                  | 新增：设置兼底 keydown 的键位描述符                         |

## 3. Kotlin 会话层

### `session/PreviewSession.kt`

先从 `onVisibleBlocks` 里抽出一个私有辅助 `registerFresh(blocks): List<SentenceInput>`，承载「分句分词 + 防环 fresh 过滤 + 注册 `SentenceRecord`」这段（含 `blockIdOf` 反查）。`onVisibleBlocks` 随之瘦成「STOPPED 丢弃 → `registerFresh` → PAUSED 缓冲 → `enqueueSentences`」，行为不变。

显式路径复用它，但**不合批、不绕缓存、穿透暂停**：

```kotlin
/** 显式手势：只解析指定的一段。会话未启动时轻量启动——置 RUNNING 但不触发全文扫描。 */
fun parseExplicitBlock(blockId: String, text: String) {
  if (state == SessionState.STOPPED) state = SessionState.RUNNING
  val fresh = registerFresh(listOf(blockId to text))
  if (fresh.isEmpty()) return
  // 与 Chrome 端 queueVisibleBlock(id, force = true) 同构：立即派发，不进 120ms 合批窗口
  scope.launch { dispatch(fresh, offscreen = false, allowPaused = true) }
}
```

`offscreen = false` → `priorityFor(active = true, offscreen = false)` = `ACTIVE_VISIBLE_CORE`，符合「用户显式发起的解析一律不置 `offscreen`」这条约定。**不绕缓存**（绕缓存只属于 `USER_RETRY` 重试）。

绕开 `enqueueSentences` / `flushBatch` 是有意的：`pendingBatch` 是共享的，`offscreen`/`allowPaused` 都按「最后一次入队者」取值，把显式块混进合批会让同批的普通块也拿到 `allowPaused`。单块派发本来也没有合批收益。

暂停穿透需要放宽 `dispatch()` 的两道守卫：

- 顶部 `if (state != SessionState.RUNNING) return` → 拆成 `if (state == SessionState.STOPPED) return` 与 `if (state == SessionState.PAUSED && !allowPaused) return`；`allowPaused` 默认 `false`，只有显式路径传 `true`，普通路径行为不变。
- 流式分片守卫 `if (state == SessionState.RUNNING && ...)` → `if (state != SessionState.STOPPED && ...)`。这一步顺带抹平一处既有不一致：`applyOutcome` 本来就不看暂停（在飞请求的最终结果照样渲染），但分片会被丢掉，表现为「暂停后卡片突然整块冒出来、没有流式过程」。加测试钉住。


### `markdown/EnglishSyntaxPreviewPanel.kt`

- `@Volatile var autoScan: Boolean = false`，由 `notifyInitialize()` 作为第三参数下发。**默认 `false`** 顺带修掉一处潜在问题：今天只要 `findPanel` 走过一次 `wrap`，注入末尾的 `notifyInitialize` 就会让 JS 上报全文块——现在靠会话恰好还是 `STOPPED` 被丢掉，纯属侥幸。
- `requestParseHoveredBlock()` + `@Volatile private var pendingParseHovered` + `@Volatile private var injected`：bundle 尚未注入时先记下意图，`injectWebResources()` 末尾（`notifyInitialize()` 之后）补发并清标记。冷启动第一次按键走的正是这条路。与 `window.__englishSyntaxLoaded` 的幂等守卫同一套思路。
- 注入末尾下发 `__englishSyntaxSetHotkey(descriptor)`，位置紧跟 `__englishSyntaxSetTheme`。

### `session/PreviewSessionConnector.kt`

新增 `parseHovered(panel, manager)`：先 `connect(panel, manager)`（分发器必须先接上，否则 JS 回传的 `PARSE_BLOCK` 无消费者），再 `panel.requestParseHoveredBlock()`。**不碰 `panel.autoScan`**——保持 `false`，除非已有整篇会话把它置过 `true`。

`start(panel, manager)` 里在 `manager.start(...)` 之前置 `panel.autoScan = true`。

### Stop 路径

`StopSyntaxLearningAction` 在 `manager.stop(previewId)` 之后把 `panel.autoScan = false` 复位，这样「停止 → 再按快捷键」只翻一段，而不是整篇。

## 4. JS 侧：悬停定位 + 手动模式

### `web/preview.ts` 新增两个导出

- `ensureBlockId(element: HTMLElement): string`：取已有的 `data-english-syntax-block`，缺失则用与 `scanMarkdownBlocks` **同一个** `nextBlockId` 计数器分配并写回。共用计数器保证不会出现双 id；被显式路径分配过 id 的元素后来被自动扫描扫到时会沿用旧 id（现有 `existing ?? next` 逻辑已覆盖）。
- `nearestPreviewBlock(target: EventTarget | null): HTMLElement | null`：从悬停元素逐级向上找最近的可解析块。

`nearestPreviewBlock` 的判据（与 Chrome 端 `nearestSafeBlock` 同构）：

1. 起点：`Element` 直接用；`Node` 取 `parentElement`；否则 `null`；
2. 起点若命中 `input,textarea,[contenteditable]` 或位于 `[contenteditable]` 内 → `null`；
3. 逐级向上，第一个同时满足下列全部条件的祖先即结果：
   - 不在 `EXCLUDED_SELECTOR` 内（`pre/code/table/.math/.katex/.mermaid/.footnotes/交互控件/[data-english-syntax-card]`）；
   - `isRendered`（computed display 非空串且非 `inline*`——happy-dom 里内联元素的 computed display 是空串，必须算作非块）；
   - `isLeafBlock`（无渲染块级子元素）；
   - `textContent.trim()` 非空。
4. 走到根仍未命中 → `null`。

**刻意不套用自动扫描的取舍**：不要求 20 字符、不要求英文占比 60%、不限定正文容器。这是 `invariants.md` 里那条不变量的 IntelliJ 版——`scanMarkdownBlocks` 要在整篇里躲开样板文字，`nearestPreviewBlock` 只服务用户指到的那一处，症状是「鼠标明明停在段落上却报『未找到可解析的段落』」（短段落、术语行、中英混排行全中招）。

### `web/bootstrap-entry.ts`

- `RuntimeState` 加 `autoScan: boolean`，由 `initialize(previewId, generation, autoScan = true)` 写入（默认 `true` 兼容既有测试调用）。
- `rescan()` 在 `if (blocks.length === 0) return;` 之后插一道 `if (!s.autoScan) return;`：**注册照旧**（`renderer.registerBlock` 在前，渲染器需要 blockId → element 映射），但不上报 `VISIBLE_BLOCKS`、不打「解析中」标记、不亮浮层。这是手动模式的关键——否则我们插入卡片引发的 mutation，以及保存后官方重渲染带来的 `initialize`（会 `resetScanRegistry()` + 清空 `lastVisibleFingerprint`），都会把整篇文档送去翻译。
- `parseHoveredBlock()`：
  1. 400ms 同 `blockId` 去抖（去抖键取定位结果，定位失败不参与去抖）；
  2. `nearestPreviewBlock(hoverTarget())`，`hoverTarget` 默认 `document.querySelectorAll(":hover")` 取最深一个，做成可注入依赖便于 happy-dom 下 stub；
  3. 命中卡片内部（`closest("[data-english-syntax-card]") !== null`）→ 浮层「该段已解析」并返回；
  4. `null` → 浮层「未找到可解析的段落」并返回；
  5. `ensureBlockId` → `renderer.registerBlock` → 发 `PARSE_BLOCK` → `markBlockActive` → 浮层「句法学习：正在解析 1 段…」。
- keydown 监听 + `setHotkey(descriptor)`；默认描述符 `{ altKey: true, ctrlKey: false, shiftKey: false, metaKey: false, code: "KeyT" }`。
- 把现有的 `reportedBlockCount: number` 改成 `requestedBlocks: Set<string>`：按段解析是逐次累加，用计数器会让 `settleBlock` 的完成判定算错（第二次按键时 `settledBlocks.size` 已经 ≥ 1）。改成集合后 `rescan` 整体替换、显式路径 `add`，并在重复请求同一块时 `settledBlocks.delete(blockId)`，两条路径共用一套账。`clearAllActive()` 同步清空。

### 浮层短提示

`setStatus(text, kind, spinning)` 已有；新增一个 `flashStatus(text)`：`setStatus(text, "error", false)` + 2.5 秒后 `hideStatus()`，复用现有的 `completeTimer` 语义但独立计时器，避免与「解析完成」淡出互相取消。

## 5. 边界情况与用户反馈

| 情况                                       | 行为                                                                                                                       |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| 鼠标不在正文上（代码块、表格、空白）       | 浮层短提示「未找到可解析的段落」，2.5 秒淡出。快捷键没有菜单反馈，静默失败会让用户以为键坏了                                |
| 悬停在已翻译的卡片上                       | 浮层提示「该段已解析」——否则会落到上一行的「未找到」，提示误导                                                              |
| 鼠标不在预览面板内                         | CSS `:hover` 可能仍停在最后悬停的元素上，于是解析那一段。与 Chrome 端同一特性，不额外处理                                   |
| 同一段重复按键                             | 幂等：`onVisibleBlocks` 的 `fresh` 过滤丢弃已注册句，无新请求                                                              |
| 整篇会话已在跑                             | 该段大概率已入队，同样被 `fresh` 过滤，什么也不发生                                                                        |
| 会话处于「暂停」                           | 显式手势穿透暂停（见 §3）。若不穿透，JS 打上的「解析中」竖条会一直亮到用户点继续，正是 `invariants.md` 警告的「竖条常亮」   |
| 首次按键时 bundle 尚未注入                 | Kotlin 侧 `pendingParseHovered` 在注入末尾补发。注入耗时内鼠标可能已移开——冷启动首次按键的固有特性，与 Chrome 端一致        |
| 保存后官方重渲染                           | 手动模式下已翻译段落不自动恢复，重按快捷键即可（命中缓存，瞬时）。列为非目标                                                |
| 未配置模型                                 | 走现有 `cacheOnly` 分支：命中缓存的句子出卡片，未命中保持原文                                                              |
| 请求失败 / 鉴权失败                        | 走现有 `CORE_ERROR` → 卡片内错误渲染 + 重试按钮，不新增逻辑                                                                |
| 非 Markdown 文件 / JCEF 不可用             | Action `update()` 置灰隐藏                                                                                                 |
| 快捷键与 IDEA 既有绑定冲突                 | 交给用户在 Keymap 改键；改完兼底通道经描述符同步跟随                                                                        |

## 6. 测试

### Kotlin（`./gradlew :intellij-plugin:test`）

- `actions/ActionStateTest`：新 Action 的 `update()` —— Markdown 文件 + JCEF 可用 → 启用；非 Markdown / JCEF 不可用 → 隐藏；**会话状态不影响启用**（冷启动、RUNNING、PAUSED 都可按）。
- `session/PreviewSessionTest`：
  - `parseExplicitBlock` 在 `STOPPED` 下置 `RUNNING` 且**不调用** `blockRequester.requestScan()`（用假 `BlockRequester` 计数）；
  - 只派发传入的那一段，`priority == ACTIVE_VISIBLE_CORE`、`bypassCache == false`；
  - `PAUSED` 下仍派发（穿透），且分片经 `CORE_STREAM` 回推；
  - 重复调用同一 `blockId` 幂等（第二次不产生新的 `analyzeCore` 调用）；
  - 已有的「暂停时普通 `onVisibleBlocks` 进 `pausedBlocks`」用例保持绿。
- `bridge/BridgeProtocolTest`：`PARSE_BLOCK` 白名单——多余键、缺 `blockId`、空 `blockId`、`text` 超 `MAX_BLOCK_TEXT`、含 `apiKey`/`headers`/`baseUrl`、`version` 不匹配、负 `generation` 全部返回 `null`；合法消息解析成 `PageMessage.ParseBlock`。
- `markdown/EnglishSyntaxPreviewPanelTest`：`notifyInitialize` 脚本包含第三个 `autoScan` 参数且随字段变化；`requestParseHoveredBlock()` 在注入前只记标记不发脚本，`injectForTest()` 之后补发一次且只补一次。
- `session/PageMessageWiringTest`：经 Panel 的 `onPageMessage` 灌入一条单块 `PARSE_BLOCK`，断言会话拿到该块并派发（钉住四层同步没漏）。
- 新增 `actions/HotkeyDescriptorTest`：`VK_T + ALT_DOWN_MASK` → `{altKey:true, code:"KeyT"}`；`VK_5` → `"Digit5"`；`VK_F7` → `null`；多修饰键逐位映射。

### Web（`cd intellij-plugin && npm test`）

- `preview.test.ts`：`nearestPreviewBlock` —— 内联 `span` → 外层 `p`；`code`/`pre` 内 → `null`；短文本（< 20 字符）**仍接受**；中文为主的段落**仍接受**；嵌套只取叶子块（不返回包着整篇的容器）；`[contenteditable]` 内 → `null`；`ensureBlockId` 幂等且与扫描共用计数器。
- `bootstrap-lifecycle.test.ts`：`autoScan = false` 时 `initialize` 不上报 `VISIBLE_BLOCKS`、不亮浮层；`parseHoveredBlock()` 只发一条含单块的 `PARSE_BLOCK`；定位失败时不发消息且浮层出现提示文案；悬停在卡片内时提示「该段已解析」；400ms 内二次调用不重复发消息；keydown 按描述符匹配（`Alt+T` 触发，`Alt+Shift+T` 不触发），`setHotkey` 改描述符后按新键触发。
- 现有断言 `bundle.js` 内容的用例补一条：包含 `"PARSE_BLOCK"`。

### 门禁与产物

```bash
(cd intellij-plugin && npm ci && npm test) \
  && ./gradlew :intellij-plugin:test :intellij-plugin:buildPlugin :intellij-plugin:verifyPluginProjectConfiguration
```

改了 `bootstrap-entry.ts` / `preview.ts` 后**必须** `cd intellij-plugin && npm run bundle-web` 重打 `src/main/resources/web/bundle.js`——它是提交进仓库的产物，忘了重打的症状是「Kotlin 侧全绿、真机按键毫无反应」。

## 7. 文档同步

| 文档                            | 要写的内容                                                                                         |
| ------------------------------- | -------------------------------------------------------------------------------------------------- |
| `docs/architecture/modules.md`  | 新源文件：`actions/ParseHoveredBlockAction.kt`、`actions/HotkeyDescriptor.kt`                       |
| `docs/architecture/protocol.md` | `PARSE_BLOCK` 页面消息；三个 JS 全局入口的签名变化（`autoScan` 第三参数、`ParseHoveredBlock`、`SetHotkey`） |
| `docs/architecture/rendering.md`| 悬停定位判据、手动模式下 `rescan` 不上报、`requestedBlocks` 集合化                                  |
| `docs/architecture/invariants.md`| 补一条「显式手势不套用自动扫描取舍」的 IntelliJ 版（规则 / 为什么 / 症状 / 守护测试）              |
| `docs/architecture/overview.md` | 链路时序补「快捷键 → Action / keydown → `PARSE_BLOCK` → 单块派发」这条支线                          |
| `CHANGELOG.md`                  | 未发布段「新增」条目                                                                                |

IntelliJ 插件仍是 `0.1.0-SNAPSHOT` 未发布（现有功能都还在 CHANGELOG 的「未发布」段里），本功能并入同一段，不单独升版本号。Chrome 端不改，其版本号不动。

## 非目标

- 不做整段连贯中文译文——卡片仍是成分级译文（与 Chrome 端一致）。
- 不做编辑器光标定位与 `md-src-pos` 映射（官方预览的实现细节，非公开 API，比悬停脆弱得多）。
- 不做保存重渲染后自动恢复已翻译段落（需要跨代次的文本级身份匹配；重按快捷键命中缓存已足够）。
- 不在设置页新增快捷键配置 UI，交给 IDEA Keymap。
- 不做常驻 mousemove 追踪，按键那一刻查 `:hover` 即可。
- 不为罕见键位堆 `KeyEvent` → `event.code` 映射表，字母数字之外回退默认键。
- 不改 Chrome 端任何代码。





