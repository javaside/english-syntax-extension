/**
 * 轮次 4-10: 快速迭代改进
 *
 * 策略调整：
 * - 硬门改进有边界（复杂模式需要模型理解）
 * - 转向提示词优化和黄金标注扩充
 * - 重点关注高频错误模式
 */

import { describe, it, expect } from "vitest";

describe("轮次 4-10: 快速迭代改进", () => {

  it("轮次 4: 提示词改进 - 动词组边界", () => {
    console.log(`\n=== 轮次 4: 提示词改进 ===`);

    console.log(`\n问题识别:`);
    console.log(`- 当前 PREDICATE_SCOPE_RULE 说"auxiliaries plus the main verb"`);
    console.log(`- 但没有明确"auxiliaries"包括哪些词`);
    console.log(`- 也没有说副词（independently）的位置`);

    console.log(`\n改进建议:`);
    console.log(`1. 在提示词中列举常见助动词`);
    console.log(`2. 明确说明："is independently deployable" 是一个 PREDICATE`);
    console.log(`3. 说明副词可以插在助动词和主要动词之间`);

    console.log(`\n优先级: 🔴 高（影响被动语态、进行时、完成时）`);
  });

  it("轮次 5: 黄金标注扩充 - 添加轮次1测试句", () => {
    console.log(`\n=== 轮次 5: 黄金标注扩充 ===`);

    console.log(`\n目标:`);
    console.log(`- 将轮次 1 的 10 个测试句子加入黄金标注`);
    console.log(`- 手工标注正确的句法结构`);
    console.log(`- 确保覆盖各种句型`);

    const sentences = [
      "React is a JavaScript library for building user interfaces.",
      "You must close all tags and wrap multiple elements in a parent.",
      "Services are independently deployable units.",
      "Component names must start with a capital letter.",
      "JSX is stricter than HTML.",
    ];

    console.log(`\n待标注句子（前5个）:`);
    sentences.forEach((s, i) => {
      console.log(`  ${i + 1}. ${s}`);
    });

    console.log(`\n优先级: 🟡 中（提升测试覆盖）`);
  });

  it("轮次 6: 介词短语完整性改进", () => {
    console.log(`\n=== 轮次 6: 介词短语完整性 ===`);

    console.log(`\n当前规则:`);
    console.log(`- 只拦截"介词独立成分"（单个词）`);
    console.log(`- 不检测介词后面跟什么`);

    console.log(`\n问题场景:`);
    console.log(`- "by designing views" 可能被拆成 [by] [designing views]`);
    console.log(`- "in a parent" 可能被拆成 [in] [a parent]`);

    console.log(`\n改进建议:`);
    console.log(`- 检测: 介词后面的成分不应该是另一个 PREDICATE`);
    console.log(`- 检测: 介词后面应该跟名词性成分`);
    console.log(`- 但这个规则可能误伤，需要谨慎`);

    console.log(`\n决定: ⚠️ 暂缓（误报风险高，提示词已有说明）`);
  });

  it("轮次 7: 并列连词 CONJUNCTION 使用明确化", () => {
    console.log(`\n=== 轮次 7: CONJUNCTION 使用明确化 ===`);

    console.log(`\n当前提示词:`);
    console.log(`- "Tag a coordinating conjunction as CONJUNCTION only when..."`);
    console.log(`- "it joins whole clauses or whole verb phrases"`);
    console.log(`- 名词/形容词/副词短语内部的 and 不标`);

    console.log(`\n问题:`);
    console.log(`- "close tags and wrap elements" 的 and 该不该标？`);
    console.log(`- 当前说法是"joins verb phrases"应该标`);
    console.log(`- 但实际是并列谓语，应该更明确`);

    console.log(`\n改进建议:`);
    console.log(`- 明确："close... and wrap..." 中的 and 标 CONJUNCTION`);
    console.log(`- 明确："designs and specs" 中的 and 不标（名词短语内部）`);
    console.log(`- 在提示词中给出明确例子`);

    console.log(`\n优先级: 🟡 中（已有规则，但可以更清晰）`);
  });

  it("轮次 8: 比较级结构明确化", () => {
    console.log(`\n=== 轮次 8: 比较级结构 ===`);

    console.log(`\n问题:`);
    console.log(`- "stricter than HTML" 的 "than HTML" 是什么成分？`);
    console.log(`- 应该归入 PREDICATIVE 还是单独的 ADVERBIAL？`);

    console.log(`\n决定:`);
    console.log(`- "stricter than HTML" 整体是 PREDICATIVE`);
    console.log(`- 比较部分不单独拆出来`);
    console.log(`- 在提示词中添加例子`);

    console.log(`\n优先级: 🟢 低（低频场景）`);
  });

  it("轮次 9: 动名词和分词短语指导", () => {
    console.log(`\n=== 轮次 9: 非谓语动词形式 ===`);

    console.log(`\n问题场景:`);
    console.log(`- "by designing views" - designing 是动名词`);
    console.log(`- "accepting consistency" - accepting 是现在分词`);
    console.log(`- "rather than handing off" - handing 是动名词`);

    console.log(`\n当前处理:`);
    console.log(`- 完全依赖模型理解`);
    console.log(`- 没有专门的硬门规则`);

    console.log(`\n改进建议:`);
    console.log(`- 提示词中明确：动名词短语作为完整成分`);
    console.log(`- 分词短语通常是修饰语（ADVERBIAL）`);
    console.log(`- 给出典型例子`);

    console.log(`\n优先级: 🟡 中（常见结构）`);
  });

  it("轮次 10: 总结与最终改进方向", () => {
    console.log(`\n=== 轮次 10: 总结 ===`);

    console.log(`\n已完成的改进:`);
    console.log(`✅ 轮次 1: 建立基线，10 个测试句子`);
    console.log(`✅ 轮次 2: 代码审查，识别 8 个现有硬门`);
    console.log(`✅ 轮次 3: 新增助动词检测，75% 成功率`);
    console.log(`📝 轮次 4-9: 识别了 6 个改进方向`);

    console.log(`\n最有价值的后续改进（按优先级）:`);
    console.log(`\n🔴 高优先级:`);
    console.log(`1. 提示词明确助动词列表和副词位置`);
    console.log(`   - 修改 PREDICATE_SCOPE_RULE`);
    console.log(`   - 添加示例："is independently deployable" 是一个 PREDICATE`);

    console.log(`\n🟡 中优先级:`);
    console.log(`2. 扩充黄金标注测试集`);
    console.log(`   - 添加轮次 1 的 10 个句子`);
    console.log(`   - 添加更多真实文档句子`);

    console.log(`3. 明确 CONJUNCTION 使用规则`);
    console.log(`   - 并列谓语的 and 要标`);
    console.log(`   - 名词短语内部的 and 不标`);

    console.log(`4. 非谓语动词形式指导`);
    console.log(`   - 动名词短语、分词短语的处理`);

    console.log(`\n🟢 低优先级:`);
    console.log(`5. 比较级结构明确化`);
    console.log(`6. 介词短语检测增强（风险高，暂缓）`);

    console.log(`\n核心发现:`);
    console.log(`- 硬门适合拦截明显错误（主语被吞、相邻谓语）`);
    console.log(`- 复杂语法现象应该在提示词中明确说明`);
    console.log(`- 黄金标注是验证质量的关键`);
    console.log(`- 需要实际模型输出来发现更多问题`);
  });
});
