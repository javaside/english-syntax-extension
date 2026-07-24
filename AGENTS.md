# 项目指令(english-syntax-extension)

Chrome MV3 英语句法学习扩展:TypeScript + Vite,Vitest(fake-indexeddb / happy-dom)单测,Playwright E2E(假 OpenAI 服务器)。本仓库由 springai-agentdemo 单仓拆出(git filter-repo,历史完整保留)。

## 门禁(提交前全部过)

```bash
npm test && npx playwright test && npm run lint && npm run format:check && npm run build
```

- **lint 基线:恰好 1 个错误**——`src/options/options.test.ts` 的 `no-unnecessary-type-assertion`。不要修它,也不要新增任何错误。
- 提交信息用中文主题。

## 关键工程约定

- **协议三层校验必须同步**:新增 `ResponseMessage` 成员时,`src/shared/protocol.ts` 类型、SW 侧校验/路由、content 侧 `isRuntimeResponse` 的 switch case 三处缺一不可。content 层漏 case 会把 SW 的成功响应静默替换成 ERROR(缓存写对但计数全错,曾在真机验收才暴露)。
- **E2E/验收断言用探针,不用墙钟**:判"是否真调了模型"用 fetch 计数/请求记录;判"预载成功"断言 `detailReady === detailTotal && detailFailed === 0`,不能只断言"结束了"。
- **content script 读不到 chrome.storage**(TRUSTED_CONTEXTS):设置必须由 SW 在 START_SESSION 页面命令上快照下发。
- 详解缓存键 = 规范化句文本 + schema 版本 + focus 区间(与 profile/模型无关),预载与点击路径共用同一键——改任一侧的键构造必须两侧同步并用对方路径读回验证。
- 假模型服务器按 prompt 首行前缀识别请求类型(`tests/support/fake-openai-server.ts` 的 `detectKind`),改 prompt 首行措辞会破坏 E2E。
- 调度优先级:`user-retry(0) > detail-click(1) > visible-core(2) > prefetch-core(3) > prefetch-detail(4)`。

## 真机验收

- 脚本放 `.superpowers/acceptance/`(已 gitignore,**永不提交**)。
- API key 只从环境变量读(如 `DEEPSEEK_API_KEY`,在 `~/.secrets`),日志一律脱敏(`key <masked>`)。
- 运行:`source ~/.secrets && node .superpowers/acceptance/<script>.mjs`。

## 流程

- 新功能先走 brainstorming 出方案确认,再写 spec(`docs/superpowers/specs/`)与实现计划(`docs/superpowers/plans/`),后编码(TDD)。
- git 远端走 gh HTTPS(本环境 SSH 被墙)。
