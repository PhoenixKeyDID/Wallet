/**
 * Check the package a user actually installs.
 *
 * Everything else in CI checks source. This checks `dist-extension/` — the
 * directory that gets dragged onto `chrome://extensions`. The gap matters:
 * a broken popup entry or an unparseable manifest leaves every source-level
 * gate green and the extension unloadable, because nothing else in the
 * pipeline ever runs the shipping build.
 *
 * Three properties, in order of what they protect:
 *
 * 1. **`host_permissions` cannot outgrow the source.** That list is the whole
 *    answer to "who can this wallet talk to". Adding a host there is a one-line
 *    diff in a JSON file, and it is not code, so it reads as harmless. Every
 *    host declared must appear in `src/lib/cardano/provider.ts`, which
 *    CODEOWNERS gates — so widening the manifest requires a review either way.
 * 2. **No remote code.** The CSP must keep `script-src 'self'`, and `popup.html`
 *    must reference only same-directory files. An extension that can fetch a
 *    script is an extension whose published source proves nothing.
 * 3. **It loads at all.** Manifest parses, every file it names exists.
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(REPO, "dist-extension");
const problems = [];
const fail = (msg) => problems.push(msg);

if (!existsSync(DIST)) {
  console.error(`No dist-extension/ — run \`bun run build:extension\` first.`);
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(join(DIST, "manifest.json"), "utf8"));
} catch (err) {
  console.error(`dist-extension/manifest.json does not parse: ${err.message}`);
  process.exit(1);
}

// 3 — it loads at all.
if (manifest.manifest_version !== 3) fail(`manifest_version is ${manifest.manifest_version}, expected 3`);
const popup = manifest.action?.default_popup;
if (!popup) fail("manifest declares no action.default_popup");
for (const rel of [popup, ...Object.values(manifest.icons ?? {})].filter(Boolean)) {
  if (!existsSync(join(DIST, rel))) fail(`manifest names "${rel}", which is not in the package`);
}

// 2 — no remote code.
const csp = manifest.content_security_policy?.extension_pages ?? "";
if (!/(^|;)\s*script-src\s+'self'\s*(;|$)/.test(csp)) {
  fail(`extension_pages CSP must be exactly \`script-src 'self'\`, got: ${csp || "(none)"}`);
}
if (popup && existsSync(join(DIST, popup))) {
  const html = readFileSync(join(DIST, popup), "utf8");
  for (const [, url] of html.matchAll(/(?:src|href)\s*=\s*"([^"]+)"/g)) {
    if (/^(https?:)?\/\//i.test(url) || url.startsWith("/")) {
      fail(`${popup} references "${url}" — must be a relative path inside the package`);
    }
  }
}

// 1 — host_permissions cannot outgrow the source.
const provider = readFileSync(join(REPO, "src", "lib", "cardano", "provider.ts"), "utf8");
for (const pattern of manifest.host_permissions ?? []) {
  const host = pattern.replace(/^\*?:?\/\//, "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!provider.includes(host)) {
    fail(
      `host_permissions declares "${pattern}", but "${host}" appears nowhere in ` +
        `src/lib/cardano/provider.ts — the manifest is claiming reach the code does not use`,
    );
  }
}

if (problems.length) {
  console.error("Extension package FAILED:");
  for (const p of problems) console.error("  • " + p);
  process.exit(1);
}

console.log(
  `Extension package OK — manifest v3 loads, CSP allows no remote code, ` +
    `${(manifest.host_permissions ?? []).length} host permissions all backed by provider.ts`,
);
