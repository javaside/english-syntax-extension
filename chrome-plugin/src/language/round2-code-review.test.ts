/**
 * 轮次 2: 代码审查与改进点识别
 */

import { describe, it } from "vitest";

describe("轮次 2: 代码审查与改进点识别", () => {

  it("审查现有硬门规则", () => {
    console.log(`\n=== 现有硬门规则审查 ===`);

    console.log(`\n已实现的硬门 (analysis-validator.ts):`);
    console.log(`1. ✅ 相邻 PREDICATE 必须合并 (PREDICATE_SCOPE_RULE)`);
    console.log(`   - 检测: previous.role === PREDICATE && current.role === PREDICATE`);
    console.log(`   - 条件: previous.endToken + 1 === current.startToken`);
    console.log(`   - 拦截: "You can press" 被拆成两个谓语`);

    console.log(`\n2. ✅ 谓语不得以限定词/主格代词开头`);
    console.log(`   - PREDICATE_HEAD_BLOCKERS = DETERMINERS ∪ SUBJECT_PRONOUNS`);
    console.log(`   - 拦截: "The components are..." → PREDICATE 吞了主语`);
    console.log(`   - 拦截: "She kept..." → PREDICATE 吞了主语`);

    console.log(`\n3. ✅ 谓语内部不得含限定词`);
    console.log(`   - 检测: words.slice(1).some(word => DETERMINERS.has(word))`);
    console.log(`   - 拦截: "build the components" → 宾语被吞进谓语`);

    console.log(`\n4. ✅ 从属连词不能引导 COORDINATE_CLAUSE`);
    console.log(`   - SUBORDINATING_CONJUNCTIONS 白名单`);
    console.log(`   - 拦截: "Because..." 被误标为并列分句`);

    console.log(`\n5. ✅ 介词不得独立成分`);
    console.log(`   - 检测: words.length === 1 && PREPOSITIONS.has(word)`);
    console.log(`   - 拦截: "into" 单独一个成分`);

    console.log(`\n6. ✅ CONJUNCTION 必须包含并列连词`);
    console.log(`   - COORDINATING_CONJUNCTIONS (FANBOYS)`);
    console.log(`   - 拦截: 逗号或从属连词被标为 CONJUNCTION`);

    console.log(`\n7. ✅ 单成分不得包住整句`);
    console.log(`   - 条件: components.length === 1 && 实词数 ≥ 3`);
    console.log(`   - 拦截: 整句只有一个 SUBJECT 或 PREDICATE`);

    console.log(`\n8. ✅ COORDINATE_CLAUSE 已废弃`);
    console.log(`   - 直接拦截任何 COORDINATE_CLAUSE`);
  });

  it("识别潜在的改进点", () => {
    console.log(`\n=== 潜在改进点 ===`);

    console.log(`\n【高优先级】`);

    console.log(`\n1. 🔧 助动词/情态动词检测`);
    console.log(`   问题: "must close" 可能被拆成两个 PREDICATE`);
    console.log(`   当前: 相邻 PREDICATE 规则可以拦截，但不够精确`);
    console.log(`   改进: 添加助动词/情态动词白名单，明确它们是谓语的一部分`);
    console.log(`   助动词: can, could, may, might, must, shall, should, will, would`);
    console.log(`   be动词: am, is, are, was, were, be, been, being`);
    console.log(`   have: have, has, had, having`);
    console.log(`   do: do, does, did`);

    console.log(`\n2. 🔧 介词短语完整性增强`);
    console.log(`   问题: "by designing" 可能被拆开`);
    console.log(`   当前: 只检测单词介词独立成分`);
    console.log(`   改进: 检测介词后必须跟名词性成分，不能直接接另一个 PREDICATE`);

    console.log(`\n3. 🔧 动名词/分词短语识别`);
    console.log(`   问题: "accepting consistency" 这类分词短语可能被误判`);
    console.log(`   当前: 无专门规则`);
    console.log(`   改进: 识别 -ing/-ed 结尾的词，检查其作为非谓语的合理性`);

    console.log(`\n【中优先级】`);

    console.log(`\n4. 📝 比较级结构 (than...)`);
    console.log(`   问题: "stricter than HTML" 的 "than HTML" 归属`);
    console.log(`   当前: 无专门规则`);
    console.log(`   改进: 提示词明确 than 引导的比较部分归入前面的成分`);

    console.log(`\n5. 📝 并列结构中的 and 处理`);
    console.log(`   问题: "close tags and wrap elements" 中的 and 是否标 CONJUNCTION`);
    console.log(`   当前: 提示词说「名词/形容词/副词短语内部的 and 不标」`);
    console.log(`   改进: 明确「并列谓语的 and 标 CONJUNCTION」`);

    console.log(`\n6. 📝 非限定性修饰语`);
    console.log(`   问题: 逗号后的分词短语、同位语等`);
    console.log(`   当前: 依赖模型理解`);
    console.log(`   改进: 提示词中明确处理方式`);

    console.log(`\n【低优先级】`);

    console.log(`\n7. 🎯 不定式结构 (to + 动词)`);
    console.log(`   问题: "to build" 这类不定式的归属`);
    console.log(`   当前: 依赖模型`);
    console.log(`   改进: 明确不定式作为完整成分还是附加到前面动词`);
  });

  it("制定轮次 3 改进计划", () => {
    console.log(`\n=== 轮次 3 改进计划 ===`);

    console.log(`\n目标: 加强助动词/情态动词检测`);
    console.log(`\n实施步骤:`);
    console.log(`1. 在 analysis-validator.ts 中添加助动词白名单`);
    console.log(`2. 添加新硬门: 检测助动词后是否紧跟主要动词`);
    console.log(`3. 如果助动词独立成 PREDICATE，报错要求合并`);
    console.log(`4. 添加测试用例验证`);

    console.log(`\n预期效果:`);
    console.log(`- 拦截: "must" 和 "close" 被拆成两个谓语`);
    console.log(`- 拦截: "is" 和 "stricter" 被拆开（系表结构）`);
    console.log(`- 拦截: "are" 和 "deployable" 被拆开（被动语态）`);
  });
});
