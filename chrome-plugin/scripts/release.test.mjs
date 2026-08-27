import { describe, expect, it } from "vitest";
import {
  assertReleasableTree,
  assertSemverBump,
  assertStoreDocVersion,
  bumpGradleVersion,
  bumpVersionFiles,
  nextChangelogHeading,
  parseVersion,
  releaseSteps,
} from "./release.mjs";

describe("parseVersion", () => {
  it("接受标准三段版本号", () => {
    expect(parseVersion("1.0.5")).toBe("1.0.5");
  });

  it("容忍 v 前缀", () => {
    expect(parseVersion("v1.0.5")).toBe("1.0.5");
  });

  it.each([["1.0"], ["1.0.5.1"], ["1.0.x"], [""], ["latest"]])("拒绝 %s", (bad) => {
    expect(() => parseVersion(bad)).toThrow(/版本号/u);
  });
});

describe("bumpVersionFiles", () => {
  const files = {
    "manifest.json": '{\n  "name": "x",\n  "version": "1.0.4"\n}\n',
    "package.json": '{\n  "version": "1.0.4",\n  "private": true\n}\n',
    "package-lock.json":
      '{\n  "name": "x",\n  "version": "1.0.4",\n  "packages": {\n    "": {\n      "version": "1.0.4"\n    }\n  }\n}\n',
  };

  it("三处版本一起改，其余内容原样保留", () => {
    const out = bumpVersionFiles(files, "1.0.5");

    expect(JSON.parse(out["manifest.json"]).version).toBe("1.0.5");
    expect(JSON.parse(out["manifest.json"]).name).toBe("x");
    expect(JSON.parse(out["package.json"]).version).toBe("1.0.5");
    expect(JSON.parse(out["package.json"]).private).toBe(true);
    const lock = JSON.parse(out["package-lock.json"]);
    expect(lock.version).toBe("1.0.5");
    // lock 的根包版本漏改会让 npm ci 报版本漂移
    expect(lock.packages[""].version).toBe("1.0.5");
  });

  it("新版本不高于当前版本时拒绝", () => {
    expect(() => bumpVersionFiles(files, "1.0.4")).toThrow(/1\.0\.4/u);
    expect(() => bumpVersionFiles(files, "1.0.3")).toThrow(/1\.0\.3/u);
  });

  it("三处当前版本不一致时拒绝——先修好再发", () => {
    const drifted = { ...files, "package.json": '{\n  "version": "1.0.3"\n}\n' };

    expect(() => bumpVersionFiles(drifted, "1.0.5")).toThrow(/必须一致/u);
  });
});

describe("bumpGradleVersion", () => {
  const gradle = [
    'group = "dev.codetui"',
    'version = "0.1.0-SNAPSHOT"',
    "",
    "kotlin { jvmToolchain(21) }",
  ].join("\n");

  it("改掉版本行，其余内容原样保留", () => {
    const out = bumpGradleVersion(gradle, "1.2.0");

    expect(out).toContain('version = "1.2.0"');
    expect(out).not.toContain("SNAPSHOT");
    expect(out).toContain("kotlin { jvmToolchain(21) }");
  });

  // 产物名里带版本号,漏改就会把 intellij-plugin-0.1.0-SNAPSHOT.zip 挂到 Release 上。
  it("只动顶层 version 行，不碰依赖里的同名赋值", () => {
    const withNested = `${gradle}\n\nintellijPlatformTesting {\n  runIde {\n    version = "2025.1"\n  }\n}\n`;

    const out = bumpGradleVersion(withNested, "1.2.0");

    expect(out).toContain('version = "1.2.0"');
    expect(out).toContain('    version = "2025.1"');
  });

  it("找不到版本行时拒绝——宁可现在失败，也别发出错版本的附件", () => {
    expect(() => bumpGradleVersion('group = "dev.codetui"\n', "1.2.0")).toThrow(/build\.gradle/u);
  });
});

describe("nextChangelogHeading", () => {
  it("在最新一节之前插入新版本标题", () => {
    const changelog = "# 更新日志\n\n## 1.0.4 — 2026-07-27\n\n旧内容\n";

    const out = nextChangelogHeading(changelog, "1.0.5", "2026-07-28");

    expect(out.indexOf("## 1.0.5 — 2026-07-28")).toBeLessThan(out.indexOf("## 1.0.4"));
    expect(out).toContain("旧内容");
  });

  it("已经写好该版本时原样返回——不覆盖手写的说明", () => {
    const changelog = "# 更新日志\n\n## 1.0.5 — 2026-07-28\n\n我手写的\n\n## 1.0.4 — x\n";

    expect(nextChangelogHeading(changelog, "1.0.5", "2026-07-28")).toBe(changelog);
  });
});

