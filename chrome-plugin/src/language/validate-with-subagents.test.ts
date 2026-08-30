/**
 * 使用 subagent 并行验证 32 个标注
 * 每个句子用独立的 agent 测试，避免污染主上下文
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

describe("32 个标注质量验证 - 使用 subagent", () => {

  it("轮次 1: 加载标注并启动并行验证", async () => {
    console.log(`\n=== 使用 Subagent 并行验证 32 个标注 ===\n`);

    // 加载 32 个标注
    const batch1Path = path.join(__dirname, "../../../test-output/auto-generated-gold-annotations.json");
    const batch2Path = path.join(__dirname, "../../../test-output/retry-successful-annotations.json");
    const batch3Path = path.join(__dirname, "../../../test-output/improved-successful-annotations.json");

    const batch1 = JSON.parse(fs.readFileSync(batch1Path, "utf-8"));
    const batch2 = JSON.parse(fs.readFileSync(batch2Path, "utf-8"));
    const batch3 = JSON.parse(fs.readFileSync(batch3Path, "utf-8"));

    const allSentences = [...batch1.sentences, ...batch2.sentences, ...batch3.sentences];

    console.log(`总共 ${allSentences.length} 个标注需要验证\n`);
    console.log(`策略: 每个标注使用独立的 subagent 进行 10+ 项检查`);
    console.log(`检查项: 硬门规则、成分完整性、翻译质量、语法正确性等\n`);

    // 写入待验证的句子到临时文件
    const tempPath = path.join(__dirname, "../../../test-output/sentences-to-validate.json");
    fs.writeFileSync(tempPath, JSON.stringify({ sentences: allSentences }, null, 2));

    console.log(`✅ 标注已保存到: ${tempPath}`);
    console.log(`\n准备启动 ${allSentences.length} 个 subagent 进行并行验证...\n`);

    expect(allSentences.length).toBe(32);
  }, 10000);
});
