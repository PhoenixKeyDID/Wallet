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
/**
 * Directories this gate does not START from. They are not walls: the walk
 * starts from SCAN and the repo root, and then follows every import it can
 * resolve, wherever it lands. A list of directories was the flaw — a panel
 * re-exporting `docs/relay.ts`, `locales/relay.ts` or a skipped test file, each
 * re-exporting the keystore, printed OK, because the one file that touched the
 * keystore sat in a directory nobody walked. What a scanned file imports is
 * read, in any directory, so a relay is found by the edge that reaches it.
 */
const NOT_SOURCE = new Set([".git", "node_modules", "dist-extension", ".claude", "_Agents", ".github", "docs", "locales"]);
/**
 * The one exclusion, and it is printed with every result. The gate's own tests
 * live here and spell keystore imports inside string fixtures — an alias such
 * as `@/lib/keystore/vault` resolves the same from any directory — so reading
 * them would fail the gate on its own test data. Only `*.test.*` files are
 * skipped, and only as starting points: a helper module beside them is read,
 * and so is a test file that any read file imports.
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
/*
 * A clause may also hold string names — `export { vault as "v" }` and
 * `import { "vault" as v }` are valid ES2022, and both stopped the old pattern
 * at the first quote, which it then took for the specifier, so the real one was
 * never read. The specifier is now the string after `from`; a side-effect
 * import, which has no `from`, is `BARE_IMPORT_RE` below.
 */
const QUOTED = String.raw`"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'`;
const IMPORT_RE = new RegExp(
  String.raw`\b(import|export)((?:${GAP}|[\w$*{},]|${QUOTED})*?)\bfrom${GAP}*["'\`]([^"'\`]+)["'\`]`,
  "g",
);
const BARE_IMPORT_RE = new RegExp(String.raw`\bimport${GAP}*["'\`]([^"'\`]+)["'\`]`, "g");
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
 * pattern or an array of them. Negated patterns (`!…`) only remove files and
 * are skipped.
 *
 * A pattern is matched against the files that exist, the way Vite expands it.
 * It used to be resolved like one specifier, with `*` compared as a path
 * segment — so a pattern whose wildcard sat ABOVE the keystore directory (all
 * of `../lib/`, recursively; or every `vault.ts` one level under it) was not
 * "inside" the keystore, and printed OK while Vite bundled the vault. Each file
 * the pattern matches is now judged like a file imported by name: a keystore
 * file is a failure, a sealed entry is "not a named import", and anything else
 * is read in turn. A call whose pattern is not a literal — a variable, a
 * template that interpolates, an extglob — is a failure, because no file list
 * can be derived from it.
 */
const GLOB_RE = new RegExp(
  String.raw`\bimport\.meta\.glob(?:Eager)?(?:${GAP}|<[^>()]*>)*\(${GAP}*(\[[^\]]*\]|["'\`][^"'\`]+["'\`])`,
  "y",
);
/** Every call Vite would expand, whatever its argument looks like. */
const GLOB_CALL_RE = new RegExp(String.raw`\bimport\.meta\.glob(?:Eager)?(?:${GAP}|<[^>()]*>)*\(`, "g");
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

/**
 * `package.json#imports` — the other place a `#` alias is declared. Node, the
 * TypeScript resolver (`moduleResolution: "bundler"`) and Vite all honour it;
 * this gate read only tsconfig, so `"#k": "./src/lib/keystore/index.ts"` and a
 * panel re-exporting `#k` printed OK while Vite bundled the vault. Every
 * `package.json` from the importing file's directory up to the repo root is
 * read, and every target under every condition counts: whichever one a build
 * picks, it is one of these.
 */
