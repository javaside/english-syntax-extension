# 页面渲染链路

content script 世界里发生的一切:怎么认出段落、怎么切句、什么时候发请求、卡片长什么样、怎么可逆地换回去。涉及文件都在 `chrome-plugin/src/content/` 与 `chrome-plugin/src/language/`(文件名不再逐个带前缀)。

## 1. 认段落(`document-scanner.ts`)

**两条路径,取舍刻意不同。** 把自动扫描的克制套到显式手势上,是本仓库出过的真实回归。

### `scanDocument(root)` —— 自动扫描

```
selectPrincipalRoot(root)                  先选出"正文容器"
  ├─ semanticRoot():  article / main / [role=main] 里挑得分最高的
  │     得分 = Σ(块文本长度 - 2 × 块内链接文本长度)
  │     并列时取作用域更小的、再取文档序更前的
  └─ fallbackRoot():  没有语义根时,给每个祖先累加后代块的分数,取最高
       │
       ▼
blockCandidates(principalRoot)             在容器内收候选块
  ├─ strict: h1-h6, p, li, blockquote
  └─ loose:  div/section/dd/td/figcaption/span/article/main 中
             「渲染为块」且「无块级子元素」且「未被 strict 块包含」的叶子
       │
       ▼
每个候选过 candidateText(element, automatic = true)
  ├─ isSafeElement:  是块候选 / 不在排除区 / 不含危险后代 / 布局可见
  ├─ 英文占优:  英文单词占全部字母词 ≥ 60%
  └─ 长度 ≥ 20 字符
```

- **排除区** `EXCLUSION_SELECTOR`:`nav, aside, footer, form, pre, code, script, style, noscript, template, svg, canvas, iframe, [contenteditable], [hidden], [aria-hidden=true]`。
- **危险后代** `UNSAFE_DESCENDANT_SELECTOR`:`button, input, textarea, select, video, audio, canvas, iframe, [contenteditable]`。**图片不在此列**——替换只是把原节点 `display:none`,退出时原样恢复,段落里夹插图不妨碍可逆性;而按钮 / 输入控件会连交互状态一起被藏掉。
- **为什么要收 loose 叶子**:只按标签名找会漏掉整类站点。Mintlify 一类文档站(含 Claude Code 自己的文档)整篇正文都是 `<span data-as="p">` 靠 CSS 渲染成块——真实页面实测覆盖率仅 10%。躲开边栏靠的是排除区与正文容器限制,不是标签名。

### `nearestSafeBlock(target)` —— 显式手势(选中 / 悬停 / 右键)

从光标处的元素往上逐级找第一个安全块。**不套用自动扫描的两条取舍**:

| 取舍                         | 自动扫描 | 显式手势 | 为什么                                                                                                        |
| ---------------------------- | -------- | -------- | ------------------------------------------------------------------------------------------------------------- |
| 必须落在得分最高的正文容器内 | ✅       | ❌       | 多 `<article>` 页面、SPA 换内容后缓存失效都会误伤,表现为"鼠标明明停在段落上,快捷键却报『未找到可解析的段落』" |
| 最短 20 字符                 | ✅       | ❌       | 用户指哪解析哪,歧义已由鼠标消解                                                                               |
| 按渲染盒子认块               | ✅       | ✅       | `isRenderedBlock()` 看 computed display,`LOOSE_BLOCK_SELECTOR` 只作兜底                                       |
| 只认叶子块                   | ✅       | ✅       | 否则往上找会撞到包着整篇正文的外层容器                                                                        |

额外:密码框 / textarea / contenteditable 一律拒绝。

> **happy-dom 里内联元素的 computed display 是空串而非 `"inline"`**,所以 `INLINE_DISPLAY` 正则把空串也算作非块。
>
> 给 `nearestSafeBlock` 加回任何"正文容器 / 最短长度"限制之前,先想清楚它只有显式调用方。

## 2. 切句与分词(`language/segmenter.ts`)

