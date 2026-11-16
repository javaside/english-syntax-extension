# 详解面板内子结构下钻(design)

日期:2026-11-16
状态:待确认

## 意图

点击句子成分打开详解后,详解面板里的**子结构标注**(①核心名词短语 / ②后置介词短语…)也可以继续点击,以该子结构的 token 区间为新的 focus 再看一层详解。交互形态(用户已选):**面板内下钻 + 顶部「← 返回上级」按钮沿栈回退**;子结构只剩一个单词时同样允许下钻(词级讲解有教学价值,且下钻自然收敛,不做特判)。

## 为什么可行:现有链路天然支持

- `ANALYZE_DETAIL` 的 `focus` 本来就是任意 `TokenRange`,协议校验(`isTokenRange`)、SW 校验、提示词("Explain the grammatical component…Focus range")均不要求它是 core 成分区间。
- 详解缓存键 = 句子文本 + `CORE_SCHEMA_VERSION` + `DETAIL_PROMPT_VERSION` + focus 区间,子结构区间独立成键、独立缓存,与父级详解互不污染。
- 子结构的 `startToken/endToken` 就在句子 token 坐标系内(SW 校验已要求 structures 在 focus 界内),可直接作为新 focus。

## 目标

1. `renderDetail` 完整渲染的面板中,每个标注块(`.annotation`)可点击、可键盘触发,点击以子结构区间下钻。
2. 下钻复用 `syntax-detail-request` → `requestDetail` → `ANALYZE_DETAIL` 链路;面板 DOM 原地转为 loading,**位置不动**。
3. 面板顶部显示「← 返回上级」;返回是纯前端操作(栈内存快照重画),零网络依赖,逐级回退;栈空(根级详解)不显示。
4. 下钻命中缓存时秒回;预载(prefetch)不覆盖子结构区间,首次下钻是冷请求(有流式渲染)。

## 非目标

- **IntelliJ 侧同步实现**——这是 content script 的 UI 交互;若真机验证好用,后续单独立项对等移植(参照 chat panel 的双端做法)。
- 流式渲染期间(`renderDetailStructures`)的标注**不挂点击**——流式 structures 是未校验输出,下钻栈只存已通过完整校验的 `DetailAnalysis`。
- 不做完整面包屑(只逐级返回)、不限下钻深度(模型对单词区间只给词级结构,自然收敛)。
- 不改 runtime 协议消息、不改提示词、不改缓存键构造、不动预载。`SyntaxFocusEventDetail` 是 content 内部 DOM 事件类型,加可选字段不触及三层协议校验。

## 交互细节(与现状的对齐点)

- **返回栈存在 `SyntaxLearningBlock` 实例上**(单面板不变式下就是一个数组 `#detailStack: DetailAnalysis[]`):下钻时压入当前 `DetailAnalysis`;`closeDetails()`(点其他成分/新请求开启)清栈——面板没了栈就是孤儿。
- **`renderDetail`/`renderError` 开头按当前面板 focus 寻址的逻辑不变**:下钻 loading 时把面板的 `dataset.startToken/endToken` 改写为子结构区间,晚到的父级响应因 focus 不匹配被既有守卫丢弃(「晚到的响应不得重开面板」逻辑天然覆盖下钻竞态)。
- **错误态保留返回按钮**:下钻中模型失败 → 面板显示错误 + 重试,栈非空时同时显示「← 返回上级」,用户可退回已核实的父级内容。
- **再次点击同一标注 = 关闭面板的 toggle 语义只属于成分按钮**;下钻面板内点标注永远是下钻,关闭走返回到根后再点一次成分,或点其他成分。
- 事件 `detail` 增加可选 `drillDown?: true`:controller 收到后跳过「当前块 closeDetails + setDetailLoading」,改调 block 的下钻 loading 方法;其他块的面板照旧全关(同屏一个面板不变)。

## 方案取舍

| 方案 | 结论 |
| --- | --- |
| A. 面板内下钻 + 返回栈(选定) | 上下文连续、栈快照零网络回退;改动集中在 learning-block |
| B. 平级切换(点子结构=关旧开新) | 改动最小,但丢父级上下文、长句面板位置跳动,放弃 |
| C. 面板内嵌套折叠 | 多级同屏信息全,但长句面板过长、嵌套 DOM 复杂,放弃 |

## 改动清单

- `chrome-plugin/src/content/learning-block.ts`:标注块改可点按钮(`.component` 同款 appearance:none + hover + focus-visible)、下钻 loading、返回按钮、`#detailStack`、`closeDetails` 清栈、错误态返回按钮。
- `chrome-plugin/src/content/session-controller.ts`:`requestDetail` 识别 `drillDown`,跳过当前块面板关闭。
- 测试:`learning-block.test.ts`(下钻事件/栈/返回/竞态/流式不可点/清栈)、`session-controller.test.ts`(下钻路径不关面板、请求带子 focus)、E2E 一条(下钻 fetch 计数 +1、返回恢复)。
- 文档:`docs/architecture/rendering.md`(面板交互新增下钻/返回);`npm run docs:drift` 反查。

## 风险

- 假模型服务器按 prompt 首行识别请求类型——本功能不改 prompt,E2E 识别不受影响。
- 预载统计(`detailTotal/detailReady`)只统计 core 成分 focus,子结构下钻不进预载口径,进度数字不受影响。