const pkgCache = new Map();
function readPackageImports(dir) {
  if (pkgCache.has(dir)) return pkgCache.get(dir);
  const file = join(dir, "package.json");
  let imports = null;
  if (existsSync(file)) {
    try {
      imports = JSON.parse(readFileSync(file, "utf8")).imports ?? null;
    } catch (e) {
      fail(`cannot parse ${relative(REPO, file).split(sep).join("/") || "package.json"}: ${e.message}`);
    }
  }
  pkgCache.set(dir, imports);
  return imports;
}
function leaves(target) {
  if (typeof target === "string") return [target];
  if (target && typeof target === "object") return Object.values(target).flatMap(leaves);
  return [];
}
function subpathImports(s, fromFile) {
  const out = [];
  // A followed file arrives as a real path, which under a symlinked repo is
  // not below REPO as written; either spelling of the root ends the walk.
  const stops = [resolve(REPO), realpathSync(REPO)];
  for (let dir = dirname(resolve(fromFile)); ; dir = dirname(dir)) {
    const imports = readPackageImports(dir);
    if (imports && typeof imports === "object") {
      for (const [key, target] of Object.entries(imports)) {
        const star = key.indexOf("*");
        let middle = null;
        if (star < 0) middle = key === s ? "" : null;
        else if (s.startsWith(key.slice(0, star)) && s.endsWith(key.slice(star + 1)) && s.length >= key.length - 1) {
          middle = s.slice(star, s.length - (key.length - star - 1));
        }
        if (middle === null) continue;
        for (const t of leaves(target)) if (t.startsWith("./")) out.push(resolve(dir, t.split("*").join(middle)));
      }
    }
    if (stops.includes(dir) || dirname(dir) === dir || !stops.some((s) => dir.startsWith(s + sep))) break;
  }
  return out;
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
  const out = s.startsWith("#") ? subpathImports(s, fromFile) : [];
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
 * Specifiers in `text`, as `[spec, offset, clause, kind]`. `clause` is, for a
 * static `import`/`export … from`, the text between the keyword and `from`
 * (`null` for every form that does not name what it takes). `kind` is `"glob"`
 * for an `import.meta.glob` pattern, `"unreadable-glob"` for a glob call whose
 * argument is not a literal (with `spec` null), and `"spec"` otherwise.
 */
function* specifiers(text) {
  IMPORT_RE.lastIndex = 0; // these are /g and shared across files
  for (const m of text.matchAll(IMPORT_RE)) yield [m[3], m.index, m[1] + m[2], "spec"];
  for (const re of [BARE_IMPORT_RE, DYNAMIC_RE, URL_CTOR_RE]) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) yield [m[1], m.index, null, "spec"];
  }
  GLOB_CALL_RE.lastIndex = 0;
  for (const call of text.matchAll(GLOB_CALL_RE)) {
    GLOB_RE.lastIndex = call.index;
    const m = GLOB_RE.exec(text);
    if (!m) {
      yield [null, call.index, null, "unreadable-glob"];
      continue;
    }
    const arg = m[1];
    const strings = [...arg.matchAll(STRING_RE)];
    // An array must hold string literals and nothing else: `[base + "/*.ts"]`
    // names files no list of literals describes.
    const rest = arg.startsWith("[")
      ? arg.slice(1, -1).replace(STRING_RE, "").replace(new RegExp(GAP, "g"), "").replace(/,/g, "")
      : "";
    if (rest !== "" || strings.length === 0) {
      yield [null, call.index, null, "unreadable-glob"];
      continue;
    }
    for (const s of strings) {
      if (s[0].startsWith("`") && s[1].includes("${")) yield [null, call.index, null, "unreadable-glob"];
      else if (!s[1].startsWith("!")) yield [s[1], call.index, null, "glob"];
    }
  }
}

const noExt = (p) => p.replace(/\.(m|c)?[jt]sx?$/, "");
const SEALED_ABS = SEALED.map(([entry, names]) => [
  entry,
  entry.endsWith("/") ? canonical(join(REPO, entry)) : noExt(canonical(join(REPO, entry))),
  new Set(names),
]);

/** The sealed entry a real path falls on, or undefined. */
function sealedOf(real) {
  for (const s of SEALED_ABS) {
    const hit = s[0].endsWith("/") ? inside(real, s[1]) : noExt(real).toLowerCase() === s[1].toLowerCase();
    if (hit) return s;
  }
  return undefined;
}

/** The sealed entry a specifier lands on, or undefined. */
function sealedTarget(spec, fromFile) {
  for (const c of candidates(spec, fromFile)) {
    const s = sealedOf(canonical(c));
    if (s) return s;
  }
  return undefined;
}

/**
 * The names a static import or re-export clause takes, or null when it takes
 * something a name list cannot describe (`*`, a default, a namespace, nothing).
 * A name may be a string (`import { "LocalWalletPanel" as P }`); it is the
 * same name without its quotes.
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
    .map((n) => n.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim().replace(/^(["'])(.*)\1$/, "$2"))
    .filter(Boolean);
  return names.length ? names : null;
}

const SOURCE_RE = /\.(m|c)?[jt]sx?$/;
const EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const isFile = (p) => existsSync(p) && statSync(p).isFile();

/**
 * The source files a specifier resolves to, as a bundler would find them:
 * the path itself, the path with each extension, a `.js` spelling of a `.ts`
 * file, and a directory's `index`. Every candidate counts.
 */
function resolveFiles(spec, fromFile) {
  const out = [];
  for (const c of candidates(spec, fromFile)) {
    const tries = [c, ...EXTS.map((e) => c + e), ...EXTS.map((e) => join(c, "index" + e))];
    const js = /\.(m|c)?jsx?$/.exec(c);
    if (js) tries.push(...EXTS.map((e) => c.slice(0, -js[0].length) + e));
    for (const t of tries) if (SOURCE_RE.test(t) && isFile(t)) out.push(t);
  }
  return out;
}

