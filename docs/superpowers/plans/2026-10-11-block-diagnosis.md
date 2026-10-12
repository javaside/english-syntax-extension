# 段落诊断（block diagnosis）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 右键任意未翻译的段落 → 本地按生产判定链逐门复算证据 → 模型基于证据解释 → 面板展示并可复制结构化 markdown 报告（给 code-tui 修 bug 用）。

**Architecture:** 证据采集全部复用生产函数（`page-inventory` 新增只读出口 `explainElement`）；两条新消息（SW→content 纯触发 `DIAGNOSE_BLOCK`、content→SW 模型请求 `EXPLAIN_DIAGNOSIS`）+ 一条新响应 `DIAGNOSIS_RESULT`；诊断不写缓存、不升任何版本常量、不新增错误码；调度复用 `detail-click` 档但用 `${documentId}:diagnosis` 后缀隔离 abort 连坐。

**Tech Stack:** TypeScript + Vitest（happy-dom）+ Playwright E2E（假 OpenAI 服务器）。Chrome MV3，无新依赖。

**Spec:** `docs/superpowers/specs/2026-10-11-block-diagnosis-design.md`（实现前先读，本计划从 spec 立论）

## Global Constraints

- 所有命令在 `chrome-plugin/` 里跑（除标注仓库根的）；测试命令 `npx vitest run <file>`。
- **lint 基线：恰好 1 个错误**（`options.test.ts` 的 no-unnecessary-type-assertion）。不要修它，也不要新增任何错误。
- 协议三层校验同步（AGENTS.md 硬约定）：`shared/protocol.ts` 类型+守卫 / `service-worker.ts` route() / `content-script.ts` isRuntimeResponse——本计划 Task 3、6、10 各负责一层，缺一层测试必红。
- 假服务器红线：任何模型内容必须经 `writeContent` 出去（`tests/support/fake-openai-server.ts:671`）；`detectKind` 加新前缀时**必须同时给 `respondAuto` 加真正的应答分支**（default 落 `respondCore` 会回 core 形状）。
- 诊断首行常量**不进 `PROMPT_FIRST_LINES`**（它被 contracts.json + Kotlin 双侧钉死）；先例：`buildSentenceDetailsPrompt` 的首行是函数内字面量（`prompts.ts:303`）。
- 不新增 `ERROR_CODES`、不升 `MESSAGE_VERSION` / `CORE_PROMPT_VERSION` / `DETAIL_PROMPT_VERSION`、不动 `STORE_NAMES` / `DATABASE_VERSION`、不动 `PRIORITY_RANK`。
- SW 诊断分支**不写 `activeTabs`**（spec D1：记账会把未启动会话伪造成 running）。
- 新测试文件头加 `// @vitest-environment happy-dom`（仓库惯例，config 不设全局 environment）。
- DOM 测试构造：小用例 `document.body.innerHTML = markup` + 全局 happy-dom document；fixture 页用独立 `new Window()`（样板见 `page-inventory.test.ts:59-73`）。
- 提交信息用中文主题；每个 Task 结束提交一次。
- worktree：`.worktrees/diagnose-block`（分支 `feat/block-diagnosis`，基于 main @ 83a288c）。**绝不在 main 上直接实现。**

## 关键既有接口（各 Task 都要用，先读一遍）

```ts
// page-inventory.ts 既有导出
export function inventoryReadableUnits(root: ParentNode): ReadableUnit[];   // :509
export function explicitCandidateText(element: Element): string | null;     // :210
// ReadableUnit { id, element, kind, text, automatic, exclusionReason? }    // :51-58
// ReadableUnitExclusionReason：14 个字符串字面量                        // :35-49

// document-scanner.ts
export function nearestSafeBlock(target: Node | null): { id: string; element: HTMLElement; text: string } | null;  // :44-60 返回形态以现有代码为准

// readable-dom-text.ts
export function normalizedReadableText(element: Element): string;           // :97

// protocol.ts
const pageOnlyKeys = ["version","requestId","type","tabId","documentId"] as const;  // :205
function hasOnlyKeys(value, allowedKeys): boolean                           // :219
function hasPageContext(value): boolean                                     // :223
function isNonBlankString(value): value is string                           // 既有 helper
export function serialize 未导出——serialize 在 prompts.ts
```

---

### Task 1: `page-inventory.explainElement` 只读诊断出口

**Files:**
- Modify: `chrome-plugin/src/content/page-inventory.ts`（新增导出，不改任何现有行为）
- Test: `chrome-plugin/src/content/page-inventory.test.ts`（追加 describe）

**Interfaces (Produces):**
```ts
export interface CandidateGateResult { gate: string; ok: boolean; value?: string | number }
export function explainElement(element: Element): CandidateGateResult[];
```
gate 名固定为（顺序镜像 `classifyExclusion` 优先级链）：`scientific-exclusion` / `covered-by-child` / `has-separable-direct-text`（条件门） / `inside-principal-root` / `excluded-region` / `unsafe-descendant`（含自身 matches） / `hidden-ancestor` / `layout-visible` / `readable-words` / `english-dominant` / `min-auto-text-length` / `block-candidate`（额外语义证据，放最后）。

- [ ] **Step 1: 写失败测试**（追加到 `page-inventory.test.ts` 末尾）

```ts
describe("explainElement 只读诊断出口", () => {
  // 集合包含式一致性（刻意不是「首个失败门唯一决定 reason」）：classifyExclusion
  // (page-inventory.ts:425-467) 的优先级链 + covered-by-child 的方向①（内联单元被
  // 自动父吸收）都依赖整页两遍算法，单元素函数无法逐门复刻优先级。断言改为两条：
  // ① automatic 单元无任何失败门；② 非自动单元的失败门集合 ⊇ 产出其 reason 所需的门。
  // 这就是防「诊断逻辑漂移」的核心断言：诊断说的原因必须与生产判定一致。
  const SCIENTIFIC_REASONS = [
    "conversion-placeholder", "math-auxiliary", "reference-metadata",
    "display-math", "unsupported-reference-layout",
  ];
  const requiredGateByReason: Record<string, string> = {
    "outside-principal-content": "inside-principal-root",
    "excluded-region": "excluded-region",
    "unsafe-interactive": "unsafe-descendant",
    "no-readable-words": "readable-words",
    "non-english": "english-dominant",
    "loose-block-too-short": "min-auto-text-length",
    "covered-by-child": "covered-by-child",
    "unsafe-partial-replacement": "has-separable-direct-text",
  };

  it("对两份冻结 fixture 的每个 unit，失败门集合覆盖其 exclusionReason 所需的门", () => {
    for (const fixtureName of fixtures) {
      const page = parsePage(readFixture(fixtureName, "html"));
      const contract = JSON.parse(readFixture(fixtureName, "json")) as InventoryContract;
      const units = new Map(
        inventoryReadableUnits(page).map((unit) => [unit.element.getAttribute("data-audit-id") ?? unit.id, unit]),
      );
      for (const { id, reason } of contract.units) {
        const unit = units.get(id);
        if (unit === undefined || reason === null) continue;
        const failed = new Set(
          explainElement(unit.element).filter(({ ok }) => !ok).map(({ gate }) => gate),
        );
        if (unit.automatic) {
          expect([...failed], `${fixtureName}:${id} 自动单元不应有失败门`).toEqual([]);
          continue;
        }
        if (SCIENTIFIC_REASONS.includes(reason)) {
          expect(failed, `${fixtureName}:${id} reason=${reason}`).toContain("scientific-exclusion");
          continue;
        }
        if (reason === "hidden") {
          expect(
            failed.has("hidden-ancestor") || failed.has("layout-visible"),
            `${fixtureName}:${id} hidden 应有 hidden-ancestor 或 layout-visible 失败`,
          ).toBe(true);
          continue;
        }
        if (reason === "covered-by-child") {
          // 两方向：方向②自身有可分析子（covered-by-child 门失败）；方向①被某个自动
          // 祖先吸收（整页判定，这里用 inventory 结果验证，explainElement 单元素复算不了）。
          const absorbed = [...units.values()].some(
            (other) => other.automatic && other.element !== unit.element && other.element.contains(unit.element),
          );
          expect(
            failed.has("covered-by-child") || absorbed,
            `${fixtureName}:${id} covered-by-child 两方向均不满足`,
          ).toBe(true);
          continue;
        }
        const required = requiredGateByReason[reason];
        expect(required, `${fixtureName}:${id} 未知的 reason=${reason}——映射表缺条目`).toBeDefined();
        expect(failed, `${fixtureName}:${id} reason=${reason} 缺门 ${required}`).toContain(required);
      }
    }
  });

  it("english-dominant 门带回词级占比（isEnglishDominant 是词级判定，不是字符级）", () => {
    // 3/6 英文词 = 0.5 < 0.6（page-inventory.ts:162-166 的口径）。
    document.body.innerHTML = '<main><p id="mixed">你好 hello 世界 test again 更多</p></main>';
    const gates = explainElement(document.getElementById("mixed")!);
    const gate = gates.find(({ gate }) => gate === "english-dominant")!;
    expect(gate.ok).toBe(false);
    expect(gate.value).toBe(0.5);
  });

  it("min-auto-text-length 门的条件与 classifyExclusion 同款（非 BLOCK/CALLOUT 且 <20）", () => {
    document.body.innerHTML = '<main><div id="tiny">Short text</div></main>';
    const gates = explainElement(document.getElementById("tiny")!);
    const gate = gates.find(({ gate }) => gate === "min-auto-text-length")!;
    expect(gate.ok).toBe(false);
    expect(gate.value).toBe(10);
    // BLOCK_SELECTOR 命中的元素不受短块门限制（classifyExclusion:459-465 同款）。
    document.body.innerHTML = '<main><figcaption id="cap">Tiny.</figcaption></main>';
    const caption = explainElement(document.getElementById("cap")!);
    expect(caption.find(({ gate }) => gate === "min-auto-text-length")!.ok).toBe(true);
  });
});
```

注意：`fixtures` / `readFixture` / `parsePage` / `InventoryContract` 已在该测试文件 59-94 行定义，直接复用；`explainElement` 从 `./page-inventory` import。fixture 页是独立 `new Window()` 文档——**explainElement 内部严禁引用全局 `document`**（见 Step 3 的 S2 修复）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd chrome-plugin && npx vitest run src/content/page-inventory.test.ts`
Expected: FAIL——`explainElement` 未导出（TS 编译错或 import 报 undefined）。

- [ ] **Step 3: 实现 `explainElement`**（追加到 `page-inventory.ts` 末尾；只调用本模块既有私有函数，不复制判据）

```ts
export interface CandidateGateResult {
  gate: string;
  ok: boolean;
  value?: string | number;
}

/**
 * 只读诊断出口：对单个元素按生产判据逐门复算，返回每门结果与当时取值。
 * 门顺序刻意镜像 classifyExclusion(:425-467) 的优先级链（科学排除 → 覆盖/部分替换 →
 * principal root → 排除区 → 交互元素 → 可见性 → 实词 → 英文 → 短块），block-candidate
 * 作为额外语义证据放最后；它与 inventoryReadableUnits 的判定必须一致——诊断报告要拿去
 * 改代码，不能复制一份会漂移的判据。不改任何生产路径行为，纯新增导出。
 */
export function explainElement(element: Element): CandidateGateResult[] {
  const text = normalizedReadableText(element);
  const words = letterWords(text).length;
  const ratio = englishLetterRatio(text); // 从 isEnglishDominant(:162-166) 提取的词级占比
  const scientific = scientificExclusion(element);
  const owner = element.ownerDocument; // S2 修复：绝不引用全局 document——fixture 元素在独立 Window 文档里
  const principalRoot = selectPrincipalRoot(owner);
  const excluded = excludedRegionAncestor(element);
  const hasAnalyzableChildren = analyzableDescendants(element).length > 0;
  const unsafeSelf = element.matches(UNSAFE_DESCENDANT_SELECTOR); // 注意拼写 DESCENDANT(:87)
  const unsafeChild = element.querySelector(UNSAFE_DESCENDANT_SELECTOR) !== null;
  return [
    { gate: "scientific-exclusion", ok: scientific === undefined, ...(scientific === undefined ? {} : { value: scientific }) },
    { gate: "covered-by-child", ok: !hasAnalyzableChildren },
    // 条件门：仅在有可分析子时才评估（automatic 单元没有可分析子，恒 ok）——
    // 镜像 classifyExclusion 里 children 检查先于 hasSeparableDirectText 的顺序。
    {
      gate: "has-separable-direct-text",
      ok: !hasAnalyzableChildren || !hasSeparableDirectText(element),
    },
    {
      gate: "inside-principal-root",
      ok: principalRoot === null || principalRoot.contains(element) || element === principalRoot,
    },
    { gate: "excluded-region", ok: excluded === null, ...(excluded === null ? {} : { value: "excluded-region-ancestor" }) },
    // classifyExclusion:451 是 matches(自身) || querySelector(后代)——isSafeElement:200 只查后代，
    // 这里按 classifyExclusion 的口径（自身也算），unsafe-interactive 才有门可依。
    { gate: "unsafe-descendant", ok: !unsafeSelf && !unsafeChild },
    { gate: "hidden-ancestor", ok: element.closest(HIDDEN_SELECTOR) === null },
    { gate: "layout-visible", ok: isLayoutVisible(element) },
    { gate: "readable-words", ok: words > 0, value: words },
    { gate: "english-dominant", ok: ratio >= 0.6, value: Math.round(ratio * 100) / 100 },
    {
      gate: "min-auto-text-length",
      // 与 classifyExclusion:459-465 逐字同款：非 BLOCK 且非 CALLOUT 且 <20 才失败。
      ok:
        element.matches(BLOCK_SELECTOR) ||
        element.matches(CALLOUT_SELECTOR) ||
        text.length >= MINIMUM_AUTO_TEXT_LENGTH,
      value: text.length,
    },
    { gate: "block-candidate", ok: isBlockCandidate(element, true) },
  ];
}
```

**实现注意（执行者必读）**：
- `isBlockCandidate` 的真实签名以 `page-inventory.ts:185-193` 为准（若第二参不是 `loose: boolean` 就按真实签名调用）；`englishLetterRatio` 不存在——把 `isEnglishDominant`（`:162-166`）的词级占比计算提为私有 `englishLetterRatio(text): number` 并让两者共用（允许的最小重构，判据一行不重写）。
- `hasSeparableDirectText` / `excludedRegionAncestor` / `analyzableDescendants` / `scientificExclusion` / `isLayoutVisible` / `letterWords` 均为该文件既有私有函数，直接调用。
- 门 `value` 用真实可得的值（`scientificExclusion` 的 reason、词数、文本长度、占比）；`excluded-region` 的 value 给固定标记即可（`excludedRegionAncestor` 的真实返回形态以代码为准）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd chrome-plugin && npx vitest run src/content/page-inventory.test.ts`
Expected: PASS（含既有的全部用例——证明没有破坏生产判定）。

