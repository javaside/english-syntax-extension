# FRAGMENT_HEAD 无谓语片段支持 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Chrome 与 IntelliJ 双端稳定地把技术文档中的无谓语标题/列表项分析为 `FRAGMENT_HEAD` 加真实修饰成分，而不虚构主谓宾。

**Architecture:** 保持现有平铺 CoreAnalysis 协议，只扩充一个角色并在 core/repair 共用规则中先判分句完整性。双端 validator 只执行可由角色序列确定的数量与互斥硬门；prompt、共享契约、黄金集和版本共同约束模型选择该角色。

**Tech Stack:** TypeScript/Vitest/Vite、Kotlin/JUnit5/Gradle IntelliJ Platform、共享 JSON fixtures。

**Spec:** `docs/superpowers/specs/2026-09-02-fragment-head-design.md`

## Global Constraints

- 英文句法边界优先；中文 `translation` 只作当前 span 的辅助释义，不新增句级翻译。
- core 层继续平铺、短语级、互不重叠，不引入嵌套树。
- 新角色固定为 `FRAGMENT_HEAD`，中文标签固定为 `片段主体`。
- `FRAGMENT_HEAD` 只用于不构成分句的标题、列表项或短语；祈使句仍以 `PREDICATE` 分析。
- TS/Kotlin prompt 与 validator 错误文案逐字一致。
- `CORE_PROMPT_VERSION` 从 `10` 升至 `11`；`CORE_SCHEMA_VERSION=3` 与 `DETAIL_PROMPT_VERSION=5` 不变。
- Chrome lint 基线保持恰好 1 个既有错误、0 个警告。

---

### Task 1: 双端领域角色与渲染标签

**Files:**
- Modify: `chrome-plugin/src/shared/grammar.ts`
- Modify: `chrome-plugin/src/shared/grammar.test.ts`
- Modify: `chrome-plugin/src/content/learning-block.ts`
- Modify: `chrome-plugin/src/content/learning-block.test.ts`
- Modify: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/domain/Domain.kt`
- Modify: `intellij-plugin/src/main/resources/web/roles.ts`
- Modify: `intellij-plugin/src/main/resources/web/roles.test.ts`
- Modify: `shared-fixtures/contracts.json`

**Interfaces:**
- Produces: `GrammarRole.FRAGMENT_HEAD` / `GrammarRole.FRAGMENT_HEAD` and label `片段主体` for prompt, validator, schema and both renderers.
- Keeps: existing `CoreComponent` JSON shape unchanged.

- [ ] **Step 1: Write failing role and renderer tests**

Add assertions:

```ts
expect(GRAMMAR_LABELS[GrammarRole.FRAGMENT_HEAD]).toBe("片段主体");
```

In Chrome `learning-block.test.ts`, render a component with `role: GrammarRole.FRAGMENT_HEAD` and assert the visible `.role` text is `片段主体`. In IntelliJ `roles.test.ts`, assert `roleLabel("FRAGMENT_HEAD") === "片段主体"` and that `roleColor("FRAGMENT_HEAD")` returns the chosen subject-family blue in light/dark palettes.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
cd chrome-plugin && npx vitest run src/shared/grammar.test.ts src/content/learning-block.test.ts
cd intellij-plugin && npx vitest run src/main/resources/web/roles.test.ts
```

Expected: TypeScript/expectation failure because `FRAGMENT_HEAD` is absent.

- [ ] **Step 3: Add the role and labels minimally**

Add `FRAGMENT_HEAD = "FRAGMENT_HEAD"` beside phrase-level roles in TS, `FRAGMENT_HEAD` in Kotlin, and `片段主体` in all label maps. Add a dedicated blue/teal role color in Chrome `ROLE_COLORS` and IntelliJ light/dark palettes; do not reuse neutral `INDEPENDENT_ELEMENT`, because the fragment head is structural.

Update `shared-fixtures/contracts.json` with:

```json
{"role":"FRAGMENT_HEAD","label":"片段主体"}
```

at the same enum position used by both runtimes.

- [ ] **Step 4: Re-run focused tests and contract test**

Run:

```bash
cd chrome-plugin && npx vitest run src/shared/grammar.test.ts src/content/learning-block.test.ts src/shared/cross-platform-contract.test.ts
cd intellij-plugin && npx vitest run src/main/resources/web/roles.test.ts
```

Expected: role/render tests pass; cross-platform contract passes after fixture synchronization.

- [ ] **Step 5: Commit**

```bash
git add chrome-plugin/src/shared/grammar.ts chrome-plugin/src/shared/grammar.test.ts \
  chrome-plugin/src/content/learning-block.ts chrome-plugin/src/content/learning-block.test.ts \
  intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/domain/Domain.kt \
  intellij-plugin/src/main/resources/web/roles.ts intellij-plugin/src/main/resources/web/roles.test.ts \
  shared-fixtures/contracts.json
git commit -m "feat: 增加无谓语片段主体角色"
```

### Task 2: 双端 fragment validator 硬门

**Files:**
- Modify: `chrome-plugin/src/language/analysis-validator.test.ts`
- Modify: `chrome-plugin/src/language/analysis-validator.ts`
- Modify: `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/language/AnalysisValidatorTest.kt`
- Modify: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/language/AnalysisValidator.kt`

**Interfaces:**
- Consumes: `GrammarRole.FRAGMENT_HEAD` from Task 1.
- Produces: identical grammar errors from `validateCoreBatch` on both runtimes.

- [ ] **Step 1: Add failing TS validator tests**

Use the exact target fragment and tokenized ranges:

```ts
const sentence = sentenceOf(
  "Portable API support across AI providers for Chat, text-to-image, and Embedding models.",
);
const valid = [
  { startToken: 0, endToken: 2, role: "FRAGMENT_HEAD", translation: "可移植 API 支持" },
  { startToken: 3, endToken: 5, role: "ATTRIBUTE", translation: "跨 AI 提供商" },
  { startToken: 6, endToken: 14, role: "ATTRIBUTE", translation: "面向聊天、文生图和嵌入模型" },
];
```

Assert it passes. Add tests that reject two fragment heads with:

```text
a non-clausal fragment must contain at most one FRAGMENT_HEAD
```

and table-test every forbidden role (`SUBJECT`, `PREDICATE`, `OBJECT`, `PREDICATIVE`, `COMPLEMENT`, five clause roles, `COORDINATE_CLAUSE`) with:

```text
FRAGMENT_HEAD marks a non-clausal fragment and must not be mixed with clause-level SUBJECT, PREDICATE, OBJECT, PREDICATIVE, COMPLEMENT, or clause roles
```

Change the existing `Detailed usage instructions.` valid fixture from `SUBJECT` to `FRAGMENT_HEAD`. Keep the existing imperative acceptance test unchanged.

- [ ] **Step 2: Run TS validator test and verify RED**

Run:

```bash
cd chrome-plugin && npx vitest run src/language/analysis-validator.test.ts
```

Expected: valid role parsing may pass after Task 1, but duplicate/mixed-role cases incorrectly pass.

- [ ] **Step 3: Implement minimal TS constraints**

Add a `FRAGMENT_CLAUSE_ROLES` set containing the exact forbidden roles. At the end of `collectGrammarErrors`:

```ts
const fragmentHeads = components.filter((component) => component.role === GrammarRole.FRAGMENT_HEAD);
if (fragmentHeads.length > 1) { /* add exact count error at `${path}.components` */ }
if (fragmentHeads.length > 0 && components.some((component) => FRAGMENT_CLAUSE_ROLES.has(component.role))) {
  /* add exact mixed-role error at `${path}.components` */
}
```

Do not add lexical verb guessing.

- [ ] **Step 4: Run TS validator test and verify GREEN**

Run the same focused Vitest command. Expected: PASS.

- [ ] **Step 5: Port tests and implementation to Kotlin**

Mirror the same valid fragment, duplicate-head test, forbidden-role parameterized test, short fragment update, role set and two exact errors in Kotlin. Use `TokenRange`/JSON fixtures following existing `AnalysisValidatorTest` helpers.

- [ ] **Step 6: Run Kotlin validator tests and compare messages**

Run:

```bash
./gradlew :intellij-plugin:test --tests '*AnalysisValidatorTest'
```

Expected: PASS. Search both production files for the two exact messages and verify byte-for-byte equality.

- [ ] **Step 7: Commit**

```bash
git add chrome-plugin/src/language/analysis-validator.ts \
  chrome-plugin/src/language/analysis-validator.test.ts \
  intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/language/AnalysisValidator.kt \
  intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/language/AnalysisValidatorTest.kt