/**
 * A glob pattern with its braces expanded — `{a,b}` and nested sets — into the
 * plain patterns it stands for. A brace with no top-level comma is literal.
 */
function expandBraces(p) {
  let depth = 0;
  let open = -1;
  for (let i = 0; i < p.length; i += 1) {
    if (p[i] === "\\") {
      i += 1;
      continue;
    }
    if (p[i] === "{") {
      if (depth === 0) open = i;
      depth += 1;
    } else if (p[i] === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0) {
        const inner = p.slice(open + 1, i);
        const parts = [];
        let d = 0;
        let start = 0;
        for (let j = 0; j < inner.length; j += 1) {
          if (inner[j] === "\\") j += 1;
          else if (inner[j] === "{") d += 1;
          else if (inner[j] === "}") d -= 1;
          else if (inner[j] === "," && d === 0) {
            parts.push(inner.slice(start, j));
            start = j + 1;
          }
        }
        parts.push(inner.slice(start));
        if (parts.length < 2) continue;
        const head = p.slice(0, open);
        const tail = p.slice(i + 1);
        return parts.flatMap((part) => expandBraces(head + part + tail));
      }
    }
  }
  return [p];
}

/**
 * One brace-free glob, as a regular expression over a `/`-separated relative
 * path: `*` and `?` stay inside a segment, `**` crosses them, `[…]` is a class.
 * Case is ignored, so a pattern matches on a case-insensitive disk what it
 * matches there.
 */
function globRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === "*" && glob[i + 1] === "*") {
      i += 1;
      if (glob[i + 1] === "/") {
        i += 1;
        re += "(?:.*/)?";
      } else re += ".*";
    } else if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else if (ch === "[" && glob.indexOf("]", i + 2) > i) {
      const end = glob.indexOf("]", i + 2);
      let body = glob.slice(i + 1, end);
      const neg = body[0] === "!" || body[0] === "^";
      if (neg) body = body.slice(1);
      re += `[${neg ? "^" : ""}${body.replace(/[\\\]]/g, "\\$&")}]`;
      i = end;
    } else if (ch === "\\" && i + 1 < glob.length) {
      i += 1;
      re += glob[i].replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    } else re += ch.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i");
}

/** Every file under `dir`, following symlinks once, skipping dependencies. */
function* walkAll(dir, seen = new Set()) {
  const real = realpathSync(dir);
  if (seen.has(real)) return;
  seen.add(real);
  for (const name of readdirSync(dir).sort()) {
    if (name === "node_modules" || name === ".git") continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue; // a dangling symlink names no file
    }
    if (st.isDirectory()) yield* walkAll(full, seen);
    else if (st.isFile()) yield full;
  }
}

const REPO_REAL = realpathSync(REPO);

/**
 * The files one glob pattern matches, or `null` when this gate cannot expand
 * it (an extglob, or a `.`/`..` segment after a wildcard).
 */
function globFiles(pattern, fromFile) {
  if (/[?*+@!]\(/.test(pattern)) return null;
  const out = [];
  for (const p of expandBraces(pattern)) {
    const segs = p.split("/");
    const k = segs.findIndex((seg) => /[*?[]/.test(seg));
    if (k < 0) {
      out.push(...resolveFiles(p, fromFile));
      continue;
    }
    const restSegs = segs.slice(k);
    if (restSegs.some((seg) => seg === "." || seg === "..")) return null;
    let prefix = segs.slice(0, k).join("/");
    if (prefix === "" && p.startsWith("/")) prefix = "/";
    const bases = prefix === "" ? [dirname(fromFile)] : candidates(prefix, fromFile);
    const re = globRegExp(restSegs.join("/"));
    for (const b of bases) {
      const base = canonical(b);
      if (!existsSync(base) || !statSync(base).isDirectory()) continue;
      // A base above the repo (`/` read as the filesystem root) is walked only
      // where the repo is: nothing outside it is the keystore.
      const walkRoot = inside(REPO_REAL, base) ? REPO_REAL : inside(base, REPO_REAL) ? base : null;
      if (!walkRoot) continue;
      for (const f of walkAll(walkRoot)) {
        if (re.test(relative(base, f).split(sep).join("/"))) out.push(f);
      }
    }
  }
  return out;
}

/**
 * A source file this gate cannot read as text. A NUL byte, or a UTF-16 byte
 * order mark, turns every pattern here blind — each ASCII character is followed
 * by a zero — while tsc reads UTF-16 with a BOM as source. Such a file is a
 * failure, not a skip.
 */
function unreadableText(buf) {
  const head = buf.subarray(0, 8192);
  if (head.length >= 2 && ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff))) {
    return "is UTF-16";
  }
  return head.includes(0) ? "has a NUL byte in its first 8 KiB" : null;
}

