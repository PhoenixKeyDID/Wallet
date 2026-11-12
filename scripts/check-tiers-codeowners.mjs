/**
 * Every path CODEOWNERS guards must be `forbidden` in docs/contribution-tiers.json,
 * and so must every file such a path depends on.
 *
 * The two files answer different questions. CODEOWNERS says which changes need a
 * maintainer's review; the tier table says which changes an outside contributor
 * may be paid to make. They are allowed to differ in one direction only: the
 * table may forbid more than CODEOWNERS guards, never less. A file that needs a
 * maintainer's eye and is also listed as a paid `low` or `mid` task invites
 * exactly the drive-by change the CODEOWNERS entry exists to catch — and the
 * first version of the table did that for `receive.ts`, `qr.ts`, `night.ts` and
 * the whole of `locales/`, with nothing red anywhere.
 *
 * Four rules, each one a hole an earlier version left open:
 *
 * 1. **Guarded paths.** Every tracked file under a guarded directory classifies
 *    as `forbidden`. Whether a CODEOWNERS line names a directory is read from
 *    `git ls-files` (some tracked file sits under it), not from a trailing `/`:
 *    GitHub guards `/locales` and `/locales/` alike, and reading the first as a
 *    single file dropped seven guarded files without a word. A line that names
 *    no tracked file fails: it guards nothing, and a misspelt path there reads
 *    like protection that is not in force.
 *
 * 2. **Dependencies.** A `low` or `mid` file that a `forbidden` file imports,
 *    directly or through other files, fails. The second version of the table
 *    listed `TestnetBadge.tsx` as `mid` while the guarded `LocalWalletPanel.tsx`
 *    imported it: a paid change deleting the badge's mainnet guard was a change
 *    to the guarded screen, shipped in the extension popup, with no guarded file
 *    in the diff.
 *
 *    The graph is read from the TypeScript syntax tree of every file in `src/`
 *    and `extension/`, not from a regular expression over its text: an earlier
 *    version did that and missed `import(\`…\`)`, `require("…")`, string-named
 *    imports and `import.meta.glob`, and read imports out of comments. (Nor from
 *    `ts.preProcessFile`: its scanner does not know JSX, and an apostrophe in JSX
 *    text hides every import after it on the line.) What counts as an edge:
 *    import and export declarations, `import x = require("…")`, `import("…")`,
 *    `require("…")`, `import("…")` types, `import.meta.glob("…")` (matched against
 *    tracked files), and `new URL("…", import.meta.url)`. An `import(`, `require(`
 *    or `import.meta.glob(` whose argument is not a constant string fails —
 *    the check cannot know where it goes.
 *
 *    A specifier is resolved as the toolchain would: relative and root-relative
 *    paths, the `@/` alias, then `paths` and `baseUrl` from `tsconfig.json`
 *    (`baseUrl: "."` makes `"src/lib/x"` a file in this repository, not a
 *    package). Only when none of those reaches a tracked file is a specifier a
 *    package, and then only if `package.json` declares it or Node ships it.
 *    Anything else fails. A directory resolves through its own `package.json`
 *    (`types`, `typings`, `module`, `main`, `browser`, and the `package.json`
 *    itself is an edge) and its `index.*`; only `new URL` may name a directory
 *    as a plain path. Where bundlers could pick different files, every candidate
 *    is an edge.
 *
 *    Test files are left out of the graph: a test that imports a file pins it,
 *    it does not give it a path into a running wallet (and test files are
 *    `forbidden` themselves).
 *
 * 3. **No wildcards in paid tiers.** A `low` or `mid` entry is one tracked file,
 *    named exactly. A pattern there (`*`, `?`, `[`, `{`) fails: a wildcard is
 *    where a new file inherits a tier nobody chose for it.
 *
 * 4. **Paid entries exist.** An entry naming a file git does not track fails —
 *    a typo there is a file left in `forbidden` while the table says otherwise.
 *    Rules 3 and 4 together are why a file that does not exist yet is always
 *    `forbidden`: no paid entry can name it.
 *
 * The table must have the shape the marketplace's reader accepts (an object
 * with a `tiers` object holding only `low`, `mid` and `forbidden`, each a list
 * of non-empty strings, at most 500 patterns and 64 KiB): a table the reader
 * rejects as a whole is not one this check may call fine. The glob matcher
 * follows the dialect the table declares (only `*`, `**` and `?`, anchored at
 * both ends, `**` as a whole segment). A pattern outside that dialect, or a
 * CODEOWNERS line in a form this script does not parse, fails the check rather
 * than being skipped: a gate that cannot read its input must not report that
 * the input is fine.
 *
 * Usage: `node scripts/check-tiers-codeowners.mjs [repo-root]` — the root
 * defaults to the repository this script lives in; the tests pass a scratch one.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, posix, resolve } from "node:path";
import ts from "typescript";

const REPO = process.argv[2] ? resolve(process.argv[2]) : join(dirname(fileURLToPath(import.meta.url)), "..");
const TIER_ORDER = ["low", "mid", "forbidden"];
// The marketplace reader's limits (`parseTierTable` in its contribution-tiers.js).
const MAX_TABLE_PATTERNS = 500;
const MAX_TABLE_BYTES = 64 * 1024;
const problems = [];

function cannotRun(why) {
  console.error(`Tier/CODEOWNERS check could not run: ${why}`);
  process.exit(2);
}

// ─── the glob dialect ─────────────────────────────────────────────────────────

function segMatch(p, s) {
  let pi = 0, si = 0, star = -1, mark = 0;
  while (si < s.length) {
    if (pi < p.length && p[pi] === "*") { star = pi; pi += 1; mark = si; continue; }
    if (pi < p.length && (p[pi] === "?" || p[pi] === s[si])) { pi += 1; si += 1; continue; }
    if (star >= 0) { pi = star + 1; mark += 1; si = mark; continue; }
    return false;
  }
  while (pi < p.length && p[pi] === "*") pi += 1;
  return pi === p.length;
}

// The marketplace reader refuses the whole table (TIERS_BAD_SHAPE) when one
// pattern is longer than 1024 characters or has more than 16 wildcards, `**`
// counting once. Applying the same caps here keeps this gate from passing a
// table that reader rejects.
const MAX_PATTERN_LENGTH = 1024;
const MAX_WILDCARDS = 16;

function compileGlob(pattern) {
  if (typeof pattern !== "string" || !pattern.length) throw new Error("empty glob");
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new Error(`glob is ${pattern.length} characters long; the table's reader stops at ${MAX_PATTERN_LENGTH}`);
  }
  if (/[[\]{}]/.test(pattern) || pattern.startsWith("!") || pattern.startsWith("/")) {
    throw new Error(`glob "${pattern}" is outside the declared dialect`);
  }
  const segs = pattern.split("/");
  for (const seg of segs) {
    if (seg !== "**" && seg.includes("**")) throw new Error(`glob "${pattern}": "**" must be a whole segment`);
  }
  const wildcards = segs.reduce((n, seg) => n + (seg === "**" ? 1 : [...seg].filter((c) => c === "*" || c === "?").length), 0);
  if (wildcards > MAX_WILDCARDS) {
    throw new Error(`glob "${pattern}" has ${wildcards} wildcards; the table's reader stops at ${MAX_WILDCARDS}`);
  }
  return (path) => {
    const parts = path.split("/");
    const n = parts.length;
    let reach = new Uint8Array(n + 1);
    reach[0] = 1;
    segs.forEach((seg, i) => {
      const next = new Uint8Array(n + 1);
      if (seg === "**") {
        const last = i === segs.length - 1;
        let seen = 0;
        for (let j = 0; j <= n; j++) {
          if (last) { next[j] = seen; seen |= reach[j]; } else { seen |= reach[j]; next[j] = seen; }
        }
      } else {
        for (let j = 0; j < n; j++) if (reach[j] && segMatch(seg, parts[j])) next[j + 1] = 1;
      }
      reach = next;
    });
    return reach[n] === 1;
  };
}

// ─── the repository ───────────────────────────────────────────────────────────

let tracked;
try {
  tracked = execFileSync("git", ["-C", REPO, "ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);
} catch (e) {
  cannotRun(`git ls-files failed in ${REPO}`);
}
const trackedSet = new Set(tracked);
const isTrackedDir = (dir) => {
  const prefix = dir.replace(/\/+$/, "") + "/";
  return tracked.some((p) => p.startsWith(prefix));
};

// ─── the tier table ───────────────────────────────────────────────────────────

const tablePath = join(REPO, "docs", "contribution-tiers.json");
if (!existsSync(tablePath)) cannotRun("docs/contribution-tiers.json not found");
if (statSync(tablePath).size > MAX_TABLE_BYTES) {
  cannotRun(`docs/contribution-tiers.json is over ${MAX_TABLE_BYTES} bytes — the marketplace rejects it`);
}
let table;
try {
  table = JSON.parse(readFileSync(tablePath, "utf8"));
} catch (e) {
  cannotRun(`docs/contribution-tiers.json does not parse (${e.message})`);
}
// The same shape rules as the marketplace's reader: anything it would reject
// as a whole is refused here too, rather than read in part.
if (!table || typeof table !== "object" || Array.isArray(table)) cannotRun("the tier table is not a JSON object");
if (!table.tiers || typeof table.tiers !== "object" || Array.isArray(table.tiers)) cannotRun('the tier table has no "tiers" object');
const unknownTiers = Object.keys(table.tiers).filter((k) => !TIER_ORDER.includes(k));
if (unknownTiers.length) {
  cannotRun(`the tier table names tiers the marketplace does not know: ${unknownTiers.join(", ")} (only ${TIER_ORDER.join(", ")})`);
}
const patternCount = TIER_ORDER.reduce((n, t) => n + (Array.isArray(table.tiers[t]) ? table.tiers[t].length : 0), 0);
if (patternCount > MAX_TABLE_PATTERNS) cannotRun(`the tier table has ${patternCount} patterns, over the marketplace's ${MAX_TABLE_PATTERNS}`);
const tiers = {};
for (const tier of TIER_ORDER) {
  const list = table.tiers[tier] ?? [];
  if (!Array.isArray(list) || list.some((g) => typeof g !== "string" || !g.length)) {
    cannotRun(`tier "${tier}" is not a list of non-empty strings`);
  }
  try {
    tiers[tier] = list.map((g) => ({ glob: g, test: compileGlob(g) }));
  } catch (e) {
    cannotRun(e.message);
  }
}

// Rules 3 and 4: a paid entry is exactly one tracked file.
for (const tier of ["low", "mid"]) {
  for (const { glob } of tiers[tier]) {
    if (/[*?[\]{}]/.test(glob)) {
      problems.push(`"${tier}" entry \`${glob}\` is a pattern — paid tiers list one tracked file per entry, never a wildcard`);
    } else if (!trackedSet.has(glob)) {
      problems.push(`"${tier}" entry \`${glob}\` is not a file git tracks — a paid entry must name an existing file`);
    }
  }
}

function classify(path) {
  let best = -1;
  let by = null;
  TIER_ORDER.forEach((tier, rank) => {
    const hit = tiers[tier].find(({ test }) => test(path));
    if (hit && rank > best) { best = rank; by = hit.glob; }
  });
  return best < 0 ? { tier: "forbidden", by: "(no pattern)" } : { tier: TIER_ORDER[best], by };
}

// ─── rule 1: the CODEOWNERS files ─────────────────────────────────────────────

// GitHub reads the first of these that exists; a stray copy in another of the
// three places is still a file someone may believe is in force, so read them all.
const owners = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"].filter((p) => existsSync(join(REPO, p)));
if (!owners.length) cannotRun("no CODEOWNERS file found");

const checked = new Map(); // path -> CODEOWNERS line that guards it
let entries = 0;

for (const file of owners) {
  readFileSync(join(REPO, file), "utf8").split("\n").forEach((line, i) => {
    const text = line.trim();
    if (!text || text.startsWith("#")) return;
    // The pattern is the first run of non-space characters, where `\ ` is an
    // escaped space belonging to the pattern rather than the end of it.
    const raw = text.match(/^(?:\\.|[^\s\\])+/)?.[0] ?? "";
    const pattern = raw.replace(/\\(.)/g, "$1");
    const where = `${file}:${i + 1}`;
    // Only the anchored forms this repo uses. Anything else is a form this
    // script would have to guess at, and a guess here is a silent pass.
    if (!pattern.startsWith("/") || /[*?[\]!]/.test(pattern)) {
      problems.push(`${where}: CODEOWNERS pattern \`${raw}\` is in a form this check does not parse — extend the check before using it`);
      return;
    }
    entries += 1;
    const rel = pattern.slice(1).replace(/\/+$/, "");
    const under = tracked.filter((p) => p.startsWith(rel + "/"));
    if (under.length) {
      for (const p of under) checked.set(p, where);
    } else if (!pattern.endsWith("/") && trackedSet.has(rel)) {
      checked.set(rel, where);
    } else {
      problems.push(`${where}: CODEOWNERS pattern \`${raw}\` names no file git tracks — it guards nothing`);
    }
  });
}

for (const [path, where] of checked) {
  const { tier, by } = classify(path);
  if (tier !== "forbidden") {
    problems.push(`${path} is guarded by ${where} but the tier table puts it in "${tier}" (pattern \`${by}\`)`);
  }
}

// ─── rule 2: what forbidden files import ──────────────────────────────────────

const CODE = /^(src|extension)\/.+\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const TEST = /(^|\/)__tests__\/|\.test\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
// Node scripts that build or load a bundle rather than being part of one. Each
// is named here on purpose: a new script that imports a computed path goes red
// and somebody decides, instead of a pattern deciding for them.
const RUNNERS = new Set([
  "extension/smoke/run.mjs", // `import(bundle)` of the freshly built, untracked out/smoke.js
]);
const FILE_SUFFIXES = ["", ".ts", ".tsx", ".d.ts", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"];
const JS_TO_TS = { ".js": [".ts", ".tsx", ".d.ts"], ".jsx": [".tsx"], ".mjs": [".mts", ".d.mts"], ".cjs": [".cts", ".d.cts"] };
const INDEX_NAMES = ["index.ts", "index.tsx", "index.d.ts", "index.mts", "index.cts", "index.js", "index.jsx", "index.mjs", "index.cjs"];
const PKG_FIELDS = ["types", "typings", "module", "main", "browser"];

// Packages: only what package.json declares, or what Node ships.
const declared = new Set();
if (existsSync(join(REPO, "package.json"))) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
  } catch (e) {
    cannotRun(`package.json does not parse (${e.message})`);
  }
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    for (const name of Object.keys(pkg?.[field] ?? {})) declared.add(name);
  }
}
const builtins = new Set(builtinModules);
function packageName(spec) {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}
function isPackage(spec) {
  if (spec.startsWith("node:") || builtins.has(spec) || builtins.has(packageName(spec))) return true;
  return declared.has(packageName(spec));
}

// tsconfig.json `baseUrl` and `paths`: with `baseUrl` set, a bare specifier is
// first looked up as a path, and only then as a package.
let baseUrl = null;
const pathMaps = []; // { prefix, suffix, star, targets }
if (existsSync(join(REPO, "tsconfig.json"))) {
  const cfg = ts.readConfigFile(join(REPO, "tsconfig.json"), (p) => readFileSync(p, "utf8"));
  if (cfg.error) cannotRun(`tsconfig.json does not parse (${ts.flattenDiagnosticMessageText(cfg.error.messageText, " ")})`);
  if (cfg.config?.extends) cannotRun("tsconfig.json uses `extends`, which this check does not follow — extend the check first");
  const opts = cfg.config?.compilerOptions ?? {};
  if (typeof opts.baseUrl === "string") baseUrl = posix.normalize(opts.baseUrl).replace(/^\.\/?$/, "");
  const pathsBase = baseUrl ?? "";
  for (const [key, targets] of Object.entries(opts.paths ?? {})) {
    const star = key.indexOf("*");
    pathMaps.push({
      prefix: star < 0 ? key : key.slice(0, star),
      suffix: star < 0 ? "" : key.slice(star + 1),
      star: star >= 0,
      targets: targets.map((t) => posix.join(pathsBase, t)),
    });
  }
}

/** Candidate repository paths a bare specifier maps to through tsconfig. */
function viaTsconfig(spec) {
  const out = [];
  for (const m of pathMaps) {
    if (m.star) {
      if (spec.startsWith(m.prefix) && spec.endsWith(m.suffix) && spec.length >= m.prefix.length + m.suffix.length) {
        const mid = spec.slice(m.prefix.length, spec.length - m.suffix.length);
        for (const t of m.targets) out.push(posix.normalize(t.replace("*", mid)));
      }
    } else if (spec === m.prefix) {
      for (const t of m.targets) out.push(posix.normalize(t));
    }
  }
  if (baseUrl !== null) out.push(posix.normalize(posix.join(baseUrl, spec)));
  return out;
}

