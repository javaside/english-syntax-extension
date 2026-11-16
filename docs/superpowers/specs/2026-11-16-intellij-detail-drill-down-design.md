# IntelliJ 详解面板内子结构下钻(design)

日期:2026-11-16
状态:待确认(方案概要已在对话呈现并获「开工」确认)
关联:Chrome 侧同功能设计 `2026-11-16-detail-drill-down-design.md`(已上线,交互语义以它为准)

## 意图

对等移植 Chrome 扩展已上线的「面板内下钻 + 返回栈」:预览页详解面板里的子结构标注可点击,以该子结构 token 区间为新 focus 请求详解;面板顶部「← 返回上级」纯前端弹栈回退;单词级子结构同样可下钻;流式标注不可点。

## 为什么便宜:Kotlin 与桥零改动

- 桥 `DETAIL_REQUEST` 的 Kotlin 校验只要求 `start ≥ 0 && end ≥ start`——任意区间(子结构区间)天然放行。
- `PreviewSession.launchDetailRequest` / `onDetailRequest` 接受任意 focus:提示词、双端同构缓存键(子结构区间独立成键)、流式 `DETAIL_STREAM`、暂停门全复用。
- web 侧 `requestDetail(sentenceId, focusStart, focusEnd)` 公开入口已存在,点击成分走的就是它。

## 改动集中在 web 预览页(`render.ts` + `preview.css`)

1. `#renderDetailPanel` 加 `interactive` 区分:完整渲染(`renderDetailResult` 路径)标注为 `button` + 点击挂「下钻」(调 `#showDetailLoading(同句, 子区间)` + `requestDetail(同区间)`);流式(`renderDetailStream` 路径)保持 span。
2. 返回栈:`#detailStack: DetailPayload[]` + `#currentDetailPayload`;`renderDetailResult` 时设置当前、下钻 loading 时压栈;「← 返回上级」弹栈后直接 `#showDetailPanel(父级)` 重画,零桥消息、零网络。
3. 清栈点:`closeDetail()`(句级 toggle 关闭/换代)与 `renderCoreError`(失败行重画,面板消失)。

## 与 Chrome 侧的刻意差异(裁决)

| 差异 | 决定 | 理由 |
| --- | --- | --- |
| 下钻 loading 的「原地」 | 不做 DOM 原地保留,复用既有 `#showDetailLoading` 整卡重画;子结构区间在 `#anchorDetail` 找不到 component 时按既有 fallback 落到句子后 | render.ts 本就是全量重画模式,「面板不重建」在这里是异端;位置跳动仅长句折行场景,可接受 |
| 下钻失败呈现 | 走既有 `CORE_ERROR` → 句子失败行(带重试/纠正入口),不为下钻单开「面板内错误」通道;栈随面板消失清空 | 根级详解失败在 IntelliJ 本就是这个呈现(A9 quirk),下钻沿用不算回归;单开通道要动桥+Kotlin,违背零改动优势 |
| 同句成分点击的 toggle | 沿用既有句级语义:面板开着时点同句成分 = 关闭面板(清栈),不切换 | 既有行为,不在本次范围修 |
| 标注按钮的 cursor | JS 内联 `cursor:pointer !important`(component 按钮同款,634-636 行模式) | 官方 Markdown 预览页的全局 cursor 规则压制 stylesheet,连 !important 也压不过 |

## 非目标

- 不改桥协议、不改 Kotlin(`PreviewSession`/`AnalysisService`/缓存/调度零改动)。
- 不动双端 contracts(提示词首行、缓存键构造都没变)。
- 不修「同句成分点击 = 关闭」的既有 quirk;不做下钻 loading 期的返回按钮(与 Chrome 对齐,真机反馈再说)。

## 测试

- `render.test.ts`(vitest,happy-dom):标注可点与事件、下钻 loading、返回栈逐级/清栈(句级 toggle、CORE_ERROR)、流式 span 不可点、晚到 DETAIL_RESULT 被 `#currentDetail` 区间失配丢弃(既有守卫)、单 token 可点。
- Kotlin 侧零改动,跑全量 gradle 门禁确认无回归;双端门禁按 AGENTS.md(npm + gradle)。