const offenders = [];
let excluded = 0;
let followed = 0;

/*
 * The walk is a graph walk. It starts from every file at the repo root and
 * under SCAN, and then reads every file a read file imports — by specifier,
 * by glob, by worker URL — wherever that file sits. Files on the allow-list
 * are not read (they may import the keystore; what they hand out is checked
 * at the edge into them), and neither is the keystore itself.
 */
const queue = [];
const queued = new Set();
const reachedFrom = new Map();
function enqueue(file, from) {
  let real;
  try {
    real = realpathSync(file);
  } catch {
    return;
  }
  if (queued.has(real)) return;
  if (!inside(real, REPO_REAL) || inside(real, KEYSTORE)) return;
  const r = relative(REPO_REAL, real).split(sep).join("/");
  if (r.split("/").includes("node_modules") || allowed(r)) return;
  queued.add(real);
  if (from !== undefined) {
    followed += 1;
    reachedFrom.set(file, from);
  }
  queue.push(file);
}

// Files at the repo root are read too: a relay module there is one directory
// hop from any panel, exactly like one under `scripts/`.
const rootFiles = readdirSync(REPO)
  .sort()
  .map((n) => join(REPO, n))
  .filter((f) => SOURCE_RE.test(f) && statSync(f).isFile());
for (const file of [...rootFiles, ...SCAN.flatMap((d) => (existsSync(join(REPO, d)) ? [...walk(join(REPO, d))] : []))]) {
  const r = rel(file);
  if (EXCLUDED.test(r)) {
    excluded += 1;
    continue;
  }
  if (allowed(r)) continue;
  queued.add(realpathSync(file));
  queue.push(file);
}

const relOf = (f) => (f.startsWith(REPO + sep) ? rel(f) : relative(REPO_REAL, f).split(sep).join("/"));

while (queue.length) {
  const file = queue.shift();
  const r = relOf(file);
  const via = reachedFrom.has(file) ? ` (read because ${reachedFrom.get(file)} imports it)` : "";
  const buf = readFileSync(file);
  const bad = unreadableText(buf);
  if (bad) {
    offenders.push(`${r}${via} ${bad}, so no import in it can be read`);
    continue;
  }
  const text = buf.toString("utf8");
  const seen = new Set();
  for (const [spec, index, clause, kind] of specifiers(text)) {
    const at = `${r}:${lineOf(text, index)}${via}`;
    const whys = [];
    if (kind === "unreadable-glob") {
      whys.push("calls import.meta.glob with a pattern that is not a literal, so the files it loads cannot be listed");
    } else if (reachesKeystore(spec, file)) whys.push(`imports "${spec}"`);
    else if (kind === "glob") {
      const files = globFiles(spec, file);
      if (files === null) whys.push(`globs "${spec}", a pattern this gate cannot expand`);
      else {
        for (const f of files) {
          const real = canonical(f);
          const sealed = sealedOf(real);
          if (inside(real, KEYSTORE)) whys.push(`globs "${spec}", which matches ${relOf(real)}`);
          else if (sealed) {
            const may = sealed[2].size ? `only { ${[...sealed[2]].join(", ")} }` : "nothing";
            whys.push(`globs "${spec}", which loads all of allowed ${relOf(real)} (${sealed[0]}), which may hand out ${may}`);
          } else if (SOURCE_RE.test(f)) enqueue(f, r);
        }
      }
    } else {
      const sealed = sealedTarget(spec, file);
      const names = sealed && namedImports(clause);
      const extra = sealed && (names === null ? ["(not a named import)"] : names.filter((n) => !sealed[2].has(n)));
      if (sealed && extra.length) {
        const may = sealed[2].size ? `only { ${[...sealed[2]].join(", ")} }` : "nothing";
        whys.push(`takes ${extra.join(", ")} from allowed "${spec}" (${sealed[0]}), which may hand out ${may}`);
      } else if (!sealed) for (const f of resolveFiles(spec, file)) enqueue(f, r);
    }
    for (const why of whys) {
      // A static import can match more than one pattern; report the site once.
      if (seen.has(`${at} ${why}`)) continue;
      seen.add(`${at} ${why}`);
      offenders.push(`${at} ${why}`);
    }
  }
}

const scope =
  `scanned the repo root and ${SCAN.map((d) => d + "/").join(", ")}, then every file they import ` +
  `(${followed} outside those); ${EXCLUSION_NOTE} unless imported (${excluded} skipped)`;

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
