# 追问对话气泡的受限 markdown 渲染（双端）— 设计

日期：2026-11-27
状态：待用户批准

## 动机

chat 提示词（双端逐字一致）只约束「中文、简短、分段」，对格式只字未提；chat 模型默认输出
markdown（`**粗体**`、列表、`###`、反引号）。而双端 ChatPanel v1 刻意只走
`textContent` + `pre-wrap`（2026-11-03 / 2026-11-10 spec 的非目标：避免注入面与解析依赖），
于是 `**xxx**` 原样显示，观感是「渲染坏了」。本设计让面板正确显示受限子集，渲染层改动
不碰提示词 / 协议 / 缓存 / contracts（chat 本就无缓存、无版本号联动）。

## 目标

- assistant 气泡把常见 markdown 标记渲染成真实排版（粗体、斜体、行内代码、代码块、
  标题、有序/无序列表、引用、分段、段内换行）。
- XSS 面与现状持平：渲染**只经 `createElement` / `textContent` / `append`**，
  永不 `innerHTML`。模型输出的原始 HTML / 事件属性天然变字面文本。
- 双端行为一致（平行实现、各自 vitest 钉住，照 chat-panel.ts 平移惯例）。

## 非目标 / 反目标

- 非目标：Chrome/IntelliJ 共用代码（两套 DOM 体系，沿用既有非目标）；全量
  CommonMark；链接可点（`[t](u)` 原样显示，见下）；改提示词措辞或 contracts。
- 反目标：**任何 `innerHTML` / `insertAdjacentHTML` 路径**；渲染器接触
  apiKey / 桥协议字段；markdown 语义进入 history / 协议（`ChatTurn.content`
  仍存模型原始文本，渲染只发生在显示层）。

## 支持的子集（我的默认，可推翻）

- 块级：空行分段；`#`~`######` 标题（全部渲染成同一紧凑样式：加粗、约 1.05em，
  400px 气泡里不放大字号）；`-` / `*` / `+` 无序列表；`1.` 起始有序列表；
  ``` 围栏代码块（语言标注忽略，内部不做行内解析，未闭合时延续到结尾）；
  `>` 引用（左边框 + 缩进）。
- 行内：`**粗体**`、`*斜体*`、`` `行内代码` ``。配对要求侧翼规则：
  开标记后不得紧跟空白、闭标记前不得紧邻空白、内容非空（`2 * 3` 不会斜体）。
  `_下划线强调`刻意不收（snake_case 误伤）。
- 段内单个换行 → 换行（保住现在 pre-wrap 的观感）；行内解析顺序 =
  行内代码优先（保护内容）→ 粗体 → 斜体。
- 不支持：链接、嵌套列表（压平成单层）、表格、删除线、转义符。均原样显示。
- assistant 气泡 only：user / error / notice / pending 气泡保持纯文本
  （错误文案是本地字符串，无 markdown）。

## 流式与恢复

- `renderStreamedText` 逐片全量重渲（现有「全量替换」语义不变）：
  未闭合的 `**` 在流中暂时字面显示，闭合后变粗体；未闭合的 ``` 围栏
  按代码块渲染到当前结尾（与闭合后的最终渲染一致）。
- `restoreHistory` 的 assistant 轮重画走同一渲染器；user 轮纯文本。

## 落点

- 新文件：`chrome-plugin/src/content/chat-markdown.ts`、
  `intellij-plugin/src/main/resources/web/chat-markdown.ts`（平行实现）。
- Chrome：`chat-panel.ts` 的 `STYLES` 补 assistant 侧元素样式（shadow DOM 内，
  面板本就是浅色主题，无暗色变体）；`.message.assistant` 撤 `pre-wrap`。
- IntelliJ：`preview.css` 补亮/暗两套 assistant 侧样式；assistant 消息撤
  `pre-wrap`（user/error/notice 保留）。
- 文档同步：`modules.md`（新文件）、`rendering.md`（气泡渲染）、
  `invariants.md`（新增一条：chat 气泡只经受限渲染器，禁 innerHTML，守护测试钉住）。

## 备选方案（已摆过，用户选 A）

- A（采纳）：手写受限渲染器，零依赖，纯 DOM 构造。
- B（落选）：marked + DOMPurify——两套工程各增两依赖、MV3 bundle 增重，
  sanitize 配置本身是新出错面；chat 语法问答用不到全量 CommonMark。
- C（落选）：只做行内粗体/代码——标题/列表/代码块仍原样，而模型最爱用的
  恰恰是列表，只解决一半。

## 留给实现者

- 渲染器函数签名建议 `renderMarkdown(target: HTMLElement, text: string): void`
  （清空后填入节点）；chat-panel 的 `#bubble` / `renderStreamedText` /
  `completeAssistantTurn` / `restoreHistory` 的 assistant 分支改走它。
- 测试（双端同构）：chat-markdown 单测钉块级/行内/侧翼/未闭合围栏/「`<script>`
  字面显示」安全断言；chat-panel 集成断言 assistant 气泡出现 `<strong>` 而
  user 气泡仍是纯文本。
