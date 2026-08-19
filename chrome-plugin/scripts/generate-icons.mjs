// 从 assets/icon_chrome.png 生成扩展需要的图标尺寸。
//
// 源图是 1254×1254、带白底与投影的方形图，直接缩放有三个问题:白底在深色工具栏
// 上会显出白方块、四周约 11% 的留白让 16px 下的实际内容更小、RGB 无 alpha。
// 这里先按饱和度探出徽章本体(投影是低饱和的灰，会被排除)，补成正方形，再用圆角
// 蒙版切出透明背景。
//
// 产物已提交，构建不依赖本脚本；换了源图再跑 `npm run icons`。
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "assets", "icon_chrome.png");
const sizes = [16, 32, 48, 128];
const dataUrl = `data:image/png;base64,${readFileSync(source).toString("base64")}`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto("about:blank");

  const bounds = await page.evaluate(async (url) => {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const context = canvas.getContext("2d");
    context.drawImage(img, 0, 0);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let minX = canvas.width;
    let minY = canvas.height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        const i = (y * canvas.width + x) * 4;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        // 饱和度足够高才算徽章本体:白底与灰投影都会被排除
        const saturation = Math.max(r, g, b) - Math.min(r, g, b);
        if (saturation > 60) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    return { minX, minY, maxX, maxY };
  }, dataUrl);

  const width = bounds.maxX - bounds.minX + 1;
  const height = bounds.maxY - bounds.minY + 1;
  const side = Math.max(width, height);
  // 以内容框中心取正方形，避免裁偏
  const cropX = bounds.minX + width / 2 - side / 2;
  const cropY = bounds.minY + height / 2 - side / 2;
  console.log(
    `徽章本体: ${width}x${height} @ (${bounds.minX},${bounds.minY}) → 裁 ${side}x${side}`,
  );

  for (const size of sizes) {
    const base64 = await page.evaluate(
      async ({ url, size, cropX, cropY, side }) => {
        const img = new Image();
        img.src = url;
        await img.decode();
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const context = canvas.getContext("2d");
        context.imageSmoothingQuality = "high";
        context.drawImage(img, cropX, cropY, side, side, 0, 0, size, size);
        // 圆角蒙版:半径取 22%，与源图徽章的圆角观感一致
        context.globalCompositeOperation = "destination-in";
        const radius = size * 0.22;
        context.beginPath();
        context.roundRect(0, 0, size, size, radius);
        context.fill();
        return canvas.toDataURL("image/png").split(",")[1];
      },
      { url: dataUrl, size, cropX, cropY, side },
    );
    const png = Buffer.from(base64, "base64");
    writeFileSync(join(root, "public", "assets", `icon-${size}.png`), png);
    console.log(`public/assets/icon-${size}.png  ${png.length} bytes`);
  }
} finally {
  await browser.close();
}
