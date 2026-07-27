import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "coverage/**",
      "playwright-report/**",
      "test-results/**",
      ".superpowers/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    // page.evaluate 的回调在浏览器里执行:Image / document 是那个上下文的全局对象。
    // 只对这个文件放行，避免把浏览器全局撒给其余 Node 脚本而放过真正的笔误。
    files: ["scripts/generate-icons.mjs", "scripts/generate-promo.mjs"],
    languageOptions: {
      globals: { Image: "readonly", document: "readonly", Buffer: "readonly" },
    },
  },
  {
    // 构建脚本是纯 ESM 工具代码，不在 tsconfig 的 include 里:开着类型感知规则会直接
    // 报 "not found by the project service"。仍然吃 recommended 规则，只是不做类型检查。
    files: ["**/*.js", "**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      // 必须并进来，不能整体覆盖:disableTypeChecked 正是通过 languageOptions
      // 关掉项目服务的，直接写同名键会把它重新打开。
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: { console: "readonly", process: "readonly" },
    },
  },
);
