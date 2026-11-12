/**
 * Every path CODEOWNERS guards must be `forbidden` in docs/contribution-tiers.json.
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
 * A guarded directory is checked twice: every tracked file under it, and one
 * file that does not exist yet. The second probe is what catches a directory
 * wildcard in `mid` — a new file is where a wildcard does its damage, and no
 * tracked file would show it.
 *
 * The glob matcher below follows the dialect the table declares (only `*`, `**`
 * and `?`, anchored at both ends, `**` as a whole segment). A pattern outside
 * that dialect, or a CODEOWNERS line in a form this script does not parse, fails
 * the check rather than being skipped: a gate that cannot read its input must
 * not report that the input is fine.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const TIER_ORDER = ["low", "mid", "forbidden"];
const PROBE_NAME = "__new_file_probe__.ts";
const problems = [];

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

// ─── the tier table ───────────────────────────────────────────────────────────

const table = JSON.parse(readFileSync(join(REPO, "docs", "contribution-tiers.json"), "utf8"));
const tiers = {};
for (const tier of TIER_ORDER) {
  const list = table?.tiers?.[tier] ?? [];
  if (!Array.isArray(list)) {
    console.error(`Tier/CODEOWNERS check could not run: tier "${tier}" is not a list`);
    process.exit(2);
  }
  try {
    tiers[tier] = list.map((g) => ({ glob: g, test: compileGlob(g) }));
  } catch (e) {
    console.error(`Tier/CODEOWNERS check could not run: ${e.message}`);
    process.exit(2);
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

// ─── the CODEOWNERS files ─────────────────────────────────────────────────────

// GitHub reads the first of these that exists; a stray copy in another of the
// three places is still a file someone may believe is in force, so read them all.
const owners = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"].filter((p) => existsSync(join(REPO, p)));
if (!owners.length) {
  console.error("Tier/CODEOWNERS check could not run: no CODEOWNERS file found");
  process.exit(2);
}

const tracked = execFileSync("git", ["-C", REPO, "ls-files"], { encoding: "utf8" }).trim().split("\n");
const checked = new Map(); // path -> CODEOWNERS line that guards it
let entries = 0;

for (const file of owners) {
  readFileSync(join(REPO, file), "utf8").split("\n").forEach((line, i) => {
    const text = line.trim();
    if (!text || text.startsWith("#")) return;
    const pattern = text.split(/\s+/)[0];
    const where = `${file}:${i + 1}`;
    // Only the anchored forms this repo uses. Anything else is a form this
    // script would have to guess at, and a guess here is a silent pass.
    if (!pattern.startsWith("/") || /[*?[\]!]/.test(pattern)) {
      problems.push(`${where}: CODEOWNERS pattern \`${pattern}\` is in a form this check does not parse — extend the check before using it`);
      return;
    }
    entries += 1;
    const rel = pattern.slice(1);
    if (rel.endsWith("/")) {
      const under = tracked.filter((p) => p.startsWith(rel));
      for (const p of under) checked.set(p, where);
      checked.set(rel + PROBE_NAME, where);
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

if (problems.length) {
  console.error("Tier/CODEOWNERS check FAILED:");
  for (const p of problems) console.error("  • " + p);
  process.exit(1);
}

console.log(
  `Tier/CODEOWNERS OK — ${entries} CODEOWNERS entries, ${checked.size - probes} guarded files and ` +
    `${probes} new-file probes, all forbidden in docs/contribution-tiers.json`,
);
