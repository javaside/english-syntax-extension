import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/**/*.test.ts",
      "scripts/**/*.test.mjs",
      "intellij-plugin/src/main/resources/web/**/*.test.ts",
    ],
    restoreMocks: true,
  },
});
