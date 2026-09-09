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
 *    `src/lib/cardano/provider.ts` or `src/lib/cardano/chainEnv.ts`, both of
 *    which CODEOWNERS gates. An earlier version
 *    compared the pattern after stripping it down to bare text, so a pattern
 *    meaning "every https host" reduced to a single star, and `provider.ts`
 *    contains a star on every comment line: the gate printed OK for an
 *    extension holding permission over every https site. Measured, not feared.
 * 3. **No remote code.** The CSP must keep `script-src 'self'`, and `popup.html`
 *    must reference only same-directory files. An extension that can fetch a
 *    script is an extension whose published source proves nothing.
 * 4. **It loads at all.** Manifest parses, every file it names exists.
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
/**
 * The package directory to grade.
 *
 * Overridable only so this gate can be graded itself. Nothing checked the gate
 * before, and two mutations that switched off real rules in it left the whole
 * suite green — a file deciding which hosts a wallet may talk to was the only
 * thing checking itself. `scripts/__tests__/checkExtensionPackage.test.ts`
 * stages each attack in a temp directory and points this at it.
 *
 * Not a way around the gate: CI invokes it with no environment, and anyone who
 * could set this variable in CI could edit this file instead.
 */
const DIST = process.env.PHOENIX_DIST || join(REPO, "dist-extension");
const problems = [];
const fail = (msg) => problems.push(msg);

if (!existsSync(DIST)) {
  console.error(`No dist-extension/ — run \`bun run build:extension\` first.`);
  process.exit(1);
}

/**
 * Refuse to grade a build older than the code it was built from.
 *
 * `dist-extension/` is gitignored, so what sits there is whatever the last
 * build left — possibly from a different branch, possibly from before the very
 * change being checked. This gate is the one that decides whether the shipped
 * extension may talk to a host, and a gate reporting OK about a stale artifact
 * is the worst of the three states a measurement can be in: it does not say
 * "mismatch" and it does not say "I could not measure", it says "fine".
 *
 * CI builds immediately before running this, so the check is invisible there.
 * It fires for the person running the gate by hand, which is exactly when the
 * artifact is likely to be old.
 */
const newestUnder = (dir) => {
  let newest = 0;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    newest = Math.max(newest, st.isDirectory() ? newestUnder(full) : st.mtimeMs);
  }
  return newest;
};

