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
const SEND = "src/components/wallet/SendPanel.tsx";
const STAKING = "src/components/wallet/StakingPanel.tsx";
const GOV = "src/components/wallet/GovernancePanel.tsx";
const TABS = "src/components/wallet/WalletTabs.tsx";
const PROVIDER = "src/lib/cardano/provider.ts";
const BLOCKFROST = "src/lib/cardano/blockfrost.ts";
const TESTS = [
  "src/lib/cardano/__tests__/history.test.ts",
  "src/lib/cardano/__tests__/price.test.ts",
  "src/components/wallet/__tests__/moneyNotice.test.ts",
  "src/components/wallet/__tests__/uncertainStore.test.ts",
  "src/lib/cardano/submitError.test.ts",
  "src/lib/keystore/__tests__/keystore.test.ts",
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

  // ── The lock on an unresolved submit ──────────────────────────────────────
  //
  // One transaction was signed and handed to the network with no reply. Sending
  // again is how the same amount leaves twice, so every money screen refuses
  // until the reader says they have checked. Each entry below is a way that
  // refusal has actually been broken, or was found to be breakable, while the
  // whole suite stayed green.

  {
    // The shape that survived the first attempt at a gate: the gate matched a
    // *string* in the function text. Dropping `return` is what a linter
    // suggests for a returned void expression, and what someone writing the
    // `if` by hand forgets. After it, Confirm shows the warning and then signs.
    name: "the Send refusal warns and falls through (the `return` dropped)",
    file: SEND,
    from: '    if (uncertainHash !== null) return toastError(t("uncertain_blocked"));',
    to: '    if (uncertainHash !== null) toastError(t("uncertain_blocked"));',
  },
  {
    name: "the delegate refusal warns and falls through",
    file: STAKING,
    from: '    if (uncertainHash !== null) return toastError(t("uncertain_blocked"));\n    setBusy(true);\n    try {\n      const hash = await port.signAndSubmit(poolReview.built, network);',
    to: '    if (uncertainHash !== null) toastError(t("uncertain_blocked"));\n    setBusy(true);\n    try {\n      const hash = await port.signAndSubmit(poolReview.built, network);',
  },
  {
    name: "the withdraw refusal is removed (the second door on one screen)",
    file: STAKING,
    from: '    if (!withdrawReview) return;\n    if (uncertainHash !== null) return toastError(t("uncertain_blocked"));',
    to: "    if (!withdrawReview) return;",
  },
  {
    name: "the governance refusal warns and falls through",
    file: GOV,
    from: '    if (uncertainHash !== null) return toastError(t("uncertain_blocked"));\n    setBusy(true);',
    to: '    if (uncertainHash !== null) toastError(t("uncertain_blocked"));\n    setBusy(true);',
  },
  {
    // The notice's body tells the reader to go look the hash up. Putting it
    // back inside a tab condition means following that instruction destroys it.
    name: "the notice goes back inside a tab condition",
    file: TABS,
    from: "      {uncertainHash !== null && (",
    to: '      {activeTab === "send" && uncertainHash !== null && (',
  },
  {
    // React state dies on idle-lock, which is five minutes, which is about how
    // long looking a transaction up takes.
    name: "the lock is no longer written down (memory only again)",
    file: TABS,
    from: "    writeLock(store, network, changeAddress, txHash);\n",
    to: "",
  },
  {
    name: "the lock is never read back on mount",
    file: TABS,
    from: "  const [uncertainHash, setUncertainHash] = useState<string | null>(() =>\n    readLock(store, network, changeAddress),\n  );",
    to: "  const [uncertainHash, setUncertainHash] = useState<string | null>(null);",
  },
  {
    // Both submit doors must report a refusal as a TYPE. A plain Error sends a
    // definitively-rejected transaction down the "unknown" path, which locks
    // every money screen and asks for a hash that exists nowhere.
    name: "the Koios door reports a rejection as a plain Error again",
    file: PROVIDER,
    from: 'if (!res.ok) throw new SubmitRejectedError(res.status, text.slice(0, 300), "Koios /submittx");',
    to: "if (!res.ok) throw new Error(`Koios /submittx → HTTP ${res.status}: ${text.slice(0, 300)}`);",
  },
  {
    name: "the Blockfrost-shaped door reports a rejection as a plain Error again",
    file: BLOCKFROST,
    from: '    throw new SubmitRejectedError(res.status, text.slice(0, 300), "Chain endpoint /tx/submit");',
    to: "    throw new Error(`Chain endpoint /tx/submit → HTTP ${res.status}: ${text.slice(0, 300)}`);",
  },
  {
    name: "a 5xx counts as the node saying no (invites a second payment)",
    file: "src/lib/cardano/submitError.ts",
    from: "  return err instanceof SubmitRejectedError && err.status >= 400 && err.status < 500;",
    to: "  return err instanceof SubmitRejectedError;",
  },
];

/**
 * Known survivors, and why they are allowed to survive.
 *
 * Not skipped — they run, and the run reports them. Written down because an
 * unstated gap is the kind that gets rediscovered as a defect:
 *
 *   - `SendPanel`'s `canBuild` dropping `uncertainHash === null &&`
 *   - `GovernancePanel.review()`'s guard turned into `if (false)`
 *
 * Both are second doors: the spend itself is refused inside the function that
 * calls `signAndSubmit`, and removing THAT is caught on all four paths above.
 * Pinning these would need a gate naming one function in one file, which then
 * goes red on any honest rename — the kind of watcher that gets deleted rather
 * than fixed.
 */

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
