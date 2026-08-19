## 这个 PR 做了什么

<!-- 说清「为什么」。改动本身能从 diff 读出来，动机往往不能。 -->

## 关联 issue

<!-- Closes #123 -->

## 门禁

<!-- 全部跑过再勾（Chrome 侧命令在 `chrome-plugin/` 里跑；动了 `intellij-plugin/`、`shared-fixtures/` 或桥协议时，另跑 AGENTS.md 里的 Gradle + web 测试门禁）。CI 会重跑一遍。 -->

- [ ] `cd chrome-plugin && npm test`
- [ ] `cd chrome-plugin && npx playwright test`
- [ ] `cd chrome-plugin && npm run lint:baseline`（基线是**恰好 1 个错误**，不是 0）
- [ ] `cd chrome-plugin && npm run format:check`
- [ ] `cd chrome-plugin && npm run build`

## 自查

- [ ] 改动有测试覆盖；修 bug 的话，先有一个能复现该 bug 的失败测试
- [ ] 若新增了 `RequestMessage` / `ResponseMessage` 成员：类型、SW 侧校验与路由、content 侧守卫三处都改了
- [ ] 若改了 prompt 首行措辞：确认没有破坏假模型服务器的 `detectKind`
- [ ] 没有提交 `dist/`、`release/` 或任何凭据
