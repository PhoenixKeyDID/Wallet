/**
 * Extension build.
 *
 * Two properties matter more than convenience here:
 *
 * - **No remote code, ever.** The manifest sets `script-src 'self'`, so every
 *   line that runs must be in the package a reviewer can read. Nothing is
 *   fetched at runtime — the locale JSON is bundled, not loaded.
 * - **A build a stranger can reproduce.** `bun install && bun run build:ext`
 *   with no credentials and no environment variables. Anyone can rebuild this
 *   from the tag and diff it against what the store serves, which is the only
 *   version of "open source" that means anything for a wallet.
 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { copyFileSync, existsSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");

export default defineConfig({
  root: here,
  // Relative asset paths: an extension page is served from the package root,
  // and relative URLs keep the bundle loadable however it is packed.
  base: "./",
  plugins: [
    react(),
    {
      name: "phoenix-copy-static",
      closeBundle() {
        const out = resolve(repo, "dist-extension");
        for (const f of ["manifest.json", "icon128.png"]) {
          const from = resolve(here, f);
          if (existsSync(from)) copyFileSync(from, resolve(out, f));
        }
      },
    },
  ],
  resolve: {
    alias: { "@": resolve(repo, "src") },
  },
  build: {
    outDir: resolve(repo, "dist-extension"),
    emptyOutDir: true,
    // Readable output. A minified wallet bundle is one a reviewer cannot check
    // against the source, which defeats the point of publishing the source.
    minify: false,
    rollupOptions: {
      input: { popup: resolve(here, "popup.html") },
      output: { entryFileNames: "[name].js", chunkFileNames: "[name].js", assetFileNames: "[name].[ext]" },
    },
  },
});
