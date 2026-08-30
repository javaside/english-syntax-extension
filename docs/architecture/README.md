# 架构文档

这套文档的目标只有一个:**让一个从未见过本仓库的人(或模型)读完之后,不必再全量扫描源码,就能定位到该改的那几个文件、并知道改动会踩到哪些坑。**

源码本身注释密度很高——很多"为什么这么写"的一手证据写在函数上方。本文档不复制那些注释,而是补它们给不了的东西:**跨文件的结构、链路、契约与不变量**。

## 30 秒概览

仓库根下两个平级子模块,同一套「英语句法伴读」的两个平台实现:

- **`chrome-plugin/`** —— Chrome MV3 扩展:把网页里的英文段落**就地替换**成逐句句法拆解卡片(每个成分三行——角色标签 / 英文原文 / 中文译文),点任一成分展开详细解析面板。句法分析由用户自配的**任意 OpenAI 兼容端点**完成(云端 API 或本地 Ollama),结果按句缓存在 IndexedDB。完整 npm 工程,TypeScript + Vite + `vite-plugin-web-extension`;Vitest(happy-dom / fake-indexeddb)单测,Playwright E2E(加载真实构建产物 + 本地假 OpenAI 服务器)。
- **`intellij-plugin/`** —— IntelliJ IDEA Markdown 预览插件:Kotlin + Gradle IntelliJ Platform,SQLite 缓存(与 Chrome 扩展互通),JCEF 桥接预览页;web 侧 TS 测试在该子目录里独立跑。

两运行时**不共享运行代码**,只共享契约:仓库根 `shared-fixtures/` 的向量与 fixture 由 TS / Kotlin 测试同时消费;`docs/architecture/` 与 `CHANGELOG.md` 也是仓库级。无后端、无遥测:除了用户自己填的模型端点,扩展不向任何服务器发请求。仓库由 `springai-agentdemo` 单仓拆出(git filter-repo,历史完整保留)。

## 该读哪一份

| 你要做的事                                | 先读                                               |
| ----------------------------------------- | -------------------------------------------------- |
| 完全不了解这个项目                        | 本页 →[`overview.md`](./overview.md)               |
| 找"改这个功能该动哪个文件"                | [`modules.md`](./modules.md)                       |
| 加 / 改一条扩展内部消息或 IntelliJ 桥消息 | [`protocol.md`](./protocol.md)                     |
| 调 prompt、换模型、改并发/超时/降级/缓存  | [`model-pipeline.md`](./model-pipeline.md)         |
| 改页面上的卡片、面板、扫描规则、进度提示  | [`rendering.md`](./rendering.md)                   |
| 跑测试、加测试、发版                      | [`build-test-release.md`](./build-test-release.md) |
| 动手之前想知道"哪里有雷"                  | [`invariants.md`](./invariants.md)                 |

## 与仓库其它文档的分工

| 文件                                     | 定位                                                | 谁读                                   |
| ---------------------------------------- | --------------------------------------------------- | -------------------------------------- |
| `AGENTS.md`                              | **权威简版**:门禁命令 + 最容易踩的工程约定,一页读完 | 每次动手前必读                         |
| `docs/architecture/*`(本目录)            | 结构与链路的完整说明,含"为什么"                     | 需要理解全局或改跨层逻辑时             |
| `README.md`                              | 面向使用者:安装、配置模型、权限、隐私、故障排查     | 用户 / 新贡献者                        |
| `CHANGELOG.md`                           | 按版本记录变更与性能实测数字                        | 查"某个取舍是什么时候、为什么定下来的" |
| `docs/superpowers/specs/*`               | 单个功能的设计稿(写于实现之前)                      | 考古某个功能的原始需求                 |
| `docs/superpowers/plans/*`               | 单个功能的分步实现计划                              | 同上                                   |
| `chrome-plugin/docs/chrome-web-store.md` | 应用商店上架文案与素材说明                          | 发布时                                 |
| `PRIVACY.md` / `SECURITY.md`             | 隐私声明与安全披露流程                              | 合规                                   |

**冲突时以 `AGENTS.md` 为准**,并把本目录里过时的那段改掉。

## 维护这套文档

过时的架构文档比没有更糟——它会让人自信地做出错误决定。所以这里分三道防线,一道比一道松、一道比一道广。

### 第一道:门禁里的自动守护

`chrome-plugin/src/shared/architecture-docs.test.ts` 随 `chrome-plugin/` 的 `npm test` 一起跑(它从子目录回看仓库根的文档与 `intellij-plugin/`),钉住能机器判定的部分:

| 断言                                                                                                                                                                                      | 改了什么会让它变红 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `chrome-plugin/src/` 与 `intellij-plugin/` 下每个实现文件都在 `modules.md` 出现                                                                                                           | 新增或重命名模块   |
| 每条 `RequestMessage` / `ResponseMessage` 都在 `protocol.md` 出现                                                                                                                         | 增删消息类型       |
| 每个 `GrammarRole` 与中文标签都在 `protocol.md` 出现;文档里写的角色数量正确                                                                                                               | 增删语法角色       |
| 每个 `ERROR_CODES` 成员都在 `protocol.md` 出现                                                                                                                                            | 增删错误码         |
| 每个 `*_KEY` storage 键都在 `protocol.md` 的存储清单出现                                                                                                                                  | 增删存储键         |
| 五档调度优先级都在 `model-pipeline.md` 出现                                                                                                                                               | 改优先级           |
| 每个 `SentencePhase` 都在 `overview.md` 的相位机出现                                                                                                                                      | 改相位             |
| 三个能力降级位都在 `model-pipeline.md` 出现                                                                                                                                               | 改降级逻辑         |
| 文档里写出的常量数值(`MESSAGE_VERSION` / `CORE_SCHEMA_VERSION` / `MAX_SENTENCES_PER_REQUEST` / `MODEL_REQUEST_CONCURRENCY` / `CLOUD_SENTENCES_PER_REQUEST`)与源码一致——**每一处出现都查** | 调这些常量         |
| 文档间的相对链接都指向存在的文件                                                                                                                                                          | 改文件名或链接     |

**红了就去改文档,不要放宽断言。** 断言刻意只覆盖"清单与数字"这类客观事实,不试图校验散文。

### 第二道:改完代码跑 `npm run docs:drift`

第一道只认**名字与数字**。改现有文件的内部逻辑时它一条都不会红——而"新增功能"多半正是这一类,这是最容易漂的地方。

`chrome-plugin/scripts/check-docs-drift.mjs` 补的就是这一段:读本次 git 改动(含未跟踪的新文件),按文件路径反查该核对哪几份文档,列出"这些源文件变了、对应文档却没动"。

在 `chrome-plugin/` 里跑(git 操作由脚本从仓库根执行):

```bash
npm run docs:drift                              # 比工作区与 HEAD
node scripts/check-docs-drift.mjs origin/main   # 比与基线分支的差异
node scripts/check-docs-drift.mjs --strict      # 缺失即退出码 1(给 CI 用)
```

判据刻意宽松——**只问"碰过没有",不问"改得对不对"**。只改测试 / 样式 / HTML 骨架一律豁免。确实没有新说法要记(改 typo、纯重构)就忽略它,这是提醒而不是门禁。

映射规则在脚本的 `RULES` 表里,与 [`AGENTS.md` 的「文档同步」一节](../../AGENTS.md)对应;`check-docs-drift.test.mjs` 钉住它,包括"动了文档但动错了份要照报"。

### 第三道:人的判断

两个工具都抓不到"说法变了但文件也确实动过了"的情况——比如你改了降级顺序,也确实编辑了 `model-pipeline.md`,但改的是另一段。

一条经验:**如果你改代码时需要先读某份文档才敢下手,那份文档就该跟着这次改动一起更新。**

## 术语表

| 术语                            | 含义                                                                                                                          |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **block / 块**                  | 页面上的一个候选段落元素(`<p>`、`<li>`,以及"渲染为块的叶子元素")。扫描与替换的最小单位。                                      |
| **sentence / 句**               | 块内经 TS/Kotlin 共享的确定性候选边界与合并规则切出的一句。模型请求与缓存的最小单位。                                         |
| **token**                       | 句内的一个词或标点,带 `id`(句内序号)。**模型只用 `id` 定位,一切区间都是闭区间 `[startToken, endToken]`**。                    |
| **core / 核心解析**             | 整句拆成若干互不重叠的成分(主谓宾定状补 + 五类从句 + 并列),每个成分带中文译文。就是卡片上看到的东西。                         |
| **detail / 详解**               | 对**某一个成分**的展开解释:内部再拆结构 + 语法点 + 整体说明。点成分才请求。                                                   |
| **component / 成分**            | core 的一项;**focus** 就是被点击成分的 token 区间,详解按 focus 请求与缓存。                                                   |
| **profile / 模型配置**          | 一套端点参数(baseUrl / apiKey / model / headers / timeout + 探到的能力位)。可存多份,一份为"启用中"。                          |
| **documentId**                  | 一次页面会话的标识。SW 与 content script 用它判断消息是否属于当前会话;换页 / SPA 导航即换代。                                 |
| **相位 / phase**                | 单句的生命周期状态:`discovered → cache-check → queued → requesting → validating → ready`(或 `failed` / `skipped` / `stale`)。 |
| **纯缓存模式 / cacheOnly**      | 没有任何模型配置时的会话:只查缓存,未命中的句子保持原文,不报错。                                                               |
| **降级 / capability downgrade** | 端点拒绝 `response_format` / `stream` / `reasoning_effort` 时,记下否定态并改用兼容路径,不再重复试错。                         |
