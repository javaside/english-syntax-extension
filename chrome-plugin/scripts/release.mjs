/**
 * 一条命令走完发版:改版本（扩展三处 + IDEA 插件）→ 跑全套门禁 → 打包 → 提交 →
 * 打 tag → 推送。
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
/** IntelliJ 插件的版本单点（仓库相对路径）;plugin.xml 不写 version,由它注入。 */
const GRADLE_VERSION_FILE = "intellij-plugin/build.gradle.kts";
/**
 * 发版这一步允许自己改动的文件（仓库相对路径），其余一律要求先提交。
 * 版本文件与商店手册在 chrome-plugin/ 内,CHANGELOG 与 IDEA 插件构建脚本在仓库根侧。
 */
const RELEASE_FILES = [
  ...VERSION_FILES.map((name) => `chrome-plugin/${name}`),
  "CHANGELOG.md",
  "chrome-plugin/docs/chrome-web-store.md",
  GRADLE_VERSION_FILE,
];

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
 * IntelliJ 插件与扩展同版本发布,所以它的版本也由这条命令改——两端各自维护版本
 * 只会重演商店手册那个坑:tag 发出去了,附件却还是上一版（这里更隐蔽,产物名里
 * 就带着版本号,`intellij-plugin-0.1.0-SNAPSHOT.zip` 会直接挂到 Release 上）。
 * CI 侧另有一道 tag↔gradle 版本比对。
 *
 * @param text build.gradle.kts 全文
 */
export function bumpGradleVersion(text, next) {
  const pattern = /^version = "[^"]*"$/mu;
  if (!pattern.test(text)) {
    throw new Error(`${GRADLE_VERSION_FILE} 里找不到 \`version = "…"\` 这一行,无法改版本`);
  }
  return text.replace(pattern, `version = "${next}"`);
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

/**
 * CHANGELOG 首行就声明「版本号遵循语义化版本」,而 semver 要求向后兼容的新功能
 * 升 MINOR。1.0.6 那次带着新功能只升了 patch,靠人记规矩没记住——所以改成发版时
 * 按本版说明里有没有「新增」一节自动判定。
 *
 * @param changelog CHANGELOG 全文
 * @param next      本次要发的版本
 * @param from      当前版本
 */
