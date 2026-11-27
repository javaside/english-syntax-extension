# 追问对话气泡受限 Markdown 渲染 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 双端 ChatPanel 的 assistant 气泡把模型输出的受限 markdown 子集渲染成真实排版，XSS 面与现状持平。

**Architecture:** 新增零依赖渲染器 `chat-markdown.ts`（双端平行各一份），只经 `createElement`/`textContent`/`append` 构造 DOM，永不 `innerHTML`。ChatPanel 的 assistant 渲染路径改走它；user/error/notice 气泡与协议、history、缓存、提示词全部不动。

**Tech Stack:** TypeScript + Vitest(happy-dom)（chrome-plugin 与 intellij-plugin web 各一套）；CSS（Chrome 走 shadow DOM 内 STYLES，IntelliJ 走 preview.css 亮/暗两套）。

**Spec:** `docs/superpowers/specs/2026-11-27-chat-markdown-rendering-design.md`

## Global Constraints

- 渲染器只用 `createElement` / `textContent` / `append` / `replaceChildren`，**禁止 `innerHTML` / `insertAdjacentHTML` / `outerHTML` / `DocumentFragment.innerHTML`**——违反即审查不过。
- 只渲染 assistant 气泡（含 assistant pending）；user / error / notice 保持 `textContent`。
- `ChatTurn.content`、桥协议、SW 消息、提示词、contracts、缓存**零改动**。
- 双端渲染器为平行实现（不共用代码），测试同构；文件名相同：`chat-markdown.ts` / `chat-markdown.test.ts`。
- 模块地图守卫：`architecture-docs.test.ts` 要求双端每个实现文件出现在 `docs/architecture/modules.md`（Task 5 落实，任务 5 之前跑不了全量 chrome 测试套件的原因即此）。
- lint 基线：恰好 1 个错误（`options.test.ts` 的 `no-unnecessary-type-assertion`），不得新增。
- 提交信息用中文主题。

## Review Focus

- 未闭合 `**` 字面显示、未闭合 ``` 围栏按代码块渲染到结尾（流式中途态）→ Task 1 Step 1 测试 9。
- 数学乘号 `2 * 3`、`a * b * c` 不被斜体化（侧翼规则）→ Task 1 测试 4。
- 模型输出的 `<script>` / 事件属性字面显示、不产生元素节点 → Task 1 测试 11。
- `renderMarkdown` 连续调用是全量替换（流式逐片重渲安全）→ Task 1 测试 12。
- user / error / notice 气泡不渲染 markdown（含 `**` 原样）→ Task 2 / Task 4 集成测试。
- 纯文本回答观感不变（`p` + `br`；现有 chat-panel 测试全绿）→ Task 2 / Task 4 回归。

---

### Task 1: Chrome 端渲染器 chat-markdown.ts

**Files:**
- Create: `chrome-plugin/src/content/chat-markdown.ts`
- Test: `chrome-plugin/src/content/chat-markdown.test.ts`

**Interfaces:**
- Produces: `export function renderMarkdown(target: HTMLElement, text: string): void`——清空 target 后填入解析结果。元素全部经 `target.ownerDocument.createElement` 创建（双端通用）。产出元素只用语义标签：`p` / `h4` / `ul` / `ol` / `li` / `pre` / `code` / `blockquote` / `strong` / `em` / `br`，**不发 class**——样式由两侧选择器 `.message.assistant p` 等承担。

- [ ] **Step 1: 写失败测试**（`chat-markdown.test.ts`，测试环境 happy-dom，与 chat-panel.test.ts 同款；每个用例新建一个 `div` 当 target）

测试清单（每个 `it` 一条，断言 DOM 结构而非 innerHTML）：

1. 纯文本 → 单个 `p` 子元素，textContent 原样；段内单个 `\n` → `p` 内出现 `br` 且前后文本分段。
2. 空行（`\n\n`）分段 → 两个 `p`。
3. `**加粗**` → `strong`（textContent `加粗`）；`*斜体*` → `em`；`` `代码` `` → 行内 `code`。
4. 侧翼规则：`2 * 3 与 a * b` 不产生 `em`（`*` 后是空格不作开标记）；`**中文**`（无空格侧翼）正常成对。
5. 未闭合 `**标记` → `p` 内字面文本含 `**标记`，无 `strong`。
6. 行内代码优先：`` 包含 `a **b** c` 结尾 `` → `code` 内字面 `a **b** c`。
7. `# 一级`、`## 二级`、`###### 六级` → 都是 `h4` 元素。
8. `- 甲\n- 乙` → `ul`>`li`×2；`1. 甲\n2. 乙` → `ol`>`li`×2（li 文本不含标记符）。
9. 围栏代码块 ``` 围起多行 → `pre`>`code`，内容逐字保留、**不做行内解析**（内部 `**x**` 字面）；未闭合 ``` 延续到文本结尾仍成 `pre`。
10. `> 引用一行` → `blockquote`，文本不含 `>`。
11. 安全：输入含 `<script>alert(1)</script>` 与 `<img src=x onerror=alert(2)>` → `target.querySelectorAll("script,img").length === 0`，且某 `p` 的 textContent 字面包含这两个串。
12. 全量替换：先 render A 再 render B → `target.children.length` 只反映 B，且 querySelector 不留 A 的节点。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd chrome-plugin && npx vitest run src/content/chat-markdown.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现渲染器**

