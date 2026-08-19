import { describe, expect, it } from "vitest";

import { documentsFor, missingDocs, parseNameStatus } from "./check-docs-drift.mjs";

/** @param {string} raw */
const docsFor = (raw) => documentsFor(parseNameStatus(raw));
/** @param {string} raw */
const missingFor = (raw) => missingDocs(parseNameStatus(raw)).map(([doc]) => doc);

describe("parseNameStatus", () => {
  it("读出普通改动的状态与路径", () => {
    expect(parseNameStatus("M\tchrome-plugin/src/content/learning-block.ts\n")).toEqual([
      { status: "M", path: "chrome-plugin/src/content/learning-block.ts" },
    ]);
  });

  it("重命名取新路径,不取旧路径", () => {
    const changes = parseNameStatus(
      "R096\tchrome-plugin/src/content/old.ts\tchrome-plugin/src/content/new.ts\n",
    );
    expect(changes).toEqual([{ status: "R", path: "chrome-plugin/src/content/new.ts" }]);
  });

  it("空输出得到空清单", () => {
    expect(parseNameStatus("")).toEqual([]);
  });
});

describe("documentsFor", () => {
  it("改渲染层要核对 rendering.md", () => {
    expect([...docsFor("M\tchrome-plugin/src/content/learning-block.ts\n").keys()]).toEqual([
      "rendering.md",
    ]);
  });

  it("改后台链路要核对 model-pipeline.md", () => {
    expect([...docsFor("M\tchrome-plugin/src/background/prompts.ts\n").keys()]).toEqual([
      "model-pipeline.md",
    ]);
  });

  it("service-worker 同时牵动协议与总览", () => {
    expect([...docsFor("M\tchrome-plugin/src/background/service-worker.ts\n").keys()]).toEqual([
      "protocol.md",
      "overview.md",
    ]);
  });

  it("更具体的规则优先于目录级规则", () => {
    // analysis-cache.ts 命中专条,不该退化成 src/background/ 的通配
    expect([...docsFor("M\tchrome-plugin/src/background/analysis-cache.ts\n").keys()]).toEqual([
      "model-pipeline.md",
      "protocol.md",
    ]);
  });

  it("新增源文件额外要求 modules.md", () => {
    const docs = docsFor("A\tchrome-plugin/src/content/new-thing.ts\n");
    expect([...docs.keys()].sort()).toEqual(["modules.md", "rendering.md"]);
  });

  it("删除源文件同样要求 modules.md", () => {
    expect([...docsFor("D\tchrome-plugin/src/language/segmenter.ts\n").keys()]).toContain(
      "modules.md",
    );
  });

  it("只改测试不要求动文档", () => {
    expect(docsFor("M\tchrome-plugin/src/content/learning-block.test.ts\n").size).toBe(0);
  });

  it("只改样式与页面骨架不要求动文档", () => {
    expect(
      docsFor("M\tchrome-plugin/src/options/options.css\nM\tchrome-plugin/src/popup/popup.html\n")
        .size,
    ).toBe(0);
  });

  it("文档自身的改动不触发要求", () => {
    expect(docsFor("M\tdocs/architecture/rendering.md\n").size).toBe(0);
  });

  it("记下每份文档是被哪些文件触发的", () => {
    const docs = docsFor(
      "M\tchrome-plugin/src/content/progress-pill.ts\nM\tchrome-plugin/src/content/viewport-observer.ts\n",
    );
    expect(docs.get("rendering.md")).toEqual([
      "chrome-plugin/src/content/progress-pill.ts",
      "chrome-plugin/src/content/viewport-observer.ts",
    ]);
  });

  it("改 manifest 要核对总览里的权限面", () => {
    expect([...docsFor("M\tchrome-plugin/manifest.json\n").keys()]).toEqual(["overview.md"]);
  });

  it("未列入规则的文件不产生要求", () => {
    expect(docsFor("M\tREADME.md\nM\tpackage.json\n").size).toBe(0);
  });
});

describe("missingDocs", () => {
  it("改了源文件却一份文档都没动 → 报出来", () => {
    expect(missingFor("M\tchrome-plugin/src/content/learning-block.ts\n")).toEqual([
      "rendering.md",
    ]);
  });

  it("同一次改动里动了对应文档 → 不报", () => {
    const raw =
      "M\tchrome-plugin/src/content/learning-block.ts\nM\tdocs/architecture/rendering.md\n";
    expect(missingFor(raw)).toEqual([]);
  });

  it("动了文档但动错了份 → 照报", () => {
    const raw =
      "M\tchrome-plugin/src/content/learning-block.ts\nM\tdocs/architecture/protocol.md\n";
    expect(missingFor(raw)).toEqual(["rendering.md"]);
  });

  it("牵动多份时只补了一份 → 报剩下的", () => {
    const raw =
      "M\tchrome-plugin/src/background/service-worker.ts\nM\tdocs/architecture/protocol.md\n";
    expect(missingFor(raw)).toEqual(["overview.md"]);
  });

  it("新增源文件时 modules.md 也在缺失清单里", () => {
    const raw = "A\tchrome-plugin/src/content/new-thing.ts\nM\tdocs/architecture/rendering.md\n";
    expect(missingFor(raw)).toEqual(["modules.md"]);
  });

  it("按文档名排序输出,便于稳定比对", () => {
    expect(missingFor("A\tchrome-plugin/src/options/thing.ts\n")).toEqual([
      "modules.md",
      "protocol.md",
    ]);
  });
});