- [ ] **Step 5: 提交**

```bash
git add src/content/page-inventory.ts src/content/page-inventory.test.ts
git commit -m "feat: page-inventory 新增只读诊断出口 explainElement"
```

---

### Task 2: SessionController 失败文案留存 + `diagnosisSnapshot` 只读快照

**Files:**
- Modify: `chrome-plugin/src/content/session-controller.ts`（`SentenceRecord` 加一个可选字段；4 个失败落点各补一行；新增只读方法）
- Test: `chrome-plugin/src/content/session-controller.test.ts`（追加 describe）

**Interfaces (Produces):**
```ts
// SessionController 公开只读方法：
diagnosisSnapshot(element: Element | null): {
  state: "stopped" | "running" | "paused";
  registered: boolean;
  blockId?: string;
  sentences: Array<{ text: string; phase: SentencePhase; failureMessage?: string }>;
}
```
（`SentencePhase` 是该文件 35-41 行的既有联合类型。）

- [ ] **Step 1: 写失败测试**（追加到 `session-controller.test.ts`；该文件已有完整的 controller 测试 harness——复用其既有 `harness()`/fake transport 构造方式，先读文件头 60 行找到样板）

```ts
describe("diagnosisSnapshot 只读快照", () => {
  it("stopped 会话返回未注册与空句列表", async () => {
    const { controller } = harness(); // 复用既有 harness；无 harness 就照文件内最简单的构造用例抄
    document.body.innerHTML = '<p id="target">Some English sentence here.</p>';
    const snapshot = controller.diagnosisSnapshot(document.getElementById("target"));
    expect(snapshot.state).toBe("stopped");
    expect(snapshot.registered).toBe(false);
    expect(snapshot.sentences).toEqual([]);
  });

  it("已登记块返回句相位与失败文案", async () => {
    // 该文件里已有「失败句渲染」类用例（CORE_RESULT ERROR / 缺失句的 fake transport
    // 响应构造）——先读文件找到最接近的一个照抄其 setup：起会话、等块登记、让响应
    // 携带一个失败句。目标元素句柄这样取（harness 返回值里没有元素）：
    //   const target = document.querySelector("p") as HTMLElement;  // 用例 setup 里写进 DOM 的那个块
    const snapshot = controller.diagnosisSnapshot(document.querySelector("p"));
    expect(snapshot.registered).toBe(true);
    expect(snapshot.state).toBe("running");
    expect(snapshot.sentences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: "failed", failureMessage: expect.any(String) }),
      ]),
    );
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd chrome-plugin && npx vitest run src/content/session-controller.test.ts -t "diagnosisSnapshot"`
Expected: FAIL——`diagnosisSnapshot` 不是方法。

- [ ] **Step 3: 实现**（三处小改，全部 additive）

1. `SentenceRecord`（`session-controller.ts:97-102`）加字段：

```ts
interface SentenceRecord {
  input: SentenceInput;
  phase: SentencePhase;
  core?: CoreAnalysis;
  blockId: string;
  /** 诊断用：最近一次失败的原因文案（含错误码前缀）；成功重试后不清除，以最新为准。 */
  failureMessage?: string;
}
```

2. 四个失败落点各补一行 `sentence.failureMessage = <该处的 message 变量>`——精确位置（已核实）：
   - `:856-861` 超长句：`failuresByBlock.get(block)!.push({...message: TOO_LONG_MESSAGE})` 后、`transition(sentence, "failed")` 前后加 `sentence.failureMessage = TOO_LONG_MESSAGE;`
   - `:917-922` 缺失结果：`failures.push({...message: responseErrorMessage(response)})` 处，加 `sentence.failureMessage = responseErrorMessage(response);`
   - `:930-936` 渲染异常：`message: MISSING_RESULT_MESSAGE` 处同理。
   - `:1108-1110` 单句重试失败：`this.finishBlock(block, [{... message: responseErrorMessage(response)}])` 前加 `sentence.failureMessage = responseErrorMessage(response);`

3. 类内新增公开方法（放在 `get status()` 附近）：

```ts
  /** 诊断只读快照：目标元素所在块的登记状态与逐句相位。不触发任何状态迁移。 */
  diagnosisSnapshot(element: Element | null): {
    state: SessionState;
    registered: boolean;
    blockId?: string;
    sentences: Array<{ text: string; phase: SentencePhase; failureMessage?: string }>;
  } {
    let matched: BlockRecord | undefined;
    if (element !== null) {
      for (const block of this.blocks.values()) {
        if (block.candidate.element === element || block.candidate.element.contains(element)) {
          matched = block;
          break;
        }
      }
    }
    if (matched === undefined) {
      return { state: this.state, registered: false, sentences: [] };
    }
    return {
      state: this.state,
      registered: true,
      blockId: matched.candidate.id,
      sentences: matched.sentences.map((sentence) => ({
        text: sentence.input.text,
        phase: sentence.phase,
        ...(sentence.failureMessage === undefined ? {} : { failureMessage: sentence.failureMessage }),
      })),
    };
  }
```

（`SessionState` 若该文件没有现成导入，用 `"stopped" | "running" | "paused"` 字面量联合；`get status()` 的 `state: this.state` 就是这个类型。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd chrome-plugin && npx vitest run src/content/session-controller.test.ts`
Expected: PASS 全部（92 个既有用例不红——证明 additive）。

- [ ] **Step 5: 提交**

```bash
git add src/content/session-controller.ts src/content/session-controller.test.ts
git commit -m "feat: SessionController 留存失败文案并提供 diagnosisSnapshot"
```

---

### Task 3: 协议第一层——类型与守卫（`shared/protocol.ts`）

**Files:**
- Modify: `chrome-plugin/src/shared/protocol.ts`
- Test: `chrome-plugin/src/shared/protocol.test.ts`（追加 describe）

**Interfaces (Produces，后续所有 Task 依赖这些名字)：**
```ts
// BlockDiagnosis / SessionDiagnosisSnapshot / DiagnosisExplanation / CandidateGateResult
// 全部定义在 protocol.ts（wire 类型统一放这，content 与 background 共用）
export interface DiagnosisGateResult { gate: string; ok: boolean; value?: string | number }
export interface SessionDiagnosisSnapshot {
  state: "stopped" | "running" | "paused";
  registered: boolean;
  blockId?: string;
  sentences: Array<{ text: string; phase: string; failureMessage?: string }>;
}
export interface BlockDiagnosis {
  target: { tagName: string; className: string; id: string; selectorPath: string; outerHtml: string };
  targetSource: "selection" | "contextmenu" | "body" | "extension-ascended";
  selectionText?: string;
  inventory: { isUnit: boolean; kind?: string; automatic: boolean; exclusionReason?: string };
  explicit: { resolvable: boolean; selectorPath?: string };
  gates: DiagnosisGateResult[];
  text: { length: number; letterWords: number; englishRatio?: number; minAutoTextLength: number };
  segmentation: { sentenceCount: number; sentenceLengths: number[]; tokenCount: number; emptyText: boolean };
  requestFeasibility: {
    maxSentenceLength: number;
    sentenceLengthLimit: number;
    maxSentencesPerRequest: number;
    cloudSentencesPerRequest: number;
  };
  session: SessionDiagnosisSnapshot;
  page: { url: string; readyState: string };
  capturedAt: string;
}
export interface DiagnosisExplanation {
  likelyCause: string;
  explanation: string;
  suggestions: string[];
}
// RequestMessage 追加两成员：
| (PageRequestBase & { type: "DIAGNOSE_BLOCK"; selectionText?: string })
| (PageRequestBase & { type: "EXPLAIN_DIAGNOSIS"; diagnosis: BlockDiagnosis })
// ResponseMessage 追加一成员：
| (MessageBase & {
    type: "DIAGNOSIS_RESULT";
    diagnosis: BlockDiagnosis;
    model?: DiagnosisExplanation;
    modelError?: ExtensionError;
    profile?: { model: string };
  })
```

注意：`CandidateGateResult`（Task 1 在 page-inventory.ts 定义）与 `DiagnosisGateResult` 结构相同——**让 page-inventory.ts 的 `CandidateGateResult` 改为 re-export `DiagnosisGateResult`**（`export type { DiagnosisGateResult as CandidateGateResult } from "../shared/protocol"`），单一形状单一处定义。

- [ ] **Step 1: 写失败测试**（追加到 `protocol.test.ts`，照该文件既有守卫用例风格）

```ts
describe("diagnosis 消息守卫", () => {
  const baseDiagnosis: BlockDiagnosis = {
    target: { tagName: "P", className: "content", id: "p1", selectorPath: "main > p#p1", outerHtml: '<p id="p1">' },
    targetSource: "contextmenu",
    inventory: { isUnit: true, kind: "paragraph", automatic: false, exclusionReason: "non-english" },
    explicit: { resolvable: false },
    gates: [{ gate: "english-dominant", ok: false, value: 0.2 }],
    text: { length: 40, letterWords: 8, englishRatio: 0.2, minAutoTextLength: 20 },
    segmentation: { sentenceCount: 1, sentenceLengths: [40], tokenCount: 9, emptyText: false },
    requestFeasibility: { maxSentenceLength: 40, sentenceLengthLimit: 2000, maxSentencesPerRequest: 6, cloudSentencesPerRequest: 2 },
    session: { state: "stopped", registered: false, sentences: [] },
    page: { url: "https://example.com/a", readyState: "complete" },
    capturedAt: "2026-10-11T00:00:00.000Z",
  };

  it("接受合法 DIAGNOSE_BLOCK（带与不带 selectionText）", () => {
    expect(isRequestMessage({ ...page, type: "DIAGNOSE_BLOCK" })).toBe(true);
    expect(isRequestMessage({ ...page, type: "DIAGNOSE_BLOCK", selectionText: "hello world" })).toBe(true);
  });
  it("拒绝空白 selectionText 与未知字段", () => {
    expect(isRequestMessage({ ...page, type: "DIAGNOSE_BLOCK", selectionText: "  " })).toBe(false);
    expect(isRequestMessage({ ...page, type: "DIAGNOSE_BLOCK", extra: 1 })).toBe(false);
  });
  it("接受合法 EXPLAIN_DIAGNOSIS 并拒绝非法 diagnosis", () => {
    expect(isRequestMessage({ ...page, type: "EXPLAIN_DIAGNOSIS", diagnosis: baseDiagnosis })).toBe(true);
    expect(isRequestMessage({ ...page, type: "EXPLAIN_DIAGNOSIS" })).toBe(false);
    expect(isRequestMessage({ ...page, type: "EXPLAIN_DIAGNOSIS", diagnosis: { ...baseDiagnosis, gates: "x" } })).toBe(false);
  });
});
```

（`page` 是该文件既有的页面请求基线常量（`protocol.test.ts:11-16`），字段拼装照抄。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd chrome-plugin && npx vitest run src/shared/protocol.test.ts`
Expected: FAIL——新 type 未定义。

- [ ] **Step 3: 实现**（protocol.ts 三处）

1. 类型定义（放在 `CacheStats` 附近）+ RequestMessage/ResponseMessage 联合体追加成员（照 `PARSE_SELECTION`/`PROFILE_TEST_RESULT` 的写法）。
2. `export function isBlockDiagnosis(value: unknown): value is BlockDiagnosis` 守卫（**导出**——Task 10 的 `isRuntimeResponse` case 要 import 它）——**结构抽查**即可（消息来自我们自己的 content script，不是不可信输入；但缺字段必须拒）：

```ts
function isDiagnosisGateResult(value: unknown): value is DiagnosisGateResult {
  return (
    isRecord(value) &&
    typeof value.gate === "string" &&
    typeof value.ok === "boolean" &&
    (value.value === undefined || typeof value.value === "string" || typeof value.value === "number")
  );
}

function isBlockDiagnosis(value: unknown): value is BlockDiagnosis {
  if (!isRecord(value) || !isRecord(value.target) || !isRecord(value.inventory) || !isRecord(value.session)) {
    return false;
  }
  return (
    typeof value.target.tagName === "string" &&
    typeof value.target.selectorPath === "string" &&
    typeof value.inventory.automatic === "boolean" &&
    Array.isArray(value.gates) &&
    value.gates.every(isDiagnosisGateResult) &&
    typeof value.capturedAt === "string" &&
    (value.session.state === "stopped" || value.session.state === "running" || value.session.state === "paused")
  );
}
```

3. `isRequestMessage` switch 加两个 case（`:289-368` 内；`DIAGNOSE_BLOCK` 的 selectionText 可选——**present 时**必须非空白）：

```ts
    case "DIAGNOSE_BLOCK":
      return (
        hasOnlyKeys(value, [...pageOnlyKeys, "selectionText"]) &&
        hasPageContext(value) &&
        (value.selectionText === undefined || isNonBlankString(value.selectionText))
      );
    case "EXPLAIN_DIAGNOSIS":
      return (
        hasOnlyKeys(value, [...pageOnlyKeys, "diagnosis"]) &&
        hasPageContext(value) &&
        isBlockDiagnosis(value.diagnosis)
      );
```

- [ ] **Step 4: 跑测试 + 全量确认 additive**

