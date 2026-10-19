import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Some tests build a real index (HNSW) or run a command as a process. They take a few seconds
    // alone and longer when the whole suite runs in parallel, so vitest's default of 5 seconds
    // failed them at random.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
