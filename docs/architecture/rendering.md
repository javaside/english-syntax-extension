# 页面渲染链路

content script 世界里发生的一切:怎么认出段落、怎么切句、什么时候发请求、卡片长什么样、怎么可逆地换回去。

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

Chrome 端在真实网页里替换 DOM;IntelliJ 端在 JCEF 渲染的 Markdown 预览页里做同样的事,但取舍不同:

- **扫描**:`preview.ts` 的 `scanMarkdownBlocks` 只认 Markdown 渲染产物——候选固定为 `h1-h6/p/li/blockquote`(blockquote 只取安全叶子),排除 `pre/code/table/.math/.katex/.mermaid/.footnotes/交互控件`与插件自己的卡片;英文占比 ≥ 60%、最短 20 字符。Chrome 端"正文容器得分"那套在这里不适用。
- **可见性**:IntersectionObserver(rootMargin 上下各一屏),不支持时退化为 rAF 节流的 scroll/resize。
- **卡片**:`render.ts` 用 `data-english-syntax-hidden` 隐藏原文、在其后插入 `data-english-syntax-card` 卡片;`restoreAll` 精确删除插件节点与 data 属性。模型文本一律 `textContent`,杜绝 `<img onerror>` 注入。
- **generation 双闸**:页面收到旧 generation 的 `CORE_RESULT`/`DETAIL_*` 一律丢弃(见 [invariants.md](./invariants.md))。
- **详解**:点击成分经 bridge 发 `DETAIL_REQUEST`,面板同时只展开一个详解面板;再次点击同一成分关闭。
