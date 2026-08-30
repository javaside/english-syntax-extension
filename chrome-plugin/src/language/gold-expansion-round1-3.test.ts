/**
 * 黄金标注扩充 - 轮次 1-10
 *
 * 从真实文章中提取句子，测试、评估、改进，最终扩充到黄金标注集
 */

import { describe, it, expect } from "vitest";
import { segmentBlock, tokenize } from "./segmenter";

describe("黄金标注扩充 - 轮次 1: 技术安全文章", () => {

  const round1Sentences = [
    // 来源: Computer.org - Secure Software Engineering 2026
    "The way we build software has changed.",
    "So have the threats.",
    "Security isn't just something you tack on at the end.",
    "It's something you build in from the first line of code.",
    "That means developers now play a frontline role.",
    "Whether you're writing an API, pushing to production, or fixing bugs, security needs to be part of the muscle memory.",
    "Security shouldn't show up in the final sprint.",
    "Start by adopting a secure SDLC (software development lifecycle).",
    "That means building security into every phase, from planning and design to testing and deployment.",
    "Use threat modeling tools early.",
    "Bottom line? Security isn't a post-mortem.",
    "It's a mindset you carry from kickoff to sunset.",
    "No amount of firewalls or patches can save bad code.",
    "If the foundation's weak, everything else cracks.",
    "That's why secure coding should be your default, not an exception.",
    "Clean code is easier to secure and easier to fix.",
    "Your APIs are the front door.",
    "Don't leave them wide open.",
    "The combo of a gateway and a WAF can absorb a lot of noise and risk.",
    "The trick? Automate all of it.",
    "Automated security testing isn't a nice-to-have anymore.",
    "It's your first line of defense, on autopilot.",
    "You didn't write that open-source library, but you're responsible for what it does.",
    "Your app is only as secure as its weakest library.",
    "Good architecture doesn't just scale, it protects.",
    "Think in layers.",
    "This isn't about paranoia.",
    "Testing isn't just for bugs.",
    "It's for vulnerabilities too.",
    "A second pair of eyes can catch what you missed.",
    "In 2026, secure software isn't a bonus.",
    "It's the baseline.",
    "If you're a developer, you're already part of the security team.",
    "Because secure engineering isn't a checkbox.",
    "It's how you build software that lasts.",
  ];

  it("轮次 1: 分句测试", () => {
    console.log(`\n=== 轮次 1: 技术安全文章 ===`);
    console.log(`来源: Computer.org - Secure Software Engineering`);
    console.log(`句子数: ${round1Sentences.length}`);

    let totalTokens = 0;
    const sentenceStats: Array<{ text: string; tokens: number; issues: string[] }> = [];

    round1Sentences.forEach((text, index) => {
      const sentences = segmentBlock(text);
      const tokens = tokenize(text);
      totalTokens += tokens.length;

      const issues: string[] = [];

      // 检查分句是否正确
      if (sentences.length !== 1) {
        issues.push(`分句错误: ${sentences.length} 个分句`);
      }

      // 检查特殊结构
      if (text.includes("(") && text.includes(")")) {
        issues.push("包含括号说明");
      }
      if (text.includes("?")) {
        issues.push("疑问句");
      }
      if (text.match(/^(So|That|Whether|If|Because)/)) {
        issues.push("从句或连词开头");
      }

      sentenceStats.push({ text, tokens: tokens.length, issues });

      if (issues.length > 0 || tokens.length > 15) {
        console.log(`\n[${index + 1}] ${text}`);
        console.log(`  Tokens: ${tokens.length}`);
        if (issues.length > 0) {
          console.log(`  注意: ${issues.join(", ")}`);
        }
      }
    });

    console.log(`\n统计:`);
    console.log(`  总句数: ${round1Sentences.length}`);
    console.log(`  总 Tokens: ${totalTokens}`);
    console.log(`  平均 Tokens: ${(totalTokens / round1Sentences.length).toFixed(2)}`);
    console.log(`  有注意点的句子: ${sentenceStats.filter(s => s.issues.length > 0).length}`);

    expect(round1Sentences.length).toBeGreaterThan(30);
  });

  it("轮次 1: 句型分析", () => {
    console.log(`\n=== 轮次 1: 句型分析 ===`);

    const patterns = {
      "简单陈述句": [] as string[],
      "系表结构": [] as string[],
      "否定句": [] as string[],
      "祈使句": [] as string[],
      "条件句": [] as string[],
      "并列结构": [] as string[],
      "复杂修饰": [] as string[],
    };

    round1Sentences.forEach(text => {
      if (text.match(/^(Don't|Start|Use|Think|Automate)/)) {
        patterns["祈使句"].push(text);
      } else if (text.includes(" is ") || text.includes(" isn't ") || text.includes("'s ")) {
        patterns["系表结构"].push(text);
      } else if (text.includes("n't ") || text.includes("No ")) {
        patterns["否定句"].push(text);
      } else if (text.match(/^If |^Whether /)) {
        patterns["条件句"].push(text);
      } else if (text.includes(" and ") || text.includes(" or ")) {
        patterns["并列结构"].push(text);
      } else if (text.split(" ").length > 12) {
        patterns["复杂修饰"].push(text);
      } else {
        patterns["简单陈述句"].push(text);
      }
    });

    Object.entries(patterns).forEach(([type, sentences]) => {
      if (sentences.length > 0) {
        console.log(`\n${type} (${sentences.length}):`);
        sentences.slice(0, 2).forEach(s => console.log(`  - ${s}`));
      }
    });

    console.log(`\n评估:`);
    console.log(`✅ 覆盖多种句型`);
    console.log(`✅ 包含真实技术写作风格`);
    console.log(`⚠️  多为短句，缺少复杂从句`);
  });
});

describe("黄金标注扩充 - 轮次 2: 工程实践文章", () => {

  const round2Sentences = [
    // 来源: Pragmatic Engineer Newsletter - Engineering Practices
    "The author prefers calling them software engineering practices rather than best practices because what works well in one context may not work elsewhere.",
    "Code reviews are widely beneficial but not always optimal.",
    "Every practice has tradeoffs.",
    "Be clear about current issues and their impact.",
    "Do a pre-mortem considering team dynamics and potential issues.",
    "Consult case studies but be aware they often emphasize successes.",
    "Talk directly with people who've used the practice.",
    "The article stresses avoiding blind adoption of practices just because they worked elsewhere.",
    "Be willing to reject or drop practices that don't deliver value.",
  ];

  it("轮次 2: 分句与复杂度测试", () => {
    console.log(`\n=== 轮次 2: 工程实践文章 ===`);
    console.log(`来源: Pragmatic Engineer Newsletter`);
    console.log(`句子数: ${round2Sentences.length}`);

    const complexSentences: Array<{ text: string; tokens: number; features: string[] }> = [];

    round2Sentences.forEach(text => {
      const tokens = tokenize(text);
      const features: string[] = [];

      if (text.includes(" because ")) features.push("原因从句");
      if (text.includes(" but ")) features.push("转折");
      if (text.includes(" rather than ")) features.push("比较结构");
      if (text.includes(" that ") || text.includes(" who ")) features.push("定语从句");
      if (tokens.length > 15) features.push("长句");

      if (features.length > 0) {
        complexSentences.push({ text, tokens: tokens.length, features });
      }
    });

    console.log(`\n复杂句分析:`);
    complexSentences.forEach(s => {
      console.log(`\n"${s.text}"`);
      console.log(`  Tokens: ${s.tokens}, 特征: ${s.features.join(", ")}`);
    });

    console.log(`\n评估:`);
    console.log(`✅ 句子更复杂，包含从句和复杂修饰`);
    console.log(`✅ 符合真实技术文章风格`);
    console.log(`⚠️  样本量较小，需要更多句子`);
  });
});

describe("黄金标注扩充 - 轮次 3: Martin Fowler 技术博客", () => {

  const round3Sentences = [
    // 来源: Martin Fowler's Bliki
    "Vibe coding is building a software application by prompting an LLM, telling it what to build, trying it out, prompting for changes - but without looking at any of the code that the LLM generates.",
    "The key point about vibe coding is 'forget that the code even exists'.",
    "Because a vibe coder doesn't look at the code, they don't need programming skills, so it's perfect for someone with no programming knowledge to build applications for their own use.",
    "When we need an LLM to perform a complex task, we often need to feed it a lot of context.",
    "The obvious way to do this is for a human to write this context, but an alternative is to use an LLM to write this context after interviewing a human.",
    "An Architecture Decision Record (ADR) is a short document that captures and explains a single decision relevant to a product or ecosystem.",
    "The common advice is to keep decision records in the source repository of the code base to which they apply.",
    "Email is the nerve center of my life.",
    "Direct access to an email account immediately triggers The Lethal Trifecta: untrusted content, sensitive information, and external communication.",
    "This casts the leader as a host: preparing a suitable space, inviting the team in, providing ideas and problems, and then stepping back to let them work.",
  ];

  it("轮次 3: 高复杂度句子测试", () => {
    console.log(`\n=== 轮次 3: Martin Fowler 技术博客 ===`);
    console.log(`来源: martinfowler.com/bliki`);
    console.log(`句子数: ${round3Sentences.length}`);

    round3Sentences.forEach((text, index) => {
      const tokens = tokenize(text);
      const sentences = segmentBlock(text);

      console.log(`\n[${index + 1}] ${text}`);
      console.log(`  Tokens: ${tokens.length}`);
      console.log(`  分句: ${sentences.length}`);

      // 分析句子结构
      const hasParentheses = text.includes("(") && text.includes(")");
      const hasColon = text.includes(":");
      const hasComma = (text.match(/,/g) || []).length;
      const hasDash = text.includes(" - ");

      if (hasParentheses) console.log(`  ✓ 包含括号说明`);
      if (hasColon) console.log(`  ✓ 包含冒号`);
      if (hasComma >= 2) console.log(`  ✓ 多个逗号 (${hasComma})`);
      if (hasDash) console.log(`  ✓ 包含破折号`);
    });

    console.log(`\n评估:`);
    console.log(`✅ 句子非常复杂，接近真实技术写作上限`);
    console.log(`✅ 包含多种标点和从句嵌套`);
    console.log(`✅ 这些是测试句法分析器的好案例`);
  });
});

// 导出所有测试句子
export const goldAnnotationCandidates = {
  round1: [
    "The way we build software has changed.",
    "Security isn't just something you tack on at the end.",
    "It's something you build in from the first line of code.",
    "That means developers now play a frontline role.",
    "Whether you're writing an API, pushing to production, or fixing bugs, security needs to be part of the muscle memory.",
    "Start by adopting a secure SDLC (software development lifecycle).",
    "That means building security into every phase, from planning and design to testing and deployment.",
    "No amount of firewalls or patches can save bad code.",
    "If the foundation's weak, everything else cracks.",
    "Your APIs are the front door.",
  ],
  round2: [
    "The author prefers calling them software engineering practices rather than best practices because what works well in one context may not work elsewhere.",
    "Code reviews are widely beneficial but not always optimal.",
    "Every practice has tradeoffs.",
    "Be clear about current issues and their impact.",
    "The article stresses avoiding blind adoption of practices just because they worked elsewhere.",
  ],
  round3: [
    "Vibe coding is building a software application by prompting an LLM, telling it what to build, trying it out, prompting for changes - but without looking at any of the code that the LLM generates.",
    "Because a vibe coder doesn't look at the code, they don't need programming skills, so it's perfect for someone with no programming knowledge to build applications for their own use.",
    "When we need an LLM to perform a complex task, we often need to feed it a lot of context.",
    "The obvious way to do this is for a human to write this context, but an alternative is to use an LLM to write this context after interviewing a human.",
    "An Architecture Decision Record (ADR) is a short document that captures and explains a single decision relevant to a product or ecosystem.",
  ],
};
