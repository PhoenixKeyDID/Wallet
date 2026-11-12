/**
 * The self-custody keystore is reachable from one place, and only one.
 *
 * `docs/Phoenix Wallet-Feat.md` §2.1a and the README both say it: the code that
 * holds a spendable seed lives in `src/lib/keystore/` and no other mode imports
 * it, which is what lets the spec claim the three key-free modes stay key-free.
 *
 * That sentence was true and unenforced. Nothing stopped a future panel from
 * importing `keystore/session` for something innocent-looking — a lock timer, a
 * wallet list — and once any Connect or Watch-only screen pulls the module in,
 * the claim is false everywhere it is written, silently, and the person who
 * broke it had no way to know they were breaking anything.
 *
 * An invariant a document asserts and a machine does not check is a wish. This
 * is the check. Widening the allow-list is allowed — it is a reviewed diff in a
 * CODEOWNERS-gated file, which is exactly the conversation that should happen.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * The repo this script lives in, unless a root is passed as the first argument
 * — which is for the tests, so they can stage an import this gate must refuse
 * without writing it into the repo.
 */
const REPO = process.argv[2]
  ? resolve(process.argv[2])
  : join(dirname(fileURLToPath(import.meta.url)), "..");

/** Repo-relative, POSIX-separated. Anything here may import the keystore. */
const ALLOWED = [
  "src/lib/keystore/", // the module itself
  "src/components/wallet/LocalWalletPanel.tsx", // the one screen that holds a key
  "extension/smoke/", // the browser-bundle check, which must exercise the real thing
  /*
   * The approval window a website's request opens. It is the second screen that
   * holds a key, and it exists because the first one cannot do this job: a
   * password typed into a page served by a dApp is indistinguishable from a
   * phishing copy of that page, so the unlock form has to live on a
   * `chrome-extension://` origin. Signing for a dApp therefore has to happen
   * where the keys are, and that is here.
   *
   * What this widening does NOT do, and what keeps the claim it changes true:
   * the keystore is still unreachable from every Connect and Watch-only screen,
   * and still unreachable from anything a web page loads. `content/bridge.ts`
   * and `inpage/provider.ts` are the two files that run inside a website, and
   * neither is on this list — they relay bytes and hold nothing. The sentence
   * in README and in the spec (§2.1a) was updated in the same commit as this
   * line, which is the trade the gate's failure message asks for.
   */
  "extension/src/approve.tsx",
];

/**
 * What a file OUTSIDE the allow-list may take from a file ON it.
 *
 * The allow-list is a list of edges, and an edge is not a wall: an allowed file
 * that re-exports the keystore hands it to whoever imports that file. Measured:
 * `extension/smoke/relay.ts` re-exporting the vault, imported by a Connect
 * panel, printed OK; so did a re-export added to `LocalWalletPanel.tsx`. So an
 * import from outside into one of these may name only the exports listed here —
 * a named import (`import { LocalWalletPanel } from …`) or a named re-export.
 * Everything else is refused: `*`, a default or namespace import, a bare
 * side-effect import, and any `import()`, `require()`, glob or `new URL` of it,
 * because none of those says which names it takes. An empty list means nothing
 * outside may import the entry at all. The keystore module itself is not here:
 * importing it from outside is already the failure.
 */
const SEALED = [
  ["src/components/wallet/LocalWalletPanel.tsx", ["LocalWalletPanel"]],
  ["extension/smoke/", []],
  ["extension/src/approve.tsx", []],
];

/**
 * Every top-level directory that holds JavaScript or TypeScript. `scripts` was
 * missing: a panel re-exporting `../../scripts/relay`, with `scripts/relay.ts`
 * re-exporting the keystore, printed OK, because the one file that touched the
 * keystore sat where nobody looked. `assertNoUnscannedSourceRoot()` fails the
 * gate when a new directory appears that is on neither list.
 */
const SCAN = ["src", "extension", "scripts"];
/** Never source this gate owes a look at. */
const NOT_SOURCE = new Set([".git", "node_modules", "dist-extension", ".claude", "_Agents", ".github", "docs", "locales"]);
/**
 * The one exclusion, and it is printed with every result. The gate's own tests
 * live here and spell keystore imports inside string fixtures — an alias such
 * as `@/lib/keystore/vault` resolves the same from any directory — so reading
 * them would fail the gate on its own test data. Only `*.test.*` files are
 * skipped: a helper module beside them is still read.
 */
