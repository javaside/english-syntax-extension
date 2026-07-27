import { describe, expect, it } from "vitest";
import {
  HANDLE_REACH,
  HANDLE_START,
  PROMO_SIZES,
  TREE_EDGES,
  TREE_NODES,
  TREE_SPAN,
  checkPromoImage,
  fitFontSize,
  promoLayout,
} from "./generate-promo.mjs";

/** 造一张纯色图,便于逐条构造违规。 */
function solid({ width, height, rgba }) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rgba[0];
    data[i + 1] = rgba[1];
    data[i + 2] = rgba[2];
    data[i + 3] = rgba[3];
  }
  return { width, height, data };
}

/** 蓝→红饱和渐变:与图标同一套色，是"合规"的基准。 */
function gradient(size) {
  const image = solid({ ...size, rgba: [0, 0, 0, 255] });
  for (let y = 0; y < size.height; y += 1) {
    for (let x = 0; x < size.width; x += 1) {
      const t = x / (size.width - 1);
      const i = (y * size.width + x) * 4;
      image.data[i] = Math.round(0x31 + t * (0xfd - 0x31));
      image.data[i + 1] = Math.round(0x74 + t * (0x37 - 0x74));
      image.data[i + 2] = Math.round(0xfc + t * (0x45 - 0xfc));
    }
  }
  return image;
}

function paintBorder(image, rgb) {
  const { width, height, data } = image;
  const set = (x, y) => {
    const i = (y * width + x) * 4;
    [data[i], data[i + 1], data[i + 2]] = rgb;
  };
  for (let x = 0; x < width; x += 1) {
    set(x, 0);
    set(x, height - 1);
  }
  for (let y = 0; y < height; y += 1) {
    set(0, y);
    set(width - 1, y);
  }
}

describe("PROMO_SIZES", () => {
  it("小图块 440×280、marquee 1400×560", () => {
    expect(PROMO_SIZES.small).toEqual({ width: 440, height: 280 });
    expect(PROMO_SIZES.marquee).toEqual({ width: 1400, height: 560 });
  });
});

describe("checkPromoImage", () => {
  it("饱和渐变、不透明、铺满——零违规", () => {
    expect(checkPromoImage(gradient(PROMO_SIZES.small), PROMO_SIZES.small)).toEqual([]);
  });

  it("尺寸不符时报出期望与实际", () => {
    const wrong = gradient({ width: 440, height: 279 });

    const violations = checkPromoImage(wrong, PROMO_SIZES.small);

    expect(violations.join("\n")).toMatch(/440×280/u);
    expect(violations.join("\n")).toMatch(/440×279/u);
  });

  // 商店把图片放在浅灰背景上，任何半透明都会透出灰底而不是"填满整个区域"。
  it("存在半透明像素时拒绝", () => {
    const translucent = gradient(PROMO_SIZES.small);
    translucent.data[3] = 128;

    expect(checkPromoImage(translucent, PROMO_SIZES.small).join("\n")).toMatch(/透明/u);
  });

  // "square corners with no padding"——白边就是 padding。
  it("四周留白边时拒绝", () => {
    const padded = gradient(PROMO_SIZES.small);
    paintBorder(padded, [255, 255, 255]);

    expect(checkPromoImage(padded, PROMO_SIZES.small).join("\n")).toMatch(/留白|边缘/u);
  });

  it("整张接近白色时拒绝——大面积白与浅灰是明确劝退项", () => {
    const washed = solid({ ...PROMO_SIZES.small, rgba: [245, 245, 247, 255] });

    expect(checkPromoImage(washed, PROMO_SIZES.small).join("\n")).toMatch(/浅色|白/u);
  });

  it("浅灰同样算——它不是白色，但一样会糊在商店背景上", () => {
    const gray = solid({ ...PROMO_SIZES.small, rgba: [230, 230, 230, 255] });

    expect(checkPromoImage(gray, PROMO_SIZES.small)).not.toEqual([]);
  });
});

