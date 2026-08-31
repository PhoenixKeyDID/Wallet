import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    // The cardano core is pure TypeScript — no DOM needed.
    environment: "node",
    // `.tsx` and `extension/` are included even though no test lives there yet.
    // The old pattern was `src/**/*.test.ts`, so a component test or an
    // extension test would have been collected by nobody and reported by
    // nothing — a test file that never runs is worse than a missing one,
    // because the repo counts it as coverage.
    include: ["src/**/*.test.ts?(x)", "extension/**/*.test.ts?(x)"],
  },
});