const EXCLUDED = /^scripts\/__tests__\/[^/]+\.test\.(m|c)?[jt]sx?$/;
const EXCLUSION_NOTE = "test files matching scripts/__tests__/*.test.* are not read";

/** A gap between tokens: whitespace, a block comment, or a line comment. */
const GAP = String.raw`(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*)`;
/**
 * Static `import`/`export … from`, wherever the statement starts.
 *
 * It used to be anchored at the start of a line or after a `;`, and each
 * anchor was a way past it: a block comment before the statement on the same
 * line (`/**\/ import …`) and an empty block (`{} import …`) both printed OK,
 * and both compile. The keyword is now matched anywhere it starts a word.
 *
 * What may sit between the keyword and the specifier is limited to what an
 * import clause is made of — names, `*`, braces, commas, `as`/`from`/`type`,
 * whitespace and comments. The old body was "anything, lazily", which let
 * `export { f };` on one line run on to a quote on a later line, report THAT
 * line, and catch an indented `import()` only by accident.
 */
const IMPORT_RE = new RegExp(String.raw`\b(?:import|export)(?:${GAP}|[\w$*{},])*?["'\`]([^"'\`]+)["'\`]`, "g");
/**
 * Dynamic `import("…")` and `require("…")`, anywhere, at any indentation.
 *
 * Verified against this gate before it was added: a file containing only
 * `export const CLS = "probe";` and a dynamic import of the keystore's `port`
 * module through the `@/` alias, inside a function, was reported **OK**, as was
 * the same file using `require(...)`. The static pattern, as it stood then,
 * could reach neither — its `^` anchor skipped indented code, and its lazy body
 * stopped at the first quote it met, which in such a file is an unrelated
 * string literal. (The example is described rather than spelled out because
 * this file is now scanned too, and the spelled-out call is exactly what it
 * refuses.)
 *
 * The quotes may be backticks: `` import(`…`) `` with no interpolation is a
 * static specifier to the runtime and an invisible one to a pattern that only
 * read `'` and `"`. A template that interpolates (`…${m}…`) resolves to a path
 * this gate cannot spell, and stays a job for review.
 *
 * An invariant a document asserts and a machine only half-checks is still a
 * wish; it is just a wish that prints OK.
 *
 * What this still does not stop, stated so nobody mistakes the gate for more
 * than it is: a specifier that is never written literally — `eval("require")(…)`,
 * a path assembled from variables, a re-export laundered through a third module.
 * This is a textual check, so it catches the accident and the shortcut, not the
 * author who is deliberately hiding. That author is what code review is for.
 */
const DYNAMIC_RE = new RegExp(String.raw`\b(?:import|require)\s*\(${GAP}*["'\`]([^"'\`]+)["'\`]`, "g");
// A comment between `(` and the specifier — `import(/* @vite-ignore */ "…")`,
// the form Vite itself suggests — used to hide the call; `GAP` lets it through.

/**
 * `import.meta.glob("…")` — Vite's way to import every module a pattern names,
 * eagerly if asked. Measured: `import.meta.glob("../lib/keystore/vault.ts",
 * { eager: true })` inside a function printed OK. The argument may be one
 * pattern or an array of them; each is resolved like a specifier, and a `*` in
 * it is compared as a path segment, so a pattern under the keystore directory
 * is inside it. Negated patterns (`!…`) only remove files and are skipped.
 */