export function assertSemverBump(changelog, next, from) {
  const escaped = next.replace(/\./gu, "\\.");
  const pattern = new RegExp(`^## ${escaped} —.*?$([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, "mu");
  const section = pattern.test(changelog) ? changelog.match(pattern) : null;
  if (section === null) {
    throw new Error(`CHANGELOG 里没有 ${next} 这一节,发布说明先写好再发`);
  }
  const hasFeature = /^### 新增$/mu.test(section[1]);
  const [major, minor] = next.split(".").map(Number);
  const [fromMajor, fromMinor] = from.split(".").map(Number);
  const bumpedMajor = major > fromMajor;
  const bumpedMinor = major === fromMajor && minor > fromMinor;
  if (hasFeature && !bumpedMajor && !bumpedMinor) {
    throw new Error(
      `${next} 的说明里有「新增」一节,按语义化版本该升 MINOR(${fromMajor}.${fromMinor + 1}.0),` +
        `而不是 ${next}。只发修复时才用 patch。`,
    );
  }
}

/**
 * 商店上传手册里写着要传哪个 zip。1.0.6 那次发完才发现它还指着 1.0.5 的包——
 * 照着手册操作就会把上一版传进商店,所以这里也设一道闸。
 */
export function assertStoreDocVersion(doc, next) {
  const mentioned = doc.match(/english-syntax-extension-v(\d+\.\d+\.\d+)\.zip/u);
  if (mentioned === null || mentioned[1] !== next) {
    throw new Error(
      `chrome-plugin/docs/chrome-web-store.md 的上传物还写着 ${mentioned?.[1] ?? "(未标注)"},` +
        `本次要发 ${next}。先更新它,免得照着手册传错版本。`,
    );
  }
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
  // 脚本在 chrome-plugin/scripts/ 下:版本文件与商店手册在 chrome-plugin 内,
  // CHANGELOG 与 git 操作在仓库根。git status 必须从仓库根跑,porcelain 输出
  // 才是仓库相对路径,与 RELEASE_FILES 的匹配逻辑一致。
  const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."); // chrome-plugin
  const repoRoot = resolve(root, "..");
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const dryRun = args.includes("--dry-run");
  const version = parseVersion(args.find((a) => !a.startsWith("--")));

  assertReleasableTree(
    execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" }),
  );

  const files = Object.fromEntries(
    VERSION_FILES.map((name) => [name, readFileSync(join(root, name), "utf8")]),
  );
  const from = JSON.parse(files["package.json"]).version;
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
  // IDEA 插件的版本单点。prettier 不认 .kts,不能塞进下面那条 --write。
  const gradlePath = join(repoRoot, GRADLE_VERSION_FILE);
  writeFileSync(gradlePath, bumpGradleVersion(readFileSync(gradlePath, "utf8"), version));
  const changelogPath = join(repoRoot, "CHANGELOG.md");
  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(
    changelogPath,
    nextChangelogHeading(readFileSync(changelogPath, "utf8"), version, today),
  );
  // JSON.stringify 的换行策略与 prettier 不同（短数组它会拆成多行），改完直接
  // 交给 prettier 定稿，免得后面的格式检查因为脚本自己的输出而失败。
  // CHANGELOG 在仓库根,对它单独用绝对路径跑 prettier。
  execFileSync(
    "npx",
    ["prettier", "--write", ...VERSION_FILES.map((f) => join(root, f)), changelogPath],
    { cwd: root, stdio: "ignore" },
  );

  // 「准备就绪再交给人确认」的三道闸。以前这里只打印一句提醒就继续往下跑,
  // 于是「_待补充_」的说明、错版本的商店手册、不合 semver 的版本号都能发出去。
  const changelog = readFileSync(changelogPath, "utf8");
  if (changelog.includes(`## ${version} —`) && /_待补充_/u.test(changelog)) {
    throw new Error(
      `CHANGELOG 里 ${version} 一节还是「_待补充_」。发布说明该由人写,写好后重跑本命令。`,
    );
  }
  assertSemverBump(changelog, version, from);
  assertStoreDocVersion(readFileSync(join(root, "docs", "chrome-web-store.md"), "utf8"), version);
  console.log(`已改版本到 ${version}（含 IDEA 插件），说明与商店手册均已就位。`);

  for (const step of steps) {
    const [bin, argv] = step.command;
    // 提交前把改动加进暂存区——版本文件与 CHANGELOG 都是这一步产生的
    // 只暂存发版自己改的文件——add -A 会把未跟踪文件顺手带走。
    if (step.name === "提交") {
      execFileSync("git", ["add", ...RELEASE_FILES], { cwd: repoRoot, stdio: "inherit" });
    }
    console.log(`\n=== ${step.name} ===`);
    // npm/npx 步骤在 chrome-plugin 里跑;git 从仓库根跑,git add 的路径才对得上。
    const cwd = bin === "git" ? repoRoot : root;
    execFileSync(bin, argv, { cwd, stdio: "inherit" });
  }
  console.log(
    [
      ``,
      `=== 已就绪，等你确认 ===`,
      `本地与远端都已就位:版本 ${version}、tag v${version}、包 release/english-syntax-extension-v${version}.zip。`,
      `CI(.github/workflows/release.yml)会建一个 **草稿** Release——草稿是刻意的,正式发布由你按下。`,
      `草稿会附两个包:扩展 zip 与 IDEA 插件 zip(intellij-plugin-${version}.zip,CI 现场构建)。`,
      ``,
      `剩下两步只能由人做:`,
      `  1. 正式发布 GitHub Release:gh release edit v${version} --draft=false`,
      `     (先核对说明与附件:gh release view v${version})`,
      `  2. 上传 Chrome 网上应用店:按 chrome-plugin/docs/chrome-web-store.md 传 release/english-syntax-extension-v${version}.zip`,
      `     仓库里没有商店凭据,这一步不会被自动化。`,
    ].join("\n"),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
