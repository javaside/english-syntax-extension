// 把 dist/ 打成可直接「加载已解压的扩展程序」的 zip。
// 名字带版本号，避免下载目录里几个同名 zip 分不清是哪一版。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
if (!existsSync(join(dist, "manifest.json"))) {
  console.error("dist/manifest.json 不存在，先跑 npm run build");
  process.exit(1);
}

const { version } = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8"));
const outDir = join(root, "release");
mkdirSync(outDir, { recursive: true });
const zip = join(outDir, `english-syntax-extension-v${version}.zip`);
rmSync(zip, { force: true });

// -r 递归、-X 不写入 macOS 扩展属性(否则 zip 里会混进 __MACOSX 垃圾)。
// 排除 source map:它们占了未压缩体积的七成，而源码本来就在 GitHub 上公开，
// 想调试的人可以自己构建。商店审核也不必为一堆用不上的大文件买单。
execFileSync("zip", ["-r", "-X", "-q", zip, ".", "-x", "*.map"], {
  cwd: dist,
  stdio: "inherit",
});
const entries = execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" }).trim().split("\n");
console.log(`${zip}`);
console.log(`条目数: ${entries.length}`);
for (const required of ["manifest.json", "content-script.js"]) {
  if (!entries.includes(required)) {
    console.error(`打包结果缺少 ${required}`);
    process.exit(1);
  }
}
