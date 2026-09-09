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
 *
 *   `VITE_CHAIN_BASE_*` / `VITE_BLOCKFROST_PROJECT_ID_*` (see
 *   `src/lib/cardano/chainEnv.ts`) are the one exception, and they do not weaken
 *   that property — with none set the build is byte-identical to the one above.
 *   Setting one compiles an endpoint, and possibly a key, into the package: a
 *   build that is no longer the published one, and whose key is readable by
 *   anyone who unpacks it. That is a deliberate local build, not something to
 *   hand to anybody.
 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { chainSourceFromEnv } from "../src/lib/cardano/chainEnv";
import type { PhoenixNetwork } from "../src/lib/cardano/address";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");

/**
 * Hosts this particular build was pointed at, beyond the ones shipped by default.
 *
 * Asked of `chainSourceFromEnv` rather than worked out here, so the vendor host
 * for each network has one definition (`chainEnv.ts`) and this reads it. A copy
 * would be a second place to update when Blockfrost changes an address, and the
 * copy would not fail — it would grant reach to the wrong host and stay quiet.
 */
function extraChainOrigins(env: NodeJS.ProcessEnv): string[] {
  const origins = new Set<string>();
  for (const network of [0, 1, 2] as PhoenixNetwork[]) {
    const src = chainSourceFromEnv(network, env as Record<string, string | undefined>);
    // `.origin` rather than assembling a scheme around `.host`: `check:urls`
    // bans a URL built by interpolation, and it is right to — a host dropped
    // into a scheme is a host nobody reviewed. Nothing is assembled here. The
    // whole origin is parsed out of one value that already exists, so there is
    // no seam where a different host could be introduced.
    if (src && src.kind === "blockfrost") origins.add(new URL(src.base).origin);
  }
  return [...origins];
}

export default defineConfig({
  root: here,
  // Relative asset paths: an extension page is served from the package root,
  // and relative URLs keep the bundle loadable however it is packed.
  base: "./",
  plugins: [
    react(),
    {
      name: "phoenix-copy-static",
      /**
       * Copies the static files, and widens the manifest to match the build.
       *
       * The manifest is a static file; the chain endpoint is a build-time
       * choice. Left alone, the two drift in both directions and each one hurts
       * a different person:
       *
       * - **Manifest ahead of the build.** The published package would carry
       *   cross-origin reach to three `blockfrost.io` hosts that the published
       *   build never calls — with no variable set, `chainSourceFromEnv`
       *   returns `null` and the wallet reads Koios. A permission granted by
       *   every installer for a feature that exists only in somebody else's
       *   private build, and the first thing a store review asks about.
       * - **Build ahead of the manifest.** Point a build at your own node,
       *   forget the manifest, and Chrome blocks every chain read; the wallet
       *   then says the endpoint gave no readable reply, which sends you to
       *   inspect a node that is answering fine.
       *
       * Deriving one from the other removes both directions at once, and keeps
       * the reproducibility claim above literally true: with no variable set
       * nothing is added, and the emitted file is the checked-in file.
       */
      closeBundle() {
        const out = resolve(repo, "dist-extension");
        if (existsSync(resolve(here, "icon128.png"))) {
          copyFileSync(resolve(here, "icon128.png"), resolve(out, "icon128.png"));
        }
        const raw = readFileSync(resolve(here, "manifest.json"), "utf8");
        const extra = extraChainOrigins(process.env).filter((o) => !raw.includes(o));
        if (extra.length === 0) {
          copyFileSync(resolve(here, "manifest.json"), resolve(out, "manifest.json"));
          return;
        }
        const m = JSON.parse(raw);
        m.host_permissions = [...(m.host_permissions ?? []), ...extra.map((o) => o + "/*")];
        const csp = m.content_security_policy?.extension_pages;
        if (typeof csp === "string") {
          m.content_security_policy.extension_pages = csp.replace(
            /(connect-src [^;]*)/,
            (seg: string) => seg + " " + extra.join(" "),
          );
        }
        writeFileSync(resolve(out, "manifest.json"), JSON.stringify(m, null, 2) + "\n");
        console.log("[phoenix] manifest widened for this build: " + extra.join(", "));
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
      /**
       * Five entry points, and the three new ones are separate on purpose.
       *
       * `content` and `inpage` run in a web page's process, not in the
       * extension's, so anything they pull in ships to every site the user
       * visits. Keeping them out of the popup's graph is what stops the wallet,
       * the keystore and Argon2 from being loaded into every page — which would
       * be both a large download on every navigation and a much wider surface
       * than either script needs. `background` is separate because a service
       * worker has no DOM and must not be handed code that assumes one.
       *
       * `approve` is the wallet window a website's request opens: it does have
       * the keystore, and it is the only one of the three new surfaces that does.
       */
      input: {
        popup: resolve(here, "popup.html"),
        approve: resolve(here, "approve.html"),
        content: resolve(here, "content/bridge.ts"),
        inpage: resolve(here, "inpage/provider.ts"),
        background: resolve(here, "background/worker.ts"),
      },
      output: { entryFileNames: "[name].js", chunkFileNames: "[name].js", assetFileNames: "[name].[ext]" },
    },
  },
});