实现要点（测试未钉死的算法选择，在此定死）：

- 顶层循环按行扫：围栏行（```` ``` ```` 前缀）切换代码态直到闭围栏或 EOF；标题行 `^#{1,6}\s+`；列表行 `^[-*+]\s+` / `^\d+\.\s+`（同类连续行合并成一个 `ul`/`ol`）；引用行 `^>\s?`；其余聚成段落（到空行或块级边界）。
- 段落聚合：`\n` 保留为 `br`；段落与列表/标题/代码块/引用之间互不吞并。
- 行内解析（只作用于段落、li、blockquote 的文本）：先扫 `` ` `` 配对切成代码段（保护内容），再对普通段扫 `**`（开标记后非空白、闭标记前非空白、内容非空）成 `strong`，再扫单 `*` 成 `em`。`_` 一律不解析。
- 所有文本一律 `textContent` 赋值；绝无 innerHTML。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd chrome-plugin && npx vitest run src/content/chat-markdown.test.ts`
Expected: PASS 全绿。

- [ ] **Step 5: Commit**

```bash
git add chrome-plugin/src/content/chat-markdown.ts chrome-plugin/src/content/chat-markdown.test.ts
git commit -m "feat: 追问气泡受限 markdown 渲染器(Chrome 端)"
```

---

### Task 2: Chrome 端 ChatPanel 接线 + shadow DOM 样式

**Files:**
- Modify: `chrome-plugin/src/content/chat-panel.ts`（`#bubble`、`renderStreamedText`、`completeAssistantTurn`、`STYLES`）
- Test: `chrome-plugin/src/content/chat-panel.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 1 的 `renderMarkdown(target: HTMLElement, text: string): void`。

- [ ] **Step 1: 写失败集成测试**（追加到 `chat-panel.test.ts`）

1. `completeAssistantTurn` 后 assistant 气泡含 `**加粗**` 答案 → `bubble.querySelector("strong")` 非空、`strong.textContent === "加粗"`；`bubble.textContent` 含 `加粗` 且不含 `**`。
2. `appendUserTurn("**不是粗体**")` → user 气泡无 `strong`，textContent 字面含 `**`。
3. `renderStreamedText` 收到含 `**粗` 的中途片 → 无 `strong`（未闭合字面）；下一片收到 `**粗体**` 闭合 → `strong` 出现（验证逐片全量重渲）。
4. `restoreHistory`（assistant 轮含 markdown）→ 气泡同样渲染出 `strong`。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd chrome-plugin && npx vitest run src/content/chat-panel.test.ts`
Expected: 新用例 FAIL（现在全是 textContent）。

- [ ] **Step 3: 接线实现**

- import `renderMarkdown`；`#bubble` 对 `variant` 含 `assistant` 的分支走 `renderMarkdown(bubble, text)`，`user`/`error` 分支保持 `textContent`（签名 `variant` 不变）。
- `renderStreamedText` 与 `completeAssistantTurn` 里 `bubble.textContent = ...` 改成 `renderMarkdown(bubble, ...)`（pending 气泡文案「正在生成回答…」纯文本，渲染后观感不变）。
- `restoreHistory` 无需改动（走 `#bubble`）。文件头注释「回答气泡纯文本 + pre-wrap（不引 markdown）」改为新事实：受限 markdown 渲染、XSS 面仍只有 createElement/textContent。
- `STYLES` 追加（保持既有缩进与注释风格）：
  - `.message.assistant { white-space: normal; }`（撤 pre-wrap，换行改由 `br` 承担；user/error 仍 pre-wrap）。
  - assistant 侧元素样式各一条：`p`（`margin: 0 0 .35em`，末个不加也无妨）、`h4`（`margin: .45em 0 .2em; font-size: 1.05em; font-weight: 700`）、`ul`/`ol`（`margin: .2em 0; padding-left: 1.4em`）、`blockquote`（`margin: .3em 0; padding-left: .7em; border-left: 3px solid #d4d4d8; color: #52525b`）、`pre`（`margin: .3em 0; padding: 6px 8px; background: #f4f4f5; border-radius: 6px; overflow-x: auto; font-size: 12px`）、行内 `code`（`background: #f4f4f5; padding: 1px 4px; border-radius: 4px; font-size: 12px`）。

- [ ] **Step 4: 跑测试确认通过（含既有回归）**

Run: `cd chrome-plugin && npx vitest run src/content/chat-panel.test.ts src/content/chat-markdown.test.ts`
Expected: PASS（既有用例「第一段:主谓宾结构。第二段:修饰关系。」等纯文本断言不受影响）。

- [ ] **Step 5: Commit**

```bash
git add chrome-plugin/src/content/chat-panel.ts chrome-plugin/src/content/chat-panel.test.ts
git commit -m "feat: Chrome 追问气泡接线受限 markdown 渲染与样式"
```

---

