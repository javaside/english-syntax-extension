# 可见英文页面级句法覆盖实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Chrome 扩展与 IntelliJ Markdown 预览对安全、可读的英文标题、正文、列表、定义、表格、图注、脚注和参考文献题名建立可审计覆盖，并保证最终句法成分具有中文局部释义。

**Architecture:** 先冻结页面 fixture、页面目标 corpus 和旧行为 baseline，再修改生产行为。Chrome 增加科学 DOM 文本归一化与页面 semantic inventory，scanner 只投影 `automatic=true` 的最小安全单元；TypeScript/Kotlin 同步 validator、黄金集、prompt、版本和缓存。IntelliJ 不适配 arXiv DOM，但单独验证 Markdown 短标题、定义、表格、图注和脚注。

**Tech Stack:** TypeScript、Vite、Vitest、happy-dom、Playwright、Chrome MV3、Kotlin、Gradle IntelliJ Platform、JCEF、Node.js ESM、JSON 共享 fixture。

**Spec:** `docs/superpowers/specs/2026-09-08-visible-english-page-coverage-design.md`

**Audit:** `docs/superpowers/audits/2026-09-08-spring-ai-grammar-review.md`

## Global Constraints

- Task 4 的两套 corpus 各三份 pipeline baseline 完成前，不得修改 prompt、TS/Kotlin validator、tokenizer、生产 analysis service 或分析版本。
- 最终版本唯一为 `CORE_SCHEMA_VERSION=3`、`CORE_PROMPT_VERSION=13`、`DETAIL_PROMPT_VERSION=7`；吸收旧计划未执行的 CORE 13、DETAIL 7、V14，不得升成 14/8。
- 不新增句级 translation、`OBLIQUE`、角色枚举、Chrome 消息或 JCEF bridge 字段。
- 最终自然语言 core component 的 translation 至少含一个 Unicode Han 字符；专名保留英文并补中文类型。纯符号与独立公式不进入 core。
- translation 质量错误是非结构错误，与 grammar errors 同轮返回，不阻断 grammar；repair 仍至多两轮。
- `FRAGMENT_HEAD + ATTRIBUTIVE_CLAUSE` 合法；fragment 与普通分句级角色、其余四类从句和 `COORDINATE_CLAUSE` 仍互斥；硬门仍是十五条。
- inventory 排除项仅供测试/验收，不进入 SW/JCEF 协议；不扩 `SessionStatus`。
- 显式手势不套 principal root 与自动最短长度门，英文占比与安全排除不变。
- 科学 DOM 只为 inline math 选择一个稳定表示；不解析 TeX、不翻译公式、不按 URL 分支。
- 自动单元必须有可整体隐藏并恢复的 HTMLElement；不引入 Range 替换器。
- prompt 句子走 `serializeSentences` / `serializeSentence`，其余 JSON 走 `serialize`；假服务器首行和 focus 标签保持兼容。
- 新黄金句必须人工核语言学正确性并有按 ID 的精确 span/role 断言；TS/Kotlin 都用生产 tokenizer/validator replay。
- prompt parity 期望只由 TS 生成，Kotlin 只消费。
- 真实 artifact、key、header、acceptance 脚本留在 gitignored `.superpowers/acceptance/`。
- 页面覆盖率与模型 F1 分开报告。
- Chrome lint 保持恰好一个既有 `options.test.ts` 错误，不修复也不新增。
- 每个任务 RED → 确认失败 → 最小 GREEN → 测试 → 中文提交。

## File Map

**新增：**

- `shared-fixtures/visible-page-core-evaluation-corpus.json`：页面目标真模型 corpus。
- `shared-fixtures/translation-quality.json`：双端 Han/echo case。
- `chrome-plugin/tests/fixtures/pages/{spring-ai-coverage,arxiv-paper-coverage}.html`：最小真实 DOM。
- `chrome-plugin/tests/fixtures/page-inventory/{spring-ai-coverage,arxiv-paper-coverage}.json`：完整 inventory 分母。
- `chrome-plugin/src/content/readable-dom-text.ts`：科学 DOM 文本提取。
- `chrome-plugin/src/content/page-inventory.ts`：分类、reason、门槛和去重。
- `chrome-plugin/tests/e2e/page-coverage.spec.ts`：页面覆盖 E2E。