Run: `cd chrome-plugin && npx vitest run src/shared/protocol.test.ts && npx vitest run src/shared/architecture-docs.test.ts`
Expected: protocol 全绿。architecture-docs 会红一条——「protocol.md 缺少消息类型 DIAGNOSE_BLOCK / EXPLAIN_DIAGNOSIS / DIAGNOSIS_RESULT」（`:134-144` 的正则扫全部 `type: "..."`）。**这条红是预期的**，Task 12 文档同步时一起修；本 Task 先在 `docs/architecture/protocol.md` 的消息表（`:36-38` 附近）加三行占位（后续 Task 12 充实）：

```markdown
| `DIAGNOSE_BLOCK` | 受信任 UI;或 SW 自发 | `selectionText?` | 转发页面:诊断落点段落为什么没解析(纯触发) | ✅ | ❌ |
| `EXPLAIN_DIAGNOSIS` | 页面(有 tabId) | `diagnosis` | 诊断模型解释请求;回 `DIAGNOSIS_RESULT` | ❌ | ✅ |
```

（`DIAGNOSIS_RESULT` 出现在响应表即可让字符串检查通过——响应表在 `:85-102` 一带，加一行。）

- [ ] **Step 5: 提交**

```bash
git add src/shared/protocol.ts src/shared/protocol.test.ts docs/architecture/protocol.md
git commit -m "feat: 协议新增 DIAGNOSE_BLOCK/EXPLAIN_DIAGNOSIS/DIAGNOSIS_RESULT"
```

---

### Task 4: `buildDiagnosisPrompt` + 形状校验

**Files:**
- Modify: `chrome-plugin/src/background/prompts.ts`（新增导出；**不进 `PROMPT_FIRST_LINES`**）
- Modify: `chrome-plugin/src/background/analysis-service.ts`（新增 `DIAGNOSIS_SCHEMA` 与 `validateDiagnosisExplanation`——放该文件既有 schema/校验区）
- Test: `chrome-plugin/src/background/prompts.test.ts`（追加 describe）

**Interfaces (Produces):**
```ts
// prompts.ts
export function buildDiagnosisPrompt(diagnosis: BlockDiagnosis): string;
// analysis-service.ts
export const DIAGNOSIS_SCHEMA: JsonSchemaSpec;
export function validateDiagnosisExplanation(raw: unknown): DiagnosisExplanation; // 不符抛 Error（进 explainDiagnosis 的 catch）
```

首行固定为：`Diagnose why the extension did not translate the page block described by the gate evidence below.`

- [ ] **Step 1: 写失败测试**

```ts
describe("buildDiagnosisPrompt", () => {
  it("首行钉死且证据白名单序列化紧凑", () => {
    const diagnosis = sampleDiagnosis(); // 造一个含 URL/outerHTML 的完整 BlockDiagnosis（照 Task 3 测试的 baseDiagnosis 抄，补全字段）
    const prompt = buildDiagnosisPrompt(diagnosis);

    expect(prompt.split("\n")[0]).toBe(
      "Diagnose why the extension did not translate the page block described by the gate evidence below.",
    );
    // 隐私边界：URL 与 outerHTML 绝不进 prompt
    expect(prompt).not.toContain("https://example.com");
    expect(prompt).not.toContain("<p");
    // 白名单字段在场
    expect(prompt).toContain("english-dominant");
    expect(prompt).toContain('"exclusionReason":"non-english"');
    // serialize 紧凑：证据 JSON 不得美化缩进
    expect(prompt).not.toMatch(/\n {2}"/u);
  });

  it("输出形状要求三字段", () => {
    const prompt = buildDiagnosisPrompt(sampleDiagnosis());
    expect(prompt).toContain('"likelyCause"');
    expect(prompt).toContain('"suggestions"');
  });
});

describe("validateDiagnosisExplanation", () => {
  it("接受合法形状并拒绝缺字段/空串/非字符串数组", () => {
    const valid = { likelyCause: "english ratio below threshold", explanation: "该块英文占比不足", suggestions: ["检查语言"] };
    expect(validateDiagnosisExplanation(valid)).toEqual(valid);
    expect(() => validateDiagnosisExplanation({ likelyCause: "", explanation: "x", suggestions: [] })).toThrow();
    expect(() => validateDiagnosisExplanation({ likelyCause: "a", explanation: "x", suggestions: "no" })).toThrow();
    expect(() => validateDiagnosisExplanation({ likelyCause: "a" })).toThrow();
  });
});
```

（`validateDiagnosisExplanation` 的测试放 `analysis-service.test.ts`；`sampleDiagnosis()` 在两个测试文件各自内联一份即可，勿共享测试工具。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd chrome-plugin && npx vitest run src/background/prompts.test.ts src/background/analysis-service.test.ts -t "diagnos"`
Expected: FAIL——函数未定义。

- [ ] **Step 3: 实现**

`prompts.ts`（文件末尾；`serialize`、`BlockDiagnosis` import 自既有路径）：

```ts
/**
 * 诊断提示词。首行刻意是函数内字面量、不进 PROMPT_FIRST_LINES——那张表被
 * contracts.json + Kotlin 双侧钉死，动它就破坏 Chrome-only 范围（先例：
 * buildSentenceDetailsPrompt，见 :303）。
 *
 * 隐私白名单（spec D4）：只发门结果/文本度量/分句/失败 code/标签与选择器路径；
 * URL 与 outerHTML 原文绝不进 prompt（只留在本地报告）。
 */
export function buildDiagnosisPrompt(diagnosis: BlockDiagnosis): string {
  const evidence = {
    target: {
      tagName: diagnosis.target.tagName,
      className: diagnosis.target.className,
      id: diagnosis.target.id,
      selectorPath: diagnosis.target.selectorPath,
    },
    inventory: diagnosis.inventory,
    gates: diagnosis.gates,
    text: diagnosis.text,
    segmentation: diagnosis.segmentation,
    requestFeasibility: diagnosis.requestFeasibility,
    failedSentences: diagnosis.session.sentences
      .filter(({ failureMessage }) => failureMessage !== undefined)
      .map(({ phase, failureMessage }) => ({ phase, failureMessage })),
    sessionState: diagnosis.session.state,
    ...(diagnosis.selectionText === undefined ? {} : { selectionText: diagnosis.selectionText }),
  };
  return [
    "Diagnose why the extension did not translate the page block described by the gate evidence below.",
    "You are given gate-by-gate evidence from a local gating pipeline (gate name, pass/fail, the measured value). " +
      "The first failing gate with an out-of-range value is the most likely cause; say which one and why in Chinese. " +
      "If every gate passes, the block should be analyzable — then explain what else (session state, sentence length limits, request limits) could have prevented translation.",
    "Output exactly one JSON object of this shape:",
    '{"likelyCause": string, "explanation": string, "suggestions": string[]}',
    "likelyCause is a short English label; explanation and suggestions are in Chinese; suggestions are actionable fixes.",
    MINIFIED_OUTPUT,
    "Gate evidence:",
    serialize(evidence),
  ].join("\n\n");
}
```

`analysis-service.ts`（schema 放 `SENTENCE_DETAILS_SCHEMA` 附近，校验函数放既有 envelope 校验区）：

```ts
export const DIAGNOSIS_SCHEMA: JsonSchemaSpec = {
  name: "diagnosis_explanation",
  schema: {
    type: "object",
    properties: {
      likelyCause: { type: "string" },
      explanation: { type: "string" },
      suggestions: { type: "array", items: { type: "string" } },
    },
    required: ["likelyCause", "explanation", "suggestions"],
    additionalProperties: false,
  },
};

/** 只做形状校验（spec D4）：不进 grammar/译文门、不占 repair 配额、无第二轮。 */
export function validateDiagnosisExplanation(raw: unknown): DiagnosisExplanation {
  if (!isRecord(raw)) throw new Error("diagnosis explanation must be an object");
  const { likelyCause, explanation, suggestions } = raw;
  if (typeof likelyCause !== "string" || likelyCause.trim().length === 0 || likelyCause.length > 500) {
    throw new Error("diagnosis likelyCause must be a non-empty string (≤500 chars)");
  }
  if (typeof explanation !== "string" || explanation.trim().length === 0 || explanation.length > 4000) {
    throw new Error("diagnosis explanation must be a non-empty string (≤4000 chars)");
  }
  if (
    !Array.isArray(suggestions) ||
    suggestions.length > 10 ||
    !suggestions.every((item) => typeof item === "string" && item.trim().length > 0 && item.length <= 500)
  ) {
    throw new Error("diagnosis suggestions must be an array of non-empty strings (≤10 items, ≤500 chars each)");
  }
  return { likelyCause, explanation, suggestions };
}
```

（`isRecord` 若 analysis-service.ts 没有现成私有版，就地内联 `typeof raw === "object" && raw !== null && !Array.isArray(raw)`。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd chrome-plugin && npx vitest run src/background/prompts.test.ts src/background/analysis-service.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/background/prompts.ts src/background/prompts.test.ts src/background/analysis-service.ts src/background/analysis-service.test.ts
git commit -m "feat: 诊断提示词与形状校验（证据白名单，不含 URL/HTML）"
```

---

### Task 5: `CachedAnalysisService.explainDiagnosis`

**Files:**
- Modify: `chrome-plugin/src/background/analysis-service.ts`（接口 + 实现）
- Modify: `chrome-plugin/src/background/service-worker.test.ts`（`analysisService` 字面量 `:129-139` 补 `explainDiagnosis: vi.fn()`——接口加方法后该文件立即编译失败，必须同批修）
- Test: `chrome-plugin/src/background/analysis-service.test.ts`（追加 describe）

**Interfaces (Produces):**
```ts
export interface DiagnosisInput {
  profile: ModelProfile;
  documentId: string;
  diagnosis: BlockDiagnosis;
}
// AnalysisService 接口追加：
explainDiagnosis(input: DiagnosisInput, signal: AbortSignal): Promise<DiagnosisExplanation>;
```

两条硬要求（spec D3/重要7）：
1. 调度 `documentId` 用 `` `${input.documentId}:diagnosis` ``——`requestModel` 的 abort 监听会 `cancelDocument(documentId)`（`:1068`），不隔离就会连坐取消该页全部在飞 core 请求。
2. priority `"detail-click"`、`sentenceCount: 1`、不写任何缓存 store。

- [ ] **Step 1: 写失败测试**（照该文件既有 harness——`new CachedAnalysisService({ cache, adapter, scheduler })` 的 mock 构造，先读文件头 harness 定义）

```ts
describe("explainDiagnosis", () => {
  it("经调度器发出 detail-click 请求并返回校验后的解释", async () => {
    const { service, adapter, cache, scheduler } = harness([
      {
        likelyCause: "english ratio below threshold",
        explanation: "该块英文占比不足，被 non-english 门排除。",
        suggestions: ["确认目标段落是英文正文"],
      },
    ]);
    // harness 的 scheduler 是真 DedupeScheduler 实例（不是 vi.fn）——用 spy 取调度参数。
    const scheduleSpy = vi.spyOn(scheduler, "schedule");

    const result = await service.explainDiagnosis(
      { profile, documentId: "doc-1", diagnosis: sampleDiagnosis() },
      new AbortController().signal,
    );

    expect(result.likelyCause).toBe("english ratio below threshold");
    expect(adapter.completeJson).toHaveBeenCalledTimes(1);
    const scheduled = scheduleSpy.mock.calls[0]![0] as {
      priority: string;
      documentId: string;
    };
    expect(scheduled.priority).toBe("detail-click");
    expect(scheduled.documentId).toBe("doc-1:diagnosis"); // abort 连坐隔离
    expect(cache.core.size).toBe(0); // 诊断不写缓存
  });

  it("模型输出形状非法时抛错且不写缓存", async () => {
    const { service, cache } = harness([{ likelyCause: "" }]);
    await expect(
      service.explainDiagnosis(
        { profile, documentId: "doc-1", diagnosis: sampleDiagnosis() },
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    // MemoryCache 是普通类（putCore/putDetail 非 mock）——断言 store 为空，不是 toHaveBeenCalled。
    expect(cache.core.size).toBe(0);
    expect(cache.detail.size).toBe(0);
  });
});
```

（`harness(outputs)` 必须传参（`analysis-service.test.ts:140`）；`cache.core` / `cache.detail` 是 MemoryCache 的两个 Map store，见 `:84-105`。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd chrome-plugin && npx vitest run src/background/analysis-service.test.ts -t "explainDiagnosis"`
Expected: FAIL——方法不存在。

- [ ] **Step 3: 实现**（类内新增；`requestModel` 用法照 `analyzeDetail` `:772-796` 抄）

```ts
  async explainDiagnosis(input: DiagnosisInput, signal: AbortSignal): Promise<DiagnosisExplanation> {
    if (signal.aborted) throw cancellationError();
    const raw = await this.requestModel(
      input.profile,
      // abort 隔离后缀：requestModel 的 abort 监听会 cancelDocument(documentId)，
      // 诊断绝不能连坐取消该页正在跑的 core 请求（spec D3/重要7）。
      `${input.documentId}:diagnosis`,
      "detail-click",
      `diagnosis:${input.diagnosis.target.selectorPath}:${input.diagnosis.capturedAt}`,
      1,
      [{ role: "user", content: buildDiagnosisPrompt(input.diagnosis) }],
      DIAGNOSIS_SCHEMA,
      signal,
    );
    return validateDiagnosisExplanation(raw);
  }
```

（`buildDiagnosisPrompt` / `DIAGNOSIS_SCHEMA` / `validateDiagnosisExplanation` 来自 Task 4，prompts.ts 已是既有 import 源；`AnalysisService` 接口 `:181-193` 同步加签名；**`service-worker.ts:1078-1093` 的懒加载包装层 `defaultDependencies()` 也要加一行转发**，否则 SW 拿不到方法——转发写法照该文件 analysisService 其它方法的转发样板。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd chrome-plugin && npx vitest run src/background/analysis-service.test.ts`
Expected: PASS 全部。

- [ ] **Step 5: 提交**

```bash
git add src/background/analysis-service.ts src/background/analysis-service.test.ts src/background/service-worker.ts
git commit -m "feat: AnalysisService.explainDiagnosis（detail-click 档 + abort 隔离后缀）"
```

---

### Task 6: 协议第二层——SW 路由 + 右键菜单