### Task 3: IntelliJ 端渲染器 chat-markdown.ts（平行实现）

**Files:**
- Create: `intellij-plugin/src/main/resources/web/chat-markdown.ts`
- Test: `intellij-plugin/src/main/resources/web/chat-markdown.test.ts`

**Interfaces:**
- Produces: 与 Task 1 完全相同的 `renderMarkdown(target: HTMLElement, text: string): void`（平行实现，非 import——双端代码体系独立，2026-11-10 spec 非目标「共用代码」）。

- [ ] **Step 1: 写失败测试**

测试清单与 Task 1 Step 1 的 12 条**同构**（用例名与断言逐字对齐；环境差异仅 import 路径 `./chat-markdown`）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd intellij-plugin && npx vitest run src/main/resources/web/chat-markdown.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现渲染器**

把 Task 1 的 `chat-markdown.ts` 平移过来，文件头注释按仓库习惯改写（说明与 Chrome 端平行实现、rolldown 经 `bootstrap-entry.ts` 自动入 bundle）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd intellij-plugin && npx vitest run src/main/resources/web/chat-markdown.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add intellij-plugin/src/main/resources/web/chat-markdown.ts intellij-plugin/src/main/resources/web/chat-markdown.test.ts
git commit -m "feat: 追问气泡受限 markdown 渲染器(IntelliJ 端,平行实现)"
```

---

### Task 4: IntelliJ 端 ChatPanel 接线 + preview.css 亮暗样式

**Files:**
- Modify: `intellij-plugin/src/main/resources/web/chat-panel.ts`（`#bubble`、`renderStreamedText`、`completeAssistantTurn`、头注释）
- Modify: `intellij-plugin/src/main/resources/web/preview.css`（assistant 气泡样式，亮 + 暗）
- Test: `intellij-plugin/src/main/resources/web/chat-panel.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 3 的 `renderMarkdown`。

- [ ] **Step 1: 写失败集成测试**

与 Task 2 Step 1 的 4 条同构（选择器换成 `bubble.querySelector("strong")`，等价）。另加一条：`failAssistantTurn` 的 error 气泡含 `**x**` → 无 `strong`、字面显示。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd intellij-plugin && npx vitest run src/main/resources/web/chat-panel.test.ts`
Expected: 新用例 FAIL。

- [ ] **Step 3: 接线实现**

- `chat-panel.ts` 与 Task 2 同款三处改动（`#bubble` 分支、流式、落定）；头注释同步改写。
- `preview.css`（类名前缀体系照旧）：
  - `.english-syntax-chat-message--assistant { white-space: normal; }`（其余消息类保留 pre-wrap）。
  - `.english-syntax-chat-message--assistant p/h4/ul/ol/blockquote/pre/code` 样式，数值与 Task 2 的 STYLES 对齐；颜色用现有变量/字面值与亮色主题一致（对照 381-430 行既有写法）。
  - 暗色块（`:root[data-english-syntax-dark="true"]` 段，对照 575-590 行）补 assistant 侧 `pre`/行内 `code` 的暗色背景与 `blockquote` 边框色。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd intellij-plugin && npm test`
Expected: PASS（web 侧全套）。

- [ ] **Step 5: Commit**

```bash
git add intellij-plugin/src/main/resources/web/chat-panel.ts intellij-plugin/src/main/resources/web/preview.css intellij-plugin/src/main/resources/web/chat-panel.test.ts
git commit -m "feat: IntelliJ 追问气泡接线受限 markdown 渲染与亮暗样式"
```

---

### Task 5: 文档同步 + 双端门禁

**Files:**
- Modify: `docs/architecture/modules.md`（双端各加 `chat-markdown.ts` 一行；守卫测试要求文件名出现）
- Modify: `docs/architecture/rendering.md`（追问气泡渲染：受限子集、assistant-only、渲染器元素结构）
- Modify: `docs/architecture/invariants.md`（新不变量一条：chat 气泡只经受限渲染器、禁 innerHTML、守护测试 = 双端 chat-markdown 安全用例）
- Modify: `CHANGELOG.md`（未发布条目）

- [ ] **Step 1: 改四份文档**（按上表内容）

- [ ] **Step 2: Chrome 全量门禁**

```bash
cd chrome-plugin && npm test && npx playwright test && npm run lint && npm run format:check && npm run build && npm run docs:drift
```

Expected: 全绿；lint 恰 1 个既有错误；architecture-docs 模块地图用例因新文件已补而 PASS。

- [ ] **Step 3: IntelliJ 全量门禁**

```bash
(cd intellij-plugin && npm ci && npm test) && ./gradlew :intellij-plugin:test :intellij-plugin:buildPlugin :intellij-plugin:verifyPluginProjectConfiguration
```

Expected: 全绿。（gradle 网络挂起时按既有绕法：`--no-configuration-cache`，见仓库记忆「本机联网构建坑」。）

- [ ] **Step 4: Commit**

```bash
git add docs/architecture/modules.md docs/architecture/rendering.md docs/architecture/invariants.md CHANGELOG.md
git commit -m "docs: 追问气泡 markdown 渲染的模块地图/渲染链路/不变量同步"
```
