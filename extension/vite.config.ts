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
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { chainSourceFromEnv } from "../src/lib/cardano/chainEnv";
import type { PhoenixNetwork } from "../src/lib/cardano/address";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");

/** Where the build receipt goes, and the name `check:package` looks for. */
const ORIGINS_RECEIPT = ".chain-origins.json";

/**
 * Every chain origin this build actually compiled in.
 *
 * Asked of `chainSourceFromEnv` rather than worked out here, so the vendor host
 * for each network has one definition (`chainEnv.ts`) and this reads it. A copy
 * would be a second place to update when Blockfrost changes an address, and the
 * copy would not fail — it would grant reach to the wrong host and stay quiet.
 *
 * **Only `VITE_*`.** `chainSourceFromEnv` also honours `NEXT_PUBLIC_*`, because
 * the same module is compiled by the web app's bundler. Nothing under that
 * prefix reaches an extension bundle, so letting it through here would widen a
 * shipped extension's reach because of a variable left in a shell by the web
 * app's dev loop — a permission granted for a host the package never calls.
 */
export function extraChainOrigins(env: Record<string, string | undefined>): string[] {
  const viteOnly = Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith("VITE_")));
  const origins = new Set<string>();
  for (const network of [0, 1, 2] as PhoenixNetwork[]) {
    const src = chainSourceFromEnv(network, viteOnly);
    // `.origin` rather than assembling a scheme around `.host`: `check:urls`
    // bans a URL built by interpolation, and it is right to — a host dropped
    // into a scheme is a host nobody reviewed. Nothing is assembled here. The
    // whole origin is parsed out of one value that already exists, so there is
    // no seam where a different host could be introduced.
    if (src && src.kind === "blockfrost") {
      const u = new URL(src.base);
      // Refused at the point of writing, not left for the packaging gate.
      //
      // A Chrome match pattern has no place for a port: `https://host:8443/*`
      // matches nothing, so the extension cannot reach that endpoint at all.
      // Writing it anyway produces a manifest that loads and an extension that
      // silently reaches nothing, and the wallet reports the endpoint as down.
      // The gate catches it, but by then the build has already succeeded and
      // somebody may have packed the directory.
      //
      // `chainSource.ts` allows a port on purpose — the wallet also runs as a
      // web page, where a self-hosted endpoint on 8443 is ordinary. The
      // restriction belongs to this target, so it is stated here.
      if (u.port) {
        throw new Error(
          `Chain endpoint "${src.base}" carries a port, and a Chrome match pattern has no ` +
            `place for one — an extension built against it would reach nothing. Point the ` +
            `endpoint at 443, or build the web app, where ports are ordinary.`,
        );
      }
      // The same refusal, one axis over, and written next to it because the
      // first version of this guard covered only the port. A port is a harmless
      // pattern that matches nothing; a plain-HTTP grant is the opposite — it
      // loads, it works, and any network between the browser and that host can
      // read every address the wallet looks up and rewrite every answer,
      // including the balance somebody is about to act on. `foo://` lands here
      // too, where `.origin` is the string "null" and the manifest would have
      // been given the pattern `null/*`.
      //
      // `chainSource.ts` allows plain HTTP on loopback on purpose, and that
      // stays true for the web app. What cannot follow it here is the standing
      // grant: a `host_permissions` entry outlives whatever the chain source is
      // later set to.
      if (u.protocol !== "https:") {
        throw new Error(
          `Chain endpoint "${src.base}" is not https, and an extension cannot be granted ` +
            `reach over a plain-HTTP host — the grant would stay in the manifest whatever ` +
            `the chain source is later set to. Serve the endpoint over https, or build the ` +
            `web app, where a loopback endpoint over HTTP is allowed.`,
        );
      }
      origins.add(u.origin);
    }
  }
  return [...origins];
}

/**
 * The manifest this build should ship, and the origins it granted itself.
 *
 * Split out of `closeBundle` so it can be tested. What lives here is every
 * decision — which origins are new, what `host_permissions` becomes, what the
 * CSP becomes — and what stays in `closeBundle` is reading and writing files.
 * The version that kept the decisions inside the plugin hook had no test at all:
 * deleting the `VITE_` filter and the whole CSP-widening block left the suite
 * fully green, and `check:package` stayed OK too, because the receipt and the
 * manifest widen together so both directions still agreed.
 *
 * `granted` is returned rather than recomputed by the caller, so the receipt the
 * gate reads and the permissions Chrome enforces come from one decision. Two
 * computations of the same list is the shape where they drift apart.
 */
