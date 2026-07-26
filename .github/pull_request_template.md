## 这个 PR 做了什么

<!-- 说清「为什么」。改动本身能从 diff 读出来，动机往往不能。 -->

## 关联 issue

<!-- Closes #123 -->

## 门禁

<!-- 全部跑过再勾。CI 会重跑一遍。 -->

- [ ] `npm test`
- [ ] `npx playwright test`
- [ ] `npm run lint:baseline`（基线是**恰好 1 个错误**，不是 0）
- [ ] `npm run format:check`
- [ ] `npm run build`

## 自查

- [ ] 改动有测试覆盖；修 bug 的话，先有一个能复现该 bug 的失败测试
- [ ] 若新增了 `RequestMessage` / `ResponseMessage` 成员：类型、SW 侧校验与路由、content 侧守卫三处都改了
- [ ] 若改了 prompt 首行措辞：确认没有破坏假模型服务器的 `detectKind`
- [ ] 没有提交 `dist/`、`release/` 或任何凭据