**关键修改：**

- `chrome-plugin/scripts/core-evaluation*.mjs`：通用 corpus、配置可比性、三对汇总。
- `.superpowers/acceptance/run-core-gold-evaluation.mjs`：`--corpus` 和三对 manifest；不提交。
- Chrome `document-scanner.ts` / `session-controller.test.ts`：inventory 投影与链路证明。
- IntelliJ `web/preview.ts` / `preview.test.ts`：Markdown 语义块覆盖。
- 双端 `AnalysisValidator`、`Prompts`、`AnalysisService` 测试及共享 fixtures。
- 四处版本/契约：`versions.ts`、`Domain.kt`、`contracts.json`、`core-prompt-parity.json`。

**保持接口：**

```ts
export interface CandidateBlock {
  id: string;
  element: Element;
  text: string;
}
export function scanDocument(root: ParentNode): CandidateBlock[];
export function nearestSafeBlock(
  target: EventTarget | null,
): CandidateBlock | null;
```

---

### Task 1: 解耦通用评测 corpus 与固定 40 句矩阵

**Files:**

- Modify: `chrome-plugin/scripts/core-evaluation.mjs`
- Modify: `chrome-plugin/scripts/core-evaluation.test.mjs`

**Interfaces:**

- Produces: `validateCoreEvaluationCorpusV1(corpus)`。
- Preserves: `validateCoreEvaluationArtifactV1`、`scoreCoreEvaluationArtifacts`。

- [ ] **Step 1: 写 RED 测试**

构造两句 `page-target` 小 corpus，要求通用校验通过；增加 duplicate id、denominator 顺序、空 source/rationale、重叠边界拒绝。旧 fixture 测试继续精确断言 40 句、2 split × 5 category × 每格 4。

- [ ] **Step 2: 确认 RED**

```bash
cd chrome-plugin && npx vitest run scripts/core-evaluation.test.mjs
```

Expected: 新函数不存在或小 corpus 被旧矩阵拒绝。

- [ ] **Step 3: 实现 GREEN**

抽出 corpus 通用不变量：id/version、唯一句 ID、denominator 与句序全等、非空 split/category/source/rationale、合法有序字符边界。artifact validator 调此函数后继续严格校验 tokenizer、trace 一次覆盖、repair 收窄、hash/report。固定矩阵只留在旧 fixture 专属测试。

- [ ] **Step 4: 测试并提交**

```bash
cd chrome-plugin && npx vitest run scripts/core-evaluation.test.mjs
git add scripts/core-evaluation.mjs scripts/core-evaluation.test.mjs
git commit -m "评测语料校验解耦固定四十句矩阵"
```

---

### Task 2: 强制配对配置一致并汇总三次运行

**Files:**

- Modify: `chrome-plugin/scripts/core-evaluation.mjs`
- Modify: `chrome-plugin/scripts/core-evaluation.test.mjs`
- Modify: `chrome-plugin/scripts/core-evaluation-runner.mjs`
- Modify: `chrome-plugin/scripts/core-evaluation-runner.test.mjs`

**Interfaces:**

- Produces: `validateComparableCoreEvaluationArtifactsV1(baseline,candidate)`。
- Produces: `scoreCoreEvaluationArtifactPairs(pairs)`，恰好三对。
- Produces: `loadEvaluationCorpus(document)`。
- Extends: `requestChatCompletion` 返回 `{completion,compatibility:{removedFields,attemptCount}}`。

- [ ] **Step 1: 写 RED 测试**

`run.comparisonConfig` 固定 endpoint、model、pipeline mode、batchSize、temperature、reasoning requested/effective/fallback、response-format requested/effective/fallback、timeout strategy/value。逐项漂移必须拒绝；createdAt、commit、prompt/messages hash 可不同。非三对拒绝；三对输出 final exact、labeled-span F1、final failures 的 mean/min/max 与逐 pair transition IDs。runner 测试覆盖完整 artifact/corpus-only 装载和两字段依次降级且脱敏。

- [ ] **Step 2: 确认 RED**

```bash
cd chrome-plugin
npx vitest run scripts/core-evaluation.test.mjs scripts/core-evaluation-runner.test.mjs
```

- [ ] **Step 3: 实现 GREEN**

