/**
 * 强化的提示词 - 专门解决标点和空成分问题
 */

import { buildCorePrompt } from "../background/prompts";
import type { SentenceInput } from "../shared/protocol";

// 在原有提示词基础上，添加强化规则
export const ENHANCED_PUNCTUATION_RULE = `
CRITICAL RULES (MUST FOLLOW):
1. NEVER create a component that contains ONLY punctuation tokens
2. Punctuation may be INCLUDED at the end of a component with non-punctuation tokens, but NEVER alone
3. Every component MUST have a non-empty translation (Chinese text)
4. If uncertain about a component, merge it with an adjacent component rather than leaving it empty

WRONG EXAMPLES (DO NOT DO THIS):
❌ {"startToken": 5, "endToken": 5, "role": "OBJECT", "translation": "。"}  // Only punctuation
❌ {"startToken": 3, "endToken": 3, "role": "ADVERBIAL", "translation": ","}  // Only punctuation
❌ {"startToken": 2, "endToken": 4, "role": "SUBJECT", "translation": ""}  // Empty translation

CORRECT EXAMPLES:
✅ {"startToken": 2, "endToken": 4, "role": "SUBJECT", "translation": "软件开发"}  // Has text + punctuation is OK at end
✅ {"startToken": 5, "endToken": 7, "role": "PREDICATE", "translation": "已经改变。"}  // Punctuation at end is OK
`;

/**
 * 构建增强的核心分析提示词
 */
export function buildEnhancedCorePrompt(sentences: readonly SentenceInput[]): string {
  const originalPrompt = buildCorePrompt(sentences);

  // 在原提示词后添加强化规则
  return originalPrompt + "\n\n" + ENHANCED_PUNCTUATION_RULE;
}
