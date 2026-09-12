# 构建、测试与发布

## 1. 门禁

提交前**全部**要过(与 `AGENTS.md` 一致)。Chrome 侧命令都在 `chrome-plugin/` 里跑:

```bash
cd chrome-plugin && npm test && npx playwright test && npm run lint && npm run format:check && npm run build
```

- **lint 基线:恰好 1 个错误、0 个警告。** 那一个是 `chrome-plugin/src/options/options.test.ts` 的 `no-unnecessary-type-assertion`。不要修它,也不要新增任何错误。`npm run lint:baseline` 与 CI 用同一套判定——**直接看 `eslint .` 末尾那行会误读**,它报的是"可自动修复"的计数,不是总数。
- 提交信息用中文主题。
- **验证退出码别用管道**(`cmd | tail` 会吞掉真实退出码)。

IntelliJ 的 JCEF 真机执行提交的 `intellij-plugin/src/main/resources/web/bundle.js`，不是 `web/*.ts` 源文件。改 Web 源码后必须在 `intellij-plugin/` 运行 `npm run bundle-web` 再测试/构建；`bootstrap-lifecycle.test.ts` 会检查 bundle 是否包含当前核心桥协议标记与按段解析入口（`PARSE_BLOCK`、`__englishSyntaxParseHoveredBlock`），防止 Kotlin 已发送新字段而旧 bundle 的严格白名单把全部结果丢掉，也防止「Kotlin 侧全绿、真机按快捷键毫无反应」。

