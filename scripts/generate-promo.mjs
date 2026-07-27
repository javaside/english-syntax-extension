/**
 * 生成 Chrome 商店的两张宣传图块。
 *
 *   npm run promo
 *
 * 商店图标(128×128 方形徽章)与宣传图块是两种东西:图标要求缩到 16px 仍可辨,
 * 宣传图块是横幅，Google 明确说"不要只放截图，主要任务是传达品牌"。所以这里不
 * 缩放图标，而是用同一组色值(从 assets/icon_chrome.png 采样得来)重画横幅，让
 * 两者看起来出自同一个插件。
 *
 * 图块的硬性约束来自官方 Supplying Images 文档:填满整个区域、方角零 padding、
 * 假设背景是浅灰因此避免大面积白与浅灰、用饱和色、少放文字、缩到一半仍可读。
 * 前四条能机器验，生成后由 checkPromoImage 自查——肉眼容易漏掉半透明边缘。
 *
 * 宣传图不做本地化(截图可以)，文案固定中文:主要用户是中文母语者。
 *
 * 产物写到 store-assets/(已 gitignore)，脚本本身进仓库:改文案重跑即可。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PROMO_SIZES = {
  small: { width: 440, height: 280 },
  marquee: { width: 1400, height: 560 },
};

/** 与 public/assets/icon-*.png 同源:从图标四角采样得到的蓝→红。 */
const BRAND = {
  blue: "#3174fc",
  deepBlue: "#2159d6",
  red: "#fd3745",
};

/**
 * 画面里的句法树:节点相对坐标(0–1)与连线，照图标里放大镜内的结构。
 * 坐标以 TREE_SPAN 映射到镜片内，节点必须完整落在镜圈里——贴到圈上会被裁掉半边。
 */
export const TREE_NODES = [
  { x: 0.5, y: 0.14, r: 1.15 },
  { x: 0.27, y: 0.5, r: 1 },
  { x: 0.73, y: 0.5, r: 1 },
  { x: 0.14, y: 0.83, r: 0.85 },
  { x: 0.4, y: 0.83, r: 0.85 },
  { x: 0.86, y: 0.83, r: 0.85 },
];
export const TREE_EDGES = [
  [0, 1],
  [0, 2],
  [1, 3],
  [1, 4],
  [2, 5],
];
/** 归一化坐标铺开到镜片半径的这个倍数。 */
export const TREE_SPAN = 1.24;

const COPY = {
  small: { title: "英语句法可视化", subtitle: undefined },
  marquee: { title: "英语句法可视化", subtitle: "点句子看成分 · 点成分看详解" },
};

/**
 * 放大镜手柄的起讫，单位是镜片半径。起点必须在圈外(>1):第一版从 0.78r 起笔，
 * 手柄伸进镜片内部，和右下角那片叶子叠在一起。
 */
export const HANDLE_START = 1.02;
export const HANDLE_REACH = 1.62;

/**
 * 按可用宽度收窄字号。理想字号放得下就用它，放不下则缩到刚好放得下。
 *
 * 440×280 的标题第一版就被右边界切掉了:小图块的可用宽度只有 marquee 的三分之一，
 * 而字号是按 min(width,height) 定的——高度相同，字号就相同。
 *
 * @param measure (text, size) => 宽度;浏览器侧传 canvas 的 measureText。
 */
export function fitFontSize(text, ideal, available, measure) {
  const width = measure(text, ideal);
  if (width <= available) return ideal;
  // 中文字宽近似线性于字号，一次换算即可;取下界并留 1px 余量防四舍五入越界。
  return Math.max(1, Math.floor((ideal * available) / width));
}

/**
 * 定出主视觉与文案的位置:先按可用宽度收窄字号，再把「放大镜 + 文案」整组水平居中。
 *
 * 分离成纯函数是因为溢出与偏心都只在几何上体现，肉眼看缩略图看不出差 3px;
 * 画布侧只负责照这份布局落笔。
 */
export function promoLayout({ width, height, copy, measure }) {
  const unit = Math.min(width, height);
  const radius = unit * (width < 600 ? 0.26 : 0.32);
  // 上下都要放得下手柄，镜心因此略偏上
  const centerY = Math.min(height * 0.48, height - radius * HANDLE_REACH);
  const gapToText = radius * 0.45;
  // 主视觉整体占宽:镜片直径 + 手柄超出右侧的部分
  const glassWidth = radius * (1 + HANDLE_REACH);

  const idealTitle = unit * (copy.subtitle === undefined ? 0.155 : 0.135);
  const idealSubtitle = unit * 0.075;
  // 先给文案留下扣掉主视觉与两侧最小留白后的宽度
  const margin = width * 0.05;
  const available = width - glassWidth - gapToText - margin * 2;
  const titleSize = fitFontSize(copy.title, idealTitle, available, measure);
  const subtitleSize =
    copy.subtitle === undefined ? 0 : fitFontSize(copy.subtitle, idealSubtitle, available, measure);
  // 右边界按最宽的一行算，否则短副标题会让整组看着偏左
  const textWidth = Math.max(
    measure(copy.title, titleSize),
    copy.subtitle === undefined ? 0 : measure(copy.subtitle, subtitleSize),
  );

  const groupWidth = glassWidth + gapToText + textWidth;
  const groupLeft = (width - groupWidth) / 2;
  const textLeft = groupLeft + glassWidth + gapToText;
  return {
    glass: { x: groupLeft + radius, y: centerY, radius },
    text: { left: textLeft, right: textLeft + textWidth },
    titleSize,
    subtitleSize,
  };
}

