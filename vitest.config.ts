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
    include: ["src/**/*.test.ts"],
  },
});
