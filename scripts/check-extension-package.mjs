/**
 * Check the package a user actually installs.
 *
 * Everything else in CI checks source. This checks `dist-extension/` — the
 * directory that gets dragged onto `chrome://extensions`. The gap matters:
 * a broken popup entry or an unparseable manifest leaves every source-level
 * gate green and the extension unloadable, because nothing else in the
 * pipeline ever runs the shipping build.
 *
 * Four properties, in order of what they protect:
 *
 * 1. **The manifest cannot grow a new surface.** Every top-level key and every
 *    entry in `permissions` is matched against an explicit allow-list, so the
 *    gate fails on anything it was not taught about — `content_scripts`,
 *    `background`, `web_accessible_resources`, `externally_connectable`,
 *    `scripting`, `tabs`. Those are exactly the keys that turn a popup into
 *    code running on every page you visit, and each is a one-line JSON diff
 *    that reads as harmless. Deny-by-default is the only spelling that holds:
 *    a gate listing what is *forbidden* is out of date the day the platform
 *    ships a new key. Adding CIP-30 injection means editing this list on
 *    purpose, in a diff a reviewer sees.
 * 2. **`host_permissions` cannot outgrow the source.** That list is the whole
 *    answer to "who can this wallet talk to". Each pattern must be
 *    `https://<literal host>` followed by a path wildcard — no wildcard scheme,
 *    no `<all_urls>`, no wildcard
 *    inside the host — and the host must appear as a URL literal in
 *    `src/lib/cardano/provider.ts`, which CODEOWNERS gates. An earlier version
 *    compared the pattern after stripping it down to bare text, so a pattern
 *    meaning "every https host" reduced to a single star, and `provider.ts`
 *    contains a star on every comment line: the gate printed OK for an
 *    extension holding permission over every https site. Measured, not feared.
 * 3. **No remote code.** The CSP must keep `script-src 'self'`, and `popup.html`
 *    must reference only same-directory files. An extension that can fetch a
 *    script is an extension whose published source proves nothing.
 * 4. **It loads at all.** Manifest parses, every file it names exists.
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

// 4 — it loads at all.
if (manifest.manifest_version !== 3) fail(`manifest_version is ${manifest.manifest_version}, expected 3`);
const popup = manifest.action?.default_popup;
if (!popup) fail("manifest declares no action.default_popup");
for (const rel of [popup, ...Object.values(manifest.icons ?? {})].filter(Boolean)) {
  if (!existsSync(join(DIST, rel))) fail(`manifest names "${rel}", which is not in the package`);
}

// 3 — no remote code.
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

// 1 — the manifest cannot grow a new surface.
// Deny-by-default: a key absent from this list is a key nobody reviewed.
const ALLOWED_KEYS = new Set([
  "manifest_version", "name", "version", "description",
  "action", "permissions", "host_permissions",
  "content_security_policy", "icons",
]);
for (const key of Object.keys(manifest)) {
  if (!ALLOWED_KEYS.has(key)) {
    fail(
      `manifest declares "${key}", which this gate has never been taught to allow — ` +
        `if that key is wanted, add it to ALLOWED_KEYS in this file so the widening ` +
        `shows up in a reviewed diff`,
    );
  }
}

const ALLOWED_PERMISSIONS = new Set(["storage"]);
for (const perm of manifest.permissions ?? []) {
  if (!ALLOWED_PERMISSIONS.has(perm)) {
    fail(`permissions declares "${perm}", which is not in the reviewed set (${[...ALLOWED_PERMISSIONS].join(", ")})`);
  }
}

// 2 — host_permissions cannot outgrow the source.
// Only `https://<literal host>/*`. A wildcard anywhere in the scheme or the host
// is rejected before it is compared with anything: `https://*/*` is reach over
// the whole web, and no substring test against source can be allowed to bless it.
const provider = readFileSync(join(REPO, "src", "lib", "cardano", "provider.ts"), "utf8");
const providerHosts = new Set(
  [...provider.matchAll(/https:\/\/([a-z0-9.-]+)/gi)].map(([, host]) => host.toLowerCase()),
);
for (const pattern of manifest.host_permissions ?? []) {
  const m = /^https:\/\/([a-z0-9.-]+)\/\*$/i.exec(pattern);
  if (!m) {
    fail(
      `host_permissions declares "${pattern}" — only \`https://<host>/*\` with a literal ` +
        `host is allowed; a wildcard scheme or host grants reach over sites nobody reviewed`,
    );
    continue;
  }
  const host = m[1].toLowerCase();
  if (!providerHosts.has(host)) {
    fail(
      `host_permissions declares "${pattern}", but no \`https://${host}\` URL appears in ` +
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
  `Extension package OK — manifest v3 loads, no manifest key or permission outside ` +
    `the reviewed set, CSP allows no remote code, and all ` +
    `${(manifest.host_permissions ?? []).length} host permissions are literal hosts backed by provider.ts`,
);