const GLOB_RE = new RegExp(
  String.raw`\bimport\.meta\.glob(?:Eager)?\s*(?:<[^>()]*>)?\s*\(${GAP}*(\[[^\]]*\]|["'\`][^"'\`]+["'\`])`,
  "g",
);
const STRING_RE = /["'`]([^"'`]+)["'`]/g;

/**
 * `new URL("…", import.meta.url)`, and `new Worker("…")` / `new SharedWorker("…")`
 * with a literal path. Vite reads the first as an asset or worker entry and
 * bundles the module it names, so `new Worker(new URL("../lib/keystore/vault.ts",
 * import.meta.url))` — the natural way to move key derivation off the main
 * thread — put the vault into a chunk while this gate printed OK. The path is
 * resolved like any other specifier; a URL with a scheme resolves nowhere near
 * the keystore and is left alone. Comments may sit between the tokens.
 */
const URL_CTOR_RE = new RegExp(
  String.raw`\bnew${GAP}+(?:URL|Worker|SharedWorker)${GAP}*\(${GAP}*["'\`]([^"'\`]+)["'\`]`,
  "g",
);

/**
 * Where an import specifier lands, decided by resolving it — not by what it
 * looks like.
 *
 * This used to be a pattern over the specifier's text, and a pattern over text
 * only knows the spellings its author thought of. Measured against it: a panel
 * one directory over importing `../keystore`, and one importing a module of the
 * keystore the pattern did not list, were both reported OK. Every relative
 * spelling of the same directory is a different string and the same folder;
 * resolving the specifier against the importing file collapses them all into
 * the one question that matters — is this path inside `src/lib/keystore`?
 *
 * Aliases come from `tsconfig.json` (`paths`, and `baseUrl` for bare paths like
 * `src/lib/keystore`), read rather than copied, so a new alias is covered the
 * day it is added. The comparison runs on real paths and ignores case: a
 * symlinked directory, or `../Keystore` on a case-insensitive disk, reaches the
 * same files under a name that is not `keystore`.
 */
const KEYSTORE = canonical(join(REPO, "src", "lib", "keystore"));

/** A failure — never a silent default. */
function fail(message) {
  console.error(`Keystore boundary FAILED — ${message}`);
  process.exit(1);
}

/** One tsconfig file, read as the JSONC it is. */
function readTsconfig(file) {
  const text = readFileSync(file, "utf8");
  try {
    return JSON.parse(text);
  } catch {
    try {
      // tsconfig is JSONC. Drop comments and trailing commas, outside strings.
      return JSON.parse(
        text
          .replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str ?? "")
          .replace(/("(?:[^"\\]|\\.)*")|,(\s*[}\]])/g, (m, str, close) => str ?? close),
      );
    } catch (e) {
      // An alias this gate cannot read is an import it cannot resolve: fail, so
      // the gate does not go on reporting OK about a map it never saw.
      return fail(`cannot parse ${relative(REPO, file).split(sep).join("/")}: ${e.message}`);
    }
  }
}

/** The file an `extends` entry names, as tsc finds it. */
function extendsTarget(entry, fromDir) {
  const tries = entry.startsWith(".") || isAbsolute(entry)
    ? [resolve(fromDir, entry), resolve(fromDir, `${entry}.json`)]
    : [join(REPO, "node_modules", entry), join(REPO, "node_modules", `${entry}.json`), join(REPO, "node_modules", entry, "tsconfig.json")];
  const hit = tries.find((t) => existsSync(t) && statSync(t).isFile());
  return hit ?? fail(`cannot find "${entry}", which a tsconfig extends`);
}

/**
 * One config and the chain it `extends`, merged as tsc merges it: a key set in
 * a file beats the same key from what it extends, and of several `extends`
 * entries the later one wins. Without this an alias declared in a base config
 * (`#k` → the keystore, in `tsconfig.base.json`) printed OK.
 */
function loadChain(file, seen) {
  if (seen.has(file)) fail(`tsconfig extends itself through ${relative(REPO, file)}`);
  seen.add(file);
  const json = readTsconfig(file);
  const dir = dirname(file);
  const acc = {};
  for (const entry of [].concat(json.extends ?? [])) {
    for (const [k, v] of Object.entries(loadChain(extendsTarget(entry, dir), seen))) if (v !== undefined) acc[k] = v;
  }
  const options = json.compilerOptions ?? {};
  if (options.baseUrl !== undefined) acc.baseUrl = resolve(dir, options.baseUrl);
  if (options.paths !== undefined) {
    acc.paths = Object.entries(options.paths);
    acc.pathsDir = dir; // with no baseUrl, targets are relative to the declaring file
  }
  seen.delete(file);
  return acc;
}

/** `tsconfig.json`'s module resolution, following `extends`, or a failure. */
function loadTsconfig() {
  const file = join(REPO, "tsconfig.json");
  if (!existsSync(file)) return { baseUrl: REPO, pathsBase: REPO, paths: [] };
  const c = loadChain(file, new Set());
  return { baseUrl: c.baseUrl ?? REPO, pathsBase: c.baseUrl ?? c.pathsDir ?? REPO, paths: c.paths ?? [] };
}

const TSCONFIG = loadTsconfig();

/**
 * The real path of what `p` names, trying the extensions the bundler tries.
 * A path that does not exist keeps its own last segments, but the longest part
 * of it that DOES exist is resolved to its real path first. Comparing the
 * whole thing as written put it on a different side of every symlink than
 * KEYSTORE: under a repo reached through one (macOS `/var` → `/private/var`),
 * `…/keystore/vault.js` — which a bundler resolves to `vault.ts` — printed OK.
 */
function canonical(p) {
  for (const c of [p, `${p}.ts`, `${p}.tsx`, `${p}.js`, `${p}.mjs`]) {
    if (existsSync(c)) return realpathSync(c);
  }
  let head = resolve(p);
  const tail = [];
  while (!existsSync(head)) {
    const up = dirname(head);
    if (up === head) return resolve(p);
    tail.unshift(basename(head));
    head = up;
  }
  return join(realpathSync(head), ...tail);
}

/** Every path a specifier written in `fromFile` can resolve to. */
function candidates(spec, fromFile) {
  // `…/vault?raw` is still the vault. Not from the first character: a leading
  // `#` is a subpath-import alias, not a fragment.
  const s = spec.replace(/(.)[?#].*$/, "$1");
  if (s === "." || s === ".." || s.startsWith("./") || s.startsWith("../")) return [resolve(dirname(fromFile), s)];
  // A leading `/` is absolute to the filesystem, and to Vite it is also
  // project-root-relative — `/src/lib/keystore/vault` reaches the keystore
  // through a spelling no filesystem resolves. Both readings are returned;
  // whichever one lands inside the keystore is the one that counts.
  if (isAbsolute(s)) return [s, join(REPO, s)];
  const out = [];
  for (const [pattern, targets] of TSCONFIG.paths) {
    const star = pattern.indexOf("*");
    const head = star < 0 ? pattern : pattern.slice(0, star);
    const tail = star < 0 ? "" : pattern.slice(star + 1);
    const hit = star < 0 ? s === pattern : s.startsWith(head) && s.endsWith(tail) && s.length >= head.length + tail.length;
    if (!hit) continue;
    const middle = star < 0 ? "" : s.slice(head.length, s.length - tail.length);
    for (const t of targets) out.push(resolve(TSCONFIG.pathsBase, t.replace("*", middle)));
  }
  // `baseUrl` makes every bare path a path from that directory as well.
  out.push(resolve(TSCONFIG.baseUrl, s));
  return out;
}

const inside = (p, dir) => {
  const a = p.toLowerCase();
  const b = dir.toLowerCase();
  return a === b || a.startsWith(b + sep);
};
const reachesKeystore = (spec, fromFile) => candidates(spec, fromFile).some((c) => inside(canonical(c), KEYSTORE));

/**
 * Source files, wherever they sit. This used to skip every directory named
 * `out` — a rule wide enough to hide `src/out/P.ts` — and to read only
 * `.ts`/`.tsx`, so `src/components/P.js` imported the keystore in a file the
 * walk never handed to the patterns. Now only the built bundle under
 * `extension/smoke/out` is skipped, and every spelling of JavaScript and
 * TypeScript the bundler accepts is read.
 */
function* walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    if (name === "node_modules") continue;
    const full = join(dir, name);
    if (relative(REPO, full).split(sep).join("/") === "extension/smoke/out") continue;
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(m|c)?[jt]sx?$/.test(name)) yield full;
  }
}

