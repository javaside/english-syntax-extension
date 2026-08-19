#!/usr/bin/env node
// 按本次改动的源文件,反查该核对哪几份架构文档。
//
// `src/shared/architecture-docs.test.ts` 只能钉住「名字与数字」——枚举、错误码、
// 消息类型、存储键、常量取值。改现有文件的内部逻辑(绝大多数「新增功能」都是这类)
// 它一条都不会红。这个脚本补的正是那一段:你动了哪些文件,就提醒你核对哪几份文档。
//
//   node scripts/check-docs-drift.mjs                 比工作区(含暂存)与 HEAD
//   node scripts/check-docs-drift.mjs origin/main     比与指定基线的差异
//   node scripts/check-docs-drift.mjs --strict        相关文档一份都没动就退出码 1
//
// 判据刻意宽松:只要求「相关文档里至少有一份被碰过」,不试图判断改得对不对。
// 那部分是人的责任,见 AGENTS.md「文档同步」。

import { execFileSync } from "node:child_process";

const DOCS_DIR = "docs/architecture/";

/** 源文件前缀 → 该核对的文档。按从具体到宽泛匹配,命中即取该条。 */
const RULES = [
  ["src/background/service-worker.ts", ["protocol.md", "overview.md"]],
  ["src/background/analysis-cache.ts", ["model-pipeline.md", "protocol.md"]],
  ["src/background/config-repository.ts", ["protocol.md", "model-pipeline.md"]],
  ["src/background/", ["model-pipeline.md"]],
  ["src/content/content-script.ts", ["protocol.md", "rendering.md"]],
  ["src/content/session-controller.ts", ["rendering.md", "overview.md"]],
  ["src/content/", ["rendering.md"]],
  ["src/shared/protocol.ts", ["protocol.md"]],
  ["src/shared/grammar.ts", ["protocol.md"]],
  ["src/shared/errors.ts", ["protocol.md"]],
  ["src/shared/versions.ts", ["protocol.md"]],
  ["src/language/", ["rendering.md", "protocol.md"]],
  ["src/popup/", ["modules.md"]],
  ["src/options/", ["modules.md", "protocol.md"]],
  [
    "intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/domain/",
    ["protocol.md", "overview.md"],
  ],
  [
    "intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/bridge/",
    ["protocol.md", "overview.md"],
  ],
  ["intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/model/", ["model-pipeline.md"]],
  ["intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/analysis/", ["model-pipeline.md"]],
  ["intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/cache/", ["model-pipeline.md"]],
  ["intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/scheduler/", ["model-pipeline.md"]],
  [
    "intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/markdown/",
    ["rendering.md", "overview.md"],
  ],
  [
    "intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/session/",
    ["rendering.md", "overview.md"],
  ],
  [
    "intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/settings/",
    ["model-pipeline.md", "build-test-release.md"],
  ],
  ["intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/actions/", ["rendering.md"]],
  ["intellij-plugin/src/main/resources/web/", ["rendering.md"]],
  ["intellij-plugin/src/main/resources/META-INF/", ["build-test-release.md"]],
  ["intellij-plugin/src/test/kotlin/", ["build-test-release.md"]],
  ["intellij-plugin/build.gradle.kts", ["build-test-release.md"]],
  ["intellij-plugin/gradle/", ["build-test-release.md"]],
  ["shared-fixtures/", ["build-test-release.md", "protocol.md"]],
  ["tests/support/", ["build-test-release.md"]],
  ["tests/e2e/", ["build-test-release.md"]],
  ["scripts/", ["build-test-release.md"]],
  ["manifest.json", ["overview.md"]],
  [".github/workflows/", ["build-test-release.md"]],
];

/** 改动了这些文件就必须动 modules.md——模块地图是逐文件的清单。 */
function isModuleRosterChange(status, path) {
  return (
    (status === "A" || status === "D" || status === "R") &&
    (path.startsWith("src/") ||
      path.startsWith("intellij-plugin/src/main/kotlin/") ||
      path.startsWith("intellij-plugin/src/main/resources/web/"))
  );
}

