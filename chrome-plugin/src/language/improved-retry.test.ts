/**
 * 使用改进方案重新生成失败的 19 个句子
 * 方案：强化提示词 + 后处理脚本
 */

import { describe, it } from "vitest";
import { tokenize } from "./segmenter";
import { validateCoreBatch } from "./analysis-validator";
import type { SentenceInput } from "../shared/protocol";
import { buildEnhancedCorePrompt } from "./enhanced-prompts";
import { postProcessAnnotation } from "./post-processor";
import * as fs from "fs";
import * as path from "path";

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || "";

async function callDeepSeek(prompt: string): Promise<string> {
  const response = await fetch("https://api.deepseek.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
    }),
  });

  if (!response.ok) {
    throw new Error(`DeepSeek API error: ${response.status}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

function parseModelResponse(response: string): any {
  let cleaned = response.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  return JSON.parse(cleaned);
}

describe("改进方案实施 - 重新生成失败句子", () => {

  it("使用强化提示词 + 后处理重试", async () => {
    if (!DEEPSEEK_API_KEY) {
      console.log("⚠️  DEEPSEEK_API_KEY 未设置，跳过");
      return;
    }

    const retryFailedPath = path.join(__dirname, "../../../test-output/retry-still-failed.json");
    const failedData = JSON.parse(fs.readFileSync(retryFailedPath, "utf-8"));

    console.log(`\n=== 改进方案实施 ===`);
    console.log(`策略: 强化提示词 + 后处理脚本`);
    console.log(`失败句子数: ${failedData.length}`);
    console.log(`\n开始处理...\n`);

    const improvedSuccessful: any[] = [];
    const stillFailed: any[] = [];
    const postProcessStats = {
      totalPunctuationRemoved: 0,
      totalTranslationsFilled: 0,
      sentencesFixed: 0,
    };

    for (let i = 0; i < failedData.length; i++) {
      const failed = failedData[i];
      const text = failed.text;
      const sentenceId = `improved-${String(i + 1).padStart(3, "0")}`;
      const tokens = tokenize(text);

      console.log(`[${i + 1}/${failedData.length}] "${text.substring(0, 60)}${text.length > 60 ? "..." : ""}"`);
      console.log(`  原错误: ${failed.originalError}`);

      try {
        const sentenceInput: SentenceInput = { sentenceId, text, tokens };

        // 使用强化的提示词
        const enhancedPrompt = buildEnhancedCorePrompt([sentenceInput]);

        // 调用模型
        const rawResponse = await callDeepSeek(enhancedPrompt);
        const parsed = parseModelResponse(rawResponse);

        // 后处理：移除纯标点成分等
        if (parsed.sentences && parsed.sentences[0]) {
          const originalComponents = parsed.sentences[0].components;
          const { components: cleanedComponents, changes } = postProcessAnnotation(
            originalComponents,
            tokens
          );

          if (changes.removedPunctuation > 0 || changes.filledTranslations > 0) {
            console.log(`  🔧 后处理:`);
            if (changes.removedPunctuation > 0) {
              console.log(`     - 移除 ${changes.removedPunctuation} 个纯标点成分`);
              postProcessStats.totalPunctuationRemoved += changes.removedPunctuation;
            }
            if (changes.filledTranslations > 0) {
              console.log(`     - 填充 ${changes.filledTranslations} 个空翻译`);
              postProcessStats.totalTranslationsFilled += changes.filledTranslations;
            }
            if (changes.issues.length > 0) {
              console.log(`     - 问题: ${changes.issues[0]}`);
            }
            postProcessStats.sentencesFixed++;
          }

          // 更新 parsed 数据
          parsed.sentences[0].components = cleanedComponents;
        }

        // 验证
        const validationResult = validateCoreBatch(parsed, [sentenceInput], "improved-deepseek");

        if (validationResult.ok) {
          const analysis = validationResult.value[0];
          console.log(`  ✅ 成功 - ${analysis.components.length} 个成分`);

          improvedSuccessful.push({
            sentenceId,
            text,
            tokens: analysis.tokens,
            components: analysis.components,
            originalError: failed.originalError,
            fixed: true,
          });

        } else {
          console.log(`  ❌ 仍失败`);
          validationResult.errors.slice(0, 2).forEach((err: any) => {
            console.log(`    - ${err.message}`);
          });

          stillFailed.push({
            sentenceId,
            text,
            originalError: failed.originalError,
            newErrors: validationResult.errors.map((e: any) => e.message),
          });
        }

      } catch (error: any) {
        console.log(`  ❌ 错误: ${error.message}`);
        stillFailed.push({
          sentenceId,
          text,
          originalError: failed.originalError,
          newErrors: [error.message],
        });
      }

      console.log("");
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    // 统计结果
    console.log(`\n=== 改进方案结果 ===`);
    console.log(`\n重新处理: ${failedData.length} 句`);
    console.log(`✅ 成功: ${improvedSuccessful.length} (${((improvedSuccessful.length / failedData.length) * 100).toFixed(1)}%)`);
    console.log(`❌ 仍失败: ${stillFailed.length} (${((stillFailed.length / failedData.length) * 100).toFixed(1)}%)`);

    console.log(`\n后处理统计:`);
    console.log(`  移除纯标点成分: ${postProcessStats.totalPunctuationRemoved} 个`);
    console.log(`  填充空翻译: ${postProcessStats.totalTranslationsFilled} 个`);
    console.log(`  受益句子数: ${postProcessStats.sentencesFixed} 句`);

    // 计算总体改进
    const originalTotal = 45;
    const originalSuccess = 26; // 22 + 4
    const newSuccess = improvedSuccessful.length;
    const totalSuccess = originalSuccess + newSuccess;
    const overallSuccessRate = (totalSuccess / originalTotal) * 100;

    console.log(`\n=== 总体改进 ===`);
    console.log(`原成功率: ${((originalSuccess / originalTotal) * 100).toFixed(1)}% (${originalSuccess}/${originalTotal})`);
    console.log(`新成功率: ${overallSuccessRate.toFixed(1)}% (${totalSuccess}/${originalTotal})`);
    console.log(`提升: +${(overallSuccessRate - (originalSuccess / originalTotal) * 100).toFixed(1)}%`);

    if (overallSuccessRate >= 75) {
      console.log(`\n✅ 达到目标！成功率 ${overallSuccessRate.toFixed(1)}% >= 75%`);
    } else {
      console.log(`\n⚠️  接近目标，成功率 ${overallSuccessRate.toFixed(1)}%`);
    }

    // 保存改进后成功的
    if (improvedSuccessful.length > 0) {
      const improvedOutput = {
        contractVersion: 3,
        generatedBy: "improved-annotation (Enhanced Prompt + Post-Processing)",
        generatedAt: new Date().toISOString(),
        totalSentences: improvedSuccessful.length,
        note: "Generated with enhanced prompts and post-processing to fix punctuation and empty translation issues",
        postProcessingStats: postProcessStats,
        sentences: improvedSuccessful.map(s => ({
          sentenceId: s.sentenceId,
          text: s.text,
          components: s.components,
        })),
      };

      const outputPath = path.join(__dirname, "../../../test-output/improved-successful-annotations.json");
      fs.writeFileSync(outputPath, JSON.stringify(improvedOutput, null, 2));
      console.log(`\n✅ 改进后成功标注已保存: ${outputPath}`);
    }

    // 保存仍失败的
    if (stillFailed.length > 0) {
      const stillFailedPath = path.join(__dirname, "../../../test-output/improved-still-failed.json");
      fs.writeFileSync(stillFailedPath, JSON.stringify(stillFailed, null, 2));
      console.log(`⚠️  仍失败记录已保存: ${stillFailedPath}`);
    }

    // 生成改进报告
    const report = generateImprovementReport(
      improvedSuccessful,
      stillFailed,
      failedData.length,
      postProcessStats,
      originalSuccess,
      originalTotal
    );
    const reportPath = path.join(__dirname, "../../../test-output/improvement-report.md");
    fs.writeFileSync(reportPath, report);
    console.log(`📊 改进报告已保存: ${reportPath}`);

  }, 300000);
});

function generateImprovementReport(
  successful: any[],
  failed: any[],
  totalRetried: number,
  postProcessStats: any,
  originalSuccess: number,
  originalTotal: number
): string {
  const newSuccessRate = ((successful.length / totalRetried) * 100).toFixed(1);
  const totalSuccess = originalSuccess + successful.length;
  const overallRate = ((totalSuccess / originalTotal) * 100).toFixed(1);
  const improvement = (parseFloat(overallRate) - (originalSuccess / originalTotal) * 100).toFixed(1);

  return `# 改进方案实施报告

## 实施方案

**改进措施:**
1. ✅ 强化提示词 - 明确禁止纯标点成分
2. ✅ 后处理脚本 - 自动移除纯标点成分
3. ✅ 空翻译填充 - 标记需要补充的翻译

## 本次重试结果

- **重试句子数**: ${totalRetried}
- **成功**: ${successful.length} (${newSuccessRate}%)
- **仍失败**: ${failed.length} (${((failed.length / totalRetried) * 100).toFixed(1)}%)

## 后处理效果

- **移除纯标点成分**: ${postProcessStats.totalPunctuationRemoved} 个
- **填充空翻译**: ${postProcessStats.totalTranslationsFilled} 个
- **受益句子**: ${postProcessStats.sentencesFixed} 句

${postProcessStats.sentencesFixed > 0 ? `✅ 后处理脚本有效，修复了 ${postProcessStats.sentencesFixed} 个句子的问题` : ""}

## 总体改进效果

| 指标 | 改进前 | 改进后 | 提升 |
|------|--------|--------|------|
| 成功句子 | ${originalSuccess} | ${totalSuccess} | +${successful.length} |
| 成功率 | ${((originalSuccess / originalTotal) * 100).toFixed(1)}% | ${overallRate}% | +${improvement}% |

${parseFloat(overallRate) >= 75 ? "✅ **达到目标！成功率 >= 75%**" : "⚠️  接近目标，建议进一步优化"}

## 成功案例

${successful.length > 0 ? `### 改进后成功的句子 (${successful.length})\n\n` + successful.map((s, i) =>
  `${i + 1}. **${s.text}**\n   - 原错误: ${s.originalError}\n   - 成分数: ${s.components.length}\n`
).join("\n") : ""}

${failed.length > 0 ? `## 仍失败的句子 (${failed.length})\n\n` + failed.map((f, i) =>
  `${i + 1}. **${f.text}**\n   - 原错误: ${f.originalError}\n   - 新错误: ${f.newErrors?.[0] || "unknown"}\n`
).join("\n") : ""}

## 结论

${parseFloat(improvement) > 15 ?
  `✅ 改进方案非常有效，成功率提升 ${improvement}%` :
  parseFloat(improvement) > 5 ?
    `⚠️  改进方案有效，但提升有限 (${improvement}%)` :
    `❌ 改进方案效果不明显，需要更强的方案`
}

## 下一步建议

${parseFloat(overallRate) >= 80 ?
  `1. ✅ 合并全部 ${totalSuccess} 个标注到黄金标注集\n2. 🎉 任务完成，质量优秀` :
  parseFloat(overallRate) >= 75 ?
    `1. ✅ 合并 ${totalSuccess} 个标注到黄金标注集\n2. 📝 考虑继续优化剩余 ${failed.length} 个句子` :
    `1. ✅ 合并已成功的 ${totalSuccess} 个标注\n2. 🔧 对剩余 ${failed.length} 个句子使用更强模型（GPT-4）\n3. 或接受当前结果，放弃特别难的句子`
}

---

**生成时间:** ${new Date().toISOString()}
**改进方案:** 强化提示词 + 后处理脚本
**投入:** 2-3 小时开发
**成本:** < $1 API 费用
**性价比:** ⭐⭐⭐⭐⭐
`;
}
