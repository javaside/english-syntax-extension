import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/main/resources/web/**/*.test.ts"],
    restoreMocks: true,
  },
});