```
块文本 → segmentBlock()  Intl.Segmenter("en", {granularity:"sentence"})
                         + 缩写合并(Mr. Mrs. Ms. Dr. Prof. Sr. Jr. e.g. i.e. U.S.)
       → tokenize()      /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*|[^\s]/gu
                         每个 token 带 id / text / start / end / leadingWhitespace / punctuation
       → createSentenceId()  SHA-256(sessionId ␀ blockId ␀ order ␀ 规范化文本).slice(0,24)
```

`rebuildTokens()` 能无损还原原文——`learning-block` 渲染前会用它校验"句子与 token 对得上",对不上直接抛错。

注册候选时每 8ms 让一次事件循环(`yieldNow`),长页面不会卡住主线程。

## 3. 何时发请求

```
ViewportObserver(rootMargin: "100% 0px 100% 0px")
   │ 进入(含上下各一屏的)视野 → queueVisibleBlock(blockId)
   ▼
queueVisibleBlock(blockId, force?, immediate = force)
   ├─ 会话 stopped → 丢弃
   ├─ 会话 paused 且非 force → 记进 pausedBlocks,resume 时重放
   ├─ 全部句子已是 ready/failed/skipped → 跳过
   ├─ immediate → 立刻 analyzeBlocks([block])
   └─ 否则 → enqueueForBatch(block)
              桶 key = `${是否屏外}:${是否跳缓存}`
              攒满 MAX_SENTENCES_PER_REQUEST(6) 句,或 batchWindowMs(120ms) 到期 → flush
```

**为什么要合批**:视口一次放出十几个段落,而一个段落常常只有 1–2 句。逐段发的话,2210 字符的固定指令要在每条请求里重付一遍——单句请求里它占 **82%**。

**为什么按两个维度分桶**:`offscreen` 决定调度优先级,`bypassCache` 是请求级标记——混进同一条请求会波及别的块。

**哪些不进窗口**:

- 用户显式发起的单块解析(选中 / 悬停 / 右键)——用户正在等,不该为省 token 让他多等;
- 「重新解析可见段落」虽然也是用户发起,但它是**整屏批量操作**,合批更快,所以 `force = true, immediate = false`。

`enqueueForBatch` 里有一处顺序敏感:**先把条目写进 `pendingBatches` 再起定时器**。反过来的话,同步触发的定时器会在条目写入前就跑 `flushBatch`,找不到东西直接返回,这一批就永远发不出去。

## 4. 相位与版本守卫(`session-controller.ts`)

每次 `analyzeBlocks` 会 `++operationVersion` 并把它写进每个参与块的 `block.operationVersion`。响应回来后**逐块校验版本**——合批期间某个块被失效(内容变动 / 重新解析)时只跳过它,不连累同批。

`send()` 另有一层请求级守卫:响应的 `version` / `requestId` 必须匹配,且 `pendingRequestIds` 里记的版本号没变。

相位流转全部经 `transition()`,它会顺手刷新块级标记并上报状态。

## 5. 卡片(`learning-block.ts`)

### 为什么不是 custom element

content script 跑在隔离世界,`window.customElements` 是 `null`。所以 `SyntaxLearningBlock` **不是**自定义元素,而是一个普通类:它自己造一个 `<div data-syntax-learning-block>` 宿主、`attachShadow({mode:"open"})`,通过组合持有影子根。需要真实 DOM 节点的地方一律用 `.host`。

样式是文件顶部的 `STYLES` 常量,注入影子根内——不污染页面,也不受页面样式影响。

### 结构

```
#shadow-root
  <style>…</style>
  <div class="sentences">
    <section class="sentence" data-sentence-id="…" aria-label="原句">
      <button class="component" data-start-token data-end-token style="--syntax-role-color: …">
        <span class="role">主语</span>              ← 第 1 行
        <span class="english">The engineer</span>   ← 第 2 行(下划线用角色色)
        <span class="translation">工程师</span>      ← 第 3 行(可省)
      </button>
      …
    </section>
    <div class="detail" data-sentence-id data-start-token data-end-token>…</div>
  </div>
```

设计要点:

| 点                          | 说明                                                                                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **基线对齐**                | `.sentence` 用 `align-items: baseline`,按首行(角色标签)对齐。不能用 `end`——译文折行的高卡会把英文行顶上去                                                                                  |
| **成分首 token 去前导空格** | 否则下划线会伸进成分之间的间隙,模糊边界                                                                                                                                                    |
| **未覆盖的标点**            | 挂到**前一个成分的英文行**里(没有前置成分时挂句容器),不单独成卡                                                                                                                            |
| **句首独立标点**            | `align-self: end` 沉到行底,不参与三行基线组                                                                                                                                                |
| **并列分句编号**            | 有 ≥2 个 `COORDINATE_CLAUSE` 时,可见标签加圈码 ①②,`aria-label` 用普通数字(屏幕阅读器念得准)                                                                                                |
| **宽译文**                  | 超过 16 个字符的译文加 `.translation-wide`(`inline-size:0; min-inline-size:max(100%,16em)`),铺满卡宽而不是以 16em 窄列折行。Chrome 在内涵尺寸阶段解析不了含百分比的 `max()`,只能按长度分流 |
| **回显译文**                | 小参数本地模型偶尔把英文原文回填进 `translation`;`isEchoTranslation()` 判等即视为无译文,退回两行                                                                                           |
| **句子按源序就位**          | `#placeSentenceSection()` 保证重渲染 / 失败句不会被追加到末尾,把自己和它下面的详解面板挤到后面去                                                                                           |

### 详解面板的锚定

面板要落在**被点成分所在视觉行**的正下方,分两种插法:

- **那一行不是整句的最后一行**(长句折行):插在**句内**、该行最后一个成分之后。这种句子已占满栏宽,让它变块级(CSS `.sentence:has(.detail)`)没有视觉代价。
- **是最后一行**:插到**句子外面**、该视觉行最后一句之后。短句常与邻句共行,放句内会逼句子变块级,把邻居挤到下一行。

行判定依赖真实布局(`getBoundingClientRect`)。零尺寸环境(happy-dom 单测)所有矩形都是 0,所以要**显式判断有没有真实布局**(`height > 0`),否则数值比较会误判成"下面还有成分"而选错分支。

全页同时只开一个面板。再点同一个成分则关闭(toggle),不重新请求。

## 6. 可逆替换(`block-replacement.ts`)

```
show(original, block)
  ├─ 闸门: block.isReadyToReplace()      整块所有句子都已渲染
  ├─ inheritTypography()                 把原元素与父容器不同的 font-size/weight 搬到卡片宿主
  ├─ 保留 一个唯一 hide class + 注入 `.<class>{display:none!important}` 样式
  ├─ original.after(block.host)
  └─ 记下 original 原本有没有 class 属性

showPreview(original, block)              流式用:闸门放宽到 hasRenderedSentence()
restore()                                 移除 class(原本没有 class 属性就连空的一起删)、删样式、删卡片
currentElement(original)                  当前呈现的元素:替换中返回卡片,否则返回原元素
```

- **为什么要搬字号**:卡片插在原元素之后,继承的是**父容器**的字体。h2 换成卡片会掉到正文字号,整篇文章的层级在解析后全部消失。卡片内部用 `em` 相对单位,所以把字号字重搬到宿主即可等比缩放。只搬"与父容器不同"的值,普通段落照旧跟随页面。
- **为什么用唯一 class 而不是共享 class**:避免与页面已有类名冲突;`#reserveHiddenClass` 最多试 100 次,同时查全局 `reservedHiddenClasses` 与文档里是否已存在。
- 内部还挂一个 `MutationObserver`:原元素被页面从 DOM 里摘掉时自动 `restore()`,不留孤儿卡片。

## 7. 段落"解析中"标记(`block-activity-marker.ts`)

只绑 `requesting` 相位,由 `transition()` → `refreshBlockActivity()` 统一收口。挂载点取 `replacement.currentElement()`,**流式换成卡片后标记自动跟过去**。

三条硬约束:

1. **必须用 data 属性,不能用 class。** `BlockReplacement` 靠"原文本来有没有 class 属性"决定还原时删不删空 `class`;标记先一步加 class 会让它误判,在页面上留下 `<p class="">`(而此时标记已迁到卡片上,清理不到原文)。曾一次弄红三条 E2E。
2. **竖条必须用 `inset box-shadow` 而非 `border-left`。** 后者参与布局计算会让文字位移,推翻折行布局 E2E。
3. **重连彻底失败时要单独清标记。** `reconnectAndResume()` 用尽重试后直接返回,相位停在 `requesting`,不清的话竖条会一直亮着。

## 8. 进度胶囊(`progress-pill.ts`)

页面右下角,Shadow DOM(`:host{all:initial}`),`pointer-events:none`,纯展示。

文案分支:

| 状态            | 文案                                                    |
| --------------- | ------------------------------------------------------- |
| `stopped`       | 移除                                                    |
| `paused`        | `⏸ 已暂停 done/discovered`                              |
| 完成 + 预载未完 | `详解预载中 settled/total`                              |
| 完成(纯缓存)    | `✓ 缓存命中 ready/discovered`                           |
| 完成 + 有失败   | `✓ 完成,N 句失败` / `✓ 解析完成（N 个详解失败）`        |
| 完成            | `✓ 解析完成`,2.5 秒后淡出                               |
| 进行中          | `句法解析中 done/discovered`,纯缓存时动词换成`查询缓存` |

`done = ready + failed + skipped`。**必须计入 `skipped`**——纯缓存模式下未命中句都是 skipped,漏掉计数会一直不动。

另有 `notice(text)`:与会话无关的一次性提示。快捷键没有右键菜单那样的"已触发"反馈,且 SW 会丢弃页面命令的响应,所以"未找到可解析的段落"只能在页面里就地提示。

## 9. 详解预载(`detail-prefetcher.ts`)

每句 core 就绪即 `enqueue(sentence, core)`,并发 2,一次请求覆盖该句**所有缺失成分**。

计数是**成分级**的:`total += core.components.length`,`ready` / `failed` 按响应里的 `succeeded` / `failed` 累加。

| 结果        | 处理                                                                                                                                         |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `ok`        | 累加计数。**调用方契约:`succeeded + failed` 必须等于该句成分数**,否则计数永远对不上 total                                                    |
| `cancelled` | 回滚到队首、**不立即 pump**。等 `resume()` 或后续 `enqueue()` 再触发,避免未 pause 时(如 stop 触发的 cancelDocument)立即重发形成取消—重发循环 |
| `failed`    | 整句成分数计入 failed                                                                                                                        |

`discard(sentenceId)`(块失效时调用):还在排队的立即丢弃并扣 total;已完成或在飞的只释放 `trackedIds`(计数不动,在飞的跑完照常计数),使句子重新就绪后能再次 enqueue。

## 10. 动态内容与断线重连

### MutationObserver

监听 `documentElement` 的 `childList` / `characterData` / `subtree`,100ms 防抖后 `flushMutations()`:

- 命中已注册块 → 失效它、删掉句记录与块记录;
- 从变动根重新扫描发现新块。

**轻量会话(快捷键冷启动、未做全页扫描)不做第二步**——它只该解析用户指到的那一段,不该被页面变动带着自动发现新内容。

### 断线重连

端口断开 → `reconnectAndResume()`:按 `[0, 250, 500, 1000]` ms 重试连接;成功后把所有未达终态的块重新入队(paused 时放进 `pausedBlocks`)。全部失败则清掉所有块的活动标记。

## IntelliJ 插件的渲染链路(预览页)

Chrome 端在真实网页里替换 DOM;IntelliJ 端在 **IDEA 默认的官方 Markdown 预览**(`MarkdownJCEFHtmlPanel`,官方 JCEF 渲染)里做同样的事,但取舍不同:

- **不自建预览**:插件**不注册** `html.panel.provider`,不创建自己的浏览器——渲染、滚动、缩放全是官方的。`EnglishSyntaxPreviewPanel` 只是官方 JCEF 面板的**能力层包装**:`MarkdownJCEFHtmlPanel` 继承 `JCEFHtmlPanel` → `JBCefBrowser`,`executeJavaScript` 与 `JBCefJSQuery.create` 都是公开 API,不反射、无需用户切换 provider。
- **注入**:包装在页面 load 完成(立即或 `onLoadEnd`)后经 `executeJavaScript` 注入 web 资源,分两步:① bootstrap 脚本(样式 + `EnglishSyntaxHost.post` 绑定到 `JBCefJSQuery`);② `web/bundle.js` **原样**作为独立的 `executeJavaScript` 调用执行。**不能**把 bundle 塞进页面上下文的 `eval()`/`new Function`/动态 `<script>`——官方预览页 CSP 无 `unsafe-eval`,`script-src` 只允许官方静态资源,字符串求值会被静默拦截;`executeJavaScript` 是浏览器 API 级注入,不受页面 CSP 约束(见 [invariants.md](./invariants.md))。bundle 由 `scripts/bundle-web.mjs` 用 rolldown 从 `bootstrap-entry.ts` 打包成单文件 IIFE。Kotlin→JS 走一组固定全局入口(`__englishSyntaxInitialize(previewId, generation, autoScan)`/`__englishSyntaxReload`/`__englishSyntaxScrollTo`/`__englishSyntaxMessage`/`__englishSyntaxSetTheme`/`__englishSyntaxParseHoveredBlock`/`__englishSyntaxSetHotkey`,参数一律 JSON 序列化,绝不拼接模型文本;逐条说明见 [protocol.md](./protocol.md));JS→Kotlin 走 `EnglishSyntaxHost.post(jsonText)`(JBCefJSQuery 注入的回调)。
- **渲染换代**:官方每次 `updateDom` 会重写整个 body、清掉插件卡片。JS 侧 MutationObserver 检测「卡片从有到无」的边沿,上报 `PREVIEW_RENDERED`;Kotlin 侧递增 generation、经 `onGenerationChanged` 清空会话旧记录,再重发 `__englishSyntaxInitialize(新 generation)` 重新扫描——旧响应不会污染新 DOM。**但「从有到无」的边沿必须排除「我方主动清卡」**:`RESTORE_ALL`(点「停止并恢复原文」)会触发 `renderer.restoreAll()` 删卡,这个 DOM 变更若被当成官方重渲染上报 `PREVIEW_RENDERED`,Kotlin 换代重扫后 `rescan()` 又会亮出「正在解析」进度浮层——停止后进度重现(回归)。因此 JS 侧在 `RESTORE_ALL` 分支**同步把「有卡片」基线 `previewHadCards` 复位为 false**(赶在 MutationObserver 微任务回调之前),让我方清卡不构成 true→false 边沿(见 [invariants.md](./invariants.md))。
- **消息接线**:JS→Kotlin 的页面消息(`VISIBLE_BLOCKS`/`DETAIL_REQUEST`/`RETRY_SENTENCE`/`PARSE_BLOCK`)由 `PreviewSessionConnector` 统一派发进会话——Start Action 调 `PreviewSessionConnector.start(panel, manager)`,顺序固定「先接线、后启动会话」(会话初始 `STOPPED`,先到的 `VISIBLE_BLOCKS` 会被丢弃);按段解析走同文件的 `parseHovered(panel, manager)`,同样先接线,但**不置 `autoScan`**、也不启动整篇会话(轻量启动由 `PreviewSession.parseExplicitBlock` 自己完成)。驱动 JS 重扫必须执行 `window.__englishSyntaxInitialize`(`panel.requestScan()`),向 `onPageMessage` 合成 `PREVIEW_READY` 只是 Kotlin 侧自言自语、JS 收不到。曾因「移除自建预览面板」重构把接线整体丢掉:每层单测全绿,端到端却无一条页面消息到达会话,表现为点了开始后毫无变化也无报错(见 [invariants.md](./invariants.md))。
- **面板定位**:Action 拿面板**不能**对 `selectedEditor` 做 `as? EnglishSyntaxPreviewPanel`——面板不是 `FileEditor` 本身,那样永远 null。`EnglishSyntaxPreviewPanel.findPanel` 从 `FileEditorManager` 取当前文件的所有 editor(展开 `TextEditorWithPreview` 的 `previewEditor`),找 `MarkdownPreviewFileEditor`,经其公开的 `PREVIEW_BROWSER` UserData(`Key<WeakReference<MarkdownHtmlPanel>>`)取回**官方** `MarkdownJCEFHtmlPanel` 并包装(包装缓存挂在面板 UserData 上,previewId 稳定)。
- **扫描**:`preview.ts` 的 `scanMarkdownBlocks` 只认 Markdown 渲染产物——候选固定为 `h1-h6/p/li/blockquote`(blockquote 只取安全叶子),排除 `pre/code/table/.math/.katex/.mermaid/.footnotes/交互控件`与插件自己的卡片;英文占比 ≥ 60%、最短 20 字符。Chrome 端"正文容器得分"那套在这里不适用。
- **显式手势的块定位**:快捷键按段解析不走 `scanMarkdownBlocks`,而是 `nearestPreviewBlock(target)` 从悬停元素逐级向上找最近的可解析块,判据只有四条——不在排除区、是渲染盒子(computed display 非空串且非 `inline*`)、是叶子块、文本非空;**不套用 `scanMarkdownBlocks` 的 20 字符下限与英文占比 60% 门槛**,也不限定候选标签名(取舍与 Chrome 端 `nearestSafeBlock` 同源:用户已经用鼠标指明目标,再拿统计门槛去否决就是纯粹误判——见 [invariants.md](./invariants.md))。`ensureBlockId` 与自动扫描共用 `nextBlockId` 计数器,同一元素先后走两条路径也只有一个 blockId。定位结果一律有反馈:定位失败提示「未找到可解析的段落」,悬停在已解析的卡片上提示「该段已解析」(`flashStatus`,2.5 秒淡出)——快捷键没有菜单那样的"已触发"反馈,静默失败会让用户以为键坏了。两条快捷键通道(IDEA Action 与页面 keydown 兼底)可能同时到达,故同一块 400ms 去抖。
- **手动扫描模式**:`autoScan=false` 时 `rescan()` 只做 `registerBlock`(渲染器需要 blockId → element 映射),**绝不** `postToHost(VISIBLE_BLOCKS)`。`EnglishSyntaxPreviewPanel.autoScan` **默认 false**,只有 `PreviewSessionConnector.start`(整篇会话)置 true、`StopSyntaxLearningAction` 停止后复位 false;`parseHovered` 刻意不碰它。否则我方插卡引发的 mutation、以及官方重渲染后的 `initialize`(会 `resetScanRegistry` 并清空可见指纹)都会把整篇文档送去翻译(见 [invariants.md](./invariants.md))。段落级「解析中」标记与完成账目改用 `requestedBlocks: Set<string>`(取代此前的计数器):整篇路径整体替换,按段路径 `add`——用计数器的话第二次按快捷键时 `settledBlocks.size` 已经 ≥ 1,完成判定会立刻误判为"全部完成"。
- **可见性**:IntersectionObserver(rootMargin 上下各一屏),不支持时退化为 rAF 节流的 scroll/resize。**start() 先用几何判定(getBoundingClientRect 与视口±一屏)播种首批可见块并立即上报**——JCEF 里 IO 的初始回调不可靠,只依赖它会导致 `VISIBLE_BLOCKS` 永远不发出(见 [invariants.md](./invariants.md))。
- **卡片**:`render.ts` 用 `data-english-syntax-hidden` 隐藏原文、在其后插入 `data-english-syntax-card` 卡片;`restoreAll` 精确删除插件节点与 data 属性。模型文本一律 `textContent`,杜绝 `<img onerror>` 注入。**结构与视觉对齐 Chrome 端 `learning-block.ts`**:三行组件(角色标签/英文原文/中文译文,`roles.ts` 与 Chrome 端 `grammar.ts`/`ROLE_COLORS` 逐值同源)、按角色着色的细下划线、中文角色标签、失败句保留原文 + 「重新解析」按钮、详解面板为「标注行(①角色+英文摘录) + 解释列表 + 语法点 + 整体说明」。**句子惰性注册**:sentenceId 由 Kotlin 权威生成(`s-{blockId}-{index}`),JS 端不做分句;`CORE_STREAM`/`CORE_RESULT`/`CORE_ERROR` 携带 `blockId`,渲染器在消息首次到达时按 blockId 注册句子再渲染——曾因生产路径从不注册句子(`registerSentence` 被当成测试辅助),`#sentences` 永远为空、`entry === undefined` 直接 return,卡片永远不出现。**句子排列 = 源序,不是消息到达序**:`#blockSentenceOrder` 累积的是句子 ID,`#repaintBlock` 渲染前按 sentenceId 末尾 `index` 数值升序重排(`bySourceOrder`)——流式分片按模型输出到达可能先吐后半句,若不重排 final 卡片英文顺序会和原文对不上(Chrome 端 `setExpectedSentenceIds` 同语义,这里直接从 sentenceId 推断,宿主无需额外传序)。
- **generation 双闸**:页面收到旧 generation 的 `CORE_RESULT`/`DETAIL_*` 一律丢弃(见 [invariants.md](./invariants.md))。
- **详解**:点击成分经 bridge 发 `DETAIL_REQUEST`,面板同时只展开一个详解面板;再次点击同一成分关闭。**面板锚定在「被点成分所在视觉行」正下方**(移植 Chrome 端 `setDetailLoading` 的行判定:被点成分下面还有同句成分时插到该行最后一个成分之后,否则插到句子之后;零尺寸环境退化插句子后)。曾因 append 到卡片末尾,面板跑到很远的下面。
- **状态反馈**:点「开始句法学习」立即弹 BALLOON;预览页右下角注入 `#english-syntax-status` 浮层(带转圈 spinner,对齐 Chrome 进度胶囊)——扫描完成显示「正在解析 N 段」,每个 `CORE_RESULT`/`CORE_ERROR` 更新「已处理 k 句」,`SESSION_STATE`(Toggle 暂停/继续时由 Kotlin 推送)显示「⏸ 已暂停 / ready/discovered」,`RESTORE_ALL` 隐藏。
- **段落级「解析中」标记**:上报 `VISIBLE_BLOCKS` 后对可见块打 `data-english-syntax-active`(左侧蓝色竖条 + 淡底色 + 呼吸动画,`inset box-shadow` 不参与布局),流式卡片出现后标记跟到卡片上(`renderer.currentElement`),该块首个 `CORE_RESULT`/`CORE_ERROR` 到达即撤;全部可见块出结果后浮层显示「✓ 句法解析完成」并在 2.5s 后自动隐藏——Chrome 端 `BlockActivityMarker`/进度胶囊同款语义。
- **Action 反馈**:Tools 菜单三个 Action 的失败不再静默——`ActionNotifier` 走 `EnglishSyntax` 通知组弹 BALLOON(未找到预览面板 / 服务不可用 / 当前文件尚未开始);Toggle/Stop 的 `update` 与 `actionPerformed` 都 `runCatching` 包住 manager 获取,初始化异常(如 SQLite 缓存)只导致按钮禁用或通知,不再冒泡成 ActionUpdater 的 SEVERE。**每个 markdown 文件独立会话**:三个 Action 一律按「当前文件面板」定位自己的 previewId,再取该 previewId 的 session——不再依赖单一 `activePreviewId`,因此一个文件在进行中不会阻塞其它文件开始/暂停/停止(Pause/Stop 只作用于当前文件)。**但 `update()` 只准用只读的 `findWrappedPanel`(不 `wrap`/`attach`/注入)**:`findPanel` 有注入副作用,放进高频调用的 `update()` 会让「点开工具菜单」就自动初始化 JS、扫描全文、打解析中标记——Kotlin 侧却无 RUNNING 会话,表现为假翻译且暂停/停止灰色(见 [invariants.md](./invariants.md))。`findPanel` 只在点击按钮的 `actionPerformed` 里用。
