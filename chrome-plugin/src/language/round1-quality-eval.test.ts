import { describe, expect, it } from "vitest";
import { tokenize } from "./segmenter";
import { validateCoreBatch } from "./analysis-validator";
import { GrammarRole } from "../shared/grammar";
import type { SentenceInput } from "../shared/protocol";

/**
 * 轮次 1: 句法分析质量评估
 *
 * 这一轮我们发现了一个重要限制：
 * validateCoreBatch 需要模型的原始输出，不能用于验证手工构造的分析结果。
 *
 * 因此，我们改变策略：
 * 1. 记录这些测试句子和预期结构
 * 2. 在实际使用中收集模型输出
 * 3. 分析实际问题并改进
 *
 * 当前我们先总结第一轮发现：
 */
describe("轮次 1: 基线建立与问题识别", () => {

  const testSentences = [
    // 简单句
    { text: "React is a JavaScript library for building user interfaces.", category: "简单句-系表" },
    { text: "You must close all tags and wrap multiple elements in a parent.", category: "简单句-并列谓语" },
    { text: "Services are independently deployable units.", category: "简单句-被动" },
    { text: "Component names must start with a capital letter.", category: "简单句-情态动词" },
    { text: "JSX is stricter than HTML.", category: "简单句-比较级" },

    // 复杂句
    { text: "When you use two or more headings, GitHub automatically generates a table of contents.", category: "复杂句-时间状语从句" },
    { text: "You build encapsulated components that manage their own state.", category: "复杂句-定语从句" },
    { text: "React enables creating interactive UIs by designing simple views for each state in your application.", category: "复杂句-动名词+介词短语" },
    { text: "Teams own services for their full lifetime rather than handing off to maintenance.", category: "复杂句-rather than结构" },
    { text: "Each service manages its own database, accepting eventual consistency over distributed transactions.", category: "复杂句-现在分词短语" },
  ];

  it("建立测试句子库", () => {
    console.log(`\n=== 轮次 1: 建立基线 ===`);
    console.log(`总测试句数: ${testSentences.length}`);

    const byCategory: Record<string, number> = {};
    testSentences.forEach(s => {
      const tokens = tokenize(s.text);
      byCategory[s.category] = (byCategory[s.category] || 0) + 1;
      console.log(`\n[${s.category}]`);
      console.log(`  "${s.text}"`);
      console.log(`  Token 数: ${tokens.length}`);
    });

    console.log(`\n分类统计:`);
    Object.entries(byCategory).forEach(([cat, count]) => {
      console.log(`  ${cat}: ${count} 句`);
    });

    expect(testSentences.length).toBeGreaterThan(0);
  });

  it("识别常见错误模式（理论分析）", () => {
    console.log(`\n=== 常见错误模式 ===`);
    console.log(`\n基于 1.3.0 版本的硬门，我们可以拦截：`);
    console.log(`  ✓ 主语被吞进谓语（谓语以主格代词开头）`);
    console.log(`  ✓ 主语被吞进谓语（谓语以限定词开头）`);
    console.log(`  ✓ 宾语被吞进谓语（谓语内部含限定词）`);
    console.log(`  ✓ 从属连词误判为并列句`);
    console.log(`  ✓ 相邻谓语未合并`);
    console.log(`  ✓ 单成分包住整句`);
    console.log(`  ✓ 介词独立成分`);
    console.log(`  ✓ COORDINATE_CLAUSE 已废弃`);

    console.log(`\n可能存在的问题（需要真实模型验证）：`);
    console.log(`  ? 情态动词 + 动词被拆成两个谓语`);
    console.log(`  ? 被动语态的 be + 过去分词被拆开`);
    console.log(`  ? 介词短语被误拆（介词和宾语分开）`);
    console.log(`  ? 动名词短语划分不准确`);
    console.log(`  ? 现在分词短语识别问题`);
    console.log(`  ? 比较级结构 (than...) 处理`);
    console.log(`  ? rather than 这类连接词处理`);
    console.log(`  ? 并列成分内部的 and 是否需要标 CONJUNCTION`);
  });

  it("下一步计划", () => {
    console.log(`\n=== 轮次 2 计划 ===`);
    console.log(`1. 创建一个简单的模拟测试环境`);
    console.log(`2. 观察这些句子的实际分析结果`);
    console.log(`3. 识别最高频的错误模式`);
    console.log(`4. 针对性改进硬门或提示词`);
    console.log(`5. 扩充黄金标注测试集`);

    console.log(`\n重点关注领域：`);
    console.log(`  - 动词短语的边界识别（情态动词、被动语态）`);
    console.log(`  - 介词短语的完整性（不拆分）`);
    console.log(`  - 非谓语动词形式（动名词、分词）`);
    console.log(`  - 并列结构的识别（何时标 CONJUNCTION）`);
  });
});

// 导出测试句子供其他模块使用
export const round1TestSentences = [
  "React is a JavaScript library for building user interfaces.",
  "You must close all tags and wrap multiple elements in a parent.",
  "Services are independently deployable units.",
  "Component names must start with a capital letter.",
  "JSX is stricter than HTML.",
  "When you use two or more headings, GitHub automatically generates a table of contents.",
  "You build encapsulated components that manage their own state.",
  "React enables creating interactive UIs by designing simple views for each state in your application.",
  "Teams own services for their full lifetime rather than handing off to maintenance.",
  "Each service manages its own database, accepting eventual consistency over distributed transactions.",
];
