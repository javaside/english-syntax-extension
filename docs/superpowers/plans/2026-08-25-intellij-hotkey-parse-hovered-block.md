# IDEA 插件快捷键按段翻译 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 IntelliJ 插件里加一个快捷键（默认 `Alt+T`），按下即解析鼠标悬停的那一段 Markdown 预览段落；会话未启动时轻量启动，只翻这一段，不触发全文扫描。

**Architecture:** 快捷键走两条通道汇入同一个 JS 入口——IDEA Action（可在 Keymap 改键）与预览页自带的 `keydown` 监听（焦点在 JCEF 里时兜住）。JS 侧定位悬停段后回传一条新的 `PARSE_BLOCK` 桥消息，Kotlin 会话把它当单块显式手势派发（`ACTIVE_VISIBLE_CORE` 优先级、不合批、不绕缓存、穿透暂停）。新增的 `autoScan` 开关让 JS 的 `rescan()` 在手动模式下只注册不上报，避免整篇被送去翻译。

**Tech Stack:** Kotlin + Gradle IntelliJ Platform（`intellij-plugin/`）、kotlinx-serialization、JCEF 桥（`JBCefJSQuery` + `executeJavaScript`）、TypeScript + rolldown IIFE bundle、vitest + happy-dom、kotlin.test。

**Spec:** `docs/superpowers/specs/2026-08-25-intellij-hotkey-parse-hovered-block-design.md`

---

## 开工前必读

- **不要开 worktree。** 仓库工作区当前有 54 个文件的未提交改动（含 `PreviewSession.kt`、`BridgeProtocol.kt`、`bridge.ts`、`render.ts`、`bundle.js`、`EnglishSyntaxBundle.properties`），本计划里的所有行号与代码片段都是贴着**当前工作区**写的，不是贴着 HEAD。开 worktree 会拿到 HEAD 版本，对不上。
- **每个任务的 commit 只 stage 该任务碰过的文件**，用显式路径。**绝不 `git add -A` / `git add .`**——会把那 54 个无关改动一起提交。
- 提交信息用中文主题（仓库约定）。
- 命令都在 `intellij-plugin/`（npm）或仓库根（gradle）下跑。首次跑 web 测试前先 `cd intellij-plugin && npm ci`。
- 单跑一个 Kotlin 测试类：`./gradlew :intellij-plugin:test --tests "dev.codetui.englishsyntax.*.类名"`。
- 单跑一个 web 测试文件：`cd intellij-plugin && npx vitest run src/main/resources/web/文件名.test.ts`。

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `intellij-plugin/src/main/kotlin/.../bridge/HotkeyDescriptor.kt`（新建） | `KeyStroke` → 浏览器 `KeyboardEvent` 判据的纯转换 + 从 keymap 读实际绑定 + 动作 id 常量 |
| `intellij-plugin/src/main/kotlin/.../bridge/BridgeProtocol.kt`（改） | 新增 `PageMessage.ParseBlock` 与 `PARSE_BLOCK` 白名单分支 |
| `intellij-plugin/src/main/kotlin/.../session/PreviewSession.kt`（改） | 抽出 `registerFresh`；新增 `parseExplicitBlock`；`dispatch` 加 `allowPaused` |
| `intellij-plugin/src/main/kotlin/.../session/PreviewSessionConnector.kt`（改） | 分发 `PARSE_BLOCK`；`start` 置 `autoScan=true`；新增 `parseHovered` 接线 |
| `intellij-plugin/src/main/kotlin/.../markdown/EnglishSyntaxPreviewPanel.kt`（改） | `autoScan` 字段并随 `initialize` 下发；`requestParseHoveredBlock` + 未注入时延迟补发；注入时下发快捷键描述符 |
| `intellij-plugin/src/main/kotlin/.../actions/ParseHoveredBlockAction.kt`（新建） | 快捷键 Action：定位面板 → 接线 → 触发页面定位 |
| `intellij-plugin/src/main/kotlin/.../actions/PreviewActionSupport.kt`（改） | 新增 `hoverParseEnabled` 纯判定 |
| `intellij-plugin/src/main/kotlin/.../actions/StopSyntaxLearningAction.kt`（改） | 停止时把 `autoScan` 复位为 false |
| `intellij-plugin/src/main/resources/META-INF/plugin.xml`（改） | 注册 Action + `alt T` 默认键位 |
| `intellij-plugin/src/main/resources/messages/EnglishSyntaxBundle.properties`（改） | 新 Action 的文案键 |
| `intellij-plugin/src/main/resources/web/preview.ts`（改） | 新增 `ensureBlockId` 与 `nearestPreviewBlock` |
| `intellij-plugin/src/main/resources/web/bootstrap-entry.ts`（改） | `autoScan` 模式、`parseHoveredBlock`、keydown 兼底、`requestedBlocks` 集合化、短提示 |
| `intellij-plugin/src/main/resources/web/bundle.js`（重打） | rolldown 产物，提交进仓库 |

---

## Task 1: 快捷键描述符（KeyStroke → KeyboardEvent 判据）

**Files:**
- Create: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/bridge/HotkeyDescriptor.kt`
- Test: `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/bridge/HotkeyDescriptorTest.kt`

放在 `bridge/` 包而不是 `actions/`：它描述的是**发往 JS 的**判据，`markdown/` 已经依赖 `bridge/`，反过来让 `markdown/` 依赖 `actions/` 会绕出一个包环。

- [ ] **Step 1: 写失败测试**

创建 `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/bridge/HotkeyDescriptorTest.kt`：

```kotlin
package dev.codetui.englishsyntax.bridge

import java.awt.event.InputEvent
import java.awt.event.KeyEvent
import javax.swing.KeyStroke
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class HotkeyDescriptorTest {

  @Test
  fun `alt letter maps to a layout independent code`() {
    // 必须用 event.code 而非 event.key：macOS 上 ⌥T 的 key 是 "†"。
    val stroke = KeyStroke.getKeyStroke(KeyEvent.VK_T, InputEvent.ALT_DOWN_MASK)
    val descriptor = HotkeyDescriptor.from(stroke)
    assertEquals(
      HotkeyDescriptor("KeyT", altKey = true, ctrlKey = false, shiftKey = false, metaKey = false),
      descriptor,
    )
  }

  @Test
  fun `digits and every modifier bit are mapped`() {
    val stroke = KeyStroke.getKeyStroke(
      KeyEvent.VK_5,
      InputEvent.CTRL_DOWN_MASK or InputEvent.SHIFT_DOWN_MASK or InputEvent.META_DOWN_MASK,
    )
    val descriptor = HotkeyDescriptor.from(stroke)
    assertEquals("Digit5", descriptor?.code)
    assertEquals(false, descriptor?.altKey)
    assertEquals(true, descriptor?.ctrlKey)
    assertEquals(true, descriptor?.shiftKey)
    assertEquals(true, descriptor?.metaKey)
  }

  @Test
  fun `non alphanumeric keys are rejected so the page keeps the default`() {
    // 不为罕见键位堆映射表：返回 null，调用方回退 DEFAULT。
    assertNull(HotkeyDescriptor.from(KeyStroke.getKeyStroke(KeyEvent.VK_F7, 0)))
  }

  @Test
  fun `default descriptor matches the chrome extension hotkey`() {
    assertEquals("KeyT", HotkeyDescriptor.DEFAULT.code)
    assertTrue(HotkeyDescriptor.DEFAULT.altKey)
  }

  @Test
  fun `json payload uses the browser event field names`() {
    val json = HotkeyDescriptor.DEFAULT.toJson()
    assertEquals(
      """{"code":"KeyT","altKey":true,"ctrlKey":false,"shiftKey":false,"metaKey":false}""",
      json,
    )
  }

  @Test
  fun `action id matches the id registered in plugin xml`() {
    assertEquals("EnglishSyntax.ParseHoveredBlock", HotkeyDescriptor.PARSE_HOVERED_BLOCK_ACTION_ID)
  }
}
```

- [ ] **Step 2: 跑测试确认失败**

```bash
./gradlew :intellij-plugin:test --tests "dev.codetui.englishsyntax.bridge.HotkeyDescriptorTest"
```

Expected: 编译失败，`Unresolved reference: HotkeyDescriptor`。

- [ ] **Step 3: 写实现**

创建 `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/bridge/HotkeyDescriptor.kt`：

```kotlin
package dev.codetui.englishsyntax.bridge

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.awt.event.InputEvent
import java.awt.event.KeyEvent
import javax.swing.KeyStroke

/**
 * 预览页 keydown 兼底通道的键位判据：把 IDEA keymap 里的 [KeyStroke] 翻成浏览器
 * `KeyboardEvent` 的字段。
 *
 * 用 `event.code` 而不是 `event.key`：macOS 上 ⌥T 的 `key` 是 `†`（Option 是死键），
 * 只有 `code`（`"KeyT"`）与键盘布局无关。字母数字之外一律返回 null，让页面保持
 * [DEFAULT]——不为罕见键位堆映射表。
 */
