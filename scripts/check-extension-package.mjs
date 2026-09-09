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
 * 2. **`host_permissions` and the build must say the same thing, both ways.**
 *    That list is the whole answer to "who can this wallet talk to". Each
 *    pattern must be `https://<literal host>` followed by a path wildcard — no
 *    wildcard scheme, no `<all_urls>`, no wildcard inside the host — and the
 *    host must hold one of exactly two blessings: it appears as a URL literal
 *    in `src/lib/cardano/provider.ts` or `src/lib/cardano/chainEnv.ts`, both of
 *    which CODEOWNERS gates, **or** this build declared it in
 *    `.chain-origins.json`. The second blessing is weaker on purpose and the
 *    closing line says so by name: nobody reviewed it, the build variable
 *    decided it. The reverse direction is checked too — a host the build reads
 *    and the manifest omits is refused, because Chrome silently blocks it and
 *    the wallet then reports the endpoint as unreachable. An earlier version
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

/**
 * A manifest field that must be a list, read as one.
 *
 * `manifest.host_permissions ?? []` covers the field being absent and nothing
 * else. A manifest holding `"host_permissions": "https://x.example/*"` — a
 * plausible hand-edit, and one Chrome itself rejects — reaches `.map` and this
 * gate dies with a `TypeError` naming a line of its own source. The person
 * reading that has been told the checker is broken, when what is broken is the
 * file being checked, and the exit code is the same either way.
 *
 * So a wrong type is a finding like any other, in the same voice as the rest,
 * and the run continues to report whatever else is wrong with the package.
 *
 * **Every list read goes through here, nested ones included.** The first version
 * wrapped only the top-level fields, which left the same crash live four lines
 * further down — `content_scripts[].matches`, `[].js`, and both lists inside
 * `web_accessible_resources`. Two of those took the whole gate out with a
 * `TypeError`; the other two were worse, because a string is iterable: `"js":
 * "content.js"` walked it a character at a time and the gate reported that the
 * manifest names files called `c`, `o`, `n` — a page of confident nonsense, with
 * every real rule about `js` silently skipped. A fix scoped to where the symptom
 * was first noticed is a fix that leaves the cause in place.
 *
 * That sentence then had to be applied to itself. Guarding the containers still
 * left six manifests killing this gate one level down, on the *elements* — so
 * nothing calls `asArray` directly any more. It is the shared first step of
 * `stringsIn` and `objectsIn` below, and those are what the rules use.
 */
const asArray = (value, field) => {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  fail(
    `manifest ${field} is ${typeof value}, not a list — Chrome refuses to load a ` +
      `manifest shaped this way, and every rule below about ${field} was skipped.`,
  );
  return [];
};

/** How a value should be named in a message about its type. */
const typeName = (v) => (v === null ? "null" : Array.isArray(v) ? "a list" : typeof v);

/**
 * A list whose entries must each be a string, read as one.
 *
 * `asArray` gates the **container**; this gates what is inside it, and the
 * distinction is not academic. These lists feed either a set comparison or
 * `join(DIST, …)`, and `join` throws on a non-string with `ERR_INVALID_ARG_TYPE`
 * — the same crash as the container case, one level down, still naming a line of
 * this file's own source. Measured after the containers were guarded:
 * `"host_permissions": [123]` and `"js": [7]` both still killed the gate.
 *
 * The stricter reader was already in this file — the `.chain-origins.json` check
 * gates the array *and* every element in it — so this is the gate matching a
 * standard it had already set for itself, in a reader that carries less weight
 * than this one.
 */
const stringsIn = (value, field) => {
  const out = [];
  for (const entry of asArray(value, field)) {
    if (typeof entry === "string") {
      out.push(entry);
      continue;
    }
    fail(
      `manifest ${field} contains ${typeName(entry)}, not a string — Chrome refuses ` +
        `to load a manifest shaped this way, and that entry was not checked.`,
    );
  }
  return out;
};

