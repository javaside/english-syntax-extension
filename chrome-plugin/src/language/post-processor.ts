/**
 * 改进方案实施：后处理 + 强化提示词
 */

import { tokenize } from "./segmenter";
import type { Token } from "../shared/grammar";

/**
 * 后处理函数：移除只包含标点的成分
 */
export function removeOnlyPunctuationComponents(
  components: any[],
  tokens: Token[]
): { cleaned: any[]; removed: number } {
  const cleaned = components.filter(component => {
    const componentTokens = tokens.filter(
      token => token.id >= component.startToken && token.id <= component.endToken
    );

    // 如果所有 token 都是标点，则移除此成分
    const hasNonPunctuation = componentTokens.some(token => !token.punctuation);
    return hasNonPunctuation;
  });

  return {
    cleaned,
    removed: components.length - cleaned.length,
  };
}

/**
 * 后处理函数：填充空的 translation
 */
export function fillEmptyTranslations(components: any[]): { fixed: any[]; filled: number } {
  let filledCount = 0;

  const fixed = components.map(component => {
    if (!component.translation || component.translation.trim() === "") {
      filledCount++;
      return {
        ...component,
        translation: "[待补充]", // 标记为需要补充
      };
    }
    return component;
  });

  return {
    fixed,
    filled: filledCount,
  };
}

/**
 * 后处理函数：验证并修复 token 覆盖
 */
export function fixTokenCoverage(
  components: any[],
  tokens: Token[]
): { fixed: any[]; issues: string[] } {
  const issues: string[] = [];
  const nonPuncTokens = tokens.filter(t => !t.punctuation);

  // 检查哪些非标点 token 未被覆盖
  const covered = new Set<number>();
  components.forEach(c => {
    for (let i = c.startToken; i <= c.endToken; i++) {
      covered.add(i);
    }
  });

  const uncovered = nonPuncTokens.filter(t => !covered.has(t.id));

  if (uncovered.length > 0) {
    issues.push(`未覆盖的 tokens: ${uncovered.map(t => `${t.id}:${t.text}`).join(", ")}`);
  }

  // 当前版本只报告问题，不自动修复（自动修复太复杂且可能引入错误）
  return {
    fixed: components,
    issues,
  };
}

/**
 * 综合后处理管道
 */
export function postProcessAnnotation(
  components: any[],
  tokens: Token[]
): {
  components: any[];
  changes: {
    removedPunctuation: number;
    filledTranslations: number;
    issues: string[];
  };
} {
  // 步骤 1: 移除纯标点成分
  const { cleaned, removed } = removeOnlyPunctuationComponents(components, tokens);

  // 步骤 2: 填充空翻译
  const { fixed, filled } = fillEmptyTranslations(cleaned);

  // 步骤 3: 检查覆盖问题
  const { fixed: final, issues } = fixTokenCoverage(fixed, tokens);

  return {
    components: final,
    changes: {
      removedPunctuation: removed,
      filledTranslations: filled,
      issues,
    },
  };
}