/**
 * Tracked files `base` (a repository path, no extension needed) stands for.
 * Every candidate a bundler might pick is returned. With `dirOk`, a directory
 * is a plain path and stands for no file.
 */
function resolveBase(base, dirOk, depth = 0) {
  if (base.startsWith("../") || base === "..") return null;
  const hits = new Set();
  for (const s of FILE_SUFFIXES) if (trackedSet.has(base + s)) hits.add(base + s);
  const ext = Object.keys(JS_TO_TS).find((e) => base.endsWith(e));
  if (ext) for (const t of JS_TO_TS[ext]) if (trackedSet.has(base.slice(0, -ext.length) + t)) hits.add(base.slice(0, -ext.length) + t);
  const dir = base.replace(/\/+$/, "");
  if (isTrackedDir(dir)) {
    if (dirOk) return hits.size ? [...hits] : [];
    const pkgPath = posix.join(dir, "package.json");
    if (trackedSet.has(pkgPath) && depth < 4) {
      hits.add(pkgPath);
      let pkg = null;
      try { pkg = JSON.parse(readFileSync(join(REPO, pkgPath), "utf8")); } catch { /* reported below */ }
      if (!pkg || typeof pkg !== "object") return null;
      for (const f of PKG_FIELDS) {
        if (typeof pkg[f] !== "string") continue;
        const sub = resolveBase(posix.normalize(posix.join(dir, pkg[f])), false, depth + 1);
        if (sub) for (const t of sub) hits.add(t);
      }
    }
    for (const n of INDEX_NAMES) if (trackedSet.has(posix.join(dir, n))) hits.add(posix.join(dir, n));
    // A directory whose package.json leads nowhere and has no index is not a
    // module the toolchain can load; report it rather than calling it resolved.
    if (hits.size === 1 && hits.has(pkgPath)) return null;
  }
  return hits.size ? [...hits] : null;
}