**Files:**
- Modify: `chrome-plugin/src/background/service-worker.ts`（常量、菜单注册、`onClicked` 分支、`route()` 两个 case、`sendPageCommand` body 联合）
- Test: `chrome-plugin/src/background/service-worker.test.ts`（追加 describe）

**Interfaces (Produces):** 无新导出；行为契约：
- `DIAGNOSE_MENU_ID = "syntax-diagnose-block"`（常量放 `:28-29` 两个既有菜单 id 旁）
- `route()` 的 `EXPLAIN_DIAGNOSIS` 分支回 `DIAGNOSIS_RESULT`（不是 ERROR——错误嵌在 `modelError` 里，本地证据始终可用）
- `DIAGNOSE_BLOCK` 分支 = 穷尽性拒绝（`errorResponse(request.requestId, "MALFORMED_MESSAGE")`）

- [ ] **Step 1: 写失败测试**（照该文件既有 route 测试的 chromeApi mock / activeTabs 构造，先读文件内 `TEST_PROFILE` 或 `ANALYZE_DETAIL` 的路由用例样板）

```ts
describe("diagnosis 路由", () => {
  // 路由用例的调用方式照文件内既有 ANALYZE_DETAIL / TEST_PROFILE 路由用例的
  // chromeMock()/dependencies()/registerServiceWorker 三件套（先读文件头 harness）。

  it("注册第三个右键菜单项——同时更新被钉死的两项注册断言", async () => {
    // 既有用例 "creates both context menu commands exactly once on install"（:224-236）
    // 用 toEqual 钉死两项菜单的精确列表，加第三项必红：**修改该既有用例**（而非新增
    // 重复用例），期望数组改为三项：
    const subject = chromeMock();
    registerServiceWorker(dependencies(), subject.api);
    subject.events.runtime.onInstalled.listeners[0]!({ reason: "install" });
    await vi.waitFor(() => expect(subject.events.contextMenus.removeAll).toHaveBeenCalledOnce());
    expect(subject.events.contextMenus.create.mock.calls).toEqual([
      [{ id: "syntax-parse-selection", title: "解析选中文本", contexts: ["selection"] }],
      [{ id: "syntax-parse-context-block", title: "解析此区域", contexts: ["page"] }],
      [{ id: "syntax-diagnose-block", title: "诊断：这段为什么没解析", contexts: ["page", "selection"] }],
    ]);
  });

  it("无 profile 时 EXPLAIN_DIAGNOSIS 回 DIAGNOSIS_RESULT 且 modelError=CONFIG_MISSING", async () => {
    configRepository.getActiveProfile.mockResolvedValue(undefined);
    const response = await route({ ...pageRequestBase, type: "EXPLAIN_DIAGNOSIS", diagnosis: sampleDiagnosis() });
    expect(response.type).toBe("DIAGNOSIS_RESULT");
    if (response.type !== "DIAGNOSIS_RESULT") return;
    expect(response.model).toBeUndefined();
    expect(response.modelError?.code).toBe("CONFIG_MISSING");
    expect(response.diagnosis).toEqual(sampleDiagnosis());
  });

  it("有 profile 时调 explainDiagnosis 并回填 model 与 profile.model", async () => {
    configRepository.getActiveProfile.mockResolvedValue(profile);
    analysisService.explainDiagnosis.mockResolvedValueOnce({
      likelyCause: "english ratio below threshold",
      explanation: "占比不足",
      suggestions: [],
    });
    const response = await route({ ...pageRequestBase, type: "EXPLAIN_DIAGNOSIS", diagnosis: sampleDiagnosis() });
    expect(analysisService.explainDiagnosis).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: pageRequestBase.documentId }),
      expect.any(AbortSignal),
    );
    if (response.type !== "DIAGNOSIS_RESULT") throw new Error("expected DIAGNOSIS_RESULT");
    expect(response.model?.likelyCause).toBe("english ratio below threshold");
    expect(response.profile).toEqual({ model: profile.model });
  });

  it("explainDiagnosis 抛错时 modelError 带错误码且仍回 DIAGNOSIS_RESULT", async () => {
    configRepository.getActiveProfile.mockResolvedValue(profile);
    analysisService.explainDiagnosis.mockRejectedValueOnce(
      Object.assign(new Error("timeout"), { code: "REQUEST_TIMEOUT" }),
    );
    const response = await route({ ...pageRequestBase, type: "EXPLAIN_DIAGNOSIS", diagnosis: sampleDiagnosis() });
    if (response.type !== "DIAGNOSIS_RESULT") throw new Error("expected DIAGNOSIS_RESULT");
    expect(response.modelError?.code).toBe("REQUEST_TIMEOUT");
  });

  it("DIAGNOSE_BLOCK 入站被拒（无合法入站来源）", async () => {
    const response = await route({ ...pageRequestBase, type: "DIAGNOSE_BLOCK" });
    expect(response.type).toBe("ERROR");
    if (response.type === "ERROR") expect(response.error.code).toBe("MALFORMED_MESSAGE");
  });

  it("菜单点击下发 DIAGNOSE_BLOCK 且不写 activeTabs", async () => {
    activeTabsGet.mockReturnValue(undefined); // tab 无账
    await triggerMenuClick("syntax-diagnose-block", { selectionText: "hello" });
    expect(chromeApi.tabs.sendMessage).toHaveBeenCalledWith(
      expect.any(Number),
      expect.objectContaining({ type: "DIAGNOSE_BLOCK", selectionText: "hello" }),
    );
    expect(activeTabsSet).not.toHaveBeenCalled(); // spec D1：不记账、不伪造 running
  });
});
```

（下方路由用例里的 `route(...)` / `configRepository` / `analysisService` / `profile` / `pageRequestBase` / `activeTabsGet`/`activeTabsSet` 是**行为断言的简写**——落到该文件的真实 harness 上：`chromeMock()` + `dependencies(覆盖)` + `registerServiceWorker`，路由调用方式照文件内既有 `ANALYZE_DETAIL` / `TEST_PROFILE` 路由用例的 dispatch 写法（先读文件），请求基线照既有页面请求用例构造。断言体（右侧 expect 部分）照抄不改。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd chrome-plugin && npx vitest run src/background/service-worker.test.ts -t "diagnosis"`
Expected: FAIL。

- [ ] **Step 3: 实现**（service-worker.ts 五处）

1. 常量（`:28-29` 旁）：`const DIAGNOSE_MENU_ID = "syntax-diagnose-block";`
2. 菜单注册（`onInstalled` 内、既有两项之后）：

```ts
      chromeApi.contextMenus.create({
        id: DIAGNOSE_MENU_ID,
        title: "诊断：这段为什么没解析",
        contexts: ["page", "selection"],
      });
```

3. `onClicked` 分支（`CONTEXT_BLOCK_MENU_ID` 分支之后）：

```ts
    if (info.menuItemId === DIAGNOSE_MENU_ID) {
      void (async () => {
        await hydrated;
        const documentId = activeTabs.get(tabId)?.documentId ?? generatedDocumentId(tabId);
        await inject(tabId);
        // 诊断是只读手势，刻意不写 activeTabs：记账会把未启动会话的 tab 伪造成
        // running，popup 随即显示不存在的进行中会话，还绕过「解析此区域」的 stopped
        // 门（spec D1）。一致性门无账时放行、有账时此处已复用账上 documentId。
        await sendPageCommand(tabId, documentId, {
          type: "DIAGNOSE_BLOCK",
          ...(typeof info.selectionText === "string" && info.selectionText.trim().length > 0
            ? { selectionText: info.selectionText }
            : {}),
        });
      })().catch(() => {
        // chrome:// 等不可注入页面：静默忽略（与 commands 分支同款）。
      });
      return;
    }
```

4. `sendPageCommand` 的 body 联合（`:352-369`）追加 `| { type: "DIAGNOSE_BLOCK"; selectionText?: string }`。
5. `route()` switch 两个 case（放 `TEST_PROFILE` 分支后）：

```ts
        case "EXPLAIN_DIAGNOSIS": {
          const profile = await profileFor(request.tabId);
          const base = {
            version: MESSAGE_VERSION,
            requestId: request.requestId,
            type: "DIAGNOSIS_RESULT",
            diagnosis: request.diagnosis,
          } as const;
          if (profile === undefined) {
            return { ...base, modelError: errorResponse(request.requestId, "CONFIG_MISSING").error };
          }
          if (isProfilePaused(profile)) {
            return { ...base, modelError: errorResponse(request.requestId, "AUTH_FAILED").error };
          }
          try {
            const model = await dependencies.analysisService.explainDiagnosis(
              { profile, documentId: request.documentId, diagnosis: request.diagnosis },
              new AbortController().signal,
            );
            return {
              ...base,
              // 模型回文本出站前脱敏（spec D3）：先读 redactProfileSecrets 的真实签名（:134-139），
              // 若它是 (text: string) => string 就逐字段套用；若是深脱敏就直接传对象。
              model: redactDiagnosisExplanation(model),
              profile: { model: profile.model },
            };
          } catch (error) {
            const code = errorCode(error);
            if (code === "AUTH_FAILED") pauseProfile(profile);
            return { ...base, modelError: errorResponse(request.requestId, code).error };
          }
        }
        case "DIAGNOSE_BLOCK":
          // 没有合法入站来源（SW 只发不收）；case 仅为满足 assertNever 穷尽性。
          return errorResponse(request.requestId, "MALFORMED_MESSAGE");
```

`redactDiagnosisExplanation` 是本文件新增的小 helper：

```ts
// redactProfileSecrets 的真实签名是 (value: string, profile: ModelProfile)（:134-139）。
function redactDiagnosisExplanation(
  model: DiagnosisExplanation,
  profile: ModelProfile,
): DiagnosisExplanation {
  return {
    likelyCause: redactProfileSecrets(model.likelyCause, profile),
    explanation: redactProfileSecrets(model.explanation, profile),
    suggestions: model.suggestions.map((item) => redactProfileSecrets(item, profile)),
  };
}
```

（调用处相应改为 `model: redactDiagnosisExplanation(model, profile)`；`DiagnosisExplanation` 从 `../shared/protocol` import。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd chrome-plugin && npx vitest run src/background/service-worker.test.ts`
Expected: PASS 全部（含按 Step 1 更新后的菜单注册断言；其余既有用例不红）。

- [ ] **Step 5: 提交**

```bash
git add src/background/service-worker.ts src/background/service-worker.test.ts
git commit -m "feat: SW 诊断路由与右键菜单（不记账，错误嵌 modelError）"
```

---

### Task 7: `block-diagnosis.ts` 证据采集

**Files:**
- Create: `chrome-plugin/src/content/block-diagnosis.ts`
- Modify: `docs/architecture/modules.md`（**同批**加一行——`architecture-docs.test.ts:113-121` 钉了新源文件必须出现在模块地图，拖到 Task 12 会让 Task 7-11 期间全量 `npm test` 带红）
- Test: `chrome-plugin/src/content/block-diagnosis.test.ts`

**Interfaces (Produces):**
```ts
export type DiagnosisTargetSource = "selection" | "contextmenu" | "body" | "extension-ascended";
export function recordDiagnosisTarget(event: Event): void;   // contextmenu 捕获监听用
export interface ResolvedDiagnosisTarget { element: Element | null; source: DiagnosisTargetSource }
export function resolveDiagnosisTarget(doc?: Document): ResolvedDiagnosisTarget;
export interface DiagnoseElementInput {
  target: Element | null;
  targetSource: DiagnosisTargetSource;
  selectionText?: string;
  document: Document;
  sessionSnapshot?: (element: Element | null) => SessionDiagnosisSnapshot;
  url: string;
  now?: () => Date;
}
export function diagnoseElement(input: DiagnoseElementInput): BlockDiagnosis;
```

（`BlockDiagnosis` / `SessionDiagnosisSnapshot` import 自 `../shared/protocol`。）

- [ ] **Step 1: 写失败测试**（新文件，头两行 `// @vitest-environment happy-dom`）