比较完整 corpus snapshot、sentenceOrder、comparisonConfig；正式配对只允许 pipeline。三对聚合复用单对评分。`requestChatCompletion` 记录实际 compatibility；effective 模式不同判不可比。URL 只复用 `parseRunnerBaseUrl`，不复制规则。

- [ ] **Step 4: 测试并提交**

```bash
cd chrome-plugin
npx vitest run scripts/core-evaluation.test.mjs scripts/core-evaluation-runner.test.mjs
git add scripts/core-evaluation*.mjs
git commit -m "评测配对强制运行配置一致"
```

---

### Task 3: 冻结页面目标 corpus 并扩展本地 runner

**Files:**

- Create: `shared-fixtures/visible-page-core-evaluation-corpus.json`
- Modify: `chrome-plugin/scripts/core-evaluation.test.mjs`
- Modify, never commit: `.superpowers/acceptance/run-core-gold-evaluation.mjs`
- Modify: `docs/architecture/build-test-release.md`

**Interfaces:**

- Corpus: `core-evaluation-corpus/v1`，id=`visible-english-pages-spring-ai-arxiv`，version=1。
- CLI: `--corpus <path>`；`--compare-manifest <path>`。

- [ ] **Step 1: 写 fixture RED 合同**

断言 denominator/句序、唯一 ID、source/rationale、字符半开边界，并按 ID 精确固定 arXiv 标题四段。

```bash
cd chrome-plugin && npx vitest run scripts/core-evaluation.test.mjs
```

Expected: fixture 不存在。

- [ ] **Step 2: 创建并人工复核 corpus**

覆盖 Spring 前导语/功能片段、fragment-relative/完整句反例、arXiv 标题/冒号完整分句反例、finite/non-finite when/before、VP/NP coordination、宾语控制、零关系词、动词/名词/嵌套 PP、图注、表格定义、inline H0、短标题。Token 不手写；边界按原文字符并人工核对。

- [ ] **Step 3: 双端 tokenizer 验证**

```bash
cd chrome-plugin
npx vitest run scripts/core-evaluation.test.mjs src/language/segmenter.test.ts
cd .. && ./gradlew :intellij-plugin:test --tests '*SegmenterTest*'
```

- [ ] **Step 4: 扩展本地 runner**

`--corpus` 调 `loadEvaluationCorpus`；`--compare-manifest` 离线调用三对评分；artifact 写 corpus snapshot、production tokenizer、trace/report、comparisonConfig/compatibility，不写 key/header。用 synthetic manifest 验证不联网，再用 fake/local provider 验证页面 artifact 可 `--validate-artifact`。

- [ ] **Step 5: 文档与提交**

```bash
git add shared-fixtures/visible-page-core-evaluation-corpus.json \
  chrome-plugin/scripts/core-evaluation.test.mjs docs/architecture/build-test-release.md
git commit -m "冻结页面目标句法评测语料"
```

不得提交 `.superpowers/acceptance/`。

---

### Task 4: 在旧行为上生成两套三次 baseline

**Files:**

- Generate, never commit: `.superpowers/acceptance/core40-baseline-run{1,2,3}.json`
- Generate, never commit: `.superpowers/acceptance/visible-page-baseline-run{1,2,3}.json`

**Gate:** 完成前禁止 Task 5 以后生产改动。

- [ ] **Step 1: 确认版本与固定配置**

记录 commit；版本必须仍为 3/12/6。固定同一 endpoint/model/temperature/batch/reasoning/schema/timeout；若已是 13/7，从旧 commit 的隔离 worktree 生成。

- [ ] **Step 2: 各跑三次 pipeline**

```bash
source ~/.secrets
export CORE_EVAL_API_KEY="$DEEPSEEK_API_KEY"
export CORE_EVAL_BASE_URL="https://api.deepseek.com/v1"
export CORE_EVAL_MODEL="deepseek-chat"
export CORE_EVAL_TIMEOUT_MS="120000"
for i in 1 2 3; do
  node .superpowers/acceptance/run-core-gold-evaluation.mjs --mode pipeline \
    --candidate ".superpowers/acceptance/core40-baseline-run${i}.json"
  node .superpowers/acceptance/run-core-gold-evaluation.mjs --mode pipeline \
    --corpus shared-fixtures/visible-page-core-evaluation-corpus.json \
    --candidate ".superpowers/acceptance/visible-page-baseline-run${i}.json"
done
```

