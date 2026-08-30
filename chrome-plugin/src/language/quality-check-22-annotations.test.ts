/**
 * 质量检查：逐句分析 22 个自动生成的标注
 * 判断是否达到合并到黄金标注集的标准
 */

import { describe, it } from "vitest";
import { tokenize } from "./segmenter";
import * as fs from "fs";
import * as path from "path";

interface QualityIssue {
  severity: "critical" | "major" | "minor";
  type: string;
  description: string;
}

interface AnnotationQuality {
  sentenceId: string;
  text: string;
  componentCount: number;
  passed: boolean;
  issues: QualityIssue[];
  score: number; // 0-100
  recommendation: "accept" | "review" | "reject";
}

describe("质量检查 - 22 个自动标注", () => {

  it("逐句详细检查", () => {
    const annotationsPath = path.join(__dirname, "../../../test-output/auto-generated-gold-annotations.json");
    const data = JSON.parse(fs.readFileSync(annotationsPath, "utf-8"));

    console.log(`\n=== 质量检查开始 ===`);
    console.log(`总句子数: ${data.sentences.length}`);
    console.log(`\n逐句分析:\n`);

    const qualityResults: AnnotationQuality[] = [];

    data.sentences.forEach((sentence: any, index: number) => {
      const issues: QualityIssue[] = [];
      let score = 100;

      console.log(`[${index + 1}/${data.sentences.length}] "${sentence.text}"`);
      console.log(`  ID: ${sentence.sentenceId}`);
      console.log(`  成分数: ${sentence.components.length}`);

      // 检查 1: 是否有主语
      const hasSubject = sentence.components.some((c: any) => c.role === "SUBJECT");
      if (!hasSubject) {
        issues.push({
          severity: "major",
          type: "missing_subject",
          description: "缺少主语（非祈使句应有主语）"
        });
        score -= 15;
      }

      // 检查 2: 是否有谓语
      const hasPredicate = sentence.components.some((c: any) => c.role === "PREDICATE");
      if (!hasPredicate) {
        issues.push({
          severity: "critical",
          type: "missing_predicate",
          description: "缺少谓语（所有句子必须有谓语）"
        });
        score -= 30;
      }

      // 检查 3: 成分数量合理性
      const tokens = tokenize(sentence.text);
      const nonPuncTokens = tokens.filter((t: any) => !t.punctuation).length;
      const componentTokenRatio = sentence.components.length / nonPuncTokens;

      if (sentence.components.length < 2) {
        issues.push({
          severity: "major",
          type: "too_few_components",
          description: `成分过少 (${sentence.components.length} 个)`
        });
        score -= 20;
      } else if (componentTokenRatio > 0.5) {
        issues.push({
          severity: "minor",
          type: "possibly_too_granular",
          description: `可能过于细碎 (${sentence.components.length} 个成分 / ${nonPuncTokens} 个词)`
        });
        score -= 5;
      }

      // 检查 4: 翻译质量
      const hasEmptyTranslation = sentence.components.some((c: any) => !c.translation || c.translation.trim() === "");
      if (hasEmptyTranslation) {
        issues.push({
          severity: "major",
          type: "empty_translation",
          description: "有空翻译"
        });
        score -= 15;
      }

      // 检查 5: 成分角色合理性
      const roles = sentence.components.map((c: any) => c.role);
      const roleCount: Record<string, number> = {};
      roles.forEach((role: string) => {
        roleCount[role] = (roleCount[role] || 0) + 1;
      });

      // 多个主语可能有问题（除非是并列结构）
      if (roleCount["SUBJECT"] > 2) {
        issues.push({
          severity: "minor",
          type: "multiple_subjects",
          description: `有 ${roleCount["SUBJECT"]} 个主语（可能是并列或定语从句）`
        });
        score -= 3;
      }

      // 多个谓语可能有问题（除非是并列谓语）
      if (roleCount["PREDICATE"] > 2) {
        issues.push({
          severity: "minor",
          type: "multiple_predicates",
          description: `有 ${roleCount["PREDICATE"]} 个谓语（应该合并或标记并列）`
        });
        score -= 5;
      }

      // 检查 6: Token 覆盖完整性
      const coveredTokens = new Set<number>();
      sentence.components.forEach((c: any) => {
        for (let i = c.startToken; i <= c.endToken; i++) {
          coveredTokens.add(i);
        }
      });

      const uncoveredTokens = [];
      for (let i = 0; i < tokens.length; i++) {
        if (!tokens[i].punctuation && !coveredTokens.has(i)) {
          uncoveredTokens.push(i);
        }
      }

      if (uncoveredTokens.length > 0) {
        issues.push({
          severity: "critical",
          type: "uncovered_tokens",
          description: `有 ${uncoveredTokens.length} 个 token 未覆盖`
        });
        score -= 25;
      }

      // 检查 7: 特殊结构识别
      const text = sentence.text.toLowerCase();

      // 被动语态应该有合理的谓语
      if (text.match(/\b(is|are|was|were|been|being)\s+\w+ed\b/) && hasPredicate) {
        const predicates = sentence.components.filter((c: any) => c.role === "PREDICATE");
        if (predicates.length > 0) {
          // 被动语态的谓语应该包含 be 动词和过去分词
          console.log(`  ✓ 包含被动语态结构`);
        }
      }

      // 打印分析结果
      console.log(`  主语: ${hasSubject ? "✓" : "✗"}, 谓语: ${hasPredicate ? "✓" : "✗"}`);

      if (issues.length === 0) {
        console.log(`  ✅ 无问题 (得分: ${score})`);
      } else {
        console.log(`  ⚠️  ${issues.length} 个问题 (得分: ${score})`);
        issues.forEach(issue => {
          const icon = issue.severity === "critical" ? "🔴" : issue.severity === "major" ? "🟡" : "⚪";
          console.log(`    ${icon} ${issue.description}`);
        });
      }

      // 判断建议
      let recommendation: "accept" | "review" | "reject";
      if (score >= 90) {
        recommendation = "accept";
        console.log(`  ✅ 建议: 接受`);
      } else if (score >= 70) {
        recommendation = "review";
        console.log(`  ⚠️  建议: 人工复审`);
      } else {
        recommendation = "reject";
        console.log(`  ❌ 建议: 拒绝`);
      }

      console.log("");

      qualityResults.push({
        sentenceId: sentence.sentenceId,
        text: sentence.text,
        componentCount: sentence.components.length,
        passed: score >= 70,
        issues,
        score,
        recommendation,
      });
    });

    // 总结
    console.log(`\n=== 质量检查总结 ===`);

    const accept = qualityResults.filter(r => r.recommendation === "accept").length;
    const review = qualityResults.filter(r => r.recommendation === "review").length;
    const reject = qualityResults.filter(r => r.recommendation === "reject").length;

    console.log(`\n建议分布:`);
    console.log(`  ✅ 接受 (90+分): ${accept} (${((accept / qualityResults.length) * 100).toFixed(1)}%)`);
    console.log(`  ⚠️  复审 (70-89分): ${review} (${((review / qualityResults.length) * 100).toFixed(1)}%)`);
    console.log(`  ❌ 拒绝 (<70分): ${reject} (${((reject / qualityResults.length) * 100).toFixed(1)}%)`);

    const avgScore = qualityResults.reduce((sum, r) => sum + r.score, 0) / qualityResults.length;
    console.log(`\n平均得分: ${avgScore.toFixed(1)}`);

    // 问题统计
    const issueTypes: Record<string, number> = {};
    qualityResults.forEach(r => {
      r.issues.forEach(issue => {
        issueTypes[issue.type] = (issueTypes[issue.type] || 0) + 1;
      });
    });

    if (Object.keys(issueTypes).length > 0) {
      console.log(`\n常见问题:`);
      Object.entries(issueTypes)
        .sort((a, b) => b[1] - a[1])
        .forEach(([type, count]) => {
          console.log(`  - ${type}: ${count} 次`);
        });
    }

    // 最终判断
    console.log(`\n=== 最终判断 ===`);

    if (accept >= qualityResults.length * 0.7) {
      console.log(`✅ 整体质量良好，建议合并 ${accept} 个标注到黄金标注集`);
      console.log(`⚠️  ${review} 个需要人工复审后再决定`);
      if (reject > 0) {
        console.log(`❌ ${reject} 个质量不达标，建议剔除`);
      }
    } else if (accept >= qualityResults.length * 0.5) {
      console.log(`⚠️  质量中等，建议只合并 ${accept} 个高质量标注`);
      console.log(`📋 ${review + reject} 个需要进一步处理`);
    } else {
      console.log(`❌ 整体质量不达标，建议先改进提示词再重新生成`);
      console.log(`   仅 ${accept} 个达到合并标准`);
    }

    // 保存质量报告
    const reportPath = path.join(__dirname, "../../../test-output/quality-check-report.json");
    fs.writeFileSync(reportPath, JSON.stringify({
      timestamp: new Date().toISOString(),
      totalSentences: qualityResults.length,
      summary: {
        accept,
        review,
        reject,
        averageScore: avgScore,
      },
      details: qualityResults,
      issueTypes,
    }, null, 2));

    console.log(`\n📊 详细报告已保存: ${reportPath}`);
  });
});