/**
 * One value that has to be an object before fields can be read off it.
 *
 * The reason this exists: optional chaining reads a scalar exactly as quietly
 * as it reads a missing key, so `manifest.background?.service_worker` came out
 * `undefined` for `"background": 5`, and the gate reported a missing field on a
 * manifest whose problem was one level up.
 *
 * **Three return values, because there are three states**, and collapsing two of
 * them is what produced the last two defects in this file:
 *
 *   • `undefined` — absent. The caller decides whether that is allowed.
 *   • `null`      — present and the wrong type. Already reported; the caller
 *                   must stay silent, or the one cause gets a second sentence
 *                   that contradicts the first.
 *   • the object  — read on.
 *
 * A two-value version of this reads as simpler and is the thing that goes
 * wrong: `!container` cannot tell "you did not write this" from "what you wrote
 * is not an object", and those need opposite handling.
 */
const objectAt = (value, field) => {
  if (value === undefined) return undefined;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return value;
  fail(`manifest ${field} is ${typeName(value)}, not an object`);
  return null;
};

/** One value that has to be a string before it can be joined onto a path. */
const stringAt = (value, field) => {
  if (typeof value === "string") return value;
  fail(`manifest ${field} is ${typeName(value)}, not a string`);
  return null;
};

/**
 * Entries of a list that must each be an object, read as such.
 *
 * `"content_scripts": [null]` passes every check about the list — it is a list —
 * and then the rules read `.matches` off it and the gate dies. Null rather than
 * some exotic value because it is the shape a hand-edit leaves behind: an entry
 * deleted, the comma still in place.
 */
const objectsIn = (value, field) => {
  const out = [];
  for (const entry of asArray(value, field)) {
    if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
      out.push(entry);
      continue;
    }
    fail(
      `manifest ${field} contains ${typeName(entry)}, not an object — Chrome refuses ` +
        `to load a manifest shaped this way, and every rule about that entry was skipped.`,
    );
  }
  return out;
};

/**
 * `manifest.icons` read as the name→path map it is.
 *
 * Same failure, one type over: `"icons": "icon.png"` is not a list but it *is*
 * iterable, so `Object.values` on a string hands back single characters and the
 * gate goes looking for files named `i`, `c`, `o`. Not a list — a map — so it
 * gets its own door rather than being bent through `asArray`.
 *
 * The values are checked as well, for the reason `stringsIn` exists: `{"16": 16}`
 * reached `join(DIST, 16)` and crashed. Reported by icon name, so the reader is
 * told which icon rather than which line of this gate.
 */
const iconPaths = (value) => {
  if (value === undefined || value === null) return [];
  if (typeof value === "object" && !Array.isArray(value)) {
    const out = [];
    for (const [name, path] of Object.entries(value)) {
      if (typeof path === "string") out.push(path);
      else fail(`manifest icons["${name}"] is ${typeName(path)}, not a path`);
    }
    return out;
  }
  fail(
    `manifest icons is ${typeName(value)}, not a name-to-path map — Chrome refuses ` +
      `to load a manifest shaped this way, and no icon was checked against the package.`,
  );
  return [];
};