门禁之外还有一条**提醒**(不阻断):`chrome-plugin/` 里的 `npm run docs:drift`(脚本按仓库根的 git 状态反查,从子目录跑即可) 按本次改动的文件反查该核对哪几份架构文档。它不在上面那条命令链里,因为"改了代码就必须改文档"并非总成立(改 typo、纯重构都不必),硬阻断只会教人学会绕过。详见 [`README.md` 的「维护这套文档」](./README.md#维护这套文档)。

## 2. 构建

以下配置与产物路径都在 `chrome-plugin/` 下。

`npm run build`(在 `chrome-plugin/`) = `tsc --noEmit` + **两次 Vite 构建**:

| 配置                                          | 产出                               | 为什么分开                                                                   |
| --------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------- |
| `vite.config.ts`(`vite-plugin-web-extension`) | manifest、SW、popup、options、图标 | 插件按 manifest 收集入口,产 ESM                                              |
| `vite.content.config.ts`                      | `dist/content-script.js`           | content script 必须是**单文件 IIFE**(`emptyOutDir: false`,追加进同一个 dist) |

其它约定:

- `modulePreload: false`——扩展页面加载的是本地 `chrome-extension://` 资源,预加载没有收益,反而触发 Chrome 的 "cross-world extension resource mismatch / preload not used" 控制台警告。
- `target: chrome120`,与 manifest 的 `minimum_chrome_version` 一致。
- `public/assets/icon-*.png` 会被 Vite 复制成 `dist/assets/`,manifest 里的图标路径与之对应(`manifest.test.ts` 断言这些文件存在)。
- **manifest 插件在构建时会发 TLS 请求**,偶发 `ETIMEDOUT`;构建一挂,整轮 E2E 就跑不起来。重试即可。

## 3. 测试分层

| 层   | 工具                                                    | 范围                                                                     | 命令                                                  |
| ---- | ------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------- |
| 单测 | Vitest(happy-dom / fake-indexeddb,`restoreMocks: true`) | `chrome-plugin/src/**/*.test.ts` + `chrome-plugin/scripts/**/*.test.mjs` | `chrome-plugin/` 里 `npm test` / `npm run test:watch` |
| E2E  | Playwright + 真实 Chromium + 真实构建产物               | `chrome-plugin/tests/e2e/*.spec.ts`                                      | `chrome-plugin/` 里 `npm run test:e2e`                |

E2E 配置:`fullyParallel: false`、`workers: 1`(共享持久化 profile 的权限与存储状态)、单例 30s / 断言 10s 超时、CI 上重试 1 次。**不碰外网**——只有本地假模型与固定页服务器。

### 页面级覆盖 E2E(`chrome-plugin/tests/e2e/page-coverage.spec.ts`)

`extension.spec`/`layout.spec` 之外的第二条整页链路:两份 coverage fixture(`arxiv-paper-coverage.html` / `spring-ai-coverage.html` + 冻结 inventory `tests/fixtures/page-inventory/*.json`)钉住「页面语义合同」——inventory 里每个单元都有明确结局(automatic 或带 reason 的排除),automatic 单元经生产 `segmentBlock` 得出期望句集合:

1. 逐 automatic DOM id `scrollIntoView`(原生 API;`scrollIntoViewIfNeeded` 会被 `display:none` 的已替换原文卡住空转)让每块真实走视口发现;
2. `expect.poll` 同时盯假服务器请求多重集与 `GET_SESSION_STATUS`(探针,不用墙钟),定格后断言 `discovered/ready === expected`、`failed/skipped/queued/inFlight === 0`;
3. 请求集合多重集全等且唯一,每条请求 ≤ `MAX_SENTENCES_PER_REQUEST`,kind 只允许 `core`/`core-repair`;
4. 每块恰好一张卡(嵌套 `li>p`/`td>p`/`figcaption>p` 只进子),每张卡至少一条含 `\p{Script=Han}` 的译文(出现非 Han 译文 = 走了 `isEchoTranslation` 兜底,页面语义覆盖即破);
5. 逐请求断言 prompt/句文本不含 display equation、TeX annotation、作者邮箱、`\Acp` 占位符、无题名 reference、隐藏段落、导航与交互控件(按内容而非 reason 枚举,贴近「内容不泄入模型」义务本身);
6. STOP 无损还原(标题/表格/图注/链接 `outerHTML` 逐字节还原)+ 换 tab 换 documentId 重开缓存零请求;
7. 另有一例三轮非法脚本钉「失败可见、不写缓存、重新解析强制重发」。

### E2E harness(`chrome-plugin/tests/e2e/fixtures.ts`)

worker 级 fixture 做一次构建,然后:

1. 复制 `dist/` 到临时目录,**把 `optional_host_permissions` 里的两个 localhost 提升为必需 `host_permissions`**——MV3 的可选 host 权限提示是原生 Chrome 弹窗,无头自动化里关不掉。其余(包括 `TRUSTED_CONTEXTS` 存储限制)原样不动,所以测的仍是真实代码路径。**发布用的 dist manifest 保持 optional**,`extension.spec.ts` 有一例专门断言这点。
2. 起固定页服务器(`tests/fixtures/pages/`,带路径穿越防护)与 `FakeOpenAiServer`。
3. `launchPersistentContext` 加载扩展,等 service worker 就绪。

harness 提供三个口子:`seedProfiles()`(直接写 `chrome.storage.local`)、`tabIdFor(url)`、`dispatchFromUi(message)`(伪装成 popup 向 SW 派发受信任消息)。

> `seedProfiles` 是**逐字段映射**的——给 `ModelProfile` 加了新字段却忘了在这里映射,会被静默丢弃,表现为"配了却不生效",很难查。

### 假 OpenAI 服务器(`chrome-plugin/tests/support/fake-openai-server.ts`)

四条契约,破了就是一连串莫名其妙的 E2E 失败:

1. **按 prompt 首行前缀识别请求类型**(`detectKind`)。前缀表见 [`model-pipeline.md` §2](./model-pipeline.md#2-提示词promptsts)。改 prompt 首行措辞 = 破坏 E2E。
2. **任何"模型内容"都必须经 `writeContent` 出去**——core / detail / sentence-details / compound / probe 一个都不能漏。**这条踩过两次**(第一次漏了 scripted 分支,第二次漏了详解路径):直接 `response.end(completion(...))` 会让流式请求收到 JSON 体,客户端判定不支持流式后回落重发,依赖 fetch 计数的用例随之错乱。
3. **`script()` 的队列耗尽即回落默认合法响应**,所以脚本要覆盖生产里的每一轮:core 最终失败路径必须为首轮 + 两轮 repair 排满三份非法响应。少排任何一轮 = 后续 repair 拿到默认合法响应、页面渲染成功,用例从"验证失败可见"悄悄变成"验证成功渲染"。E2E 要同时用请求记录断言 `core = 1`、`core-repair = 2`(详见 [`invariants.md` I-13.1](./invariants.md))。
4. **默认合法响应必须过得了本地语法硬门。** `autoComponents` 的尾段刻意标 `OBJECT` 而**不是** `PREDICATE`:两条硬门只作用于 `PREDICATE`(首词不得是限定词/主格代词、内部不得含限定词),而按位置切分对任意 fixture 散文都保证不了这两条(`Although the passage…` / `However, you may need…` 都会撞上)。同理,「单成分包住整句」现在也非法,所以 Kotlin 侧 `AnalysisServiceTest.validCoreRaw` 与 `MarkdownSyntaxIntegrationTest.validCore` 都必须给真的同层划分。E2E 断言是结构性的(成分个数、三行结构),从不读 role 文案,所以换 role 是安全的。**core 的修复轮(`kind: "core-repair"`)作答用 `repairComponents` 而不是 `autoComponents`**:首词为介词的句子(`With …` 一类)若仍按「首词 SUBJECT + 其余 OBJECT」拆,会被本地 validator 的介词硬门连拒两轮,表现成假模型服务器特有的最终失败(真模型按修复指令一轮就修好);修复轮因此把首个介词短语并入 ADVERBIAL。译文同样必须含 Han(译文质量硬门对修复结果照样生效)。

服务器还记录每次请求(kind / model / 是否带 Authorization / 是否用了 response_format / 是否流式 / 句子文本 / 完整 prompt),并可脚本化注入错误、分片、非法输出。详解 fixture 也必须遵守生产校验:每个 structure 位于 focus 内且有序不重叠;测试并列分句内部时不能把 focus 外的并列连词塞进详解。

### 断言纪律

- **用探针,不用墙钟。** 判"是否真调了模型"用 fetch 计数 / 请求记录;判"预载成功"断言 `detailReady === detailTotal && detailFailed === 0`,不能只断言"结束了"。
- 教学语料(`chrome-plugin/tests/fixtures/teaching-sentences.json`)的测试**只校验结构不变量**(分句、无损分词、声明的词元数),**永不断言某个唯一的模型答案**——不同模型对成分的切分本就可以不同。
- 双端分句/分词契约由 `shared-fixtures/segmenter-vectors.json` 固定；可收句缩写 `etc.` 同时覆盖句中小写续接、句末大写新句与单 Token 非标点语义；`inc-nbsp-tail` 固定两句、`inc-u001c-tail` 固定一句，防 JVM `trimEnd()` 扩大尾部空白集合。任何 Tokenization 改动都要同步刷新 core/detail 版本、共享 contracts/parity，以及 `core-evaluation-traces.json` 的 tokenizer snapshot 版本/哈希。
- 准确性回归另用 `shared-fixtures/core-gold-annotations.json` 的显式黄金标注约定。CI 中 TS/Kotlin 双端的黄金集测试都用各自生产 tokenizer 重建 Token，逐句跑一遍各自的 `validateCoreBatch`（fixture 中无论是否已有 translation，Kotlin replay 都只取 span/role 并注入非空占位译文）；新增的本地语法硬门若把正确答案判非法，这些测试会红——那比漏判更糟，会把合法分析送进无意义的修复轮。黄金集含 fragment-relative 正例（`FRAGMENT_HEAD` + 完整 `ATTRIBUTIVE_CLAUSE`）、完整句定语从句反例、arXiv 冒号标题四段口径、冒号完整分句反例与页面语料代表句型（finite/non-finite when、VP coordination、宾语控制、零关系词），TS 侧另有按句 ID 的精确 token span/role 断言（零关系词句钉住 `to produce text` 整体一个 COMPLEMENT、专有名词 OBJECT 的译文必须带中文类型名「Maven 构建工具」），Kotlin 全量 replay。`scripts/core-evaluation.test.mjs` / `core-evaluation-runner.test.mjs` 只验证纯评分器和 runner 公共件；**都不联网、不调用真实模型**。
- 双端 validator 的英文修复文案由 `shared-fixtures/validator-messages.json` 互验。fixture schema v1 保存 `{schemaVersion, coveredMessageSubstrings, cases[]}`；每个 case 只存句子 id/text、原始 JSON 值、显式 `accepted` 与完整有序 errors，两端测试用各自生产 `tokenize()` 重建 Token 后只读消费。覆盖子串与实际 errors 并集做双向闭合断言，避免新增/删除用例时漏声明。fragment-relative 放行后 fixture 含 accepted 正例（`FRAGMENT_HEAD` + 完整 `ATTRIBUTIVE_CLAUSE`）与「只标引导词仍被从句最小长度门拒绝」的 case，混用错误文案显式列出仍禁止的角色。纯标点成分已用 accepted/rejected 两类 case 双端对齐；当前刻意排除前谓语为单词助动词的相邻 `PREDICATE`、负数/`0.0` Token 区间输入。
- 译文质量门的共享 case 由 `shared-fixtures/translation-quality.json` 双端 replay：拒绝原样回显、大小写/空白差异回显、全宽字符回显、无 Han 非回显、纯专名（JSON / Spring AI / GWTC-5.0 / H0）；接受「丢名 + 中文类型」释义（JSON 数据格式、Spring AI 框架、GWTC-5.0 引力波事件目录、哈勃常数 H0）与含 translation+grammar 同轮完整错误序列的 case。双端各自用生产 `tokenize()` 重建 Token 后断言 `accepted` 与完整有序 errors。fixture 另有 `hanScriptBoundary` 组（15 case：假名/谚文/CJK 标点/纯 ASCII 期望 false，扩展 A 区 `㐀`、CJK 兼容区 `丽`、`〇` 期望 true），双端各自把生产 Han 判定（TS `\p{Script=Han}` / JVM `\p{IsHan}`）对着它全量 replay，钉住跨区块脚本等价。

### 黄金集与评分器

`scripts/core-evaluation.mjs` 是无网络、无 provider 依赖的纯评分器，接受黄金句与预测句，输出：

- 整句 exact 数量与比例；
- span exact precision / recall / F1；
- labeled span precision / recall / F1；
- exact span 上的 role accuracy；
- 每句的 missing span、extra span、role error，以及缺句/多句/重复句状态。

准确性修改必须以这套指标比较 baseline/candidate，不能只凭某一句手测。跨 tokenizer 的可比评分先用每次运行保存的 token→原文字符映射，把 Token span 归一成字符半开区间；Token ID 不同但字符边界与 role 相同仍视为相等。失败句始终留在冻结全集分母中。

**为什么必须归一化(踩过的坑)**:v12/v13 prompt 的标点措辞逐字相同(`"Punctuation tokens at the end of a component may be included…"` 自 v12 起未动),但 v13 的其余教学变化让模型开始把句尾终止标点并进最后一个成分——旧口径下 9 句「差 1 字符」的 lost-exact 把 3 句真实语义退化淹没,首轮评测因此先误判「大跌」、更正时又把因果写成「v13 新许可」。归一化后 core40 exact mean 从 0.675 修正回 0.84167、visible 从 0.43333 修正回 0.46667,真退化(`ho-clause-1/2` 系表合并、`spring-vp-coordination` OBJECT 吞 ATTRIBUTE、`arxiv-figure-caption` 双重合并)与教学空隙(`nonfinite-when-phrase`)才浮出来,记为 v14 回归靶。归一化只对称移除记账差,真实合并不受豁免;页面 corpus(20 句)与 40 句 corpus 的总分不可直接比较。

**预测尾标点归一化（评分口径，与生产 validator 语义一致）**：`scoreCorePredictions` 在评分前对**预测**成分做两步归一化，口径与 `validateCoreBatch` 内的 `semanticComponents` 过滤完全一致——①成分覆盖的 token 从 startToken 到 endToken **全部为纯标点**时整条丢弃（生产同样不允许凭空给逗号/句号标 PUNCTUATION 一类角色）；②否则把「句尾纯标点尾巴上的 token」从成分尾部裁掉，`endToken`（及 `endChar`，若有）同步改写到新尾 token。理由：标点 token 本就允许不覆盖，模型把句尾终止标点并进最后一个成分只是覆盖记账差，不是语义差，不归一化会让按新 prompt 措辞（"may include punctuation"）行事的模型被 exact 与 span 记账双重惩罚。**gold 不做裁剪**——黄金集总体约定标点不覆盖，唯一人工核过的例外（`fragment-portable-api` 的 `ATTRIBUTE` 止于句号）必须保持可区分；且「与 gold 完全相等（含该例外尾标点）」的预测保留原样、仍判 exact，归一化不反向惩罚 gold 例外。裁剪只发生在评分路径；artifact 校验、哈希与 trace 结构都不经此函数（内嵌 `report` 因评分口径变化需同步重算）。

### 首轮评分与生产链路验收边界

准确性验收分两轨，不能混成一个分数：

1. **首轮轨**直接用 `buildCorePrompt` 请求并评分，用来隔离模型首次回答的成分质量。
2. **生产链路轨**必须从冷缓存以 `bypassCache: true` 调用真实 `CachedAnalysisService.analyzeCore`，覆盖生产 validator、最多两轮逐轮收窄 repair 与最终失败。adapter 只包装并记录同一次调用的 messages/raw/顺序，不复制 validator 或 repair loop；首轮 raw 与最终结果必须来自同一次 service 调用。Kotlin 侧用相同合成轨迹经真实 `AnalysisService` 独立回放，不能用 TS 终评代替 Kotlin 验证。

`shared-fixtures/core-evaluation-traces.json` 是 versioned、synthetic、脱敏的离线契约，固定验证首轮合法、错→对、语法 exact 但非语法字段错后修坏、三轮失败、两句逐轮收窄，以及双端最终 span/role、成功/失败集合和 repair subset 一致。该 fixture 同时冻结 40 句人工复核 corpus：两个 split × 五个 category × 每格四句，每句都有非空字符半开区间、role、来源与标注理由；Task 21 的两处裁定只在这里体现，不提前修改正式黄金集。synthetic fixture 与真实 artifact 共用 `core-evaluation-trace/v1` 校验器和 `traces[]` 形状，不再另设不兼容的 replay schema；fixture 内嵌的 adapter messages 必须由当前生产 `buildCorePrompt` / `buildRepairPrompt` 重建（`analysis-service.test.ts` 的全 trace 首轮 prompt 逐字比对钉住），改 prompt 后必须按生产模板重算 messages 与 prompt/messages 哈希，否则回放与哈希校验同时变红。每个 production batch 是一个 trace，保存 `callId`、完整输入 ID、实际 adapter messages、首轮 raw/validator errors、最多两轮局部编号 repair 及最终 outcome；错误逐条带 `grammar` / `non-grammar` 分类。真实模型 artifact 只存 gitignored `.superpowers/acceptance/`，保存完整 corpus/tokenizer 快照、commit、模型参数、批大小/顺序，以及实际 messages/prompt/corpus/tokenizer 的 SHA-256，不含密钥。正确首轮分母为 0 时拒绝率展示 `N/A`。

手动 runner 默认仍是首轮模式；`--mode pipeline` 才走生产链路，要求显式给独立 `--candidate` 文件。默认 corpus 是上述固定 40 句，也可用 `--corpus <path>` 载入通过 `loadEvaluationCorpus` 校验的 corpus-only JSON 或完整 artifact 中的 corpus；页面目标题型另冻结在 `shared-fixtures/visible-page-core-evaluation-corpus.json`，不能与 40 句 corpus 的总分直接比较。通用 corpus validator 对可选 `sourceEvidence` 严格校验日期格式、与句文本全等的 `exactExcerpt` 及其 SHA-256 `contentHash`；页面 corpus 的浮动 Spring 来源全部携带这份小型内嵌不可变证据，避免只靠会漂移的默认文档 URL。artifact 保存完整 corpus snapshot、生产 tokenizer snapshot、trace/report，以及 `comparisonConfig` 和每次 provider 兼容降级记录，不保存 key 或请求 header。`--baseline` 永远只读，禁止和 candidate 同路径；载入保存 artifact 时先过同一个 v1 validator。`--compare-manifest <path>` 在读取任何 provider 配置或密钥前离线加载恰好三对 `{baseline,candidate}` artifact，逐对校验完整 corpus、sentenceOrder 和 endpoint/model/mode/batch/temperature/reasoning/response-format/timeout 配置一致，再汇总 final exact、labeled-span F1、final failure 的 mean/min/max 和逐 pair transition IDs。首轮、pipeline 首轮/最终与 baseline/candidate 比较全部强制按各自 tokenizer snapshot 映射到字符坐标；token 缺失、ID 重复、range 反转或无法映射立即失败，绝不退回 Token ID 比较。固定分母必须与 corpus ID 一一对应且唯一，未知、重复、漏句均拒绝；报告总指标及 corpus 实际 split/category（均从当前 corpus 的去重值动态生成，不硬编码旧 40 句的两个 split）的首轮/最终全指标与转移；只有调用方显式声明的额外空组才为 N/A。上线判断以同配置、同句集三次配对运行的最终整句 exact 与 labeled-span F1 均值为主，同时检查范围、类别与逐句 repair 修坏；只有离线合成轨迹通过不能宣称真实准确性验收完成。

### 商店截图

`chrome-plugin/` 里 `STORE_SHOTS=1 npm run screenshots` 跑 `tests/e2e/screenshots.spec.ts`,产物进 `chrome-plugin/store-assets/`(已 gitignore)。

## 4. 真机验收

- 脚本放 `.superpowers/acceptance/`(已 gitignore,**永不提交**)。
- API key 只从环境变量读(如 `DEEPSEEK_API_KEY`,存在 `~/.secrets`),日志一律脱敏(`key <masked>`)。
- 运行:`source ~/.secrets && node .superpowers/acceptance/<script>.mjs`。

核心句法黄金集的手动真模型 runner 是 `.superpowers/acceptance/run-core-gold-evaluation.mjs`（runner base URL 只接受 HTTP(S)，拒绝 username/password/query/fragment；网络请求、日志与 artifact 统一使用去尾斜杠的规范化安全 URL）（gitignored，**不是 CI 门禁**）：

```bash
source ~/.secrets
CORE_EVAL_API_KEY="$DEEPSEEK_API_KEY" \
CORE_EVAL_BASE_URL="https://api.deepseek.com/v1" \
CORE_EVAL_MODEL="deepseek-chat" \
node .superpowers/acceptance/run-core-gold-evaluation.mjs \
  --mode pipeline \
  --corpus shared-fixtures/visible-page-core-evaluation-corpus.json \
  --baseline .superpowers/acceptance/visible-page-baseline-run1.json \
  --candidate .superpowers/acceptance/visible-page-candidate-run1.json

# 三对都生成后纯离线比较；manifest 内路径相对 manifest 自身解析
node .superpowers/acceptance/run-core-gold-evaluation.mjs \
  --compare-manifest .superpowers/acceptance/visible-page-comparison-manifest.json
```

还可用 `CORE_EVAL_TIMEOUT_MS`、`CORE_EVAL_BASELINE_PATH`、`CORE_EVAL_CANDIDATE_PATH`。runner 逐句使用生产 tokenizer 与 core prompt，保存预测、失败与完整评分报告，再打印 candidate-minus-baseline；默认发送 `reasoning_effort: "none"` 与 JSON `response_format`，provider 以 400/422 明确拒绝对应字段时逐项删除后重试，并把 requested/effective/fallback 与逐调用 attemptCount 记入 artifact。API key 只从环境变量读取，控制台固定显示 `key <masked>`，provider 错误会替换 key/Bearer/Authorization 并截断。

## 5. CI(`.github/workflows/ci.yml`)

push 到 main 与所有 PR 触发,三个 job:`chrome`(Node 22,`chrome-plugin/` 里跑全部前端门禁)、`intellij`(JDK21 + Gradle,先在 `intellij-plugin/` 里 `npm ci && npm test` 跑 web 测试)、`contracts`(契约向量)。chrome job 主链:

```
npm ci → playwright install chromium → npm test → playwright test
→ lint 基线校验(恰好 1 error / 0 warning,偏离即失败)
→ format:check → build
失败时上传 chrome-plugin/playwright-report/(保留 7 天)
```

## 6. 发布

### 本地一条命令

```bash
cd chrome-plugin
npm run release -- 1.2.0          # 改版本 → 全套门禁 → 打包 → 提交 → 打 tag → 推送
npm run release -- 1.2.0 --dry-run
```

`chrome-plugin/scripts/release.mjs` 存在的理由很具体:这套流程手工做了五次栽了三次——两次改完版本忘了 `npm run package`(本地 `release/` 里躺着上一版的包),一次 `format:check` 报错却没看结果就 commit + push,把红 CI 推了出去。

它会校验:semver 递增(**新功能升 minor**)、工作树干净、CHANGELOG 有对应小节、商店文档版本一致。版本号同时写进 `chrome-plugin/manifest.json` / `chrome-plugin/package.json` / `chrome-plugin/package-lock.json` **与 `intellij-plugin/build.gradle.kts`**——双运行时同版本发布,IDEA 插件的产物名里就带版本号(`intellij-plugin-<version>.zip`),两端各自维护版本只会重演商店手册那个坑:tag 发出去了,附件却还是上一版。`build.gradle.kts` 因此也在 `RELEASE_FILES` 里(prettier 不认 `.kts`,发版脚本写完它不做格式化)。CHANGELOG 在仓库根,git 操作也从仓库根执行。

### CI(`.github/workflows/release.yml`)

tag `v*` 触发,`permissions: contents: write`:

```
校验 tag == manifest.version == package.version == intellij-plugin 的 gradle version(不一致直接终止)
→ npm test → npm run package
→ ./gradlew :intellij-plugin:buildPlugin(job 里另装 JDK21 + gradle 缓存;这一步 working-directory 回到仓库根)
→ scripts/release-notes.mjs 切出本版本那一节 + 补安装说明(Chrome / IDEA 各一段)
→ softprops/action-gh-release 建 draft release,附 chrome-plugin/release/*.zip
  与 intellij-plugin/build/distributions/*.zip
```

只取当前版本那一节:整个 CHANGELOG 当正文会把所有历史版本一起贴出去。

### 交接约定

准备就绪就停下通知,最后一步(确认 draft、发布、上架商店)由人来做。

## 7. 其它工程约定

| 事项         | 约定                                                                                                                                      |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 新功能流程   | 先 brainstorming 出方案确认 → 写 spec(`docs/superpowers/specs/`)与实现计划(`docs/superpowers/plans/`)→ 编码(TDD)                          |
| git 远端     | 走 `gh` HTTPS(本环境 SSH 被墙)                                                                                                            |
| npm registry | 两个子工程的 `.npmrc` 均固定 `registry.npmjs.org`。**公开仓库的 lockfile 不应固化任何镜像地址**;需要镜像请用 `npm install --registry=...` |
| ESLint       | `recommendedTypeChecked` 全开;`*.js`/`*.mjs` 关类型感知(不在 tsconfig include 里);两个绘图脚本单独放行浏览器全局                          |
| Prettier     | `.prettierrc.json`;`npm run format:check` 是门禁的一环                                                                                    |
| TypeScript   | `strict` + `noUncheckedIndexedAccess` + `noImplicitOverride` + `isolatedModules`,`noEmit`(Vite 负责产出)                                  |
| Node         | `>= 22.20.0`                                                                                                                              |
| 依赖         | 全部是 devDependencies——运行时零依赖                                                                                                      |

## IntelliJ 插件的构建、测试与发布

- **门禁**:仓库根 `./gradlew :intellij-plugin:test :intellij-plugin:buildPlugin :intellij-plugin:verifyPluginProjectConfiguration`;桥协议的 TS 侧测试在 `intellij-plugin/` 里跑(`npm run test:idea-web`,即该子目录的 `vitest run src/main/resources/web`,有自己的 package.json / vitest.config.ts,不再挂在 Chrome 侧的 npm 工程下)。一键全量走仓库根 `npm run test:all`(= chrome-plugin 的 `npm test` + intellij-plugin 的 `test:idea-web` + `./gradlew intellijCheck`,见根 `package.json`)。
- **测试分层**:Kotlin 单测(JUnit5)覆盖模型/调度/缓存/会话;集成测试(`integration/`)用 FakeOpenAiServer + 真实 AnalysisService 走全链路,断言用探针(请求计数、发送记录)不用墙钟;core repair 用例必须覆盖第二轮只带剩余失败句以及两轮后终止。`SecretIsolationTest` 钉密钥隔离;`PageMessageWiringTest` 钉 JS→Kotlin 消息接线(Panel 桥接入口 → 会话)。跨端契约由仓库根 `shared-fixtures/` 双端消费(chrome-plugin 里 `npm run test:contracts`)，`contracts.json` 钉版本常量，`core-prompt-parity.json` 钉两端 core 主 prompt 正文字节一致；repair-only 文案另由双端 `PromptsTest` 钉住。**Gradle 配置缓存会把 `:intellij-plugin:test` 标 UP-TO-DATE 而无视 `shared-fixtures/` 的变更**——动过 fixture 时用 `./gradlew :intellij-plugin:test --rerun-tasks`,否则双端一致是假绿。
- **假模型服务器**:Kotlin 侧复用 `testsupport/FakeOpenAiServer`(本地 HTTP,FIFO 响应队列);并发分块用例的响应内容做成"任意配对都合法",不依赖 HTTP 到达顺序。验证两轮 repair 终止时 FIFO 也必须排满首轮和两轮 repair 三份非法响应。
- **CI**:三个 job——chrome(chrome-plugin 全部前端门禁)、intellij(JDK21 + Gradle 缓存 + 插件 zip 产物,web 测试也在这个 job 里)、contracts(契约向量)。不上传 PasswordSafe/沙箱目录。
- **发版**:与 Chrome 扩展**同版本、同一个 Release**。`intellij-plugin/build.gradle.kts` 的 `version` 由 `chrome-plugin/scripts/release.mjs` 一并改写(发版提交里落成正式版本号并一直留在那儿,不回退成 SNAPSHOT;下次发版再被改成新版本号),`buildPlugin` 产出 `intellij-plugin-<version>.zip`(约 17 MB,含 sqlite-jdbc 多平台原生库),由 release CI 附进同一个 draft;`plugin.xml` 不写 `<version>`,由 gradle 注入。Plugin Verifier 对 IC 2025.1+ 校验。JCEF 不可用的运行时里「开始句法学习」Action 不可用并提示切换 JetBrains Runtime。
- **重启语义**:扩展点(applicationService / applicationConfigurable / notificationGroup)与 Action 都在 `plugin.xml` 声明。只改 class 内容、不碰 plugin.xml 的更新可热加载(IDE 不提示重启,日志见 `loaded without restart`);改动 plugin.xml(增删扩展点)则 IDE 提示重启——这是插件是否要求重启的判定依据。