```ts
// @vitest-environment happy-dom
import { describe, expect, it, beforeEach } from "vitest";
import { diagnoseElement, recordDiagnosisTarget, resolveDiagnosisTarget } from "./block-diagnosis";

const baseInput = {
  document,
  url: "https://example.com/docs?page=3#section",
  sessionSnapshot: () => ({ state: "stopped" as const, registered: false, sentences: [] }),
  now: () => new Date("2026-10-11T00:00:00Z"),
};

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("resolveDiagnosisTarget（spec D1 落点优先级：选区锚点 → 右键落点 → body）", () => {
  it("recordDiagnosisTarget 记录元素，resolve 返回 contextmenu 源", () => {
    document.body.innerHTML = '<main><p id="p">Text</p></main>';
    recordDiagnosisTarget({ target: document.getElementById("p") } as unknown as Event);
    const resolved = resolveDiagnosisTarget();
    expect(resolved.element).toBe(document.getElementById("p"));
    expect(resolved.source).toBe("contextmenu");
  });

  it("选区锚点优先于右键落点（spec D1：三者都记进报告）", () => {
    document.body.innerHTML = '<main><p id="a">First para.</p><p id="b">Second para.</p></main>';
    recordDiagnosisTarget({ target: document.getElementById("b") } as unknown as Event);
    const selection = document.getSelection();
    const range = document.createRange();
    range.selectNodeContents(document.getElementById("a")!);
    selection?.removeAllRanges();
    selection?.addRange(range);
    const resolved = resolveDiagnosisTarget();
    // happy-dom 的 getSelection 实现有限：若 anchorNode 取不到就跳过该断言分支（真机/E2E 覆盖）
    if (selection?.anchorNode != null) {
      expect(resolved.source).toBe("selection");
      expect(resolved.element).toBe(document.getElementById("a"));
    }
  });

  it("无选区无记录时回落 body", () => {
    document.body.innerHTML = "<main><p>x</p></main>";
    recordDiagnosisTarget({ target: null } as unknown as Event); // 清掉记录
    const resolved = resolveDiagnosisTarget();
    expect(resolved.element).toBe(document.body);
    expect(resolved.source).toBe("body");
  });

  it("S4：documentElement 的 ready 标记不算扩展自身元素；卡片/胶囊才上溯", () => {
    // installContentScript 会在 <html> 上设 data-syntax-learning-extension="ready"
    // （content-script.ts:462）——任何元素 closest 都会命中它；若把它当扩展元素，
    // 生产环境所有落点都会退化成 html.parentElement === null。必须排除。
    document.documentElement.dataset.syntaxLearningExtension = "ready";
    document.body.innerHTML = '<main><p id="p">Text</p></main>';
    recordDiagnosisTarget({ target: document.getElementById("p") } as unknown as Event);
    expect(resolveDiagnosisTarget().element).toBe(document.getElementById("p"));
    delete document.documentElement.dataset.syntaxLearningExtension;

    // 真正的扩展元素（卡片 host）仍然上溯并标记 extension-ascended
    document.body.innerHTML = '<main><div id="wrap"><div data-syntax-learning-block></div></div></main>';
    const card = document.querySelector("[data-syntax-learning-block]")!;
    recordDiagnosisTarget({ target: card } as unknown as Event);
    const resolved = resolveDiagnosisTarget();
    expect(resolved.element).toBe(document.getElementById("wrap"));
    expect(resolved.source).toBe("extension-ascended");
  });
});

describe("diagnoseElement", () => {
  it("非英文段落的证据指向 english-dominant 门并带数值", () => {
    document.body.innerHTML = '<main><p id="mixed">Hello 你好世界测试数据</p></main>';
    const diagnosis = diagnoseElement({
      ...baseInput,
      target: document.getElementById("mixed"),
      targetSource: "contextmenu",
    });
    const gate = diagnosis.gates.find(({ gate }) => gate === "english-dominant")!;
    expect(gate.ok).toBe(false);
    expect(gate.value).toBeLessThan(0.6);
    expect(diagnosis.inventory.exclusionReason).toBe("non-english");
  });

  it("text 度量与短块阈值进证据", () => {
    document.body.innerHTML = '<main><div id="tiny">Short text</div></main>';
    const diagnosis = diagnoseElement({
      ...baseInput,
      target: document.getElementById("tiny"),
      targetSource: "contextmenu",
    });
    expect(diagnosis.text.minAutoTextLength).toBe(20);
    expect(diagnosis.text.length).toBe(10);
  });

  it("segmentation 用生产分句/分词", () => {
    document.body.innerHTML =
      '<main><p id="two">First sentence here. Second sentence there now.</p></main>';
    const diagnosis = diagnoseElement({
      ...baseInput,
      target: document.getElementById("two"),
      targetSource: "contextmenu",
    });
    expect(diagnosis.segmentation.sentenceCount).toBe(2);
    expect(diagnosis.segmentation.tokenCount).toBeGreaterThan(4);
    expect(diagnosis.segmentation.emptyText).toBe(false);
  });

  it("URL 去 query 与 fragment；outerHTML 截断并脱敏表单值", () => {
    document.body.innerHTML =
      '<main><p id="x" data-secret="keep">Value <input value="hunter2"></p></main>';
    const diagnosis = diagnoseElement({
      ...baseInput,
      target: document.getElementById("x"),
      targetSource: "contextmenu",
    });
    expect(diagnosis.page.url).toBe("https://example.com/docs");
    expect(diagnosis.target.outerHtml).not.toContain("hunter2");
    expect(diagnosis.target.outerHtml.length).toBeLessThanOrEqual(220); // 200 + 少量省略标记
  });

  it("requestFeasibility 标出超长句并带两档批上限", () => {
    document.body.innerHTML = `<main><p id="long">${"word ".repeat(600)}</p></main>`;
    const diagnosis = diagnoseElement({
      ...baseInput,
      target: document.getElementById("long"),
      targetSource: "contextmenu",
    });
    expect(diagnosis.requestFeasibility.maxSentenceLength).toBeGreaterThan(2000);
    expect(diagnosis.requestFeasibility.sentenceLengthLimit).toBe(2000);
    expect(diagnosis.requestFeasibility.maxSentencesPerRequest).toBe(6);
    expect(diagnosis.requestFeasibility.cloudSentencesPerRequest).toBe(2);
  });

  it("会话快照透传", () => {
    document.body.innerHTML = '<main><p id="p">Some English words here.</p></main>';
    const snapshot = { state: "running" as const, registered: true, sentences: [{ text: "x", phase: "failed", failureMessage: "INVALID_MODEL_OUTPUT：bad" }] };
    const diagnosis = diagnoseElement({
      ...baseInput,
      target: document.getElementById("p"),
      targetSource: "contextmenu",
      sessionSnapshot: () => snapshot,
    });
    expect(diagnosis.session).toEqual(snapshot);
    expect(diagnosis.targetSource).toBe("contextmenu");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd chrome-plugin && npx vitest run src/content/block-diagnosis.test.ts`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 实现**（新文件完整结构；判定全部调生产函数）

```ts
import type { BlockDiagnosis, SessionDiagnosisSnapshot } from "../shared/protocol";
import { MAX_SENTENCES_PER_REQUEST } from "../shared/protocol";
import { CLOUD_SENTENCES_PER_REQUEST_FOR_CONTRACT } from "../background/analysis-service";
import { explainElement, inventoryReadableUnits, type ReadableUnit } from "./page-inventory";
import { nearestSafeBlock } from "./document-scanner";
import { normalizedReadableText } from "./readable-dom-text";
import { segmentBlock, tokenize } from "../language/segmenter";

const SENTENCE_LENGTH_LIMIT = 2_000;
const OUTER_HTML_LIMIT = 200;
// 注意：刻意不含 [data-syntax-learning-extension]——那是 installContentScript 设在
// <html> 上的「已安装」标记（content-script.ts:462），任何元素的 closest 都会命中它；
// 把它算进来会让生产环境所有落点退化成 html.parentElement === null（评审 S4）。
const EXTENSION_OWN_SELECTOR =
  "[data-syntax-learning-block],[data-syntax-learning-selection-anchor],[data-syntax-progress-pill],[data-syntax-diagnosis-panel]";

export type DiagnosisTargetSource = "selection" | "contextmenu" | "body" | "extension-ascended";

export interface ResolvedDiagnosisTarget {
  element: Element | null;
  source: DiagnosisTargetSource;
}

let lastTarget: Element | null = null;

export function recordDiagnosisTarget(event: Event): void {
  const target = event.target;
  if (target instanceof Element) lastTarget = target;
}

/** spec D1 落点优先级：选区锚点 → 右键落点 → body；扩展自身元素上溯。 */
export function resolveDiagnosisTarget(doc: Document = document): ResolvedDiagnosisTarget {
  // ① 选区锚点（getSelection().anchorNode 的 parentElement）
  const anchor = doc.getSelection()?.anchorNode?.parentElement ?? null;
  if (anchor !== null) return { element: anchor, source: "selection" };
  // ② 右键落点；落点在扩展自身元素（卡片/胶囊/面板 host）上时上溯到其父元素
  if (lastTarget !== null) {
    const own = lastTarget.closest(EXTENSION_OWN_SELECTOR);
    if (own === null) return { element: lastTarget, source: "contextmenu" };
    return { element: own.parentElement, source: "extension-ascended" };
  }
  // ③ 兜底
  return { element: doc.body, source: "body" };
}

function cssPath(element: Element): string {
  const parts: string[] = [];
  let current: Element | null = element;
  while (current !== null && current !== document.body && parts.length < 8) {
    let part = current.tagName.toLowerCase();
    if (current.id) part += `#${current.id}`;
    else if (current.classList.length > 0) part += `.${[...current.classList].slice(0, 2).join(".")}`;
    parts.unshift(part);
    current = current.parentElement;
  }
  return parts.join(" > ");
}

function sanitizedOuterHtml(element: Element): string {
  const raw = element.outerHTML
    .replace(/\s(value|checked|placeholder|src|href|data-secret)=("[^"]*"|'[^']*')/giu, "")
    .slice(0, OUTER_HTML_LIMIT);
  return raw.length === OUTER_HTML_LIMIT ? `${raw}…` : raw;
}

export interface DiagnoseElementInput {
  target: Element | null;
  targetSource: DiagnosisTargetSource;
  selectionText?: string;
  document: Document;
  sessionSnapshot?: (element: Element | null) => SessionDiagnosisSnapshot;
  url: string;
  now?: () => Date;
}

export function diagnoseElement(input: DiagnoseElementInput): BlockDiagnosis {
  const { target, document } = input;
  const text = target === null ? "" : normalizedReadableText(target);
  const gates = target === null ? [] : explainElement(target);
  const unit: ReadableUnit | undefined =
    target === null ? undefined : inventoryReadableUnits(document).find(({ element }) => element === target);
  const explicit = target === null ? null : nearestSafeBlock(target);
  const sentences = text.length === 0 ? [] : segmentBlock(text);
  const sentenceLengths = sentences.map(({ text: sentence }) => sentence.length);
  const tokenCount = sentences.reduce((sum, { text: sentence }) => sum + tokenize(sentence).length, 0);
  const englishGate = gates.find(({ gate }) => gate === "english-dominant");
  const letterGate = gates.find(({ gate }) => gate === "readable-words");
  let url = input.url;
  try {
    const parsed = new URL(input.url);
    parsed.search = "";
    parsed.hash = "";
    url = parsed.toString().replace(/\/$/u, "");
  } catch {
    /* 保持原值 */
  }
  return {
    target: target === null
      ? { tagName: "", className: "", id: "", selectorPath: "", outerHtml: "" }
      : {
          tagName: target.tagName,
          className: [...target.classList].join(" ").slice(0, 120),
          id: target.id,
          selectorPath: cssPath(target),
          outerHtml: sanitizedOuterHtml(target),
        },
    targetSource: input.targetSource,
    ...(input.selectionText === undefined ? {} : { selectionText: input.selectionText }),
    inventory: {
      isUnit: unit !== undefined,
      ...(unit === undefined ? {} : { kind: unit.kind }),
      automatic: unit?.automatic ?? false,
      ...(unit?.exclusionReason === undefined ? {} : { exclusionReason: unit.exclusionReason }),
    },
    explicit: {
      resolvable: explicit !== null,
      ...(explicit === null ? {} : { selectorPath: cssPath(explicit.element) }),
    },
    gates,
    text: {
      length: text.length,
      letterWords: typeof letterGate?.value === "number" ? letterGate.value : 0,
      ...(typeof englishGate?.value === "number" ? { englishRatio: englishGate.value } : {}),
      minAutoTextLength: 20,
    },
    segmentation: {
      sentenceCount: sentences.length,
      sentenceLengths,
      tokenCount,
      emptyText: text.length === 0,
    },
    requestFeasibility: {
      maxSentenceLength: sentenceLengths.reduce((max, length) => Math.max(max, length), 0),
      sentenceLengthLimit: SENTENCE_LENGTH_LIMIT,
      maxSentencesPerRequest: MAX_SENTENCES_PER_REQUEST,
      cloudSentencesPerRequest: CLOUD_SENTENCES_PER_REQUEST_FOR_CONTRACT,
    },
    session: input.sessionSnapshot?.(target) ?? { state: "stopped", registered: false, sentences: [] },
    page: { url, readyState: document.readyState },
    capturedAt: (input.now ?? (() => new Date()))().toISOString(),
  };
}
```

（`nearestSafeBlock` 的真实返回形态以 `document-scanner.ts:44-60` 为准——若它返回 `CandidateBlock` 形状，取 `.element`；`ReadableUnit.kind` 的真实字段名同上以 `page-inventory.ts:20-33` 为准。`CLOUD_SENTENCES_PER_REQUEST_FOR_CONTRACT` 已从 `analysis-service.ts` 导出（`cross-platform-contract.test.ts:4` 在用）；content import background 模块在该仓库已有先例吗——**若 vite 构建不允许 content→background 引用**，就把常量挪到 `shared/protocol.ts` 并让 analysis-service re-export，单一来源不变。提交前确认 `npm run build` 通过。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd chrome-plugin && npx vitest run src/content/block-diagnosis.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/content/block-diagnosis.ts src/content/block-diagnosis.test.ts docs/architecture/modules.md
git commit -m "feat: block-diagnosis 证据采集（复用生产判定，不复制判据）"
```

---

### Task 8: `formatDiagnosisReport` markdown 报告

**Files:**
- Modify: `chrome-plugin/src/content/block-diagnosis.ts`（追加导出）
- Test: `chrome-plugin/src/content/block-diagnosis.test.ts`（追加 describe）

**Interfaces (Produces):**
```ts
export interface DiagnosisReportOptions {
  model?: DiagnosisExplanation;
  modelError?: ExtensionError;
  profileModel?: string;
  extensionVersion?: string;
  generatedAt?: string;
}
export function formatDiagnosisReport(diagnosis: BlockDiagnosis, options?: DiagnosisReportOptions): string;
```

- [ ] **Step 1: 写失败测试**

```ts
describe("formatDiagnosisReport", () => {
  const diagnosisOf = (target: string) =>
    diagnoseElement({ ...baseInput, target: document.querySelector(target), targetSource: "contextmenu" });

  it("七个小节齐全且顺序固定", () => {
    document.body.innerHTML = '<main><p id="p">Hello world from the test page.</p></main>';
    const report = formatDiagnosisReport(diagnosisOf("#p"), {});
    const sections = ["## 概述", "## 页面与落点", "## 本地判定证据", "## 分句与请求可行性", "## 会话状态", "## 模型解释", "## 环境"];
    const positions = sections.map((s) => report.indexOf(s));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("概述点名第一个失败门", () => {
    document.body.innerHTML = '<main><p id="mixed">Hello 你好世界测试</p></main>';
    const report = formatDiagnosisReport(diagnosisOf("#mixed"), {});
    expect(report).toContain("english-dominant");
  });

  it("证据表逐门列出结果与取值", () => {
    document.body.innerHTML = '<main><p id="p">Some English words in the paragraph.</p></main>';
    const report = formatDiagnosisReport(diagnosisOf("#p"), {});
    expect(report).toMatch(/\| *english-dominant *\|/u);
    expect(report).toMatch(/\| *门 *\|/u);
  });

  it("模型解释段呈现三字段；无模型时呈现 modelError", () => {
    document.body.innerHTML = '<main><p id="p">Another English sentence here.</p></main>';
    const base = diagnosisOf("#p");
    const withModel = formatDiagnosisReport(base, {
      model: { likelyCause: "english ratio below threshold", explanation: "占比不足。", suggestions: ["检查语言"] },
      profileModel: "deepseek-flash",
      extensionVersion: "1.4.2",
      generatedAt: "2026-10-11T00:00:00Z",
    });
    expect(withModel).toContain("likelyCause: english ratio below threshold");
    expect(withModel).toContain("- 检查语言");
    expect(withModel).toContain("deepseek-flash");
    const withError = formatDiagnosisReport(base, {
      modelError: { code: "CONFIG_MISSING", message: "尚未配置", retryable: false },
    });
    expect(withError).toContain("CONFIG_MISSING");
  });

  it("URL 已去 query（进报告的是净化后 URL）", () => {
    document.body.innerHTML = '<main><p id="p">English words for the url check.</p></main>';
    const report = formatDiagnosisReport(diagnosisOf("#p"), {});
    expect(report).toContain("https://example.com/docs");
    expect(report).not.toContain("page=3");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd chrome-plugin && npx vitest run src/content/block-diagnosis.test.ts -t "formatDiagnosisReport"`
Expected: FAIL——未导出。

- [ ] **Step 3: 实现**（追加到 `block-diagnosis.ts`）

```ts
export interface DiagnosisReportOptions {
  model?: DiagnosisExplanation;
  modelError?: ExtensionError;
  profileModel?: string;
  extensionVersion?: string;
  generatedAt?: string;
}

export function formatDiagnosisReport(
  diagnosis: BlockDiagnosis,
  options: DiagnosisReportOptions = {},
): string {
  const firstFailing = diagnosis.gates.find(({ ok }) => !ok);
  const overview = firstFailing
    ? `第一个失败门是 \`${firstFailing.gate}\`${firstFailing.value === undefined ? "" : `（当时取值 ${firstFailing.value}）`}。`
    : diagnosis.session.sentences.some(({ phase }) => phase === "failed")
      ? "所有门均通过，但会话中存在失败句——问题在分析链路而非扫描门。"
      : "所有门均通过；该块应可解析。若页面无译文，请检查会话是否启动、视口是否触发。";
  const lines: string[] = [
    "# 段落诊断报告",
    "",
    `## 概述`,
    overview,
    "",
    `## 页面与落点`,
    `- URL: ${diagnosis.page.url}`,
    `- 落点来源: ${diagnosis.targetSource}（选择器路径 \`${diagnosis.target.selectorPath}\`）`,
    `- 目标元素: \`${diagnosis.target.tagName}\` class=\`${diagnosis.target.className}\``,
    `- outerHTML（截断并脱敏）: \`${diagnosis.target.outerHtml}\``,
    `- document.readyState: ${diagnosis.page.readyState}`,
    ...(diagnosis.selectionText === undefined
      ? []
      : [`- 选中文本: ${diagnosis.selectionText.slice(0, 200)}`, ""]),
    `## 本地判定证据`,
    `- inventory: ${diagnosis.inventory.isUnit ? "是语义单元" : "不是语义单元"}；automatic=${diagnosis.inventory.automatic}${diagnosis.inventory.exclusionReason === undefined ? "" : `；exclusionReason=\`${diagnosis.inventory.exclusionReason}\`}`,
    `- 显式手势路径: ${diagnosis.explicit.resolvable ? "可解析" : "不可解析"}`,
    "",
    `| 门 | 结果 | 当时取值 |`,
    `| --- | --- | --- |`,
    ...diagnosis.gates.map(
      ({ gate, ok, value }) => `| ${gate} | ${ok ? "✅" : "❌"} | ${value ?? ""} |`,
    ),
    "",
    `## 分句与请求可行性`,
    `- 分句数: ${diagnosis.segmentation.sentenceCount}；token 数: ${diagnosis.segmentation.tokenCount}`,
    `- 最长句: ${diagnosis.requestFeasibility.maxSentenceLength} / 上限 ${diagnosis.requestFeasibility.sentenceLengthLimit}`,
    `- 单请求句数上限: loopback ${diagnosis.requestFeasibility.maxSentencesPerRequest} / 云端 ${diagnosis.requestFeasibility.cloudSentencesPerRequest}`,
    "",
    `## 会话状态`,
    `- state: ${diagnosis.session.state}；registered: ${diagnosis.session.registered}${diagnosis.session.blockId === undefined ? "" : `（blockId \`${diagnosis.session.blockId}\`）`}`,
    ...diagnosis.session.sentences.map(
      ({ text, phase, failureMessage }) =>
        `- [${phase}] ${text.slice(0, 80)}${failureMessage === undefined ? "" : ` — ${failureMessage}`}`,
    ),
    "",
    `## 模型解释`,
    options.model
      ? [`likelyCause: ${options.model.likelyCause}`, "", options.model.explanation, "",
          ...options.model.suggestions.map((item) => `- ${item}`)].join("\n")
      : options.modelError
        ? `模型解释不可用：${options.modelError.code}：${options.modelError.message}`
        : "模型解释未返回（可能在途中）。",
    "",
    `## 环境`,
    `- 扩展版本: ${options.extensionVersion ?? "未知"}`,
    `- profile 模型: ${options.profileModel ?? "未返回 / 未配置"}`,
    `- 证据采集时间: ${diagnosis.capturedAt}；报告生成时间: ${options.generatedAt ?? "未知"}`,
  ];
  // 不做 filter：空行是小节分隔符，滤掉会让 markdown 渲染成一坨（评审 次要7）。
  return lines.join("\n").replace(/\n{3,}/gu, "\n\n") + "\n";
}
```

（`DiagnosisExplanation` / `ExtensionError` import 自 `../shared/protocol` / `../shared/errors`；可选段（选中文本）用条件 push 而不是空串占位。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd chrome-plugin && npx vitest run src/content/block-diagnosis.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/content/block-diagnosis.ts src/content/block-diagnosis.test.ts
git commit -m "feat: formatDiagnosisReport 结构化 markdown 报告"
```

