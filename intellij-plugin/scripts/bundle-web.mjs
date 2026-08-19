// 把 web TS 打包成单文件 IIFE,供 JCEF 预览页 <script> 注入。
// 依赖子工程 node_modules 里的 rolldown(vitest 传递依赖),不新增 devDependency。
import { build } from "rolldown";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const webDir = join(here, "..", "src", "main", "resources", "web");

await build({
  input: join(webDir, "bootstrap-entry.ts"),
  output: {
    file: join(webDir, "bundle.js"),
    format: "iife",
    name: "EnglishSyntaxPreview",
  },
});
console.log("bundle.js written");
