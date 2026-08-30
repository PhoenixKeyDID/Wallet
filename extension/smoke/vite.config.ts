/**
 * Builds `entry.ts` with the same plugins, aliases and browser target as the
 * popup, so the smoke check exercises the module graph the user would actually
 * install — not a smaller one that happens to agree.
 *
 * It stays a `lib` build rather than reusing `popup.html` for one reason:
 * `popup.tsx` calls `createRoot` at module scope, which needs a DOM. `entry.ts`
 * imports the same modules without mounting them, so module-evaluation crashes
 * still surface here while the check keeps running under plain Node.
 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");

export default defineConfig({
  root: here,
  plugins: [react()],
  // Vite's app build replaces `process.env.NODE_ENV` at compile time — measured:
  // the shipped `dist-extension/popup.js` contains zero occurrences of it. A
  // `lib` build leaves the substitution to the consumer, so without this the
  // smoke would fail on a difference it introduced itself rather than on
  // anything the user would hit.
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  resolve: { alias: { "@": resolve(repo, "src") } },
  build: {
    outDir: resolve(here, "out"),
    emptyOutDir: true,
    minify: false,
    lib: { entry: resolve(here, "entry.ts"), formats: ["es"], fileName: "smoke" },
  },
});
