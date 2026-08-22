/**
 * 语法角色 → 颜色 / 中文标签。与 Chrome 端 `learning-block.ts` / `grammar.ts`
 * 逐值对齐——两端视觉必须一致，改任何一边都要同步另一边。
 */

export const ROLE_COLORS: Readonly<Record<string, string>> = {
  SUBJECT: "#2563eb",
  PREDICATE: "#dc2626",
  OBJECT: "#059669",
  PREDICATIVE: "#0891b2",
  ATTRIBUTE: "#7c3aed",
  ADVERBIAL: "#d97706",
  COMPLEMENT: "#be185d",
  APPOSITIVE: "#6b7280",
  SUBJECT_CLAUSE: "#2563eb",
  OBJECT_CLAUSE: "#059669",
  PREDICATIVE_CLAUSE: "#0891b2",
  ATTRIBUTIVE_CLAUSE: "#7c3aed",
  ADVERBIAL_CLAUSE: "#d97706",
  INDEPENDENT_ELEMENT: "#6b7280",
  COORDINATE_CLAUSE: "#0d9488",
  CONJUNCTION: "#6b7280",
};

/**
 * IDEA 深色主题下的提亮色板：保持各角色色相，但提高明度，保证深色背景可读。
 * 只影响 IDEA 端（由 Kotlin 检测 JBColor.isBright() 注入是否深色）；
 * 浅色主题仍走 ROLE_COLORS 与 Chrome 端逐值一致。
 */
const ROLE_COLORS_DARK: Readonly<Record<string, string>> = {
  SUBJECT: "#60a5fa",
  PREDICATE: "#f87171",
  OBJECT: "#34d399",
  PREDICATIVE: "#22d3ee",
  ATTRIBUTE: "#a78bfa",
  ADVERBIAL: "#fbbf24",
  COMPLEMENT: "#f472b6",
  APPOSITIVE: "#9ca3af",
  SUBJECT_CLAUSE: "#60a5fa",
  OBJECT_CLAUSE: "#34d399",
  PREDICATIVE_CLAUSE: "#22d3ee",
  ATTRIBUTIVE_CLAUSE: "#a78bfa",
  ADVERBIAL_CLAUSE: "#fbbf24",
  INDEPENDENT_ELEMENT: "#9ca3af",
  COORDINATE_CLAUSE: "#2dd4bf",
  CONJUNCTION: "#9ca3af",
};

export const GRAMMAR_LABELS: Readonly<Record<string, string>> = {
  SUBJECT: "主语",
  PREDICATE: "谓语",
  OBJECT: "宾语",
  PREDICATIVE: "表语",
  ATTRIBUTE: "定语",
  ADVERBIAL: "状语",
  COMPLEMENT: "补语",
  APPOSITIVE: "同位语",
  SUBJECT_CLAUSE: "主语从句",
  OBJECT_CLAUSE: "宾语从句",
  PREDICATIVE_CLAUSE: "表语从句",
  ATTRIBUTIVE_CLAUSE: "定语从句",
  ADVERBIAL_CLAUSE: "状语从句",
  INDEPENDENT_ELEMENT: "独立成分",
  COORDINATE_CLAUSE: "并列分句",
  CONJUNCTION: "并列连词",
};

const FALLBACK_COLOR = "#6b7280";
const FALLBACK_COLOR_DARK = "#9ca3af";

/** IDEA 深色主题开关：由 Kotlin 检测 JBColor.isBright() 后经 bootstrap 设置。默认浅色。 */
let darkMode = false;

/** 供 bootstrap / 主题监听设置深色模式；浅色模式恢复与 Chrome 端一致的默认色。 */
export function setDarkMode(dark: boolean): void {
  darkMode = dark;
}

/** 测试辅助：读当前深色开关状态。 */
export function isDarkMode(): boolean {
  return darkMode;
}

/** core 成分：role 是英文枚举；渲染标签用中文，颜色按枚举查。 */
export function roleLabel(role: string): string {
  return GRAMMAR_LABELS[role] ?? role;
}

function paletteFor(dark: boolean): Readonly<Record<string, string>> {
  return dark ? ROLE_COLORS_DARK : ROLE_COLORS;
}

export function roleColor(role: string): string {
  const palette = paletteFor(darkMode);
  return palette[role] ?? (darkMode ? FALLBACK_COLOR_DARK : FALLBACK_COLOR);
}

/**
 * 详解 structure 的 role 是模型自由文本：优先中文标签精确匹配，若为已知
 * 英文枚举则映射后查色，否则灰色。与 Chrome 端 structureColor 同构。
 */
export function structureColor(role: string): string {
  const palette = paletteFor(darkMode);
  const byLabel = Object.entries(GRAMMAR_LABELS).find(([, label]) => label === role);
  if (byLabel !== undefined) {
    return palette[byLabel[0]] ?? (darkMode ? FALLBACK_COLOR_DARK : FALLBACK_COLOR);
  }
  return palette[role] ?? (darkMode ? FALLBACK_COLOR_DARK : FALLBACK_COLOR);
}

/** Chrome 端同款圈号：1-20 用 ①…，超出退回普通数字。 */
export function circledNumber(value: number): string {
  return value >= 1 && value <= 20 ? String.fromCodePoint(0x2460 + value - 1) : `${value}`;
}