// A seam that is on says so, before any verdict.
//
// The risk here is not somebody reaching for the variable on purpose — that
// person could edit this file. It is a variable left over in a shell, after
// which this prints a confident OK about a different directory, or about source
// files that are not the ones CODEOWNERS gates. That is the third state: not
// "matches", not "differs", but "measured something else" — and it has to be
// louder than a mismatch, because a mismatch at least says something is wrong.
for (const [name, value, normally] of [
  ["PHOENIX_DIST", process.env.PHOENIX_DIST, "dist-extension/"],
  ["PHOENIX_BACKING_SOURCES", process.env.PHOENIX_BACKING_SOURCES, "provider.ts + chainEnv.ts"],
]) {
  if (!value) continue;
  console.error(
    `⚠ ${name} is set: grading "${value}" instead of ${normally}. ` +
      `Every line below is about that, not about what a release would ship.`,
  );
}

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
 *
 * `NOT_SOURCE` is what it must not count. `extension/smoke/out` is written by
 * `extension/smoke/run.mjs`, so running the smoke test makes `extension/` newer
 * than any package built before it, and this check then refuses a build that is
 * not stale. That refusal is worse than useless: a red gate with no defect
 * behind it, on the ordinary path of running the checks in order, and a gate
 * that cries wolf is a gate people learn to re-run until it passes. Matched by
 * path rather than by the name `out`, so a source directory that happens to be
 * called that is still read.
 *
 * It is a hand-kept list of one, and the fact it needs keeping is the point of
 * this paragraph. The same directory is already named in `.gitignore`, and the
 * two are not wired together — a second build output added under `extension/`,
 * `src/` or `locales/` gets gitignored by whoever adds it and nothing brings
 * them back here, so the false alarm returns and nobody is told why. Reading
 * `.gitignore` directly would join them, and is not done because that file
 * carries patterns rather than paths, and a wrong reading of it would make this
 * check skip a real source tree — failing quiet where it currently fails loud.
 * So: a list, with the coupling written down instead of hidden.
 */
const NOT_SOURCE = new Set([join(REPO, "extension", "smoke", "out")]);

const newestUnder = (dir) => {
  let newest = 0;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const full = join(dir, entry);
    if (NOT_SOURCE.has(full)) continue;
    const st = statSync(full);
    newest = Math.max(newest, st.isDirectory() ? newestUnder(full) : st.mtimeMs);
  }
  return newest;
};

// A directory that was not produced by a build is refused with a sentence
// rather than a stack trace. It happens on an ordinary path: the build throws
// after Vite has already emptied the output and written the bundle — a chain
// endpoint carrying a port or a plain-HTTP scheme does exactly that — leaving a
// directory with code in it and no manifest. Reading `mtimeMs` off a file that
// is not there answers with `ENOENT` and an absolute path out of the build
// machine, about a situation the receipt check below already has words for.
if (!existsSync(join(DIST, "manifest.json"))) {
  console.error(
    `dist-extension/ has no manifest.json, so it was not produced by a completed build —\n` +
      "a build that failed part-way leaves the bundle behind without one. Run\n" +
      "`bun run build:extension` and fix whatever it reports.",
  );
  process.exit(1);
}

const builtAt = statSync(join(DIST, "manifest.json")).mtimeMs;
// `locales/` is here because it is compiled in — `extension/src/i18n.ts` imports
// the JSON, so a locale edit changes the bundle exactly as a source edit does.
// Leaving it out meant a package built before a translation change was graded as
// current. No rule in this gate reads a locale today, so nothing was measured
// wrong; the directory is listed because the reason to list it is "it reaches
// the bundle", and that is already true.
const sourceAt = Math.max(
  newestUnder(join(REPO, "extension")),
  newestUnder(join(REPO, "src")),
  newestUnder(join(REPO, "locales")),
);
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

/**
 * The root has to be an object before any field can be read off it.
 *
 * `JSON.parse` succeeds on `null`, on `[]`, on `5` — all valid JSON, none of
 * them a manifest — and the first field read then dies with `Cannot read
 * properties of null`, naming a line of this file. `null` in particular is what
 * a build step leaves behind when it writes a manifest from a variable nothing
 * assigned, which is the case worth surviving.
 *
 * An exit rather than a finding, unlike every other type check here: there is
 * no package left to report anything else about, so continuing would print a
 * list of complaints that are all the same complaint.
 */
if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
  console.error(
    `dist-extension/manifest.json parses, but its root is ${typeName(manifest)} rather than an object — ` +
      "Chrome refuses to load it, and no rule below has anything to read.",
  );
  process.exit(1);
}