---

### Task 9: `DiagnosisPanel` 面板组件

**Files:**
- Create: `chrome-plugin/src/content/diagnosis-panel.ts`
- Modify: `docs/architecture/modules.md`（同批加一行——理由同 Task 7 的 I9）
- Test: `chrome-plugin/src/content/diagnosis-panel.test.ts`

**Interfaces (Produces):**
```ts
export class DiagnosisPanel {
  readonly host: HTMLElement;
  constructor(doc?: Document);
  show(diagnosis: BlockDiagnosis): void;            // 渲染本地证据段（单例复用，就地更新）
  trackRequest(requestId: string): void;           // 记录最新请求，渲染"解释生成中…"
  updateModel(result: {
    requestId: string;                              // 过期响应直接忽略（requestId 即 generation）
    model?: DiagnosisExplanation;
    modelError?: ExtensionError;
    profile?: { model: string };
  }): void;
  report(): string;                                 // 点击复制时组装的完整 markdown
  close(): void;
}
```

- [ ] **Step 1: 写失败测试**（新文件，`// @vitest-environment happy-dom`；`sampleDiagnosis` 用 Task 3 的 baseDiagnosis 内联）

```ts
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiagnosisPanel } from "./diagnosis-panel";

const strip = (text: string | null | undefined) => (text ?? "").replace(/\s+/gu, " ").trim();

describe("DiagnosisPanel", () => {
  let panel: DiagnosisPanel;
  beforeEach(() => {
    panel = new DiagnosisPanel();
  });
  afterEach(() => {
    panel.close();
    document.documentElement.innerHTML = "";
  });

  it("show 渲染本地证据并挂载到 documentElement", () => {
    panel.show(sampleDiagnosis());
    expect(panel.host.isConnected).toBe(true);
    const text = strip(panel.host.shadowRoot!.textContent);
    expect(text).toContain("本地判定证据");
    expect(text).toContain("english-dominant");
    expect(text).toContain("模型解释生成中"); // show 后默认等待模型
  });

  it("updateModel 渲染解释；过期 requestId 被忽略", () => {
    panel.show(sampleDiagnosis());
    panel.trackRequest("req-2");
    panel.updateModel({ requestId: "req-1", model: { likelyCause: "stale", explanation: "旧", suggestions: [] } });
    expect(strip(panel.host.shadowRoot!.textContent)).not.toContain("stale");
    panel.updateModel({ requestId: "req-2", modelError: { code: "CONFIG_MISSING", message: "尚未配置", retryable: false } });
    expect(strip(panel.host.shadowRoot!.textContent)).toContain("CONFIG_MISSING");
  });

  it("report() 在模型返回后含解释与 profile 模型名", () => {
    panel.show(sampleDiagnosis());
    panel.trackRequest("req-1");
    panel.updateModel({
      requestId: "req-1",
      model: { likelyCause: "english ratio", explanation: "占比不足", suggestions: ["x"] },
      profile: { model: "deepseek-flash" },
    });
    const report = panel.report();
    expect(report).toContain("## 模型解释");
    expect(report).toContain("english ratio");
    expect(report).toContain("deepseek-flash");
  });

  it("复制按钮成功走剪贴板；失败降级 textarea", async () => {
    panel.show(sampleDiagnosis());
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    (panel.host.shadowRoot!.querySelector(".copy") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0]![0]).toContain("## 概述");

    const fail = vi.fn().mockRejectedValue(new Error("denied"));
    Object.assign(navigator, { clipboard: { writeText: fail } });
    (panel.host.shadowRoot!.querySelector(".copy") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      const area = panel.host.shadowRoot!.querySelector("textarea") as HTMLTextAreaElement | null;
      expect(area).not.toBeNull();
      expect(area!.value).toContain("## 概述");
    });
  });

  it("隐私提示两句都在面板上", () => {
    panel.show(sampleDiagnosis());
    const text = strip(panel.host.shadowRoot!.textContent);
    expect(text).toContain("粘贴到外部工具前请自查");
    expect(text).toContain("发送给你配置的模型服务");
  });

  it("close 移除 host", () => {
    panel.show(sampleDiagnosis());
    panel.close();
    expect(panel.host.isConnected).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd chrome-plugin && npx vitest run src/content/diagnosis-panel.test.ts`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 实现**（结构照 `progress-pill.ts:54-146` 的样板：host + open shadow root + `documentElement.append`）

