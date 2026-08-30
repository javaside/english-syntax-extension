/**
 * 对失败的 13 个句子重新生成标注
 * 策略：调整提示词，强调完整覆盖和合理成分数量
 */

import { describe, it } from "vitest";
import { tokenize } from "./segmenter";
import { validateCoreBatch } from "./analysis-validator";
import type { SentenceInput } from "../shared/protocol";
import { buildCorePrompt } from "../background/prompts";
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

describe("重新生成失败的 13 个句子", () => {

  it("加载失败列表并重试", async () => {
    if (!DEEPSEEK_API_KEY) {
      console.log("⚠️  DEEPSEEK_API_KEY 未设置，跳过");
      return;
    }

    const failedPath = path.join(__dirname, "../../../test-output/failed-annotations.json");
    const failedData = JSON.parse(fs.readFileSync(failedPath, "utf-8"));

    console.log(`\n=== 重新生成失败的句子 ===`);
    console.log(`失败句子数: ${failedData.length}`);
    console.log(`策略: 使用改进的提示词重试`);
    console.log(`\n开始处理...\n`);

    const retrySuccessful: any[] = [];
    const retryFailed: any[] = [];

    for (let i = 0; i < failedData.length; i++) {
      const failed = failedData[i];
      const text = failed.text;
      const sentenceId = `retry-${String(i + 1).padStart(3, "0")}`;
      const tokens = tokenize(text);

      console.log(`[${i + 1}/${failedData.length}] "${text.substring(0, 60)}${text.length > 60 ? "..." : ""}"`);
      console.log(`  原失败原因: ${failed.errorMessages ? failed.errorMessages[0] : "unknown"}`);
      console.log(`  Tokens: ${tokens.length}`);

      try {
        const sentenceInput: SentenceInput = { sentenceId, text, tokens };

        // 使用标准提示词
        const prompt = buildCorePrompt([sentenceInput]);

        // 添加额外的强调指令
        const enhancedPrompt = prompt + `

IMPORTANT REMINDERS:
1. Every non-punctuation token must be covered exactly once
2. Do not create components with only punctuation
3. Merge adjacent predicates into one PREDICATE
4. Ensure translations are not empty
5. Use reasonable number of components (typically 3-7 for most sentences)`;

        // 调用模型
        const rawResponse = await callDeepSeek(enhancedPrompt);
        const parsed = parseModelResponse(rawResponse);

        // 验证
        const validationResult = validateCoreBatch(parsed, [sentenceInput], "deepseek-retry");

        if (validationResult.ok) {
          const analysis = validationResult.value[0];
          console.log(`  ✅ 重试成功 - ${analysis.components.length} 个成分`);

          retrySuccessful.push({
            sentenceId,
            text,
            tokens: analysis.tokens,
            components: analysis.components,
            originalError: failed.errorMessages ? failed.errorMessages[0] : "unknown",
          });

        } else {
          console.log(`  ❌ 重试仍失败`);
          validationResult.errors.slice(0, 2).forEach((err: any) => {
            console.log(`    - ${err.message}`);
          });

          retryFailed.push({
            sentenceId,
            text,
            tokens,
            originalError: failed.errorMessages ? failed.errorMessages[0] : "unknown",
            newErrors: validationResult.errors.map((e: any) => e.message),
          });
        }

      } catch (error: any) {
        console.log(`  ❌ 错误: ${error.message}`);
        retryFailed.push({
          sentenceId,
          text,
          tokens,
          originalError: failed.errorMessages ? failed.errorMessages[0] : "unknown",
          newErrors: [error.message],
        });
      }

      // 避免限流
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    // 统计结果
    console.log(`\n\n=== 重试完成 ===`);
    console.log(`总重试: ${failedData.length}`);
    console.log(`✅ 重试成功: ${retrySuccessful.length} (${((retrySuccessful.length / failedData.length) * 100).toFixed(1)}%)`);
    console.log(`❌ 仍然失败: ${retryFailed.length} (${((retryFailed.length / failedData.length) * 100).toFixed(1)}%)`);

    // 保存重试成功的
    if (retrySuccessful.length > 0) {
      const retrySuccessOutput = {
        contractVersion: 3,
        generatedBy: "auto-gold-annotation (DeepSeek Retry)",
        generatedAt: new Date().toISOString(),
        totalSentences: retrySuccessful.length,
        note: "These are successfully retried sentences from the initial failed batch",
        sentences: retrySuccessful.map(s => ({
          sentenceId: s.sentenceId,
          text: s.text,
          components: s.components,
        })),
      };

      const outputPath = path.join(__dirname, "../../../test-output/retry-successful-annotations.json");
      fs.writeFileSync(outputPath, JSON.stringify(retrySuccessOutput, null, 2));
      console.log(`\n✅ 重试成功标注已保存: ${outputPath}`);
    }

    // 保存仍然失败的
    if (retryFailed.length > 0) {
      const retryFailedPath = path.join(__dirname, "../../../test-output/retry-still-failed.json");
      fs.writeFileSync(retryFailedPath, JSON.stringify(retryFailed, null, 2));
      console.log(`⚠️  仍失败记录已保存: ${retryFailedPath}`);
    }

    // 生成重试报告
    const retryReport = generateRetryReport(retrySuccessful, retryFailed, failedData.length);
    const reportPath = path.join(__dirname, "../../../test-output/retry-report.md");
    fs.writeFileSync(reportPath, retryReport);
    console.log(`📊 重试报告已保存: ${reportPath}`);

    // 最终总结
    console.log(`\n=== 最终总结 ===`);
    const originalSuccessful = 22;
    const totalSuccessful = originalSuccessful + retrySuccessful.length;
    const totalCandidates = 45; // 原始候选数
    const overallSuccessRate = (totalSuccessful / totalCandidates) * 100;

    console.log(`原成功: ${originalSuccessful}`);
    console.log(`重试成功: ${retrySuccessful.length}`);
    console.log(`总成功: ${totalSuccessful}/${totalCandidates} (${overallSuccessRate.toFixed(1)}%)`);

    if (overallSuccessRate >= 80) {
      console.log(`\n✅ 整体成功率优秀！建议合并全部 ${totalSuccessful} 个标注`);
    } else if (overallSuccessRate >= 70) {
      console.log(`\n⚠️  整体成功率良好，建议合并 ${totalSuccessful} 个标注`);
    } else {
      console.log(`\n⚠️  整体成功率中等，建议审查后合并`);
    }

  }, 300000);
});

function generateRetryReport(successful: any[], failed: any[], totalRetried: number): string {
  const successRate = ((successful.length / totalRetried) * 100).toFixed(1);

  let report = `# 重试生成报告

## 重试统计

- **重试句子数**: ${totalRetried}
- **重试成功**: ${successful.length} (${successRate}%)
- **仍然失败**: ${failed.length} (${((failed.length / totalRetried) * 100).toFixed(1)}%)
- **重试时间**: ${new Date().toISOString()}

## 成功案例

`;

  if (successful.length > 0) {
    report += `### 重试成功的句子 (${successful.length})\n\n`;
    successful.forEach((s, i) => {
      report += `${i + 1}. **${s.text}**\n`;
      report += `   - 原错误: ${s.originalError}\n`;
      report += `   - 成分数: ${s.components.length}\n\n`;
    });
  }

  if (failed.length > 0) {
    report += `\n## 仍然失败的句子 (${failed.length})\n\n`;

    // 分析失败原因
    const errorTypes: Record<string, number> = {};
    failed.forEach((f: any) => {
      f.newErrors?.forEach((err: string) => {
        const type = err.split(":")[0] || "unknown";
        errorTypes[type] = (errorTypes[type] || 0) + 1;
      });
    });

    report += `### 错误类型统计\n`;
    Object.entries(errorTypes).sort((a, b) => b[1] - a[1]).forEach(([type, count]) => {
      report += `- ${type}: ${count} 次\n`;
    });

    report += `\n### 详细列表\n\n`;
    failed.forEach((f: any, i: number) => {
      report += `${i + 1}. **${f.text}**\n`;
      report += `   - 原错误: ${f.originalError}\n`;
      if (f.newErrors) {
        report += `   - 新错误: ${f.newErrors.join(", ")}\n`;
      }
      report += `\n`;
    });
  }

  report += `\n## 建议\n\n`;

  if (successRate >= "75") {
    report += `✅ 重试效果很好，大部分失败句子已成功生成标注\n`;
  } else if (successRate >= "50") {
    report += `⚠️ 重试效果中等，部分句子仍有问题\n`;
  } else {
    report += `❌ 重试效果不佳，需要进一步调整策略\n`;
  }

  if (failed.length > 0) {
    report += `\n针对仍失败的 ${failed.length} 个句子:\n`;
    report += `1. 考虑使用其他模型（智谱 AI）\n`;
    report += `2. 手动调整提示词针对特定错误\n`;
    report += `3. 或者接受当前成功的标注，放弃这些特别难的句子\n`;
  }

  return report;
}