/**
 * 逐条对应官方图片规范里可机器验的部分。传入 ImageData 形状的对象。
 *
 * @returns 违规描述数组;空数组表示通过。
 */
export function checkPromoImage(image, expected) {
  const violations = [];
  if (image.width !== expected.width || image.height !== expected.height) {
    violations.push(
      `尺寸应为 ${expected.width}×${expected.height}，实际 ${image.width}×${image.height}`,
    );
    return violations;
  }

  const { width, height, data } = image;
  let translucent = 0;
  let lightPixels = 0;
  const total = width * height;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 255) translucent += 1;
    // 白与浅灰同样劝退:按亮度判定，不只看纯白。
    const luminance = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
    const saturation =
      Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]);
    if (luminance > 200 && saturation < 40) lightPixels += 1;
  }
  if (translucent > 0) {
    violations.push(`存在 ${translucent} 个半透明像素;商店背景是浅灰，会透出来`);
  }
  if (lightPixels / total > 0.5) {
    violations.push(
      `${Math.round((lightPixels / total) * 100)}% 的像素是白或浅灰;应改用饱和色填满`,
    );
  }

  // 方角零 padding:四条边本身必须是画面内容，不能是浅色留白。
  const edgeIsLight = (x, y) => {
    const i = (y * width + x) * 4;
    const luminance = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
    const saturation =
      Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]);
    return luminance > 200 && saturation < 40;
  };
  let lightEdge = 0;
  let edgeSamples = 0;
  for (let x = 0; x < width; x += 1) {
    for (const y of [0, height - 1]) {
      edgeSamples += 1;
      if (edgeIsLight(x, y)) lightEdge += 1;
    }
  }
  for (let y = 0; y < height; y += 1) {
    for (const x of [0, width - 1]) {
      edgeSamples += 1;
      if (edgeIsLight(x, y)) lightEdge += 1;
    }
  }
  if (lightEdge / edgeSamples > 0.2) {
    violations.push(`${Math.round((lightEdge / edgeSamples) * 100)}% 的边缘像素是浅色留白`);
  }
  return violations;
}

/** 文案字体。字宽严格线性于字号，所以量一次参考字号就能换算任意字号。 */
const FONT_STACK = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
const REFERENCE_FONT_SIZE = 100;