/** 只改测试不要求动文档:测试跟着实现走,实现没动就没有新说法要记。 */
function isExempt(path) {
  return (
    path.endsWith(".test.ts") ||
    path.endsWith(".test.mjs") ||
    path.startsWith("tests/fixtures/") ||
    path.endsWith(".css") ||
    path.endsWith(".html")
  );
}

/** @returns {Map<string, string[]>} 文档名 → 触发它的源文件 */
export function documentsFor(changes) {
  const wanted = new Map();
  const add = (doc, path) => {
    const list = wanted.get(doc);
    if (list) list.push(path);
    else wanted.set(doc, [path]);
  };

  for (const { status, path } of changes) {
    if (path.startsWith(DOCS_DIR) || isExempt(path)) continue;
    if (isModuleRosterChange(status, path)) add("modules.md", path);
    const rule = RULES.find(([prefix]) => path.startsWith(prefix));
    if (rule) for (const doc of rule[1]) add(doc, path);
  }
  return wanted;
}

/**
 * 该动却没动的文档。
 * @returns {Array<[string, string[]]>} [文档名, 触发它的源文件[]],按文档名排序
 */
export function missingDocs(changes) {
  const touched = new Set(
    changes
      .filter((change) => change.path.startsWith(DOCS_DIR))
      .map((change) => change.path.slice(DOCS_DIR.length)),
  );
  return [...documentsFor(changes)]
    .filter(([doc]) => !touched.has(doc))
    .sort(([a], [b]) => a.localeCompare(b));
}

/** 解析 `git diff --name-status` 的输出。R/C 带相似度后缀与两个路径。 */
export function parseNameStatus(raw) {
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\t");
      const status = parts[0]?.[0] ?? "M";
      // 重命名/复制取新路径,其余取唯一路径
      const path = parts.length > 2 ? parts[2] : parts[1];
      return { status, path: path ?? "" };
    })
    .filter((change) => change.path !== "");
}

function main() {
  const args = process.argv.slice(2);
  const strict = args.includes("--strict");
  const base = args.find((arg) => !arg.startsWith("--"));

  const range = base ? [`${base}...HEAD`] : ["HEAD"];
  const raw = execFileSync("git", ["diff", "--name-status", ...range], {
    encoding: "utf8",
  });
  const changes = parseNameStatus(raw);

  // 比工作区时还要把未跟踪文件算进来。新增源文件恰恰是最该提醒改 modules.md 的
  // 场景,而它在 `git add` 之前对 `git diff` 完全不可见——只看 diff 会静默漏掉。
  if (!base) {
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
    for (const path of untracked) changes.push({ status: "A", path });
  }
  if (changes.length === 0) {
    console.log("没有改动,跳过文档漂移检查。");
    return;
  }

  const wanted = documentsFor(changes);
  if (wanted.size === 0) {
    console.log("本次改动不涉及需要同步文档的源文件。");
    return;
  }

  const missing = missingDocs(changes);
  if (missing.length === 0) {
    console.log(`相关文档都动过了:${[...wanted.keys()].sort().join("、")}`);
    return;
  }

  console.log("");
  console.log("这些源文件变了,对应的架构文档却没动:");
  console.log("");
  for (const [doc, paths] of missing) {
    console.log(`  ${DOCS_DIR}${doc}`);
    for (const path of [...new Set(paths)].sort()) console.log(`      ← ${path}`);
  }
  console.log("");
  console.log("确实没有新说法要记就忽略(改个 typo、纯重构都算)。");
  console.log("判断标准见 AGENTS.md「文档同步」:改代码时需要先读某份文档才敢下手,那份就该一起改。");
  console.log("");

  if (strict) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/"))) {
  main();
}
