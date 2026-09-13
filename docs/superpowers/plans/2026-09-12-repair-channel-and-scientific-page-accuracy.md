# 修复通道坐标与科学页面准确性实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让双端 repair 通道的错误坐标与模型所见 JSON 严格一致（P0），并修掉科学页面上公式取 LaTeX 源码、邮箱元数据被当正文、句末引用号与短标题编号错标四类准确性问题（P1）。

**Architecture:** P0 在 validator 内部引入私有包装类型，把「语义成分序列」与「诊断坐标（rawIndex）」分离，并把错误按 sentenceId 分组序列化进 repair prompt；接受集合与成功结果必须逐字不变，仅错误路径改变。P1 改 `readable-dom-text` 的 MathML 取文本策略、`page-inventory` 的邮箱排除、prompt 与黄金集的引用/编号口径，并新增静默错标审计集把「通过校验但标错」变成可度量指标。

**Tech Stack:** TypeScript + Vite + Vitest、Playwright、Chrome MV3、Kotlin + Gradle IntelliJ Platform、共享 JSON fixture（TS/Kotlin 双端消费）、Node.js ESM 验收脚本。

**Spec:** `docs/superpowers/specs/2026-09-12-repair-channel-and-scientific-page-accuracy-design.md`

## Global Constraints

- `CORE_SCHEMA_VERSION = 3`、`CORE_PROMPT_VERSION = 13`、`DETAIL_PROMPT_VERSION = 7`（起点值，见 Task 12/13）。
- 缓存键 = 规范化句文本 + `CORE_SCHEMA_VERSION` + `CORE_PROMPT_VERSION` + focus 区间；改任一侧必须两侧同步并用对方路径读回验证。
- `PROMPT_FIRST_LINES.coreRepair` 首行**逐字保持不变**：`Repair only the structure of the invalid core-analysis JSON so it satisfies every validation error.`（假服务器按首行识别请求类型）。
- 错误英文文案 TS/Kotlin **逐字一致**，并进 repair prompt；`MAX_SENTENCES_PER_REQUEST = 6`；repair 至多两轮且逐轮收窄。
- 不新增语法角色、不新增协议字段、不扩 `SessionStatus`、不新增 Chrome 消息或 JCEF bridge 字段。
- 不放宽译文质量门（`HAN_PATTERN` 与回显判据不动）；不改 `MAX_WHOLE_SENTENCE_FRAGMENT_LEXICAL_TOKENS = 10`；不排除标题/图注/文献题名；不增加第 3 轮 repair。
- 段内句子 prompt 一律走 `serializeSentences` / `serializeSentence`，其余内嵌 JSON 走 `serialize`。
- Chrome 门禁 lint **恰好 1 个既有错误**（`src/options/options.test.ts` 的 `no-unnecessary-type-assertion`），**不修复也不新增**，且不得用 lint 退出码判全绿。
- 提交信息用中文主题。每个任务 RED → 确认失败 → 最小 GREEN → 测试 → 提交。
- 真实 artifact、key、header、acceptance 脚本留在 gitignored `.superpowers/acceptance/`，永不提交。

---

## 文件结构

**P0（新增/修改）**

- `chrome-plugin/src/language/indexed-components.ts`（新建）：坐标承载类型与投影函数，只服务 validator 内部。
- `chrome-plugin/src/language/analysis-validator.ts`（修改）：parse / 结构检查 / grammar 三段改用坐标；coverage 保持句级路径。
- `chrome-plugin/src/background/repair-errors.ts`（新建）：把 `InvalidCoreSentence[]` 转成按句分组的序列化结构（四类路径语义）。
- `chrome-plugin/src/background/analysis-service.ts`（修改）：`InvalidCoreSentence` 带上坐标信息；repair 调用改用分组序列化。
- `chrome-plugin/src/background/prompts.ts`（修改）：`buildRepairPrompt` 接收分组结构；规则段补两句。
- `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/language/IndexedComponents.kt`（新建）：同构包装。
- `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/language/AnalysisValidator.kt`（修改）。
- `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/analysis/RepairErrors.kt`（新建）。
- `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/analysis/AnalysisService.kt`（修改）。
- `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/model/Prompts.kt`（修改）。
- `.superpowers/acceptance/probe-arxiv-live.mjs`（修改，gitignored）。

**P1（新增/修改）**

- `chrome-plugin/src/content/readable-dom-text.ts`（修改）：MathML 取文本策略。
- `chrome-plugin/src/content/page-inventory.ts`（修改）：邮箱元数据排除。
- `chrome-plugin/src/background/prompts.ts`（修改）：引用附着 + 编号绑定口径。
- `shared-fixtures/audit-silent-mislabel.json`（新建）：静默错标审计集。
- `chrome-plugin/scripts/silent-mislabel-audit.mjs`（新建）+ 测试：审计器。
- `shared-fixtures/core-gold-annotations.json`、`shared-fixtures/visible-page-core-evaluation-corpus.json`（修改）。
- `shared-fixtures/validator-messages.json`（修改）：补 auxiliary/modal 文案。
- 文档：`docs/architecture/{model-pipeline,modules,invariants,rendering,build-test-release}.md`、`AGENTS.md`、`CHANGELOG.md`。

**保持接口不变**

```ts
export function scanDocument(root: ParentNode): CandidateBlock[];
export function nearestSafeBlock(target: EventTarget | null): CandidateBlock | null;
export function validateCoreBatch(raw: unknown, requests: readonly SentenceInput[], modelProfileId: string): ValidationResult<CoreAnalysis[]>;
```

---

## P0 批次：修复通道坐标系

### Task 1: 坐标承载类型与 validator 的 parse 段

**Files:**
- Create: `chrome-plugin/src/language/indexed-components.ts`
- Modify: `chrome-plugin/src/language/analysis-validator.ts:700-745`
- Test: `chrome-plugin/src/language/indexed-components.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces:
  - `interface RawComponentEntry { readonly rawIndex: number; readonly value: unknown }`
  - `interface ParsedComponentEntry { readonly rawIndex: number; readonly component: CoreComponent | undefined }`
  - `interface IndexedCoreComponent { readonly rawIndex: number; readonly component: CoreComponent }`
  - `function rawComponentEntries(components: readonly unknown[], tokens: readonly Token[]): RawComponentEntry[]` —— 记录原始下标，再按现有纯标点判据排除
  - `function toIndexed(entries: readonly ParsedComponentEntry[]): IndexedCoreComponent[]`

- [ ] **Step 1: 写失败测试**

```ts
// chrome-plugin/src/language/indexed-components.test.ts
import { describe, expect, it } from "vitest";
import { rawComponentEntries } from "./indexed-components";
import { tokenize } from "./segmenter";

