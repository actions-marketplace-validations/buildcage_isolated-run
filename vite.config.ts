import { defineConfig } from "vite-plus";

const generatedOutputs = ["dist/**"];
const fixtures = ["**/__fixtures__/**"];

export default defineConfig({
  lint: {
    ignorePatterns: generatedOutputs,
    options: { typeAware: true },
  },
  fmt: {
    ignorePatterns: [...generatedOutputs, ...fixtures, "MAINTAINERS.md"],
  },
  staged: {
    "*.{ts,tsx,js,jsx,json,jsonc,yaml,yml,md}": "vp check --fix",
    "docker/gen-seccomp-profile/**/*.go": "gofmt -w",
  },
  test: {
    include: ["src/**/*.test.ts"],
    restoreMocks: true,
    // No thresholds: this only makes the numbers visible. @vitest/coverage-v8
    // is pinned to the exact vitest version vite-plus bundles, which vite-plus
    // asserts at startup; bump both together.
    coverage: {
      provider: "v8",
      // Without an explicit include, v8 reports only files some test imported,
      // which hides the files that have no test at all.
      include: ["src/**/*.ts"],
      exclude: [
        "**/*.test.ts",
        ...fixtures,
        "**/*.d.ts",
        // Test scaffolding: the QuickJS shims and the QuickJS test runner.
        "src/core/lib/test/**",
        "src/core/scripts/test/**",
      ],
      // text goes to the CI log; the file copy is what the workflow pastes
      // into the job summary.
      reporter: [
        ["text", {}],
        ["text-summary", { file: "summary.txt" }],
      ],
    },
  },
});