export function manifestForBuild(
  manifest: Record<string, unknown>,
  env: Record<string, string | undefined>,
): { manifest: Record<string, unknown>; granted: string[] } {
  // Compared against the parsed list, not against the file's text: an origin
  // that is a prefix of one already declared (`https://chain.example` under
  // `https://chain.example.org/*`) reads as "already there" in a substring test,
  // and the build then quietly fails to grant it.
  const declared = (manifest.host_permissions as string[]) ?? [];
  const already = new Set(declared.map((p) => p.replace(/\/\*$/, "")));
  const granted = extraChainOrigins(env).filter((o) => !already.has(o));
  if (granted.length === 0) return { manifest, granted };

  const m = JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>;
  m.host_permissions = [...declared, ...granted.map((o) => o + "/*")];
  const csp = (m.content_security_policy as { extension_pages?: string } | undefined)
    ?.extension_pages;
  if (typeof csp === "string") {
    // Both lists move together. Widening `host_permissions` alone gets past
    // Chrome's permission check and is then blocked by the page's own CSP —
    // the request fails with no status, which the wallet reports as the
    // endpoint being unreachable. Same wrong sentence as a blocked host, from
    // a different layer.
    // `\s+`, matching how `check-extension-package.mjs` reads the same field.
    // The two used different spellings — one literal space here, `\s+` there —
    // so a CSP written with a tab would have widened `host_permissions` and not
    // the CSP, silently, and been caught only by a cross-check one layer down.
    // Two expressions for one field is the shape that produced every
    // contradiction in this build step so far.
    (m.content_security_policy as { extension_pages: string }).extension_pages = csp.replace(
      /(connect-src\s+[^;]*)/,
      (seg: string) => seg + " " + granted.join(" "),
    );
  }
  return { manifest: m, granted };
}

export default defineConfig(({ mode }) => ({
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
       *
       * ## Why the environment is read through `loadEnv`, not `process.env`
       *
       * Vite inlines `VITE_*` from `.env` files **and** the shell, and it
       * deliberately does not copy `.env` values into `process.env`. A plugin
       * reading `process.env` alone is therefore blind to the documented way of
       * setting these — and blind silently: measured, an `extension/.env`
       * holding `VITE_BLOCKFROST_PROJECT_ID_PREPROD` produced a bundle carrying
       * the key and calling `cardano-preprod.blockfrost.io`, a manifest
       * declaring no such host, and not one line of output saying so.
       *
       * ## Why it writes down what it decided
       *
       * `check:package` has to answer "which hosts does this package call", and
       * inferring that by searching the bundle's text is answering a different
       * question: any string of the right shape counts, including one that
       * arrived in a bundled locale file. So the build states its own decision
       * here, and the gate reads the statement. The receipt is written on every
       * build — an empty list is a real answer, and its absence means the
       * package was not built by this config, which the gate must refuse rather
       * than read as "no extra hosts".
       */
      closeBundle() {
        const out = resolve(repo, "dist-extension");
        if (existsSync(resolve(here, "icon128.png"))) {
          copyFileSync(resolve(here, "icon128.png"), resolve(out, "icon128.png"));
        }
        // `.env` first, shell second — the same precedence Vite gives them.
        const env = { ...loadEnv(mode, here, "VITE_"), ...process.env };
        const raw = readFileSync(resolve(here, "manifest.json"), "utf8");
        const { manifest, granted } = manifestForBuild(JSON.parse(raw), env);

        writeFileSync(resolve(out, ORIGINS_RECEIPT), JSON.stringify(granted) + "\n");
        if (granted.length === 0) {
          copyFileSync(resolve(here, "manifest.json"), resolve(out, "manifest.json"));
          return;
        }
        writeFileSync(resolve(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
        console.log("[phoenix] manifest widened for this build: " + granted.join(", "));
      },
    },
  ],
  resolve: {
    /**
     * The extension is a **host** of this module, and until now it was one that
     * supplied nothing.
     *
     * `docs/host-contract.json` names five aliases a host is expected to point at
     * its own implementations. The web app points all five at real ones. This
     * config declared a single catch-all, so all five resolved back into the
     * module's own stand-ins — and nothing failed, because they resolved
     * *successfully*. A stand-in that logs to the console is a working import.
     *
     * What that cost: panels call toast with a bare i18n key, the stand-in prints
     * the key, and somebody who had just delegated their stake read the literal
     * word `delegate_submitted` — a message indistinguishable from a crash, right
     * after an action that moves money.
     *
     * Order matters and is the whole mechanism: Vite tries these in sequence, so
     * every specific entry must precede the catch-all. Putting `"@"` first would
     * swallow all of them and restore the bug in a way no test would notice.
     */
    alias: [
      { find: "@/lib/toast", replacement: resolve(here, "src/toast.ts") },
      { find: "@", replacement: resolve(repo, "src") },
    ],
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
}));
