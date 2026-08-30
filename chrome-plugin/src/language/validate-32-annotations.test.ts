/**
 * 10+ 轮测试验证 32 个自动生成的标注
 * 全面检查正确性、一致性、合理性
 */

import { describe, it, expect } from "vitest";
import { tokenize } from "./segmenter";
import { validateCoreBatch } from "./analysis-validator";
import type { SentenceInput } from "../shared/protocol";
import * as fs from "fs";
import * as path from "path";

interface DetailedIssue {
  severity: "critical" | "major" | "minor" | "info";
  category: string;
  description: string;
  sentenceId: string;
  sentenceText: string;
}

describe("轮次 1: 加载并汇总 32 个标注", () => {
  it("汇总三批标注", () => {
    console.log(`\n=== 轮次 1: 加载标注 ===\n`);

    const batch1Path = path.join(__dirname, "../../../test-output/auto-generated-gold-annotations.json");
    const batch2Path = path.join(__dirname, "../../../test-output/retry-successful-annotations.json");
    const batch3Path = path.join(__dirname, "../../../test-output/improved-successful-annotations.json");

    const batch1 = JSON.parse(fs.readFileSync(batch1Path, "utf-8"));
    const batch2 = JSON.parse(fs.readFileSync(batch2Path, "utf-8"));
    const batch3 = JSON.parse(fs.readFileSync(batch3Path, "utf-8"));

    console.log(`批次 1: ${batch1.sentences.length} 个标注`);
    console.log(`批次 2: ${batch2.sentences.length} 个标注`);
    console.log(`批次 3: ${batch3.sentences.length} 个标注`);
    console.log(`总计: ${batch1.sentences.length + batch2.sentences.length + batch3.sentences.length} 个标注`);

    expect(batch1.sentences.length + batch2.sentences.length + batch3.sentences.length).toBe(32);
  });
});

