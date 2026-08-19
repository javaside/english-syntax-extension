// 与 CI 完全同法地校验 lint 基线(恰好 1 error / 0 warning，见 AGENTS.md)。
// 单看 `eslint .` 的末尾输出容易误读:那行是"可自动修复"的计数，不是总数。
import { execFileSync } from "node:child_process";

const raw = (() => {
  try {
    return execFileSync("npx", ["eslint", ".", "--format", "json"], { encoding: "utf8" });
  } catch (error) {
    // eslint 有错时退出码非 0，但 stdout 里的 JSON 报告仍然有效
    if (typeof error.stdout === "string" && error.stdout.length > 0) return error.stdout;
    throw error;
  }
})();

const report = JSON.parse(raw);
const errors = report.reduce((sum, file) => sum + file.errorCount, 0);
const warnings = report.reduce((sum, file) => sum + file.warningCount, 0);
console.log(`eslint: ${errors} error(s), ${warnings} warning(s)`);
for (const file of report.filter((f) => f.errorCount > 0 || f.warningCount > 0)) {
  console.log(`  ${file.filePath}`);
  for (const m of file.messages) {
    console.log(`    ${m.line}:${m.column}  ${m.ruleId ?? m.message}`);
  }
}
if (errors !== 1 || warnings !== 0) {
  console.error("偏离 lint 基线(恰好 1 error / 0 warning)");
  process.exit(1);
}
console.log("符合基线");