const tokens = tokenize("The service works well.");

describe("rawComponentEntries", () => {
  it("记录原始下标后再排除纯标点成分", () => {
    const entries = rawComponentEntries(
      [
        { startToken: 0, endToken: 1, role: "SUBJECT", translation: "服务" },
        { startToken: 2, endToken: 2, role: "PUNCTUATION", translation: "。" }, // 纯标点
        { startToken: 3, endToken: 3, role: "ADVERBIAL", translation: "良好" },
      ],
      tokens,
    );
    expect(entries.map((entry) => entry.rawIndex)).toEqual([0, 2]);
  });

  it("非法元素保留原始下标、不当作可跳过", () => {
    const entries = rawComponentEntries(["not-an-object"], tokens);
    expect(entries.map((entry) => entry.rawIndex)).toEqual([0]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd chrome-plugin && npx vitest run src/language/indexed-components.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 最小实现**

```ts
// chrome-plugin/src/language/indexed-components.ts
// Token 与 CoreComponent 都在 shared/grammar.ts(不是 protocol.ts)。
import type { CoreComponent, Token } from "../shared/grammar";

export interface RawComponentEntry {
  readonly rawIndex: number;
  readonly value: unknown;
}

export interface ParsedComponentEntry {
  readonly rawIndex: number;
  readonly component: CoreComponent | undefined;
}

export interface IndexedCoreComponent {
  readonly rawIndex: number;
  readonly component: CoreComponent;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 纯标点区间:区间落在句内、token 连续、且每个 token 都是标点。非法元素不在此列。 */
function isPunctuationOnly(value: unknown, tokens: readonly Token[]): boolean {
  if (!isRecord(value)) return false;
  const { startToken, endToken } = value;
  if (!Number.isSafeInteger(startToken) || !Number.isSafeInteger(endToken)) return false;
  const covered = tokens.filter(
    (token) => token.id >= (startToken as number) && token.id <= (endToken as number),
  );
  return (
    covered.length > 0 &&
    covered[0]!.id === startToken &&
    covered.at(-1)!.id === endToken &&
    covered.every((token) => token.punctuation)
  );
}

/**
 * 先记录原始下标,再按现有纯标点判据排除——顺序不能反,否则 error path 与模型所见
 * JSON 的 components 数组下标失配(实测 15 例:错误指向隔壁成分)。
 */
export function rawComponentEntries(
  components: readonly unknown[],
  tokens: readonly Token[],
): RawComponentEntry[] {
  return components
    .map((value, rawIndex) => ({ rawIndex, value }))
    .filter((entry) => !isPunctuationOnly(entry.value, tokens));
}

export function toIndexed(entries: readonly ParsedComponentEntry[]): IndexedCoreComponent[] {
  return entries.flatMap((entry) =>
    entry.component === undefined ? [] : [{ rawIndex: entry.rawIndex, component: entry.component }],
  );
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd chrome-plugin && npx vitest run src/language/indexed-components.test.ts`
Expected: PASS（2 例）。

- [ ] **Step 5: 提交**

```bash
git add chrome-plugin/src/language/indexed-components.ts chrome-plugin/src/language/indexed-components.test.ts
git commit -m "坐标承载类型分离语义序列与诊断下标"
```

---

### Task 2: validator 三个阶段的错误路径改用 rawIndex

**Files:**
- Modify: `chrome-plugin/src/language/analysis-validator.ts:700-790`（`parseCoreSentence`）
- Modify: `chrome-plugin/src/language/analysis-validator.ts:323-332`（`collectGrammarErrors` 签名与路径）
- Test: `chrome-plugin/src/language/analysis-validator.test.ts`（新增用例）

**Interfaces:**
- Consumes: Task 1 的 `rawComponentEntries`、`toIndexed`、`IndexedCoreComponent`。
- Produces: 无新导出；`collectGrammarErrors(components: readonly IndexedCoreComponent[], tokens, path, errors)` 签名变更（同文件私有）。

- [ ] **Step 1: 写失败测试**

在 `analysis-validator.test.ts` 的 `describe("validateCoreBatch")` 内新增（`tokenize` 从 `./segmenter` 导入；`SentenceInput` 来自 `../shared/protocol`——该文件已有这些导入，按现有风格补齐即可）：

```ts
const sentence: SentenceInput = {
  sentenceId: "raw-index-1",
  text: "The service works well.",
  tokens: tokenize("The service works well."),
};

function coreRaw(components: unknown[]): unknown {
  return { sentences: [{ sentenceId: sentence.sentenceId, components }] };
}

it("错误路径索引是原始数组下标,不受纯标点成分影响", () => {
  // 第 0 个是纯标点成分(会被丢弃)、真正非法的译文在原始第 2 个。
  const result = validateCoreBatch(
    coreRaw([
      { startToken: 4, endToken: 4, role: "PUNCTUATION", translation: "。" },
      { startToken: 0, endToken: 1, role: "SUBJECT", translation: "The service" },
      { startToken: 2, endToken: 3, role: "PREDICATE", translation: "works" },
    ]),
    [sentence],
    "profile-1",
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.errors).toContainEqual({
    path: "sentences[0].components[1].translation",
    message:
      "translation must include a meaningful Chinese gloss for the complete covered English span instead of echoing or only copying it",
  });
});

it("接受集合与成功成分不受坐标改动影响", () => {
  const valid = validateCoreBatch(
    coreRaw([
      { startToken: 4, endToken: 4, role: "PUNCTUATION", translation: "。" },
      { startToken: 0, endToken: 1, role: "SUBJECT", translation: "服务" },
      { startToken: 2, endToken: 3, role: "PREDICATE", translation: "运转良好" },
    ]),
    [sentence],
    "profile-1",
  );
  expect(valid.ok).toBe(true);
  if (!valid.ok) return;
  expect(valid.value[0]!.components).toEqual([
    { startToken: 0, endToken: 1, role: "SUBJECT", translation: "服务" },
    { startToken: 2, endToken: 3, role: "PREDICATE", translation: "运转良好" },
  ]);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd chrome-plugin && npx vitest run src/language/analysis-validator.test.ts -t "原始数组下标"`
Expected: FAIL — 实际路径是 `components[1]` 但指向被排除后的第 1 个（`PREDICATE`），message 落在 `components[2]` 或指向错误成分。

- [ ] **Step 3: 最小实现**

改 `parseCoreSentence`：

```ts
  const entries = rawComponentEntries(value.components, request.tokens);
  if (entries.length === 0) {
    addError(errors, `${path}.components`, "must contain a non-punctuation component");
    return undefined;
  }
  const parsed: ParsedComponentEntry[] = entries.map((entry) => ({
    rawIndex: entry.rawIndex,
    component: parseCoreComponent(
      entry.value,
      request.tokens,
      `${path}.components[${entry.rawIndex}]`,
      errors,
    ),
  }));
  let structureTrusted = parsed.every((entry) => entry.component !== undefined);
  let previousEnd = -1;
  for (const entry of parsed) {
    if (entry.component === undefined) {
      structureTrusted = false;
      continue;
    }
    const componentPath = `${path}.components[${entry.rawIndex}]`;
    // …原有 range / 顺序检查,把 component 换为 entry.component…
  }
  const validComponents = toIndexed(parsed);
  if (structureTrusted) {
    collectGrammarErrors(validComponents, request.tokens, path, errors);
  }
  // coverage 循环改用 validComponents（语义不变,路径仍是句级）
```

改 `collectGrammarErrors`：

```ts
function collectGrammarErrors(
  components: readonly IndexedCoreComponent[],
  tokens: readonly Token[],
  path: string,
  errors: ValidationError[],
): void {
  const hasConjunction = components.some(({ component }) => component.role === GrammarRole.CONJUNCTION);

  components.forEach((entry, index) => {
    const { component } = entry;
    const componentPath = `${path}.components[${entry.rawIndex}]`;
    const previous = components[index - 1]?.component; // 语义邻接,不是原数组邻接
    // …其余判断体把 component 与 previous 的用法原样保留…
```

同时把 `validComponents.length !== components.length` 的返回判断改为 `validComponents.length !== entries.length`。

- [ ] **Step 4: 运行确认通过**

Run: `cd chrome-plugin && npx vitest run src/language/analysis-validator.test.ts`
Expected: PASS（含全部既有用例——这是「接受集合不变」的守护）。

- [ ] **Step 5: 提交**

```bash
git add chrome-plugin/src/language/analysis-validator.ts chrome-plugin/src/language/analysis-validator.test.ts
git commit -m "validator 错误路径改用原始成分下标"
```

---

### Task 3: grammar 邻接门不被坐标改动绕过

**Files:**
- Test: `chrome-plugin/src/language/analysis-validator.test.ts`（新增用例）

**Interfaces:**
- Consumes: Task 2 的 `collectGrammarErrors` 语义邻接。
- Produces: 无。

- [ ] **Step 1: 写失败测试**

```ts
it("GRAMMAR 邻接仍是语义邻接:隔一个纯标点成分后,定语从句后接宾语仍被拒", () => {
  const s: SentenceInput = {
    sentenceId: "adjacency-1",
    text: "The API that returns JSON responses, an object.",
    tokens: tokenize("The API that returns JSON responses, an object."),
  };
  const result = validateCoreBatch(
    {
      sentences: [
        {
          sentenceId: s.sentenceId,
          components: [
            { startToken: 0, endToken: 1, role: "SUBJECT", translation: "该 API" },
            { startToken: 2, endToken: 5, role: "ATTRIBUTIVE_CLAUSE", translation: "返回 JSON 响应的" },
            { startToken: 6, endToken: 6, role: "PUNCTUATION", translation: "，" },
            { startToken: 7, endToken: 8, role: "OBJECT", translation: "一个对象" },
          ],
        },
      ],
    },
    [s],
    "profile-1",
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.errors.some((e) => e.message.includes("ATTRIBUTIVE_CLAUSE"))).toBe(true);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd chrome-plugin && npx vitest run src/language/analysis-validator.test.ts -t "语义邻接"`
Expected: FAIL — 若按原数组取 `index-1`，中间夹着被排除的纯标点成分，`previous` 变成 `undefined`，该门静默通过。

- [ ] **Step 3: 最小实现**

确认 Task 2 的 `components[index - 1]?.component` 已按包装序列取值（无需额外改动）；若实现时误用了原数组下标，改回包装序列取值。

- [ ] **Step 4: 运行确认通过**

Run: `cd chrome-plugin && npx vitest run src/language/analysis-validator.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add chrome-plugin/src/language/analysis-validator.test.ts
git commit -m "钉住 grammar 邻接不受坐标改动绕过"
```

---

### Task 4: repair 错误按句分组序列化

**Files:**
- Create: `chrome-plugin/src/background/repair-errors.ts`
- Modify: `chrome-plugin/src/background/analysis-service.ts:204-207,446-461,1000-1020`
- Modify: `chrome-plugin/src/background/prompts.ts:243-263`
- Test: `chrome-plugin/src/background/repair-errors.test.ts`、`chrome-plugin/src/background/prompts.test.ts`

**Interfaces:**
- Consumes: Task 2 的验证器错误路径。
- Produces:
  - `interface RepairErrorGroup { sentenceId: string; rawOccurrence?: number; kind: "invalid" | "missing" | "duplicate"; errors: readonly ValidationError[] }`
  - `function groupRepairErrors(invalid: readonly InvalidCoreSentence[], raw: unknown, requested: readonly SentenceInput[]): RepairErrorGroup[]`
  - `buildRepairPrompt(sentences: readonly SentenceInput[], groups: readonly RepairErrorGroup[], invalidJson: unknown): string`

- [ ] **Step 1: 写失败测试**

```ts
// chrome-plugin/src/background/repair-errors.test.ts
import { describe, expect, it } from "vitest";
import { groupRepairErrors } from "./repair-errors";

const sentence = (id: string): SentenceInput => ({
  sentenceId: id,
  text: "The service works well.",
  tokens: tokenize("The service works well."),
});

it("多句 repair 的错误各自归属到 sentenceId,不再共享 sentences[0]", () => {
  const groups = groupRepairErrors(
    [
      { sentence: sentence("a"), errors: [{ path: "sentences[0].components[1].translation", message: "m-a" }] },
      { sentence: sentence("b"), errors: [{ path: "sentences[0].components[3].translation", message: "m-b" }] },
    ],
    { sentences: [{ sentenceId: "a" }, { sentenceId: "b" }] },
    [sentence("a"), sentence("b")],
  );
  expect(groups).toEqual([
    { sentenceId: "a", rawOccurrence: 0, kind: "invalid", errors: [{ path: "components[1].translation", message: "m-a" }] },
    { sentenceId: "b", rawOccurrence: 0, kind: "invalid", errors: [{ path: "components[3].translation", message: "m-b" }] },
  ]);
});

it("缺失句与重复句各有明确 kind", () => {
  const missing = groupRepairErrors(
    [{ sentence: sentence("a"), errors: [] }],
    { sentences: [] },
    [sentence("a")],
  );
  expect(missing[0]).toMatchObject({ sentenceId: "a", kind: "missing" });

  const duplicate = groupRepairErrors(
    [{ sentence: sentence("a"), errors: [{ path: "sentences[1].sentenceId", message: "is duplicated" }] }],
    { sentences: [{ sentenceId: "a" }, { sentenceId: "a" }] },
    [sentence("a")],
  );
  expect(duplicate[0]).toMatchObject({ sentenceId: "a", kind: "duplicate", rawOccurrence: 1 });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd chrome-plugin && npx vitest run src/background/repair-errors.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 最小实现**

```ts
// chrome-plugin/src/background/repair-errors.ts
import type { SentenceInput } from "../shared/protocol";
import type { ValidationError } from "../language/analysis-validator";

export interface InvalidCoreSentence {
  sentence: SentenceInput;
  errors: readonly ValidationError[];
}

export interface RepairErrorGroup {
  sentenceId: string;
  rawOccurrence?: number;
  kind: "invalid" | "missing" | "duplicate";
  errors: readonly ValidationError[];
}

function rawIds(raw: unknown): string[] {
  if (typeof raw !== "object" || raw === null) return [];
  const sentences = (raw as { sentences?: unknown }).sentences;
  if (!Array.isArray(sentences)) return [];
  return sentences.map((entry) =>
    typeof entry === "object" && entry !== null && typeof (entry as { sentenceId?: unknown }).sentenceId === "string"
      ? ((entry as { sentenceId: string }).sentenceId)
      : "",
  );
}

const SENTENCE_PREFIX = /^sentences\[\d+\]\.?/;

/**
 * 验证器对每句单独调用,错误路径恒以 sentences[0] 起;多句拼装进同一 prompt 时
 * 必须重新按句分组,否则模型无从判断该改哪一句(实测 108 次 repair 中 47 次如此)。
 */
export function groupRepairErrors(
  invalid: readonly InvalidCoreSentence[],
  raw: unknown,
  requested: readonly SentenceInput[],
): RepairErrorGroup[] {
  const ids = rawIds(raw);
  return invalid.map(({ sentence, errors }) => {
    const occurrences = ids.filter((id) => id === sentence.sentenceId).length;
    const stripped = errors.map(({ path, message }) => ({
      path: path.replace(SENTENCE_PREFIX, ""),
      message,
    }));
    if (occurrences === 0) {
      return {
        sentenceId: sentence.sentenceId,
        kind: "missing" as const,
        errors: [{ path: "", message: "no output for this sentenceId; emit it" }],
      };
    }
    if (occurrences > 1) {
      return {
        sentenceId: sentence.sentenceId,
        rawOccurrence: occurrences - 1,
        kind: "duplicate" as const,
        errors: [{ path: "", message: "remove this duplicate instance" }],
      };
    }
    return { sentenceId: sentence.sentenceId, rawOccurrence: 0, kind: "invalid" as const, errors: stripped };
  });
}
```

`analysis-service.ts`：`InvalidCoreSentence` 改为从 `repair-errors.ts` 导入；`:706-710` 改为

```ts
content: buildRepairPrompt(
  remaining.map(({ sentence }) => sentence),
  groupRepairErrors(remaining, invalidRaw, chunk.map(({ sentence }) => sentence)),
  invalidRawSubset(invalidRaw, failedIds),
),
```

`prompts.ts`：`buildRepairPrompt` 第二参数改为 `groups`，第 258 行改为 `serialize(groups)`；规则段在 `"For each PREDICATE error…"` 之后插入两行：

```ts
"Each group carries one sentenceId; apply its errors to that sentence only, and never to another sentence in the same payload.",
"Ranges, roles and translations may be corrected, but sentence IDs and Tokens must not change.",
```

- [ ] **Step 4: 运行确认通过**

Run: `cd chrome-plugin && npx vitest run src/background/repair-errors.test.ts src/background/prompts.test.ts src/background/analysis-service.test.ts`
Expected: PASS（`prompts.test.ts` 若断言旧的扁平 errors 形状，同步改为分组形状）。

- [ ] **Step 5: 提交**

```bash
git add chrome-plugin/src/background/repair-errors.ts chrome-plugin/src/background/repair-errors.test.ts chrome-plugin/src/background/analysis-service.ts chrome-plugin/src/background/prompts.ts chrome-plugin/src/background/prompts.test.ts
git commit -m "repair 错误按句分组并携带实例坐标"
```

---

### Task 5: 多失败句 + 纯标点成分 + 逐轮收窄契约

**Files:**
- Test: `chrome-plugin/src/background/analysis-service.test.ts`（新增用例）

**Interfaces:**
- Consumes: Task 4 的分组序列化与 `buildRepairPrompt`。
- Produces: 无。

- [ ] **Step 1: 写失败测试**

```ts
it("多失败句 repair:每组只带本句错误,已修好的兄弟句不回流", async () => {
  const first = { sentences: [/* 两句都非法,其中一句含纯标点成分 */] };
  const second = { sentences: [/* 只修好第二句 */] };
  const third = { sentences: [/* 两句都合法 */] };
  const { adapter, service } = harness([first, second, third]);

  const outcome = await service.analyzeCore(coreInput([sentenceOne, sentenceTwo]), new AbortController().signal);

  // completeJson(profile, messages, schema, signal)——messages 是第 2 个参数(索引 1)。
  const repairPrompts = adapter.completeJson.mock.calls
    .map((call) => (call[1] as { content: string }[]).at(-1)!.content)
    .filter((content) => content.includes("Repair only the structure"));
  expect(repairPrompts).toHaveLength(2);
  expect(repairPrompts[0]).toContain(`"sentenceId":"${sentenceOne.sentenceId}"`);
  expect(repairPrompts[1]).not.toContain(`"sentenceId":"${sentenceTwo.sentenceId}"`);
  expect(outcome.result).toHaveLength(2);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd chrome-plugin && npx vitest run src/background/analysis-service.test.ts -t "兄弟句不回流"`
Expected: FAIL — 分组结构尚未生效时 prompt 里没有 `"sentenceId":"…"` 分组。

- [ ] **Step 3: 最小实现**

无需新生产代码；若 harness 的 `sentenceOne`/`sentenceTwo` 构造需要纯标点成分，在测试内补上并在注释写明这是坐标对齐的回归点。

- [ ] **Step 4: 运行确认通过**

Run: `cd chrome-plugin && npx vitest run src/background/analysis-service.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add chrome-plugin/src/background/analysis-service.test.ts
git commit -m "契约测试钉住多句 repair 分组与逐轮收窄"
```

---

### Task 6: Kotlin 侧同构改动

**Files:**
- Create: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/language/IndexedComponents.kt`
- Create: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/analysis/RepairErrors.kt`
- Modify: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/language/AnalysisValidator.kt:516-570`
- Modify: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/analysis/AnalysisService.kt:395-405`
- Modify: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/model/Prompts.kt:236-258`
- Test: `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/language/AnalysisValidatorTest.kt`

**Interfaces:**
- Consumes: TS 侧同一坐标系（错误文案必须逐字一致）。
- Produces: `internal data class RepairErrorGroup(val sentenceId: String, val rawOccurrence: Int?, val kind: String, val errors: List<ValidationError>)`；`internal fun groupRepairErrors(...)`。

- [ ] **Step 1: 写失败测试**

在 `AnalysisValidatorTest.kt` 新增与 Task 2/3 同形的两例（原始下标 + 语义邻接），断言 `path == "sentences[0].components[1].translation"`。

- [ ] **Step 2: 运行确认失败**

Run: `./gradlew :intellij-plugin:test --tests '*AnalysisValidatorTest*'`
Expected: FAIL — 路径仍是被排除后的下标。

- [ ] **Step 3: 最小实现**

按 TS 同构改写：`componentsValue.filterNot { … }` 先建 `mapIndexed { rawIndex, value -> }` 包装，再 `filterNot { isPunctuationOnly }`；`collectGrammarErrors` 接收 `List<IndexedCoreComponent>`，邻居取包装序列、路径取 `rawIndex`。`AnalysisService.kt:403` 的 `invalid.flatMap { it.second }` 改为 `groupRepairErrors(...)`，`Prompts.kt` 的 `buildRepairPrompt` 同步改签名与规则段两行（与 TS 逐字一致）。

- [ ] **Step 4: 运行确认通过**

Run: `./gradlew :intellij-plugin:test --tests '*AnalysisValidatorTest*' --tests '*AnalysisServiceTest*'`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax
git commit -m "IntelliJ 侧同步修复通道坐标系"
```

---

### Task 7: 验收记录口径与完整输出

**Files:**
- Modify: `.superpowers/acceptance/probe-arxiv-live.mjs`（gitignored）

**Interfaces:**
- Consumes: 生产消息与端口记录。
- Produces: 报告字段（单位见 Global Constraints 与 spec D8）。

- [ ] **Step 1: 改探针**

`output: streamedContent(call).slice(0, 4_000)` 改为完整输出；每条 call 增 `requestId` / `round` / `generation`；`cards` 增 `blockId`；新增 `inventory` 段（`inventoryTotal` / `expectedAutomatic` / `scannerDiscovered` 为语义单元数，`modelRequested` 为逻辑请求数，`ready` / `failed` / `skipped` 为句数），并在报告头写入 `units` 说明块级聚合规则（部分 ready、部分 failed 的块同时计入两个句级计数）。

- [ ] **Step 2: 运行验证**

Run: `source ~/.secrets && UPSTREAM=https://api.deepseek.com UPSTREAM_KEY="$DEEPSEEK_API_KEY" node .superpowers/acceptance/probe-arxiv-live.mjs --blocks=8`
Expected: 报告含上述字段；`output` 长度不再恒为 4 000。

- [ ] **Step 3: 提交**

不提交（`.superpowers/` 已 gitignore）。

---

## P1 批次：页面表示与标注口径

### Task 8: corpus v2 冻结与 baseline

**Files:**
- Modify: `shared-fixtures/visible-page-core-evaluation-corpus.json`
- Test: `chrome-plugin/scripts/core-evaluation.test.mjs`

**Interfaces:**
- Consumes: `validateCoreEvaluationCorpusV1`。
- Produces: corpus `version` 升为 `2`；边界 `79..115` / `152..213`。

- [ ] **Step 1: 改 fixture 并升版本**

`spring-np-coordination` 末成分 `79..116` → `79..115`；`spring-zero-relative` 末成分 `152..214` → `152..213`；顶层 `version: 2`；`source`/`annotationRationale` 注明「标点不覆盖，v2 重钉」。

- [ ] **Step 2: 运行确认旧断言失败**

Run: `cd chrome-plugin && npx vitest run scripts/core-evaluation.test.mjs`
Expected: FAIL — 测试若硬编码 v1 边界或版本 1。

- [ ] **Step 3: 更新断言**

改为按 v2 边界与版本断言；补一例「v1 与 v2 不互为配对基线」。

- [ ] **Step 4: 运行确认通过**

Run: `cd chrome-plugin && npx vitest run scripts/core-evaluation.test.mjs`
Expected: PASS。

- [ ] **Step 5: 跑 baseline（不进 CI）**

Run: `source ~/.secrets && node .superpowers/acceptance/run-core-gold-evaluation.mjs --mode pipeline --corpus=visible-page --candidate=.superpowers/acceptance/core-eval-v2-baseline-run{1,2,3}.json`
Expected: 三份 artifact 通过 `validateCoreEvaluationArtifactV1`；记录为 v2 baseline。

- [ ] **Step 6: 提交**

```bash
git add shared-fixtures/visible-page-core-evaluation-corpus.json chrome-plugin/scripts/core-evaluation.test.mjs
git commit -m "页面语料v2重钉边界并冻结基线"
```

---

### Task 9: 静默错标审计集与审计器

**Files:**
- Create: `shared-fixtures/audit-silent-mislabel.json`
- Create: `chrome-plugin/scripts/silent-mislabel-audit.mjs`
- Test: `chrome-plugin/scripts/silent-mislabel-audit.test.mjs`

**Interfaces:**
- Consumes: `shared-fixtures/core-evaluation-traces.json` 的坐标习惯。
- Produces:
  - `function validateAuditSetV1(value: unknown): AuditSetV1`
  - `function auditPredictions(set: AuditSetV1, predictionsByCase: Map<string, unknown>): AuditReportV1`
  - 报告含运行轴（未请求/未终态/失败/通过）与裁决轴（已裁决/待裁决），以及 `silentMislabelRate`（分母 0 时 `null`）与 `correctnessLowerBound`。

- [ ] **Step 1: 写失败测试**

```js
// chrome-plugin/scripts/silent-mislabel-audit.test.mjs
import { describe, expect, it } from "vitest";
import { auditPredictions, validateAuditSetV1 } from "./silent-mislabel-audit.mjs";

const set = {
  schemaVersion: 1,
  cases: [
    {
      caseId: "heading-number-binding-ii-2-2",
      category: "heading-number-binding",
      text: "II.2.2 Generating and storing the LOS redshift prior",
      fingerprint: "sha256:…",
      tokenization: "core-13",
      adjudicationStatus: "adjudicated",
      acceptedAnalyses: [
        [
          { startToken: 0, endToken: 9, role: "FRAGMENT_HEAD" },
        ],
      ],
      constraints: [
        { type: "must-cover-together", tokens: [0, 9] },
        { type: "must-not-be-standalone-role", tokens: [0, 2], role: "FRAGMENT_HEAD" },
      ],
    },
  ],
};

it("把现网的编号独立片段主体判为违反", () => {
  const report = auditPredictions(set, new Map([
    ["heading-number-binding-ii-2-2", { components: [
      { startToken: 0, endToken: 2, role: "FRAGMENT_HEAD", translation: "II.2.2 节" },
      { startToken: 3, endToken: 9, role: "ATTRIBUTE", translation: "生成并存储…" },
    ] }],
  ]));
  expect(report.cases[0].verdict).toBe("violates-gold");
  expect(report.silentMislabelRate).toBe(1);
});

it("待裁决项不进正式分母", () => {
  const pending = { schemaVersion: 1, cases: [{ ...set.cases[0], adjudicationStatus: "pending" }] };
  const report = auditPredictions(pending, new Map());
  expect(report.silentMislabelRate).toBeNull();
  expect(report.correctnessLowerBound).toBe(0);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd chrome-plugin && npx vitest run scripts/silent-mislabel-audit.test.mjs`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 最小实现**

实现 `validateAuditSetV1`（唯一 caseId、非空 `acceptedAnalyses`、区间合法有序、`constraints` 指向 token 范围、oracle 自洽）与 `auditPredictions`（完整答案匹配 + 全部 constraints 通过才 `meets-gold`；单独成分为 `violates-gold`；缺预测为 `not-requested`）。审计集先放三条真实 case：`II.2.2` 编号绑定、`Figure 2:` label、`[61].` 句末引用附着（后者 `adjudicationStatus: "pending"`，等 D4 政策冻结后裁决）。

- [ ] **Step 4: 运行确认通过**

Run: `cd chrome-plugin && npx vitest run scripts/silent-mislabel-audit.test.mjs`
Expected: PASS（2 例）。

- [ ] **Step 5: 提交**

```bash
git add shared-fixtures/audit-silent-mislabel.json chrome-plugin/scripts/silent-mislabel-audit.mjs chrome-plugin/scripts/silent-mislabel-audit.test.mjs
git commit -m "建立静默错标审计集与两轴报告"
```

---

### Task 10: 引用附着与编号绑定口径（prompt + 黄金集）

**Files:**
- Modify: `chrome-plugin/src/background/prompts.ts`（规则段）
- Modify: `shared-fixtures/core-gold-annotations.json`（conventions + 新句）
- Modify: `shared-fixtures/audit-silent-mislabel.json`（把待裁决项裁决）
- Test: `chrome-plugin/src/language/core-gold-annotations.test.ts`

**Interfaces:**
- Consumes: Task 9 的审计集。
- Produces: 两条新 conventions；黄金集新句 `ref-trailing-citation-1`、`heading-number-binding-1`。

- [ ] **Step 1: 写失败测试**

在 `core-gold-annotations.test.ts` 加断言：`conventions` 含「句末书目引用并入前一成分」与「章节编号与其标题中心词同属一个 `FRAGMENT_HEAD`」；新句按 ID 精确断言 span/role。

- [ ] **Step 2: 运行确认失败**

Run: `cd chrome-plugin && npx vitest run src/language/core-gold-annotations.test.ts`
Expected: FAIL — conventions 与新句缺失。

- [ ] **Step 3: 最小实现**

prompt 规则段补两条口径并各配一个反例（`The vector is [1, 2].` 的 `[1, 2]` 不并入、`IV.2 Implications for the future` 的 `for the future` 仍可单列 `ATTRIBUTE`）；黄金集两句按**人工核语言学正确性**填写（标点不覆盖；编号绑定句的 `FRAGMENT_HEAD` 覆盖编号 + 标题主体）；把 Task 9 的引用附着 case 裁决为 `adjudicated` 并填 `acceptedAnalyses`。

- [ ] **Step 4: 运行确认通过**

Run: `cd chrome-plugin && npx vitest run src/language/core-gold-annotations.test.ts src/language/analysis-validator.test.ts && npx vitest run scripts/silent-mislabel-audit.test.mjs`
Expected: PASS（黄金集整份通过 validator）。

- [ ] **Step 5: 真模型验证效果**

Run: `source ~/.secrets && MODEL=deepseek-flash UPSTREAM=https://api.deepseek.com UPSTREAM_KEY="$DEEPSEEK_API_KEY" node .superpowers/acceptance/probe-arxiv-live.mjs --blocks=1000 --out=/tmp/arxiv-after-citation.json`
Expected: 句末引用号独立成分数下降；记录数字供 Task 16 对比。

- [ ] **Step 6: 提交**

```bash
git add chrome-plugin/src/background/prompts.ts shared-fixtures/core-gold-annotations.json shared-fixtures/audit-silent-mislabel.json chrome-plugin/src/language/core-gold-annotations.test.ts
git commit -m "统一句末引用附着与章节编号绑定的口径"
```

---

### Task 11: 公式改取可见 MathML 文本

**Files:**
- Modify: `chrome-plugin/src/content/readable-dom-text.ts`
- Test: `chrome-plugin/src/content/readable-dom-text.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces: `normalizedReadableText(element: Element): string` 行为变更（`alttext` 不再参与）。

- [ ] **Step 1: 改现有测试为期望失败**

把「math 优先使用 alttext 且只取一次」改为：

```ts
it("alttext 是 TeX 源码时不采用,改读可见 MathML 文本", () => {
  const element = elementFrom(
    '<p>Value of <math alttext="H_{0}={71.9}_{-7.5}^{+9.1}"><semantics>' +
      '<mrow><msub><mi>H</mi><mn>0</mn></msub><mo>=</mo><mn>71.9</mn></mrow>' +
      '<annotation encoding="application/x-tex">H_{0}={71.9}_{-7.5}^{+9.1}</annotation></semantics></math> here.</p>',
  );
  const text = normalizedReadableText(element);
  expect(text).toContain("H0=71.9");
  expect(text).not.toContain("\\");
});
```

补 `mtext` 保留、`mphantom` 排除、`annotation-xml` 排除、隐藏祖先阻断、嵌套 math 不重复、math 与 span 交错不插空格、空表示不产出空片段各一例。

- [ ] **Step 2: 运行确认失败**

Run: `cd chrome-plugin && npx vitest run src/content/readable-dom-text.test.ts`
Expected: FAIL — 现在返回 alttext。

- [ ] **Step 3: 最小实现**

`AUXILIARY_SELECTOR` 扩为 `"annotation,annotation-xml,semantics>annotation,[aria-hidden='true'],mphantom"`；`visibleMathText` 改为递归遍历（含元素自身的可见性判断），不再读 `alttext`；两处 `getAttribute("alttext") ??` 删除。

- [ ] **Step 4: 运行确认通过**

Run: `cd chrome-plugin && npx vitest run src/content/readable-dom-text.test.ts src/content/page-inventory.test.ts`
Expected: PASS；`page-inventory` 若因文本变化导致 fixture 全等失配，按新文本更新 fixture 并在提交信息说明。

- [ ] **Step 5: 提交**

```bash
git add chrome-plugin/src/content/readable-dom-text.ts chrome-plugin/src/content/readable-dom-text.test.ts
git commit -m "公式文本改取可见 MathML 而非 TeX alttext"
```

---

### Task 12: 版本同步升级（token 文本已变）

**Files:**
- Modify: `chrome-plugin/src/shared/versions.ts`
- Modify: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/domain/Domain.kt`
- Modify: `shared-fixtures/contracts.json`、`shared-fixtures/core-prompt-parity.json`（parity 只由 TS 生成）
- Test: `chrome-plugin/src/shared/cross-platform-contract.test.ts`

**Interfaces:**
- Consumes: Task 11 的 token 文本变化。
- Produces: `CORE_PROMPT_VERSION = 14`、`DETAIL_PROMPT_VERSION = 8`、`CORE_SCHEMA_VERSION = 3`。

- [ ] **Step 1: 写失败测试**

在 `cross-platform-contract.test.ts` 断言三处版本一致且为 `3/14/8`。

- [ ] **Step 2: 运行确认失败**

Run: `cd chrome-plugin && npx vitest run src/shared/cross-platform-contract.test.ts`
Expected: FAIL — 现为 `3/13/7`。

- [ ] **Step 3: 同步三处**

`versions.ts`、`Domain.kt`、`contracts.json` 同时改为 `3/14/8`；重生成 `core-prompt-parity.json`。

- [ ] **Step 4: 运行确认通过**

Run: `cd chrome-plugin && npx vitest run src/shared/cross-platform-contract.test.ts && cd .. && ./gradlew :intellij-plugin:test --tests '*Domain*'`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add chrome-plugin/src/shared/versions.ts intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/domain/Domain.kt shared-fixtures/contracts.json shared-fixtures/core-prompt-parity.json chrome-plugin/src/shared/cross-platform-contract.test.ts
git commit -m "分词文本变化同步提升双提示词版本"
```

---

### Task 13: 邮箱元数据排除

**Files:**
- Modify: `chrome-plugin/src/content/page-inventory.ts:343-360`
- Test: `chrome-plugin/src/content/page-inventory.test.ts`

**Interfaces:**
- Consumes: 现有 `reference-metadata` reason。
- Produces: `scientificExclusion` 新增邮箱块判定。

- [ ] **Step 1: 写失败测试**

```ts
it("整块由邮箱与转换残留构成时按 reference-metadata 排除", () => {
  const root = elementFrom(
    "<article><p>show]Rachel.Gray@glasgow.ac.uk ]Daniel.Williams@glasgow.ac.uk</p>" +
      "<p>Contact us at author@example.org for details.</p></article>",
  );
  const units = inventoryReadableUnits(root);
  expect(units.find((u) => u.text.includes("Rachel.Gray"))?.exclusionReason).toBe("reference-metadata");
  expect(units.find((u) => u.text.startsWith("Contact us"))?.automatic).toBe(true);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd chrome-plugin && npx vitest run src/content/page-inventory.test.ts -t "邮箱"`
Expected: FAIL — 邮箱块现在是 automatic。

- [ ] **Step 3: 最小实现**

```ts
/** 作者邮箱串与其转换残留(`show]`、孤立 `]`、逗号、连接词)构成的整块,不是可读正文。 */
const EMAIL_TOKEN_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const AUTHOR_RESIDUE_PATTERN = /^(show|and|,|;|\]|\[|\|)$/iu;

function isContactMetadataBlock(text: string): boolean {
  const parts = text.trim().split(/\s+/u);
  if (parts.length === 0) return false;
  let emails = 0;
  for (const part of parts) {
    const bare = part.replace(/^[\]\[]+/u, "").replace(/[.,;]+$/u, "");
    if (EMAIL_TOKEN_PATTERN.test(bare)) {
      emails += 1;
      continue;
    }
    if (AUTHOR_RESIDUE_PATTERN.test(part)) continue;
    return false; // 出现任何其它实词,说明是正文
  }
  return emails > 0;
}
```

在 `scientificExclusion` 的开头调用它并返回 `"reference-metadata"`。

- [ ] **Step 4: 运行确认通过**

Run: `cd chrome-plugin && npx vitest run src/content/page-inventory.test.ts`
Expected: PASS（含反向保留例）。

- [ ] **Step 5: 提交**

```bash
git add chrome-plugin/src/content/page-inventory.ts chrome-plugin/src/content/page-inventory.test.ts
git commit -m "作者邮箱块按元数据排除而非当正文解析"
```

---

### Task 14: 补 TS/Kotlin 错误文案漂移

**Files:**
- Modify: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/language/AnalysisValidator.kt:304-313`
- Modify: `shared-fixtures/validator-messages.json`
- Test: `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/language/ValidatorMessagesTest.kt`

**Interfaces:**
- Consumes: 无。
- Produces: 双端逐字一致的 `auxiliary/modal verb "…" must be merged with the following main verb into one PREDICATE covering the complete verb group`。

- [ ] **Step 1: 写失败测试**

在 `validator-messages.json` 的 `coveredMessageSubstrings` 补该文案，并加一个 case（`is` + `running` 相邻两个 PREDICATE）。

- [ ] **Step 2: 运行确认失败**

Run: `./gradlew :intellij-plugin:test --tests '*ValidatorMessagesTest*'`
Expected: FAIL — Kotlin 产出通用 adjacent PREDICATE 文案。

- [ ] **Step 3: 最小实现**

Kotlin 侧补 `auxiliaryModals` 词表与分支，文案与 TS 逐字一致。

- [ ] **Step 4: 运行确认通过**

Run: `cd chrome-plugin && npx vitest run src/language/validator-messages.test.ts && cd .. && ./gradlew :intellij-plugin:test --tests '*ValidatorMessagesTest*'`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/language/AnalysisValidator.kt shared-fixtures/validator-messages.json intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/language/ValidatorMessagesTest.kt
git commit -m "对齐助动词相邻谓语的错误文案"
```

---

### Task 15: 文档同步

**Files:**
- Modify: `docs/architecture/model-pipeline.md`、`docs/architecture/modules.md`、`docs/architecture/invariants.md`、`docs/architecture/rendering.md`、`docs/architecture/build-test-release.md`、`AGENTS.md`、`CHANGELOG.md`
- Test: `chrome-plugin/src/shared/architecture-docs.test.ts`

**Interfaces:**
- Consumes: 全部前序任务。
- Produces: 无。

- [ ] **Step 1: 写失败断言（若机器可判）**

`architecture-docs.test.ts` 若钉住版本号或模块职责，改为新值；**不放宽现有断言**。

- [ ] **Step 2: 运行确认失败**

Run: `cd chrome-plugin && npx vitest run src/shared/architecture-docs.test.ts`
Expected: FAIL（版本 `3/14/8` 或 `readable-dom-text` 职责描述）。

- [ ] **Step 3: 改文档**

- `model-pipeline.md`：MathML 口径修订（不再用 alttext 及其原因）、版本 `3/14/8`、评测数字按 corpus v2 解读；
- `modules.md`：`readable-dom-text` 职责改为「可见 MathML 文本」；登记 `indexed-components.ts` / `repair-errors.ts` / `silent-mislabel-audit.mjs`；
- `invariants.md`：新增「repair 错误坐标必须与模型所见 JSON 一致」「MathML alttext 是 TeX 源码」「坐标改动不得改变接受集合」三条（规则/为什么/症状/守护测试）；
- `rendering.md`：静默错标审计与两轴报告；
- `build-test-release.md`：报告记录口径与分层验证；
- `AGENTS.md`：摘要上述约定；`CHANGELOG.md`：新增条目。

- [ ] **Step 4: 运行确认通过**

Run: `cd chrome-plugin && npx vitest run src/shared/architecture-docs.test.ts && npm run docs:drift`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add docs AGENTS.md CHANGELOG.md
git commit -m "文档同步修复通道与科学页面口径"
```

---

### Task 16: 全门禁与真机对比

**Files:** 无新增。

- [ ] **Step 1: Chrome 门禁**

```bash
cd chrome-plugin && npm test && npx playwright test && npm run lint && npm run format:check && npm run build
```

Expected: 测试与构建通过；lint **恰好**只报 `src/options/options.test.ts` 的 `no-unnecessary-type-assertion`（显式核对，不看退出码）。

- [ ] **Step 2: IntelliJ 门禁**

```bash
(cd intellij-plugin && npm ci && npm test) \
  && ./gradlew :intellij-plugin:test :intellij-plugin:buildPlugin :intellij-plugin:verifyPluginProjectConfiguration
```

- [ ] **Step 3: 真机全页对比**

```bash
source ~/.secrets && MODEL=deepseek-flash UPSTREAM=https://api.deepseek.com UPSTREAM_KEY="$DEEPSEEK_API_KEY" \
  node .superpowers/acceptance/probe-arxiv-live.mjs --blocks=1000 --out=/tmp/arxiv-after.json
```

对照指标（基线见 spec §1）：含 `\` 的成分 79 → 目标 0；含失败块 37（20.1%）；引用号独立成分；图注/章节标题失败数。不足时逐句给出原因分类。

- [ ] **Step 4: 两套 corpus 三次配对**

```bash
source ~/.secrets && node .superpowers/acceptance/run-core-gold-evaluation.mjs --mode pipeline --candidate=.superpowers/acceptance/core-eval-v2-candidate-run{1,2,3}.json
```

Expected: `correctToWrongOrFailure = 0`；与 Task 8 的 v2 baseline 配对比较。

- [ ] **Step 5: 审计集报告**

```bash
cd chrome-plugin && node scripts/silent-mislabel-audit.mjs --predictions=/tmp/arxiv-after.json
```

Expected: 两轴分栏 + 静默错标率与正确率下界；`II.2.2` 编号绑定项为 `meets-gold`。

- [ ] **Step 6: 提交（若有剩余改动）**

```bash
git status --short && git diff --check
```

---

## Self-Review

**Spec 覆盖核对**

| spec 项 | 任务 |
| --- | --- |
| D1a 句身份四类路径 | Task 4（TS）、Task 6（Kotlin） |
| D1b 四阶段坐标 + 语义不变量 | Task 1–3 |
| D1c 逐轮收窄 | Task 5 |
| D1b 附带的文案漂移 | Task 14 |
| D2 公式文本九项决定 | Task 11 |
| D3 邮箱排除 | Task 13 |
| D4 引用附着（不进硬门） | Task 10 |
| D5 编号绑定主体 | Task 10 |
| D6 版本 3/14/8 | Task 12 |
| D7 corpus v2 + baseline | Task 8 |
| D8 记录口径（P0 同批） | Task 7（P0 批次末尾） |
| D9 静默错标审计 | Task 9、Task 10 |
| 文档同步 | Task 15 |
| 验收标准 1–8 | Task 16 |

**类型一致性**：`InvalidCoreSentence` 在 Task 4 从 `analysis-service.ts` 移到 `repair-errors.ts` 并重导出，Task 5/6 引用同一名字；`RepairErrorGroup` 的 `kind` 在 TS 与 Kotlin 均为 `invalid|missing|duplicate`；`buildRepairPrompt` 第二参数在 Task 4 与 Task 6 都是分组数组（Kotlin 为 `List<RepairErrorGroup>`）。

**已知取舍**：Task 7 的探针改动在 gitignored 目录，不产生提交；Task 8 的 baseline 与 Task 16 的 candidate 都不进 CI（遵守「CI 不联网」）。
