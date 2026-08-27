// 从 CHANGELOG.md 里切出指定版本那一节，并在前面补安装说明，作为 Release 正文。
// 直接把整个 CHANGELOG 当正文的话，发 1.1.0 时会连所有历史版本一起贴出去。

/** 取出 `## <version>` 到下一个 `## ` 之间的内容（不含标题行本身）。 */
export function extractReleaseNotes(changelog, version) {
  const lines = changelog.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`## ${version}`));
  if (start === -1) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  const body = (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
  return body.length === 0 ? undefined : body;
}

export function installSection(version) {
  return [
    "## 安装",
    "",
    "两个运行时各自独立，装哪个都不影响另一个。",
    "",
    "### Chrome 扩展",
    "",
    `1. 下载下方的 \`english-syntax-extension-v${version}.zip\`；`,
    "2. 解压到一个**不会被删掉**的目录（Chrome 每次启动都从这里读取）；",
    "3. 打开 `chrome://extensions`，右上角开启「开发者模式」；",
    "4. 点「加载已解压的扩展程序」，选择解压出的目录；",
    "5. 右键扩展图标 →「选项」，配置你的模型端点。",
    "",
    "> 本扩展未上架应用商店，Chrome 会周期性提示「禁用开发者模式扩展」，选择保留即可。",
    "",
    "### IntelliJ IDEA 插件（Markdown 预览里学句法）",
    "",
    `1. 下载下方的 \`intellij-plugin-${version}.zip\`（**不要解压**）；`,
    "2. `Settings / Preferences → Plugins → ⚙ → Install Plugin from Disk…`，选中该 zip；",
    "3. 重启 IDE；",
    "4. `Settings → Tools → English Syntax Learning`，配置模型端点与 API key（key 存进 PasswordSafe，不进任何日志）；",
    "5. 打开一份 Markdown 切到预览，`Tools → 句法学习 → 开始句法学习`；" +
      "或把鼠标停在某一段上按 `Alt+T`（Mac：`Option+T`），只解析那一段。",
    "",
    "> 需要 IDEA 2025.1+ 且运行在自带 JCEF 的 JetBrains Runtime 上；预览面板不可用时 Action 会置灰并提示。",
    "",
    "> 思考模型(Qwen3、DeepSeek v4 等)会为一句话先生成上万 token 推理，" +
      "扩展与插件默认已要求模型不做思考，无需任何设置;端点不接受该参数时会自动去掉并重发。",
  ].join("\n");
}

export function buildReleaseBody(changelog, version) {
  const notes = extractReleaseNotes(changelog, version);
  if (notes === undefined) throw new Error(`CHANGELOG.md 里找不到 ${version} 这一节`);
  return `${installSection(version)}\n\n---\n\n${notes}\n`;
}

// 作为 CLI 运行时才读写文件，便于上面的纯函数被测试直接引用。
// CHANGELOG 在仓库根（../CHANGELOG.md），版本文件在 chrome-plugin/ 内。
if (import.meta.url === `file://${process.argv[1]}`) {
  const { readFileSync, writeFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const version = process.argv[2] ?? JSON.parse(readFileSync("package.json", "utf8")).version;
  const body = buildReleaseBody(readFileSync(resolve("../CHANGELOG.md"), "utf8"), version);
  const out = process.argv[3] ?? "RELEASE_NOTES.md";
  writeFileSync(out, body);
  console.log(`${out}: ${body.length} 字符（版本 ${version}）`);
}