- [ ] **Step 3: 校验并锁定**

六份逐一 `--validate-artifact`；manifest 记录 commit、hash、comparisonConfig、metrics；文件只读。要求两组各三份有效、配置全等、corpus v1 冻结、版本 3/12/6、无密钥。Task 不提交。

---

### Task 5: 冻结 Chrome 页面 DOM 与完整 inventory

**Files:**

- Create: `chrome-plugin/tests/fixtures/pages/spring-ai-coverage.html`
- Create: `chrome-plugin/tests/fixtures/pages/arxiv-paper-coverage.html`
- Create: `chrome-plugin/tests/fixtures/page-inventory/spring-ai-coverage.json`
- Create: `chrome-plugin/tests/fixtures/page-inventory/arxiv-paper-coverage.json`
- Create RED test: `chrome-plugin/src/content/page-inventory.test.ts`

**Contract:** `{sourceUrl,capturedAt,units:[{id,kind,text,automatic,reason}]}`。

- [ ] **Step 1: 建最小 DOM fixtures**

Spring 保留标题、前导语、完整/片段/嵌套列表、callout、dt/dd、自然语言表格。arXiv 保留长/短标题、摘要、inline MathML、display equation、自然语言/公式表格、figcaption、脚注、结构化/非结构化 reference、作者邮箱、`\Acp`、annotation/assistive fallback。顶部记录来源、2026-09-08、用途。

- [ ] **Step 2: 完整分类**

每个审计 id 恰好一项。reason 至少含 outside-principal-content、excluded-region、unsafe-interactive、hidden、non-english、no-readable-words、loose-block-too-short、display-math、math-auxiliary、conversion-placeholder、reference-metadata、unsupported-reference-layout、covered-by-child、unsafe-partial-replacement。

- [ ] **Step 3: 写 RED 全等测试并提交分母**

断言 contract 不引用缺失节点、DOM 无未分类审计节点、未来 inventory 去掉 element 后全等、scanner 等于 automatic 投影。

```bash
cd chrome-plugin && npx vitest run src/content/page-inventory.test.ts
# Expected: page-inventory 模块不存在
git add tests/fixtures src/content/page-inventory.test.ts
git commit -m "冻结技术文档页面语义清单"
```

---

### Task 6: 实现科学 DOM 文本与 Chrome inventory

**Files:**

- Create: `chrome-plugin/src/content/readable-dom-text.ts`
- Create: `chrome-plugin/src/content/readable-dom-text.test.ts`
- Create: `chrome-plugin/src/content/page-inventory.ts`
- Modify: `chrome-plugin/src/content/page-inventory.test.ts`
- Modify: `chrome-plugin/src/content/document-scanner.ts`
- Modify: `chrome-plugin/src/content/document-scanner.test.ts`

**Interfaces:**

- `normalizedReadableText(element: Element): string`。
- `inventoryReadableUnits(root: ParentNode): ReadableUnit[]`。
- `ReadableUnit` 含 id/element/kind/text/automatic/exclusionReason。

- [ ] **Step 1: 文本提取 RED**

测试普通内联顺序/隐藏祖先；math alttext 优先且只一次；无 alttext 只取一次可见 MathML；annotation/assistive 不重复；inline math 不删除。

- [ ] **Step 2: 最小提取实现**

普通可见 Text 按序；math 取 alttext 或剔除辅助子树后的单一文本并停止递归；Unicode 空白折叠。禁止 TeX parser、公式翻译、URL 分支。

- [ ] **Step 3: inventory RED 与 GREEN**

短 h/dt/th/caption 自动；p/li/dd/td/figcaption 不受统一 20 字符门；loose div/section/span 保留门；li>p、td>p、figcaption>p 唯一；table/tr/figure 不整体；科学排除 reason 稳定；`.ltx_bib_title` 只取题名。父全由子覆盖记 covered-by-child；父有不可分直接文本记 unsafe-partial-replacement。scanner 只投影 automatic；显式路径约束不变。

- [ ] **Step 4: 测试并提交**

