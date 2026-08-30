import { describe, expect, it } from "vitest";
import { segmentBlock, tokenize } from "./segmenter";

/**
 * 轮次 1: 技术文档基线测试
 * 来源: GitHub Markdown 文档、React 文档、React README、微服务文章、BBC 新闻
 */
describe("轮次 1: 多类型文档分句测试", () => {
  const testCases = [
    // GitHub 文档 - 技术说明文本
    {
      category: "技术文档",
      source: "GitHub Markdown",
      text: "To create a heading, add one to six # symbols before your heading text.",
    },
    {
      category: "技术文档",
      source: "GitHub Markdown",
      text: "The number of # you use will determine the hierarchy level and typeface size of the heading.",
    },
    {
      category: "技术文档",
      source: "GitHub Markdown",
      text: "When you use two or more headings, GitHub automatically generates a table of contents that you can access by clicking the menu icon within the file header.",
    },
    {
      category: "技术文档",
      source: "GitHub Markdown",
      text: "You can indicate emphasis with bold, italic, strikethrough, subscript, or superscript text in comment fields and .md files.",
    },
    {
      category: "技术文档",
      source: "GitHub Markdown",
      text: "You can call out code or a command within a sentence with single backticks.",
    },
    {
      category: "技术文档",
      source: "GitHub Markdown",
      text: "The text within the backticks will not be formatted.",
    },
    {
      category: "技术文档",
      source: "GitHub Markdown",
      text: "You can also press Command+E (Mac) or Ctrl+E (Windows/Linux) keyboard shortcut to insert the backticks for a code block within a line of Markdown.",
    },

    // React 文档 - 教程文本
    {
      category: "教程",
      source: "React Tutorial",
      text: "React components are JavaScript functions that return markup.",
    },
    {
      category: "教程",
      source: "React Tutorial",
      text: "Component names must start with a capital letter.",
    },
    {
      category: "教程",
      source: "React Tutorial",
      text: "JSX is stricter than HTML.",
    },
    {
      category: "教程",
      source: "React Tutorial",
      text: "You must close all tags and wrap multiple elements in a parent.",
    },
    {
      category: "教程",
      source: "React Tutorial",
      text: "Use curly braces to embed JavaScript variables in JSX.",
    },
    {
      category: "教程",
      source: "React Tutorial",
      text: "Each list item needs a unique key.",
    },

    // React README - 项目说明
    {
      category: "README",
      source: "React README",
      text: "React is a JavaScript library for building user interfaces.",
    },
    {
      category: "README",
      source: "React README",
      text: "React enables creating interactive UIs by designing simple views for each state in your application.",
    },
    {
      category: "README",
      source: "React README",
      text: "You build encapsulated components that manage their own state, then compose them to make complex UIs.",
    },
    {
      category: "README",
      source: "React README",
      text: "React doesn't require assumptions about your full stack.",
    },
    {
      category: "README",
      source: "React README",
      text: "The repository's purpose is to continue evolving React core, making it faster and easier to use.",
    },

    // 微服务文章 - 技术文章
    {
      category: "技术文章",
      source: "Microservices Article",
      text: "Microservices is an approach to developing a single application as a suite of small services.",
    },
    {
      category: "技术文章",
      source: "Microservices Article",
      text: "Each service runs in its own process and communicates with lightweight mechanisms.",
    },
    {
      category: "技术文章",
      source: "Microservices Article",
      text: "Services are independently deployable units, unlike libraries that require full application redeployment.",
    },
    {
      category: "技术文章",
      source: "Microservices Article",
      text: "Teams are cross-functional and aligned to business domains rather than technology layers.",
    },
    {
      category: "技术文章",
      source: "Microservices Article",
      text: "Teams own services for their full lifetime rather than handing off to maintenance.",
    },
    {
      category: "技术文章",
      source: "Microservices Article",
      text: "Each service manages its own database, accepting eventual consistency over distributed transactions.",
    },

    // BBC 新闻 - 新闻报道
    {
      category: "新闻",
      source: "BBC News",
      text: "At least 675 people have died in Nepal, local authorities say.",
    },
    {
      category: "新闻",
      source: "BBC News",
      text: "The country's tourism board says 320 foreign nationals are among the missing.",
    },
    {
      category: "新闻",
      source: "BBC News",
      text: "A vote on whether to resume membership talks with the European Union is too close to call.",
    },
    {
      category: "新闻",
      source: "BBC News",
      text: "The self-styled provocateur had been detained by Immigration and Customs Enforcement.",
    },
    {
      category: "新闻",
      source: "BBC News",
      text: "According to official figures only 1,811 cuttlefish turned up to mate this year, down 97% on last year.",
    },
  ];

  it("应该正确分句所有测试用例", () => {
    let totalSentences = 0;
    let totalTokens = 0;
    const categoryStats: Record<string, { count: number; tokens: number }> = {};

    testCases.forEach((testCase) => {
      const sentences = segmentBlock(testCase.text);

      // 每个测试用例应该是单句（已经是单句输入）
      expect(sentences).toHaveLength(1);
      expect(sentences[0].text).toBe(testCase.text);

      const tokens = tokenize(testCase.text);
      totalTokens += tokens.length;
      totalSentences++;

      // 统计分类
      if (!categoryStats[testCase.category]) {
        categoryStats[testCase.category] = { count: 0, tokens: 0 };
      }
      categoryStats[testCase.category].count++;
      categoryStats[testCase.category].tokens += tokens.length;
    });

    console.log(`\n=== 轮次 1 基线测试统计 ===`);
    console.log(`总测试句数: ${totalSentences}`);
    console.log(`总 token 数: ${totalTokens}`);
    console.log(`平均每句 token 数: ${(totalTokens / totalSentences).toFixed(2)}`);
    console.log(`\n分类统计:`);
    Object.entries(categoryStats).forEach(([category, stats]) => {
      console.log(`  ${category}: ${stats.count} 句, 平均 ${(stats.tokens / stats.count).toFixed(2)} tokens`);
    });
  });

  // 测试复杂句子
  it("应该正确处理复杂技术句子", () => {
    const complexSentences = [
      "When you use two or more headings, GitHub automatically generates a table of contents that you can access by clicking the menu icon within the file header.",
      "You can also press Command+E (Mac) or Ctrl+E (Windows/Linux) keyboard shortcut to insert the backticks for a code block within a line of Markdown.",
      "React enables creating interactive UIs by designing simple views for each state in your application.",
      "You build encapsulated components that manage their own state, then compose them to make complex UIs.",
      "Services are independently deployable units, unlike libraries that require full application redeployment.",
    ];

    complexSentences.forEach((text) => {
      const sentences = segmentBlock(text);
      const tokens = tokenize(text);

      console.log(`\n复杂句: "${text}"`);
      console.log(`  Token 数: ${tokens.length}`);
      console.log(`  分句数: ${sentences.length}`);

      expect(sentences).toHaveLength(1);
      expect(tokens.length).toBeGreaterThan(10); // 复杂句应该有足够的 tokens
    });
  });
});
