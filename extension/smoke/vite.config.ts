/**
 * Builds `entry.ts` with the same browser target as the popup, so the smoke
 * check exercises the bundle the user would actually install.
 */
import { defineConfig } from "vite";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  build: {
    outDir: resolve(here, "out"),
    emptyOutDir: true,
    minify: false,
    lib: { entry: resolve(here, "entry.ts"), formats: ["es"], fileName: "smoke" },
  },
});