```bash
cd chrome-plugin
npx vitest run src/content/readable-dom-text.test.ts \
  src/content/page-inventory.test.ts src/content/document-scanner.test.ts
git add src/content tests/fixtures/page-inventory
git commit -m "页面扫描按语义清单覆盖科学文档"
```

---

### Task 7: 验证 Chrome session 与 IntelliJ Markdown 扫描

**Files:**

- Modify: `chrome-plugin/src/content/session-controller.test.ts`
- Modify only if exposed: `chrome-plugin/src/content/session-controller.ts`
- Modify: `intellij-plugin/src/main/resources/web/preview.ts`
- Modify: `intellij-plugin/src/main/resources/web/preview.test.ts`
- Regenerate: `intellij-plugin/src/main/resources/web/bundle.js` via `npm run bundle-web`。

- [ ] **Step 1: Chrome session 测试**

真实 fixture+scanner：observed 与 automatic units 一一对应；discovered 等于生产 segment 句数；逐个 viewport emit 后请求文本全等且唯一；ready=total、failed/skipped=0；mutation 不重复；stop restore。允许 6 句合批。只修 `performScan/registerCandidates/flushMutations` 暴露缺陷。

- [ ] **Step 2: IntelliJ RED 测试**

增加短 h、dt/dd、caption/th/自然语言 td、figcaption、footnote，以及代码/数学/公式表格反例；要求语义块纳入且父子不重复，显式路径不回归。当前 table/footnotes 排除应使测试失败。

- [ ] **Step 3: 最小 Markdown 实现**

按 Markdown DOM 标签纳入语义块；短 semantic block 只需英文实词；普通 p/li 保持比例；loose/custom 保持取舍。排除代码、数学、mermaid、交互、卡片、纯公式 cell；不加 arXiv 适配。

- [ ] **Step 4: 测试、bundle、提交**

```bash
cd chrome-plugin && npx vitest run src/content/session-controller.test.ts
cd ../intellij-plugin && npm test && npm run bundle-web
cd ..
git add chrome-plugin/src/content/session-controller* intellij-plugin/src/main/resources/web
git commit -m "双端扫描覆盖短语义文档块"
```

---

### Task 8: 双端拒绝英文回显并复用 repair/cache

**Files:**

- Create: `shared-fixtures/translation-quality.json`
- Modify: `shared-fixtures/validator-messages.json`
- Modify: `chrome-plugin/src/language/analysis-validator.ts`
- Modify: `chrome-plugin/src/language/analysis-validator.test.ts`
- Modify: `chrome-plugin/src/language/validator-messages.test.ts`
- Modify: `chrome-plugin/src/background/analysis-service.test.ts`
- Modify: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/language/AnalysisValidator.kt`
- Modify: `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/language/AnalysisValidatorTest.kt`
- Modify: `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/language/ValidatorMessagesTest.kt`
- Modify: `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/analysis/AnalysisServiceTest.kt`

**Error:** `translation must include a meaningful Chinese gloss for the complete covered English span instead of echoing or only copying it`。

- [ ] **Step 1: 共享 RED cases**

拒绝原 echo、大小写/空白 echo、无 Han 非 echo、纯 JSON/Spring AI/GWTC-5.0/H0；接受中文类型示例；包含 translation+grammar 同轮完整错误。

- [ ] **Step 2: 双端 RED/GREEN**

从 token range 按 leadingWhitespace+text 重建 span，NFKC + Locale.ROOT/en-US lowercase + Unicode 空白折叠。TS 用 `\p{Script=Han}`，Kotlin 用单测确认的 JVM Han regex。quality error 不丢 component、不降 structureTrusted、与 grammar 同轮；只报一次。detail 不强制，renderer echo fallback 保留。

- [ ] **Step 3: repair/cache 测试**

首轮 echo 触发 repair且 prompt 带精确错误；修好只缓存中文；echo 旧缓存视为 miss；两轮仍错最终失败不缓存；不加第三轮。

- [ ] **Step 4: 测试并提交**

```bash
cd chrome-plugin
npx vitest run src/language/analysis-validator.test.ts \
  src/language/validator-messages.test.ts src/background/analysis-service.test.ts
cd ..
./gradlew :intellij-plugin:test --tests '*AnalysisValidatorTest*' \
  --tests '*ValidatorMessagesTest*' --tests '*AnalysisServiceTest*'
