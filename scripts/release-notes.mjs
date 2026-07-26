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
    `1. 下载下方的 \`english-syntax-extension-v${version}.zip\`；`,
    "2. 解压到一个**不会被删掉**的目录（Chrome 每次启动都从这里读取）；",
    "3. 打开 `chrome://extensions`，右上角开启「开发者模式」；",
    "4. 点「加载已解压的扩展程序」，选择解压出的目录；",
    "5. 右键扩展图标 →「选项」，配置你的模型端点。",
    "",
    "> 本扩展未上架应用商店，Chrome 会周期性提示「禁用开发者模式扩展」，选择保留即可。",
    "",
    "> **用本地思考模型（Qwen3 等）请先在选项页勾选「关闭模型思考」**，" +
      "否则单句推理会超时，表现为整页没有译文。",
  ].join("\n");
}

export function buildReleaseBody(changelog, version) {
  const notes = extractReleaseNotes(changelog, version);
  if (notes === undefined) throw new Error(`CHANGELOG.md 里找不到 ${version} 这一节`);
  return `${installSection(version)}\n\n---\n\n${notes}\n`;
}

// 作为 CLI 运行时才读写文件，便于上面的纯函数被测试直接引用。
if (import.meta.url === `file://${process.argv[1]}`) {
  const { readFileSync, writeFileSync } = await import("node:fs");
  const version = process.argv[2] ?? JSON.parse(readFileSync("package.json", "utf8")).version;
  const body = buildReleaseBody(readFileSync("CHANGELOG.md", "utf8"), version);
  const out = process.argv[3] ?? "RELEASE_NOTES.md";
  writeFileSync(out, body);
  console.log(`${out}: ${body.length} 字符（版本 ${version}）`);
}
