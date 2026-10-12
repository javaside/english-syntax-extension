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
gate 名固定为：`editable-content` / `block-candidate` / `excluded-region` / `hidden-ancestor` / `unsafe-descendant` / `layout-visible` / `readable-words` / `english-dominant` / `min-auto-text-length` / `scientific-exclusion` / `inside-principal-root` / `covered-by-child`。

- [ ] **Step 1: 写失败测试**（追加到 `page-inventory.test.ts` 末尾）

```ts
describe("explainElement 只读诊断出口", () => {
  // gate 首个失败项 → inventory exclusionReason 的期望映射。
  // 这就是防「诊断逻辑漂移」的核心断言：诊断说的原因必须与生产判定一致。
  const reasonByFirstFailingGate: Record<string, string> = {
    "editable-content": "hidden",            // 可编辑区在 HIDDEN_SELECTOR 内，语义同为不可安全替换
    "block-candidate": "unsafe-partial-replacement",
    "excluded-region": "excluded-region",
    "hidden-ancestor": "hidden",
    "layout-visible": "hidden",
    "readable-words": "no-readable-words",
    "english-dominant": "non-english",
    "min-auto-text-length": "loose-block-too-short",
    "scientific-exclusion": "reference-metadata", // fixture 里科学排除的代表值，逐条见下
    "inside-principal-root": "outside-principal-content",
    "covered-by-child": "covered-by-child",
  };

  it("对两份冻结 fixture 的每个 unit，门结论与 inventory 判定逐一致", () => {
    for (const fixtureName of fixtures) {
      const page = parsePage(readFixture(fixtureName, "html"));
      const contract = JSON.parse(readFixture(fixtureName, "json")) as InventoryContract;
      const units = new Map(
        inventoryReadableUnits(page).map((unit) => [unit.element.getAttribute("data-audit-id") ?? unit.id, unit]),
      );
      for (const { id, reason } of contract.units) {
        const unit = units.get(id);
        if (unit === undefined) continue; // fixture 契约里允许 null reason 的行
        const gates = explainElement(unit.element);
        const failed = gates.filter(({ ok }) => !ok);
        if (unit.automatic) {
          expect(failed, `${fixtureName}:${id} 自动单元不应有失败门`).toEqual([]);
        } else {
          expect(failed.length, `${fixtureName}:${id} 非自动单元应至少有一门失败`).toBeGreaterThan(0);
          const first = reasonByFirstFailingGate[failed[0]!.gate];
          // scientific-exclusion 的 5 个子 reason 单独对表
          if (failed[0]!.gate === "scientific-exclusion") {
            expect(
              ["conversion-placeholder","math-auxiliary","reference-metadata","display-math","unsupported-reference-layout"],
              `${fixtureName}:${id}`,
            ).toContain(reason);
          } else {
            expect(first, `${fixtureName}:${id} gate=${failed[0]!.gate}`).toBe(reason);
          }
        }
      }
    }
  });

  it("english-dominant 门带回当时取值（占比数值）", () => {
    document.body.innerHTML = '<main><p id="mixed">Hello world 你好世界测试</p></main>';
    const gates = explainElement(document.getElementById("mixed")!);
    const gate = gates.find(({ gate }) => gate === "english-dominant")!;
    expect(typeof gate.value).toBe("number");
    expect(gate.ok).toBe(false); // 2/6 < 0.6
  });

  it("min-auto-text-length 门带文本长度与阈值 20", () => {
    document.body.innerHTML = '<main><div id="tiny">Short text</div></main>';
    const gates = explainElement(document.getElementById("tiny")!);
    const gate = gates.find(({ gate }) => gate === "min-auto-text-length")!;
    expect(gate.ok).toBe(false);
    expect(gate.value).toBe(10);
  });
});
```

注意：`fixtures` / `readFixture` / `parsePage` / `InventoryContract` 已在该测试文件 59-94 行定义，直接复用；`explainElement` 从 `./page-inventory` import。

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
 * 与 inventoryReadableUnits 的判定必须一致——诊断报告要拿去改代码，不能复制一份
 * 会漂移的判据。不改任何生产路径行为，纯新增导出。
 */