```ts
import type { BlockDiagnosis, DiagnosisExplanation } from "../shared/protocol";
import type { ExtensionError } from "../shared/errors";
import { formatDiagnosisReport } from "./block-diagnosis";

const STYLES = `
  :host { all: initial; }
  .panel {
    all: initial;
    position: fixed; right: 16px; bottom: 64px; z-index: 2147483647;
    max-width: min(560px, calc(100vw - 32px)); max-height: 60vh; overflow: auto;
    font: 13px/1.6 system-ui, sans-serif; color: #111;
    background: #fff; border: 1px solid #d4d4d8; border-radius: 10px;
    padding: 12px 14px; box-shadow: 0 8px 24px rgba(0,0,0,.18);
  }
  .privacy { font-size: 11px; color: #71717a; margin: 4px 0 8px; }
  .gate-table { border-collapse: collapse; font-size: 12px; }
  .gate-table td, .gate-table th { border: 1px solid #e4e4e7; padding: 1px 6px; }
  .model-pending { color: #71717a; }
  .model-error { color: #b91c1c; }
  .toolbar { display: flex; gap: 8px; margin-top: 8px; }
  button { all: initial; font: inherit; cursor: pointer; padding: 3px 10px;
    border: 1px solid #a1a1aa; border-radius: 6px; }
  button.primary { background: #18181b; color: #fff; }
  textarea { width: 100%; height: 120px; font: 11px/1.4 monospace; margin-top: 8px; }
`;

export class DiagnosisPanel {
  readonly host: HTMLElement;
  #doc: Document;
  #diagnosis?: BlockDiagnosis;
  #model?: DiagnosisExplanation;
  #modelError?: ExtensionError;
  #profile?: { model: string };
  #latestRequestId?: string;
  #root: HTMLDivElement;

  constructor(doc: Document = document) {
    this.#doc = doc;
    this.host = doc.createElement("div");
    this.host.dataset.syntaxDiagnosisPanel = "";
    const shadow = this.host.attachShadow({ mode: "open" });
    const style = doc.createElement("style");
    style.textContent = STYLES;
    this.#root = doc.createElement("div");
    this.#root.className = "panel";
    shadow.append(style, this.#root);
  }

  show(diagnosis: BlockDiagnosis): void {
    this.#diagnosis = diagnosis;
    this.#model = undefined;
    this.#modelError = undefined;
    this.#profile = undefined;
    this.#render("模型解释生成中…");
    if (!this.host.isConnected) this.#doc.documentElement.append(this.host);
  }

  trackRequest(requestId: string): void {
    this.#latestRequestId = requestId;
  }

  updateModel(result: {
    requestId: string;
    model?: DiagnosisExplanation;
    modelError?: ExtensionError;
    profile?: { model: string };
  }): void {
    // requestId 即 generation（spec D5/重要7）：晚到的旧响应直接丢弃。
    if (result.requestId !== this.#latestRequestId) return;
    this.#model = result.model;
    this.#modelError = result.modelError;
    this.#profile = result.profile;
    this.#renderModel();
  }

  report(): string {
    if (this.#diagnosis === undefined) return "";
    return formatDiagnosisReport(this.#diagnosis, {
      ...(this.#model === undefined ? {} : { model: this.#model }),
      ...(this.#modelError === undefined ? {} : { modelError: this.#modelError }),
      ...(this.#profile === undefined ? {} : { profileModel: this.#profile.model }),
      generatedAt: new Date().toISOString(),
    });
  }

  close(): void {
    this.host.remove();
  }

  #render(modelHtml: string): void {
    const d = this.#diagnosis;
    if (d === undefined) return;
    const firstFailing = d.gates.find(({ ok }) => !ok);
    this.#root.replaceChildren();
    const title = this.#doc.createElement("strong");
    title.textContent = "这段为什么没被翻译";
    const close = this.#doc.createElement("button");
    close.textContent = "关闭";
    close.addEventListener("click", () => this.close());
    const privacy = this.#doc.createElement("p");
    privacy.className = "privacy";
    privacy.textContent =
      "报告含页面 URL 与截断 HTML，粘贴到外部工具前请自查。模型解释会把判定证据（不含 URL 与 HTML）发送给你配置的模型服务。";
    const evidence = this.#doc.createElement("div");
    evidence.append(this.#heading("本地判定证据"));
    const summary = this.#doc.createElement("p");
    summary.textContent = firstFailing
      ? `第一个失败门：${firstFailing.gate}${firstFailing.value === undefined ? "" : `（取值 ${firstFailing.value}）`}`
      : "所有扫描门均通过";
    evidence.append(summary);
    const table = this.#doc.createElement("table");
    table.className = "gate-table";
    for (const { gate, ok, value } of d.gates) {
      const row = table.insertRow();
      row.insertCell().textContent = gate;
      row.insertCell().textContent = ok ? "✅" : "❌";
      row.insertCell().textContent = value === undefined ? "" : String(value);
    }
    evidence.append(table);
    const modelSection = this.#doc.createElement("div");
    modelSection.className = "model-section";
    modelSection.innerHTML = modelHtml;
    const toolbar = this.#doc.createElement("div");
    toolbar.className = "toolbar";
    const copy = this.#doc.createElement("button");
    copy.className = "primary copy";
    copy.textContent = "复制诊断报告";
    copy.addEventListener("click", () => void this.#copy(copy));
    toolbar.append(copy);
    this.#root.append(title, close, privacy, evidence, modelSection, toolbar);
    this.#modelSection = modelSection;
  }

  #modelSection: HTMLDivElement | undefined;

  #renderModel(): void {
    if (this.#modelSection === undefined) return;
    this.#modelSection.replaceChildren();
    this.#modelSection.append(this.#heading("模型解释"));
    if (this.#model !== undefined) {
      const cause = this.#doc.createElement("p");
      cause.textContent = `likelyCause: ${this.#model.likelyCause}`;
      const body = this.#doc.createElement("p");
      body.textContent = this.#model.explanation;
      this.#modelSection.append(cause, body, ...this.#model.suggestions.map((item) => {
        const li = this.#doc.createElement("div");
        li.textContent = `- ${item}`;
        return li;
      }));
      return;
    }
    const error = this.#doc.createElement("p");
    error.className = this.#modelError === undefined ? "model-pending" : "model-error";
    error.textContent =
      this.#modelError === undefined
        ? "模型解释生成中…"
        : `模型解释不可用：${this.#modelError.code}：${this.#modelError.message}（本地证据仍完整）`;
    this.#modelSection.append(error);
  }

  #heading(text: string): HTMLHeadingElement {
    const h = this.#doc.createElement("h4");
    h.textContent = text;
    return h;
  }

  async #copy(button: HTMLButtonElement): Promise<void> {
    const report = this.report();
    try {
      await navigator.clipboard.writeText(report);
      button.textContent = "已复制";
      return;
    } catch {
      // 非安全上下文 / 权限拒绝：展开已全选的只读 textarea 兜底（在 shadow root 内，
      // 不是 button 内，因此可选可复制）。
      const area = this.#doc.createElement("textarea");
      area.readOnly = true;
      area.value = report;
      this.#root.append(area);
      area.focus();
      area.select();
      button.textContent = "请按 ⌘C / Ctrl+C 复制";
    }
  }
}
```

（`show` 里 `#render("模型解释生成中…")` 与 `#renderModel` 有少量重复——实现时可统一为 `#render()` 内部按状态渲染模型段；测试断言的是行为，不锁内部结构。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd chrome-plugin && npx vitest run src/content/diagnosis-panel.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/content/diagnosis-panel.ts src/content/diagnosis-panel.test.ts docs/architecture/modules.md
git commit -m "feat: DiagnosisPanel 面板（requestId 防过期响应，剪贴板降级）"
```

---

### Task 10: 协议第三层——content 接线

**Files:**
- Modify: `chrome-plugin/src/content/content-script.ts`（`isRuntimeResponse` case、入站拒绝列表、router case、`RoutedController` 接口扩两个成员、`installContentScript` 装配落点监听）
- Modify: `chrome-plugin/src/content/session-controller.ts`（`RoutedController` 需要暴露 `transport`——给 `SessionController` 加一个 public getter，见 Step 3 第 4 点）
- Test: **新建 `chrome-plugin/src/content/content-script-diagnosis.test.ts`**（isRuntimeResponse 是 content-script 的导出，可直接单测；router 行为用 ContentScriptRouter + fake transportFactory 测）

**Interfaces (Produces):** 无新导出（`runDiagnosis` 为模块内私有）。

- [ ] **Step 1: 写失败测试**

```ts
// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { ContentScriptRouter, isRuntimeResponse } from "./content-script";
import type { RequestMessage, ResponseMessage } from "../shared/protocol";

const validResult: ResponseMessage = {
  version: 1,
  requestId: "r1",
  type: "DIAGNOSIS_RESULT",
  diagnosis: sampleDiagnosis(), // Task 3 的 baseDiagnosis 内联
  modelError: { code: "CONFIG_MISSING", message: "x", retryable: false },
};

describe("isRuntimeResponse 诊断 case", () => {
  it("合法 DIAGNOSIS_RESULT 通过守卫（case 缺了它必红——防三层漏一层的断言形态）", () => {
    expect(isRuntimeResponse(validResult, "r1")).toBe(true);
  });
  it("requestId 不匹配或载荷畸形被拒", () => {
    expect(isRuntimeResponse(validResult, "r2")).toBe(false);
    expect(
      isRuntimeResponse({ ...validResult, diagnosis: { broken: true } }, "r1"),
    ).toBe(false);
  });
});

describe("ContentScriptRouter 诊断命令", () => {
  it("DIAGNOSE_BLOCK 回 ack 且发出 EXPLAIN_DIAGNOSIS", async () => {
    const sent: RequestMessage[] = [];
    const fakeTransportInstance = {
      send: (message: RequestMessage) => {
        sent.push(message);
        return Promise.resolve(validResult); // 顶部那个合法 DIAGNOSIS_RESULT，requestId 换成消息里的
      },
    };
    const router = new ContentScriptRouter({
      transportFactory: () => fakeTransportInstance as unknown as ReturnType<
        typeof ChromeRuntimeTransport
      >,
    });
    document.body.innerHTML = '<p id="p">Hello target text here.</p>';
    // 先用 contextmenu 记录落点（capture 监听由 installContentScript 装配；单测里手动调）
    recordDiagnosisTarget({ target: document.getElementById("p") } as unknown as Event);

    const response = await router.route({ ...pageCommandBase, type: "DIAGNOSE_BLOCK" });
    expect(response.type).toBe("ACK");
    // runDiagnosis 同步执行到 transport.send（首个 await 前），route 返回时 sent 已就绪
    expect(sent.at(-1)?.type).toBe("EXPLAIN_DIAGNOSIS");
  });

  it("EXPLAIN_DIAGNOSIS 误入站返回 invalidMessage", async () => {
    const router = new ContentScriptRouter({});
    const response = await router.route({
      ...pageCommandBase,
      type: "EXPLAIN_DIAGNOSIS",
      diagnosis: sampleDiagnosis(),
    });
    expect(response.type).toBe("ERROR");
  });
});
```

（`pageCommandBase` / `fakeTransport` / `sampleDiagnosis` 在文件内构造；`recordDiagnosisTarget` import 自 `./block-diagnosis`。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd chrome-plugin && npx vitest run src/content/content-script-diagnosis.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**（content-script.ts 四处）

1. `isRuntimeResponse` switch（`:164-210`）加 case：

```ts
    case "DIAGNOSIS_RESULT":
      return (
        isBlockDiagnosis(value.diagnosis) &&
        (value.model === undefined || isDiagnosisExplanation(value.model)) &&
        (value.modelError === undefined || isExtensionError(value.modelError)) &&
        (value.profile === undefined || (isRecord(value.profile) && typeof value.profile.model === "string"))
      );
```

（`isBlockDiagnosis` 已在 Task 3 导出，直接 import；`isDiagnosisExplanation` 小守卫同文件内新增：三字段 typeof 检查。）

2. 入站拒绝列表（`:350-356`）追加 `request.type === "EXPLAIN_DIAGNOSIS"`。
3. `route()` switch 加 case（`PARSE_HOVERED_BLOCK` 后）：

```ts
        case "DIAGNOSE_BLOCK": {
          // 诊断编排是页面侧主动：本地证据立即上屏，模型解释走 EXPLAIN_DIAGNOSIS。
          // 不 await——页面命令只承诺"已受理"（ack），模型结果经面板回调呈现。
          void this.runDiagnosis(request);
          return ack(request);
        }
```

4. **transport 复用会话通道（评审 S5，关键）+ 编排方法**。诊断**绝不能新建 transport**：`ChromeRuntimeTransport` 构造即 `connectWatchdog()` 建第二个 `syntax-learning:<documentId>` 端口（`content-script.ts:314-315`），而 SW 的 `onConnect` 会无条件 `documentPorts.set(documentId, port)`（`service-worker.ts:987`）——会话运行中触发一次诊断，流式推送就改走没有注册任何 handler 的新端口，会话的流式预览静默断流。router 的 `controller()` 已经为每个 documentId 建好了 controller+transport，诊断复用它。

先给 `SessionController` 加 public getter 并扩 `RoutedController` 接口（`content-script.ts:18-29`）：

```ts
// session-controller.ts（Task 2 的提交里一并加）：
/** 诊断等页面侧一次性请求复用会话通道——绝不能另开端口（会劫持流式推送）。 */
get transport(): RuntimeTransport {
  return this.options.transport;
}

// content-script.ts 的 RoutedController 接口追加两个成员：
//   readonly transport: RuntimeTransport;
//   diagnosisSnapshot(element: Element | null): SessionDiagnosisSnapshot;
```

router 内编排（**`diagnosisPanel` 惰性单例必须真的定义**，评审 I2）：

```ts
  private diagnosisPanelInstance?: DiagnosisPanel;
  private diagnosisRequestCounter = 0;

  private diagnosisPanel(): DiagnosisPanel {
    if (this.diagnosisPanelInstance === undefined) {
      this.diagnosisPanelInstance = new DiagnosisPanel();
    }
    return this.diagnosisPanelInstance;
  }

  private async runDiagnosis(request: DiagnoseBlockRequest): Promise<void> {
    const panel = this.diagnosisPanel();
    const controller = this.controller(request.tabId, request.documentId);
    const { element, source } = resolveDiagnosisTarget();
    const diagnosis = diagnoseElement({
      target: element,
      targetSource: source,
      ...(request.selectionText === undefined ? {} : { selectionText: request.selectionText }),
      document,
      sessionSnapshot: (target) => controller.diagnosisSnapshot(target),
      url: location.href,
    });
    panel.show(diagnosis);
    const requestId = `${request.documentId}:diagnosis:${++this.diagnosisRequestCounter}`;
    panel.trackRequest(requestId);
    const response = await controller.transport.send({
      version: MESSAGE_VERSION,
      requestId,
      type: "EXPLAIN_DIAGNOSIS",
      tabId: request.tabId,
      documentId: request.documentId,
      diagnosis,
    });
    if (response.type === "DIAGNOSIS_RESULT") {
      panel.updateModel({
        requestId,
        ...(response.model === undefined ? {} : { model: response.model }),
        ...(response.modelError === undefined ? {} : { modelError: response.modelError }),
        ...(response.profile === undefined ? {} : { profile: response.profile }),
      });
      return;
    }
    panel.updateModel({
      requestId,
      modelError:
        response.type === "ERROR"
          ? response.error
          : { code: "INVALID_MODEL_OUTPUT", message: "响应不是 DIAGNOSIS_RESULT", retryable: false },
    });
  }
```

（`DiagnoseBlockRequest` 类型 = `Extract<RequestMessage, { type: "DIAGNOSE_BLOCK" }>`；`resolveDiagnosisTarget` / `diagnoseElement` / `DiagnosisPanel` import 自 `./block-diagnosis` / `./diagnosis-panel`。测试的 `transportFactory` fake 会同时喂给 controller 与诊断——`send` 里按 `message.type` 区分回应即可。）

5. `installContentScript()`（`:430-465`）装配两件事（`installHoverTracker(document)` 之后）：

```ts
  // 诊断落点：contextmenu 捕获监听，与 SessionController 的 contextTarget 无关——
  // 那个只在会话运行时记录，而「识别不出段落」的用户多半没启动会话（spec D1）。
  document.addEventListener("contextmenu", recordDiagnosisTarget, true);
```

（面板实例由 router 内部惰性创建，install 处不需要额外装配。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd chrome-plugin && npx vitest run src/content/content-script-diagnosis.test.ts src/content/session-controller.test.ts src/content/content-script-related 2>/dev/null || npx vitest run src/content/content-script-diagnosis.test.ts src/content/session-controller.test.ts`
Expected: PASS（若 content-script.ts 已有旧测试文件，一并跑，确认 additive）。

- [ ] **Step 5: 提交**

```bash
git add src/content/content-script.ts src/content/session-controller.ts src/content/content-script-diagnosis.test.ts
git commit -m "feat: content 接线诊断命令与面板（复用会话通道，第三层守卫 + 落点捕获监听）"
```

---

### Task 11: 假服务器应答 + E2E

**Files:**
- Modify: `chrome-plugin/tests/support/fake-openai-server.ts`（`detectKind` + `respondAuto` 的 diagnosis 分支）
- Create: `chrome-plugin/tests/e2e/diagnose.spec.ts`
- Modify: `chrome-plugin/tests/e2e/fixtures.ts`（若 harness 需要暴露 `serviceWorker.evaluate` 下的页面命令发送 helper——先读 `:136-180`，已有就不用改）

**Interfaces (Produces):** `detectKind` 新值 `"diagnosis"`（`RequestKind` 联合追加）；E2E 走既有 `serviceWorker.evaluate` 驱动页面命令的模式。