/**
 * Resolves `spec` imported from `from`: an array of tracked files (empty for a
 * package or a plain directory path), or null when it reaches nothing it may.
 */
function resolveSpecifier(from, spec, dirOk) {
  const clean = spec.replace(/[?#].*$/, "");
  if (!clean) return null;
  if (clean.startsWith("./") || clean.startsWith("../") || clean === "." || clean === "..") {
    return resolveBase(posix.normalize(posix.join(posix.dirname(from), clean)), dirOk);
  }
  if (clean.startsWith("/")) return resolveBase(posix.normalize(clean.slice(1)), dirOk);
  if (clean.startsWith("@/")) return resolveBase(posix.normalize("src/" + clean.slice(2)), dirOk);
  const found = new Set();
  for (const cand of viaTsconfig(clean)) {
    const r = resolveBase(cand, dirOk);
    if (r) for (const t of r) found.add(t);
  }
  if (found.size) return [...found];
  return isPackage(clean) ? [] : null;
}

/** Tracked files an `import.meta.glob` pattern matches, or null if it cannot be read. */
function resolveGlob(from, pattern) {
  if (pattern.startsWith("!")) return []; // an exclusion only removes files
  if (/[[\]{}]/.test(pattern)) return null;
  let full;
  if (pattern.startsWith("./") || pattern.startsWith("../")) full = posix.normalize(posix.join(posix.dirname(from), pattern));
  else if (pattern.startsWith("/")) full = posix.normalize(pattern.slice(1));
  else if (pattern.startsWith("@/")) full = posix.normalize("src/" + pattern.slice(2));
  else return null;
  if (full.startsWith("../")) return null;
  let test;
  try { test = compileGlob(full); } catch { return null; }
  return tracked.filter((p) => test(p));
}

const unwrap = (n) => {
  while (n && (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isTypeAssertionExpression(n) ||
    ts.isNonNullExpression(n) || (ts.isSatisfiesExpression && ts.isSatisfiesExpression(n)))) n = n.expression;
  return n;
};
const isImportMeta = (n) => {
  n = unwrap(n);
  return !!n && ts.isMetaProperty(n) && n.keywordToken === ts.SyntaxKind.ImportKeyword && n.name.text === "meta";
};
const constString = (n) => {
  n = unwrap(n);
  return n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : null;
};
/** `import.meta.glob(...)`, `import.meta["glob"](...)`, `(import.meta as any).globEager(...)`. */
function globCallee(expr) {
  expr = unwrap(expr);
  if (ts.isPropertyAccessExpression(expr) && isImportMeta(expr.expression)) return expr.name.text.startsWith("glob");
  if (ts.isElementAccessExpression(expr) && isImportMeta(expr.expression)) {
    const key = constString(expr.argumentExpression);
    return key === null ? true : key.startsWith("glob");
  }
  return false;
}

function scriptKind(file) {
  if (/\.tsx$/.test(file)) return ts.ScriptKind.TSX;
  if (/\.jsx$/.test(file)) return ts.ScriptKind.JSX;
  if (/\.(js|mjs|cjs)$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** Every module reference in `file`, as `{ spec, dirOk }` or `{ glob }`; unreadable ones go to `problems`. */
function references(file, source) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind(file));
  const out = [];
  if (sf.parseDiagnostics?.length) {
    problems.push(`${file} does not parse (${ts.flattenDiagnosticMessageText(sf.parseDiagnostics[0].messageText, " ")}) — the dependency check cannot read it`);
    return out;
  }
  for (const ref of sf.referencedFiles) out.push({ spec: ref.fileName.startsWith(".") ? ref.fileName : "./" + ref.fileName });
  const where = (n) => `${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  const visit = (n) => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier) {
      const s = constString(n.moduleSpecifier);
      if (s === null) problems.push(`${where(n)}: module specifier is not a constant string`);
      else out.push({ spec: s });
    } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) {
      const s = constString(n.moduleReference.expression);
      if (s === null) problems.push(`${where(n)}: \`require\` of something that is not a constant string — the dependency check cannot follow it`);
      else out.push({ spec: s });
    } else if (ts.isImportTypeNode(n)) {
      const lit = ts.isLiteralTypeNode(n.argument) ? constString(n.argument.literal) : null;
      if (lit === null) problems.push(`${where(n)}: \`import()\` type of something that is not a constant string`);
      else out.push({ spec: lit });
    } else if (ts.isCallExpression(n)) {
      const callee = unwrap(n.expression);
      const kind = n.expression.kind === ts.SyntaxKind.ImportKeyword ? "import"
        : ts.isIdentifier(callee) && callee.text === "require" ? "require"
        : globCallee(n.expression) ? "import.meta.glob"
        : null;
      if (kind === "import.meta.glob") {
        const arg = n.arguments[0] && unwrap(n.arguments[0]);
        const list = arg && ts.isArrayLiteralExpression(arg) ? arg.elements.map(constString) : [arg ? constString(arg) : null];
        if (!list.length || list.some((s) => s === null)) {
          problems.push(`${where(n)}: \`import.meta.glob\` of something that is not a constant string — the dependency check cannot follow it`);
        } else {
          for (const g of list) out.push({ glob: g });
        }
      } else if (kind) {
        const s = n.arguments.length ? constString(n.arguments[0]) : null;
        if (s === null) problems.push(`${where(n)}: \`${kind}(…)\` of something that is not a constant string — the dependency check cannot follow it`);
        else out.push({ spec: s });
      }
    } else if (ts.isNewExpression(n)) {
      const callee = unwrap(n.expression);
      const args = n.arguments ?? [];
      if (ts.isIdentifier(callee) && callee.text === "URL" && args.length >= 2) {
        const second = unwrap(args[1]);
        const s = constString(args[0]);
        if (s !== null && ts.isPropertyAccessExpression(second) && second.name.text === "url" && isImportMeta(second.expression)) {
          out.push({ spec: s, dirOk: true });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

// Test files and the runners above are read neither as importers nor as
// importees here (see rule 2); how many is printed with the result.
const code = tracked.filter((p) => CODE.test(p) && !TEST.test(p) && !RUNNERS.has(p));
const leftOut = tracked.filter((p) => CODE.test(p) && (TEST.test(p) || RUNNERS.has(p))).length;
const deps = new Map();
let edges = 0;
for (const file of code) {
  const source = readFileSync(join(REPO, file), "utf8");
  const out = new Set();
  for (const ref of references(file, source)) {
    if (ref.glob !== undefined) {
      const hits = resolveGlob(file, ref.glob);
      if (hits === null) problems.push(`${file} globs \`${ref.glob}\`, a pattern the dependency check cannot read`);
      else for (const t of hits) out.add(t);
      continue;
    }
    const targets = resolveSpecifier(file, ref.spec, !!ref.dirOk);
    if (targets === null) {
      problems.push(`${file} imports \`${ref.spec}\`, which resolves to no tracked file and no declared package — the dependency check cannot follow it`);
    } else {
      for (const t of targets) if (t !== file) out.add(t);
    }
  }
  edges += out.size;
  deps.set(file, [...out]);
}

const seeds = code.filter((p) => classify(p).tier === "forbidden");
const via = new Map(); // reached file -> the file that imported it on the first path found
const queue = [];
for (const s of seeds) { via.set(s, null); queue.push(s); }
while (queue.length) {
  const file = queue.shift();
  for (const dep of deps.get(file) ?? []) {
    if (via.has(dep)) continue;
    via.set(dep, file);
    queue.push(dep);
  }
}
for (const [file] of via) {
  const { tier } = classify(file);
  if (tier === "forbidden") continue;
  const chain = [file];
  for (let at = via.get(file); at; at = via.get(at)) chain.push(at);
  problems.push(`${file} is "${tier}" but a forbidden file depends on it: ${chain.reverse().join(" → ")}`);
}

if (problems.length) {
  console.error("Tier/CODEOWNERS check FAILED:");
  for (const p of problems) console.error("  • " + p);
  process.exit(1);
}

console.log(
  `Tier/CODEOWNERS OK — ${entries} CODEOWNERS entries, ${checked.size} guarded files, ` +
    `${seeds.length} forbidden source files and ${edges} import edges followed ` +
    `(${leftOut} test and runner files left out of the graph), all forbidden in docs/contribution-tiers.json`,
);
