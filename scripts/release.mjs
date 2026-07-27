/**
 * 一条命令走完发版:改版本 → 跑全套门禁 → 打包 → 提交 → 打 tag → 推送。
 *
 * 存在的理由很具体——这套流程我手工做了五次，栽了三次:两次改完版本忘了
 * `npm run package`（本地 release/ 里躺着上一版的包），一次 format:check 报错
 * 却没看结果就 commit + push，把红 CI 推了出去。这些都是"记得就没事"的步骤，
 * 而记性不该是发版流程的一环。
 *
 *   npm run release -- 1.0.5
 *   npm run release -- 1.0.5 --dry-run    # 只打印将要执行的步骤
 *
 * 版本一致性在 CI 侧也有一道校验（.github/workflows/release.yml），这里是本地
 * 的第一道闸:让不一致在推送之前就暴露。
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION_FILES = ["manifest.json", "package.json", "package-lock.json"];
/** 发版这一步允许自己改动的文件，其余一律要求先提交。 */
const RELEASE_FILES = [...VERSION_FILES, "CHANGELOG.md", "docs/chrome-web-store.md"];

export function parseVersion(raw) {
  const value = String(raw ?? "").replace(/^v/u, "");
  if (!/^\d+\.\d+\.\d+$/u.test(value)) {
    throw new Error(`版本号必须形如 1.0.5，收到:${JSON.stringify(raw)}`);
  }
  return value;
}

function compare(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * 三处版本一起改。lock 有两个版本字段（根与 packages[""]），漏掉任一个都会让
 * `npm ci` 报版本漂移。
 *
 * @param files 文件名 → 原始文本
 * @returns 文件名 → 新文本
 */
export function bumpVersionFiles(files, next) {
  const current = new Map();
  for (const name of VERSION_FILES) {
    current.set(name, JSON.parse(files[name]).version);
  }
  const distinct = new Set(current.values());
  if (distinct.size > 1) {
    const detail = [...current].map(([name, v]) => `${name}=${v}`).join(" ");
    throw new Error(`发版前三处版本必须一致，先修好再发:${detail}`);
  }
  const from = [...distinct][0];
  if (compare(next, from) <= 0) {
    throw new Error(`新版本 ${next} 必须高于当前版本 ${from}`);
  }

  const out = {};
  for (const name of VERSION_FILES) {
    const parsed = JSON.parse(files[name]);
    parsed.version = next;
    if (name === "package-lock.json" && parsed.packages?.[""] !== undefined) {
      parsed.packages[""].version = next;
    }
    out[name] = `${JSON.stringify(parsed, null, 2)}\n`;
  }
  return out;
}

/**
 * 发版只该动版本文件与说明。上一次我用 `git add -A` 把两份无关的旧文档一起
 * 提交、还推了红 CI——所以这里宁可拒绝，也不替人决定该带什么进提交。
 *
 * @param porcelain `git status --porcelain` 的输出
 */
export function assertReleasableTree(porcelain) {
  const stray = porcelain
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^\S+\s+/u, ""))
    .filter((file) => !RELEASE_FILES.includes(file));
  if (stray.length > 0) {
    throw new Error(`工作区有与发版无关的改动，请先提交或撤销:\n  ${stray.join("\n  ")}`);
  }
}

/**
 * 只补标题行，不替用户写正文——发布说明该由人写。已经手写好该版本时原样返回。
 */
export function nextChangelogHeading(changelog, version, date) {
  if (changelog.includes(`## ${version} —`)) return changelog;
  const firstHeading = changelog.indexOf("\n## ");
  const heading = `## ${version} — ${date}\n\n_待补充_\n\n`;
  if (firstHeading === -1) return `${changelog.trimEnd()}\n\n${heading}`;
  return `${changelog.slice(0, firstHeading + 1)}${heading}${changelog.slice(firstHeading + 1)}`;
}

/** 发版步骤。顺序本身就是不变量，由测试钉住。 */
export function releaseSteps(version) {
  return [
    { name: "单元测试", command: ["npm", ["test"]] },
    { name: "E2E", command: ["npx", ["playwright", "test"]] },
    { name: "lint 基线", command: ["npm", ["run", "lint:baseline"]] },
    { name: "格式检查", command: ["npm", ["run", "format:check"]] },
    { name: "打包", command: ["npm", ["run", "package"]] },
    { name: "提交", command: ["git", ["commit", "-q", "-m", `chore: 发布 ${version}`]] },
    { name: "打 tag", command: ["git", ["tag", "-a", `v${version}`, "-m", `发布 ${version}`]] },
    { name: "推送分支", command: ["git", ["push", "origin", "HEAD"]] },
    { name: "推送 tag", command: ["git", ["push", "origin", `v${version}`]] },
  ];
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const dryRun = args.includes("--dry-run");
  const version = parseVersion(args.find((a) => !a.startsWith("--")));

  assertReleasableTree(
    execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }),
  );

  const files = Object.fromEntries(
    VERSION_FILES.map((name) => [name, readFileSync(join(root, name), "utf8")]),
  );
  const bumped = bumpVersionFiles(files, version);

  const steps = releaseSteps(version);
  if (dryRun) {
    console.log(`将发布 ${version}，步骤:`);
    for (const [index, step] of steps.entries()) {
      const [bin, argv] = step.command;
      console.log(`  ${index + 1}. ${step.name}: ${bin} ${argv.join(" ")}`);
    }
    return;
  }

  for (const [name, text] of Object.entries(bumped)) writeFileSync(join(root, name), text);
  const changelogPath = join(root, "CHANGELOG.md");
  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(
    changelogPath,
    nextChangelogHeading(readFileSync(changelogPath, "utf8"), version, today),
  );
  // JSON.stringify 的换行策略与 prettier 不同（短数组它会拆成多行），改完直接
  // 交给 prettier 定稿，免得后面的格式检查因为脚本自己的输出而失败。
  execFileSync("npx", ["prettier", "--write", ...VERSION_FILES, "CHANGELOG.md"], {
    cwd: root,
    stdio: "ignore",
  });
  console.log(`已改版本到 ${version}；若 CHANGELOG 是「_待补充_」请先补写再继续。`);

  for (const step of steps) {
    const [bin, argv] = step.command;
    // 提交前把改动加进暂存区——版本文件与 CHANGELOG 都是这一步产生的
    // 只暂存发版自己改的文件——add -A 会把未跟踪文件顺手带走。
    if (step.name === "提交") {
      execFileSync("git", ["add", ...RELEASE_FILES], { cwd: root, stdio: "inherit" });
    }
    console.log(`\n=== ${step.name} ===`);
    execFileSync(bin, argv, { cwd: root, stdio: "inherit" });
  }
  console.log(`\n完成。Release 流水线会建草稿，确认后手动发布。`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