git commit -m "feat: 校验无谓语片段角色边界"
```

### Task 3: 双端 completeness-first prompt 与缓存版本

**Files:**
- Modify: `chrome-plugin/src/background/prompts.test.ts`
- Modify: `chrome-plugin/src/background/prompts.ts`
- Modify: `chrome-plugin/src/shared/versions.ts`
- Modify: `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/model/PromptsTest.kt`
- Modify: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/model/Prompts.kt`
- Modify: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/domain/Domain.kt`
- Modify: `shared-fixtures/contracts.json`
- Modify: `shared-fixtures/core-prompt-parity.json`

**Interfaces:**
- Consumes: 17-role enum including `FRAGMENT_HEAD`; validator messages from Task 2.
- Produces: byte-identical TS/Kotlin core prompt and `CORE_PROMPT_VERSION=11`.

- [ ] **Step 1: Add failing TS prompt assertions**

Add a test that both `buildCorePrompt` and `buildRepairPrompt` contain, in order before `Clause-structure-first rule:`:

```text
Completeness-first rule:
FRAGMENT_HEAD
Portable API support
across AI providers
for Chat, text-to-image, and Embedding models
An imperative is a clause, not a fragment
"Install the CLI" is PREDICATE "Install" plus OBJECT "the CLI"
```

Also assert:

```ts
expect(prompt).toContain("The role field is a closed 17-role enum:");
```

and that local component translations remain glosses without any sentence-level translation field instruction.

- [ ] **Step 2: Run TS prompt tests and verify RED**

Run:

```bash
cd chrome-plugin && npx vitest run src/background/prompts.test.ts
```

Expected: completeness rule and 17-role assertion fail.

- [ ] **Step 3: Implement the shared prompt rule in TS**

Create `COMPLETENESS_FIRST_RULE` immediately before `CLAUSE_FIRST_RULE`, with these semantics in one stable string:

```text
Completeness-first rule: before assigning clause roles, decide whether the input forms a clause. An input with an explicit finite predicate, or an imperative with an omitted subject, is a clause and uses the existing clause-level roles. A heading, list item, noun phrase, adjective phrase, or non-finite verb phrase that does not form a clause must contain exactly one FRAGMENT_HEAD; never invent SUBJECT, PREDICATE, OBJECT, PREDICATIVE, or ADVERBIAL merely to force a fragment into a clause pattern. Keep ordinary determiners and tightly bound single-word premodifiers with the FRAGMENT_HEAD, and emit separable postmodifying prepositional, participial, or infinitive phrases as ATTRIBUTE. "Portable API support across AI providers for Chat, text-to-image, and Embedding models" is FRAGMENT_HEAD "Portable API support" plus ATTRIBUTE "across AI providers" plus ATTRIBUTE "for Chat, text-to-image, and Embedding models". An imperative is a clause, not a fragment: "Install the CLI" is PREDICATE "Install" plus OBJECT "the CLI".
```

Insert it before `CLAUSE_FIRST_RULE` in `CORE_ANALYSIS_RULES`. Keep translation instruction unchanged.

- [ ] **Step 4: Port the exact prompt string and tests to Kotlin**

Add the same constant and list position to `Prompts.kt`; update `PromptsTest.kt` to assert the completeness rule appears in core and repair prompts before clause-first. Preserve byte identity including punctuation and spaces.

- [ ] **Step 5: Raise versions and regenerate parity fixtures**

Set TS `CORE_PROMPT_VERSION = 11`, Kotlin `ContractVersions.CORE_PROMPT = 11`, and fixture `corePromptVersion/corePromptVersion` fields to 11.

Generate `shared-fixtures/core-prompt-parity.json` from the actual TS `buildCorePrompt` output using the repository’s existing parity fixture sentence and compact JSON format; do not hand-edit the prompt body. If no generator script exists, use the same fixture sentence from `cross-platform-contract.test.ts` in a one-off Node command importing the built/test module, then write the JSON through the repository’s formatter.

- [ ] **Step 6: Run prompt and contract parity tests**

Run:

```bash
cd chrome-plugin && npx vitest run src/background/prompts.test.ts src/shared/cross-platform-contract.test.ts
./gradlew :intellij-plugin:test --tests '*PromptsTest'
```

Expected: all pass, proving both prompt copies match the shared fixture.

- [ ] **Step 7: Commit**

```bash
git add chrome-plugin/src/background/prompts.ts chrome-plugin/src/background/prompts.test.ts \
  chrome-plugin/src/shared/versions.ts \
  intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/model/Prompts.kt \
  intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/model/PromptsTest.kt \
  intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/domain/Domain.kt \
  shared-fixtures/contracts.json shared-fixtures/core-prompt-parity.json
