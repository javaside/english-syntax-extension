# 参与贡献

欢迎 issue 与 PR。这份文档只写本项目**真实存在、且容易踩的**约定，不重复通用的 Git 礼仪。

## 环境

- Chrome 扩展开发：Node.js ≥ 22.20（`chrome-plugin/package.json` 的 `engines` 是硬要求）、Chrome / Chromium ≥ 120
- IntelliJ 插件开发：JDK 21 + Gradle（仓库根 `./gradlew ...`），web 桥测试另需在 `intellij-plugin/` 里 `npm ci`

```bash
git clone https://github.com/javaside/english-syntax-extension.git
cd english-syntax-extension/chrome-plugin
npm ci
npm run build            # 产出 dist/，用于「加载已解压的扩展程序」
```

## 提交前必须全过的门禁

Chrome 侧在 `chrome-plugin/` 里跑（IntelliJ 侧改动另见 AGENTS.md 的 Gradle + web 测试门禁）：

```bash
npm test && npx playwright test && npm run lint:baseline && npm run format:check && npm run build
```

### lint 基线是「恰好 1 个错误」，不是 0

`src/options/options.test.ts` 有一处 `no-unnecessary-type-assertion` 是**有意保留**的。CI 校验的是「恰好 1 error / 0 warning」，把它修掉同样会让 CI 失败。

**不要用 `npm run lint | tail` 判断是否达标**——eslint 末尾那行 `N error ... potentially fixable` 是可自动修复数，不是总数，很容易误读（本项目就因此推过一次红 CI）。请用 `npm run lint:baseline`，它与 CI 同法统计。

## 几条反直觉的工程约定

违反这些不会被类型系统拦住，但会造成难查的线上问题：

- **协议三层校验必须同步**。新增 `ResponseMessage` 成员时，`src/shared/protocol.ts` 的类型、SW 侧校验与路由、content 侧 `isRuntimeResponse` 的 switch case，三处缺一不可。content 层漏 case 会把 SW 的成功响应静默替换成 ERROR。
- **流式分片走端口推送**，用 `isCoreStreamPush` 单独把关（`isRuntimeResponse` 对它不适用），但三处同步的要求照旧。分片是未校验输出，只用于渲染，不写缓存、不改句子相位。
- **prompt 里的句子一律走 `serializeSentences` / `serializeSentence`**。模型只按 Token ID 定位，`start`/`end`/`leadingWhitespace` 是死重量——曾把 prompt 撑到原文的 35 倍。
- **content script 读不到 `chrome.storage`**（TRUSTED_CONTEXTS）。设置必须由 SW 在 START_SESSION 页面命令上快照下发。
- **假模型服务器的所有「模型内容」都必须经 `writeContent` 出去**。直接 `response.end(completion(...))` 会让流式请求收到 JSON 体，客户端判定不支持流式后回落重发，依赖 fetch 计数的用例随之错乱。
- **E2E 断言用探针，不用墙钟**。判「是否真调了模型」用 fetch 计数；判「预载成功」断言 `detailReady === detailTotal && detailFailed === 0`。

完整清单见 [`AGENTS.md`](AGENTS.md)。

## 开发流程

- 先写测试再写实现。修 bug 时，先写一个能复现该 bug 的失败测试。
- 提交信息**用中文主题**，正文说清「为什么」，尤其是当改动的理由不能从代码本身读出来时。
- 不要提交 `dist/`、`release/`、`.superpowers/`（均已 gitignore）。

## 发布

维护者操作：更新根 `CHANGELOG.md` → 同步 `chrome-plugin/manifest.json` / `chrome-plugin/package.json` / `chrome-plugin/package-lock.json` 的版本（在 `chrome-plugin/` 里 `npm run release -- x.y.z` 一条龙）→ 打 `v*` tag 并推送。流水线会校验 tag 与两处版本一致、跑单测、打包、建**草稿** Release，需人工确认后公开。