/** 在 canvas 上画一张图块。跑在浏览器上下文里,只能用参数传进来的东西。 */
function paintPromo({
  width,
  height,
  brand,
  tree,
  edges,
  treeSpan,
  copy,
  layout,
  fontStack,
  handleStart,
  handleReach,
}) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");

  // 底:蓝→红对角渐变，饱和度贴近图标
  const background = context.createLinearGradient(0, 0, width, height);
  background.addColorStop(0, brand.deepBlue);
  background.addColorStop(0.45, brand.blue);
  background.addColorStop(1, brand.red);
  context.fillStyle = background;
  context.fillRect(0, 0, width, height);

  // 极轻的暗角:让白色前景在缩到一半时仍有对比，同时不引入浅色
  const vignette = context.createRadialGradient(
    width * 0.5,
    height * 0.5,
    0,
    width * 0.5,
    height * 0.5,
    Math.max(width, height) * 0.75,
  );
  vignette.addColorStop(0, "rgba(0,0,0,0)");
  vignette.addColorStop(1, "rgba(0,0,0,0.28)");
  context.fillStyle = vignette;
  context.fillRect(0, 0, width, height);

  const { x: glassCenterX, y: glassCenterY, radius: glassRadius } = layout.glass;
  const stroke = glassRadius * 0.17;

  // 放大镜手柄
  context.save();
  context.strokeStyle = "rgba(255,255,255,0.95)";
  context.lineCap = "round";
  context.lineWidth = stroke;
  context.beginPath();
  const diagonal = Math.SQRT1_2;
  context.moveTo(
    glassCenterX + glassRadius * handleStart * diagonal,
    glassCenterY + glassRadius * handleStart * diagonal,
  );
  context.lineTo(
    glassCenterX + glassRadius * handleReach * diagonal,
    glassCenterY + glassRadius * handleReach * diagonal,
  );
  context.stroke();

  // 镜片:半透明白圈 + 白描边,内部放句法树
  context.beginPath();
  context.arc(glassCenterX, glassCenterY, glassRadius, 0, Math.PI * 2);
  context.fillStyle = "rgba(255,255,255,0.16)";
  context.fill();
  context.lineWidth = stroke * 0.85;
  context.stroke();

  context.save();
  context.beginPath();
  context.arc(glassCenterX, glassCenterY, glassRadius, 0, Math.PI * 2);
  context.clip();
  const span = glassRadius * treeSpan;
  const nodeAt = (node) => ({
    x: glassCenterX + (node.x - 0.5) * span,
    y: glassCenterY + (node.y - 0.5) * span,
    r: glassRadius * 0.115 * node.r,
  });
  context.strokeStyle = "rgba(255,255,255,0.85)";
  context.lineWidth = glassRadius * 0.05;
  for (const [from, to] of edges) {
    const a = nodeAt(tree[from]);
    const b = nodeAt(tree[to]);
    context.beginPath();
    context.moveTo(a.x, a.y);
    context.lineTo(b.x, b.y);
    context.stroke();
  }
  for (const [index, node] of tree.entries()) {
    const point = nodeAt(node);
    context.beginPath();
    context.arc(point.x, point.y, point.r, 0, Math.PI * 2);
    // 根与一层用白，末级用图标里的红，呼应"成分"高亮
    context.fillStyle = index >= 3 ? "#ffd8dc" : "#ffffff";
    context.fill();
  }
  context.restore();
  context.restore();

  // 文案:一行主标题，marquee 多一行副标题。字号已由布局按可用宽度收窄。
  context.textBaseline = "middle";
  context.fillStyle = "#ffffff";
  context.shadowColor = "rgba(0,0,0,0.32)";
  context.shadowBlur = Math.min(width, height) * 0.03;
  context.font = `700 ${Math.round(layout.titleSize)}px ${fontStack}`;
  if (copy.subtitle === undefined) {
    context.fillText(copy.title, layout.text.left, height * 0.5);
  } else {
    context.fillText(copy.title, layout.text.left, height * 0.42);
    context.font = `700 ${Math.round(layout.subtitleSize)}px ${fontStack}`;
    context.fillStyle = "rgba(255,255,255,0.92)";
    context.fillText(copy.subtitle, layout.text.left, height * 0.63);
  }

  const { data } = context.getImageData(0, 0, width, height);
  return { png: canvas.toDataURL("image/png").split(",")[1], pixels: [...data] };
}

/** 在浏览器里量出各行在参考字号下的宽度。 */
function measureTexts({ texts, fontStack, referenceSize }) {
  const context = document.createElement("canvas").getContext("2d");
  context.font = `700 ${referenceSize}px ${fontStack}`;
  return Object.fromEntries(texts.map((text) => [text, context.measureText(text).width]));
}

async function main() {
  const { chromium } = await import("@playwright/test");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const outDir = join(root, "store-assets");
  mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch();
  const failures = [];
  try {
    const page = await browser.newPage();
    await page.goto("about:blank");

    // 先量字宽:布局是纯函数(有单测)，把它需要的度量从浏览器取回来，
    // 而不是把布局代码送进浏览器执行。
    const texts = [...new Set(Object.values(COPY).flatMap((c) => [c.title, c.subtitle]))].filter(
      (text) => text !== undefined,
    );
    const reference = await page.evaluate(measureTexts, {
      texts,
      fontStack: FONT_STACK,
      referenceSize: REFERENCE_FONT_SIZE,
    });
    const measure = (text, size) => (reference[text] / REFERENCE_FONT_SIZE) * size;

    for (const [name, size] of Object.entries(PROMO_SIZES)) {
      const copy = COPY[name];
      const layout = promoLayout({ ...size, copy, measure });
      const result = await page.evaluate(paintPromo, {
        ...size,
        brand: BRAND,
        tree: TREE_NODES,
        edges: TREE_EDGES,
        treeSpan: TREE_SPAN,
        copy,
        layout,
        fontStack: FONT_STACK,
        handleStart: HANDLE_START,
        handleReach: HANDLE_REACH,
      });
      const violations = checkPromoImage(
        { ...size, data: Uint8ClampedArray.from(result.pixels) },
        size,
      );
      const fileName = `promo-${name}-${size.width}x${size.height}.png`;
      const png = Buffer.from(result.png, "base64");
      writeFileSync(join(outDir, fileName), png);
      console.log(`store-assets/${fileName}  ${png.length} bytes`);
      for (const violation of violations) {
        failures.push(`${name}: ${violation}`);
        console.error(`  ✗ ${violation}`);
      }
    }
  } finally {
    await browser.close();
  }
  if (failures.length > 0) {
    console.error(`\n${failures.length} 处不符合商店图片规范。`);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
