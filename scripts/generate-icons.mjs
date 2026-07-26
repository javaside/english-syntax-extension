// 用 Playwright 已装好的 Chromium 把 assets/icon.svg 光栅化成扩展需要的尺寸。
// PNG 落在 public/ 下，Vite 会原样复制到 dist/assets/ —— 与 manifest 里的
// icons 路径一致；直接放仓库根的 assets/ 不会进构建产物，扩展会因缺图标报错。
// 产物已提交，构建不依赖本脚本；改了 SVG 再跑一次即可。
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const svg = readFileSync(join(root, "assets", "icon.svg"), "utf8");
const sizes = [16, 32, 48, 128];

const browser = await chromium.launch();
try {
  for (const size of sizes) {
    const page = await browser.newPage({
      viewport: { width: size, height: size },
      deviceScaleFactor: 1,
    });
    await page.setContent(
      `<style>html,body{margin:0;padding:0}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
    );
    const png = await page.locator("svg").screenshot({ omitBackground: true });
    writeFileSync(join(root, "public", "assets", `icon-${size}.png`), png);
    await page.close();
    console.log(`public/assets/icon-${size}.png  ${png.length} bytes`);
  }
} finally {
  await browser.close();
}