export function explainElement(element: Element): CandidateGateResult[] {
  const text = normalizedReadableText(element);
  const ratio = englishLetterRatio(text);
  const words = letterWords(text).length;
  const scientific = scientificExclusion(element);
  const inBlockSelector = BLOCK_SELECTOR.split(",").some((selector) => element.matches(selector.trim()));
  const inCallout = CALLOUT_SELECTOR.split(",").some((selector) => element.matches(selector.trim()));
  const shortGateApplies = !inBlockSelector && !inCallout;
  const principalRoot = selectPrincipalRoot(document);
  return [
    {
      gate: "editable-content",
      ok: !element.closest(EDITABLE_CONTENT_SELECTOR),
      value: element.closest(EDITABLE_CONTENT_SELECTOR)?.selectorText ?? undefined,
    },
    { gate: "block-candidate", ok: isBlockCandidate(element, true) },
    {
      gate: "excluded-region",
      ok: excludedRegionAncestor(element) === null,
      value: excludedRegionAncestor(element)?.selectorText ?? undefined,
    },
    { gate: "hidden-ancestor", ok: element.closest(HIDDEN_SELECTOR) === null },
    {
      gate: "unsafe-descendant",
      ok: element.querySelector(UNSAFE_DESCANDANT_SELECTOR) === null,
    },
    { gate: "layout-visible", ok: isLayoutVisible(element) },
    { gate: "readable-words", ok: words > 0, value: words },
    { gate: "english-dominant", ok: ratio >= 0.6, value: Math.round(ratio * 100) / 100 },
    {
      gate: "min-auto-text-length",
      ok: !shortGateApplies || text.length >= MINIMUM_AUTO_TEXT_LENGTH,
      value: text.length,
    },
    { gate: "scientific-exclusion", ok: scientific === undefined, value: scientific },
    {
      gate: "inside-principal-root",
      ok: principalRoot === null || principalRoot.contains(element) || element === principalRoot,
    },
    { gate: "covered-by-child", ok: analyzableDescendants(element).length === 0 },
  ];
}
```

**实现注意（执行者必读）**：上面的代码是骨架——`element.closest(...)?.selectorText` 不是真实 API，`excludedRegionAncestor` / `scientificExclusion` 的真实返回形态、`isBlockCandidate` 的真实签名、以及英文占比是否已有私有函数（`isEnglishDominant` 在 `:165` 附近，内部算 ratio），**先读 `page-inventory.ts` 的 165-230 行再落码**，让每门直接复用真实判据；`value` 字段用真实可得的值（如 closest 命中的选择器字符串、`scientificExclusion` 返回的 reason）。判据本身一行都不许重写——`ratio` 如果已有私有函数就提出来共用（把 `isEnglishDominant` 内部计算提为 `englishLetterRatio(text): number` 私有函数并让两者共用，属允许的最小重构）。

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
    // 用既有 harness 起一个会话并让一句失败（该文件里已有「失败句渲染」类用例，照抄其
    // CORE_RESULT ERROR/缺失句的 fake 响应构造），然后：
    const snapshot = controller.diagnosisSnapshot(knownBlockElement);
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
  requestFeasibility: { maxSentenceLength: number; sentenceLengthLimit: number; maxSentencesPerRequest: number };
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
    requestFeasibility: { maxSentenceLength: 40, sentenceLengthLimit: 2000, maxSentencesPerRequest: 6 },
    session: { state: "stopped", registered: false, sentences: [] },
    page: { url: "https://example.com/a", readyState: "complete" },
    capturedAt: "2026-10-11T00:00:00.000Z",
  };

  it("接受合法 DIAGNOSE_BLOCK（带与不带 selectionText）", () => {
    expect(isRequestMessage({ ...pageBase, type: "DIAGNOSE_BLOCK" })).toBe(true);
    expect(isRequestMessage({ ...pageBase, type: "DIAGNOSE_BLOCK", selectionText: "hello world" })).toBe(true);
  });
  it("拒绝空白 selectionText 与未知字段", () => {
    expect(isRequestMessage({ ...pageBase, type: "DIAGNOSE_BLOCK", selectionText: "  " })).toBe(false);
    expect(isRequestMessage({ ...pageBase, type: "DIAGNOSE_BLOCK", extra: 1 })).toBe(false);
  });
  it("接受合法 EXPLAIN_DIAGNOSIS 并拒绝非法 diagnosis", () => {
    expect(isRequestMessage({ ...pageBase, type: "EXPLAIN_DIAGNOSIS", diagnosis: baseDiagnosis })).toBe(true);
    expect(isRequestMessage({ ...pageBase, type: "EXPLAIN_DIAGNOSIS" })).toBe(false);
    expect(isRequestMessage({ ...pageBase, type: "EXPLAIN_DIAGNOSIS", diagnosis: { ...baseDiagnosis, gates: "x" } })).toBe(false);
  });
});
```