const builtAt = statSync(join(DIST, "manifest.json")).mtimeMs;
const sourceAt = Math.max(newestUnder(join(REPO, "extension")), newestUnder(join(REPO, "src")));
if (sourceAt > builtAt) {
  console.error(
    "dist-extension/ is older than the source it was built from — this check would\n" +
      "be grading a stale artifact. Run `bun run build:extension` first.",
  );
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

/*
 * `connect-src` must name the same hosts as `host_permissions`, and no others.
 *
 * Everything else in this file gates the *source*: a host has to be written down
 * in `provider.ts`, and the outbound-URL check requires it to be a literal there.
 * That is a text gate, and text gates lose to anyone willing to assemble a host
 * at runtime — the outbound-URL check now blocks several ways of doing that, and
 * cannot block all of them (base64, a reversed string, a value read from the
 * build environment). None of those survive a browser refusing the connection.
 *
 * So the two lists say the same thing in two enforcement layers, and the
 * agreement is checked rather than trusted: a duplicated list nobody compares is
 * a list that drifts, and it would drift in the direction of the CSP being the
 * stale one — the permissive failure.
 */
const cspConnect = /(^|;)\s*connect-src\s+([^;]+)/.exec(csp);
if (!cspConnect) {
  fail("extension_pages CSP has no `connect-src` — the browser would allow any host");
} else {
  const declared = new Set(
    cspConnect[2].trim().split(/\s+/).filter((s) => s !== "'self'"),
  );
  const permitted = new Set(
    (manifest.host_permissions ?? []).map((p) => p.replace(/\/\*$/, "")),
  );
  for (const host of declared) {
    if (!permitted.has(host)) {
      fail(`CSP connect-src allows ${host}, which is not in host_permissions`);
    }
  }
  for (const host of permitted) {
    if (!declared.has(host)) {
      fail(`host_permissions declares ${host}, which CSP connect-src does not allow`);
    }
  }
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
/**
 * The three keys after `icons` were added to inject a CIP-30 provider into web
 * pages, and each one widens what this extension can reach. Written down here
 * rather than waved through, because this is the diff a reviewer sees:
 *
 * - `content_scripts` — runs our code in every page matching the patterns. It
 *   is the largest single increase in reach this extension has ever taken. The
 *   script it runs (`content.js`) is a relay: it decides nothing, holds no key,
 *   and adds nothing to a message. Its `matches` are `https://*` plus loopback,
 *   and `all_frames` is false, so a sub-frame gets no wallet at all.
 * - `web_accessible_resources` — lets a page load `inpage.js`. That file has to
 *   run in the page's own world to be reachable as `window.cardano.phoenix`,
 *   and shipping it as a file is what keeps the CSP at `script-src 'self'`;
 *   injecting the same code as a string would need `'unsafe-inline'`.
 * - `background` — the service worker, which is where the origin is read from
 *   the browser and every permission decision is made. It holds no keys.
 *
 * What deliberately did NOT change: `permissions` gains nothing (no `tabs`, no
 * `activeTab`, no `<all_urls>` host permission), and the CSP is untouched.
 */
const ALLOWED_KEYS = new Set([
  "manifest_version", "name", "version", "description",
  "action", "permissions", "host_permissions",
  "content_security_policy", "icons",
  "content_scripts", "web_accessible_resources", "background",
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

/**
 * 1b — the page-facing keys, checked and not merely permitted.
 *
 * Allowing `content_scripts` without reading it would be a gate that prints OK
 * for `matches: ["<all_urls>"]` — the exact shape it exists to stop, and the
 * exact failure this repo has already paid for once: four gates that printed OK
 * for the thing they were built to block.
 *
 * So the injection patterns are an allow-list of their own. The https wildcard
 * pattern means every https site, which is what a wallet provider genuinely
 * needs — a dApp can be anywhere — but loopback is named host by host and
 * nothing else is allowed in at all: no plaintext wildcard, no `file:`, and no
 * `<all_urls>`, which would add `file:` and `ftp:` reach on top.
 */
const ALLOWED_MATCHES = new Set(["https://*/*", "http://localhost/*", "http://127.0.0.1/*"]);

const contentScripts = manifest.content_scripts ?? [];
for (const cs of contentScripts) {
  for (const m of cs.matches ?? []) {
    if (!ALLOWED_MATCHES.has(m)) {
      fail(
        `content_scripts injects into "${m}", which is not in the reviewed set ` +
          `(${[...ALLOWED_MATCHES].join(", ")}) — widening where this wallet runs ` +
          `must show up in a reviewed diff`,
      );
    }
  }
  // A sub-frame's origin is honest but is not what the user reads in the
  // address bar, so a frame gets no provider at all. `all_frames` defaulting
  // to false is not enough: it must be false on purpose, or a later edit that
  // sets it true reads as a one-word change.
  if (cs.all_frames !== false) {
    fail(`content_scripts must set "all_frames": false explicitly, got ${JSON.stringify(cs.all_frames)}`);
  }
  if (cs.run_at !== "document_start") {
    fail(`content_scripts must run at document_start so the provider exists before page scripts look for it`);
  }
  for (const f of cs.js ?? []) {
    if (!existsSync(join(DIST, f))) fail(`content_scripts names "${f}", which is not in the package`);
  }
}

for (const war of manifest.web_accessible_resources ?? []) {
  for (const m of war.matches ?? []) {
    if (!ALLOWED_MATCHES.has(m)) {
      fail(`web_accessible_resources is exposed to "${m}", which is not in the reviewed set`);
    }
  }
  for (const r of war.resources ?? []) {
    if (!existsSync(join(DIST, r))) fail(`web_accessible_resources names "${r}", which is not in the package`);
    // Anything reachable from a page is reachable by every page. Exposing a
    // wallet page here would put the unlock screen inside a site's frame.
    if (r !== "inpage.js") {
      fail(`web_accessible_resources exposes "${r}"; only the page-world provider may be web-reachable`);
    }
  }
}

const sw = manifest.background?.service_worker;
if (manifest.background && !sw) fail("background declares no service_worker");
if (sw && !existsSync(join(DIST, sw))) fail(`background names "${sw}", which is not in the package`);

/**
 * 5 — nothing that runs inside a website carries a key.
 *
 * README and the spec (§2.1a, §5.8) both say the keystore is unreachable from
 * anything a web page loads, and `check:keystore-boundary` is what makes that
 * true — but it reads *source imports*. A bundler answers a different question:
 * a transitive re-export, or one shared chunk too many, can put the keystore in
 * a page-world file without any source line saying so. The claim is about the
 * shipped bytes, so it is checked on the shipped bytes.
 *
 * The check is the module graph, not a word search. `content.js` and
 * `inpage.js` run in a website's process, and each may import exactly one
 * chunk: `protocol.js`, which is pure rules and holds nothing. A keystore that
 * arrived any way at all — inlined, re-exported, or dragged in as a shared
 * chunk — has to show up as an import outside that set.
 *
 * Measured, because the obvious spelling of this check does not work: importing
 * the keystore into `content/bridge.ts` and rebuilding left `content.js` at
 * 1,426 bytes, because the bundler put the keystore in a *separate* chunk and
 * imported it. A size ceiling alone would have printed OK. The import graph is
 * the check; the ceiling below is only a backstop for the day a bundler inlines
 * instead of splitting.
 */
const PAGE_WORLD = ["content.js", "inpage.js"];
const PAGE_WORLD_MAY_IMPORT = new Set(["./protocol.js"]);
const PAGE_WORLD_MAX_BYTES = 32 * 1024;
for (const f of PAGE_WORLD) {
  const path = join(DIST, f);
  if (!existsSync(path)) {
    fail(`${f} is not in the package, so the wallet injects nothing`);
    continue;
  }
  const src = readFileSync(path, "utf8");
  for (const [, spec] of src.matchAll(/(?:^|\s)import\s[^;]*?from\s*"([^"]+)"/g)) {
    if (!PAGE_WORLD_MAY_IMPORT.has(spec)) {
      fail(
        `${f} runs inside every website and imports "${spec}" — page-world code may ` +
          `import only ${[...PAGE_WORLD_MAY_IMPORT].join(", ")}, or the keystore can reach a page`,
      );
    }
  }
  // A relay is small. Anything approaching the keystore's size got there somehow.
  if (src.length > PAGE_WORLD_MAX_BYTES) {
    fail(
      `${f} is ${src.length} bytes, past the ${PAGE_WORLD_MAX_BYTES} allowed for page-world code — ` +
        `a relay that big has been given something to hold`,
    );
  }
}

// 2 — host_permissions cannot outgrow the source.
// Only `https://<literal host>/*`. A wildcard anywhere in the scheme or the host
// is rejected before it is compared with anything: `https://*/*` is reach over
// the whole web, and no substring test against source can be allowed to bless it.
// Two files may name a host the wallet reaches, and both are CODEOWNERS-gated:
// `provider.ts` holds the default indexer, `chainEnv.ts` the endpoints a build
// can be pointed at. Reading only the first would reject a manifest that is
// correct, which is the failure that gets a check deleted rather than fixed.
// `PHOENIX_BACKING_SOURCES` exists so this rule can be tested at all. The files
// below are real repo sources, so a test cannot stage a comment in one of them
// without editing the repo — and the version of this test that did not have the
// seam asserted something weaker than its own name: it staged a host no source
// mentions *anywhere*, so it stayed green while the string-literal scan was
// turned into a whole-file scan. A rule nothing can stage is a rule nothing checks.
const BACKING_SOURCES = process.env.PHOENIX_BACKING_SOURCES
  ? process.env.PHOENIX_BACKING_SOURCES.split(",").filter(Boolean)
  : [
      join(REPO, "src", "lib", "cardano", "provider.ts"),
      join(REPO, "src", "lib", "cardano", "chainEnv.ts"),
    ];
/**
 * A host counts as backed when it appears inside a string literal.
 *
 * The question this answers is "can the code hand this host to `fetch`", and
 * only a string can be. Matching the file's whole text answers a different
 * question — it blesses any host somebody names in a sentence. Demonstrated:
 * one line reading `// See also the mirror at https://evil.example/api/v0`
 * plus `https://evil.example/*` in the manifest, and this check printed OK for
 * eight hosts. `chainEnv.ts` has the highest comment-to-code ratio in its
 * directory, so that is exactly where a whole-text search is least safe.
 *
 * Matching inside quotes rather than stripping comments first, because
 * stripping answers by elimination and gets it wrong on code that compiles:
 * a `"…/*"` inside a string opens a phantom comment block that runs to the
 * next `*` + `/` and swallows the constants below it. Measured on a fixture,
 * three real hosts became one — a false accusation, which is the failure mode
 * that gets a check deleted rather than fixed.
 */
const hostsInStringLiterals = (text) =>
  [...text.matchAll(/(["'`])https:\/\/([a-z0-9.-]+)[^"'`]*\1/gi)].map(([, , host]) => host.toLowerCase());
const providerHosts = new Set(
  BACKING_SOURCES.flatMap((f) => hostsInStringLiterals(readFileSync(f, "utf8"))),
);
/**
 * Hosts this build was compiled to read the chain from — from the build itself.
 *
 * The build writes down what it decided (`extension/vite.config.ts`, the
 * `.chain-origins.json` receipt) and this reads the statement. Searching the
 * bundle's text for a URL was the obvious alternative and it answers a
 * different question: any string of the right shape counts, wherever it came
 * from. Measured — a key added to `locales/en/wallet.json` is bundled verbatim
 * by `extension/src/i18n.ts`, reaches the output, and blessed a host that no
 * code calls, with `check:urls` silent because `locales/` is not scanned for
 * URLs. It also missed the case that matters most: a build given only
 * `VITE_BLOCKFROST_PROJECT_ID_*` reads the vendor host out of `chainEnv.ts`,
 * so no URL is inlined at all and there is nothing for a text search to find,
 * while the package really does call that host.
 *
 * A missing receipt is refused rather than read as "no extra hosts". It means
 * this directory was not produced by the build config, and a gate that cannot
 * measure has to say so instead of returning the reassuring answer.
 */
const RECEIPT = ".chain-origins.json";
const bundleHosts = new Set();
if (!existsSync(join(DIST, RECEIPT))) {
  fail(
    `dist-extension/${RECEIPT} is missing, so which chain hosts this package calls cannot be ` +
      `determined — rebuild with \`bun run build:extension\` rather than packing the directory by hand`,
  );
} else {
  let origins;
  try {
    origins = JSON.parse(readFileSync(join(DIST, RECEIPT), "utf8"));
  } catch (err) {
    fail(`dist-extension/${RECEIPT} does not parse: ${err.message}`);
    origins = [];
  }
  if (!Array.isArray(origins)) {
    fail(`dist-extension/${RECEIPT} must hold an array of origins`);
    origins = [];
  }
  for (const origin of origins) {
    try {
      bundleHosts.add(new URL(origin).host.toLowerCase());
    } catch {
      fail(`dist-extension/${RECEIPT} lists "${origin}", which is not a URL`);
    }
  }
}

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
  // Two ways a host earns its entry, and a private build needs the second:
  // named in the reviewed source, or compiled into this bundle by a build-time
  // endpoint variable. The second is not a loophole — that string is in the
  // package a reviewer reads, and it got there because whoever ran the build
  // set the variable on purpose.
  if (!providerHosts.has(host) && !bundleHosts.has(host)) {
    fail(
      `host_permissions declares "${pattern}", but no URL for host ${host} appears in ` +
        `src/lib/cardano/provider.ts or src/lib/cardano/chainEnv.ts, and this build was ` +
        `not compiled to read the chain from it — the manifest is claiming reach the ` +
        `code does not use`,
    );
  }
}

/**
 * 2b — and the manifest cannot fall behind the bundle either.
 *
 * The loop above asks one direction: does the manifest claim reach the code
 * does not use. That is the direction that matters to a store reviewer, and it
 * is not the direction that breaks a user. The endpoint is now a build-time
 * choice while the manifest is a static file, so the pair can drift the other
 * way: build with `VITE_CHAIN_BASE_PREPROD=https://my-node.example/api/v0`,
 * forget the manifest, and Chrome blocks every chain read. What the wallet then
 * reports is `ProviderUnreachableError` — "the request did not arrive, or a
 * reply did and the browser discarded it" — which sends the operator to inspect
 * a node that is answering perfectly.
 *
 * `bundleHosts` is gathered above, where the other direction also needs it.
 */
const declaredHosts = new Set(
  (manifest.host_permissions ?? [])
    .map((p) => /^https:\/\/([a-z0-9.-]+)\/\*$/i.exec(p)?.[1]?.toLowerCase())
    .filter(Boolean),
);
for (const host of bundleHosts) {
  if (!declaredHosts.has(host)) {
    fail(
      `this build reads the chain from ${host}, which host_permissions does not declare — ` +
        `Chrome blocks every chain read and the wallet reports "no readable reply", which ` +
        `reads as the endpoint being down`,
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
    `the reviewed set, CSP allows no remote code, page-world code imports nothing but ` +
    `the rules, and all ` +
    `${(manifest.host_permissions ?? []).length} host permissions are literal hosts backed by ` +
    `provider.ts or chainEnv.ts`,
);