git commit -m "feat: 优先识别无谓语片段结构"
```

### Task 4: 人工黄金标注与评分契约

**Files:**
- Modify: `chrome-plugin/tests/fixtures/core-gold-annotations.json`
- Modify: `chrome-plugin/src/language/core-gold-annotations.test.ts`
- Modify: `chrome-plugin/scripts/core-evaluation.test.mjs`

**Interfaces:**
- Consumes: `FRAGMENT_HEAD` role and production validator.
- Produces: human-reviewed fragment conventions and regression examples.

- [ ] **Step 1: Add failing convention and exact-role tests**

In `core-gold-annotations.test.ts`, assert conventions mention that non-clausal fragments use exactly one `FRAGMENT_HEAD`, never fake `SUBJECT/PREDICATE/OBJECT`, and that imperative clauses remain `PREDICATE`-led.

Add exact fixture assertions by ID for:

```text
fragment-portable-api
fragment-support-apis
fragment-compatible-providers
fragment-building-apps
fragment-imperative-counterexample
```

The first must be exactly `[FRAGMENT_HEAD 0..2, ATTRIBUTE 3..5, ATTRIBUTE 6..14]`; the imperative must start with `PREDICATE` and contain no `FRAGMENT_HEAD`.

Add a scorer unit case whose gold and prediction both contain `FRAGMENT_HEAD`, and assert exact/labeled-span metrics count it normally.

- [ ] **Step 2: Run gold/scorer tests and verify RED**

Run:

```bash
cd chrome-plugin && npx vitest run src/language/core-gold-annotations.test.ts scripts/core-evaluation.test.mjs
```

Expected: missing fixture IDs/convention assertions fail.

- [ ] **Step 3: Add human-reviewed fixture entries**

Tokenize each exact sentence with production `tokenize()` and store hand-reviewed spans:

- target noun fragment: `FRAGMENT_HEAD + ATTRIBUTE + ATTRIBUTE`;
- `Support for synchronous and streaming APIs.`: `FRAGMENT_HEAD "Support" + ATTRIBUTE "for ... APIs"`;
- `Compatible with all major model providers.`: one `FRAGMENT_HEAD` if no separable peer modifier exists (short fragment exception remains valid);
- `Building production-ready AI applications at scale.`: `FRAGMENT_HEAD "Building production-ready AI applications" + ATTRIBUTE "at scale"` only if `at scale` modifies the nominal activity; document this chosen flat-core convention;
- `Install the CLI.`: `PREDICATE "Install" + OBJECT "the CLI"`.

Add concise Chinese translations only where this fixture section already stores translations; translations must cover their own spans and must not affect boundaries.

- [ ] **Step 4: Run gold, validator and scorer tests**

Run the same command plus:

```bash
cd chrome-plugin && npx vitest run src/language/analysis-validator.test.ts
```

Expected: all new entries pass production validator and scoring tests.

- [ ] **Step 5: Commit**

```bash
git add chrome-plugin/tests/fixtures/core-gold-annotations.json \
  chrome-plugin/src/language/core-gold-annotations.test.ts \
  chrome-plugin/scripts/core-evaluation.test.mjs