git add shared-fixtures chrome-plugin/src intellij-plugin/src
git commit -m "双端拒绝无中文释义与英文回显"
```

---

### Task 9: 放行 fragment-relative 并统一黄金集

**Files:**

- Modify: `chrome-plugin/src/language/analysis-validator.ts`
- Modify: `chrome-plugin/src/language/analysis-validator.test.ts`
- Modify: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/language/AnalysisValidator.kt`
- Modify: `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/language/AnalysisValidatorTest.kt`
- Modify: `shared-fixtures/validator-messages.json`
- Modify: `shared-fixtures/core-gold-annotations.json`
- Modify: `chrome-plugin/src/language/core-gold-annotations.test.ts`
- Modify: `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/contract/CoreGoldAnnotationsTest.kt`

- [ ] **Step 1: validator RED/GREEN**

接受 fragment+ATTRIBUTIVE_CLAUSE；逐项拒绝普通分句级角色、其余四从句、COORDINATE_CLAUSE。改为显式 `FRAGMENT_FORBIDDEN_ROLES`，只移出 ATTRIBUTIVE_CLAUSE；精确错误文案双端一致，十五门不变。

- [ ] **Step 2: 人工审计黄金集**

先统计全部零关系词与 PP 同构异标并裁决，再加入 fragment-relative、完整句反例、arXiv 四段标题、冒号完整分句和页面 corpus 句。每条新口径有精确 token span/role；Kotlin 全量 replay。

- [ ] **Step 3: 测试并提交**

```bash
cd chrome-plugin
npx vitest run src/language/analysis-validator.test.ts \
  src/language/validator-messages.test.ts src/language/core-gold-annotations.test.ts
cd ..
./gradlew :intellij-plugin:test --tests '*AnalysisValidatorTest*' \
  --tests '*ValidatorMessagesTest*' --tests '*CoreGoldAnnotationsTest*'
git add shared-fixtures chrome-plugin/src/language intellij-plugin/src
git commit -m "片段允许内嵌完整定语从句"
```

---

### Task 10: 重写双端 prompt 并一次升级 3/13/7

**Files:**

- Modify: `chrome-plugin/src/background/prompts.ts`
- Modify: `chrome-plugin/src/background/prompts.test.ts`
- Modify: `chrome-plugin/src/background/analysis-service.ts`
- Modify: `chrome-plugin/src/background/analysis-service.test.ts`
- Modify: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/model/Prompts.kt`
- Modify: `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/model/PromptsTest.kt`
- Modify: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/analysis/AnalysisService.kt`
- Modify: `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/analysis/AnalysisServiceTest.kt`
- Modify: `shared-fixtures/core-prompt-parity.json`
- Modify: `chrome-plugin/src/shared/versions.ts`
- Modify: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/domain/Domain.kt`
- Modify: `shared-fixtures/contracts.json`
- Modify: `chrome-plugin/src/shared/cross-platform-contract.test.ts`
- Modify: `chrome-plugin/src/background/analysis-cache.test.ts`
- Modify: `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/contract/SharedContractTest.kt`
- Modify: `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/cache/CacheKeysTest.kt`

- [ ] **Step 1: 预算与 RED 测试**

记录旧 core/core-repair 字符/token 预算。测试 fragment-relative/完整句、arXiv/普通冒号、VP/NP coordination、finite/non-finite、allow/force/let、零关系词、PP 四类、中文释义/专名、低频 clause/APPOSITIVE/INDEPENDENT_ELEMENT。detail repair 含 output shape 且标签兼容。

- [ ] **Step 2: 重写规则**

删除重复冲突后加入最小对照；保持 completeness-first、系表与十五门口径；core/repair 同源；序列化约束不变。不得机械追加旧计划全文。

- [ ] **Step 3: 一次版本升级与 parity**

四处同步 3/13/7；TS 单端生成 core parity，Kotlin 消费；确认 core/correction 随 13、detail 随 7 cache miss。

- [ ] **Step 4: 测试并提交**

```bash
cd chrome-plugin
npx vitest run src/background/prompts.test.ts src/background/analysis-service.test.ts \
  src/shared/cross-platform-contract.test.ts src/background/analysis-cache.test.ts