const rel = (f) => relative(REPO, f).split(sep).join("/");
const allowed = (r) => ALLOWED.some((a) => (a.endsWith("/") ? r.startsWith(a) : r === a));
const lineOf = (text, index) => text.slice(0, index).split("\n").length;

/** A top-level directory holding source that neither list mentions. */
function assertNoUnscannedSourceRoot() {
  const missed = readdirSync(REPO)
    .sort()
    .filter((d) => !NOT_SOURCE.has(d) && !SCAN.includes(d) && statSync(join(REPO, d)).isDirectory())
    .filter((d) => {
      for (const _ of walk(join(REPO, d))) return true;
      return false;
    });
  if (missed.length) {
    fail(
      `source directories nobody scans: ${missed.map((d) => d + "/").join(", ")}\n` +
        "Add them to SCAN in this file, or to NOT_SOURCE if they ship nothing.",
    );
  }
}
assertNoUnscannedSourceRoot();

/**
 * Specifiers in `text`, each with the offset of the statement that names it and,
 * for a static `import`/`export … from`, the clause between the keyword and the
 * specifier (`null` for every form that does not name what it takes).
 */
function* specifiers(text) {
  IMPORT_RE.lastIndex = 0; // these are /g and shared across files
  for (const m of text.matchAll(IMPORT_RE)) yield [m[1], m.index, m[0].slice(0, m[0].length - m[1].length - 2)];
  for (const re of [DYNAMIC_RE, URL_CTOR_RE]) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) yield [m[1], m.index, null];
  }
  GLOB_RE.lastIndex = 0;
  for (const m of text.matchAll(GLOB_RE)) {
    for (const s of m[1].matchAll(STRING_RE)) if (!s[1].startsWith("!")) yield [s[1], m.index, null];
  }
}

