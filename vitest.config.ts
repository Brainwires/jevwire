/// <reference types="vitest" />
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    // A few tests spawn real git/node subprocesses; on a loaded machine those
    // exceed the 5 s default under CPU starvation even though they take ~1 s
    // unloaded. 20 s tolerates that while still catching a genuine hang.
    testTimeout: 40_000,
  },
});
