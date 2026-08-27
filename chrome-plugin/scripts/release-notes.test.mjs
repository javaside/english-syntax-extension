import { describe, expect, it } from "vitest";
import { buildReleaseBody, extractReleaseNotes, installSection } from "./release-notes.mjs";

const changelog = [
  "# 更新日志",
  "",
  "版本号遵循语义化版本。",
  "",
  "## 1.1.0 — 2026-08-01",
  "",
  "### 功能",
  "- 新东西",
  "",
  "## 1.0.0 — 2026-07-26",
  "",
  "第一个正式版。",
  "",
  "### 已知限制",
  "- 老限制",
].join("\n");

describe("release notes", () => {
  it("只取指定版本那一节，不带标题行", () => {
    expect(extractReleaseNotes(changelog, "1.1.0")).toBe("### 功能\n- 新东西");
  });

  // 这正是「整个 CHANGELOG 当正文」的老毛病:发新版会把历史版本一起贴出去。
  it("新版本的说明里不会混进旧版本", () => {
    const notes = extractReleaseNotes(changelog, "1.1.0");
    expect(notes).not.toContain("1.0.0");
    expect(notes).not.toContain("老限制");
  });

  it("末版本一直取到文件结尾", () => {
    expect(extractReleaseNotes(changelog, "1.0.0")).toContain("老限制");
  });

  it("找不到版本时返回 undefined，构建正文则直接报错", () => {
    expect(extractReleaseNotes(changelog, "9.9.9")).toBeUndefined();
    expect(() => buildReleaseBody(changelog, "9.9.9")).toThrow(/9\.9\.9/u);
  });

  it("正文以安装说明开头，并带上该版本的 zip 名", () => {
    const body = buildReleaseBody(changelog, "1.0.0");
    expect(body.startsWith("## 安装")).toBe(true);
    expect(body).toContain("english-syntax-extension-v1.0.0.zip");
    // 关思考已改为默认行为，安装说明不该再让用户去找那个开关。
    expect(body).toContain("默认已要求模型不做思考");
    expect(body).not.toContain("勾选「关闭模型思考」");
  });

  // 双运行时同版本发布:Release 附两个包,安装说明漏掉哪个,那个包就没人知道怎么装。
  it("两个运行时各有一段安装说明，zip 名都跟着本版版本号", () => {
    const section = installSection("1.2.0");

    expect(section).toContain("### Chrome 扩展");
    expect(section).toContain("english-syntax-extension-v1.2.0.zip");
    expect(section).toContain("### IntelliJ IDEA 插件");
    expect(section).toContain("intellij-plugin-1.2.0.zip");
    expect(section).toContain("Install Plugin from Disk");
  });
});