cd ..
./gradlew :intellij-plugin:test --tests '*PromptsTest*' \
  --tests '*SharedContractTest*' --tests '*CacheKeysTest*'
git add shared-fixtures chrome-plugin/src intellij-plugin/src
git commit -m "页面句型提示词统一并升级分析版本"
```

---

### Task 11: 页面 E2E 与两套 candidate

**Files:**

- Create: `chrome-plugin/tests/e2e/page-coverage.spec.ts`
- Consume unchanged: `chrome-plugin/tests/e2e/fixtures.ts`
- Generate, never commit: 两套 candidate 三次与 manifests

- [ ] **Step 1: 页面 E2E**

参数化 fixtures；JSON inventory + production segmenter 得 expected sentences；逐 automatic id `scrollIntoViewIfNeeded`；用 fake-model requests 与 GET_SESSION_STATUS 轮询，不用墙钟。

- [ ] **Step 2: 全链路断言**

请求集合全等且唯一；discovered/ready=expected，failed/skipped/queued/inFlight=0；每块有 Han；父子各一卡；请求不含公式、annotation、作者邮箱、`\Acp`、无题名 reference。STOP 后标题/表格/图注/链接 outerHTML 恢复；重开缓存零请求且中文可见。两轮失败脚本必须排满三份非法响应。

- [ ] **Step 3: 跑 E2E**

```bash
cd chrome-plugin && npx playwright test tests/e2e/page-coverage.spec.ts
```

- [ ] **Step 4: 两套各三份 candidate**

复用 Task 4 完全相同配置，对应 baseline 一一配对；逐份 validator，再三对汇总。要求无新 `correctToWrongOrFailure`、final failures 不增、40 句不回归、目标题型逐句改善；否则回到 Task 9/10，baseline 不变。

- [ ] **Step 5: 提交 E2E**

```bash
git add chrome-plugin/tests/e2e/page-coverage.spec.ts
git commit -m "页面级端到端验证英文语义覆盖"
```

---

### Task 12: 文档、全门禁与真页面验收

**Files:**

- Modify: `AGENTS.md`、`CHANGELOG.md`
- Modify: `docs/architecture/{overview,modules,protocol,model-pipeline,rendering,build-test-release,invariants}.md`
- Correct: spec 的“强制每条 translation 含汉字”冲突项

- [ ] **Step 1: 同步文档**

把冲突项改为“不采用纯专名中文化或专名词典；保留英文并补中文类型”。记录 inventory/reason、MathML、Markdown 边界、translation repair、fragment 例外、3/13/7 全量重取、三次配对。`protocol.md` 明确协议未变；`modules.md` 登记新源文件。

- [ ] **Step 2: Chrome 门禁**

```bash
cd chrome-plugin
npm test
npx playwright test
npm run lint
npm run format:check
npm run build
npm run docs:drift
```

Expected: 仅既有 lint 单错误；其余成功。

- [ ] **Step 3: IntelliJ 门禁**

```bash
cd ..
(cd intellij-plugin && npm ci && npm test) \
  && ./gradlew :intellij-plugin:test :intellij-plugin:buildPlugin \
    :intellij-plugin:verifyPluginProjectConfiguration
```

- [ ] **Step 4: 真页面验收**

Spring AI 与 arXiv 逐块滚动，gitignored 报告包含 inventoryTotal、expectedAutomatic、scannerDiscovered、modelRequested、ready、failed、skipped、visibleChinese、englishEchoRejected、excludedByReason。automatic 必须 100% discovered/requested/ready；排除 100% 有 reason；STOP 无损恢复。

- [ ] **Step 5: 仓库检查与提交**

```bash
git diff --check
git status --short
git add AGENTS.md docs CHANGELOG.md
git commit -m "文档同步页面级英文句法覆盖约束"
```

确认 `.superpowers/acceptance` 未跟踪、无 14/8 误升、无敏感信息。

## Execution Checkpoints

1. Task 1–3：只改评测能力和冻结语料。
2. Task 4：执行者必须确认六份 baseline 有效后继续。
3. Task 5–7：页面发现与 DOM 链路独立审查。
4. Task 8–10：双端 validator、黄金集、prompt 和唯一版本升级。
5. Task 11：指标不达标不得收尾。
6. Task 12：全门禁、真页面验收和文档提交。
