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

// "The service works well." tokenize 后：0 The / 1 service / 2 works / 3 well / 4 .(p)
describe("rawComponentEntries", () => {
  it("记录原始下标后再排除纯标点成分", () => {
    const entries = rawComponentEntries(
      [
        { startToken: 0, endToken: 1, role: "SUBJECT", translation: "服务" },
        { startToken: 4, endToken: 4, role: "PUNCTUATION", translation: "。" }, // token 4 才是句号
        { startToken: 2, endToken: 3, role: "PREDICATE", translation: "运转良好" },
      ],
      tokens,
    );
    expect(entries.map((entry) => entry.rawIndex)).toEqual([0, 2]);
  });

  it("非法元素保留原始下标、不当作可跳过", () => {
    const entries = rawComponentEntries(["not-an-object"], tokens);
    expect(entries.map((entry) => entry.rawIndex)).toEqual([0]);
  });

  it("按 token 内容判纯标点,不看模型虚构的角色", () => {
    // 角色写成 PUNCTUATION 但区间覆盖实词时,不能被跳过。
    const entries = rawComponentEntries(
      [{ startToken: 2, endToken: 3, role: "PUNCTUATION", translation: "。" }],
      tokens,
    );
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
  // 原始下标 0 是纯标点成分(被跳过);SUBJECT 合法(有中文),只有原始下标 2
  // 的 PREDICATE 回显英文。旧实现报 components[1],新实现必须报 components[2]。
  const result = validateCoreBatch(
    coreRaw([
      { startToken: 4, endToken: 4, role: "PUNCTUATION", translation: "。" },
      { startToken: 0, endToken: 1, role: "SUBJECT", translation: "服务" },
      { startToken: 2, endToken: 3, role: "PREDICATE", translation: "works well" },
    ]),
    [sentence],
    "profile-1",
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  const paths = result.errors.map((error) => error.path);
  expect(paths).toContain("sentences[0].components[2].translation");
  expect(paths).not.toContain("sentences[0].components[1].translation");
  expect(paths).not.toContain("sentences[0].components[0].translation");
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

改 `collectGrammarErrors`：**注意迁移的是「取出的对象类型」，不是「序列长度」**——`components.length` 可以保留（包装序列长度 == 原成功解析的语义成分数），但凡从序列里取出对象读 role/区间的地方都必须解包 `.component`。逐处清单（对照 `analysis-validator.ts`）：

| 现有行 | 现有写法 | 迁移后 |
| --- | --- | --- |
| `:331` | `const componentPath = \`${path}.components[${index}]\`` | 用 `entry.rawIndex` |
| `:332` | `components.some((c) => c.role === CONJUNCTION)` | `components.some(({ component }) => …)` |
| `:335` | `const previous = components[index - 1]` | `components[index - 1]?.component`（语义邻接，不是原数组邻接） |
| `:464-466` | **后继门** `components[index + 1]!.role`（`ATTRIBUTIVE_CLAUSE` 后接 `OBJECT`/`PREDICATIVE`） | `components[index + 1]?.component?.role` |
| `:495-497` | 单成分门 `const only = components[0]`、`lexicalTexts(tokens, only)` | `only` 取解包后的 `CoreComponent` |
| `:528-530` | `coordinateClauses` 过滤读 role | 先 `map(({ component }) => component)` 再过滤 |
| `:539-541` | `fragmentHeads` 过滤读 role | 同上 |
| `:549-551` | fragment 混用角色检查读 role | 同上 |

`collectGrammarErrors` 接收包装序列后的骨架：

```ts
function collectGrammarErrors(
  components: readonly IndexedCoreComponent[],
  tokens: readonly Token[],
  path: string,
  errors: ValidationError[],
): void {
  const roles = components.map(({ component }) => component);
  const hasConjunction = roles.some((component) => component.role === GrammarRole.CONJUNCTION);

  components.forEach((entry, index) => {
    const { component } = entry;
    const componentPath = `${path}.components[${entry.rawIndex}]`;
    const previous = components[index - 1]?.component; // 语义邻接
    const next = components[index + 1]?.component; // 语义邻接
    // …其余判断体用 component / previous / next,role 类聚改用 roles…
```

**coverage 与返回值同样要解包**：`:762-779` 的 coverage 继续用成功解析的语义成分，但读的是 `entry.component.startToken/endToken`；`:789-794` 的返回必须投影为纯 `CoreComponent[]`（`validComponents.map(({ component }) => component)`），**不得把包装对象或 rawIndex 泄漏进缓存与渲染**。返回判断改为 `validComponents.length !== entries.length`（语义等价：成功解析数 ≠ 非纯标点候选数）。

coverage 的三条诊断与句级路径保持不变：非标点漏覆盖、非标点重复覆盖、**标点重复覆盖**；且 `structureTrusted === false` 时照旧执行 coverage。

- [ ] **Step 4: 运行确认通过**

Run: `cd chrome-plugin && npx vitest run src/language/analysis-validator.test.ts`
Expected: PASS（含全部既有用例——这是「接受集合不变」的守护）。

- [ ] **Step 5: 提交**

```bash
git add chrome-plugin/src/language/analysis-validator.ts chrome-plugin/src/language/analysis-validator.test.ts
git commit -m "validator 错误路径改用原始成分下标"
```

---

### Task 3: grammar 门的保行为守护与 rawIndex 平移

**Files:**
- Test: `chrome-plugin/src/language/analysis-validator.test.ts`（新增用例）

**Interfaces:**
- Consumes: Task 2 的 `collectGrammarErrors` 语义邻接与 rawIndex 路径。
- Produces: 无。

**注意**：`ATTRIBUTIVE_CLAUSE` 后接 `OBJECT` 的门（`analysis-validator.ts:464-471`）**检查的是后继成分 `components[index + 1]`**，且传入的序列**本来就已过滤纯标点**——所以「隔一个纯标点成分」这个场景在旧实现下**已经会拒绝**，它不是 RED，而是「坐标改动不得破坏它」的保行为测试。下面第二个用例才是真正的 RED（rawIndex 平移）。

- [ ] **Step 1: 写测试**

```ts
// 文本 tokenize：0 The / 1 API / 2 that / 3 returns / 4 JSON / 5 responses /
// 6 ,(p) / 7 an / 8 object / 9 .(p)
const adjacency: SentenceInput = {
  sentenceId: "adjacency-1",
  text: "The API that returns JSON responses, an object.",
  tokens: tokenize("The API that returns JSON responses, an object."),
};

it("保行为:定语从句后接宾语仍被拒(纯标点成分在中间不影响)", () => {
  const result = validateCoreBatch(
    {
      sentences: [
        {
          sentenceId: adjacency.sentenceId,
          components: [
            { startToken: 0, endToken: 1, role: "SUBJECT", translation: "该 API" },
            { startToken: 2, endToken: 5, role: "ATTRIBUTIVE_CLAUSE", translation: "返回 JSON 响应的" },
            { startToken: 6, endToken: 6, role: "PUNCTUATION", translation: "，" },
            { startToken: 7, endToken: 8, role: "OBJECT", translation: "一个对象" },
          ],
        },
      ],
    },
    [adjacency],
    "profile-1",
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  const grammar = result.errors.find((e) => e.message.includes("ATTRIBUTIVE_CLAUSE"));
  expect(grammar).toBeDefined();
  // 从句在原始下标 1（下标 0 是 SUBJECT）；标点成分在从句之后，不改变从句路径。
  expect(grammar!.path).toBe("sentences[0].components[1]");
});

it("RED:从句之前插入纯标点成分后,grammar 错误路径随 rawIndex 平移", () => {
  const result = validateCoreBatch(
    {
      sentences: [
        {
          sentenceId: adjacency.sentenceId,
          // 原始下标 0 是纯标点成分(被跳过);从句现在位于原始下标 2。
          components: [
            { startToken: 9, endToken: 9, role: "PUNCTUATION", translation: "。" },
            { startToken: 0, endToken: 1, role: "SUBJECT", translation: "该 API" },
            { startToken: 2, endToken: 5, role: "ATTRIBUTIVE_CLAUSE", translation: "返回 JSON 响应的" },
            { startToken: 7, endToken: 8, role: "OBJECT", translation: "一个对象" },
          ],
        },
      ],
    },
    [adjacency],
    "profile-1",
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  const grammar = result.errors.find((e) => e.message.includes("ATTRIBUTIVE_CLAUSE"));
  expect(grammar).toBeDefined();
  // 旧实现报 components[1]（过滤后下标），新实现必须报 components[2]。
  expect(grammar!.path).toBe("sentences[0].components[2]");
});
```

- [ ] **Step 2: 确认第二个用例失败、第一个通过**

Run: `cd chrome-plugin && npx vitest run src/language/analysis-validator.test.ts -t "语义邻接"`
（`-t` 匹配不到上面两个用例名时，直接跑整文件并查看这两例。）
Expected: 第二例 FAIL（旧实现报 `components[1]`）；第一例 **PASS**——它本来就是保行为测试，不是 RED。

- [ ] **Step 3: 最小实现**

确认 Task 2 的 `components[index - 1]?.component` 与 `components[index + 1]?.component` 都按**包装序列**取值、路径取 `entry.rawIndex`；若误用原数组下标，改回包装序列取值。

- [ ] **Step 4: 运行确认通过**

Run: `cd chrome-plugin && npx vitest run src/language/analysis-validator.test.ts`
Expected: PASS（两例）。

- [ ] **Step 5: 提交**

```bash
git add chrome-plugin/src/language/analysis-validator.test.ts
git commit -m "守护 grammar 语义邻接与诊断下标平移"
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
  const missing = groupRepairErrors([{ sentence: sentence("a"), errors: [] }], { sentences: [] });
  expect(missing[0]).toMatchObject({ sentenceId: "a", kind: "missing" });

  const duplicate = groupRepairErrors(
    [{ sentence: sentence("a"), errors: [{ path: "sentences[1].sentenceId", message: "is duplicated" }] }],
    { sentences: [{ sentenceId: "a" }, { sentenceId: "a" }] },
  );
  expect(duplicate).toEqual([
    { sentenceId: "a", rawOccurrence: 1, kind: "duplicate", errors: [{ path: "", message: "remove this duplicate instance" }] },
  ]);
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
 *
 * 关键:出现重复实例时**不能吞掉首实例自身的结构错误**——重复与非法可以并存,
 * 两者必须各出一组。首实例按 invalid 带完整 stripping 后的错误;每个重复实例
 * 各出一条删除指令。
 */
export function groupRepairErrors(
  invalid: readonly InvalidCoreSentence[],
  raw: unknown,
): RepairErrorGroup[] {
  const ids = rawIds(raw);
  const groups: RepairErrorGroup[] = [];
  for (const { sentence, errors } of invalid) {
    const occurrences = ids.filter((id) => id === sentence.sentenceId).length;
    if (occurrences === 0) {
      groups.push({
        sentenceId: sentence.sentenceId,
        kind: "missing",
        errors: [{ path: "", message: "no output for this sentenceId; emit it" }],
      });
      continue;
    }
    const stripped = errors
      // 「is duplicated」是批级簿记错误,不是该实例的结构错误:不进首实例组。
      .filter(({ message }) => !message.includes("is duplicated"))
      .map(({ path, message }) => ({ path: path.replace(SENTENCE_PREFIX, ""), message }));
    if (stripped.length > 0) {
      groups.push({
        sentenceId: sentence.sentenceId,
        rawOccurrence: 0,
        kind: "invalid",
        errors: stripped,
      });
    }
    for (let occurrence = 1; occurrence < occurrences; occurrence += 1) {
      groups.push({
        sentenceId: sentence.sentenceId,
        rawOccurrence: occurrence,
        kind: "duplicate",
        errors: [{ path: "", message: "remove this duplicate instance" }],
      });
    }
  }
  return groups;
}
```

`requested` 参数不需要（`invalid` 已带 `sentence`），**不要保留未使用形参**（lint 会报）。

补充两个测试（与上面的分组测试同文件）：

```ts
it("重复实例与首实例非法并存时,两边各出一组、互不吞并", () => {
  const groups = groupRepairErrors(
    [
      {
        sentence: sentence("a"),
        errors: [
          { path: "sentences[1].sentenceId", message: "is duplicated" },
          { path: "sentences[0].components[1].translation", message: "m-a" },
        ],
      },
    ],
    { sentences: [{ sentenceId: "a" }, { sentenceId: "a" }, { sentenceId: "a" }] },
  );
  expect(groups).toEqual([
    { sentenceId: "a", rawOccurrence: 0, kind: "invalid", errors: [{ path: "components[1].translation", message: "m-a" }] },
    { sentenceId: "a", rawOccurrence: 1, kind: "duplicate", errors: [{ path: "", message: "remove this duplicate instance" }] },
    { sentenceId: "a", rawOccurrence: 2, kind: "duplicate", errors: [{ path: "", message: "remove this duplicate instance" }] },
  ]);
});
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

**断言必须解析 `Validation errors:` 段**：旧实现的 repair prompt 里本来就有输入句与 Invalid JSON 的 `sentenceId`，所以对整份 prompt 做 `toContain(sentenceId)` **无法区分新旧通道**，不是有效 RED。

- [ ] **Step 1: 写失败测试**

```ts
/** 取出 repair prompt 里 `Validation errors:` 与 `Invalid JSON:` 之间的分组。 */
function errorGroupsOf(prompt: string): { sentenceId: string; errors: { path: string; message: string }[] }[] {
  const start = prompt.indexOf("Validation errors:");
  const end = prompt.indexOf("Invalid JSON:");
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return JSON.parse(prompt.slice(start + "Validation errors:".length, end).trim());
}

it("多失败句 repair:errors 按句分组,已修好的兄弟句不回流", async () => {
  // 两句都非法(各自只有一处译文回显),其中第一句还带一个纯标点成分。
  const invalidBoth = {
    sentences: [
      { sentenceId: sentenceOne.sentenceId, components: punctuationPlusEcho(sentenceOne) },
      { sentenceId: sentenceTwo.sentenceId, components: echoOnly(sentenceTwo) },
    ],
  };
  // 第二轮只修好第一句(第二句仍回显)。
  const secondRound = { sentences: [validCore(sentenceOne)] };
  const thirdRound = { sentences: [validCore(sentenceOne), validCore(sentenceTwo)] };
  const { adapter, service } = harness([invalidBoth, secondRound, thirdRound]);

  const outcome = await service.analyzeCore(
    coreInput([sentenceOne, sentenceTwo]),
    new AbortController().signal,
  );

  // completeJson(profile, messages, schema, signal)——messages 是第 2 个参数(索引 1)。
  const repairPrompts = adapter.completeJson.mock.calls
    .map((call) => (call[1] as { content: string }[]).at(-1)!.content)
    .filter((content) => content.includes("Repair only the structure"));
  expect(repairPrompts).toHaveLength(2);

  // 第一轮:两组各自的错误只含本句,路径不带 sentences[i] 前缀。
  const firstGroups = errorGroupsOf(repairPrompts[0]!);
  expect(firstGroups.map((group) => group.sentenceId)).toEqual([
    sentenceOne.sentenceId,
    sentenceTwo.sentenceId,
  ]);
  for (const group of firstGroups) {
    expect(group.errors.length).toBeGreaterThan(0);
    for (const error of group.errors) {
      expect(error.path.startsWith("sentences[")).toBe(false);
    }
  }

  // 第二轮:只带仍失败的第二句,已修好的第一句不得回流。
  const secondGroups = errorGroupsOf(repairPrompts[1]!);
  expect(secondGroups.map((group) => group.sentenceId)).toEqual([sentenceTwo.sentenceId]);

  expect(outcome.result).toHaveLength(2);
});
```

辅助构造函数按既有 `rawCore(sentence)` 风格实现（`punctuationPlusEcho` 在首部插一个覆盖句号的纯标点成分，`echoOnly` 让被回显成分之外的成分译文合法）。

- [ ] **Step 2: 运行确认失败**

Run: `cd chrome-plugin && npx vitest run src/background/analysis-service.test.ts -t "errors 按句分组"`
Expected: FAIL — 旧实现下 `errorGroupsOf` 拿到的是扁平的 `ValidationError[]`，分组断言不成立。

- [ ] **Step 3: 最小实现**

无需新生产代码（Task 4 已实现分组）；把上面两个辅助构造函数补进测试文件。

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

**Kotlin 与 TS 的真实差异，逐条落实（不要照抄 TS 语义）**：

1. **JSON 类型**：候选是 `JsonElement`。现有 `asObject` / `safeInt` 是 `AnalysisValidator.kt` 的**文件级 private**（`:66-77`），搬到新文件后**不能直接调用**——要么把它们提为 `internal`，要么在新文件里复制同语义实现（`safeInt` 拒绝字符串/非整数格式/超 Int 范围，不能放宽）。
2. **包装非空 ≠ 解析成功**：`ParsedComponentEntry(component = null)` 本身不是 null。原 `parsed.all { it != null }` 与 `parsed.filterNotNull()`（`:532`、`:551`）**必须改成检查 `.component`**，否则 parse failure 会被当成成功。
3. **rawIndex 必须在第一次过滤前记录**：先 `mapIndexed` 建包装，再 `filterNot { isPunctuationOnly }`；不能过滤后 `mapIndexed`，也不能提前 `mapNotNull` 丢掉失败候选。
4. **coverage（`:555-564`）与返回（`CoreAnalysis(components = valid)`）都要解包**：读 `entry.component.startToken/endToken`，返回投影为 `List<CoreComponent>`。
5. **服务层真实类型是 `Pair`**：`AnalysisService.kt:428-449` 用 `List<Pair<SentenceInput, List<ValidationError>>>`。`groupRepairErrors` 的形参按此签名，不要照搬 TS 的 `InvalidCoreSentence`。
6. **序列化**：`Prompts.kt:254` 用 `encodeToJsonElement`；新 data class 需可序列化（`@Serializable` 或手工构 `JsonObject`）。`buildRepairPrompt` 是 public，其参数类型不能是 internal——把 `RepairErrorGroup` 声明为 public 或改为传 `JsonElement`。
7. **missing/duplicate 的字段省略**：`promptJson` 开了 `encodeDefaults = true`（`Prompts.kt:24-27`），`rawOccurrence: Int?` 为 null 时是否输出 null 字段必须显式决定（建议手构 `JsonObject`），保证四类格式与 TS 逐字一致。
8. **文案逐字一致**：新加的两行规则句与 TS 完全相同，且 `coveredMessageSubstrings` 的守护要能覆盖它们。

- [ ] **Step 4: 运行确认通过**

Run: `./gradlew :intellij-plugin:test --tests '*AnalysisValidatorTest*' --tests '*AnalysisServiceTest*' --tests '*ValidatorMessagesTest*'`
Expected: PASS。**Task 6 必须同时补 repair 分组、missing、duplicate、逐轮收窄与序列化一致性的测试**（不能只复制 Task 2/3 的两例——那两例的断言已按 Task 3 修正为 rawIndex 平移）。

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
- Consumes: 页面内注入的测试专用观测 + 代理账本。
- Produces: 报告字段（单位见 spec D8）。

**关键限制（必须正视）**：现有探针只能读**已生成的卡片**（`[data-syntax-learning-block]` → open shadow root → `section.sentence`），拿不到扫描前的 inventory；inventory 排除项也不进协议（`page-inventory.ts:5-11`）。因此 `inventoryTotal` / `expectedAutomatic` **无法从卡片数推出**，必须新增测试专用观测。`generation` / 逻辑请求 ID / repair round 也无法只靠 HTTP 调用次序可靠推出。

- [ ] **Step 1: 注入与生产同源的 inventory 观测**

在 `page.goto` 之后、点「开始学习」之前，用 `page.addInitScript` 或 `page.evaluate` 在页面上下文里动态 `import` 生产模块并记录分母：

```js
// 与生产同源的 inventory 枚举;只在验收脚本里跑,不进扩展产物。
const inventory = await page.evaluate(async () => {
  const { inventoryReadableUnits } = await import(
    "http://127.0.0.1:PORT/src/content/page-inventory.ts"
  );
  const units = inventoryReadableUnits(document);
  return {
    inventoryTotal: units.length,
    expectedAutomatic: units.filter((unit) => unit.automatic).length,
    excludedByReason: units.reduce((acc, unit) => {
      if (unit.exclusionReason !== undefined) acc[unit.exclusionReason] = (acc[unit.exclusionReason] ?? 0) + 1;
      return acc;
    }, {}),
  };
});
```

（端口与路径按探针实际使用的本地静态服务填写；若无法在页面里 import TS 模块，改用构建产物 `content-script.js` 里同名导出的等价入口，并在报告里注明来源。）

- [ ] **Step 2: 采集 scannerDiscovered 与逐句终态**

- `scannerDiscovered`：`inventory` 里 automatic 单元数中被实际替换（页面出现对应卡片）的个数——用块文本指纹与 inventory 单元文本配对，不依赖 `getBlockId`（`data-syntax-learning-block` 是**空属性**，不含 id）。
- 逐句终态：监听页面上 `syntax-*` 事件与状态胶囊不足以逐句判定，改为**记录 SW 端口与消息**（探针已在用代理，扩展这条通道）或在每轮结束后读取卡片里的 `section.sentence[data-sentence-id]` 与失败节点，并在报告里显式标注这是 DOM 观测、与 `ready` 相位不等价。
- `modelRequested`：代理账本按 requestId 去重后的逻辑请求数（一个逻辑请求可能含多句、并可能重试）。

- [ ] **Step 3: 完整输出与关联键**

`output: streamedContent(call).slice(0, 4_000)` 改为完整输出；每条 call 增 `requestId` / `round` / `generation`；`cards` 增 `blockTextFingerprint`。

- [ ] **Step 4: 报告头写清单位与来源**

写明三类计量单位（语义单元数 / 逻辑请求数 / 句数）、块级「部分 ready + 部分 failed」的聚合规则、以及每个字段的采集来源（生产模块枚举 / DOM 观测 / 代理账本），并显式记录**未终态**（收尾超时被吞掉的块）而不是静默丢弃。

- [ ] **Step 5: 运行验证**

Run: `source ~/.secrets && UPSTREAM=https://api.deepseek.com UPSTREAM_KEY="$DEEPSEEK_API_KEY" node .superpowers/acceptance/probe-arxiv-live.mjs --blocks=8`
Expected: 报告含上述字段与来源说明；`output` 长度不再恒为 4 000；`inventoryTotal ≥ expectedAutomatic ≥ scannerDiscovered`。

- [ ] **Step 6: 提交**

不提交（`.superpowers/` 已 gitignore）。

---

### Task 6b: P0 的离线差分与真实配对（评审要求的验证层）

**Files:**
- Create: `.superpowers/acceptance/diff-repair-coordinates.mjs`（gitignored）
- Create: `.superpowers/acceptance/p0-repair-pairing.mjs`（gitignored）

**Interfaces:**
- Consumes: 现有真机报告里的 repair prompt（完整输出，Task 7 之前的报告用其 `prompt` 字段）。
- Produces: 差分报告与配对报告（gitignored）。

**为什么单独成任务**：Task 16 Step 3 是全页运行，它回答「还剩多少失败」，**不能证明「坐标修复本身是否改变了接受集合」**，也不能证明「修复通道改善了多少」。这两件事必须在 P0 内部先测。

- [ ] **Step 1: 离线确定性差分**

从现有报告的 `modelCalls[].prompt` 提取每轮的 `Original sentence IDs and Tokens`、`Validation errors`、`Invalid JSON`；对新旧 validator 各跑一遍，比较：接受/拒绝结果、成功 components、错误 message 集合。**唯一允许的差异是错误路径索引**——若出现其它差异，说明坐标改动改变了语义，必须回退修正。

```bash
cd chrome-plugin && node ../.superpowers/acceptance/diff-repair-coordinates.mjs \
  --report ../.superpowers/acceptance/arxiv-live-flash-20260912.json
```

Expected: 报告里 `acceptanceDiffs = 0`、`componentDiffs = 0`、`messageDiffs = 0`，`pathDiffs > 0`（证明确实在改坐标）。

- [ ] **Step 2: P0-only 真实配对（固定初始非法输出）**

固定同一份初始非法输出（从报告里挑一个多句 + 含纯标点成分的样本），用旧/新 repair 通道分别调用真模型，比较「修好句数 / 消耗轮数」。**不要同时改 MathML 与标注教学**（本轮只验坐标）。

```bash
source ~/.secrets && UPSTREAM=https://api.deepseek.com UPSTREAM_KEY="$DEEPSEEK_API_KEY" \
  node .superpowers/acceptance/p0-repair-pairing.mjs --cases=4
```

对照组必须包含：多句拼装、含纯标点成分、二者组合、以及单句无错位（阴性对照，用于确认改动没有副作用）。

Expected: 坐标修复组在多句与标点错位样本上「消耗轮数不增、修好句数不减」；阴性对照两组一致。

- [ ] **Step 3: 提交**

不提交（`.superpowers/` 已 gitignore）。结论写入 Task 16 的报告。

---

---

## P1 批次：页面表示与标注口径

### Task 8: corpus v2 冻结与 baseline

**Files:**
- Modify: `shared-fixtures/visible-page-core-evaluation-corpus.json`
- Modify: `.superpowers/acceptance/run-core-gold-evaluation.mjs`（gitignored，补 `--corpus`）
- Test: `chrome-plugin/scripts/core-evaluation.test.mjs`

**Interfaces:**
- Consumes: `validateCoreEvaluationCorpusV1`、`loadEvaluationCorpus`（后者已存在但**未被 runner 使用**）。
- Produces: corpus `version` 升为 `2`；边界 `79..115` / `152..213`；runner 支持 `--corpus <path>`。

**先决问题（实测）**：`run-core-gold-evaluation.mjs:26` 把 `fixturePath` **写死**为 `shared-fixtures/core-evaluation-traces.json`，全文没有 `args.get("corpus")`——而 `docs/architecture/build-test-release.md:136` 的示例却写了 `--corpus`。也就是说文档描述的 `--corpus` **尚未实现**（`loadEvaluationCorpus` 只在 `core-evaluation-runner.mjs:25` 定义、被单测消费）。所以本任务的 baseline 命令**在当前代码上跑不通**，必须先补这个开关。

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

- [ ] **Step 4b: 给 runner 补 `--corpus`（先决）**

在 `run-core-gold-evaluation.mjs` 里把 `fixturePath` 改为可覆盖：

```js
const fixturePath = args.get("corpus")
  ? resolve(args.get("corpus"))
  : resolve(repositoryRoot, "shared-fixtures/core-evaluation-traces.json");
```

注意 `argumentsMap` 只认 `--key value` 形式（**不认 `--key=value`**），所以命令里必须用空格分隔。改完后确认文档示例（`build-test-release.md:136`）与实际一致——它本来就写了 `--corpus <path>`。

- [ ] **Step 5: 跑 baseline（不进 CI，逐次显式路径）**

`{1,2,3}` 是 shell 花括号展开、不是 runner 的循环，且每次必须给**不同的 candidate 路径**。三次分别跑：

```bash
source ~/.secrets
for n in 1 2 3; do
  CORE_EVAL_MODEL=deepseek-flash \
  node .superpowers/acceptance/run-core-gold-evaluation.mjs \
    --mode pipeline \
    --corpus shared-fixtures/visible-page-core-evaluation-corpus.json \
    --candidate ".superpowers/acceptance/core-eval-v2-baseline-run${n}.json"
done
```

Expected: 三份 artifact 各自通过 `validateCoreEvaluationArtifactV1`；报告里 `corpus` 哈希对应当前 v2 fixture。**基线在 v2 冻结之后、任何行为改动之前跑**，否则不可比。

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

**同时必须改的既有用例**（不只上面那一条，否则整文件不会全绿）：
- `readable-dom-text.test.ts:73-79`「annotation 与 aria-hidden 辅助文本不与可见公式重复」——它靠 `alttext="H0"` 拿到 `H0`；改后可见树只有 `H`，期望值要按可见文本重算。
- `readable-dom-text.test.ts:82-90`「display math 记为 display-math」——同样依赖 `alttext="H0"`。
- `readable-dom-text.test.ts:99-105`「以 math 为根时同样只产出单一表示」——`alttext="H0"` 要换成可见文本。

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
- Consumes: Task 11 的 token 文本变化；Task 4 已先升过 core 版本。
- Produces: `DETAIL_PROMPT_VERSION = 8`；最终落在 `CORE_PROMPT_VERSION = 14`、`DETAIL_PROMPT_VERSION = 8`、`CORE_SCHEMA_VERSION = 3`。

**版本分两步（不能都压到最后）**：

- **Task 4 的提交内**：core repair prompt 的规则段与 errors 序列化形状已变 → 同时把 `CORE_PROMPT_VERSION` 升到 `14`（含 `versions.ts` / `Domain.kt` / `contracts.json` / parity 重生成）。`DETAIL_PROMPT_VERSION` 不动（detail 路径未受影响）。
- **本任务**：`<math>` 的 token 文本变化同时影响 core span 与 detail focus → `DETAIL_PROMPT_VERSION 7 → 8`。

理由：每个可独立验收的行为提交必须携带自己的缓存版本，否则中间提交会出现「行为已变、缓存键仍旧」的窗口（缓存键含版本号；AGENTS.md 要求改提示词必升版本）。**若 P0 作为独立发布单元，`13→14` 必须落在该单元内，不能等 Task 12。**

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

**注意**：`page-inventory.test.ts` **没有** `elementFrom`（它用的是 `document.body.innerHTML = markup`，见该文件 `:179`）。按该文件既有风格构造，不要跨文件引用 `readable-dom-text.test.ts` 的私有 helper。

```ts
it("整块由邮箱与转换残留构成时按 reference-metadata 排除", () => {
  document.body.innerHTML =
    "<article><p>show]Rachel.Gray@glasgow.ac.uk ]Daniel.Williams@glasgow.ac.uk</p>" +
    "<p>Contact us at author@example.org for details.</p></article>";
  const units = inventoryReadableUnits(document);
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

lint 在既有基线错误上**会非零退出**，`&&` 链会在这里断掉，所以分开跑：

```bash
cd chrome-plugin
npm test
npx playwright test
npm run lint; echo "lint exit=$?"   # 显式核对输出恰好 1 个既有错误,不看退出码
npm run format:check
npm run build
```

Expected: 测试、format、build 全部通过；lint 输出**恰好**只报 `src/options/options.test.ts` 的 `no-unnecessary-type-assertion`，无新增。

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

对照指标（基线见 spec §1）。**口径按 spec §5 的三项分开报告，不写成「反斜杠为零」**：

1. **由 MathML `alttext` 引入的 TeX 泄漏**：79 → 目标 0（不是「含反斜杠的成分」——合法文本也可能含反斜杠）；
2. `expectedAutomatic` 的发现率与请求率、失败块比例（基线 37 = 20.1%，是**效果目标**不是硬门）、未终态比例；
3. 引用号独立成分数、图注/章节标题失败数、静默错标审计的两轴结果。

不足时逐句给出原因分类（输入损坏 / 网络与截断 / 协议结构错误 / validator 误拒 / 真实标注或译文错误 / 未裁决）。

- [ ] **Step 4: 两套 corpus 三次配对**

corpus 用空格分隔的 `--corpus`（`argumentsMap` 不认 `--key=value`），三次各给独立 candidate；40 句与页面两套分别跑：

```bash
source ~/.secrets
for n in 1 2 3; do
  CORE_EVAL_MODEL=deepseek-flash node .superpowers/acceptance/run-core-gold-evaluation.mjs \
    --mode pipeline \
    --baseline ".superpowers/acceptance/core-eval-v2-baseline-run${n}.json" \
    --candidate ".superpowers/acceptance/core-eval-v2-candidate-run${n}.json"
  CORE_EVAL_MODEL=deepseek-flash node .superpowers/acceptance/run-core-gold-evaluation.mjs \
    --mode pipeline \
    --corpus shared-fixtures/visible-page-core-evaluation-corpus.json \
    --candidate ".superpowers/acceptance/core-eval-v2-page-candidate-run${n}.json"
done
```

Expected: `correctToWrongOrFailure = 0`；页面 corpus 与 Task 8 的 v2 baseline 配对比较；两套 corpus 的总分**不可直接比较**。

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

**Spec 覆盖核对（诚实版——标注仍不闭合的部分）**

| spec 项 | 任务 | 状态 |
| --- | --- | --- |
| D1a 句身份四类路径 | Task 4（TS）、Task 6（Kotlin） | 覆盖；句对象级错误的序列化形状在 Task 4 只给了 invalid 的 `path: "sentenceId"` 一例，**多重复实例的并发非法**已补测试 |
| D1b 四阶段坐标 + 语义不变量 | Task 1–3 | 覆盖；迁移清单逐处列出（含后继门、单成分门、role 类聚、coverage、返回值解包） |
| D1c 逐轮收窄 | Task 5 | 覆盖；断言改为解析 `Validation errors:` 段 |
| D1b 附带的文案漂移 | Task 14 | 覆盖 |
| D2 公式文本九项决定 | Task 11 | 覆盖；含三处既有用例的连带修改 |
| D3 邮箱排除 | Task 13 | 覆盖 |
| D4 引用附着（不进硬门） | Task 10 | 覆盖 |
| D5 编号绑定主体 | Task 10 | 覆盖；**Kotlin prompt 规则同步未见任务**——见下方遗留 |
| D6 版本（分两步 13→14、7→8） | Task 4 内 + Task 12 | 覆盖 |
| D7 corpus v2 + baseline | Task 8 | 覆盖；含补 runner 的 `--corpus`；**arXiv 三句原文重核仍在 Task 8 未展开**——见下方遗留 |
| D8 记录口径（P0 同批） | Task 7 | 覆盖；已补 inventory 观测来源与单位契约 |
| D9 静默错标审计 | Task 9、Task 10 | 部分：审计器与两轴有；**待审项裁决后升 oracle 版本并重评双方**未写成步骤——见下方遗留 |
| 文档同步 | Task 15 | 覆盖；P0 的模块地图/版本变更应随对应提交，Task 15 只做最终审阅 |
| 验收标准 1–8 | Task 16 + Task 5/7/9/10 | 标准 1（差分与 P0-only 真实配对）在 Task 16 Step 3 之前补；标准 6 主要在 Task 10 |

**本计划已知遗留（执行时需补，不要当成已完成）**

1. ~~P0-only 的离线差分与真实配对~~ → 已补为 **Task 6b**。
2. **Kotlin 的 prompt 规则同步**（D4/D5 两条口径）：Task 10 只写了 TS 侧，执行时必须在同一任务内改 `intellij-plugin/.../model/Prompts.kt` 并重生成 parity（`core-prompt-parity.json` 只由 TS 生成、Kotlin 只消费）。
3. **arXiv 三句的原文/可见文本重核**：Task 8 只提了一句，执行时按 `Figure 2:` 前缀与 `(solid line)` 的原文重核 `arxiv-figure-caption`，并对 `arxiv-dark-siren-title` / `arxiv-table-definition` 按**可见文本**（含 MathML 变化后的表示）复核；重核后若 span 变化，必须重跑 Task 8 的 baseline。
4. **D9 裁决后升 oracle/corpus 版本并重评双方**：Task 10 把待审项裁决后，须升 `oracleVersion` 并对 baseline 与 candidate 各重评一次（同版本才可比）；这一步未写成独立步骤。
5. **Task 8 的 baseline 依赖先补 runner `--corpus`**（当前代码与前文文档不一致，Task 8 Step 4b 已给改法）。

**类型一致性**：`InvalidCoreSentence` 保留在 `analysis-service.ts`（Task 4 只在 `repair-errors.ts` 内重复声明其形状并导出 `RepairErrorGroup`——**执行时选一种，避免同名两处**）；`RepairErrorGroup` 的 `kind` 在 TS 与 Kotlin 均为 `invalid|missing|duplicate`；`buildRepairPrompt` 第二参数在 Task 4 与 Task 6 都是分组数组（Kotlin 为 `List<RepairErrorGroup>`，且需为 public 或改传 `JsonElement`）。

**已知取舍**：Task 7 的探针改动在 gitignored 目录，不产生提交；Task 8 的 baseline 与 Task 16 的 candidate 都不进 CI（遵守「CI 不联网」）。
