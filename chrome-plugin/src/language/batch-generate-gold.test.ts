/**
 * 使用 DeepSeek 批量生成黄金标注
 * 处理全部 45 个候选句子
 */

import { describe, it } from "vitest";
import { tokenize } from "./segmenter";
import { validateCoreBatch } from "./analysis-validator";
import type { SentenceInput } from "../shared/protocol";
import { buildCorePrompt } from "../background/prompts";
import { finalGoldCandidates } from "./gold-expansion-final.test";
import * as fs from "fs";
import * as path from "path";

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || "";

interface GeneratedAnnotation {
  sentenceId: string;
  text: string;
  tokens: any[];
  components: any[];
  passedValidation: boolean;
  errorMessages?: string[];
  componentCount: number;
  modelUsed: string;
}

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
    const errorText = await response.text();
    throw new Error(`DeepSeek API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

function parseModelResponse(response: string): any {
  let cleaned = response.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  return JSON.parse(cleaned);
}

describe("批量生成黄金标注 - DeepSeek 全部 45 句", () => {

  it("批量处理全部句子", async () => {
    if (!DEEPSEEK_API_KEY) {
      console.log("⚠️  DEEPSEEK_API_KEY 未设置，跳过");
      return;
    }

    console.log(`\n=== 批量生成黄金标注 ===`);
    console.log(`总句子数: ${finalGoldCandidates.sentences.length}`);
    console.log(`模型: DeepSeek`);
    console.log(`\n开始处理...\n`);

    const allAnnotations: GeneratedAnnotation[] = [];
    const successfulAnnotations: GeneratedAnnotation[] = [];
    const failedAnnotations: GeneratedAnnotation[] = [];

    for (let i = 0; i < finalGoldCandidates.sentences.length; i++) {
      const text = finalGoldCandidates.sentences[i];
      const sentenceId = `auto-gen-${String(i + 1).padStart(3, "0")}`;
      const tokens = tokenize(text);

      console.log(`[${i + 1}/${finalGoldCandidates.sentences.length}] ${text.substring(0, 60)}${text.length > 60 ? "..." : ""}`);
      console.log(`  Tokens: ${tokens.length}`);

      try {
        const sentenceInput: SentenceInput = { sentenceId, text, tokens };
        const prompt = buildCorePrompt([sentenceInput]);

        // 调用 DeepSeek
        const rawResponse = await callDeepSeek(prompt);
        const parsed = parseModelResponse(rawResponse);

        // 验证
        const validationResult = validateCoreBatch(parsed, [sentenceInput], "deepseek-chat");

        if (validationResult.ok) {
          const analysis = validationResult.value[0];
          console.log(`  ✅ 通过验证 - ${analysis.components.length} 个成分`);

          const annotation: GeneratedAnnotation = {
            sentenceId,
            text,
            tokens: analysis.tokens,
            components: analysis.components,
            passedValidation: true,
            componentCount: analysis.components.length,
            modelUsed: "deepseek-chat",
          };

          allAnnotations.push(annotation);
          successfulAnnotations.push(annotation);

        } else {
          console.log(`  ❌ 验证失败`);
          validationResult.errors.slice(0, 2).forEach((err: any) => {
            console.log(`    - ${err.message}`);
          });

          const annotation: GeneratedAnnotation = {
            sentenceId,
            text,
            tokens,
            components: [],
            passedValidation: false,
            errorMessages: validationResult.errors.map((e: any) => e.message),
            componentCount: 0,
            modelUsed: "deepseek-chat",
          };

          allAnnotations.push(annotation);
          failedAnnotations.push(annotation);
        }

      } catch (error: any) {
        console.log(`  ❌ 错误: ${error.message}`);
        failedAnnotations.push({
          sentenceId,
          text,
          tokens,
          components: [],
          passedValidation: false,
          errorMessages: [error.message],
          componentCount: 0,
          modelUsed: "deepseek-chat",
        });
      }

      // 避免限流，每个请求间隔 2 秒
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    // 统计结果
    console.log(`\n\n=== 批量生成完成 ===`);
    console.log(`总句子数: ${allAnnotations.length}`);
    console.log(`✅ 通过验证: ${successfulAnnotations.length} (${((successfulAnnotations.length / allAnnotations.length) * 100).toFixed(1)}%)`);
    console.log(`❌ 验证失败: ${failedAnnotations.length} (${((failedAnnotations.length / allAnnotations.length) * 100).toFixed(1)}%)`);

    // 成分数量分析
    if (successfulAnnotations.length > 0) {
      const componentCounts = successfulAnnotations.map(a => a.componentCount);
      const avgComponents = componentCounts.reduce((a, b) => a + b, 0) / componentCounts.length;
      const minComponents = Math.min(...componentCounts);
      const maxComponents = Math.max(...componentCounts);

      console.log(`\n成分数量统计:`);
      console.log(`  平均: ${avgComponents.toFixed(1)}`);
      console.log(`  范围: ${minComponents} - ${maxComponents}`);
    }

    // 保存结果
    const outputDir = path.join(__dirname, "../../../test-output");
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // 保存成功的标注
    const goldAnnotationsOutput = {
      contractVersion: 3,
      generatedBy: "auto-gold-annotation (DeepSeek)",
      generatedAt: new Date().toISOString(),
      totalSentences: successfulAnnotations.length,
      sources: finalGoldCandidates.sources,
      sentences: successfulAnnotations.map(a => ({
        sentenceId: a.sentenceId,
        text: a.text,
        components: a.components,
      })),
    };

    const successPath = path.join(outputDir, "auto-generated-gold-annotations.json");
    fs.writeFileSync(successPath, JSON.stringify(goldAnnotationsOutput, null, 2));
    console.log(`\n✅ 成功标注已保存: ${successPath}`);

    // 保存失败的句子供分析
    if (failedAnnotations.length > 0) {
      const failedPath = path.join(outputDir, "failed-annotations.json");
      fs.writeFileSync(failedPath, JSON.stringify(failedAnnotations, null, 2));
      console.log(`⚠️  失败记录已保存: ${failedPath}`);
    }

    // 生成统计报告
    const reportPath = path.join(outputDir, "generation-report.md");
    const report = generateReport(successfulAnnotations, failedAnnotations);
    fs.writeFileSync(reportPath, report);
    console.log(`📊 统计报告已保存: ${reportPath}`);

  }, 300000); // 5分钟超时
});

function generateReport(successful: GeneratedAnnotation[], failed: GeneratedAnnotation[]): string {
  const total = successful.length + failed.length;
  const successRate = ((successful.length / total) * 100).toFixed(1);

  let report = `# 自动黄金标注生成报告

## 总体统计

- **总句子数**: ${total}
- **成功**: ${successful.length} (${successRate}%)
- **失败**: ${failed.length} (${((failed.length / total) * 100).toFixed(1)}%)
- **模型**: DeepSeek Chat
- **生成时间**: ${new Date().toISOString()}

## 成功标注分析

`;

  if (successful.length > 0) {
    const componentCounts = successful.map(a => a.componentCount);
    const avg = (componentCounts.reduce((a, b) => a + b, 0) / componentCounts.length).toFixed(1);
    const min = Math.min(...componentCounts);
    const max = Math.max(...componentCounts);

    report += `### 成分数量
- 平均: ${avg}
- 最小: ${min}
- 最大: ${max}

### 成分数量分布
`;

    const distribution: Record<number, number> = {};
    componentCounts.forEach(count => {
      distribution[count] = (distribution[count] || 0) + 1;
    });

    Object.entries(distribution).sort((a, b) => Number(b[0]) - Number(a[0])).forEach(([count, freq]) => {
      report += `- ${count} 个成分: ${freq} 句\n`;
    });

    report += `\n### 示例标注（前5个）\n\n`;
    successful.slice(0, 5).forEach((ann, i) => {
      report += `${i + 1}. **${ann.text}**\n`;
      report += `   - 成分数: ${ann.componentCount}\n`;
      report += `   - 成分: ${ann.components.map(c => c.role).join(", ")}\n\n`;
    });
  }

  if (failed.length > 0) {
    report += `\n## 失败分析\n\n`;
    report += `共 ${failed.length} 个句子验证失败\n\n`;

    // 分析失败原因
    const errorTypes: Record<string, number> = {};
    failed.forEach(ann => {
      ann.errorMessages?.forEach(msg => {
        const type = msg.split(":")[0] || "unknown";
        errorTypes[type] = (errorTypes[type] || 0) + 1;
      });
    });

    report += `### 错误类型统计\n`;
    Object.entries(errorTypes).sort((a, b) => b[1] - a[1]).forEach(([type, count]) => {
      report += `- ${type}: ${count} 次\n`;
    });

    report += `\n### 失败句子示例（前3个）\n\n`;
    failed.slice(0, 3).forEach((ann, i) => {
      report += `${i + 1}. **${ann.text}**\n`;
      if (ann.errorMessages) {
        report += `   错误:\n`;
        ann.errorMessages.slice(0, 2).forEach(err => {
          report += `   - ${err}\n`;
        });
      }
      report += `\n`;
    });
  }

  report += `\n## 建议

`;

  if (successRate >= "80") {
    report += `✅ 成功率很高（${successRate}%），可以直接加入黄金标注集\n`;
  } else if (successRate >= "60") {
    report += `⚠️ 成功率中等（${successRate}%），建议审查失败案例并改进提示词\n`;
  } else {
    report += `❌ 成功率较低（${successRate}%），需要显著改进提示词或换用其他模型\n`;
  }

  if (failed.length > 0) {
    report += `\n针对失败的 ${failed.length} 个句子:\n`;
    report += `1. 分析常见错误模式\n`;
    report += `2. 调整提示词或硬门规则\n`;
    report += `3. 使用其他模型重试\n`;
  }

  return report;
}
