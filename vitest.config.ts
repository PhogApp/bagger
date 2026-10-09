import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Each database test starts its own in-process Postgres and applies the
    // real migrations, which can take a few seconds on a busy CI machine.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