/**
 * Read once, complain once.
 *
 * Five rules below need this list and each used to re-read it, so a manifest
 * with one bad entry printed the same type finding repeatedly — which is not
 * merely untidy: the report is what a reader scans for the *other* findings,
 * and a screen of one repeated line is how the rest stop being read.
 *
 * Measured before the fix, the report held **four** copies, not five. The fifth
 * read (`declaredHostList`, further down) sits after an `if (problems.length)
 * … process.exit(1)`, so in the one situation this paragraph describes it never
 * runs. Counting call sites instead of running the case gives five; the number
 * that belongs in a file arguing "measured, not feared" is the measured one.
 */
const hostPermissions = stringsIn(manifest.host_permissions, "host_permissions");
/**
 * Whether that list can be compared against anything.
 *
 * `stringsIn` returns `[]` for a wrong-typed field, having already said so — and
 * an empty list is a *valid* answer that other rules then reason from. The
 * cross-check against `connect-src` did exactly that: `"host_permissions": 5`
 * produced its own finding plus **four more** saying each CSP host "is not in
 * host_permissions", which is true of an empty list and useless to the reader.
 * Five sentences, one cause, and the four loudest ones point away from it.
 *
 * Worse, the type finding claims "every rule below about host_permissions was
 * skipped" — and that sentence was false while those four printed underneath it.
 *
 * The predicate has to match `asArray`'s own notion of readable, not a tighter
 * one. Written as "undefined or an array" it excluded `null` — which `asArray`
 * accepts as an empty list without complaint — so `"host_permissions": null`
 * produced no finding at all and the gate exited 0. That is the direction that
 * goes quiet, and it was introduced by the fix for the noise directly above:
 * suppressing a consequence is one edit away from suppressing the cause.
 */
const hostPermissionsReadable =
  manifest.host_permissions === undefined ||
  manifest.host_permissions === null ||
  Array.isArray(manifest.host_permissions);

// 4 — it loads at all.
if (manifest.manifest_version !== 3) {
  // Quoted, because the comparison is `!==` and the commonest way to fail it is
  // the string "3". Interpolated bare, that printed `manifest_version is 3,
  // expected 3` — a message that reads as a bug in the checker.
  fail(`manifest_version is ${JSON.stringify(manifest.manifest_version) ?? "undefined"}, expected 3`);
}
/**
 * "Declared" and "declared as the right type" are two questions, and one
 * sentence each.
 *
 * Reading the field through `stringAt` and then testing the result for
 * falsiness merges them, because `stringAt` returns `null` for a wrong type and
 * this reads `""` for an absent one — both falsy. A manifest holding
 * `"default_popup": 5` then produced two findings for one cause:
 *
 *     • manifest action.default_popup is number, not a string
 *     • manifest declares no action.default_popup
 *
 * The second contradicts the first — the field *is* declared — and a reader
 * acting on it adds a key that is already there. That is the failure this file
 * names by hand further down ("One cause must produce one sentence"), so the
 * absence test therefore reads `stringAt`'s own answer for "nothing usable
 * here", which is `""`, and leaves `null` — its answer for "wrong type" —
 * to the finding it has already raised.
 *
 * **Not `raw === undefined`.** That was the first attempt and it was worse than
 * the defect it replaced, because it narrowed in the direction that goes quiet:
 * `?? ""` collapses `null` *and* `undefined`, so `"default_popup": null` and
 * `"default_popup": ""` matched neither branch — not wrong-typed, since `""` is
 * a string, and not absent, since the key is there. Measured, both went from a
 * finding to `Extension package OK`, exit 0. A gate that answers "fine" for a
 * package with no popup is the third state this file warns about elsewhere: not
 * a mismatch, not an unmeasurable, but a "yes" said in the voice of a "yes".
 */