const noExt = (p) => p.replace(/\.(m|c)?[jt]sx?$/, "");
const SEALED_ABS = SEALED.map(([entry, names]) => [
  entry,
  entry.endsWith("/") ? canonical(join(REPO, entry)) : noExt(canonical(join(REPO, entry))),
  new Set(names),
]);

/** The sealed entry a specifier lands on, or undefined. */
function sealedTarget(spec, fromFile) {
  for (const c of candidates(spec, fromFile)) {
    const real = canonical(c);
    for (const s of SEALED_ABS) {
      const hit = s[0].endsWith("/") ? inside(real, s[1]) : noExt(real).toLowerCase() === s[1].toLowerCase();
      if (hit) return s;
    }
  }
  return undefined;
}

/**
 * The names a static import or re-export clause takes, or null when it takes
 * something a name list cannot describe (`*`, a default, a namespace, nothing).
 */
function namedImports(clause) {
  if (clause === null) return null;
  const body = clause
    .replace(new RegExp(String.raw`\/\*[\s\S]*?\*\/|\/\/[^\n]*`, "g"), " ")
    .replace(/^\s*(?:import|export)\b/, "")
    .replace(/\bfrom\s*$/, "")
    .replace(/^\s*type\b/, "")
    .trim();
  const m = /^\{([^{}]*)\}$/.exec(body);
  if (!m) return null;
  const names = m[1]
    .split(",")
    .map((n) => n.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim())
    .filter(Boolean);
  return names.length ? names : null;
}

const offenders = [];
let excluded = 0;
// Files at the repo root are read too: a relay module there is one directory
// hop from any panel, exactly like one under `scripts/`.
const rootFiles = readdirSync(REPO)
  .sort()
  .map((n) => join(REPO, n))
  .filter((f) => /\.(m|c)?[jt]sx?$/.test(f) && statSync(f).isFile());
for (const file of [...rootFiles, ...SCAN.flatMap((d) => (existsSync(join(REPO, d)) ? [...walk(join(REPO, d))] : []))]) {
  const r = rel(file);
  if (EXCLUDED.test(r)) {
    excluded += 1;
    continue;
  }
  if (allowed(r)) continue;
  const text = readFileSync(file, "utf8");
  const seen = new Set();
  for (const [spec, index, clause] of specifiers(text)) {
    const at = `${r}:${lineOf(text, index)}`;
    let why = null;
    if (reachesKeystore(spec, file)) why = `imports "${spec}"`;
    else {
      const sealed = sealedTarget(spec, file);
      const names = sealed && namedImports(clause);
      const extra = sealed && (names === null ? ["(not a named import)"] : names.filter((n) => !sealed[2].has(n)));
      if (sealed && extra.length) {
        const may = sealed[2].size ? `only { ${[...sealed[2]].join(", ")} }` : "nothing";
        why = `takes ${extra.join(", ")} from allowed "${spec}" (${sealed[0]}), which may hand out ${may}`;
      }
    }
    if (!why) continue;
    // A static import can match more than one pattern; report the site once.
    if (seen.has(`${at} ${spec}`)) continue;
    seen.add(`${at} ${spec}`);
    offenders.push(`${at} ${why}`);
  }
}

const scope = `scanned the repo root and ${SCAN.map((d) => d + "/").join(", ")}; ${EXCLUSION_NOTE} (${excluded} skipped)`;

if (offenders.length) {
  console.error("Keystore boundary FAILED — the self-custody keystore is reachable from:\n");
  for (const o of offenders) console.error("  • " + o);
  console.error(
    "\nThe spec (§2.1a) and the README both promise this module is reachable only" +
      "\nfrom LocalWalletPanel, which is what makes the key-free modes key-free." +
      "\nEither route this through the panel, or widen ALLOWED in this file and say" +
      "\nin the same diff which document sentence you are changing.",
  );
  console.error(`\n(${scope}.)`);
  process.exit(1);
}

console.log(
  `Keystore boundary OK — src/lib/keystore is imported only from ${ALLOWED.length} allowed locations (${scope}).`,
);