describe("releaseSteps", () => {
  const steps = releaseSteps("1.0.5");
  const names = steps.map((s) => s.name);

  // 我在这套流程上栽过三次:两次忘打包、一次推了红 CI。
  it("门禁四项都在，且都排在提交之前", () => {
    for (const gate of ["单元测试", "E2E", "lint 基线", "格式检查"]) {
      const at = names.findIndex((n) => n.includes(gate));
      expect(at, gate).toBeGreaterThanOrEqual(0);
      expect(at, `${gate} 必须在提交之前`).toBeLessThan(names.indexOf("提交"));
    }
  });

  it("打包在门禁之后、提交之前——忘打包正是踩过两次的坑", () => {
    expect(names.indexOf("打包")).toBeGreaterThan(names.indexOf("格式检查"));
    expect(names.indexOf("打包")).toBeLessThan(names.indexOf("提交"));
  });

  it("推送 tag 排在最后，且在推送分支之后", () => {
    expect(names.at(-1)).toBe("推送 tag");
    expect(names.indexOf("推送分支")).toBeLessThan(names.indexOf("推送 tag"));
  });

  it("每一步都有可执行的命令", () => {
    for (const step of steps) {
      expect(step.command.length, step.name).toBeGreaterThan(0);
    }
  });
});

describe("assertReleasableTree", () => {
  // 上一次发版我用 git add -A 把两份无关的旧文档一起提交了，还推了红 CI。
  // 发版这一步只该动版本文件与说明，其余改动请先自行提交。
  it("工作区干净时放行", () => {
    expect(() => assertReleasableTree("")).not.toThrow();
  });

  it("只有发版会改的文件时放行", () => {
    const status = [
      " M chrome-plugin/manifest.json",
      " M chrome-plugin/package.json",
      " M CHANGELOG.md",
      // IDEA 插件与扩展同版本发布,它的版本行也由发版命令自己改
      " M intellij-plugin/build.gradle.kts",
    ].join("\n");

    expect(() => assertReleasableTree(status)).not.toThrow();
  });

  it("存在无关改动时拒绝，并指出是哪些文件", () => {
    const status = [
      " M chrome-plugin/manifest.json",
      " M chrome-plugin/src/content/session-controller.ts",
    ].join("\n");

    expect(() => assertReleasableTree(status)).toThrow(/session-controller\.ts/u);
  });

  it("未跟踪文件同样拒绝——它们最容易被 add -A 顺手带走", () => {
    expect(() => assertReleasableTree("?? notes.md")).toThrow(/notes\.md/u);
  });
});

describe("assertSemverBump", () => {
  const feature = (v) => `## ${v} — 2026-07-31\n\n### 新增\n\n- 某个新功能\n`;
  const fixOnly = "## 1.0.6 — 2026-07-31\n\n### 修复\n\n- 某个修复\n";

  it("本版有「新增」却只升 patch 时拒绝——仓库声明遵循 semver", () => {
    expect(() => assertSemverBump(feature("1.0.6"), "1.0.6", "1.0.5")).toThrow(/新增/u);
  });

  it("本版有「新增」且升了 minor 时放行", () => {
    expect(() => assertSemverBump(feature("1.1.0"), "1.1.0", "1.0.5")).not.toThrow();
  });

  it("本版只有修复时，patch 放行", () => {
    expect(() => assertSemverBump(fixOnly, "1.0.6", "1.0.5")).not.toThrow();
  });

  it("升 major 时一律放行——破坏性变更由人判断", () => {
    expect(() => assertSemverBump(feature("2.0.0"), "2.0.0", "1.0.5")).not.toThrow();
  });

  it("CHANGELOG 里找不到本版一节时拒绝——发布说明该先写好", () => {
    expect(() => assertSemverBump(fixOnly, "9.9.9", "1.0.5")).toThrow(/CHANGELOG/u);
  });
});

describe("assertStoreDocVersion", () => {
  it("商店文档里的包版本与本次不一致时拒绝", () => {
    const doc = "`release/english-syntax-extension-v1.0.5.zip`（190 KB，19 个文件）。";
    expect(() => assertStoreDocVersion(doc, "1.0.6")).toThrow(/chrome-web-store/u);
  });

  it("一致时放行", () => {
    const doc = "`release/english-syntax-extension-v1.0.6.zip`（192 KB，19 个文件）。";
    expect(() => assertStoreDocVersion(doc, "1.0.6")).not.toThrow();
  });
});