const action = objectAt(manifest.action, "action");
const popup = action === null ? null : stringAt(action?.default_popup ?? "", "action.default_popup");
// `action === null` means it was declared as something that is not an object,
// and that has already been reported. Saying "declares no default_popup" on top
// of it is the second sentence that contradicts the first.
if (popup === "") fail("manifest declares no action.default_popup");
for (const rel of [popup, ...iconPaths(manifest.icons)].filter(Boolean)) {
  if (!existsSync(join(DIST, rel))) fail(`manifest names "${rel}", which is not in the package`);
}

// 3 — no remote code.
// Through `objectAt` like the other two containers: read with bare optional
// chaining, `"content_security_policy": "script-src 'self'"` produced two
// findings, both false — `got: (none)` for a policy printed in full in the
// manifest, and `has no connect-src` right after it. One cause, two sentences,
// which is the defect this PR is named for.
const cspBlock = objectAt(manifest.content_security_policy, "content_security_policy");
/**
 * Both CSP rules are skipped when the block itself is the wrong type — the two
 * of them would otherwise turn one cause into three sentences, and this is the
 * worst place in the file for that: a reader told `got: (none)` for a policy
 * that is printed in full in their manifest has been told the checker is wrong,
 * about the rule that keeps remote code out.
 */
/**
 * Readable means: the block is an object, and `extension_pages` inside it is a
 * string. Both CSP rules below are skipped otherwise.
 *
 * The inner check matters as much as the outer one. `"extension_pages": 5` used
 * to print `got: 5` *and* `has no connect-src` — two sentences, and the second
 * is a claim about the contents of something that has no contents. `[]` was
 * worse: it printed `got:` with nothing after it, so the reader was shown an
 * empty space where the offending value should be.
 */
const cspRaw =
  cspBlock === null
    ? null
    : stringAt(cspBlock?.extension_pages ?? "", "content_security_policy.extension_pages");
