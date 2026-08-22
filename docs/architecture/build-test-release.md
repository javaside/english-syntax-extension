# 构建、测试与发布

## 1. 门禁

提交前**全部**要过(与 `AGENTS.md` 一致)。Chrome 侧命令都在 `chrome-plugin/` 里跑:

```bash
cd chrome-plugin && npm test && npx playwright test && npm run lint && npm run format:check && npm run build
```

- **lint 基线:恰好 1 个错误、0 个警告。** 那一个是 `chrome-plugin/src/options/options.test.ts` 的 `no-unnecessary-type-assertion`。不要修它,也不要新增任何错误。`npm run lint:baseline` 与 CI 用同一套判定——**直接看 `eslint .` 末尾那行会误读**,它报的是"可自动修复"的计数,不是总数。
- 提交信息用中文主题。
- **验证退出码别用管道**(`cmd | tail` 会吞掉真实退出码)。

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

| 层   | 工具                                                    | 范围                                         | 命令                              |
| ---- | ------------------------------------------------------- | -------------------------------------------- | --------------------------------- |
| 单测 | Vitest(happy-dom / fake-indexeddb,`restoreMocks: true`) | `chrome-plugin/src/**/*.test.ts` + `chrome-plugin/scripts/**/*.test.mjs` | `chrome-plugin/` 里 `npm test` / `npm run test:watch` |
| E2E  | Playwright + 真实 Chromium + 真实构建产物               | `chrome-plugin/tests/e2e/*.spec.ts`          | `chrome-plugin/` 里 `npm run test:e2e` |

E2E 配置:`fullyParallel: false`、`workers: 1`(共享持久化 profile 的权限与存储状态)、单例 30s / 断言 10s 超时、CI 上重试 1 次。**不碰外网**——只有本地假模型与固定页服务器。

### E2E harness(`chrome-plugin/tests/e2e/fixtures.ts`)

worker 级 fixture 做一次构建,然后:

1. 复制 `dist/` 到临时目录,**把 `optional_host_permissions` 里的两个 localhost 提升为必需 `host_permissions`**——MV3 的可选 host 权限提示是原生 Chrome 弹窗,无头自动化里关不掉。其余(包括 `TRUSTED_CONTEXTS` 存储限制)原样不动,所以测的仍是真实代码路径。**发布用的 dist manifest 保持 optional**,`extension.spec.ts` 有一例专门断言这点。
2. 起固定页服务器(`tests/fixtures/pages/`,带路径穿越防护)与 `FakeOpenAiServer`。
3. `launchPersistentContext` 加载扩展,等 service worker 就绪。

harness 提供三个口子:`seedProfiles()`(直接写 `chrome.storage.local`)、`tabIdFor(url)`、`dispatchFromUi(message)`(伪装成 popup 向 SW 派发受信任消息)。

> `seedProfiles` 是**逐字段映射**的——给 `ModelProfile` 加了新字段却忘了在这里映射,会被静默丢弃,表现为"配了却不生效",很难查。

### 假 OpenAI 服务器(`chrome-plugin/tests/support/fake-openai-server.ts`)

两条契约,破了就是一连串莫名其妙的 E2E 失败:

1. **按 prompt 首行前缀识别请求类型**(`detectKind`)。前缀表见 [`model-pipeline.md` §2](./model-pipeline.md#2-提示词promptsts)。改 prompt 首行措辞 = 破坏 E2E。
2. **任何"模型内容"都必须经 `writeContent` 出去**——core / detail / sentence-details / compound / probe 一个都不能漏。**这条踩过两次**(第一次漏了 scripted 分支,第二次漏了详解路径):直接 `response.end(completion(...))` 会让流式请求收到 JSON 体,客户端判定不支持流式后回落重发,依赖 fetch 计数的用例随之错乱。

服务器还记录每次请求(kind / model / 是否带 Authorization / 是否用了 response_format / 是否流式 / 句子文本 / 完整 prompt),并可脚本化注入错误、分片、非法输出。

### 断言纪律

- **用探针,不用墙钟。** 判"是否真调了模型"用 fetch 计数 / 请求记录;判"预载成功"断言 `detailReady === detailTotal && detailFailed === 0`,不能只断言"结束了"。
- 教学语料(`chrome-plugin/tests/fixtures/teaching-sentences.json`)的测试**只校验结构不变量**(分句、无损分词、声明的词元数),**永不断言某个唯一的模型答案**——不同模型对成分的切分本就可以不同。

### 商店截图

`chrome-plugin/` 里 `STORE_SHOTS=1 npm run screenshots` 跑 `tests/e2e/screenshots.spec.ts`,产物进 `chrome-plugin/store-assets/`(已 gitignore)。

## 4. 真机验收

- 脚本放 `.superpowers/acceptance/`(已 gitignore,**永不提交**)。
- API key 只从环境变量读(如 `DEEPSEEK_API_KEY`,存在 `~/.secrets`),日志一律脱敏(`key <masked>`)。
- 运行:`source ~/.secrets && node .superpowers/acceptance/<script>.mjs`。

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

它会校验:semver 递增(**新功能升 minor**)、工作树干净、CHANGELOG 有对应小节、商店文档版本一致。版本号同时写进 `chrome-plugin/manifest.json` / `chrome-plugin/package.json` / `chrome-plugin/package-lock.json`;CHANGELOG 在仓库根,git 操作也从仓库根执行。

### CI(`.github/workflows/release.yml`)

tag `v*` 触发,`permissions: contents: write`:

```
校验 tag == manifest.version == package.version(不一致直接终止)
→ npm test → npm run package
→ scripts/release-notes.mjs 切出本版本那一节 + 补安装说明
→ softprops/action-gh-release 建 draft release,附 chrome-plugin/release/*.zip
```

只取当前版本那一节:整个 CHANGELOG 当正文会把所有历史版本一起贴出去。

### 交接约定

准备就绪就停下通知,最后一步(确认 draft、发布、上架商店)由人来做。

## 7. 其它工程约定

| 事项         | 约定                                                                                                                       |
| ------------ | -------------------------------------------------------------------------------------------------------------------------- |
| 新功能流程   | 先 brainstorming 出方案确认 → 写 spec(`docs/superpowers/specs/`)与实现计划(`docs/superpowers/plans/`)→ 编码(TDD)           |
| git 远端     | 走 `gh` HTTPS(本环境 SSH 被墙)                                                                                             |
| npm registry | 两个子工程的 `.npmrc` 均固定 `registry.npmjs.org`。**公开仓库的 lockfile 不应固化任何镜像地址**;需要镜像请用 `npm install --registry=...` |
| ESLint       | `recommendedTypeChecked` 全开;`*.js`/`*.mjs` 关类型感知(不在 tsconfig include 里);两个绘图脚本单独放行浏览器全局           |
| Prettier     | `.prettierrc.json`;`npm run format:check` 是门禁的一环                                                                     |
| TypeScript   | `strict` + `noUncheckedIndexedAccess` + `noImplicitOverride` + `isolatedModules`,`noEmit`(Vite 负责产出)                   |
| Node         | `>= 22.20.0`                                                                                                               |
| 依赖         | 全部是 devDependencies——运行时零依赖                                                                                       |

## IntelliJ 插件的构建、测试与发布

- **门禁**:仓库根 `./gradlew :intellij-plugin:test :intellij-plugin:buildPlugin :intellij-plugin:verifyPluginProjectConfiguration`;桥协议的 TS 侧测试在 `intellij-plugin/` 里跑(`npm run test:idea-web`,即该子目录的 `vitest run src/main/resources/web`,有自己的 package.json / vitest.config.ts,不再挂在 Chrome 侧的 npm 工程下)。一键全量走仓库根 `npm run test:all`(= chrome-plugin 的 `npm test` + intellij-plugin 的 `test:idea-web` + `./gradlew intellijCheck`,见根 `package.json`)。
- **测试分层**:Kotlin 单测(JUnit5,167 例)覆盖模型/调度/缓存/会话;集成测试(`integration/`)用 FakeOpenAiServer + 真实 AnalysisService 走全链路,断言用探针(请求计数、发送记录)不用墙钟;`SecretIsolationTest` 钉密钥隔离;`PageMessageWiringTest` 钉 JS→Kotlin 消息接线(Panel 桥接入口 → 会话)。跨端契约由仓库根 `shared-fixtures/` 双端消费(chrome-plugin 里 `npm run test:contracts`)。
- **假模型服务器**:Kotlin 侧复用 `testsupport/FakeOpenAiServer`(本地 HTTP,FIFO 响应队列);并发分块用例的响应内容做成"任意配对都合法",不依赖 HTTP 到达顺序。
- **CI**:三个 job——chrome(chrome-plugin 全部前端门禁)、intellij(JDK21 + Gradle 缓存 + 插件 zip 产物,web 测试也在这个 job 里)、contracts(契约向量)。不上传 PasswordSafe/沙箱目录。
- **发版**:`buildPlugin` 产出带版本 zip;Plugin Verifier 对 IC 2025.1+ 校验。JCEF 不可用的运行时里「开始句法学习」Action 不可用并提示切换 JetBrains Runtime。
- **重启语义**:扩展点(applicationService / applicationConfigurable / notificationGroup)与 Action 都在 `plugin.xml` 声明。只改 class 内容、不碰 plugin.xml 的更新可热加载(IDE 不提示重启,日志见 `loaded without restart`);改动 plugin.xml(增删扩展点)则 IDE 提示重启——这是插件是否要求重启的判定依据。