describe("fitFontSize", () => {
  // 中文全角字符宽度≈字号，据此估算，无需真实字体度量。
  const measure = (text, size) => text.length * size;

  it("放得下时用理想字号", () => {
    expect(fitFontSize("英语句法可视化", 40, 400, measure)).toBe(40);
  });

  it("放不下时收窄到刚好放得下——440 图块的标题曾被右边界切掉", () => {
    const size = fitFontSize("英语句法可视化", 40, 210, measure);

    expect(size).toBeLessThan(40);
    expect(measure("英语句法可视化", size)).toBeLessThanOrEqual(210);
  });

  it("即使可用宽度极小也不返回 0 或负数", () => {
    expect(fitFontSize("英语句法可视化", 40, 1, measure)).toBeGreaterThan(0);
  });
});

describe("promoLayout", () => {
  const measure = (text, size) => text.length * size;
  const layoutFor = (size, copy) => promoLayout({ ...size, copy, measure });

  it("主视觉与文案整组水平居中——两侧留白相等", () => {
    const layout = layoutFor(PROMO_SIZES.small, { title: "英语句法可视化" });
    const leftGap = layout.glass.x - layout.glass.radius;
    const rightGap = PROMO_SIZES.small.width - layout.text.right;

    expect(Math.abs(leftGap - rightGap)).toBeLessThanOrEqual(2);
  });

  it.each([
    ["small", PROMO_SIZES.small, { title: "英语句法可视化" }],
    [
      "marquee",
      PROMO_SIZES.marquee,
      { title: "英语句法可视化", subtitle: "点句子看成分 · 点成分看详解" },
    ],
  ])("%s 的所有文字都在画布内", (_name, size, copy) => {
    const layout = layoutFor(size, copy);

    expect(layout.text.left).toBeGreaterThan(0);
    expect(layout.text.right).toBeLessThanOrEqual(size.width);
  });

  it("放大镜完整落在画布内", () => {
    for (const [size, copy] of [
      [PROMO_SIZES.small, { title: "英语句法可视化" }],
      [PROMO_SIZES.marquee, { title: "英语句法可视化", subtitle: "点句子看成分 · 点成分看详解" }],
    ]) {
      const { glass } = layoutFor(size, copy);
      // 手柄是右下方向最远的部分
      expect(glass.x - glass.radius).toBeGreaterThan(0);
      expect(glass.y + glass.radius * HANDLE_REACH).toBeLessThanOrEqual(size.height);
    }
  });

  it("副标题比主标题窄时，右边界按主标题算——留白不能歪", () => {
    const layout = layoutFor(PROMO_SIZES.marquee, { title: "英语句法可视化", subtitle: "短" });

    expect(layout.text.right - layout.text.left).toBeCloseTo(
      measure("英语句法可视化", layout.titleSize),
      0,
    );
  });
});

describe("句法树几何", () => {
  // 树画在镜片的裁剪区里:节点贴到镜圈上会被切掉一半，看着像脏点。
  // 半径用镜片半径的 0.115 倍(见 paintPromo)，这里按同一比例校验。
  const NODE_RADIUS_RATIO = 0.115;

  it("每个节点都完整落在镜片内，不与镜圈相切", () => {
    for (const node of TREE_NODES) {
      const dx = (node.x - 0.5) * TREE_SPAN;
      const dy = (node.y - 0.5) * TREE_SPAN;
      const distance = Math.hypot(dx, dy);
      const nodeRadius = NODE_RADIUS_RATIO * node.r;
      // 镜片半径归一化为 1;再留出描边宽度(0.17r 的一半)的余量
      expect(distance + nodeRadius, `节点 (${node.x}, ${node.y})`).toBeLessThan(1 - 0.17 / 2);
    }
  });

  it("每条边的两端都是存在的节点", () => {
    for (const [from, to] of TREE_EDGES) {
      expect(TREE_NODES[from]).toBeDefined();
      expect(TREE_NODES[to]).toBeDefined();
    }
  });

  it("树是连通的——除根之外每个节点都有父边", () => {
    const hasParent = new Set(TREE_EDGES.map(([, to]) => to));

    for (let index = 1; index < TREE_NODES.length; index += 1) {
      expect(hasParent.has(index), `节点 ${index} 没有父边`).toBe(true);
    }
  });

  // 手柄从镜圈外侧起笔。起点落在圈内会伸进镜片里，看着像跟右下叶子撞在一起。
  it("手柄整段都在镜圈之外", () => {
    expect(HANDLE_START).toBeGreaterThan(1);
    expect(HANDLE_REACH).toBeGreaterThan(HANDLE_START);
  });
});
