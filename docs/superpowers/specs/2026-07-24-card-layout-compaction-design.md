# 设计：学习卡片布局紧凑化（2026-07-24）

## 背景

用户反馈：原文一行的内容经解析后拆成多行且每行很短，"明明能一行展示的却拆成多行"。经真实浏览器几何探针定位（650px 窄栏 + 长句/并列句/多短句 fixture），根因有三个叠加机制：

1. **成分卡是不可拆分的 flex item**：换行按整卡 max-content 宽度（钳制 100%）计算，行尾放不下就整体跳下行，前一行留大量空白（实测：长句行 1 只剩 52px 主语卡）。长从句独占行属固有行为，用户已接受（"变多行本身没问题"），不在修复范围。
2. **卡宽被中文译文撑大**：卡宽 = max(角色, 英文, 译文)。实测译文加长后卡从 51/178px 膨胀到各 294px——英文总宽本可一行放下，却因译文撑宽而换行。
3. **每句独立成块 + 句末标点孤行**：三个短句渲染为三行短行；句末句号是独立 flex item，前一成分占满行时句号孤占一行。

## 改动一：短句共行

`STYLES` 中拆开 `.sentence, .detail-annotations` 共享的 `display: flex` 规则：

- `.detail-annotations` 保持 `display: flex`；
- `.sentence` 改为 `display: inline-flex`，并加 `vertical-align: baseline`（句间按基线对齐）、`margin-inline-end: 0.75em`（句间水平距）、`margin-block-end: 0.55em`（行间距，替代原块级堆叠的自然分隔）；
- 新增 `.sentence:has(.detail) { display: flex; }`——打开成分详解面板的句子临时回到块级独占整行，保证 `.detail`（`inline-size: 100%`）以栏宽展示；关闭详解后自动恢复共行。Chrome ≥ 120 支持 `:has()`。

**卡片对齐（2026-07-25 修订）**：共享块的 `align-items` 由 `end` 改为 `baseline`。译文封顶后卡片高度不再相等（译文折两行的卡更高），`end`（底对齐）会把高卡的英文行顶上去，同一行英文高低不平；`baseline` 取每张卡首行（角色标签）的基线，角色行等高，因此卡内、跨卡、跨句的英文行必然齐平（Chrome 的 inline-grid 按钮基线导出自首个网格行内容，已实测验证）。`.sentence` 的 `vertical-align` 同步由 `bottom` 改 `baseline` 使跨句共享同一基线。句首独立标点无三行结构，不参与基线组，用 `.sentence > .punctuation { align-self: end }` 沉到行底。

失败句（`.sentence-failure`）与跳过句（`.sentence-skipped`）保持块级不变。

实测效果：三个短句 "Readers agree. Writers practice. Learners improve steadily." 由三行变为一行共排。

## 改动二：译文宽度上限

```css
.translation,
.annotation-translation {
  max-inline-size: 16em;
}
```

`16em` 以译文自身字号（0.8em ≈ 12.8px）计，约 205px / 16 个汉字。效果：译文对卡宽的贡献封顶，超长译文在卡内折行；实测病态卡（短英文+长译文）从 310px 压回 221px，英文更宽的卡不受影响。

**已实测否决的替代方案**（防止后续"优化"回退）：

- `inline-size: 0; min-inline-size: 100%`：译文完全不撑卡，但短英文+长译文时卡变"高塔"（译文在 51px 内折 7 行）；
- `inline-size: 0; min-inline-size: max(100%, 16em)`：宽卡表现理想，但会把所有窄卡（如 "and"）强撑到 16em（42px→221px）；
- `max-inline-size: max(100%, 16em)`：Chrome 对内涵尺寸计算中不可解析的百分比直接忽略整个约束，完全无效。

~~代价（接受）：英文很宽且译文超过 16em 的卡，译文以 16em 窄列居中折行（比理论最优多一行），此场景罕见（从句译文通常 8-15 字）。~~

**长译文铺开（2026-07-25 修订）**：上述"罕见"判断错误——状语、定语从句等长成分几乎必然触发（用户截图：宽卡里译文折 3 行、两侧大量空白）。理想规则"译文折行宽度 = max(卡宽, 16em)"无法用纯 CSS 表达（`max(100%, 16em)` 中的百分比在内涵尺寸阶段不可解析，Chrome 忽略整个约束，见上方否决表），改为**渲染期按长度分流**：译文 ≥17 字时加 `translation-wide` 类（`inline-size: 0; min-inline-size: max(100%, 16em); max-inline-size: none`）——不参与卡片内涵宽度、展示时铺满卡宽且下限 16em；短译文保持 16em 封顶（对短文本无操作）。实测（`.superpowers/zh-wide-probe.mjs`）：宽卡长译文由 3 行变 1 行铺满 711px；"and" 小卡 39px 不受影响；窄英文+长译文卡仍为 16em 下限折两行。正文 `.translation` 与详解 `.annotation-translation` 同一规则。

## 改动三：成分后标点并入英文行

`renderCore` 中三处独立标点 span（成分间隙 `#appendPunctuation`、成分区间尾标点、句尾 `#appendPunctuation`）改为：**有前置成分时，附加到前一成分的 `.english` span 内**（`.punctuation` span，保留 `leadingWhitespace`，与现有成分内部标点同构）；句首标点（无前置成分）保持独立 span 现状。

- 视觉：并入的标点会落在前一成分英文行的下划线内——与现状成分内部逗号的展示一致；
- 语义不变：成分的 `aria-label`、focus 区间、点击/详解定位（`data-start-token` 查询与 `nextElementSibling` 行走）均不受影响；
- 效果：消灭"句号孤行"（实测长句句号曾独占 26px 高的一行）。

`renderFailure` / `renderSkipped` 渲染原文字符串，不涉及。

## 测试

- 单测（`learning-block.test.ts`）：更新/新增标点归属断言——成分后标点位于前一成分 `.english` 内；句首标点仍为 sentence 直接子节点；文本重建（textContent 顺序）不变。
- E2E 新增 `tests/e2e/layout.spec.ts`（由调查期探针转正）+ fixture `tests/fixtures/pages/probe-long.html`：用几何探针断言 (a) 三短句共行（top 相等）；(b) 病态长译文卡宽 ≤ 230px；(c) 句尾无孤行标点（sentence 无独立 `.punctuation` 直接子节点尾随在满宽成分后）；(d) 点开成分详解后该句宽度≈栏宽（`:has` 生效）、关闭后恢复。断言用几何探针，不用截图对比。
- 现有 E2E/单测如有对标点为 sentence 直接子节点的结构断言，按新归属同步。

## 非目标

- 不改变成分粒度、模型提示词、协议；
- 不解决长从句成分独占行（盒模型固有，且用户接受）；
- 不在失败句/跳过句上做共行。
