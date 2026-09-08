/**
 * Mutation runs for the guards that decide what a wallet screen may claim.
 *
 * Why this file exists rather than a sentence in a commit message: "each guard
 * was re-broken and the tests went red" is a claim about work nobody else can
 * repeat. It ages into folklore — the guard gets refactored, the test that was
 * supposedly pinning it stops pinning anything, and the sentence stays true-
 * sounding. A list of exact edits, runnable on demand, is the difference
 * between a claim and evidence.
 *
 * It also answers a sharper question than "do the tests pass". A red test at a
 * guard does not prove that test pins the guard: the case can slide past the
 * line it names and die at the *next* one, printing the right colour for the
 * wrong reason. Deleting the guard and watching a specific test go red is the
 * measurement that distinguishes those.
 *
 * Deliberately NOT named `check:*` and NOT run in CI. Each mutation is a full
 * test run, and a gate slow enough to be skipped is a gate that gets skipped.
 * Run it when touching one of these guards:
 *
 *     node scripts/mutants.mjs
 *
 * A mutation that stays GREEN is the finding. It means the guard on that line
 * can be removed without a single test objecting.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const HISTORY = "src/lib/cardano/history.ts";
const PRICE = "src/lib/cardano/price.ts";
const TESTS = [
  "src/lib/cardano/__tests__/history.test.ts",
  "src/lib/cardano/__tests__/price.test.ts",
];

/**
 * Each entry deletes or reverts exactly one guard. `from` must appear once —
 * if a refactor moves the code, this file fails loudly rather than quietly
 * measuring nothing, which is the failure mode it was written to prevent.
 */
const MUTANTS = [
  {
    name: "withdrawal ownership filter removed (a stranger's reward counts as ours)",
    file: HISTORY,
    from: "    if (ownStakeAddresses.has(stake)) withdrawn += amount;",
    to: "    withdrawn += amount;",
  },
  {
    name: "an unattributable row shows an amount anyway",
    file: HISTORY,
    from:
      "  if (entry.unattributed !== null) return { show: false, reason: entry.unattributed };",
    to: "",
  },
  {
    name: "a withdrawal with no owner named on it is accepted",
    file: HISTORY,
    from: '      bad("this transaction withdraws rewards this wallet cannot attribute");',
    to: "      continue;",
  },
  {
    name: "a mint by any party counts as ours",
    file: HISTORY,
    from:
      '  const minted = touchedUs && net.some((n) => n.unit !== "" && mintedUnits.has(n.unit));',
    to: "  const minted = (row.assets_minted ?? []).length > 0;",
  },
  {
    name: "a burn counts as a mint",
    file: HISTORY,
    from: '      .filter((a) => asBigInt(a.quantity ?? 0, "a minted amount") > BigInt(0))\n',
    to: "",
  },
  {
    name: "a certificate by any party counts as our delegation",
    file: HISTORY,
    from: "  const delegated = (row.certificates ?? []).some((c) => {",
    to: "  const delegated = (row.certificates ?? []).length > 0 || [].some((c) => {",
  },
  {
    name: "the fee is always reported as ours",
    file: HISTORY,
    from: "    feePaidByUs: touchedUs,",
    to: "    feePaidByUs: true,",
  },
  {
    name: "a missing timestamp is padded to zero (prints 1/1/1970)",
    file: HISTORY,
    from: '    timeMs: Number(asBigInt(row.tx_timestamp, "a timestamp")) * 1000,',
    to: '    timeMs: Number(asBigInt(row.tx_timestamp ?? 0, "a timestamp")) * 1000,',
  },
  {
    name: "a missing block height is padded to zero (prints Block 0)",
    file: HISTORY,
    from: '    blockHeight: Number(asBigInt(row.block_height, "a block height")),',
    to: '    blockHeight: Number(asBigInt(row.block_height ?? 0, "a block height")),',
  },
  {
    name: "an asset whose policy id is not a policy id is accepted",
    file: HISTORY,
    from: "  if (!/^[0-9a-f]{56}$/i.test(policyId)) {",
    to: "  if (false) {",
  },
  {
    name: "a clock that went backwards keeps serving the cached rate",
    file: PRICE,
    from: "    if (age >= 0 && age < TTL_MS) return cached;",
    to: "    if (age < TTL_MS) return cached;",
  },
];

const read = (rel) => readFileSync(join(REPO, rel), "utf8");
const write = (rel, text) => writeFileSync(join(REPO, rel), text);

const runTests = () =>
  spawnSync("npx", ["vitest", "run", ...TESTS], { cwd: REPO, encoding: "utf8" }).status ?? 1;

const originals = new Map();
for (const m of MUTANTS) if (!originals.has(m.file)) originals.set(m.file, read(m.file));
const restoreAll = () => {
  for (const [rel, text] of originals) write(rel, text);
};
// A mutation left in place is a corrupted working tree, so restore on the way
// out however this process ends.
process.on("SIGINT", () => {
  restoreAll();
  process.exit(130);
});

let survived = 0;
let unanchored = 0;

try {
  // Refuse to grade anything if the tree is already red: every mutation would
  // read as "caught" for a reason that has nothing to do with the mutation.
  if (runTests() !== 0) {
    console.error("Baseline is already failing — fix that first; mutation results\n" +
      "measured against a red baseline mean nothing.");
    process.exit(1);
  }

  for (const m of MUTANTS) {
    const src = originals.get(m.file);
    const hits = src.split(m.from).length - 1;
    if (hits !== 1) {
      console.error(`  ANCHOR  ← ${m.name}\n          (matched ${hits}× in ${m.file}; expected 1)`);
      unanchored += 1;
      continue;
    }
    write(m.file, src.replace(m.from, m.to));
    const caught = runTests() !== 0;
    write(m.file, src);
    console.log(`  ${caught ? "RED   " : "GREEN "}  ← ${m.name}`);
    if (!caught) survived += 1;
  }
} finally {
  restoreAll();
}

const bad = survived + unanchored;
console.log(
  `\n${MUTANTS.length - bad}/${MUTANTS.length} guards pinned` +
    (survived ? ` · ${survived} removable with every test still green` : "") +
    (unanchored ? ` · ${unanchored} anchor(s) no longer match the source` : ""),
);
process.exit(bad === 0 ? 0 : 1);
