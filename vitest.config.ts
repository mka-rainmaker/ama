import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Fixtures are analyzer input, not tests — never run them (some are named
    // `*.test.ts` deliberately, e.g. to exercise test-file detection).
    exclude: [...configDefaults.exclude, "tests/fixtures/**"],
    environment: "node",
  },
});