const cspReadable = cspRaw !== null;
const csp = cspRaw ?? "";
if (cspReadable && !/(^|;)\s*script-src\s+'self'\s*(;|$)/.test(csp)) {
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
if (!cspReadable) {
  // The block is not an object; `objectAt` said so once and that is the whole
  // report for this cause.
} else if (!cspConnect) {
  fail("extension_pages CSP has no `connect-src` — the browser would allow any host");
} else {
  const declared = new Set(
    cspConnect[2].trim().split(/\s+/).filter((s) => s !== "'self'"),
  );
  const permitted = new Set(
    hostPermissions.map((p) => p.replace(/\/\*$/, "")),
  );
  for (const host of declared) {
    // Only when there is a list to compare against — see `hostPermissionsReadable`.
    if (hostPermissionsReadable && !permitted.has(host)) {
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
for (const perm of stringsIn(manifest.permissions, "permissions")) {
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

const contentScripts = objectsIn(manifest.content_scripts, "content_scripts");
for (const cs of contentScripts) {
  for (const m of stringsIn(cs.matches, "content_scripts[].matches")) {
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
  for (const f of stringsIn(cs.js, "content_scripts[].js")) {
    if (!existsSync(join(DIST, f))) fail(`content_scripts names "${f}", which is not in the package`);
  }
}

for (const war of objectsIn(manifest.web_accessible_resources, "web_accessible_resources")) {
  for (const m of stringsIn(war.matches, "web_accessible_resources[].matches")) {
    if (!ALLOWED_MATCHES.has(m)) {
      fail(`web_accessible_resources is exposed to "${m}", which is not in the reviewed set`);
    }
  }
  for (const r of stringsIn(war.resources, "web_accessible_resources[].resources")) {
    if (!existsSync(join(DIST, r))) fail(`web_accessible_resources names "${r}", which is not in the package`);
    // Anything reachable from a page is reachable by every page. Exposing a
    // wallet page here would put the unlock screen inside a site's frame.
    if (r !== "inpage.js") {
      fail(`web_accessible_resources exposes "${r}"; only the page-world provider may be web-reachable`);
    }
  }
}

/**
 * Same two questions as `default_popup` above, plus one this gate never asked:
 * whether `background` is an object at all.
 *
 * `"background": 5` and `"background": "background.js"` both make
 * `manifest.background?.service_worker` come out `undefined`, so the gate said
 * *"background declares no service_worker"* — a sentence about a field, for a
 * manifest whose problem is one level up. Optional chaining reads a scalar as
 * cleanly as it reads a missing key, and that is exactly what hides the case.
 */
const background = objectAt(manifest.background, "background");
const sw = stringAt(background?.service_worker ?? "", "background.service_worker");
if (background && sw === "") fail("background declares no service_worker");
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

/**
 * One reading of a `host_permissions` pattern, used everywhere it is read.
 *
 * There were three, and they disagreed. The strict regex here dropped a
 * pattern carrying a port; `bundleHosts` above parses with `new URL`, which
 * keeps the port. So a build pointed at `https://my-node.example:8443` produced
 * a manifest declaring that host, and the gate then printed, two lines apart,
 * that the pattern was rejected for "a wildcard scheme or host" — there was no
 * wildcard — and that `host_permissions` did not declare a host it declares
 * verbatim. A reader following those two sentences adds a wildcard.
 *
 * `reason` is what the pattern is wrong about, so the message can name the
 * actual cause instead of the nearest rule. `authority` is returned **even when
 * the pattern is refused**, because the "already reported" set below has to be
 * built from this function rather than from a second expression: a set built
 * from a narrower regex covers some refusal reasons and not others, and the
 * ones it misses get a contradicting second sentence. That is how the port case
 * reached review, and rebuilding the mistake one axis over is what this
 * signature exists to prevent.
 */
function parseHostPermission(pattern) {
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/*]*)\/\*$/i.exec(pattern);
  if (!m) {
    return {
      host: null,
      authority: null,
      reason:
        `only \`https://<host>/*\` with a literal host is allowed; a wildcard scheme or ` +
        `host grants reach over sites nobody reviewed`,
    };
  }
  const scheme = m[1].toLowerCase();
  const authority = m[2].toLowerCase();
  const refuse = (reason) => ({ host: null, authority, reason });

  // Refused for the same reason the wallet refuses a plain-HTTP chain source:
  // a network between the browser and the endpoint can read every address
  // looked up and replace every answer, including the balance a person is about
  // to act on. In `host_permissions` it is worse than a bad source, because it
  // is a standing grant that survives whatever the source is later set to.
  if (scheme !== "https") {
    return refuse(
      `the scheme is "${scheme}:", and only https is allowed here — a plain-HTTP grant lets ` +
        `any network between the browser and that host read every address this wallet looks ` +
        `up and rewrite every answer`,
    );
  }
  // Chrome's match patterns have no place for a port — the host part is matched
  // whole, and a pattern carrying `:8443` matches nothing, so the extension
  // simply cannot reach that endpoint. Caught here rather than left to Chrome,
  // which reports it as a chain read that returned nothing.
  //
  // `/:\d*$/`, not `includes(":")`. A colon appears in three different mistakes
  // and only one of them is a port: `https://[::1]/*` and
  // `https://user:pass@host/*` were both told to "point the endpoint at 443",
  // which names a cause neither one has. Same error the rest of this function
  // exists to stop, one level down — a rule reporting the nearest reason rather
  // than the real one.
  if (/:\d*$/.test(authority)) {
    return refuse(
      `a Chrome match pattern has no place for a port, so this one matches nothing and ` +
        `the extension cannot reach that endpoint at all — point the endpoint at ` +
        `443, or run the wallet as a web page, where ports are ordinary`,
    );
  }
  // ASCII checked on the ORIGINAL, before lowercasing.
  //
  // `.toLowerCase()` is not an ASCII operation. Exactly one codepoint above 127
  // folds into this character class — `U+212A KELVIN SIGN` maps to `k` — so
  // lowercasing first and testing after accepts `api.<U+212A>oios.rest` and
  // reports it as `api.koios.rest`. The old strict regex refused it, because a
  // regex `i` flag does not fold non-ASCII into an ASCII range. Losing that was
  // a quiet loosening in the one file whose stated job (`.github/CODEOWNERS`)
  // is catching look-alike hosts, so the order is written down rather than left
  // to whoever edits these two lines next.
  if (!/^[\x20-\x7e]+$/.test(m[2]) || !/^[a-z0-9.-]+$/.test(authority)) {
    return refuse(`"${m[2]}" is not a literal host`);
  }
  return { host: authority, authority, reason: null };
}

for (const pattern of hostPermissions) {
  const parsed = parseHostPermission(pattern);
  if (!parsed.host) {
    fail(`host_permissions declares "${pattern}" — ${parsed.reason}`);
    continue;
  }
  const m = [pattern, parsed.host];
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
  hostPermissions.map((p) => parseHostPermission(p).host).filter(Boolean),
);
/**
 * Every authority the manifest mentions, valid pattern or not.
 *
 * One cause must produce one sentence. A pattern rejected above for carrying a
 * port is absent from `declaredHosts`, so this loop would go on to say the
 * manifest does not declare a host it declares verbatim — a second sentence,
 * contradicting the first, about the same one mistake. The reader then has to
 * guess which of the two to act on, and the reachable wrong guess is adding a
 * wildcard.
 */
const mentionedAuthorities = new Set(
  hostPermissions.map((p) => parseHostPermission(p).authority).filter(Boolean),
);
for (const host of bundleHosts) {
  if (!declaredHosts.has(host)) {
    if (mentionedAuthorities.has(host)) continue; // already reported, by its real cause
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

/**
 * The closing sentence names what was measured, and it took two tries to get
 * right — both wrong in the same way, which is why the shape is written out.
 *
 * Version one said every host was "backed by provider.ts or chainEnv.ts". True
 * while source was the only blessing, false the moment a build could widen the
 * manifest for itself, and it went on printing about hosts neither file names.
 *
 * Version two split the list by `bundleHosts.has(h)` — asking one question and
 * inferring the other from its negation. A host holding *both* blessings then
 * landed in the build-only bucket and was announced as "reviewed only by whoever
 * set the build variable", which is the ordinary case: the receipt lists only
 * origins the manifest did not already declare, and every vendor host is named
 * in `chainEnv.ts`, so `VITE_BLOCKFROST_PROJECT_ID_PREPROD` alone produced that
 * sentence about a host CODEOWNERS gates on its own line. Understating is the
 * safe direction, but a warning that is wrong in the reassuring-to-ignore
 * direction teaches the reader to skip the line — and the line exists for the
 * day it is right.
 *
 * So each host is asked *both* questions, and the three answers are named.
 */
const declaredHostList = hostPermissions
  .map((p) => parseHostPermission(p).host)
  .filter(Boolean);
const inSource = (h) => providerHosts.has(h);
const inBuild = (h) => bundleHosts.has(h);
const both = declaredHostList.filter((h) => inSource(h) && inBuild(h));
const sourceOnly = declaredHostList.filter((h) => inSource(h) && !inBuild(h));
const buildOnly = declaredHostList.filter((h) => !inSource(h) && inBuild(h));
const reviewed = sourceOnly.length + both.length;
const backing =
  buildOnly.length === 0
    ? `${reviewed} host permissions, all named as URL literals in provider.ts or chainEnv.ts`
    : `${reviewed} host permissions named in provider.ts or chainEnv.ts, and ` +
      `${buildOnly.length} this build declared for itself and no source names ` +
      `(${buildOnly.join(", ")}) — reviewed only by whoever set the build variable`;
console.log(
  `Extension package OK — manifest v3 loads, no manifest key or permission outside ` +
    `the reviewed set, CSP allows no remote code, page-world code imports nothing but ` +
    `the rules, and ${backing}`,
);
