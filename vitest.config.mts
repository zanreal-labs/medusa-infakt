import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      exclude: ["**/*.test.ts", "**/.medusa/**", "**/node_modules/**", "src/admin/**"],
      include: ["src/**/*.ts"],
      provider: "v8",
    },
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
