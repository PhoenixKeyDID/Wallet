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
 * 1. **Guarded paths.** Every tracked file under a guarded directory, and one
 *    file that does not exist yet in it, classifies as `forbidden`. Whether a
 *    CODEOWNERS line names a directory is read from `git ls-files` (some tracked
 *    file sits under it), not from a trailing `/`: GitHub guards `/locales` and
 *    `/locales/` alike, and reading the first as a single file dropped seven
 *    guarded files without a word.
 *
 * 2. **Dependencies.** A `low` or `mid` file that a `forbidden` file imports,
 *    directly or through other files, fails. The second version of the table
 *    listed `TestnetBadge.tsx` as `mid` while the guarded `LocalWalletPanel.tsx`
 *    imported it: a paid change deleting the badge's mainnet guard was a change
 *    to the guarded screen, shipped in the extension popup, with no guarded file
 *    in the diff. The graph is read statically from `src/` and `extension/`
 *    (`import … from`, `export … from`, bare `import "…"`, `import("…")`,
 *    `new URL("…", import.meta.url)`), with `@/` resolved to `src/`. Test files
 *    are left out of the graph: a test that imports a file pins it, it does not
 *    give it a path into a running wallet (and test files are `forbidden`
 *    themselves). A relative or `@/` specifier that resolves to no tracked file
 *    fails the check rather than being skipped.
 *
 * 3. **No wildcards in paid tiers.** A `low` or `mid` entry is one tracked file,
 *    named exactly. A pattern there (`*`, `?`, `[`, `{`) fails: a wildcard is
 *    where a new file inherits a tier nobody chose for it, and the new-file probe
 *    in rule 1 only tries one name, so it cannot be the thing that catches it.
 *
 * 4. **Paid entries exist.** An entry naming a file git does not track fails —
 *    a typo there is a file left in `forbidden` while the table says otherwise.
 *
 * The glob matcher below follows the dialect the table declares (only `*`, `**`
 * and `?`, anchored at both ends, `**` as a whole segment). A pattern outside
 * that dialect, or a CODEOWNERS line in a form this script does not parse, fails
 * the check rather than being skipped: a gate that cannot read its input must
 * not report that the input is fine.
 *
 * Usage: `node scripts/check-tiers-codeowners.mjs [repo-root]` — the root
 * defaults to the repository this script lives in; the tests pass a scratch one.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, posix, resolve } from "node:path";

const REPO = process.argv[2] ? resolve(process.argv[2]) : join(dirname(fileURLToPath(import.meta.url)), "..");
const TIER_ORDER = ["low", "mid", "forbidden"];
const PROBE_NAME = "__new_file_probe__.ts";
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

function compileGlob(pattern) {
  if (typeof pattern !== "string" || !pattern.length) throw new Error("empty glob");
  if (/[[\]{}]/.test(pattern) || pattern.startsWith("!") || pattern.startsWith("/")) {
    throw new Error(`glob "${pattern}" is outside the declared dialect`);
  }
  const segs = pattern.split("/");
  for (const seg of segs) {
    if (seg !== "**" && seg.includes("**")) throw new Error(`glob "${pattern}": "**" must be a whole segment`);
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

// ─── the tier table ───────────────────────────────────────────────────────────

const tablePath = join(REPO, "docs", "contribution-tiers.json");
if (!existsSync(tablePath)) cannotRun("docs/contribution-tiers.json not found");
let table;
try {
  table = JSON.parse(readFileSync(tablePath, "utf8"));
} catch (e) {
  cannotRun(`docs/contribution-tiers.json does not parse (${e.message})`);
}
const tiers = {};
for (const tier of TIER_ORDER) {
  const list = table?.tiers?.[tier] ?? [];
  if (!Array.isArray(list)) cannotRun(`tier "${tier}" is not a list`);
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
    const isDir = under.length > 0 || pattern.endsWith("/");
    if (isDir) {
      for (const p of under) checked.set(p, where);
      checked.set(rel + "/" + PROBE_NAME, where);
    } else {
      checked.set(rel, where);
    }
  });
}

let probes = 0;
for (const [path, where] of checked) {
  if (path.endsWith(PROBE_NAME)) probes += 1;
  const { tier, by } = classify(path);
  if (tier !== "forbidden") {
    problems.push(`${path} is guarded by ${where} but the tier table puts it in "${tier}" (pattern \`${by}\`)`);
  }
}

// ─── rule 2: what forbidden files import ──────────────────────────────────────

const CODE = /^(src|extension)\/.+\.(ts|tsx|js|mjs)$/;
const TEST = /(^|\/)__tests__\/|\.test\.(ts|tsx|js|mjs)$/;
const SPECIFIER = [
  /\b(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\s+from\s+)?["']([^"'\n]+)["']/g,
  /\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
  /\bnew\s+URL\s*\(\s*["']([^"'\n]+)["']\s*,\s*import\.meta\.url\s*\)/g,
];
const SUFFIXES = ["", ".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.tsx", "/index.js"];

function resolveSpecifier(from, spec) {
  let base;
  if (spec.startsWith("@/")) base = "src/" + spec.slice(2);
  else if (spec.startsWith("./") || spec.startsWith("../")) base = posix.normalize(posix.join(posix.dirname(from), spec));
  else return null; // a package
  base = base.replace(/\?.*$/, "");
  const stems = [base];
  if (/\.(js|mjs)$/.test(base)) stems.push(base.replace(/\.(js|mjs)$/, ""));
  for (const stem of stems) {
    for (const suffix of SUFFIXES) if (trackedSet.has(stem + suffix)) return stem + suffix;
  }
  // `new URL("../..", import.meta.url)` may name a directory; that is a path,
  // not a module, and carries no code into the importer.
  const dir = base.replace(/\/+$/, "") + "/";
  if (tracked.some((p) => p.startsWith(dir))) return null;
  return undefined;
}

// Test files are read neither as importers nor as importees here (see rule 2).
const code = tracked.filter((p) => CODE.test(p) && !TEST.test(p));
const deps = new Map();
let edges = 0;
for (const file of code) {
  const source = readFileSync(join(REPO, file), "utf8");
  const out = new Set();
  for (const re of SPECIFIER) {
    for (const m of source.matchAll(re)) {
      const target = resolveSpecifier(file, m[1]);
      if (target === undefined) {
        problems.push(`${file} imports \`${m[1]}\`, which resolves to no tracked file — the dependency check cannot follow it`);
      } else if (target) {
        out.add(target);
      }
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
  `Tier/CODEOWNERS OK — ${entries} CODEOWNERS entries, ${checked.size - probes} guarded files and ` +
    `${probes} new-file probes, ${seeds.length} forbidden source files and ${edges} import edges followed, ` +
    `all forbidden in docs/contribution-tiers.json`,
);
