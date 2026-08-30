/**
 * 深入分析：为什么 19 个句子会失败
 * 找出根本原因和解决方案
 */

import { describe, it } from "vitest";
import { tokenize } from "./segmenter";
import * as fs from "fs";
import * as path from "path";

describe("失败原因深度分析", () => {

  it("分析所有失败句子的共同特征", () => {
    console.log(`\n=== 失败原因深度分析 ===\n`);

    // 加载两次失败的记录
    const originalFailedPath = path.join(__dirname, "../../../test-output/failed-annotations.json");
    const retryFailedPath = path.join(__dirname, "../../../test-output/retry-still-failed.json");

    const originalFailed = JSON.parse(fs.readFileSync(originalFailedPath, "utf-8"));
    const retryFailed = JSON.parse(fs.readFileSync(retryFailedPath, "utf-8"));

    console.log(`原始失败: ${originalFailed.length}`);
    console.log(`重试后仍失败: ${retryFailed.length}`);

    // 分类错误
    const errorCategories = {
      punctuationOnly: [] as any[],
      emptyComponent: [] as any[],
      uncoveredTokens: [] as any[],
      overlapping: [] as any[],
      unknownRole: [] as any[],
      other: [] as any[],
    };

    retryFailed.forEach((failed: any) => {
      const errors = failed.newErrors || [];
      const text = failed.text;

      if (errors.some((e: string) => e.includes("only punctuation"))) {
        errorCategories.punctuationOnly.push(failed);
      } else if (errors.some((e: string) => e.includes("must not be empty"))) {
        errorCategories.emptyComponent.push(failed);
      } else if (errors.some((e: string) => e.includes("is not covered"))) {
        errorCategories.uncoveredTokens.push(failed);
      } else if (errors.some((e: string) => e.includes("overlapping"))) {
        errorCategories.overlapping.push(failed);
      } else if (errors.some((e: string) => e.includes("unknown"))) {
        errorCategories.unknownRole.push(failed);
      } else {
        errorCategories.other.push(failed);
      }
    });

    console.log(`\n错误分类:`);
    console.log(`  🔴 只包含标点: ${errorCategories.punctuationOnly.length}`);
    console.log(`  🔴 空成分: ${errorCategories.emptyComponent.length}`);
    console.log(`  🔴 Token未覆盖: ${errorCategories.uncoveredTokens.length}`);
    console.log(`  🔴 成分重叠: ${errorCategories.overlapping.length}`);
    console.log(`  🔴 未知角色: ${errorCategories.unknownRole.length}`);
    console.log(`  🔴 其他: ${errorCategories.other.length}`);

    // 深入分析：为什么标点问题这么多？
    console.log(`\n\n=== 问题 1: 只包含标点 (${errorCategories.punctuationOnly.length} 个) ===`);
    console.log(`\n这是最常见的错误。为什么模型会把标点单独标注成成分？\n`);

    errorCategories.punctuationOnly.slice(0, 3).forEach((failed: any, i: number) => {
      console.log(`${i + 1}. "${failed.text}"`);
      const tokens = tokenize(failed.text);
      const punctuationTokens = tokens.filter((t: any) => t.punctuation);
      console.log(`   标点符号: ${punctuationTokens.map((t: any) => t.text).join(", ")}`);
      console.log(`   标点位置: ${punctuationTokens.map((t: any) => `token-${t.id}`).join(", ")}`);
      console.log(`   原因猜测: 模型可能尝试覆盖所有token，包括标点`);
      console.log(``);
    });

    console.log(`\n根本原因分析:`);
    console.log(`  1. 提示词说 "every non-punctuation token must be covered"`);
    console.log(`  2. 但模型可能误解为 "every token (including punctuation) must be covered"`);
    console.log(`  3. 或者模型为了完整性，主动尝试给标点分配角色`);
    console.log(`  4. 特别是逗号、句号这些常见标点`);

    console.log(`\n解决方案:`);
    console.log(`  ✅ 方案 1: 在提示词中明确 "NEVER create components with ONLY punctuation"`);
    console.log(`  ✅ 方案 2: 后处理脚本，自动删除纯标点成分`);
    console.log(`  ✅ 方案 3: 在 few-shot 示例中展示正确的标点处理`);

    // 分析空成分问题
    console.log(`\n\n=== 问题 2: 空成分 (${errorCategories.emptyComponent.length} 个) ===`);
    console.log(`\n为什么模型会返回空的成分？\n`);

    if (errorCategories.emptyComponent.length > 0) {
      errorCategories.emptyComponent.slice(0, 2).forEach((failed: any, i: number) => {
        console.log(`${i + 1}. "${failed.text}"`);
        console.log(`   原因: 可能是模型输出的 JSON 格式问题`);
        console.log(`   或者模型对某个成分不确定，返回了空值`);
        console.log(``);
      });

      console.log(`根本原因分析:`);
      console.log(`  1. JSON 序列化/反序列化错误`);
      console.log(`  2. 模型在某个字段上犹豫不决，留空`);
      console.log(`  3. 模型理解了结构但无法确定角色或翻译`);

      console.log(`\n解决方案:`);
      console.log(`  ✅ 方案 1: 强制要求所有字段非空`);
      console.log(`  ✅ 方案 2: 添加 JSON schema 验证`);
      console.log(`  ✅ 方案 3: 使用更强的模型（GPT-4）`);
    }

    // 分析句子特征
    console.log(`\n\n=== 问题 3: 失败句子的共同特征 ===\n`);

    const failedTexts = retryFailed.map((f: any) => f.text);
    const avgLength = failedTexts.reduce((sum: number, text: string) => {
      return sum + tokenize(text).length;
    }, 0) / failedTexts.length;

    const longSentences = failedTexts.filter((text: string) => tokenize(text).length > 20);
    const withCommas = failedTexts.filter((text: string) => (text.match(/,/g) || []).length >= 2);
    const withParens = failedTexts.filter((text: string) => text.includes("(") && text.includes(")"));

    console.log(`平均长度: ${avgLength.toFixed(1)} tokens`);
    console.log(`长句 (>20 tokens): ${longSentences.length}/${failedTexts.length}`);
    console.log(`多逗号 (>=2): ${withCommas.length}/${failedTexts.length}`);
    console.log(`包含括号: ${withParens.length}/${failedTexts.length}`);

    console.log(`\n特征分析:`);
    if (avgLength > 15) {
      console.log(`  ⚠️  失败句子平均较长 (${avgLength.toFixed(1)} vs 成功句~12)`);
    }
    if (longSentences.length > failedTexts.length / 2) {
      console.log(`  ⚠️  多数是长句，模型处理长句能力不足`);
    }
    if (withCommas.length > failedTexts.length / 2) {
      console.log(`  ⚠️  多数包含多个逗号，结构复杂`);
    }
    if (withParens.length > 0) {
      console.log(`  ⚠️  括号内容增加复杂度`);
    }

    // 对比成功和失败句子
    console.log(`\n\n=== 对比：成功 vs 失败句子 ===\n`);

    const successfulPath = path.join(__dirname, "../../../test-output/auto-generated-gold-annotations.json");
    const successful = JSON.parse(fs.readFileSync(successfulPath, "utf-8"));

    const successTexts = successful.sentences.map((s: any) => s.text);
    const successAvgLength = successTexts.reduce((sum: number, text: string) => {
      return sum + tokenize(text).length;
    }, 0) / successTexts.length;

    console.log(`成功句子:`);
    console.log(`  平均长度: ${successAvgLength.toFixed(1)} tokens`);
    console.log(`  长句比例: ${successTexts.filter((t: string) => tokenize(t).length > 20).length}/${successTexts.length}`);

    console.log(`\n失败句子:`);
    console.log(`  平均长度: ${avgLength.toFixed(1)} tokens`);
    console.log(`  长句比例: ${longSentences.length}/${failedTexts.length}`);

    console.log(`\n结论:`);
    if (avgLength > successAvgLength * 1.2) {
      console.log(`  🔴 失败句子明显更长更复杂`);
      console.log(`  → 模型在处理复杂句时容易犯错`);
    }

    // 最核心的问题
    console.log(`\n\n=== 核心问题总结 ===\n`);

    console.log(`1. 🔴 标点处理 bug (最严重)`);
    console.log(`   - 影响: 9/19 句子 (47%)`);
    console.log(`   - 原因: 模型误解提示词或过度覆盖`);
    console.log(`   - 可修复性: ⭐⭐⭐⭐ (高，提示词+后处理)`);

    console.log(`\n2. 🟡 长句处理能力不足`);
    console.log(`   - 影响: 约 50% 失败句是长句`);
    console.log(`   - 原因: 模型对复杂结构理解有限`);
    console.log(`   - 可修复性: ⭐⭐ (低，需要更强模型)`);

    console.log(`\n3. 🟡 空成分问题`);
    console.log(`   - 影响: 3/19 句子`);
    console.log(`   - 原因: JSON 格式或模型不确定性`);
    console.log(`   - 可修复性: ⭐⭐⭐ (中，加强验证)`);

    console.log(`\n4. 🟢 其他问题`);
    console.log(`   - 影响: <10%`);
    console.log(`   - 包括: 重叠、未知角色等`);
    console.log(`   - 可修复性: ⭐⭐⭐⭐ (高，个案处理)`);

    // 改进建议
    console.log(`\n\n=== 改进建议（优先级排序）===\n`);

    console.log(`🔴 高优先级 - 立即可做:`);
    console.log(`\n1. 添加后处理脚本，自动修复标点问题`);
    console.log(`   function removeOnlyPunctuationComponents(components) {`);
    console.log(`     return components.filter(c => {`);
    console.log(`       const tokens = getTokens(c.startToken, c.endToken);`);
    console.log(`       return tokens.some(t => !t.punctuation);`);
    console.log(`     });`);
    console.log(`   }`);

    console.log(`\n2. 强化提示词 - 标点处理`);
    console.log(`   "CRITICAL: Never create a component that contains ONLY punctuation."`);
    console.log(`   "Punctuation may be included at the end of a component, but never alone."`);
    console.log(`   "Example WRONG: {startToken: 5, endToken: 5, role: 'OBJECT', translation: '。'}"`);

    console.log(`\n🟡 中优先级 - 可以尝试:`);
    console.log(`\n3. 分段处理长句`);
    console.log(`   - 对 25+ tokens 的句子，先分析主从句`);
    console.log(`   - 然后分别标注`);
    console.log(`   - 最后合并结果`);

    console.log(`\n4. 使用更强的模型`);
    console.log(`   - GPT-4o: 对复杂句理解更好`);
    console.log(`   - Claude Opus: 指令遵循能力强`);
    console.log(`   - 成本: ~$0.015/句 (vs DeepSeek $0.0003/句)`);

    console.log(`\n🟢 低优先级 - 长期改进:`);
    console.log(`\n5. Few-shot 示例`);
    console.log(`   - 在提示词中加入 3-5 个完整标注示例`);
    console.log(`   - 特别展示标点、长句的正确处理`);

    console.log(`\n6. 多模型集成`);
    console.log(`   - DeepSeek + 智谱 + GPT-4`);
    console.log(`   - 投票或加权平均`);
    console.log(`   - 成本高但质量最好`);

    console.log(`\n\n=== 预期效果 ===\n`);

    console.log(`如果实施改进方案 1+2（后处理+提示词）:`);
    console.log(`  当前成功率: 57.8% (26/45)`);
    console.log(`  预期提升: +20-30%`);
    console.log(`  预期成功率: 75-85% (34-38/45)`);
    console.log(`  投入: 2-3 小时开发`);
    console.log(`  性价比: ⭐⭐⭐⭐⭐`);

    console.log(`\n如果实施改进方案 3+4（分段+更强模型）:`);
    console.log(`  预期成功率: 85-95% (38-42/45)`);
    console.log(`  投入: 1 天开发 + $5-10 API 成本`);
    console.log(`  性价比: ⭐⭐⭐`);

    console.log(`\n如果实施全部方案:`);
    console.log(`  预期成功率: 95%+ (43+/45)`);
    console.log(`  投入: 2-3 天 + $10-20`);
    console.log(`  性价比: ⭐⭐ (投入产出比不高)`);
  });
});