（`pageBase` 用该文件既有的页面请求基线构造——先看文件内 `PARSE_SELECTION` 守卫用例怎么造 `version/requestId/tabId/documentId` 基线，照抄。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd chrome-plugin && npx vitest run src/shared/protocol.test.ts`
Expected: FAIL——新 type 未定义。

- [ ] **Step 3: 实现**（protocol.ts 三处）

1. 类型定义（放在 `CacheStats` 附近）+ RequestMessage/ResponseMessage 联合体追加成员（照 `PARSE_SELECTION`/`PROFILE_TEST_RESULT` 的写法）。
2. `isBlockDiagnosis(value: unknown): value is BlockDiagnosis` 守卫——**结构抽查**即可（消息来自我们自己的 content script，不是不可信输入；但缺字段必须拒）：

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
    const { service, adapter, scheduler } = harness();
    adapter.completeJson.mockResolvedValueOnce({
      likelyCause: "english ratio below threshold",
      explanation: "该块英文占比不足，被 non-english 门排除。",
      suggestions: ["确认目标段落是英文正文"],
    });

    const result = await service.explainDiagnosis(
      { profile, documentId: "doc-1", diagnosis: sampleDiagnosis() },
      new AbortController().signal,
    );

    expect(result.likelyCause).toBe("english ratio below threshold");
    expect(adapter.completeJson).toHaveBeenCalledTimes(1);
    const scheduled = scheduler.schedule.mock.calls[0]![0];
    expect(scheduled.priority).toBe("detail-click");
    expect(scheduled.documentId).toBe("doc-1:diagnosis"); // abort 连坐隔离
  });

  it("模型输出形状非法时抛错且不写缓存", async () => {
    const { service, adapter, cache } = harness();
    adapter.completeJson.mockResolvedValueOnce({ likelyCause: "" });
    await expect(
      service.explainDiagnosis({ profile, documentId: "doc-1", diagnosis: sampleDiagnosis() }, new AbortController().signal),
    ).rejects.toThrow();
    expect(cache.putCore).not.toHaveBeenCalled();
    expect(cache.putDetail).not.toHaveBeenCalled();
  });
});
```

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
  it("注册第三个右键菜单项（page+selection 上下文）", async () => {
    await triggerOnInstalled(); // 复用文件内既有 onInstalled 触发方式
    const created = chromeApi.contextMenus.create.mock.calls.map(([item]) => item);
    expect(created).toContainEqual(
      expect.objectContaining({ id: "syntax-diagnose-block", contexts: ["page", "selection"] }),
    );
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

（`sampleDiagnosis()` / `pageRequestBase` / `profile` / `triggerOnInstalled` / `triggerMenuClick` / `activeTabsGet`/`Set` 的名字以该测试文件既有 harness 为准——先读文件头，把它造 fake chromeApi/configRepository/analysisService 的方式照抄过来；若 harness 不存在 `triggerMenuClick`，直接调用被测的 `contextMenus.onClicked` mock listener。）

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
function redactDiagnosisExplanation(model: DiagnosisExplanation): DiagnosisExplanation {
  return {
    likelyCause: redactProfileSecrets(model.likelyCause),
    explanation: redactProfileSecrets(model.explanation),
    suggestions: model.suggestions.map((item) => redactProfileSecrets(item)),
  };
}
```

（若 `redactProfileSecrets` 签名不是 `(text: string) => string`，按其真实签名调整——它就在 `:134-139`，读一眼再写。`DiagnosisExplanation` 从 `../shared/protocol` import。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd chrome-plugin && npx vitest run src/background/service-worker.test.ts`
Expected: PASS 全部（56 个既有用例不红）。

- [ ] **Step 5: 提交**

```bash
git add src/background/service-worker.ts src/background/service-worker.test.ts
git commit -m "feat: SW 诊断路由与右键菜单（不记账，错误嵌 modelError）"
```

---

### Task 7: `block-diagnosis.ts` 证据采集

**Files:**
- Create: `chrome-plugin/src/content/block-diagnosis.ts`
- Test: `chrome-plugin/src/content/block-diagnosis.test.ts`

**Interfaces (Produces):**
```ts
export function recordDiagnosisTarget(event: Event): void;   // contextmenu 捕获监听用
export function currentDiagnosisTarget(): Element | null;
export interface DiagnoseElementInput {
  target: Element | null;
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
import { currentDiagnosisTarget, diagnoseElement, recordDiagnosisTarget } from "./block-diagnosis";

const baseInput = {
  document,
  url: "https://example.com/docs?page=3#section",
  sessionSnapshot: () => ({ state: "stopped" as const, registered: false, sentences: [] }),
  now: () => new Date("2026-10-11T00:00:00Z"),
};

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("落点记录", () => {
  it("recordDiagnosisTarget 记录元素且不受会话状态约束", () => {
    document.body.innerHTML = '<main><p id="p">Text</p></main>';
    const event = { target: document.getElementById("p") } as unknown as Event;
    recordDiagnosisTarget(event);
    expect(currentDiagnosisTarget()).toBe(document.getElementById("p"));
  });
  it("落点在扩展自身元素上时上溯并标记 source", () => {
    document.body.innerHTML = '<main><p id="p">Text</p><div data-syntax-learning-block></div></main>';
    const card = document.querySelector("[data-syntax-learning-block]")!;
    const event = { target: card } as unknown as Event;
    recordDiagnosisTarget(event);
    // 卡片 host 挂在 p 之后的浅 DOM；上溯跳过扩展元素后落到容器
    expect(currentDiagnosisTarget()?.matches("[data-syntax-learning-block]")).toBe(false);
  });
});

describe("diagnoseElement", () => {
  it("非英文段落的证据指向 english-dominant 门并带数值", () => {
    document.body.innerHTML = '<main><p id="mixed">Hello 你好世界测试数据</p></main>';
    const diagnosis = diagnoseElement({ ...baseInput, target: document.getElementById("mixed") });
    const gate = diagnosis.gates.find(({ gate }) => gate === "english-dominant")!;
    expect(gate.ok).toBe(false);
    expect(gate.value).toBeLessThan(0.6);
    expect(diagnosis.inventory.exclusionReason).toBe("non-english");
  });

  it("text 度量与短块阈值进证据", () => {
    document.body.innerHTML = '<main><div id="tiny">Short text</div></main>';
    const diagnosis = diagnoseElement({ ...baseInput, target: document.getElementById("tiny") });
    expect(diagnosis.text.minAutoTextLength).toBe(20);
    expect(diagnosis.text.length).toBe(10);
  });

  it("segmentation 用生产分句/分词", () => {
    document.body.innerHTML =
      '<main><p id="two">First sentence here. Second sentence there now.</p></main>';
    const diagnosis = diagnoseElement({ ...baseInput, target: document.getElementById("two") });
    expect(diagnosis.segmentation.sentenceCount).toBe(2);
    expect(diagnosis.segmentation.tokenCount).toBeGreaterThan(4);
    expect(diagnosis.segmentation.emptyText).toBe(false);
  });

  it("URL 去 query 与 fragment；outerHTML 截断并脱敏表单值", () => {
    document.body.innerHTML =
      '<main><p id="x" data-secret="keep">Value <input value="hunter2"></p></main>';
    const diagnosis = diagnoseElement({ ...baseInput, target: document.getElementById("x") });
    expect(diagnosis.page.url).toBe("https://example.com/docs");
    expect(diagnosis.target.outerHtml).not.toContain("hunter2");
    expect(diagnosis.target.outerHtml.length).toBeLessThanOrEqual(220); // 200 + 少量省略标记
  });

  it("requestFeasibility 标出超长句", () => {
    document.body.innerHTML = `<main><p id="long">${"word ".repeat(600)}</p></main>`;
    const diagnosis = diagnoseElement({ ...baseInput, target: document.getElementById("long") });
    expect(diagnosis.requestFeasibility.maxSentenceLength).toBeGreaterThan(2000);
    expect(diagnosis.requestFeasibility.sentenceLengthLimit).toBe(2000);
    expect(diagnosis.requestFeasibility.maxSentencesPerRequest).toBe(6);
  });

  it("会话快照透传", () => {
    document.body.innerHTML = '<main><p id="p">Some English words here.</p></main>';
    const snapshot = { state: "running" as const, registered: true, sentences: [{ text: "x", phase: "failed", failureMessage: "INVALID_MODEL_OUTPUT：bad" }] };
    const diagnosis = diagnoseElement({
      ...baseInput,
      target: document.getElementById("p"),
      sessionSnapshot: () => snapshot,
    });
    expect(diagnosis.session).toEqual(snapshot);
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
import { explainElement, inventoryReadableUnits, type ReadableUnit } from "./page-inventory";
import { nearestSafeBlock } from "./document-scanner";
import { normalizedReadableText } from "./readable-dom-text";
import { segmentBlock, tokenize } from "../language/segmenter";

const SENTENCE_LENGTH_LIMIT = 2_000;
const OUTER_HTML_LIMIT = 200;
const EXTENSION_OWN_SELECTOR =
  "[data-syntax-learning-extension],[data-syntax-learning-block],[data-syntax-learning-selection-anchor],[data-syntax-progress-pill],[data-syntax-diagnosis-panel]";

let lastTarget: Element | null = null;

export function recordDiagnosisTarget(event: Event): void {
  const target = event.target;
  if (target instanceof Element) lastTarget = target;
}

export function currentDiagnosisTarget(): Element | null {
  if (lastTarget === null) return null;
  // 落点在扩展自身元素上：沿祖先链跳出扩展容器再取（spec D1 次要11）。
  if (lastTarget.closest(EXTENSION_OWN_SELECTOR) !== null) {
    return lastTarget.closest(EXTENSION_OWN_SELECTOR)!.parentElement;
  }
  return lastTarget;
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
    targetSource: input.selectionText !== undefined ? "selection" : target === document.body ? "body" : "contextmenu",
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
    },
    session: input.sessionSnapshot?.(target) ?? { state: "stopped", registered: false, sentences: [] },
    page: { url, readyState: document.readyState },
    capturedAt: (input.now ?? (() => new Date()))().toISOString(),
  };
}
```

（`nearestSafeBlock` 的真实返回形态以 `document-scanner.ts:44-60` 为准——若它返回 `CandidateBlock` 形状，取 `.element`；`ReadableUnit.kind` 的真实字段名同上以 `page-inventory.ts:20-33` 为准。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd chrome-plugin && npx vitest run src/content/block-diagnosis.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/content/block-diagnosis.ts src/content/block-diagnosis.test.ts
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
    diagnoseElement({ ...baseInput, target: document.querySelector(target) });

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
    diagnosis.selectionText === undefined ? "" : `- 选中文本: ${diagnosis.selectionText.slice(0, 200)}`,
    "",
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
    `- 单请求句数上限: ${diagnosis.requestFeasibility.maxSentencesPerRequest}`,
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
  return lines.filter((line) => line !== "").join("\n").replace(/\n{3,}/gu, "\n\n") + "\n";
}
```

（注意 `selectionText` 那行用空串过滤会把空行吃掉——上面末尾的 `filter + replace` 已经兜住空行压缩；`DiagnosisExplanation` / `ExtensionError` import 自 `../shared/protocol` / `../shared/errors`。）

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
git add src/content/diagnosis-panel.ts src/content/diagnosis-panel.test.ts
git commit -m "feat: DiagnosisPanel 面板（requestId 防过期响应，剪贴板降级）"
```

---

### Task 10: 协议第三层——content 接线

**Files:**
- Modify: `chrome-plugin/src/content/content-script.ts`（`isRuntimeResponse` case、入站拒绝列表、router case、`installContentScript` 装配落点监听与面板）
- Test: 复用 `chrome-plugin/src/content/session-controller.test.ts`？否——**新建 `chrome-plugin/src/content/content-script-diagnosis.test.ts`**（isRuntimeResponse 是 content-script 的导出，可直接单测；router 行为用 ContentScriptRouter + fake transportFactory 测）

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
    const router = new ContentScriptRouter({
      transportFactory: () => fakeTransport(sent), // fakeTransport: 记录 send() 并回预设 DIAGNOSIS_RESULT
    });
    document.body.innerHTML = '<p id="p">Hello target text here.</p>';
    // 先用 contextmenu 记录落点（capture 监听由 installContentScript 装配；单测里手动调 recordDiagnosisTarget）
    recordDiagnosisTarget({ target: document.getElementById("p") } as unknown as Event);

    const response = await router.route({ ...pageCommandBase, type: "DIAGNOSE_BLOCK" });
    expect(response.type).toBe("ACK");
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

（`isBlockDiagnosis` 从 `../shared/protocol` **导出**（Task 3 里改为 export），`isDiagnosisExplanation` 小守卫同文件内新增：三字段 typeof 检查。）

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

4. `ContentScriptRouter` 内新增私有编排方法与 transport 复用（transport 按 documentId 复用，避免每次诊断新开一个 watchdog 端口）：

```ts
  private readonly diagnosisTransports = new Map<string, RuntimeTransport>();
  private diagnosisRequestCounter = 0;

  private async runDiagnosis(request: DiagnoseBlockRequest): Promise<void> {
    const panel = this.diagnosisPanel(); // 惰性单例：new DiagnosisPanel(this.document ?? document)
    const controller = this.controller(request.tabId, request.documentId);
    const target = currentDiagnosisTarget() ?? (typeof document !== "undefined" ? document.body : null);
    const diagnosis = diagnoseElement({
      target,
      ...(request.selectionText === undefined ? {} : { selectionText: request.selectionText }),
      document: typeof document !== "undefined" ? document : controller.document,
      sessionSnapshot: (element) => controller.diagnosisSnapshot(element),
      url: typeof location !== "undefined" ? location.href : "",
    });
    panel.show(diagnosis);
    const requestId = `${request.documentId}:diagnosis:${++this.diagnosisRequestCounter}`;
    const message: RequestMessage = {
      version: MESSAGE_VERSION,
      requestId,
      type: "EXPLAIN_DIAGNOSIS",
      tabId: request.tabId,
      documentId: request.documentId,
      diagnosis,
    };
    panel.trackRequest(requestId);
    let transport = this.diagnosisTransports.get(request.documentId);
    if (transport === undefined) {
      transport = (this.options.transportFactory ?? ((tabId, documentId) => new ChromeRuntimeTransport(tabId, documentId)))(
        request.tabId,
        request.documentId,
      );
      this.diagnosisTransports.set(request.documentId, transport);
    }
    const response = await transport.send(message);
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

（`DiagnoseBlockRequest` 类型 = `Extract<RequestMessage, { type: "DIAGNOSE_BLOCK" }>`。`controller.document`——`SessionControllerOptions.document` 已有该注入（`:125` 附近），但 `RoutedController` 接口暴露哪些方法以现状为准：若 router 拿不到 document，就只在真实浏览器上下文跑（`typeof document !== "undefined"` 恒真，content script 场景成立）；测试注入 `document` 全局即可。）

5. `installContentScript()`（`:430-465`）装配两件事（`installHoverTracker(document)` 之后）：

```ts
  // 诊断落点：contextmenu 捕获监听，与 SessionController 的 contextTarget 无关——
  // 那个只在会话运行时记录，而「识别不出段落」的用户多半没启动会话（spec D1）。
  document.addEventListener("contextmenu", recordDiagnosisTarget, true);
```

（面板实例由 router 内部惰性创建，install 处不需要额外装配。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd chrome-plugin && npx vitest run src/content/content-script-diagnosis.test.ts src/content/session-controller.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/content/content-script.ts src/content/content-script-diagnosis.test.ts src/shared/protocol.ts
git commit -m "feat: content 接线诊断命令与面板（第三层守卫 + 落点捕获监听）"
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
import { expect, test } from "@playwright/test";
import { testServer } from "./fixtures"; // 以 fixtures.ts 实际导出为准

test.describe("段落诊断", () => {
  test("右键诊断命令 → 面板出现 → 发了模型请求 → 报告可复制", async ({ page }) => {
    const server = await testServer(); // 假服务器；profile 已按既有 E2E 配好
    await page.goto(fixtureUrl("spring-ai-coverage")); // 以既有 fixture 页加载方式为准

    // Playwright 点不开 Chrome 原生右键菜单：按既有 harness 用 SW 侧下发页面命令
    await serviceWorkerEvaluate((api) => api.sendDiagnoseCommand()); // helper 形态以 fixtures 为准；
    // 没有现成 helper 就直接 chrome.tabs.sendMessage 一条 DIAGNOSE_BLOCK（照 fixtures.ts:136-180 的写法）

    await expect(page.locator("[data-syntax-diagnosis-panel]")).toBeAttached();
    // 探针断言（不用墙钟）：假服务器确实收到 diagnosis 请求
    await expect
      .poll(() => server.requestsOfKind("diagnosis").length)
      .toBeGreaterThanOrEqual(1);
    const panel = page.locator("[data-syntax-diagnosis-panel]");
    await expect(panel).toContainText("english-dominant");
    // 点击复制 → 剪贴板内容含报告骨架（E2E 里用 context.grantPermissions(["clipboard-read"])）
    await panel.locator(".copy").click();
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toContain("## 概述");
    expect(clip).toContain("## 模型解释");
  });

  test("无 profile → 面板只出本地段，modelError=CONFIG_MISSING，且不发请求", async ({ page }) => {
    const server = await testServer({ withoutProfile: true }); // 以 fixtures 支持的构造方式为准
    await page.goto(fixtureUrl("spring-ai-coverage"));
    await serviceWorkerEvaluate((api) => api.sendDiagnoseCommand());
    const panel = page.locator("[data-syntax-diagnosis-panel]");
    await expect(panel).toContainText("CONFIG_MISSING");
    expect(server.requests().length).toBe(0);
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toContain("## 本地判定证据");
  });
});
```

（fixture/helper 名以 `tests/e2e/fixtures.ts` 实际导出为准——**先读它**，把 `serviceWorkerEvaluate` / fixture 页加载 / 假服务器启动的既有方式照抄；上面是行为契约不是逐字代码。）

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

Run: `cd chrome-plugin && node scripts/check-docs-drift.mjs --strict`
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
3. **类型一致性**：`BlockDiagnosis`/`DiagnosisExplanation`/`SessionDiagnosisSnapshot`/`DiagnosisGateResult` 定义一次（Task 3），Task 1 re-export、Task 4/5/6/7/8/9/10 引用同名；`explainDiagnosis(input: DiagnosisInput, signal)` 在 Task 5 定义、Task 6 消费；`recordDiagnosisTarget`/`currentDiagnosisTarget` Task 7 定义、Task 10 消费；面板方法 `show/trackRequest/updateModel/report/close` Task 9 定义、Task 10 消费。