git commit -m "test: 增加无谓语片段黄金标注"
```

### Task 5: 架构文档与项目不变量同步

**Files:**
- Modify: `AGENTS.md`
- Modify: `docs/architecture/protocol.md`
- Modify: `docs/architecture/model-pipeline.md`
- Modify: `docs/architecture/rendering.md`
- Modify: `docs/architecture/invariants.md`

**Interfaces:**
- Consumes: final role, prompt, validator and version behavior from Tasks 1–4.
- Produces: operator-facing source of truth aligned with architecture-doc tests.

- [ ] **Step 1: Run architecture/docs drift checks to observe required updates**

Run:

```bash
cd chrome-plugin && npx vitest run src/shared/architecture-docs.test.ts
npm run docs:drift
```

Expected: architecture test reports missing `FRAGMENT_HEAD`/`片段主体` until docs are updated; drift points to protocol/model/rendering/invariants.

- [ ] **Step 2: Update protocol and model-pipeline docs**

Document the 17th role and label, `CORE_PROMPT_VERSION=11`, completeness-first decision order, exact target example, imperative counterexample, cache invalidation, and the two validator errors. State explicitly that translation is a local gloss and not a sentence-level output.

- [ ] **Step 3: Update rendering and invariant docs**

Document `片段主体` as a structural core card with its own role color. Add an invariant with rule/why/symptom/guard tests: non-clausal technical-document fragments must not be forced into clause roles; exactly one `FRAGMENT_HEAD`, no clause-level role mixing; prompt/gold/validator tests guard it.

- [ ] **Step 4: Update AGENTS.md concise authority**

Extend the “one role criterion” paragraph with the fragment convention and extend the validator hard-gate summary with the two new checks. Update the hard-gate count from twelve to fourteen if the authoritative text still states twelve.

- [ ] **Step 5: Run docs checks**

Run:

```bash
cd chrome-plugin && npx vitest run src/shared/architecture-docs.test.ts
npm run docs:drift
```

Expected: architecture test passes; docs drift reports relevant docs touched.

- [ ] **Step 6: Commit**

```bash
git add AGENTS.md docs/architecture/protocol.md docs/architecture/model-pipeline.md \
  docs/architecture/rendering.md docs/architecture/invariants.md
git commit -m "docs: 记录无谓语片段句法口径"
```

### Task 6: 双端完整验证与回归审查

**Files:**
- Modify only if verification exposes a defect in files already covered by Tasks 1–5.

**Interfaces:**
- Consumes: complete implementation.
- Produces: evidence that all project gates pass without changing the lint baseline.

- [ ] **Step 1: Run Chrome unit and contract tests**

```bash
cd chrome-plugin && npm test
```

Expected: all tests pass, including full gold fixture validation and architecture docs.

- [ ] **Step 2: Run Chrome E2E, lint baseline, format, docs drift and build**

```bash
cd chrome-plugin && npx playwright test && npm run lint && npm run format:check && npm run docs:drift && npm run build
```

Expected: Playwright/build/format pass; lint reports exactly the one existing `src/options/options.test.ts` `no-unnecessary-type-assertion` error and no warnings/new errors. If the repository uses `lint:baseline` for the exact baseline assertion, run it in addition to `npm run lint`.

- [ ] **Step 3: Run IntelliJ web and Kotlin gates**

```bash
(cd intellij-plugin && npm ci && npm test) && \
./gradlew :intellij-plugin:test :intellij-plugin:buildPlugin :intellij-plugin:verifyPluginProjectConfiguration
```

Expected: all pass and plugin zip builds.

- [ ] **Step 4: Inspect final diff and invariants**

Run:

```bash
git diff --check
git status --short
git diff HEAD~5 --stat
```

Confirm no sentence-level translation field, no tokenizer/detail version change, exact TS/Kotlin validator messages, exact prompt parity, and no unrelated files.

- [ ] **Step 5: Commit any verification-only fixes separately**

If and only if verification required a code/doc correction:

```bash
git add <only corrected files>
git commit -m "fix: 修正片段句法支持回归"
```

Do not create an empty commit.