- [ ] **Step 1: 写失败 E2E**（`tests/e2e/diagnose.spec.ts`；参考 `tests/e2e/extension.spec.ts` 里「显式手势」与 fixtures 的假服务器探针断言写法）

```ts
// fixtures.ts 的真实导出是扩展后的 test/expect（:105/:209），测试从 "./fixtures" 导入；
// harness fixture 暴露 serviceWorker/fakeModel/pagesOrigin/seedProfiles/tabIdFor（:85-103）。
import { expect, test } from "./fixtures";

// 剪贴板读取需要授权（fixture 页是 http://127.0.0.1 源，可授）。
test.use({ permissions: ["clipboard-read"] });

/** 经 SW 侧 chrome.tabs.sendMessage 下发 DIAGNOSE_BLOCK——Playwright 点不开原生右键菜单。 */
async function sendDiagnoseBlock(harness: ExtensionHarness, tabId: number): Promise<unknown> {
  return harness.serviceWorker.evaluate(
    (id: number) =>
      chrome.tabs.sendMessage(id, {
        version: 1,
        requestId: `e2e-diagnose-${Date.now()}`,
        type: "DIAGNOSE_BLOCK",
        tabId: id,
        documentId: "e2e-diagnosis",
      }),
    tabId,
  );
}

test.describe("段落诊断", () => {
  test("诊断命令 → 面板出现 → 发了模型请求 → 报告可复制", async ({ page, harness }) => {
    // seed 的写法照既有 spec（如 extension.spec.ts）里 seedProfiles 的调用；baseUrl 指向假服务器。
    await harness.seedProfiles(
      [{ id: "p1", name: "fake", baseUrl: harness.fakeModel.url(), apiKey: "k", model: "m" }],
      "p1",
    );
    // fixture 页的 goto 照 page-coverage.spec.ts 里同名页的写法（pagesOrigin 下的固定路径）。
    await page.goto(`${harness.pagesOrigin}/spring-ai-coverage.html`);
    const tabId = await harness.tabIdFor(page.url());

    await sendDiagnoseBlock(harness, tabId);

    await expect(page.locator("[data-syntax-diagnosis-panel]")).toBeAttached();
    // 探针断言（不用墙钟）：假服务器确实收到 diagnosis 请求（记录 API 是 recordedOfKind）。
    await expect
      .poll(() => harness.fakeModel.recordedOfKind("diagnosis").length)
      .toBeGreaterThanOrEqual(1);
    const panel = page.locator("[data-syntax-diagnosis-panel]");
    await expect(panel).toContainText("本地判定证据");
    await expect(panel).toContainText("english-dominant");
    await panel.locator(".copy").click();
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toContain("## 概述");
    expect(clip).toContain("## 模型解释");
  });

  test("无 profile → 面板只出本地段，modelError=CONFIG_MISSING，且不发请求", async ({ page, harness }) => {
    // 刻意不 seedProfiles：storage 里没有可用档案。
    await page.goto(`${harness.pagesOrigin}/spring-ai-coverage.html`);
    const tabId = await harness.tabIdFor(page.url());

    await sendDiagnoseBlock(harness, tabId);

    const panel = page.locator("[data-syntax-diagnosis-panel]");
    await expect(panel).toContainText("CONFIG_MISSING");
    expect(harness.fakeModel.recorded().length).toBe(0);
    await panel.locator(".copy").click();
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toContain("## 本地判定证据");
  });
});
```

（`harness.fakeModel` 是 Node 侧的 `FakeOpenAiServer` 实例，`recordedOfKind(kind)`（`:437-439`）与 `recorded()`（`:433`）直接可用；`fakeModel.url()` 若与实际方法名不符，以 `FakeOpenAiServer` 的真实取 URL 方法为准（先读一遍）。fixture 页路径、seedProfiles 的 profile 字段照 `tests/e2e/extension.spec.ts` / `page-coverage.spec.ts` 的既有用法对齐。）

- [ ] **Step 2: 跑 E2E 确认失败**

Run: `cd chrome-plugin && npx playwright test tests/e2e/diagnose.spec.ts`
Expected: FAIL——假服务器把诊断请求当 unknown/core 应答，面板模型段报错。

- [ ] **Step 3: 实现假服务器**（`fake-openai-server.ts` 三处）

1. `RequestKind`（`:13-23`）追加 `| "diagnosis"`。
2. `detectKind`（`:75-94`）追加（放在 `detail` 判定附近）：

```ts
  if (text.startsWith("Diagnose why the extension did not translate the page block")) {
    return "diagnosis";
  }
```

3. `respondAuto` 的 switch（`:613-669`）加分支（**必须经 `writeContent`**——红线）：

```ts
      case "diagnosis":
        await this.writeContent(
          response,
          JSON.stringify({
            likelyCause: "english ratio below threshold",
            explanation: "该块被 english-dominant 门排除：英文占比低于 0.6 阈值。",
            suggestions: ["确认该段是英文正文；中文内容不在自动解析范围内。"],
          }),
          streaming,
        );
        return;
```

- [ ] **Step 4: 跑 E2E 确认通过**

Run: `cd chrome-plugin && npx playwright test tests/e2e/diagnose.spec.ts && npx playwright test`
Expected: 新用例 PASS；既有 37 用例不红。

- [ ] **Step 5: 提交**

```bash
git add tests/support/fake-openai-server.ts tests/e2e/diagnose.spec.ts tests/e2e/fixtures.ts
git commit -m "feat: 假服务器 diagnosis 应答与段落诊断 E2E"
```

---

### Task 12: 文档同步 + 全部门禁

**Files:**
- Modify: `docs/architecture/protocol.md`（充实 Task 3 的三行占位：权限门、`DIAGNOSIS_RESULT` 载荷、`EXPLAIN_DIAGNOSIS` 不挂 UI 门的理由）
- Modify: `docs/architecture/rendering.md`（诊断面板一节：定位 `right:16px; bottom:64px; z-index:2147483647`、单例复用、requestId 防过期、剪贴板降级、隐私提示两句）
- Modify: `docs/architecture/model-pipeline.md`（诊断提示词：独立首行不进 `PROMPT_FIRST_LINES`、证据白名单不含 URL/HTML、`detail-click` 档 + `${documentId}:diagnosis` abort 隔离、不缓存不升版本）
- Modify: `docs/architecture/modules.md`（新文件 `content/block-diagnosis.ts`、`content/diagnosis-panel.ts` 各一行职责——**`architecture-docs.test.ts:113-121` 钉了新源文件必须出现在 modules.md**）
- Modify: `docs/architecture/invariants.md`（新增一条：诊断必须复用生产判定函数，不得复制判据——规则/为什么/症状/守护测试四段式，守护测试指 `page-inventory.test.ts` 的 explainElement 一致性用例）
- Modify: `docs/architecture/build-test-release.md`（假服务器新增 `diagnosis` kind 与应答分支的契约一句）
- Modify: `docs/architecture/overview.md`（两条新消息的运行时链路一句）
- Modify: `AGENTS.md`（「文档同步」表之外，若「协议三层校验」段落需要点名第四处同步点——入站拒绝列表——就在那句里补半句）

- [ ] **Step 1: 改文档**（按上表逐份；写法对照各文件既有小节的密度与风格）
- [ ] **Step 2: 文档钉子测试**

Run: `cd chrome-plugin && npx vitest run src/shared/architecture-docs.test.ts`
Expected: PASS（消息类型、modules.md 新文件、常量数值全部钉住）。红了改文档，**不要放宽断言**。

- [ ] **Step 3: drift 检查**

Run: `cd chrome-plugin && npm run docs:drift`（仓库门禁脚本无 `--strict` 参数，`--strict` 是脚本 CLI 的可选项——按 AGENTS.md 跑 `npm run docs:drift` 即可，想加严再手动 `node scripts/check-docs-drift.mjs --strict`）
Expected: 相关文档都动过，无未处理项。

- [ ] **Step 4: 全量门禁**（AGENTS.md 门禁清单）

```bash
cd chrome-plugin && npm test && npx playwright test && npm run lint && npm run format:check && npm run build
```

Expected: 全过；lint 恰好 1 个既有基线错误（`scripts/check-lint-baseline.mjs` 也可单独验证）。

- [ ] **Step 5: IntelliJ 侧不受影响的证明**

本批没动 `intellij-plugin/`、`shared-fixtures/`、桥协议——按 AGENTS.md 门禁条件**无需**跑 gradle。用 `git diff --stat main..HEAD -- intellij-plugin shared-fixtures` 输出为空作证，贴进提交说明。

- [ ] **Step 6: 提交**

```bash
git add docs/ AGENTS.md
git commit -m "docs: 段落诊断功能的架构文档同步"
```

- [ ] **Step 7: 汇报与合入**

向用户汇报：功能验收点（spec §4 逐条）、门禁结果、真机自验建议（真机上右键一段中文/短 div 试试报告内容）。合入 main 等用户确认后执行（`git merge --no-ff feat/block-diagnosis`）。

---

## 计划自查记录（writing-plans Self-Review）

1. **Spec 覆盖**：D1（Task 6 菜单+不记账、Task 7 落点、Task 10 捕获监听）/ D1.5（Task 3 两条消息、Task 10 编排与第四处同步点）/ D2（Task 1 出口、Task 2 快照、Task 7 采集）/ D3（Task 3/6/10 三层 + Task 5 调度与 abort 隔离 + 不缓存不升版本的「不做」由 Global Constraints 钉死）/ D4（Task 4 提示词+白名单+形状校验、Task 11 假服务器）/ D5（Task 9 面板）/ D6（Task 8 报告）/ §3 TDD 顺序（每 Task 红-绿-提交）/ §4 验收（Task 11 E2E + Task 12 门禁）。无遗漏。
2. **占位符扫描**：Task 6/7/10/11 含「以既有 harness/真实签名为准」的指引——这些不是占位符，是对既有代码形态的显式核对指令（避免计划凭记忆写死错误的 mock 名/签名）；所有新代码（类型、函数体、prompt、样式、测试断言）均已给出全文。
3. **类型一致性**：`BlockDiagnosis`/`DiagnosisExplanation`/`SessionDiagnosisSnapshot`/`DiagnosisGateResult` 定义一次（Task 3），Task 1 re-export、Task 4/5/6/7/8/9/10 引用同名；`explainDiagnosis(input: DiagnosisInput, signal)` 在 Task 5 定义、Task 6 消费；`recordDiagnosisTarget`/`resolveDiagnosisTarget` Task 7 定义、Task 10 消费；面板方法 `show/trackRequest/updateModel/report/close` Task 9 定义、Task 10 消费。

## 评审修订记录（2026-10-11，glm-5.3 计划评审后修订）

评审子代理对照实码逐项核验后返回 6 严重 / 9 重要 / 8 次要；全部经主线核实成立并修订：

- **S1** Task 1 一致性测试从「首个失败门决定 reason」改为**集合包含式**（`classifyExclusion:425-467` 的优先级链与 covered-by-child 方向①依赖整页两遍算法，单元素函数无法复刻优先级）；门清单与顺序改为镜像 classifyExclusion；新增条件门 `has-separable-direct-text`；`unsafe-descendant` 门补 `element.matches(UNSAFE_DESCENDANT_SELECTOR)`（拼写修正 DESCENDANT）。
- **S2** `explainElement` 内部一律 `element.ownerDocument`，严禁全局 `document`（fixture 页是独立 Window 文档）。
- **S3** `english-dominant` 小测试改为词级口径（`isEnglishDominant:162-166` 是词级 0.6，非字符级）；`englishLetterRatio` 从其提取共用。
- **S4** `EXTENSION_OWN_SELECTOR` 剔除 `[data-syntax-learning-extension]`（那是 `<html>` 上的 ready 标记 `content-script.ts:462`，含它会让所有落点退化成 `html.parentElement === null`）；上溯以 `documentElement` 为界。
- **S5** 诊断**复用会话 transport**（`controller.transport.send`），不再新建 `ChromeRuntimeTransport`——新 transport 会开第二个 `syntax-learning:<documentId>` 端口，SW `onConnect` 无条件覆写 `documentPorts`（`service-worker.ts:987`），会话流式推送被劫持。
- **S6** Task 6 显式修改既有用例 "creates both context menu commands exactly once on install"（`service-worker.test.ts:224-236` 用 `toEqual` 钉死两项）为三项。
- **I1** Task 5 同批给 `service-worker.test.ts:129-139` 的 `analysisService` 字面量补 `explainDiagnosis: vi.fn()`（接口加方法后该文件立即编译失败）。**I2** Task 10 补 `diagnosisPanel()` 惰性单例的完整定义。**I3** `RoutedController` 接口补 `transport` / `diagnosisSnapshot`，`SessionController` 加 `get transport()`；删掉 `controller.document` 分支。**I4** `redactDiagnosisExplanation(model, profile)` 按真实签名 `(value: string, profile: ModelProfile)`（`:134-139`）。**I5** Task 5 测试改 `harness([...])` 传参 + `vi.spyOn(scheduler, "schedule")`（harness 的 scheduler 是真 `DedupeScheduler` 非 mock）+ 断言 `cache.core.size === 0`（`MemoryCache.putCore` 非 mock）。**I6** Task 2 第二个测试的目标元素改为 `document.querySelector("p")` 具体获取。**I7** Task 7 重设计为 `resolveDiagnosisTarget()` 返回 `{element, source}`，落实 spec D1 的「选区锚点 → 右键落点 → body」优先级与 `extension-ascended` 标记。**I8** Task 11 E2E 全部改为 fixtures 真实 API（`test/expect` from `./fixtures`、`harness.serviceWorker.evaluate` + `chrome.tabs.sendMessage`、`fakeModel.recordedOfKind`）。**I9** Task 7/9 创建新源文件的同批各补一行 `modules.md`（`architecture-docs.test.ts:113-121` 钉住，否则 Task 7-11 期间全量测试带红）。
- 次要：诊断报告不做 `filter`（空行是小节分隔符）、可选段条件 push；Task 9 测试补 `vi/beforeEach/afterEach` import；`requestFeasibility` 补云端批上限 2（`CLOUD_SENTENCES_PER_REQUEST_FOR_CONTRACT`）；`docs:drift` 命令回归 `npm run docs:drift`。