describe("轮次 2-5: 基础验证", () => {

  function loadAll32Annotations() {
    const batch1 = JSON.parse(fs.readFileSync(path.join(__dirname, "../../../test-output/auto-generated-gold-annotations.json"), "utf-8"));
    const batch2 = JSON.parse(fs.readFileSync(path.join(__dirname, "../../../test-output/retry-successful-annotations.json"), "utf-8"));
    const batch3 = JSON.parse(fs.readFileSync(path.join(__dirname, "../../../test-output/improved-successful-annotations.json"), "utf-8"));

    return [...batch1.sentences, ...batch2.sentences, ...batch3.sentences];
  }

  it("轮次 2: 硬门规则验证", () => {
    console.log(`\n=== 轮次 2: 硬门规则验证 ===\n`);

    const allSentences = loadAll32Annotations();
    let passCount = 0;
    let failCount = 0;

    allSentences.forEach((sentence: any) => {
      const tokens = tokenize(sentence.text);
      const sentenceInput: SentenceInput = {
        sentenceId: sentence.sentenceId,
        text: sentence.text,
        tokens,
      };

      const mockOutput = {
        sentences: [sentence],
      };

      const validationResult = validateCoreBatch(mockOutput, [sentenceInput], "validation");

      if (validationResult.ok) {
        passCount++;
      } else {
        failCount++;
        console.log(`❌ ${sentence.sentenceId}: ${sentence.text.substring(0, 50)}...`);
        validationResult.errors.forEach((err: any) => {
          console.log(`   - ${err.message}`);
        });
      }
    });

    console.log(`\n结果: ${passCount} 通过, ${failCount} 失败`);
    console.log(`通过率: ${((passCount / allSentences.length) * 100).toFixed(1)}%`);

    expect(passCount).toBe(32);
  });

  it("轮次 3: 成分完整性检查", () => {
    console.log(`\n=== 轮次 3: 成分完整性检查 ===\n`);

    const allSentences = loadAll32Annotations();
    const issues: DetailedIssue[] = [];

    allSentences.forEach((sentence: any) => {
      const tokens = tokenize(sentence.text);

      // 检查 1: 是否有主语
      const hasSubject = sentence.components.some((c: any) => c.role === "SUBJECT");
      if (!hasSubject && !sentence.text.match(/^(Start|Use|Think|Be|Don't)/)) {
        issues.push({
          severity: "major",
          category: "missing_subject",
          description: "非祈使句缺少主语",
          sentenceId: sentence.sentenceId,
          sentenceText: sentence.text,
        });
      }

      // 检查 2: 是否有谓语
      const hasPredicate = sentence.components.some((c: any) => c.role === "PREDICATE");
      if (!hasPredicate) {
        issues.push({
          severity: "critical",
          category: "missing_predicate",
          description: "缺少谓语",
          sentenceId: sentence.sentenceId,
          sentenceText: sentence.text,
        });
      }

      // 检查 3: Token 覆盖完整性
      const covered = new Set<number>();
      sentence.components.forEach((c: any) => {
        for (let i = c.startToken; i <= c.endToken; i++) {
          covered.add(i);
        }
      });

      const nonPuncTokens = tokens.filter((t: any) => !t.punctuation);
      const uncovered = nonPuncTokens.filter((t: any) => !covered.has(t.id));

      if (uncovered.length > 0) {
        issues.push({
          severity: "critical",
          category: "uncovered_tokens",
          description: `有 ${uncovered.length} 个词未覆盖: ${uncovered.map((t: any) => t.text).join(", ")}`,
          sentenceId: sentence.sentenceId,
          sentenceText: sentence.text,
        });
      }

      // 检查 4: 翻译非空
      const emptyTranslations = sentence.components.filter((c: any) => !c.translation || c.translation.trim() === "");
      if (emptyTranslations.length > 0) {
        issues.push({
          severity: "major",
          category: "empty_translation",
          description: `有 ${emptyTranslations.length} 个成分翻译为空`,
          sentenceId: sentence.sentenceId,
          sentenceText: sentence.text,
        });
      }
    });

    console.log(`检查了 ${allSentences.length} 个标注`);
    console.log(`发现 ${issues.length} 个问题\n`);

    if (issues.length > 0) {
      const bySeverity = {
        critical: issues.filter(i => i.severity === "critical"),
        major: issues.filter(i => i.severity === "major"),
        minor: issues.filter(i => i.severity === "minor"),
      };

      console.log(`严重问题: ${bySeverity.critical.length}`);
      console.log(`主要问题: ${bySeverity.major.length}`);
      console.log(`次要问题: ${bySeverity.minor.length}\n`);

      if (bySeverity.critical.length > 0) {
        console.log(`🔴 严重问题详情:`);
        bySeverity.critical.forEach(issue => {
          console.log(`  - [${issue.sentenceId}] ${issue.description}`);
          console.log(`    "${issue.sentenceText.substring(0, 60)}..."`);
        });
      }
    } else {
      console.log(`✅ 所有标注都通过完整性检查`);
    }

    expect(issues.filter(i => i.severity === "critical").length).toBe(0);
  });

  it("轮次 4: 翻译质量检查", () => {
    console.log(`\n=== 轮次 4: 翻译质量检查 ===\n`);

    const allSentences = loadAll32Annotations();
    const translationIssues: any[] = [];

    allSentences.forEach((sentence: any) => {
      sentence.components.forEach((component: any, index: number) => {
        const translation = component.translation;

        // 检查 1: 是否包含英文（除了专有名词）
        if (translation && /[a-zA-Z]{4,}/.test(translation)) {
          const englishWords = translation.match(/[a-zA-Z]{4,}/g);
          // 允许常见的技术术语
          const allowedTerms = ["API", "SDK", "JSON", "HTML", "CSS", "HTTP", "HTTPS", "URL", "ADR", "SDLC", "WAF", "JSX"];
          const problematic = englishWords?.filter((word: string) => !allowedTerms.includes(word.toUpperCase()));

          if (problematic && problematic.length > 0) {
            translationIssues.push({
              sentenceId: sentence.sentenceId,
              component: index,
              role: component.role,
              translation,
              issue: `包含英文词: ${problematic.join(", ")}`,
            });
          }
        }

        // 检查 2: 是否为占位符
        if (translation && (translation.includes("[待补充]") || translation.includes("TODO"))) {
          translationIssues.push({
            sentenceId: sentence.sentenceId,
            component: index,
            role: component.role,
            translation,
            issue: "包含占位符",
          });
        }

        // 检查 3: 长度合理性
        const tokens = tokenize(sentence.text);
        const componentTokens = tokens.filter((t: any) =>
          t.id >= component.startToken && t.id <= component.endToken && !t.punctuation
        );

        if (componentTokens.length >= 3 && translation && translation.length < 2) {
          translationIssues.push({
            sentenceId: sentence.sentenceId,
            component: index,
            role: component.role,
            translation,
            issue: `翻译过短 (${componentTokens.length} 个词 → ${translation.length} 个字)`,
          });
        }
      });
    });

    console.log(`检查了 ${allSentences.reduce((sum: number, s: any) => sum + s.components.length, 0)} 个成分`);
    console.log(`发现 ${translationIssues.length} 个翻译问题\n`);

    if (translationIssues.length > 0) {
      console.log(`⚠️  翻译问题详情:`);
      translationIssues.slice(0, 5).forEach(issue => {
        console.log(`  [${issue.sentenceId}] ${issue.role}: "${issue.translation}"`);
        console.log(`    问题: ${issue.issue}`);
      });

      if (translationIssues.length > 5) {
        console.log(`  ... 还有 ${translationIssues.length - 5} 个问题`);
      }
    } else {
      console.log(`✅ 所有翻译质量良好`);
    }

    // 翻译问题不算致命错误，只是警告
    expect(translationIssues.filter(i => i.issue.includes("占位符")).length).toBe(0);
  });

  it("轮次 5: 成分数量合理性", () => {
    console.log(`\n=== 轮次 5: 成分数量合理性 ===\n`);

    const allSentences = loadAll32Annotations();
    const stats: any[] = [];

    allSentences.forEach((sentence: any) => {
      const tokens = tokenize(sentence.text);
      const nonPuncTokens = tokens.filter((t: any) => !t.punctuation).length;
      const componentCount = sentence.components.length;
      const ratio = componentCount / nonPuncTokens;

      stats.push({
        sentenceId: sentence.sentenceId,
        text: sentence.text,
        tokens: nonPuncTokens,
        components: componentCount,
        ratio,
      });
    });

    // 统计
    const avgComponents = stats.reduce((sum, s) => sum + s.components, 0) / stats.length;
    const avgTokens = stats.reduce((sum, s) => sum + s.tokens, 0) / stats.length;
    const avgRatio = stats.reduce((sum, s) => sum + s.ratio, 0) / stats.length;

    console.log(`平均成分数: ${avgComponents.toFixed(1)}`);
    console.log(`平均词数: ${avgTokens.toFixed(1)}`);
    console.log(`平均比例: ${avgRatio.toFixed(2)} (成分/词)\n`);

    // 找出异常值
    const tooFew = stats.filter(s => s.components < 2);
    const tooMany = stats.filter(s => s.ratio > 0.6);

    if (tooFew.length > 0) {
      console.log(`⚠️  成分过少 (<2):`);
      tooFew.forEach(s => {
        console.log(`  [${s.sentenceId}] ${s.components} 个成分`);
        console.log(`    "${s.text.substring(0, 60)}..."`);
      });
    }

    if (tooMany.length > 0) {
      console.log(`\n⚠️  可能过细 (>0.6 比例):`);
      tooMany.forEach(s => {
        console.log(`  [${s.sentenceId}] ${s.components} 个成分 / ${s.tokens} 个词 = ${s.ratio.toFixed(2)}`);
        console.log(`    "${s.text.substring(0, 60)}..."`);
      });
    }

    if (tooFew.length === 0 && tooMany.length === 0) {
      console.log(`✅ 所有标注的成分数量都在合理范围`);
    }

    expect(tooFew.length).toBe(0);
  });
});

describe("轮次 6-8: 语法正确性验证", () => {

  function loadAll32Annotations() {
    const batch1 = JSON.parse(fs.readFileSync(path.join(__dirname, "../../../test-output/auto-generated-gold-annotations.json"), "utf-8"));
    const batch2 = JSON.parse(fs.readFileSync(path.join(__dirname, "../../../test-output/retry-successful-annotations.json"), "utf-8"));
    const batch3 = JSON.parse(fs.readFileSync(path.join(__dirname, "../../../test-output/improved-successful-annotations.json"), "utf-8"));

    return [...batch1.sentences, ...batch2.sentences, ...batch3.sentences];
  }

  it("轮次 6: 主谓一致性检查", () => {
    console.log(`\n=== 轮次 6: 主谓一致性检查 ===\n`);

    const allSentences = loadAll32Annotations();
    const issues: any[] = [];

    allSentences.forEach((sentence: any) => {
      const subjects = sentence.components.filter((c: any) => c.role === "SUBJECT");
      const predicates = sentence.components.filter((c: any) => c.role === "PREDICATE");

      // 简单句应该有1个主语和1个谓语
      if (subjects.length === 0 && predicates.length > 0) {
        // 检查是否为祈使句
        const text = sentence.text;
        if (!text.match(/^(Start|Use|Think|Be|Don't|Let|Help)/)) {
          issues.push({
            sentenceId: sentence.sentenceId,
            text: sentence.text,
            issue: `有谓语但无主语（非祈使句）`,
            subjects: subjects.length,
            predicates: predicates.length,
          });
        }
      }

      if (subjects.length > 0 && predicates.length === 0) {
        issues.push({
          sentenceId: sentence.sentenceId,
          text: sentence.text,
          issue: "有主语但无谓语",
          subjects: subjects.length,
          predicates: predicates.length,
        });
      }

      // 多个主语或谓语需要检查
      if (subjects.length > 2) {
        issues.push({
          sentenceId: sentence.sentenceId,
          text: sentence.text,
          issue: `主语过多 (${subjects.length} 个)`,
          subjects: subjects.length,
          predicates: predicates.length,
          severity: "info",
        });
      }

      if (predicates.length > 2) {
        issues.push({
          sentenceId: sentence.sentenceId,
          text: sentence.text,
          issue: `谓语过多 (${predicates.length} 个)`,
          subjects: subjects.length,
          predicates: predicates.length,
          severity: "info",
        });
      }
    });

    console.log(`检查了 ${allSentences.length} 个标注`);

    const criticalIssues = issues.filter(i => !i.severity || i.severity !== "info");
    const infoIssues = issues.filter(i => i.severity === "info");

    console.log(`发现 ${criticalIssues.length} 个问题, ${infoIssues.length} 个提示\n`);

    if (criticalIssues.length > 0) {
      console.log(`❌ 主谓问题:`);
      criticalIssues.forEach(issue => {
        console.log(`  [${issue.sentenceId}] ${issue.issue}`);
        console.log(`    "${issue.text.substring(0, 60)}..."`);
      });
    }

    if (infoIssues.length > 0) {
      console.log(`\nℹ️  提示（可能正常）:`);
      infoIssues.slice(0, 3).forEach(issue => {
        console.log(`  [${issue.sentenceId}] ${issue.issue}`);
      });
    }

    if (issues.length === 0) {
      console.log(`✅ 所有标注的主谓关系正确`);
    }

    expect(criticalIssues.length).toBe(0);
  });

  it("轮次 7: 从句识别检查", () => {
    console.log(`\n=== 轮次 7: 从句识别检查 ===\n`);

    const allSentences = loadAll32Annotations();
    const clauseStats = {
      withClauses: 0,
      withoutClauses: 0,
      clauseTypes: {} as Record<string, number>,
    };

    allSentences.forEach((sentence: any) => {
      const clauseRoles = ["SUBJECT_CLAUSE", "OBJECT_CLAUSE", "PREDICATIVE_CLAUSE", "ATTRIBUTIVE_CLAUSE", "ADVERBIAL_CLAUSE"];
      const clauses = sentence.components.filter((c: any) => clauseRoles.includes(c.role));

      if (clauses.length > 0) {
        clauseStats.withClauses++;
        clauses.forEach((c: any) => {
          clauseStats.clauseTypes[c.role] = (clauseStats.clauseTypes[c.role] || 0) + 1;
        });
      } else {
        clauseStats.withoutClauses++;
      }
    });

    console.log(`包含从句: ${clauseStats.withClauses} 个标注`);
    console.log(`简单句: ${clauseStats.withoutClauses} 个标注\n`);

    if (Object.keys(clauseStats.clauseTypes).length > 0) {
      console.log(`从句类型分布:`);
      Object.entries(clauseStats.clauseTypes).forEach(([type, count]) => {
        console.log(`  ${type}: ${count}`);
      });
    }

    console.log(`\n✅ 从句识别统计完成`);
  });

  it("轮次 8: 并列结构检查", () => {
    console.log(`\n=== 轮次 8: 并列结构检查 ===\n`);

    const allSentences = loadAll32Annotations();
    const conjunctionStats = {
      withConjunction: 0,
      withoutConjunction: 0,
      multipleSubjects: 0,
      multiplePredicates: 0,
    };

    allSentences.forEach((sentence: any) => {
      const hasConjunction = sentence.components.some((c: any) => c.role === "CONJUNCTION");
      const subjects = sentence.components.filter((c: any) => c.role === "SUBJECT");
      const predicates = sentence.components.filter((c: any) => c.role === "PREDICATE");

      if (hasConjunction) {
        conjunctionStats.withConjunction++;
      } else {
        conjunctionStats.withoutConjunction++;
      }

      if (subjects.length > 1) {
        conjunctionStats.multipleSubjects++;
      }

      if (predicates.length > 1) {
        conjunctionStats.multiplePredicates++;
      }
    });

    console.log(`包含 CONJUNCTION: ${conjunctionStats.withConjunction}`);
    console.log(`不含 CONJUNCTION: ${conjunctionStats.withoutConjunction}`);
    console.log(`多主语: ${conjunctionStats.multipleSubjects}`);
    console.log(`多谓语: ${conjunctionStats.multiplePredicates}\n`);

    console.log(`✅ 并列结构统计完成`);
  });
});

describe("轮次 9-10: 一致性与最终评分", () => {

  function loadAll32Annotations() {
    const batch1 = JSON.parse(fs.readFileSync(path.join(__dirname, "../../../test-output/auto-generated-gold-annotations.json"), "utf-8"));
    const batch2 = JSON.parse(fs.readFileSync(path.join(__dirname, "../../../test-output/retry-successful-annotations.json"), "utf-8"));
    const batch3 = JSON.parse(fs.readFileSync(path.join(__dirname, "../../../test-output/improved-successful-annotations.json"), "utf-8"));

    return [...batch1.sentences, ...batch2.sentences, ...batch3.sentences];
  }

  it("轮次 9: 标注风格一致性", () => {
    console.log(`\n=== 轮次 9: 标注风格一致性 ===\n`);

    const allSentences = loadAll32Annotations();

    // 检查同类句型的标注是否一致
    const simpleDeclarative = allSentences.filter((s: any) => {
      const tokens = tokenize(s.text);
      return tokens.length < 12 && !s.text.includes(",") && !s.text.includes("(");
    });

    console.log(`简单陈述句: ${simpleDeclarative.length} 个`);

    if (simpleDeclarative.length >= 2) {
      const componentCounts = simpleDeclarative.map((s: any) => s.components.length);
      const avg = componentCounts.reduce((a, b) => a + b, 0) / componentCounts.length;
      const stdDev = Math.sqrt(
        componentCounts.reduce((sum, val) => sum + Math.pow(val - avg, 2), 0) / componentCounts.length
      );

      console.log(`  平均成分数: ${avg.toFixed(1)}`);
      console.log(`  标准差: ${stdDev.toFixed(2)}`);

      if (stdDev > 2) {
        console.log(`  ⚠️  简单句的成分数量变化较大`);
      } else {
        console.log(`  ✅ 简单句的标注风格一致`);
      }
    }

    console.log(`\n✅ 一致性检查完成`);
  });

  it("轮次 10: 最终质量评分", () => {
    console.log(`\n=== 轮次 10: 最终质量评分 ===\n`);

    const allSentences = loadAll32Annotations();
    let totalScore = 0;
    const detailedScores: any[] = [];

    allSentences.forEach((sentence: any) => {
      let score = 100;
      const deductions: string[] = [];

      const tokens = tokenize(sentence.text);
      const nonPuncTokens = tokens.filter((t: any) => !t.punctuation);

      // 评分标准
      const hasSubject = sentence.components.some((c: any) => c.role === "SUBJECT");
      const hasPredicate = sentence.components.some((c: any) => c.role === "PREDICATE");

      if (!hasPredicate) {
        score -= 30;
        deductions.push("缺少谓语 (-30)");
      }

      if (!hasSubject && !sentence.text.match(/^(Start|Use|Think)/)) {
        score -= 20;
        deductions.push("缺少主语 (-20)");
      }

      // Token 覆盖
      const covered = new Set<number>();
      sentence.components.forEach((c: any) => {
        for (let i = c.startToken; i <= c.endToken; i++) {
          covered.add(i);
        }
      });
      const uncovered = nonPuncTokens.filter((t: any) => !covered.has(t.id));
      if (uncovered.length > 0) {
        score -= uncovered.length * 5;
        deductions.push(`有 ${uncovered.length} 个词未覆盖 (-${uncovered.length * 5})`);
      }

      // 翻译质量
      const emptyTranslations = sentence.components.filter((c: any) => !c.translation || c.translation.trim() === "");
      if (emptyTranslations.length > 0) {
        score -= emptyTranslations.length * 5;
        deductions.push(`有 ${emptyTranslations.length} 个空翻译 (-${emptyTranslations.length * 5})`);
      }

      // 成分数量
      const ratio = sentence.components.length / nonPuncTokens.length;
      if (ratio > 0.6) {
        score -= 5;
        deductions.push("可能过细 (-5)");
      }
      if (sentence.components.length < 2) {
        score -= 10;
        deductions.push("成分过少 (-10)");
      }

      score = Math.max(0, Math.min(100, score));
      totalScore += score;

      detailedScores.push({
        sentenceId: sentence.sentenceId,
        text: sentence.text,
        score,
        deductions,
      });
    });

    const avgScore = totalScore / allSentences.length;

    console.log(`=== 最终评分 ===\n`);
    console.log(`总句数: ${allSentences.length}`);
    console.log(`平均得分: ${avgScore.toFixed(1)}/100\n`);

    const excellent = detailedScores.filter(s => s.score >= 95).length;
    const good = detailedScores.filter(s => s.score >= 80 && s.score < 95).length;
    const fair = detailedScores.filter(s => s.score >= 70 && s.score < 80).length;
    const poor = detailedScores.filter(s => s.score < 70).length;

    console.log(`评级分布:`);
    console.log(`  优秀 (95-100): ${excellent} (${((excellent / allSentences.length) * 100).toFixed(1)}%)`);
    console.log(`  良好 (80-94): ${good} (${((good / allSentences.length) * 100).toFixed(1)}%)`);
    console.log(`  一般 (70-79): ${fair} (${((fair / allSentences.length) * 100).toFixed(1)}%)`);
    console.log(`  不合格 (<70): ${poor} (${((poor / allSentences.length) * 100).toFixed(1)}%)\n`);

    if (poor > 0) {
      console.log(`❌ 不合格标注:`);
      detailedScores.filter(s => s.score < 70).forEach(s => {
        console.log(`  [${s.sentenceId}] 得分: ${s.score}`);
        console.log(`    "${s.text.substring(0, 60)}..."`);
        s.deductions.forEach((d: string) => console.log(`    - ${d}`));
      });
    }

    if (avgScore >= 90) {
      console.log(`\n✅✅✅ 质量优秀！平均得分 ${avgScore.toFixed(1)}/100`);
      console.log(`建议: 立即合并到黄金标注集`);
    } else if (avgScore >= 80) {
      console.log(`\n✅ 质量良好，平均得分 ${avgScore.toFixed(1)}/100`);
      console.log(`建议: 可以合并，建议修正低分标注`);
    } else {
      console.log(`\n⚠️  质量中等，平均得分 ${avgScore.toFixed(1)}/100`);
      console.log(`建议: 修正后再合并`);
    }

    // 保存详细评分报告
    const reportPath = path.join(__dirname, "../../../test-output/final-quality-scores.json");
    fs.writeFileSync(reportPath, JSON.stringify({
      totalSentences: allSentences.length,
      averageScore: avgScore,
      distribution: { excellent, good, fair, poor },
      detailedScores,
    }, null, 2));

    console.log(`\n📊 详细评分已保存: ${reportPath}`);

    expect(avgScore).toBeGreaterThanOrEqual(85);
  });
});