data class HotkeyDescriptor(
  val code: String,
  val altKey: Boolean,
  val ctrlKey: Boolean,
  val shiftKey: Boolean,
  val metaKey: Boolean,
) {
  /** 下发给 `window.__englishSyntaxSetHotkey` 的载荷。字段名与浏览器事件一致。 */
  fun toJson(): String = buildJsonObject {
    put("code", code)
    put("altKey", altKey)
    put("ctrlKey", ctrlKey)
    put("shiftKey", shiftKey)
    put("metaKey", metaKey)
  }.toString()

  companion object {
    /** plugin.xml 里注册的动作 id；`HotkeyDescriptorTest` 与 `ActionStateTest` 双侧钉住一致性。 */
    const val PARSE_HOVERED_BLOCK_ACTION_ID = "EnglishSyntax.ParseHoveredBlock"

    /** 与 Chrome 扩展一致的默认键位 Alt+T。 */
    val DEFAULT = HotkeyDescriptor(
      code = "KeyT",
      altKey = true,
      ctrlKey = false,
      shiftKey = false,
      metaKey = false,
    )

    fun from(stroke: KeyStroke): HotkeyDescriptor? {
      val code = codeOf(stroke.keyCode) ?: return null
      val modifiers = stroke.modifiers
      return HotkeyDescriptor(
        code = code,
        altKey = modifiers and InputEvent.ALT_DOWN_MASK != 0,
        ctrlKey = modifiers and InputEvent.CTRL_DOWN_MASK != 0,
        shiftKey = modifiers and InputEvent.SHIFT_DOWN_MASK != 0,
        metaKey = modifiers and InputEvent.META_DOWN_MASK != 0,
      )
    }

    /**
     * 从当前 keymap 读实际绑定：用户改了键，兼底通道跟着改。
     * 无绑定、非字母数字键、无 IDE 上下文（纯协议测试）都回退 [DEFAULT]。
     */
    fun fromKeymap(actionId: String = PARSE_HOVERED_BLOCK_ACTION_ID): HotkeyDescriptor =
      runCatching {
        com.intellij.openapi.keymap.KeymapManager.getInstance()
          .activeKeymap
          .getShortcuts(actionId)
          .asSequence()
          .filterIsInstance<com.intellij.openapi.actionSystem.KeyboardShortcut>()
          .mapNotNull { from(it.firstKeyStroke) }
          .firstOrNull()
      }.getOrNull() ?: DEFAULT

    private fun codeOf(keyCode: Int): String? = when (keyCode) {
      in KeyEvent.VK_A..KeyEvent.VK_Z -> "Key" + ('A' + (keyCode - KeyEvent.VK_A))
      in KeyEvent.VK_0..KeyEvent.VK_9 -> "Digit" + (keyCode - KeyEvent.VK_0)
      else -> null
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
./gradlew :intellij-plugin:test --tests "dev.codetui.englishsyntax.bridge.HotkeyDescriptorTest"
```

Expected: BUILD SUCCESSFUL，6 个用例全过。

- [ ] **Step 5: 提交**

```bash
git add intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/bridge/HotkeyDescriptor.kt \
        intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/bridge/HotkeyDescriptorTest.kt
git commit -m "feat: 快捷键描述符——keymap 绑定翻成浏览器 event.code 判据"
```

---

## Task 2: `PARSE_BLOCK` 页面消息

**Files:**
- Modify: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/bridge/BridgeProtocol.kt`
- Test: `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/bridge/BridgeProtocolTest.kt`

JCEF 是不可信来源：每条消息按类型做**键白名单**，任何多余键、非法值都返回 null。

- [ ] **Step 1: 写失败测试**

在 `BridgeProtocolTest.kt` 的类里追加（文件已有 `private fun parse(text: String)` 辅助）：

```kotlin
  @Test
  fun `accepts parse block for the hotkey path`() {
    val message = parse(
      """{"version":1,"type":"PARSE_BLOCK","previewId":"p1","generation":2,"blockId":"b7","text":"Short line."}""",
    ) as PageMessage.ParseBlock
    assertEquals("p1", message.previewId)
    assertEquals(2, message.generation)
    assertEquals("b7", message.blockId)
    assertEquals("Short line.", message.text)
  }

  @Test
  fun `rejects parse block with extra or missing fields`() {
    // 多余键
    assertNull(
      parse(
        """{"version":1,"type":"PARSE_BLOCK","previewId":"p1","generation":0,"blockId":"b1","text":"t","target":"body"}""",
      ),
    )
    // 空 blockId
    assertNull(
      parse("""{"version":1,"type":"PARSE_BLOCK","previewId":"p1","generation":0,"blockId":"","text":"t"}"""),
    )
    // 缺 text
    assertNull(parse("""{"version":1,"type":"PARSE_BLOCK","previewId":"p1","generation":0,"blockId":"b1"}"""))
    // 夹带凭据
    assertNull(
      parse(
        """{"version":1,"type":"PARSE_BLOCK","previewId":"p1","generation":0,"blockId":"b1","text":"t","apiKey":"leak"}""",
      ),
    )
  }

  @Test
  fun `rejects parse block whose text exceeds the block limit`() {
    val huge = "a".repeat(BridgeProtocol.MAX_BLOCK_TEXT + 1)
    assertNull(
      parse("""{"version":1,"type":"PARSE_BLOCK","previewId":"p1","generation":0,"blockId":"b1","text":"$huge"}"""),
    )
  }
```

- [ ] **Step 2: 跑测试确认失败**

```bash
./gradlew :intellij-plugin:test --tests "dev.codetui.englishsyntax.bridge.BridgeProtocolTest"
```

Expected: 编译失败，`Unresolved reference: ParseBlock`。

- [ ] **Step 3: 写实现**

在 `bridge/BridgeProtocol.kt` 的 `sealed interface PageMessage` 里，`PreviewRendered` 之后追加：

```kotlin
  /**
   * 显式手势：JS 已经把段落定位好了，只解析这一段（快捷键悬停解析）。
   * 与 [VisibleBlocks] 分开是有意的——后者是自动扫描的批量上报，前者是用户手势，
   * 优先级、合批与暂停语义都不同。
   */
  data class ParseBlock(
    override val previewId: String,
    override val generation: Int,
    val blockId: String,
    val text: String,
  ) : PageMessage
```

在 `parsePageMessage` 的 `when (value.string("type"))` 里，`"PREVIEW_RENDERED"` 分支之后追加：

```kotlin
      "PARSE_BLOCK" -> {
        if (!hasOnlyKeys(value, "version", "type", "previewId", "generation", "blockId", "text")) return null
        val blockId = value.string("blockId")?.takeIf { it.isNotEmpty() } ?: return null
        val text = value.string("text") ?: return null
        if (text.length > MAX_BLOCK_TEXT) return null
        PageMessage.ParseBlock(previewId, generation, blockId, text)
      }
```

- [ ] **Step 4: 跑测试确认通过**

```bash
./gradlew :intellij-plugin:test --tests "dev.codetui.englishsyntax.bridge.BridgeProtocolTest"
```

Expected: BUILD SUCCESSFUL。注意此时 `PreviewSessionConnector` 的 `when (message)` 会因为新增 sealed 成员而编译报错（Kotlin 1.7 起非穷尽的 `when` 语句是 error，不是 warning）——真实分发在 Task 5 补。为了让本任务能独立编译通过，先在 `connect` 的 `when` 里临时加一行 `is PageMessage.ParseBlock -> Unit`，Task 5 再换成真实分发。


- [ ] **Step 5: 提交**

```bash
git add intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/bridge/BridgeProtocol.kt \
        intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/bridge/BridgeProtocolTest.kt \
        intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/session/PreviewSessionConnector.kt
git commit -m "feat: 新增 PARSE_BLOCK 页面消息（单块显式解析）"
```

---

## Task 3: 会话层单块显式派发

**Files:**
- Modify: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/session/PreviewSession.kt`
- Test: `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/session/PreviewSessionTest.kt`

- [ ] **Step 1: 给假服务加 `bypassCache` 记录**

在 `PreviewSessionTest.kt` 的 `FakeAnalysisService` 里，`var lastSentences: List<SentenceInput> = emptyList()` 之后加一行：

```kotlin
    var lastBypassCache: Boolean? = null
```

并在 `analyzeCore` 的 `lastSentences = sentences` 之后加一行：

```kotlin
      lastBypassCache = bypassCache
```

- [ ] **Step 2: 写失败测试**

在 `PreviewSessionTest.kt` 的类里追加四个用例：

```kotlin
  @Test
  fun `parse explicit block starts a session without scanning the whole document`() = runBlocking {
    // 快捷键可作为冷启动入口：置 RUNNING 但绝不触发全文扫描，否则「按段翻译」变成整篇翻译。
    val session = session()
    session.parseExplicitBlock("b1", "The service validates every response carefully today.")
    kotlinx.coroutines.delay(100)

    assertEquals(SessionState.RUNNING, session.state)
    assertEquals(0, scanRequests, "显式按段解析不得请求扫描")
    assertEquals(1, service.analyzeCalls)
  }

  @Test
  fun `parse explicit block dispatches at visible core priority without bypassing cache`() = runBlocking {
    val session = session()
    session.start()
    session.parseExplicitBlock("b1", "The service validates every response carefully today.")
    kotlinx.coroutines.delay(100)

    assertEquals(1, service.analyzeCalls)
    assertEquals(SchedulerPriority.ACTIVE_VISIBLE_CORE, service.lastPriority)
    assertEquals(false, service.lastBypassCache, "按段解析不绕缓存（绕缓存只属于重试）")
    assertTrue(service.lastSentences.all { it.sentenceId.startsWith("s-b1-") }, "只应派发这一段")
  }

  @Test
  fun `parse explicit block punches through pause`() = runBlocking {
    // 显式手势穿透暂停：否则 JS 打上的「解析中」竖条会一直亮到用户点继续。
    val session = session()
    session.start()
    session.pause()
    session.parseExplicitBlock("b1", "The service validates every response carefully today.")
    kotlinx.coroutines.delay(100)

    assertEquals(1, service.analyzeCalls, "暂停中显式按段解析仍应派发")
    assertEquals(SessionState.PAUSED, session.state, "显式手势不改变会话状态")
  }

  @Test
  fun `parse explicit block is idempotent for the same block`() = runBlocking {
    // 两条快捷键通道（IDEA Action + 页面 keydown）可能同时到达，重复按键也不能翻倍请求。
    val session = session()
    session.start()
    session.parseExplicitBlock("b1", "The service validates every response carefully today.")
    session.parseExplicitBlock("b1", "The service validates every response carefully today.")
    kotlinx.coroutines.delay(100)

    assertEquals(1, service.analyzeCalls)
  }

  @Test
  fun `streamed components still reach the page while paused`() = runBlocking {
    // 暂停穿透的配套：分片守卫从「必须 RUNNING」放宽到「非 STOPPED」。否则显式路径
    // 在暂停时只能等整批返回，卡片突然整块冒出来、没有流式过程。
    val session = session()
    session.start()
    session.pause()
    service.onStreamOnce = { sink ->
      sink.accept("s-b1-0", listOf(CoreComponent(0, 1, GrammarRole.SUBJECT, "该服务")))
    }
    session.parseExplicitBlock("b1", "The service validates every response carefully today.")
    kotlinx.coroutines.delay(100)

    assertTrue(sender.of("CORE_STREAM").isNotEmpty(), "暂停中显式派发的分片也要回推")
  }
```

- [ ] **Step 3: 跑测试确认失败**

```bash
./gradlew :intellij-plugin:test --tests "dev.codetui.englishsyntax.session.PreviewSessionTest"
```

Expected: 编译失败，`Unresolved reference: parseExplicitBlock`。

- [ ] **Step 4: 抽出 `registerFresh`**

把 `PreviewSession.kt` 里现有的 `onVisibleBlocks` 整体替换成下面三个函数（`onVisibleBlocks` 行为不变，只是把「分句分词 + 防环过滤 + 注册」抽出来给显式路径复用）。原来的 `blockIdOf` 私有函数保持不动，紧跟其后即可：

```kotlin
  /** JS 上报的可见块：分句分词并按状态合批派发。 */
  fun onVisibleBlocks(blocks: List<Pair<String, String>>, offscreen: Boolean = false) {
    if (state == SessionState.STOPPED) {
      LOGGER.warn("onVisibleBlocks: ${blocks.size} blocks dropped, session STOPPED (start order bug?)")
      return
    }
    LOGGER.info("onVisibleBlocks: ${blocks.size} blocks, state=$state")
    val fresh = registerFresh(blocks)
    if (fresh.isEmpty()) return
    if (state == SessionState.PAUSED) {
      pausedBlocks += fresh
      return
    }
    enqueueSentences(fresh, offscreen)
  }

  /**
   * 分句分词 + 注册 [SentenceRecord]，返回「尚未出结果、需要派发」的句子。
   *
   * 关键防环：只对尚未出结果的句子注册/入队。我们的渲染也是 DOM 变更，会触发 JS 侧
   * MutationObserver → rescan → 再次 VISIBLE_BLOCKS——若这里无条件把 READY 句重置为
   * DISCOVERED，就形成「缓存命中 → 再发 CORE_RESULT → 再触发 rescan」的无限循环
   * （CPU 狂转、请求风暴）。首次到达的句子才注册记录。
   */
  private fun registerFresh(blocks: List<Pair<String, String>>): List<SentenceInput> {
    val discovered = blocks.flatMap { (blockId, text) ->
      segmentBlock(text).mapIndexed { index, part ->
        SentenceInput(
          sentenceId = "s-${blockId}-${index}",
          text = part.text,
          tokens = tokenize(part.text),
        )
      }
    }
    return discovered.filter { input ->
      when (sentences[input.sentenceId]?.phase) {
        null -> {
          sentences[input.sentenceId] =
            SentenceRecord(SentencePhase.DISCOVERED, blockIdOf(blocks, input.sentenceId), input)
          true
        }
        // 保留原记录（含 token 供成分回填），允许重新派发
        SentencePhase.FAILED, SentencePhase.STALE -> true
        else -> false
      }
    }
  }

  /**
   * 显式手势：只解析指定的一段（快捷键悬停解析）。
   *
   * 会话未启动时**轻量启动**——置 RUNNING 但不触发全文扫描（JS 侧 `autoScan = false`
   * 保证 rescan 只注册不上报）。不合批、不绕缓存、穿透暂停，与 Chrome 端
   * `queueVisibleBlock(id, force = true)` 同构。
   *
   * 刻意绕开 [enqueueSentences]：`pendingBatch` 是共享的，`offscreen`/`allowPaused`
   * 按「最后一次入队者」取值，把显式块混进合批会让同批的普通块也拿到 allowPaused；
   * 单块派发本来也没有合批收益。
   */
  fun parseExplicitBlock(blockId: String, text: String) {
    if (state == SessionState.STOPPED) state = SessionState.RUNNING
    val fresh = registerFresh(listOf(blockId to text))
    if (fresh.isEmpty()) return
    LOGGER.info("parseExplicitBlock: blockId=$blockId sentences=${fresh.size} state=$state")
    scope.launch { dispatch(fresh, offscreen = false, allowPaused = true) }
  }
```

- [ ] **Step 5: 给 `dispatch` 加 `allowPaused`**

在 `PreviewSession.kt` 里改 `dispatch` 的签名与两道守卫。签名：

```kotlin
  private suspend fun dispatch(inputs: List<SentenceInput>, offscreen: Boolean, allowPaused: Boolean = false) {
```

顶部守卫，把 `if (state != SessionState.RUNNING) return` 换成：

```kotlin
    // 普通路径行为不变（PAUSED 直接返回）；只有显式手势传 allowPaused = true 穿透。
    if (state == SessionState.STOPPED) return
    if (state == SessionState.PAUSED && !allowPaused) return
```

流式分片守卫，把 `if (state == SessionState.RUNNING && capturedVersion == operationVersion) {` 换成：

```kotlin
          // 非 STOPPED 即可回推：applyOutcome 本来就不看暂停（在飞请求的最终结果照样
          // 渲染），分片却被丢掉，表现为「暂停后卡片突然整块冒出来、没有流式过程」。
          if (state != SessionState.STOPPED && capturedVersion == operationVersion) {
```

- [ ] **Step 6: 跑测试确认通过**

```bash
./gradlew :intellij-plugin:test --tests "dev.codetui.englishsyntax.session.PreviewSessionTest"
```

Expected: BUILD SUCCESSFUL，全部用例通过——**特别确认既有的 `pause blocks dispatch and resume replays` 仍绿**（普通路径的暂停语义没被放宽）。

- [ ] **Step 7: 提交**

```bash
git add intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/session/PreviewSession.kt \
        intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/session/PreviewSessionTest.kt
git commit -m "feat: 会话层支持单块显式派发（轻量启动、穿透暂停、不合批）"
```

---

## Task 4: 面板的 `autoScan` 开关与快捷键入口

**Files:**
- Modify: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/markdown/EnglishSyntaxPreviewPanel.kt`
- Test: `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/markdown/EnglishSyntaxPreviewPanelTest.kt`

必须排在 Connector（Task 5）之前——Connector 要用到这里新增的 `autoScan` 与 `requestParseHoveredBlock`。

- [ ] **Step 1: 修既有断言（会被第三个参数打破）**

`EnglishSyntaxPreviewPanelTest.kt` 的 `rendered event bumps generation and notifies the page` 里这一行：

```kotlin
    assertTrue(scripts[0].contains(", 1)"), "initialize 应带新 generation: ${scripts[0]}")
```

改成（脚本从 `initialize("p", 1);` 变成 `initialize("p", 1, false);`，原断言会红）：

```kotlin
    assertTrue(scripts[0].contains(", 1, "), "initialize 应带新 generation: ${scripts[0]}")
```

- [ ] **Step 2: 写失败测试**

在 `EnglishSyntaxPreviewPanelTest.kt` 的类里追加三个用例。

**断言一律匹配 `window.` 前缀的调用形式**：注入脚本里包含整个 `bundle.js`，而 bundle 内部也有 `__englishSyntaxParseHoveredBlock` / `__englishSyntaxSetHotkey` 这些标识符（全局赋值语句），只匹配裸标识符会把 bundle 也算进去，用例会假绿或数错。

```kotlin
  @Test
  fun `initialize carries the auto scan flag so manual mode never reports the whole document`() {
    // 默认手动模式：只要 findPanel 走过 wrap，注入末尾就会 notifyInitialize——默认自动扫描
    // 会让「点开工具菜单」或按一次快捷键就把整篇文档送去翻译。
    val scripts = mutableListOf<String>()
    val panel = EnglishSyntaxPreviewPanel(transportOverride = HostMessageTransport { scripts += it })

    panel.injectForTest()
    assertTrue(
      scripts.any { it.startsWith("window.__englishSyntaxInitialize(") && it.endsWith(", false);") },
      "默认 autoScan 应为 false: $scripts",
    )

    scripts.clear()
    panel.autoScan = true
    panel.requestScan()
    assertTrue(
      scripts.any { it.startsWith("window.__englishSyntaxInitialize(") && it.endsWith(", true);") },
      "整篇会话应下发 autoScan=true: $scripts",
    )

    panel.dispose()
  }

  @Test
  fun `parse hovered request before injection is deferred and flushed exactly once`() {
    // 冷启动第一次按键：bundle 还没注入，window.__englishSyntaxParseHoveredBlock 不存在，
    // 直接外发会静默丢失这一次按键。
    val scripts = mutableListOf<String>()
    val panel = EnglishSyntaxPreviewPanel(transportOverride = HostMessageTransport { scripts += it })

    panel.requestParseHoveredBlock()
    assertEquals(0, scripts.size, "未注入时不得外发: $scripts")

    panel.injectForTest()
    assertEquals(
      1,
      scripts.count { it.startsWith("window.__englishSyntaxParseHoveredBlock&&") },
      "注入后应补发一次: $scripts",
    )

    scripts.clear()
    panel.injectForTest()
    assertEquals(
      0,
      scripts.count { it.startsWith("window.__englishSyntaxParseHoveredBlock&&") },
      "标记已清，不得重复补发: $scripts",
    )

    panel.dispose()
  }

  @Test
  fun `injection pushes the fallback hotkey descriptor to the page`() {
    // 焦点在 JCEF 里时 IDEA Action 可能收不到按键，页面自带 keydown 兼底——键位要跟 keymap。
    val scripts = mutableListOf<String>()
    val panel = EnglishSyntaxPreviewPanel(transportOverride = HostMessageTransport { scripts += it })

    panel.injectForTest()

    val pushed = scripts.filter { it.startsWith("window.__englishSyntaxSetHotkey&&") }
    assertEquals(1, pushed.size, "须下发一次兼底键位: $scripts")
    assertTrue(
      pushed[0].contains("\"code\":\"KeyT\""),
      "无 IDE keymap 上下文时回退默认 Alt+T: ${pushed[0]}",
    )

    panel.dispose()
  }
```


`assertEquals` 已在文件顶部导入，无需新增 import。

- [ ] **Step 3: 跑测试确认失败**

```bash
./gradlew :intellij-plugin:test --tests "dev.codetui.englishsyntax.markdown.EnglishSyntaxPreviewPanelTest"
```

Expected: 编译失败，`Unresolved reference: autoScan` / `requestParseHoveredBlock`。

- [ ] **Step 4: 加字段**

在 `EnglishSyntaxPreviewPanel.kt` 里，紧跟现有的 `@Volatile private var disposed = false` 之后追加：

```kotlin
  /**
   * JS 侧 `rescan()` 是否自动上报全文块。
   *
   * **默认 false（手动模式）**：只要 `findPanel` 走过一次 `wrap`，注入末尾的
   * [notifyInitialize] 就会驱动 JS 扫描；默认 true 会让「按一次快捷键」或「点开工具菜单」
   * 把整篇文档送去翻译。整篇会话由 `PreviewSessionConnector.start` 置 true，
   * 停止时由 Stop Action 复位。
   */
  @Volatile
  var autoScan: Boolean = false

  /** bundle 是否已注入（全局入口是否存在）。 */
  @Volatile
  private var injected = false

  /** 注入完成前收到的按段解析请求，注入末尾补发一次。 */
  @Volatile
  private var pendingParseHovered = false
```

- [ ] **Step 5: `notifyInitialize` 带上 `autoScan`**

把现有的 `notifyInitialize` 改成：

```kotlin
  private fun notifyInitialize() {
    val previewIdLiteral = Json.encodeToString(JsonElement.serializer(), JsonPrimitive(previewId))
    execute("window.__englishSyntaxInitialize($previewIdLiteral, $generation, $autoScan);")
  }
```

- [ ] **Step 6: 新增快捷键入口**

在 `requestScan()` 之后追加：

```kotlin
  /**
   * 快捷键入口：让页面定位鼠标悬停的段落并回传 `PARSE_BLOCK`。
   *
   * bundle 尚未注入时（冷启动第一次按键）先记下意图，由 [injectWebResources] 末尾补发一次
   * ——否则 `window.__englishSyntaxParseHoveredBlock` 还不存在，这一次按键静默丢失。
   */
  fun requestParseHoveredBlock() {
    if (disposed) return
    if (!injected) {
      pendingParseHovered = true
      LOGGER.info("requestParseHoveredBlock: bundle not injected yet, deferring")
      return
    }
    execute("window.__englishSyntaxParseHoveredBlock&&window.__englishSyntaxParseHoveredBlock();")
  }
```

- [ ] **Step 7: 注入末尾下发键位并补发挂起的请求**

在 `injectWebResources()` 里，`execute("document.documentElement.setAttribute('data-english-syntax-dark', String($isDark));")` 之后、`LOGGER.info("inject: ...")` 之前插入：

```kotlin
    // 兼底 keydown 的键位跟 IDEA keymap 走：用户改键后页面通道同步改。
    val hotkey = dev.codetui.englishsyntax.bridge.HotkeyDescriptor.fromKeymap().toJson()
    execute("window.__englishSyntaxSetHotkey&&window.__englishSyntaxSetHotkey($hotkey);")
```

再把方法末尾的 `notifyInitialize()` 改成：

```kotlin
    notifyInitialize()
    injected = true
    if (pendingParseHovered) {
      pendingParseHovered = false
      LOGGER.info("inject: flushing deferred parse-hovered request")
      requestParseHoveredBlock()
    }
```

- [ ] **Step 8: 跑测试确认通过**

```bash
./gradlew :intellij-plugin:test --tests "dev.codetui.englishsyntax.markdown.EnglishSyntaxPreviewPanelTest"
```

Expected: BUILD SUCCESSFUL，9 个用例全过。

- [ ] **Step 9: 提交**

```bash
git add intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/markdown/EnglishSyntaxPreviewPanel.kt \
        intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/markdown/EnglishSyntaxPreviewPanelTest.kt
git commit -m "feat: 面板增加 autoScan 开关与按段解析入口（未注入时延迟补发）"
```

---

## Task 5: 接线 `PARSE_BLOCK` 与 `parseHovered`

**Files:**
- Modify: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/session/PreviewSessionConnector.kt`
- Test: `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/session/PageMessageWiringTest.kt`

四层同步的最后一层。曾经接线缺失导致一切页面消息无消费者，「翻译时一点变化都没有」且无任何报错——这个测试就是为此存在的。

- [ ] **Step 1: 写失败测试**

在 `PageMessageWiringTest.kt` 的类里追加：

```kotlin
  @Test
  fun `parse block from the page lightweight-starts the session and registers only that block`() = runBlocking {
    PreviewSessionConnector.parseHovered(panel, manager)
    assertEquals(false, panel.autoScan, "按段解析不得打开自动扫描（否则整篇被翻译）")

    panel.onPageMessage(
      """{"version":1,"type":"PARSE_BLOCK","previewId":"${panel.previewId}","generation":${panel.generation},"blockId":"b1","text":"The service validates every response today."}""",
    )
    delay(150)

    val session = manager.session(panel.previewId)
    assertNotNull(session, "parseHovered 接线后必须存在会话")
    assertEquals(SessionState.RUNNING, session.state, "冷启动应轻量启动会话")
    assertEquals(1, session.counts.discovered, "PARSE_BLOCK 必须注册进会话")
  }

  @Test
  fun `start opens auto scan for whole-document sessions`() {
    PreviewSessionConnector.start(panel, manager)
    assertEquals(true, panel.autoScan, "整篇会话必须允许 JS 自动上报全文块")
  }
```

- [ ] **Step 2: 跑测试确认失败**

```bash
./gradlew :intellij-plugin:test --tests "dev.codetui.englishsyntax.session.PageMessageWiringTest"
```

Expected: 编译失败，`Unresolved reference: parseHovered`（若 Task 2 加过临时的 `-> Unit`，`autoScan` 断言也会红）。

- [ ] **Step 3: 写实现**

在 `PreviewSessionConnector.kt` 里，把 `start` 换成下面这版，并在其后新增 `parseHovered`：

```kotlin
  fun start(panel: EnglishSyntaxPreviewPanel, manager: PreviewSessionManager) {
    connect(panel, manager)
    // 整篇会话：允许 JS 侧 rescan 自动上报全文块（按段解析路径保持 false）。
    panel.autoScan = true
    manager.start(panel.previewId, HostSender { panel.send(it) }) { kickoff(panel) }
  }

  /**
   * 快捷键按段解析的完整接线：先接线（JS 回传的 `PARSE_BLOCK` 必须先有消费者），
   * 再让页面定位悬停段。
   *
   * **不碰 `panel.autoScan`**——保持手动模式，除非已有整篇会话把它置过 true。
   * 会话是否已启动也不用管：`PreviewSession.parseExplicitBlock` 会在 STOPPED 时轻量启动。
   */
  fun parseHovered(panel: EnglishSyntaxPreviewPanel, manager: PreviewSessionManager) {
    connect(panel, manager)
    panel.requestParseHoveredBlock()
    LOGGER.info("parseHovered: requested for previewId=${panel.previewId}")
  }
```

再把 `connect` 里的 `when (message)` 分支补上（Task 2 若加过临时的 `-> Unit`，替换掉它）：

```kotlin
      when (message) {
        is PageMessage.VisibleBlocks -> session.onVisibleBlocks(message.blocks.map { it.blockId to it.text })
        is PageMessage.ParseBlock -> session.parseExplicitBlock(message.blockId, message.text)
        is PageMessage.DetailRequest ->
          session.launchDetailRequest(message.sentenceId, message.focusStart, message.focusEnd)
        is PageMessage.RetrySentence -> session.retrySentence(message.sentenceId)
        is PageMessage.PreviewReady, is PageMessage.PreviewRendered -> Unit
      }
```

- [ ] **Step 4: 跑测试确认通过**

```bash
./gradlew :intellij-plugin:test --tests "dev.codetui.englishsyntax.session.PageMessageWiringTest"
```

Expected: BUILD SUCCESSFUL，4 个用例全过。

- [ ] **Step 5: 提交**

```bash
git add intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/session/PreviewSessionConnector.kt \
        intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/session/PageMessageWiringTest.kt
git commit -m "feat: 接线 PARSE_BLOCK 与按段解析入口，整篇会话显式开启自动扫描"
```

---

## Task 6: Action、键位注册与停止复位

**Files:**
- Create: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/actions/ParseHoveredBlockAction.kt`
- Modify: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/actions/PreviewActionSupport.kt`
- Modify: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/actions/StopSyntaxLearningAction.kt`
- Modify: `intellij-plugin/src/main/resources/META-INF/plugin.xml`
- Modify: `intellij-plugin/src/main/resources/messages/EnglishSyntaxBundle.properties`
- Test: `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/actions/ActionStateTest.kt`

- [ ] **Step 1: 写失败测试**

在 `ActionStateTest.kt` 的类里追加两个用例，并在文件的 import 区加上：

```kotlin
import dev.codetui.englishsyntax.bridge.HotkeyDescriptor
```

```kotlin
  @Test
  fun `hover parse availability only depends on file type and runtime`() {
    // 冷启动、RUNNING、PAUSED 都应可按——所以签名里刻意没有 session/panel 参数：
    // Action 的 update() 一旦去 findPanel 就会 wrap + 注入 JCEF，那正是「点开工具菜单
    // 即假翻译」的成因。
    assertTrue(PreviewActionSupport.hoverParseEnabled(isMarkdownFile = true, jcefSupported = true))
    assertFalse(PreviewActionSupport.hoverParseEnabled(isMarkdownFile = false, jcefSupported = true))
    assertFalse(PreviewActionSupport.hoverParseEnabled(isMarkdownFile = true, jcefSupported = false))
  }

  @Test
  fun `plugin xml registers the hover parse action with the default alt T shortcut`() {
    // 兼底通道靠这个 id 去 keymap 读实际绑定；id 写歪了就永远拿不到用户改的键位。
    val xml = ActionStateTest::class.java.classLoader
      .getResourceAsStream("META-INF/plugin.xml")!!
      .use { it.readBytes().toString(Charsets.UTF_8) }

    assertTrue(
      xml.contains("id=\"${HotkeyDescriptor.PARSE_HOVERED_BLOCK_ACTION_ID}\""),
      "plugin.xml 的 action id 必须与 HotkeyDescriptor 用来读 keymap 的 id 一致",
    )
    assertTrue(xml.contains("first-keystroke=\"alt T\""), "默认键位应为 Alt+T")
  }
```

- [ ] **Step 2: 跑测试确认失败**

```bash
./gradlew :intellij-plugin:test --tests "dev.codetui.englishsyntax.actions.ActionStateTest"
```

Expected: 编译失败，`Unresolved reference: hoverParseEnabled`。

- [ ] **Step 3: 加纯判定函数**

在 `actions/PreviewActionSupport.kt` 的 `availability(...)` 之后追加：

```kotlin
  /**
   * 按段解析（快捷键）的可用性：**只看文件类型与运行时**，不看会话状态、不查面板。
   *
   * 冷启动时快捷键自己会轻量启动会话，所以 STOPPED 也要可按。签名里刻意没有
   * panel/session 参数——`update()` 一旦调 `findPanel` 就会 wrap + 注入 JCEF，
   * 展开 Tools 菜单这类高频事件就会触发「点开工具菜单即假翻译」。
   */
  fun hoverParseEnabled(isMarkdownFile: Boolean, jcefSupported: Boolean): Boolean =
    isMarkdownFile && jcefSupported
```

- [ ] **Step 4: 建 Action**

创建 `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/actions/ParseHoveredBlockAction.kt`：

```kotlin
package dev.codetui.englishsyntax.actions

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.project.Project
import com.intellij.ui.jcef.JBCefApp
import dev.codetui.englishsyntax.markdown.EnglishSyntaxPreviewPanel
import dev.codetui.englishsyntax.session.PreviewSessionConnector
import dev.codetui.englishsyntax.session.PreviewSessionManager

/**
 * 解析鼠标悬停的段落（默认 Alt+T）。会话未启动时轻量启动，只解析悬停那一段，
 * 不触发全文扫描。
 *
 * 焦点在 JCEF 预览里时这条 Action 可能收不到按键（取决于 JCEF 是否跑在离屏渲染模式），
 * 预览页自带 keydown 兼底通道（见 `web/bootstrap-entry.ts`），两条通道汇入同一个 JS 入口。
 */
class ParseHoveredBlockAction(
  private val managerProvider: (Project) -> PreviewSessionManager? = { _ ->
      com.intellij.openapi.components.service<dev.codetui.englishsyntax.PreviewSessionManagerService>().manager
    },
  private val jcefSupported: () -> Boolean = JBCefApp::isSupported,
) : AnAction() {

  override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

  override fun update(event: AnActionEvent) {
    val file = event.getData(CommonDataKeys.VIRTUAL_FILE)
    val isMarkdown = event.project != null &&
      file != null &&
      file.fileType.name.equals("Markdown", ignoreCase = true)
    // 刻意不查面板：findPanel 会 wrap + 注入 JCEF，放进高频 update() 就是假翻译回归。
    event.presentation.isEnabledAndVisible =
      PreviewActionSupport.hoverParseEnabled(isMarkdown, jcefSupported())
  }

  override fun actionPerformed(event: AnActionEvent) {
    val project = event.project ?: return
    val panel = EnglishSyntaxPreviewPanel.findPanel(project)
    if (panel == null) {
      LOGGER.warn("parseHovered: no preview panel found for project")
      ActionNotifier.warn(
        project,
        "未找到 Markdown 预览面板：请先打开一个 .md 文件的 Markdown 预览（IDEA 默认 JCEF 预览即可）",
      )
      return
    }
    val manager = runCatching { managerProvider(project) }.getOrNull()
    if (manager == null) {
      LOGGER.warn("parseHovered: manager unavailable (SQLite cache init failure lands here too)")
      ActionNotifier.warn(project, "句法学习服务不可用：请检查设置页配置")
      return
    }
    PreviewSessionConnector.parseHovered(panel, manager)
  }

  private companion object {
    private val LOGGER =
      com.intellij.openapi.diagnostic.Logger.getInstance(ParseHoveredBlockAction::class.java)
  }
}
```

- [ ] **Step 5: 注册 Action 与默认键位**

在 `intellij-plugin/src/main/resources/META-INF/plugin.xml` 里，`EnglishSyntax.Start` 那个 `<action>` 之后插入：

```xml
      <action id="EnglishSyntax.ParseHoveredBlock"
              class="dev.codetui.englishsyntax.actions.ParseHoveredBlockAction"
              text="解析鼠标悬停的段落"
              description="只解析鼠标悬停的那一段；会话未启动时自动轻量启动，不翻译整篇">
        <keyboard-shortcut first-keystroke="alt T" keymap="$default"/>
      </action>
```

- [ ] **Step 6: 补文案键**

在 `intellij-plugin/src/main/resources/messages/EnglishSyntaxBundle.properties` 里，`action.EnglishSyntaxStart.description=...` 那一行之后插入：

```properties
action.EnglishSyntaxParseHoveredBlock.text=解析鼠标悬停的段落
action.EnglishSyntaxParseHoveredBlock.description=只解析鼠标悬停的那一段；会话未启动时自动轻量启动，不翻译整篇
```

- [ ] **Step 7: 停止时复位 `autoScan`**

在 `actions/StopSyntaxLearningAction.kt` 的 `actionPerformed` 末尾，把 `manager.stop(previewId)` 换成：

```kotlin
    manager.stop(previewId)
    // 复位手动模式：停止后再按快捷键应只翻一段，而不是又把整篇送去翻译。
    panel.autoScan = false
```

- [ ] **Step 8: 跑测试确认通过**

```bash
./gradlew :intellij-plugin:test --tests "dev.codetui.englishsyntax.actions.ActionStateTest" \
  && ./gradlew :intellij-plugin:verifyPluginProjectConfiguration
```

Expected: 两条都 BUILD SUCCESSFUL（后者校验 plugin.xml 合法）。

- [ ] **Step 9: 提交**

```bash
git add intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/actions/ParseHoveredBlockAction.kt \
        intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/actions/PreviewActionSupport.kt \
        intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/actions/StopSyntaxLearningAction.kt \
        intellij-plugin/src/main/resources/META-INF/plugin.xml \
        intellij-plugin/src/main/resources/messages/EnglishSyntaxBundle.properties \
        intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/actions/ActionStateTest.kt
git commit -m "feat: 新增「解析鼠标悬停的段落」Action，默认 Alt+T"
```

---

## Task 7: 预览页的悬停块定位

**Files:**
- Modify: `intellij-plugin/src/main/resources/web/preview.ts`
- Test: `intellij-plugin/src/main/resources/web/preview.test.ts`

关键取舍：**显式手势不套用自动扫描的门槛**。`scanMarkdownBlocks` 要在整篇里躲开样板文字，所以有 20 字符与英文占比 60% 的限制；`nearestPreviewBlock` 只服务用户指到的那一处，套用后的症状是「鼠标明明停在段落上却报『未找到可解析的段落』」。

新测试的 DOM 一律用 `createElement` + `append` 搭，不用 `innerHTML`（仓库的 pre-commit 安全钩子会拦 `innerHTML` 赋值）。

- [ ] **Step 1: 写失败测试（上半：定位）**

在 `preview.test.ts` 顶部把 import 改成：

```typescript
import {
  ensureBlockId,
  nearestPreviewBlock,
  observeBlocks,
  resetScanRegistry,
  scanMarkdownBlocks,
} from "./preview";
```

在文件末尾追加：

```typescript
function el(
  tag: string,
  id: string,
  text: string,
  attrs: Record<string, string> = {},
): HTMLElement {
  const node = document.createElement(tag);
  node.id = id;
  node.textContent = text;
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  return node;
}

describe("nearestPreviewBlock", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  function hoverFixture(): void {
    const container = document.createElement("div");
    container.append(el("p", "para", "The service validates every response before returning it."));
    container.append(el("p", "short", "Too short."));
    container.append(el("p", "chinese", "这一段几乎没有英文单词，只有少量 API 术语。"));

    const inlineHost = el("p", "inline-host", "Wrapped ");
    inlineHost.append(el("em", "em", "emphasis"));
    container.append(inlineHost);

    // Mintlify 一类文档站整篇正文都是 <span>，外层 div 才是渲染盒子。
    const spanBlock = el("div", "span-block", "");
    spanBlock.append(el("span", "span-inner", "Docs sites render body text as spans."));
    container.append(spanBlock);

    const pre = document.createElement("pre");
    pre.append(el("code", "code", "const answer = theService.validates(everyResponse);"));
    container.append(pre);

    const table = document.createElement("table");
    const row = document.createElement("tr");
    row.append(el("td", "cell", "The table cell text is long enough here."));
    table.append(row);
    container.append(table);

    const card = el("div", "card", "", { "data-english-syntax-card": "true" });
    card.append(el("span", "in-card", "Rendered card text."));
    container.append(card);

    container.append(el("textarea", "editor", "Some text"));

    const editableHost = el("div", "editable-host", "", { contenteditable: "true" });
    editableHost.append(el("p", "editable", "Editable paragraph text here."));
    container.append(editableHost);

    document.body.append(container);
  }

  const at = (id: string): HTMLElement => document.getElementById(id)!;

  it("returns the hovered leaf block itself", () => {
    hoverFixture();
    expect(nearestPreviewBlock(at("para"))?.id).toBe("para");
  });

  it("walks up from an inline descendant to its block", () => {
    hoverFixture();
    expect(nearestPreviewBlock(at("em"))?.id).toBe("inline-host");
  });

  it("accepts a div whose only children are inline", () => {
    hoverFixture();
    expect(nearestPreviewBlock(at("span-inner"))?.id).toBe("span-block");
  });

  it("accepts short and non-english blocks that the auto scanner would skip", () => {
    // 显式手势不套用自动扫描的 20 字符 / 英文占比门槛。
    hoverFixture();
    expect(nearestPreviewBlock(at("short"))?.id).toBe("short");
    expect(nearestPreviewBlock(at("chinese"))?.id).toBe("chinese");
  });

  it("refuses code, tables, our own cards, and editable regions", () => {
    hoverFixture();
    expect(nearestPreviewBlock(at("code"))).toBeNull();
    expect(nearestPreviewBlock(at("cell"))).toBeNull();
    expect(nearestPreviewBlock(at("in-card"))).toBeNull();
    expect(nearestPreviewBlock(at("editor"))).toBeNull();
    expect(nearestPreviewBlock(at("editable"))).toBeNull();
  });

  it("handles null and text nodes", () => {
    hoverFixture();
    expect(nearestPreviewBlock(null)).toBeNull();
    expect(nearestPreviewBlock(at("para").firstChild)?.id).toBe("para");
  });
});
```

- [ ] **Step 2: 写失败测试（下半：blockId 分配）**

继续在 `preview.test.ts` 末尾追加：

```typescript
describe("ensureBlockId", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("assigns and persists a block id", () => {
    const element = el("p", "solo", "Anything.");
    document.body.append(element);

    const blockId = ensureBlockId(element);
    expect(blockId).toMatch(/^english-syntax-block-\d+$/);
    expect(element.getAttribute("data-english-syntax-block")).toBe(blockId);
    expect(ensureBlockId(element)).toBe(blockId);
  });

  it("shares the id counter with scanMarkdownBlocks so ids never collide", () => {
    const container = document.createElement("div");
    container.append(el("p", "a", "Alpha paragraph long enough for the scanner to accept it."));
    container.append(el("p", "b", "Beta paragraph long enough for the scanner to accept it."));
    document.body.append(container);

    // 显式路径先给 #a 分配 id，随后自动扫描应沿用它、并给 #b 一个不同的新 id。
    const manual = ensureBlockId(document.getElementById("a")!);
    const ids = scanMarkdownBlocks(container).map((block) => block.blockId);

    expect(ids).toContain(manual);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

```bash
cd intellij-plugin && npx vitest run src/main/resources/web/preview.test.ts
```

Expected: FAIL，`ensureBlockId is not a function` / `nearestPreviewBlock is not a function`。

- [ ] **Step 4: 写实现**

在 `preview.ts` 里，`resetScanRegistry()` 之后追加两个导出：

```typescript
/**
 * 取或分配 blockId。与 [scanMarkdownBlocks] 共用 `nextBlockId` 计数器——显式路径先给
 * 某元素分配过 id，之后自动扫描会沿用它，不会出现双 id。
 */
export function ensureBlockId(element: HTMLElement): string {
  const existing = element.getAttribute(BLOCK_ID_ATTRIBUTE);
  if (existing !== null) return existing;
  const blockId = `${BLOCK_SELECTOR_PREFIX}${nextBlockId++}`;
  element.setAttribute(BLOCK_ID_ATTRIBUTE, blockId);
  return blockId;
}

/**
 * 显式手势（快捷键悬停解析）的块定位：从悬停元素逐级向上找最近的可解析块。
 *
 * **刻意不套用自动扫描的取舍**：不要求 20 字符、不要求英文占比、不限定候选标签。
 * `scanMarkdownBlocks` 要在整篇里躲开边栏与样板文字，这里只服务用户指到的那一处——
 * 套用后的症状是「鼠标明明停在段落上，快捷键却报『未找到可解析的段落』」（短段落、
 * 术语行、中英混排行全中招）。保留的判据只有四条：排除区、渲染盒子、叶子块、文本非空。
 *
 * 按渲染盒子而非标签名认块：Mintlify 一类文档站整篇正文都是 `<span>`，只按标签名
 * 认块会把这类站点整页判成「未找到」。只认叶子块，否则往上会撞到包着整篇正文的容器。
 */
export function nearestPreviewBlock(target: EventTarget | null): HTMLElement | null {
  const start =
    target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  if (start === null) return null;
  if (start.closest("input,textarea,[contenteditable]") !== null) return null;

  for (let current: Element | null = start; current !== null; current = current.parentElement) {
    if (!(current instanceof HTMLElement)) continue;
    if (isExcluded(current)) continue;
    if (!isRendered(current)) continue;
    if (!isLeafBlock(current)) continue;
    if ((current.textContent ?? "").trim().length === 0) continue;
    return current;
  }
  return null;
}
```

- [ ] **Step 5: 让扫描路径复用同一个分配器**

把 `scanMarkdownBlocks` 结尾的 `.map(...)` 换成下面这版——效果与原来逐字相同，但「共用计数器」从约定变成了结构保证：

```typescript
    .map((element) => {
      registeredElements.add(element);
      return { blockId: ensureBlockId(element), element, text: (element.textContent ?? "").trim() };
    });
```

- [ ] **Step 6: 跑测试确认通过**

```bash
cd intellij-plugin && npx vitest run src/main/resources/web/preview.test.ts
```

Expected: PASS，含既有的 `scanMarkdownBlocks` / `observeBlocks` 用例全绿（尤其 `assigns stable block ids and marks elements` 与 `does not register the same element twice`，它们钉住 Step 5 的等价性）。

- [ ] **Step 7: 提交**

```bash
git add intellij-plugin/src/main/resources/web/preview.ts \
        intellij-plugin/src/main/resources/web/preview.test.ts
git commit -m "feat: 预览页悬停块定位（显式手势不套用自动扫描门槛）"
```

---

## Task 8: 手动扫描模式（`autoScan`）与完成账目集合化

**Files:**
- Modify: `intellij-plugin/src/main/resources/web/bootstrap-entry.ts`
- Test: `intellij-plugin/src/main/resources/web/bootstrap-lifecycle.test.ts`

这是「按段翻译」不变成「整篇翻译」的关键闸门。我们插入卡片引发的 mutation、以及保存后官方重渲染带来的 `initialize`（会 `resetScanRegistry()` 并清空 `lastVisibleFingerprint`），都会让 `rescan()` 重新上报全部块。

- [ ] **Step 1: 写失败测试**

在 `bootstrap-lifecycle.test.ts` 末尾追加一个 describe：

```typescript
describe("bootstrap-entry 手动扫描模式", () => {
  it("autoScan=false 时只注册不上报，浮层也不亮", async () => {
    const el = document.createElement("p");
    el.textContent = "The service validates every response before returning anything.";
    document.body.append(el);

    const initialize = (window as unknown as Record<string, unknown>)
      .__englishSyntaxInitialize as (previewId: string, generation: number, autoScan?: boolean) => void;

    initialize("pv-manual", 0, false);
    await flush();

    expect(posted.some((m) => m.type === "VISIBLE_BLOCKS")).toBe(false);
    const status = document.getElementById("english-syntax-status");
    expect(status?.hidden ?? true).toBe(true);
  });

  it("autoScan 省略时仍按整篇模式上报（既有调用方不受影响）", async () => {
    const el = document.createElement("p");
    el.textContent = "The service validates every response before returning anything.";
    document.body.append(el);

    const initialize = (window as unknown as Record<string, unknown>)
      .__englishSyntaxInitialize as (previewId: string, generation: number, autoScan?: boolean) => void;

    initialize("pv-default", 0);
    await flush();

    expect(posted.some((m) => m.type === "VISIBLE_BLOCKS")).toBe(true);
  });

  it("上报的块全部出结果后浮层显示完成", async () => {
    // requestedBlocks 集合替换 reportedBlockCount 的回归：完成判定不能因为
    // settledBlocks 里残留上一轮的块而提前或永不满足。
    const el = document.createElement("p");
    el.textContent = "The service validates every response before returning anything.";
    document.body.append(el);

    const initialize = (window as unknown as Record<string, unknown>)
      .__englishSyntaxInitialize as (previewId: string, generation: number, autoScan?: boolean) => void;
    const hostMessage = (window as unknown as Record<string, unknown>)
      .__englishSyntaxMessage as (message: Record<string, unknown>) => void;

    initialize("pv-complete", 0, true);
    await flush();

    const blocksMessage = posted.find((m) => m.type === "VISIBLE_BLOCKS");
    expect(blocksMessage).toBeDefined();
    const blocks = (blocksMessage as { blocks?: Array<{ blockId: string }> }).blocks ?? [];
    expect(blocks).toHaveLength(1);

    hostMessage(coreResultMessage("pv-complete", 0, blocks[0]!.blockId));
    await flush();

    const label = document.querySelector(".english-syntax-status-label")?.textContent ?? "";
    expect(label).toContain("完成");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd intellij-plugin && npx vitest run src/main/resources/web/bootstrap-lifecycle.test.ts
```

Expected: 第一个用例 FAIL（`VISIBLE_BLOCKS` 仍被上报——第三个参数当前被忽略）。

- [ ] **Step 3: 把计数器换成集合**

在 `bootstrap-entry.ts` 里，把

```typescript
const settledBlocks = new Set<string>();
const failedBlocks = new Set<string>();
let reportedBlockCount = 0;
```

换成

```typescript
const settledBlocks = new Set<string>();
const failedBlocks = new Set<string>();
/**
 * 已请求解析的块。按段解析是逐次累加，用计数器会让 settleBlock 的完成判定算错
 * （第二次按快捷键时 settledBlocks.size 已经 ≥ 1）。整篇路径整体替换、显式路径 add。
 */
const requestedBlocks = new Set<string>();
```

把 `settleBlock` 里的

```typescript
  if (reportedBlockCount > 0 && settledBlocks.size >= reportedBlockCount) {
```

换成

```typescript
  if (requestedBlocks.size > 0 && settledBlocks.size >= requestedBlocks.size) {
```

把 `clearAllActive()` 里的 `reportedBlockCount = 0;` 换成 `requestedBlocks.clear();`。

- [ ] **Step 4: 给运行时状态加 `autoScan`**

在 `bootstrap-entry.ts` 里，把 `interface RuntimeState` 的字段补一条：

```typescript
interface RuntimeState {
  renderer: PreviewRenderer;
  previewId: string;
  generation: number;
  /** 是否自动上报全文块。false = 手动模式（只有快捷键按段解析驱动）。 */
  autoScan: boolean;
  visibility: { start(): void; stop(): void } | null;
  observer: MutationObserver | null;
}
```

`ensureState()` 里的初始化对应改成：

```typescript
  state = { renderer, previewId: "", generation: 0, autoScan: true, visibility: null, observer: null };
```

- [ ] **Step 5: `rescan()` 加闸门，上报处改用集合**

在 `rescan()` 里，紧跟 `if (blocks.length === 0) return;` 之后插入：

```typescript
  // 手动模式（快捷键按段解析）：注册照旧（渲染器需要 blockId → element 映射），但绝不
  // 上报全量块。否则我们插入卡片引发的 mutation、以及官方重渲染后的 initialize
  // （会 resetScanRegistry + 清空指纹），都会把整篇文档送去翻译。
  if (!s.autoScan) return;
```

再把同一函数里的

```typescript
  reportedBlockCount = blocks.length;
  settledBlocks.clear();
  failedBlocks.clear();
```

换成

```typescript
  requestedBlocks.clear();
  for (const block of blocks) requestedBlocks.add(block.blockId);
  settledBlocks.clear();
  failedBlocks.clear();
```

- [ ] **Step 6: `initialize` 接收 `autoScan`**

把 `initialize` 的签名与前两行改成：

```typescript
function initialize(previewId: string, generation: number, autoScan = true): void {
  const s = ensureState();
  s.previewId = previewId;
  s.generation = generation;
  // 默认 true 兼容既有调用方；Kotlin 侧总是显式下发（EnglishSyntaxPreviewPanel.autoScan）。
  s.autoScan = autoScan;
```

其余部分不动。

- [ ] **Step 7: 跑测试确认通过**

```bash
cd intellij-plugin && npx vitest run src/main/resources/web/bootstrap-lifecycle.test.ts
```

Expected: PASS，含既有的 `RESTORE_ALL` 回归用例。

- [ ] **Step 8: 提交**

```bash
git add intellij-plugin/src/main/resources/web/bootstrap-entry.ts \
        intellij-plugin/src/main/resources/web/bootstrap-lifecycle.test.ts
git commit -m "feat: 预览页支持手动扫描模式，完成账目改用块集合"
```

---

## Task 9: 按段解析入口与 keydown 兼底

**Files:**
- Modify: `intellij-plugin/src/main/resources/web/bootstrap-entry.ts`
- Test: `intellij-plugin/src/main/resources/web/bootstrap-lifecycle.test.ts`

- [ ] **Step 1: 写失败测试（上半：解析入口）**

在 `bootstrap-lifecycle.test.ts` 末尾追加：

```typescript
describe("bootstrap-entry 按段解析", () => {
  const initialize = () =>
    (window as unknown as Record<string, unknown>).__englishSyntaxInitialize as (
      previewId: string,
      generation: number,
      autoScan?: boolean,
    ) => void;
  const parseHovered = () =>
    (window as unknown as Record<string, unknown>).__englishSyntaxParseHoveredBlock as (
      target?: Element | null,
    ) => void;
  const label = (): string =>
    document.querySelector(".english-syntax-status-label")?.textContent ?? "";

  it("只发一条单块 PARSE_BLOCK，且不上报整篇", async () => {
    const para = document.createElement("p");
    // 故意很短：显式手势不受自动扫描的 20 字符门槛限制。
    para.textContent = "Short.";
    const other = document.createElement("p");
    other.textContent = "Another paragraph long enough for the auto scanner to pick it up.";
    document.body.append(para, other);

    initialize()("pv-hover", 0, false);
    await flush();
    posted.length = 0;

    parseHovered()(para);
    await flush();

    const parsed = posted.filter((m) => m.type === "PARSE_BLOCK");
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.text).toBe("Short.");
    expect(parsed[0]!.blockId).toBe(para.getAttribute("data-english-syntax-block"));
    expect(posted.some((m) => m.type === "VISIBLE_BLOCKS")).toBe(false);
  });

  it("同一段 400ms 内重复触发只发一条", async () => {
    // 离屏渲染模式下同一次按键可能既到 IDE Action 又到 CEF，两条通道都会走到这里。
    const para = document.createElement("p");
    para.textContent = "Debounced paragraph text.";
    document.body.append(para);

    initialize()("pv-debounce", 0, false);
    await flush();
    posted.length = 0;

    parseHovered()(para);
    parseHovered()(para);
    await flush();

    expect(posted.filter((m) => m.type === "PARSE_BLOCK")).toHaveLength(1);
  });

  it("悬停不在正文上时提示且不发消息", async () => {
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.textContent = "const answer = 1;";
    pre.append(code);
    document.body.append(pre);

    initialize()("pv-miss", 0, false);
    await flush();
    posted.length = 0;

    parseHovered()(code);
    await flush();

    expect(posted.some((m) => m.type === "PARSE_BLOCK")).toBe(false);
    expect(label()).toContain("未找到");
  });

  it("悬停在已渲染的卡片上时提示该段已解析", async () => {
    const card = document.createElement("div");
    card.setAttribute("data-english-syntax-card", "true");
    const inner = document.createElement("span");
    inner.textContent = "Rendered card text.";
    card.append(inner);
    document.body.append(card);

    initialize()("pv-card", 0, false);
    await flush();
    posted.length = 0;

    parseHovered()(inner);
    await flush();

    expect(posted.some((m) => m.type === "PARSE_BLOCK")).toBe(false);
    expect(label()).toContain("该段已解析");
  });
});
```

- [ ] **Step 2: 写失败测试（下半：keydown 兼底）**

在同一个 `describe("bootstrap-entry 按段解析", ...)` 里，接在上面四个用例之后追加（放最后一个：它改的 `hotkey` 是模块级状态，末尾会复位）：

```typescript
  it("keydown 兼底逐位匹配修饰键，并随 setHotkey 改键", async () => {
    initialize()("pv-keyboard", 0, false);
    await flush();

    const setHotkey = (window as unknown as Record<string, unknown>).__englishSyntaxSetHotkey as (
      descriptor: unknown,
    ) => void;
    const clearLabel = (): void => {
      const node = document.querySelector(".english-syntax-status-label");
      if (node !== null) node.textContent = "";
    };
    const press = (init: KeyboardEventInit): void => {
      document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
    };

    // 修饰键必须逐一相等：Alt+Shift+T 不得触发绑定为 Alt+T 的入口。
    clearLabel();
    press({ code: "KeyT", altKey: true, shiftKey: true });
    await flush();
    expect(label()).toBe("");

    // 默认 Alt+T 触发。happy-dom 不实现 :hover，悬停查询取空 → 走「未找到」分支，
    // 这已足以证明入口被调用（用 event.code 而非 event.key：macOS 上 ⌥T 的 key 是 "†"）。
    press({ code: "KeyT", altKey: true });
    await flush();
    expect(label()).toContain("未找到");

    setHotkey({ code: "KeyJ", altKey: false, ctrlKey: true, shiftKey: false, metaKey: false });

    clearLabel();
    press({ code: "KeyT", altKey: true });
    await flush();
    expect(label()).toBe("");

    press({ code: "KeyJ", ctrlKey: true });
    await flush();
    expect(label()).toContain("未找到");

    // 复位：hotkey 是模块级状态，跨用例共享。
    setHotkey({ code: "KeyT", altKey: true, ctrlKey: false, shiftKey: false, metaKey: false });
  });
```

- [ ] **Step 3: 跑测试确认失败**

```bash
cd intellij-plugin && npx vitest run src/main/resources/web/bootstrap-lifecycle.test.ts
```

Expected: FAIL，`__englishSyntaxParseHoveredBlock is not a function`。

- [ ] **Step 4: 加短提示辅助**

在 `bootstrap-entry.ts` 里，紧跟现有的 `hideStatus()` 函数之后追加：

```typescript
/**
 * 短提示（2.5 秒自动隐藏）。快捷键路径没有菜单反馈，静默失败会让用户以为键坏了。
 * 用独立计时器，避免与「解析完成」的淡出互相取消。
 */
let flashTimer: ReturnType<typeof setTimeout> | undefined;

function flashStatus(text: string): void {
  clearTimeout(flashTimer);
  setStatus(text, "error", false);
  flashTimer = setTimeout(hideStatus, 2500);
}
```

- [ ] **Step 5: 加悬停查询与解析入口**

在 `bootstrap-entry.ts` 的 `initialize` 函数之前插入：

```typescript
/** CSS `:hover` 链的最深元素。happy-dom 等环境不实现该伪类，查询可能抛错，兜住返回 null。 */
function deepestHovered(): Element | null {
  let chain: NodeListOf<Element> | null = null;
  try {
    chain = document.querySelectorAll(":hover");
  } catch {
    chain = null;
  }
  if (chain === null || chain.length === 0) return null;
  return chain[chain.length - 1] ?? null;
}

/** 同一块的重复触发去抖：两条快捷键通道（IDEA Action + 本页 keydown）可能同时到达。 */
const PARSE_DEBOUNCE_MS = 400;
let lastParsedBlockId = "";
let lastParsedAt = 0;

/**
 * 解析一段并上报 `PARSE_BLOCK`。
 *
 * `target` 省略时查 CSS `:hover` 取最深元素——这是 Kotlin 的调用方式（`executeJavaScript`
 * 里不传参）。测试与将来可能的右键路径可以显式传入目标元素。
 */
function parseHoveredBlock(target?: Element | null): void {
  const s = state;
  if (s === null || s.previewId === "") return;
  const hovered = target === undefined ? deepestHovered() : target;
  if (hovered !== null && hovered.closest("[data-english-syntax-card]") !== null) {
    // 已经是卡片了：落到下面的「未找到」提示会误导用户。
    flashStatus("该段已解析");
    return;
  }
  const element = nearestPreviewBlock(hovered);
  if (element === null) {
    flashStatus("未找到可解析的段落");
    return;
  }
  const blockId = ensureBlockId(element);
  const now = Date.now();
  if (blockId === lastParsedBlockId && now - lastParsedAt < PARSE_DEBOUNCE_MS) return;
  lastParsedBlockId = blockId;
  lastParsedAt = now;

  s.renderer.registerBlock(blockId, element);
  requestedBlocks.add(blockId);
  settledBlocks.delete(blockId);
  failedBlocks.delete(blockId);
  postToHost({
    version: BRIDGE_VERSION,
    type: "PARSE_BLOCK",
    previewId: s.previewId,
    generation: s.generation,
    blockId,
    text: (element.textContent ?? "").trim(),
  });
  markBlockActive(blockId);
  setStatus("句法学习：正在解析 1 段…", "running");
}
```

`preview.ts` 的 import 同步补上两个新导出：

```typescript
import { ensureBlockId, nearestPreviewBlock, resetScanRegistry, scanMarkdownBlocks } from "./preview";
```

- [ ] **Step 6: 加键位状态与 keydown 兼底**

在 `bootstrap-entry.ts` 里，紧跟 `parseHoveredBlock` 之后插入：

```typescript
interface PageHotkey {
  code: string;
  altKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

/** 兼底通道键位。由 Kotlin 从 IDEA keymap 读实际绑定后下发；默认与 Chrome 扩展一致。 */
let hotkey: PageHotkey = {
  code: "KeyT",
  altKey: true,
  ctrlKey: false,
  shiftKey: false,
  metaKey: false,
};

function setHotkey(descriptor: unknown): void {
  if (descriptor === null || typeof descriptor !== "object") return;
  const candidate = descriptor as Partial<PageHotkey>;
  if (typeof candidate.code !== "string" || candidate.code === "") return;
  hotkey = {
    code: candidate.code,
    altKey: candidate.altKey === true,
    ctrlKey: candidate.ctrlKey === true,
    shiftKey: candidate.shiftKey === true,
    metaKey: candidate.metaKey === true,
  };
}
```

在文件末尾、现有的 `document.addEventListener("click", ...)` 之后插入：

```typescript
// 焦点在 JCEF 预览里时 IDEA Action 可能收不到按键（取决于 JCEF 是否跑在离屏渲染模式），
// 预览页自己兜住。修饰键逐位相等，避免 Alt+Shift+T 误触发绑定为 Alt+T 的入口。
document.addEventListener("keydown", (event) => {
  if (
    event.code !== hotkey.code ||
    event.altKey !== hotkey.altKey ||
    event.ctrlKey !== hotkey.ctrlKey ||
    event.shiftKey !== hotkey.shiftKey ||
    event.metaKey !== hotkey.metaKey
  ) {
    return;
  }
  event.preventDefault();
  parseHoveredBlock();
});
```

- [ ] **Step 7: 挂全局入口**

在文件末尾的全局赋值区（`w.__englishSyntaxSetTheme = setDarkMode;` 之后）追加：

```typescript
// 快捷键按段解析：Kotlin 的 Action 通道与本页 keydown 兼底通道共用这个入口。
w.__englishSyntaxParseHoveredBlock = parseHoveredBlock;
w.__englishSyntaxSetHotkey = setHotkey;
```

- [ ] **Step 8: 跑测试确认通过**

```bash
cd intellij-plugin && npx vitest run src/main/resources/web/bootstrap-lifecycle.test.ts
```

Expected: PASS。若 `悬停在已渲染的卡片上` 之后的用例出现意外的 `PREVIEW_RENDERED` 干扰，注意本文件的模块级状态跨用例共享（文件顶部已有注释说明）——每个用例都在 `initialize` + `await flush()` 之后再 `posted.length = 0`，遵守这个顺序即可。

- [ ] **Step 9: 提交**

```bash
git add intellij-plugin/src/main/resources/web/bootstrap-entry.ts \
        intellij-plugin/src/main/resources/web/bootstrap-lifecycle.test.ts
git commit -m "feat: 预览页按段解析入口与 keydown 兼底通道"
```

---

## Task 10: 重打 bundle 并跑全量门禁

**Files:**
- Modify: `intellij-plugin/src/main/resources/web/bundle.js`（rolldown 产物，提交进仓库）
- Test: `intellij-plugin/src/main/resources/web/bootstrap-lifecycle.test.ts`

`bundle.js` 是**提交进仓库**的产物，JCEF 注入的就是它。忘了重打的症状是「Kotlin 侧全绿、真机按快捷键毫无反应」——所以先加一条断言把这件事变成测试。

- [ ] **Step 1: 加产物断言**

在 `bootstrap-lifecycle.test.ts` 现有的 `committed JCEF bundle contains the current core token protocol` 用例里，追加两行：

```typescript
    expect(bundle).toContain("PARSE_BLOCK");
    expect(bundle).toContain("__englishSyntaxParseHoveredBlock");
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd intellij-plugin && npx vitest run src/main/resources/web/bootstrap-lifecycle.test.ts
```

Expected: FAIL，`expected '...' to contain 'PARSE_BLOCK'`（bundle 还是旧的）。

- [ ] **Step 3: 重打 bundle**

```bash
cd intellij-plugin && npm run bundle-web
```

Expected: 输出 `bundle.js written`。

- [ ] **Step 4: 跑 web 全量测试**

```bash
cd intellij-plugin && npm test
```

Expected: 全部测试文件 PASS。

- [ ] **Step 5: 跑 Kotlin 全量门禁**

```bash
./gradlew :intellij-plugin:test :intellij-plugin:buildPlugin :intellij-plugin:verifyPluginProjectConfiguration
```

Expected: BUILD SUCCESSFUL。注意：这轮跑的是**含仓库既有未提交改动**的工作区；若出现与本功能无关的失败，先确认它在本计划开工前就已经红（`git stash` 后重跑对比），不要顺手改。

- [ ] **Step 6: 提交**

```bash
git add intellij-plugin/src/main/resources/web/bundle.js \
        intellij-plugin/src/main/resources/web/bootstrap-lifecycle.test.ts
git commit -m "build: 重打 JCEF 预览 bundle（含按段解析入口）"
```

---

## Task 11: 架构文档与 CHANGELOG 同步

**Files:**
- Modify: `docs/architecture/modules.md`
- Modify: `docs/architecture/protocol.md`
- Modify: `docs/architecture/rendering.md`
- Modify: `docs/architecture/invariants.md`
- Modify: `docs/architecture/overview.md`
- Modify: `CHANGELOG.md`

`docs/architecture/` 要跟着代码走，这是仓库硬约定。注意这几份文档在工作区里**已有未提交改动**，在其现有内容之上追加，不要覆盖。

- [ ] **Step 1: `modules.md` 补新文件**

在 IntelliJ 侧模块表里补三行（位置分别贴着同目录的邻居）：

```markdown
| `bridge/HotkeyDescriptor.kt`                 | 兼底 keydown 的键位判据:IDEA keymap 的 KeyStroke → 浏览器 event.code + 四个修饰键;字母数字之外回退默认 Alt+T |
| `actions/ParseHoveredBlockAction.kt`         | 解析鼠标悬停的段落(默认 Alt+T):冷启动轻量启动会话,只翻这一段,不触发全文扫描 |
```

并把 `resources/web/preview.ts` 与 `session/PreviewSessionConnector.kt` 两行的职责描述补上新增职责（悬停块定位 `nearestPreviewBlock`/`ensureBlockId`；派发 `PARSE_BLOCK` 与 `parseHovered` 接线）。

- [ ] **Step 2: `protocol.md` 补消息与入口**

补 `PARSE_BLOCK` 页面消息一条：字段 `version/type/previewId/generation/blockId/text`，`blockId` 非空、`text` 受 `MAX_BLOCK_TEXT` 限制，由 `PreviewSessionConnector` 派发到 `PreviewSession.parseExplicitBlock`；说明它与 `VISIBLE_BLOCKS` 分开的理由（前者是用户手势：不合批、不绕缓存、穿透暂停；后者是自动扫描的批量上报）。

同时更新 Kotlin → JS 全局入口清单：`__englishSyntaxInitialize(previewId, generation, autoScan)` 新增第三参数、新增 `__englishSyntaxParseHoveredBlock(target?)` 与 `__englishSyntaxSetHotkey(descriptor)`。

- [ ] **Step 3: `rendering.md` 补悬停定位与手动模式**

补两段：

1. **显式手势的块定位**：`nearestPreviewBlock` 从悬停元素向上找最近的可解析块，判据只有排除区、渲染盒子（computed display 非空串且非 `inline*`）、叶子块、文本非空；不套用 `scanMarkdownBlocks` 的 20 字符与英文占比 60% 门槛。
2. **手动扫描模式**：`autoScan=false` 时 `rescan()` 只注册不上报；默认即 false，只有 `PreviewSessionConnector.start`（整篇会话）会置 true，Stop Action 复位。段落级「解析中」标记与完成账目改用 `requestedBlocks` 集合，整篇路径整体替换、按段路径 add。

- [ ] **Step 4: `invariants.md` 加一条**

按文件既有的四段式（规则 / 为什么 / 症状 / 守护测试）追加：

```markdown
### 显式手势不套用自动扫描的取舍(IntelliJ 侧)

**规则**:`nearestPreviewBlock` 只保留四条判据——排除区、渲染盒子、叶子块、文本非空。**不得**加上 `scanMarkdownBlocks` 的 20 字符下限与英文占比 60% 门槛,也不得限定候选标签名。

**为什么**:`scanMarkdownBlocks` 要在整篇里躲开边栏与样板文字,那些门槛是为「自动决定翻什么」服务的;快捷键悬停解析是用户已经指明了目标,再拿统计门槛去否决用户就是纯粹的误判。按渲染盒子而非标签名认块的理由同 Chrome 端:Mintlify 一类文档站整篇正文都是 `<span>`。

**症状**:鼠标明明停在段落上,按快捷键却提示「未找到可解析的段落」——短段落、术语行、中英混排行、span 排版的文档站全中招。

**守护测试**:`preview.test.ts`(`accepts short and non-english blocks that the auto scanner would skip`、`accepts a div whose only children are inline`)。
```

再追加一条手动模式的：

```markdown
### 手动扫描模式下 rescan 绝不上报

**规则**:`autoScan=false` 时 `rescan()` 只做 `registerBlock`,**不得** `postToHost(VISIBLE_BLOCKS)`。`EnglishSyntaxPreviewPanel.autoScan` 默认 false,只有 `PreviewSessionConnector.start` 置 true。

**为什么**:我们插入卡片本身就是 DOM 变更,会触发 MutationObserver → rescan;保存后官方 `updateDom` 重渲染还会经 `PREVIEW_RENDERED` 换代重发 `initialize`,那一路会 `resetScanRegistry()` 并清空 `lastVisibleFingerprint`,于是全部块重新变成「未注册」。任一条都会把整篇文档送去翻译。

**症状**:按一次快捷键(或按一次后保存文件),整篇文档全部开始翻译——「按段翻译」变成整篇翻译,长文档瞬间几十上百次模型请求。

**守护测试**:`bootstrap-lifecycle.test.ts`(`autoScan=false 时只注册不上报，浮层也不亮`)、`PageMessageWiringTest`(`parse block from the page lightweight-starts the session...` 断言 `panel.autoScan == false`)。
```

- [ ] **Step 5: `overview.md` 补链路支线**

在 IntelliJ 的链路时序段落后补一句支线：用户按 `Alt+T`（IDEA Action，或焦点在预览里时由页面 keydown 兼底）→ `ParseHoveredBlockAction` 经 `findPanel` 定位官方面板 → `PreviewSessionConnector.parseHovered` 接线并调 `panel.requestParseHoveredBlock()`（bundle 未注入时延迟到注入末尾补发）→ 页面 `parseHoveredBlock()` 查 `:hover` + `nearestPreviewBlock` 定位 → 回传 `PARSE_BLOCK` → `PreviewSession.parseExplicitBlock` 在 STOPPED 时轻量启动（置 RUNNING 但不扫描）并以 `ACTIVE_VISIBLE_CORE` 单块派发 → 其余与整篇路径完全相同。

- [ ] **Step 6: 跑文档漂移检查**

```bash
cd chrome-plugin && npm run docs:drift
```

Expected: 不报「相关文档未被碰过」。该脚本只判断相关文档有没有被改动，改得对不对靠人。

- [ ] **Step 7: CHANGELOG**

在 `CHANGELOG.md` 的「未发布 → 新增」段落里，IntelliJ 插件那条大条目之下追加一个子项（IntelliJ 插件仍是 `0.1.0-SNAPSHOT` 未发布，不单独升版本号）：

```markdown
  - **快捷键按段翻译**（默认 `Alt+T`，可在 IDEA Keymap 改键）：鼠标停在预览的某一段上按下即只解析那一段，会话未启动时自动轻量启动——不再只有「整篇翻译」一种模式，长文档不必为了看一段付出上百次模型请求。焦点在 JCEF 预览里时 IDEA 的按键可能不上交 IDE，预览页自带 keydown 兼底通道且键位跟随 keymap；鼠标不在正文上、或停在已翻译的卡片上，右下角浮层会给出明确提示（快捷键没有菜单反馈，静默失败会让用户以为键坏了）。
```

- [ ] **Step 8: 提交**

```bash
git add docs/architecture/modules.md docs/architecture/protocol.md docs/architecture/rendering.md \
        docs/architecture/invariants.md docs/architecture/overview.md CHANGELOG.md
git commit -m "docs: 同步快捷键按段翻译的模块、协议、渲染与不变量文档"
```

---

## Task 12: 真机验收（人工，不可自动化）

单测钉不住的三件事：JCEF 里 IDEA 按键会不会上交 IDE、CSS `:hover` 在 JCEF 里是否随鼠标更新、以及 `alt T` 在真实 keymap 里有没有冲突。跑 `./gradlew :intellij-plugin:runIde` 起沙箱 IDE，逐条过。

- [ ] **Step 1: 起沙箱 IDE 并配好模型**

```bash
./gradlew :intellij-plugin:runIde
```

在沙箱 IDE 里 `Settings → Tools → English Syntax Learning` 配一个可用 Profile（API key 只从环境变量取，别写进任何文件），然后打开一个长英文 `.md` 并开启 Markdown 预览。

- [ ] **Step 2: 冷启动按段解析（焦点在编辑器）**

点一下编辑器让焦点在源码侧，把鼠标移到预览里某一段英文上，按 `Alt+T`。

Expected：**只有那一段**变成卡片，其余段落原文不动；右下角浮层出现「正在解析 1 段…」，完成后显示「✓ 句法解析完成」并淡出。`Tools → 句法学习` 里「停止并恢复原文」变为可用（说明会话已 RUNNING）。

- [ ] **Step 3: 焦点在预览里再按一次（验证兼底通道）**

在预览里点一下（焦点进 JCEF），把鼠标移到**另一段**上按 `Alt+T`。

Expected：那一段也变成卡片。若这一步无反应，说明两条通道都没到——去 IDE 日志（`Help → Show Log in Finder`）搜 `parseHovered`，区分是 Action 没触发（日志无记录 → keymap 冲突或按键被 JCEF 吞了，兼底通道也没生效）还是页面侧没定位到（日志有记录、页面浮层提示「未找到可解析的段落」）。

- [ ] **Step 4: 边界**

- [ ] 鼠标停在代码块上按 `Alt+T` → 浮层提示「未找到可解析的段落」，无请求。
- [ ] 鼠标停在**已翻译的卡片**上按 `Alt+T` → 浮层提示「该段已解析」，无请求。
- [ ] 同一段连按三次 → 只发一次请求（IDE 日志里 `parseExplicitBlock` 只出现一次带 `sentences=N` 的记录）。
- [ ] `Tools → 暂停句法学习` 后再按 `Alt+T` → 那一段照样翻译出来（显式手势穿透暂停）。

- [ ] **Step 5: 不污染整篇**

保存一次 `.md`（触发官方预览重渲染），再按一次 `Alt+T`。

Expected：只有当次悬停的那一段被翻译，**整篇没有开始翻译**；之前翻译过的段落不自动恢复（已列为非目标，重按即命中缓存瞬时出卡）。

- [ ] **Step 6: 整篇模式没被改坏**

`Tools → 开始句法学习` → 整篇仍照旧全部翻译；再点「停止并恢复原文」→ 原文完整恢复、浮层隐藏；此后按 `Alt+T` → **只翻一段**（`autoScan` 已复位）。

- [ ] **Step 7: 记录结果**

把第 3 步的实际表现（Action 通道是否生效、是否靠兼底通道）写进 CHANGELOG 那条子项，替换掉「可能不上交 IDE」这种推测措辞。若 `alt T` 在真实 keymap 里冲突，改掉 `plugin.xml` 的 `first-keystroke` 并同步 CHANGELOG 与 spec 的决策记录表。

```bash
git add CHANGELOG.md
git commit -m "docs: 按段翻译快捷键真机表现补进变更日志"
```

---

## 完工标准

全部勾完时应同时满足：

1. `cd intellij-plugin && npm ci && npm test` 全绿；
2. `./gradlew :intellij-plugin:test :intellij-plugin:buildPlugin :intellij-plugin:verifyPluginProjectConfiguration` 全绿；
3. `bundle.js` 已重打并提交（Task 10 的产物断言保证这点）；
4. Task 12 的真机清单逐条过，第 3 步（焦点在 JCEF 里）的实际表现已写回 CHANGELOG；
5. 六份架构文档 + CHANGELOG 已同步，`npm run docs:drift` 不报缺漏；
6. `git log --oneline` 上是一串小提交，每个只含该任务的文件——仓库那 54 个既有未提交改动仍在工作区里，一个都没被卷进来。


















