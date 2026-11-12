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
 *     node scripts/mutants.mjs "signer:"   # only mutants whose name contains this
 *
 * A mutation that stays GREEN is the finding. It means the guard on that line
 * can be removed without a single test objecting.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { classifyRun } from "./lib/classify-run.mjs";
import { createTypechecker } from "./lib/typecheck-mutant.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const HISTORY = "src/lib/cardano/history.ts";
const PRICE = "src/lib/cardano/price.ts";
const SEND = "src/components/wallet/SendPanel.tsx";
const STAKING = "src/components/wallet/StakingPanel.tsx";
const GOV = "src/components/wallet/GovernancePanel.tsx";
const TABS = "src/components/wallet/WalletTabs.tsx";
const PROVIDER = "src/lib/cardano/provider.ts";
const BLOCKFROST = "src/lib/cardano/blockfrost.ts";
const TX_SUMMARY = "src/lib/cardano/txSummary.ts";
// The two screens where a token name is the last thing read before signing.
// Their helpers were pinned long before the screens were: reverting a screen
// to the bare name left every helper test green until these were rendered.
const REVIEW_OUTPUT = "src/components/wallet/ReviewOutput.tsx";
const TX_SUMMARY_VIEW = "extension/src/TxSummaryView.tsx";
const STORE = "src/components/wallet/uncertainStore.ts";
// Round six: the store-readiness work. A phrase on the clipboard, the web
// page's sentences inside the extension, and the stylesheet gate.
const SEED_STEP = "src/components/wallet/SeedPhraseStep.tsx";
const PANEL = "src/components/wallet/LocalWalletPanel.tsx";
const TESTNET_BADGE = "src/components/wallet/TestnetBadge.tsx";
const CSS_GATE = "scripts/check-popup-css.mjs";
const LOCALES_GATE = "scripts/check-locales.mjs";
const BALANCE = "src/components/wallet/BalanceView.tsx";
const POPUP_CSS = "extension/src/popup.css";
const COPY_BTN = "src/components/CopyBtn.tsx";
const WALLET_HUB = "src/components/wallet/WalletHub.tsx";
// The copy-button guard's own lists, which a mutant edits the way an author
// would to make a new component look declared.
const COPY_GUARD_TEST = "src/components/wallet/__tests__/SeedPhraseStep.test.tsx";
const COPYABLE_ANCHOR = '    "src/components/wallet/WatchOnlyPanel.tsx#WatchOnlyPanel: watched",';
const FORWARDS_ANCHOR = '    "src/components/wallet/WalletTabs.tsx#WalletTabs: port",\n  ];';
const PENDING = "extension/background/pending.ts";
const SIGN_FOREIGN = "src/lib/keystore/signForeign.ts";
const UTXO_CBOR = "src/lib/cardano/utxoCbor.ts";
const APPROVE = "extension/src/approve.tsx";
const UTXO_SELECT = "src/lib/cardano/utxoSelect.ts";
const SIGN_DATA = "src/lib/keystore/signData.ts";
const WORKER = "extension/background/worker.ts";
const DATA_SIGN_VIEW = "extension/src/DataSignView.tsx";
// The one rule for which outputs at the wallet's addresses are its own money,
// and the CIP-30 path that reads UTxOs back from another wallet.
const OWN_UTXO = "src/lib/cardano/ownUtxo.ts";
const TX = "src/lib/cardano/tx.ts";
// A gate is worth mutating too. "Is this guard pinned" and "is the thing that
// checks the guard pinned" are different questions, and the second one has gone
// unanswered here before: two table rows named after a detector were going red
// because a *count* elsewhere fell, not because the detector did its job.
const NOTICE_TEST = "src/components/wallet/__tests__/moneyNotice.test.ts";
const CLASSIFY_RUN = "scripts/lib/classify-run.mjs";
// The packaging gate and the build step for the two scripts that run inside a
// website. Both went wrong together once: the build emitted ES modules, the
// gate allowed exactly that import, and Chrome refused the file.
const PKG_GATE = "scripts/check-extension-package.mjs";
const EXT_VITE = "extension/vite.config.ts";
const TESTS = [
  "src/lib/cardano/__tests__/history.test.ts",
  "src/lib/cardano/__tests__/price.test.ts",
  "src/components/wallet/__tests__/moneyNotice.test.ts",
  "src/components/wallet/__tests__/uncertainStore.test.ts",
  "src/lib/cardano/submitError.test.ts",
  "src/lib/keystore/__tests__/keystore.test.ts",
  "src/lib/cardano/__tests__/txSummary.test.ts",
  "src/components/wallet/__tests__/ReviewOutput.test.tsx",
  "extension/src/__tests__/TxSummaryView.test.tsx",
  "src/components/wallet/__tests__/SeedPhraseStep.test.tsx",
  "src/components/wallet/__tests__/LocalWalletPanel.context.test.tsx",
  "scripts/__tests__/checkPopupCss.test.ts",
  "scripts/__tests__/checkLocales.test.ts",
  "extension/background/__tests__/pending.test.ts",
  "src/lib/keystore/__tests__/foreignTxAttack.test.ts",
  "src/lib/cardano/__tests__/utxoCbor.test.ts",
  "src/lib/keystore/__tests__/extensionApprove.test.tsx",
  "src/lib/keystore/__tests__/dripPotClaim.test.ts",
  "src/lib/keystore/__tests__/signData.test.ts",
  "src/lib/cardano/__tests__/utxoSelect.test.ts",
  "src/lib/cardano/__tests__/ownUtxo.test.ts",
  "src/lib/cardano/__tests__/blockfrost.test.ts",
  "src/lib/cardano/__tests__/e2e-journey.test.ts",
  "src/lib/keystore/__tests__/signForeign.test.ts",
  "extension/background/__tests__/worker.test.ts",
  "extension/src/__tests__/DataSignView.test.tsx",
  "scripts/__tests__/classifyRun.test.ts",
  "scripts/__tests__/checkExtensionPackage.test.ts",
  "extension/pageWorldBuild.test.ts",
];

/**
 * Each entry deletes or reverts exactly one guard. `from` must appear once —
 * if a refactor moves the code, this file fails loudly rather than quietly
 * measuring nothing, which is the failure mode it was written to prevent.
 */
const MUTANTS = [
  // ── The page-world scripts must load in a real browser: a content script and
  // a `<script src>` are classic scripts, so neither may import anything ──
  {
    name: "page-world: the package gate no longer compiles content.js/inpage.js as classic scripts",
    file: PKG_GATE,
    from: "    new vm.Script(src, { filename: f });",
    to: "    void vm;",
  },
  {
    name: "page-world: the package gate no longer refuses a module outside the relay and the rules",
    file: PKG_GATE,
    from: "        if (!PAGE_WORLD_MAY_BUNDLE.has(m)) {",
    to: "        if (false) {",
  },
  {
    name: "page-world: the package gate reads a missing module receipt as nothing extra",
    file: PKG_GATE,
    from: "if (!existsSync(join(DIST, PAGE_WORLD_RECEIPT))) {",
    to: "if (false) {",
  },
  {
    name: "page-world: the package gate lets a dynamic import() through",
    file: PKG_GATE,
    from: "  if (parses && /(?<![\\w$.])import\\s*\\(/.test(src)) {",
    to: "  if (false) {",
  },
  {
    name: "page-world: the build emits ES modules importing a shared protocol chunk again",
    file: EXT_VITE,
    from: '            format: "iife",\n            inlineDynamicImports: true,',
    to:
      '            format: "es",\n' +
      '            manualChunks: (id: string) => (id.includes("rpc/protocol") ? "protocol" : undefined),\n' +
      '            chunkFileNames: "[name].js",',
  },
  // ── Round six: a recovery phrase must not reach the clipboard; the popup must
  // not say the web page's sentences; the stylesheet gate must actually gate ──
  {
    name: "a copy button for the recovery phrase is back on the words screen",
    file: SEED_STEP,
    from: "        <button className={primaryCls} onClick={onNext}>",
    to:
      "        <button aria-label=\"Copy\" onClick={() => void navigator.clipboard.writeText(phrase)}>⧉</button>\n" +
      "        <button className={primaryCls} onClick={onNext}>",
  },
  {
    name: "the panel hands the phrase to a copy button outside the words screen",
    file: PANEL,
    from: '      {step === "words" && (\n        <SeedPhraseStep',
    to:
      '      {step === "words" && <CopyBtn value={phrase} />}\n' +
      '      {step === "words" && (\n        <SeedPhraseStep',
  },
  {
    // The name a deny-list of `phrase|mnemonic|words` never matches.
    name: "the reveal screen for an existing wallet gets a copy button for the phrase",
    file: PANEL,
    from: '                  <code className="mono block break-words text-xs">{revealed}</code>',
    to:
      '                  <code className="mono block break-words text-xs">{revealed}</code>\n' +
      "                  <CopyBtn value={revealed} />",
  },
  {
    name: "css gate: a spread onto a DOM element is no longer counted as unreadable",
    file: CSS_GATE,
    from: "    } else if (ts.isJsxSpreadAttribute(n) && /^[a-z]/.test(n.parent.parent.tagName.getText(sf))) {",
    to: "    } else if (false) {",
  },
  {
    name: "css gate: a spread onto a component is counted too, so the ceiling is blown by props",
    file: CSS_GATE,
    from: "    } else if (ts.isJsxSpreadAttribute(n) && /^[a-z]/.test(n.parent.parent.tagName.getText(sf))) {",
    to: "    } else if (ts.isJsxSpreadAttribute(n)) {",
  },
  {
    name: "the extension shows the web page's long risk paragraph again",
    file: PANEL,
    from: "      {isExtensionContext() ? (",
    to: "      {false ? (",
  },
  {
    name: "the extension shows the web intro ('no extension needed') again",
    file: PANEL,
    from: 't(isExtensionContext() ? "local_intro_ext" : "local_intro")',
    to: 't("local_intro")',
  },
  {
    name: "the test-network reminder is shown on mainnet too",
    file: TESTNET_BADGE,
    from: "  if (network === 1) return null;\n",
    to: "",
  },
  {
    name: "popup.css loses a rule the tab row needs (overflow-x-auto) — the gate must go red",
    file: POPUP_CSS,
    from: ".overflow-x-auto { overflow-x: auto; }\n",
    to: "",
  },
  {
    name: "css gate: a used class with no rule is no longer reported",
    file: CSS_GATE,
    from: "    missing.push({ token, file });",
    to: "    void file;",
  },
  {
    name: "css gate: every `variant:` token is exempt, not just breakpoints",
    file: CSS_GATE,
    from: "const BREAKPOINT_VARIANT = /^(sm|md|lg|xl|2xl):/;",
    to: "const BREAKPOINT_VARIANT = /^[a-z0-9-]+:/;",
  },
  {
    name: "css gate: stops following imports, so only the entry file is read",
    file: CSS_GATE,
    from: "      else if (p) queue.push(p);",
    to: "      else if (p) void p;",
  },
  {
    name: "css gate: a class list kept in a constant is no longer read",
    file: CSS_GATE,
    from: "        pieces.push(...via);",
    to: "        void via;",
  },
  {
    name: "css gate: el.className = … outside JSX is no longer read",
    file: CSS_GATE,
    from: '      n.left.name.text === "className"\n',
    to: '      n.left.name.text === "className /* MUT_CSS_GATE_NO_DOM_ASSIGN */"\n',
    marker: "MUT_CSS_GATE_NO_DOM_ASSIGN",
  },
  {
    name: "css gate: / no longer separates HTML attributes, so <body/class> is missed",
    file: CSS_GATE,
    from: '      if (WS.test(html[j]) || html[j] === "/") {',
    to: '      if (WS.test(html[j]) /* MUT_CSS_GATE_HTML_SPLIT */) {',
    marker: "MUT_CSS_GATE_HTML_SPLIT",
  },
  {
    name: "css gate: a > inside a quoted HTML value ends the tag again",
    file: CSS_GATE,
    from: "          const close = html.indexOf(q, j + 1);",
    to: "          const close = html.indexOf(q, j + 1);\n          if (html.slice(j + 1, close).includes(\">\")) break; // MUT_CSS_GATE_HTML_GT",
    marker: "MUT_CSS_GATE_HTML_GT",
  },
  // ── Round five: the remaining text checks, and the half of the pair that
  // was never held to the same standard as the other half ──
  {
    name: "mount read replaced by a comment saying it happens",
    file: TABS,
    from:
      "  const [uncertainHash, setUncertainHash] = useState<string | null>(() =>\n" +
      "    readLock(store, network, accountKey),\n" +
      "  );",
    to:
      "  const [uncertainHash, setUncertainHash] = useState<string | null>(\n" +
      "    null /* readLock(store, network, accountKey) */,\n" +
      "  );",
  },
  {
    name: "real key rotates while a decoy declaration satisfies the gate",
    file: TABS,
    from: "  const accountKey = accountKeyFrom(changeAddress);",
    to:
      "  const accountKey = changeAddress;\n" +
      "  const decoy = () => accountKeyFrom(changeAddress);\n" +
      "  void decoy;",
  },
  {
    name: "wholesale-clear guard inverted (one operator, unlock handed back)",
    file: TABS,
    from: "      if (next === null && e.key === null) {",
    to: "      if (next !== null && e.key === null) {",
  },
  {
    name: "the withdraw door stops reporting, so no lock is ever created",
    file: STAKING,
    from:
      "      setWithdrawReview(null);\n" +
      "      setChecked(false);\n" +
      "      const outcome = reportSignError(err, t);\n" +
      '      if (outcome.kind === "uncertain") onUncertain(outcome.txHash);',
    to:
      "      setWithdrawReview(null);\n" +
      "      setChecked(false);\n" +
      "      reportSignError(err, t);",
  },
  {
    name: "durability is a constant wearing a name, not state",
    file: TABS,
    from: "  const [durable, setDurable] = useState(true);",
    to: "  const durable = true;\n  const setDurable = (_v: boolean) => void _v;",
  },
  {
    name: "the spend-call detector stops unwrapping parentheses",
    file: NOTICE_TEST,
    from: "    while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e)) e = e.expression;",
    to: "",
  },
  // ── Round four: the gates themselves measured spelling, not meaning ──
  // Each of these was GREEN when written. They are here because the previous
  // round's checks were regexes over source text, and a regex cannot tell a
  // guard from a comment about a guard.
  {
    name: "keyed on changeAddress again, with a comment keeping the gate quiet",
    file: TABS,
    from: "  const accountKey = accountKeyFrom(changeAddress);",
    to: "  const accountKey = changeAddress; // was accountKeyFrom(changeAddress)",
  },
  {
    name: "the account-change effect reads the lock and throws the answer away",
    file: TABS,
    from: "    setUncertainHash(readLock(store, network, accountKey));",
    to: "    readLock(store, network, accountKey);",
  },
  {
    name: "durability hard-coded true (says 'kept here' when nothing was kept)",
    file: TABS,
    from: "          durable={durable}",
    to: "          durable={true}",
  },
  {
    name: "spend written as (port.signAndSubmit)(…) with the refusal gone",
    file: GOV,
    from:
      '    if (uncertainHash !== null) return toastError(t("uncertain_blocked"));\n' +
      "    setBusy(true);\n" +
      "    try {\n" +
      "      const hash = await port.signAndSubmit(pending.built, network);",
    to:
      "    setBusy(true);\n" +
      "    try {\n" +
      "      const hash = await (port.signAndSubmit)(pending.built, network);",
  },
  {
    name: "clearing site data takes the warning down as if the reader had checked",
    file: TABS,
    from:
      "      if (next === null && e.key === null) {\n" +
      "        // The warning stays, but it is no longer backed by anything: the copy\n" +
      "        // this tab is showing is now the only one. Saying so is the point of\n" +
      "        // the flag — leaving it `true` here is the same lie it exists to stop,\n" +
      "        // arriving by a different door.\n" +
      "        setDurable(false);\n" +
      "        return;\n" +
      "      }\n",
    to: "",
  },
  // ── Round three: the lock key, durability, and reachability of the refusal ──
  {
    name: "the lock is keyed on the change address again (rotates when money lands)",
    file: TABS,
    from: "  const accountKey = accountKeyFrom(changeAddress);",
    to: "  const accountKey = changeAddress;",
  },
  {
    name: "accountKeyFrom hands back the address, so the key rotates with it",
    file: STORE,
    from: '    return hash.toString("hex");',
    to: "    return changeAddressHex;",
  },
  {
    name: "the writeLock result is dropped — durability assumed, not known",
    file: TABS,
    from: "    setDurable(writeLock(store, network, accountKey, txHash));",
    to: "    writeLock(store, network, accountKey, txHash);",
  },
  {
    name: "a second tab is never told (storage listener unregistered)",
    file: TABS,
    from: '    window.addEventListener("storage", onStorage);',
    to: "",
  },
  {
    name: "the refusal is present but unreachable — wrapped in if (false)",
    file: GOV,
    from: '    if (uncertainHash !== null) return toastError(t("uncertain_blocked"));\n    setBusy(true);',
    to: '    if (false) { if (uncertainHash !== null) return toastError(t("uncertain_blocked")); }\n    setBusy(true);',
  },
  {
    name: 'spend written as port["signAndSubmit"] with the refusal gone',
    file: GOV,
    from:
      '    if (uncertainHash !== null) return toastError(t("uncertain_blocked"));\n' +
      "    setBusy(true);\n" +
      "    try {\n" +
      "      const hash = await port.signAndSubmit(pending.built, network);",
    to:
      "    setBusy(true);\n" +
      "    try {\n" +
      '      const hash = await port["signAndSubmit"](pending.built, network);',
  },
  {
    name: "withdrawal ownership filter removed (a stranger's reward counts as ours)",
    file: HISTORY,
    from: "    if (ownStakeAddresses.has(stake)) withdrawn += amount;",
    // Kept as an `if` so the `else if` after it still parses.
    to: "    if (true /* MUT_WITHDRAWAL_OWNER */) withdrawn += amount;",
    marker: "MUT_WITHDRAWAL_OWNER",
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
    name: "switching account keeps the previous account's warning on screen",
    file: TABS,
    from:
      "    if (seen.current === id) return;\n" +
      "    seen.current = id;\n" +
      "    setUncertainHash(readLock(store, network, accountKey));",
    to: "    seen.current = id;",
  },
  {
    // React state dies on idle-lock, which is five minutes, which is about how
    // long looking a transaction up takes.
    name: "the lock is no longer written down (memory only again)",
    file: TABS,
    from: "    setDurable(writeLock(store, network, accountKey, txHash));\n",
    to: "",
  },
  {
    name: "the lock is never read back on mount",
    file: TABS,
    from: "  const [uncertainHash, setUncertainHash] = useState<string | null>(() =>\n    readLock(store, network, accountKey),\n  );",
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
  {
    name: "Send review prints the bare token name again (policy id dropped on the last screen)",
    file: REVIEW_OUTPUT,
    from: "{assetLabel(tk)}",
    to: '{assetLabel(tk).split(" · ")[0]}',
  },
  {
    name: "Send review truncates the recipient address",
    file: REVIEW_OUTPUT,
    from: "<ChallengedValue value={address}",
    to: '<ChallengedValue value={address.slice(0, 16) + "…"}',
  },
  {
    name: "approval window prints the bare token name again (the website chose that name)",
    file: TX_SUMMARY_VIEW,
    from: "${assetLabel(n)}",
    to: '${assetLabel(n).split(" · ")[0]}',
  },
  {
    name: "a component that forwards its prop to a copy button is handed the revealed phrase",
    file: PANEL,
    from: "address={primaryAddress(account)}",
    to: 'address={revealed ?? ""}',
  },
  {
    name: "a second file writes the clipboard itself, the legacy way",
    file: SEND,
    from: "<CopyBtn value={txHash} />",
    to: "<CopyBtn value={txHash} />{void document.execCommand}",
  },
  {
    name: "a copy button reached under another name, out of sight of the value list",
    file: BALANCE,
    from: "<CopyBtn value={address} />",
    to: '{[CopyBtn].map((C) => <C key="c" value={address} />)}',
  },
  {
    // A text-level comment stripper reads `image/*` as a comment opening and
    // swallows everything up to the next `*/`.
    name: "a copy button for the phrase sits between `image/*` and a JSX comment",
    file: PANEL,
    from: '                  <code className="mono block break-words text-xs">{revealed}</code>',
    to:
      '                  <code className="mono block break-words text-xs">{revealed}</code>\n' +
      '                  <input type="file" accept="image/*" hidden />\n' +
      "                  <CopyBtn value={revealed} />\n" +
      "                  {/* end */}",
  },
  {
    // `[^>]*` stops at the `>` of `=>`, before the prop that matters.
    name: "a forwarder is handed the phrase after a prop that contains an arrow",
    file: PANEL,
    from: "              network={account.network}\n              address={primaryAddress(account)}",
    to: '              network={account.network}\n              key={[0].map((x) => x).join()}\n              address={revealed ?? ""}',
  },
  {
    name: "a forwarder imported under another name",
    file: PANEL,
    from: 'import { BalanceView, type DisplayAsset } from "./BalanceView";',
    to: 'import { BalanceView as Balance, type DisplayAsset } from "./BalanceView";\nconst BalanceView = Balance;',
  },
  {
    // `PhoenixCustodyPanel` copies a value derived from its `did` prop; nothing
    // declared it as forwarding, so what a caller handed it was never read.
    name: "a component that copies something derived from its prop is handed something off the list",
    file: WALLET_HUB,
    from: "<PhoenixCustodyPanel did={did} />",
    to: '<PhoenixCustodyPanel did={sessionStorage.getItem("phrase") ?? ""} />',
  },
  {
    name: "a second component in a file already on the list forwards its prop to a copy button",
    file: BALANCE,
    from: "export function BalanceView({",
    to:
      "export function AddressLine({ address }: { address: string }) {\n" +
      "  return <CopyBtn value={address} />;\n" +
      "}\n\n" +
      "export function BalanceView({",
  },
  {
    name: "the copy button's file exports a helper that copies whatever it is given",
    file: COPY_BTN,
    from: "export function CopyBtn({",
    to:
      "export async function copyText(v: string) {\n" +
      "  await navigator.clipboard.writeText(v);\n" +
      "}\n\n" +
      "export function CopyBtn({",
  },
  // The five below each take more than one edit: the component, and the line in
  // the test's lists an author would add so the component looks declared.
  {
    name: "a copy button behind memo(forwardRef(…)), declared only as copyable",
    edits: [
      {
        file: BALANCE,
        from: "export function BalanceView({",
        to:
          "export const AddressChip = memo(forwardRef<HTMLSpanElement, { address: string }>(({ address }, ref) => (\n" +
          "  <span ref={ref}><CopyBtn value={address} /></span>\n" +
          ")));\n\n" +
          "export function BalanceView({",
      },
      { file: BALANCE, from: 'import { FiatValue } from "./FiatValue";', to: 'import { FiatValue } from "./FiatValue";\nimport { forwardRef, memo } from "react";' },
      { file: COPY_GUARD_TEST, from: COPYABLE_ANCHOR, to: `${COPYABLE_ANCHOR}\n    "${BALANCE}#AddressChip: address",` },
    ],
  },
  {
    name: "a copy button in a class component, declared only as copyable",
    edits: [
      {
        file: BALANCE,
        from: "export function BalanceView({",
        to:
          "export class TxRow extends Component<{ txHash: string }> {\n" +
          "  render() {\n" +
          "    return <CopyBtn value={this.props.txHash} />;\n" +
          "  }\n" +
          "}\n\n" +
          "export function BalanceView({",
      },
      { file: BALANCE, from: 'import { FiatValue } from "./FiatValue";', to: 'import { FiatValue } from "./FiatValue";\nimport { Component } from "react";' },
      { file: COPY_GUARD_TEST, from: COPYABLE_ANCHOR, to: `${COPYABLE_ANCHOR}\n    "${BALANCE}#TxRow: this.props.txHash",` },
    ],
  },
  {
    name: "a declared forwarder is handed the phrase as its children",
    edits: [
      {
        file: BALANCE,
        from: "export function BalanceView({",
        to:
          "export function CopyChip({ children }: { children: string }) {\n" +
          "  return <CopyBtn value={children} />;\n" +
          "}\n\n" +
          "export function BalanceView({",
      },
      {
        file: PANEL,
        from: 'import { BalanceView, type DisplayAsset } from "./BalanceView";',
        to: 'import { BalanceView, CopyChip, type DisplayAsset } from "./BalanceView";',
      },
      {
        file: PANEL,
        from: '                  <code className="mono block break-words text-xs">{revealed}</code>',
        to:
          '                  <code className="mono block break-words text-xs">{revealed}</code>\n' +
          '                  <CopyChip>{revealed ?? ""}</CopyChip>',
      },
      { file: COPY_GUARD_TEST, from: COPYABLE_ANCHOR, to: `${COPYABLE_ANCHOR}\n    "${BALANCE}#CopyChip: children",` },
      { file: COPY_GUARD_TEST, from: FORWARDS_ANCHOR, to: `    "${BALANCE}#CopyChip: children",\n${FORWARDS_ANCHOR}` },
    ],
  },
  {
    name: "a copy button fed by a for…of over a prop, declared only as copyable",
    edits: [
      {
        file: BALANCE,
        from: "export function BalanceView({",
        to:
          "export function TxList({ txs }: { txs: string[] }) {\n" +
          "  const rows = [];\n" +
          "  for (const txHash of txs) rows.push(<CopyBtn key={txHash} value={txHash} />);\n" +
          "  return <>{rows}</>;\n" +
          "}\n\n" +
          "export function BalanceView({",
      },
      { file: COPY_GUARD_TEST, from: COPYABLE_ANCHOR, to: `${COPYABLE_ANCHOR}\n    "${BALANCE}#TxList: txHash",` },
    ],
  },
  {
    name: "a local function named t reaches the clipboard by a string",
    file: BALANCE,
    from: "export function BalanceView({",
    to:
      "const t = (k: string) => (navigator as unknown as Record<string, Clipboard>)[k];\n" +
      "export const copyAny = (v: string) => t(\"clipboard\").writeText(v);\n\n" +
      "export function BalanceView({",
  },
  // A component of its own inside the panel: `port` is an allowed value there,
  // and the phrase arrives as the inner function's parameter of that name.
  ...[
    ["an arrow component", "  const Chip = ({ port }: { port: string }) => <CopyBtn value={port} />;", '<Chip port={revealed ?? ""} />'],
    ["a helper function", "  function chip(port: string) {\n    return <CopyBtn value={port} />;\n  }", '{chip(revealed ?? "")}'],
    ["a useCallback", "  const chip = useCallback((port: string) => <CopyBtn value={port} />, []);", '{chip(revealed ?? "")}'],
  ].map(([what, decl, use]) => ({
    name: `${what} inside the panel hands the phrase to a copy button as port`,
    edits: [
      {
        file: PANEL,
        from: "  const [revealed, setRevealed] = useState<string | null>(null);",
        to: `  const [revealed, setRevealed] = useState<string | null>(null);\n${decl}`,
      },
      {
        file: PANEL,
        from: '                  <code className="mono block break-words text-xs">{revealed}</code>',
        to: `                  <code className="mono block break-words text-xs">{revealed}</code>\n                  ${use}`,
      },
    ],
  })),
  // A component that copies something from its props by a road the guard has
  // to follow, declared only as copyable: it must show up as a forwarder.
  ...[
    [
      "set by a setter handed by reference",
      '  const [shown, setShown] = useState("");\n  useEffect(() => {\n    void Promise.resolve(secret).then(setShown);\n  }, [secret]);\n  return <CopyBtn value={shown} />;',
      "shown",
    ],
    [
      "set by a setter handed to another element",
      '  const [shown, setShown] = useState("");\n  return (\n    <>\n      <Echo value={secret} onDone={setShown} />\n      <CopyBtn value={shown} />\n    </>\n  );',
      "shown",
    ],
    [
      "set by a setter kept where the test cannot follow it",
      '  const [shown, setShown] = useState("");\n  (window as unknown as Record<string, unknown>).later = { setShown, secret };\n  return <CopyBtn value={shown} />;',
      "shown",
    ],
    ["assigned by a for…of with no declaration", '  let shown = "";\n  for (shown of [secret]) break;\n  return <CopyBtn value={shown} />;', "shown"],
    ["built with +=", '  let shown = "";\n  shown += secret;\n  return <CopyBtn value={shown} />;', "shown"],
    ["destructured by assignment", '  let shown = "";\n  [shown] = [secret];\n  return <CopyBtn value={shown} />;', "shown"],
    ["the parameter of Array.from's callback", "  return <>{Array.from([secret], (s) => <CopyBtn key={s} value={s} />)}</>;", "s"],
    [
      "set by a setter wrapped in an arrow on another element",
      '  const [shown, setShown] = useState("");\n  return (\n    <>\n      <Echo value={secret} onDone={(v: string) => setShown(v)} />\n      <CopyBtn value={shown} />\n    </>\n  );',
      "shown",
    ],
    [
      "set by a named handler handed to another element",
      '  const [shown, setShown] = useState("");\n  const keep = (v: string) => setShown(v);\n  return (\n    <>\n      <Echo value={secret} onDone={keep} />\n      <CopyBtn value={shown} />\n    </>\n  );',
      "shown",
    ],
    [
      "set by a handler kept where the test cannot follow it",
      '  const [shown, setShown] = useState("");\n  (window as unknown as Record<string, unknown>).later = { secret, keep: (v: string) => setShown(v) };\n  return <CopyBtn value={shown} />;',
      "shown",
    ],
    ["returned by a nested function", "  function current() {\n    return secret;\n  }\n  return <CopyBtn value={current()} />;", "current()"],
    ["kept by push", "  const kept: string[] = [];\n  kept.push(secret);\n  return <CopyBtn value={kept[0]} />;", "kept[0]"],
    ["kept by Object.assign", '  const box = { v: "" };\n  Object.assign(box, { v: secret });\n  return <CopyBtn value={box.v} />;', "box.v"],
    [
      "kept by Map.set",
      "  const m = new Map<string, string>();\n  m.set('k', secret);\n  return <CopyBtn value={m.get('k') ?? ''} />;",
      "m.get('k') ?? ''",
    ],
    [
      "set through the useState tuple",
      '  const st = useState("");\n  useEffect(() => {\n    st[1](secret);\n  }, [secret]);\n  return <CopyBtn value={st[0]} />;',
      "st[0]",
    ],
    [
      "set through an object pattern on useState",
      '  const { 0: shown, 1: setShown } = useState("");\n  useEffect(() => {\n    setShown(secret);\n  }, [secret]);\n  return <CopyBtn value={shown} />;',
      "shown",
    ],
    ["kept by Reflect.set", '  const box = { v: "" };\n  Reflect.set(box, "v", secret);\n  return <CopyBtn value={box.v} />;', "box.v"],
    [
      "kept by Object.defineProperty",
      '  const box = { v: "" };\n  Object.defineProperty(box, "v", { value: secret });\n  return <CopyBtn value={box.v} />;',
      "box.v",
    ],
    ['kept by Object["assign"]', '  const box = { v: "" };\n  Object["assign"](box, { v: secret });\n  return <CopyBtn value={box.v} />;', "box.v"],
    ["kept by push.call", "  const kept: string[] = [];\n  Array.prototype.push.call(kept, secret);\n  return <CopyBtn value={kept[0]} />;", "kept[0]"],
    ["kept by push on an alias", "  const kept: string[] = [];\n  const alias = kept;\n  alias.push(secret);\n  return <CopyBtn value={kept[0]} />;", "kept[0]"],
    ["kept by assigning through an alias", '  const box = { v: "" };\n  const ref = box;\n  ref.v = secret;\n  return <CopyBtn value={box.v} />;', "box.v"],
    ["held by a class field", "  class K {\n    v = secret;\n  }\n  return <CopyBtn value={new K().v} />;", "new K().v"],
    ["returned by a class method", "  class K {\n    get() {\n      return secret;\n    }\n  }\n  return <CopyBtn value={new K().get()} />;", "new K().get()"],
    [
      "kept by Object.assign into an object cast to a string",
      '  const box = { v: "" };\n  Object.assign(box as unknown as string, { v: secret });\n  return <CopyBtn value={box.v} />;',
      "box.v",
    ],
    ["thrown and caught", '  let v = "";\n  try {\n    throw secret;\n  } catch (e) {\n    v = e as string;\n  }\n  return <CopyBtn value={v} />;', "v"],
    ["as a default in a destructured declaration", "  const { a = secret } = {} as { a?: string };\n  return <CopyBtn value={a} />;", "a"],
    ["as a default in a destructuring assignment", '  let v = "";\n  ({ v = secret } = {} as { v?: string });\n  return <CopyBtn value={v} />;', "v"],
    ["written through a comma expression", '  const box = { v: "" };\n  (0, box).v = secret;\n  return <CopyBtn value={box.v} />;', "box.v"],
    ["written through what a local function returns", '  const box = { v: "" };\n  const me = () => box;\n  me().v = secret;\n  return <CopyBtn value={box.v} />;', "box.v"],
    [
      "written through an alias picked by a conditional",
      '  const box = { v: "" };\n  const alias = Date.now() > 0 ? box : box;\n  alias.v = secret;\n  return <CopyBtn value={box.v} />;',
      "box.v",
    ],
    [
      "read back from arguments",
      "  function row() {\n    // eslint-disable-next-line prefer-rest-params\n    return <CopyBtn value={arguments[0]} />;\n  }\n  return <div>{row.apply(null, [secret] as unknown as [])}</div>;",
      "arguments[0]",
    ],
    [
      "written into import.meta.env",
      "  (import.meta.env as Record<string, string>).VITE_SHOWN = secret;\n  return <CopyBtn value={import.meta.env.VITE_SHOWN} />;",
      "import.meta.env.VITE_SHOWN",
    ],
    [
      "kept by Object.assign into an untyped value declared a string",
      "  const box: string = JSON.parse('{\"v\":\"\"}');\n  Object.assign(box, { v: secret });\n  return <CopyBtn value={Object.values(box).join()} />;",
      "Object.values(box).join()",
    ],
    [
      "kept by Object.assign into an object a type predicate calls a string",
      "  const isText = (x: unknown): x is string => x !== null;\n  const box: { v: string } | string = Date.now() > 0 ? { v: \"\" } : \"\";\n  if (isText(box)) Object.assign(box, { v: secret });\n  return <CopyBtn value={typeof box === 'string' ? box : box.v} />;",
      "typeof box === 'string' ? box : box.v",
    ],
    [
      "kept by Object.assign into an array read as a string through a wider alias",
      '  const box: string[] = [];\n  const outer: string[] = [];\n  const wide: (string | string[])[] = outer;\n  wide.push(box);\n  const s: string = outer[0];\n  Object.assign(s, [secret]);\n  return <CopyBtn value={box.join()} />;',
      "box.join()",
    ],
    [
      "kept by Object.assign into an array an overload calls a string",
      '  function asText(x: string[]): string;\n  function asText(x: unknown) {\n    return x;\n  }\n  const box: string[] = [];\n  const s: string = asText(box);\n  Object.assign(s, [secret]);\n  return <CopyBtn value={box.join()} />;',
      "box.join()",
    ],
    [
      "kept by Object.assign into an array a typed pattern over an untyped value calls a string",
      '  const box: string[] = [];\n  const key: string = "w";\n  const { s }: { s: string } = Reflect.get({ w: { s: box } }, key);\n  Object.assign(s, [secret]);\n  return <CopyBtn value={box.join()} />;',
      "box.join()",
    ],
    // Nothing below hands the phrase on as a value: each rebuilds it from what
    // a test on it decided, or puts it where any other code can read it back.
    [
      "rebuilt letter by letter under an if",
      '  let out = "";\n  for (let i = 0; i < secret.length; i++)\n    for (const c of "abcdefghijklmnopqrstuvwxyz ") if (secret[i] === c) out += c;\n  return <CopyBtn value={out} />;',
      "out",
    ],
    [
      "rebuilt letter by letter behind &&",
      '  let out = "";\n  for (let i = 0; i < secret.length; i++)\n    for (const c of "abcdefghijklmnopqrstuvwxyz ") void (secret.charAt(i) === c && (out = out.concat(c)));\n  return <CopyBtn value={out} />;',
      "out",
    ],
    [
      "rebuilt letter by letter in a catch a test throws into",
      '  let out = "";\n  for (let i = 0; i < secret.length; i++)\n    for (const c of "abcdefghijklmnopqrstuvwxyz ")\n      try {\n        if (secret[i] === c) throw 0;\n      } catch {\n        out += c;\n      }\n  return <CopyBtn value={out} />;',
      "out",
    ],
    [
      "rebuilt letter by letter from where a loop breaks",
      '  let out = "";\n  for (let i = 0; i < secret.length; i++) {\n    let hit = "";\n    for (const c of "abcdefghijklmnopqrstuvwxyz ") {\n      hit = c;\n      if (secret[i] === c) break;\n    }\n    out += hit;\n  }\n  return <CopyBtn value={out} />;',
      "out",
    ],
    [
      "kept as the key of an object",
      "  const keys: Record<string, true> = {};\n  keys[secret] = true;\n  return <CopyBtn value={Object.keys(keys)[0]} />;",
      "Object.keys(keys)[0]",
    ],
    [
      "rebuilt through a computed key in a pattern",
      '  const table: Record<string, string> = {};\n  for (const c of "abcdefghijklmnopqrstuvwxyz ") table[c] = c;\n  let out = "";\n  for (const ch of secret) {\n    const { [ch]: hit = "" } = table;\n    out += hit;\n  }\n  return <CopyBtn value={out} />;',
      "out",
    ],
    [
      "kept in sessionStorage",
      "  sessionStorage.setItem('k', secret);\n  return <CopyBtn value={sessionStorage.getItem('k') ?? ''} />;",
      "sessionStorage.getItem('k') ?? ''",
    ],
    [
      "kept in an attribute of a hidden element",
      "  return (\n    <>\n      <span id='shown-k' data-k={secret} hidden />\n      <CopyBtn value={document.getElementById('shown-k')?.dataset.k ?? ''} />\n    </>\n  );",
      "document.getElementById('shown-k')?.dataset.k ?? ''",
    ],
    [
      "kept in localStorage from inside an effect",
      "  useEffect(() => {\n    window.localStorage.setItem('k', secret);\n  }, [secret]);\n  return <CopyBtn value={window.localStorage.getItem('k') ?? ''} />;",
      "window.localStorage.getItem('k') ?? ''",
    ],
    [
      "rebuilt by picking which function to call",
      '  let out = "";\n  const table: Record<string, () => void> = {};\n  for (const ch of "abcdefghijklmnopqrstuvwxyz ") table[ch] = () => {\n    out += ch;\n  };\n  for (const c of secret) table[c]?.();\n  return <CopyBtn value={out} />;',
      "out",
    ],
    [
      "rebuilt by counting up to each letter",
      '  const A = "abcdefghijklmnopqrstuvwxyz ";\n  let out = "";\n  for (let i = 0; i < 64; i++) {\n    let n = 0;\n    while (n < A.length && A[n] !== secret[i]) n++;\n    out += A.charAt(n);\n  }\n  return <CopyBtn value={out} />;',
      "out",
    ],
    [
      "kept as a property of sessionStorage",
      "  (sessionStorage as unknown as Record<string, string>).k = secret;\n  return <CopyBtn value={window.sessionStorage.getItem('k') ?? ''} />;",
      "window.sessionStorage.getItem('k') ?? ''",
    ],
    [
      "kept in the document title",
      "  document.title = secret;\n  return <CopyBtn value={window.document.title} />;",
      "window.document.title",
    ],
    [
      "kept on Math through Reflect",
      "  Reflect.set(Math, 'leak', secret);\n  return <CopyBtn value={String(Reflect.get(Math, 'leak'))} />;",
      "String(Reflect.get(Math, 'leak'))",
    ],
    [
      "kept in a fragment the page reads back",
      "  return (\n    <>\n      {secret}\n      <CopyBtn value={document.body.textContent ?? ''} />\n    </>\n  );",
      "document.body.textContent ?? ''",
    ],
    [
      "rebuilt by a call each letter decides, handed nothing tainted",
      '  const A = "abcdefghijklmnopqrstuvwxyz ";\n  let out = "";\n  for (let i = 0; i < 64; i++) {\n    const k: number[] = [];\n    while (k.length < A.length && A[k.length] !== secret[i]) k.push(0);\n    out += A.charAt(k.length);\n  }\n  return <CopyBtn value={out} />;',
      "out",
    ],
    [
      "kept in sessionStorage under another name",
      "  const s = window.sessionStorage;\n  s.setItem('k', secret);\n  return <CopyBtn value={window.sessionStorage.getItem('k') ?? ''} />;",
      "window.sessionStorage.getItem('k') ?? ''",
    ],
    [
      "kept on a global function through Reflect",
      "  Reflect.set(parseInt, 'leak', secret);\n  return <CopyBtn value={String(Reflect.get(parseInt, 'leak'))} />;",
      "String(Reflect.get(parseInt, 'leak'))",
    ],
  ].map(([what, body, value]) => ({
    name: `a copy button fed from a prop ${what}, declared only as copyable`,
    edits: [
      {
        file: BALANCE,
        from: "export function BalanceView({",
        to: `export function Shown({ secret }: { secret: string }) {\n${body}\n}\n\nexport function BalanceView({`,
      },
      {
        file: BALANCE,
        from: 'import { FiatValue } from "./FiatValue";',
        to: 'import { FiatValue } from "./FiatValue";\nimport { useEffect, useState } from "react";',
      },
      { file: COPY_GUARD_TEST, from: COPYABLE_ANCHOR, to: `${COPYABLE_ANCHOR}\n    "${BALANCE}#Shown: ${value}",` },
    ],
    // `Echo` is left undeclared on purpose: the guard reads this source and
    // cannot see what another element does with the setter, and `Shown` is
    // never rendered, so the missing name never runs.
    ...(body.includes("<Echo ") ? { undeclared: ["Echo"] } : {}),
  })),
  // A parameter the component defaults or writes holds its own functions, not
  // the caller's: picking one by the phrase rebuilds the phrase.
  ...[
    ["a second parameter with a default", "{ secret }: { secret: string }, table: Record<string, () => void> = {}"],
    [
      "a prop with a default",
      "{ secret, table = {} }: { secret: string; table?: Record<string, () => void> }",
    ],
  ].map(([what, params]) => ({
    name: `a copy button fed from a prop rebuilt by picking which function in ${what} to call, declared only as copyable`,
    edits: [
      {
        file: BALANCE,
        from: "export function BalanceView({",
        to: `export function Shown(${params}) {\n  let out = "";\n  for (const ch of "abcdefghijklmnopqrstuvwxyz ") table[ch] = () => {\n    out += ch;\n  };\n  for (const c of secret) table[c]?.();\n  return <CopyBtn value={out} />;\n}\n\nexport function BalanceView({`,
      },
      { file: COPY_GUARD_TEST, from: COPYABLE_ANCHOR, to: `${COPYABLE_ANCHOR}\n    "${BALANCE}#Shown: out",` },
    ],
  })),
  {
    name: "a copy button reading back the page through a module-level alias of document, declared only as copyable",
    edits: [
      {
        file: BALANCE,
        from: "export function BalanceView({",
        to: "const doc = globalThis.document;\n\nexport function Shown({ secret }: { secret: string }) {\n  return (\n    <>\n      <span>{secret}</span>\n      <CopyBtn value={doc.body.textContent ?? ''} />\n    </>\n  );\n}\n\nexport function BalanceView({",
      },
      { file: COPY_GUARD_TEST, from: COPYABLE_ANCHOR, to: `${COPYABLE_ANCHOR}\n    "${BALANCE}#Shown: doc.body.textContent ?? ''",` },
    ],
  },
  // What code outside the component keeps, or what decides that a line inside
  // it runs: a helper, a store reached through a helper, a context, a throw, an
  // optional chain, a default. Declaring the copied value alone is not enough.
  ...[
    [
      "kept by a module helper",
      'let box = "";\nfunction keep(v: string) {\n  box = v;\n}\nfunction give() {\n  return box;\n}',
      "Shown",
      "  keep(secret);\n  return <CopyBtn value={give()} />;",
      "give()",
    ],
    [
      "kept in sessionStorage reached through a module helper",
      "const ss = () => sessionStorage;",
      "Shown",
      // Single quotes: the value is pasted into a double-quoted string in the test.
      "  ss().setItem('k', secret);\n  return <CopyBtn value={ss().getItem('k')} />;",
      "ss().getItem('k')",
    ],
    [
      "handed on through a context",
      'const Ctx = createContext("");\nfunction Inner() {\n  const v = useContext(Ctx);\n  return <CopyBtn value={v} />;\n}',
      "Inner",
      "  return (\n    <Ctx.Provider value={secret}>\n      <Inner />\n    </Ctx.Provider>\n  );",
      "v",
    ],
    [
      "rebuilt by which letters a built-in lets through without throwing",
      "",
      "Shown",
      '  const A = "abcdefghijklmnopqrstuvwxyz ";\n  let out = "";\n  for (let i = 0; i < 64; i++)\n    for (const c of A) {\n      try {\n        "".repeat(secret[i] === c ? 1 : -1);\n        out += c;\n      } catch {}\n    }\n  return <CopyBtn value={out} />;',
      "out",
    ],
    [
      "rebuilt by which letters a module helper lets through without throwing",
      'const A = "abcdefghijklmnopqrstuvwxyz ";\nconst must = (b: boolean) => {\n  if (!b) throw 0;\n};',
      "Shown",
      '  let out = "";\n  for (let i = 0; i < 64; i++)\n    for (const c of A) {\n      try {\n        must(secret[i] === c);\n        out += c;\n      } catch {}\n    }\n  return <CopyBtn value={out} />;',
      "out",
    ],
    [
      "rebuilt by which letters a local helper lets through without throwing",
      "",
      "Shown",
      '  const A = "abcdefghijklmnopqrstuvwxyz ";\n  const must = (b: boolean) => {\n    if (!b) throw 0;\n  };\n  let out = "";\n  for (let i = 0; i < 64; i++)\n    for (const c of A) {\n      try {\n        must(secret[i] === c);\n        out += c;\n      } catch {}\n    }\n  return <CopyBtn value={out} />;',
      "out",
    ],
    [
      "rebuilt by which optional chains go on",
      "",
      "Shown",
      '  const A = "abcdefghijklmnopqrstuvwxyz ";\n  let out = "";\n  for (let i = 0; i < 64; i++)\n    for (const c of A) (secret[i] === c ? "" : undefined)?.charAt((out += c, 0));\n  return <CopyBtn value={out} />;',
      "out",
    ],
    [
      "rebuilt by which parameter defaults run",
      "",
      "Shown",
      '  const A = "abcdefghijklmnopqrstuvwxyz ";\n  let out = "";\n  for (let i = 0; i < 64; i++)\n    for (const c of A) {\n      const g = (x: string | undefined = (out += c)) => x;\n      g(secret[i] === c ? undefined : "");\n    }\n  return <CopyBtn value={out} />;',
      "out",
    ],
    [
      "rebuilt by which destructuring defaults run",
      "",
      "Shown",
      '  const A = "abcdefghijklmnopqrstuvwxyz ";\n  let out = "";\n  for (let i = 0; i < 64; i++)\n    for (const c of A) {\n      const { z = (out += c) }: { z?: string } = secret[i] === c ? {} : { z: "" };\n      void z;\n    }\n  return <CopyBtn value={out} />;',
      "out",
    ],
  ].map(([what, prelude, at, body, value]) => ({
    name: `a copy button fed from a prop ${what}, declared only as copyable`,
    edits: [
      {
        file: BALANCE,
        from: "export function BalanceView({",
        to: `${prelude}\n\nexport function Shown({ secret }: { secret: string }) {\n${body}\n}\n\nexport function BalanceView({`,
      },
      {
        file: BALANCE,
        from: 'import { FiatValue } from "./FiatValue";',
        to: 'import { FiatValue } from "./FiatValue";\nimport { createContext, useContext } from "react";',
      },
      { file: COPY_GUARD_TEST, from: COPYABLE_ANCHOR, to: `${COPYABLE_ANCHOR}\n    "${BALANCE}#${at}: ${value}",` },
    ],
  })),
  // In a file with no copy button yet, so nothing else it already holds goes
  // missing when the import is not followed.
  {
    name: "a copy button imported as CopyBtn.js and fed from a prop, declared only as copyable",
    edits: [
      {
        file: TESTNET_BADGE,
        from: 'import type { PhoenixNetwork } from "@/lib/cardano";',
        to:
          'import type { PhoenixNetwork } from "@/lib/cardano";\n' +
          'import { CopyBtn } from "@/components/CopyBtn.js";\n\n' +
          "export function Shown({ secret }: { secret: string }) {\n" +
          "  return <CopyBtn value={secret} />;\n" +
          "}",
      },
      { file: COPY_GUARD_TEST, from: COPYABLE_ANCHOR, to: `${COPYABLE_ANCHOR}\n    "${TESTNET_BADGE}#Shown: secret",` },
    ],
  },
  // A held import.meta exported, so the write to it sits in a file whose own
  // uses of the holder the check never sees.
  {
    name: "a copy button fed from import.meta.env written through an exported holder, declared only as copyable",
    edits: [
      {
        file: TESTNET_BADGE,
        from: 'import type { PhoenixNetwork } from "@/lib/cardano";',
        to:
          'import type { PhoenixNetwork } from "@/lib/cardano";\n\n' +
          "export const held = import.meta as unknown as { env: Record<string, string> };",
      },
      {
        file: BALANCE,
        from: "export function BalanceView({",
        to:
          "export function Shown({ secret }: { secret: string }) {\n" +
          "  held.env.VITE_SHOWN = secret;\n" +
          '  return <CopyBtn value={import.meta.env.VITE_SHOWN ?? ""} />;\n' +
          "}\n\nexport function BalanceView({",
      },
      {
        file: BALANCE,
        from: 'import { FiatValue } from "./FiatValue";',
        to: 'import { FiatValue } from "./FiatValue";\nimport { held } from "./TestnetBadge";',
      },
      { file: COPY_GUARD_TEST, from: COPYABLE_ANCHOR, to: `${COPYABLE_ANCHOR}\n    "${BALANCE}#Shown: import.meta.env.VITE_SHOWN ?? \\"\\"",` },
    ],
  },
  // Needs no line in the list at all: the button arrives under a name the
  // value list never reads, from a path no import spells out.
  {
    name: "a copy button loaded by import() from a path built at run time",
    edits: [
      {
        file: TESTNET_BADGE,
        from: 'import type { PhoenixNetwork } from "@/lib/cardano";',
        to:
          'import type { PhoenixNetwork } from "@/lib/cardano";\n' +
          'import { lazy } from "react";\n\n' +
          'const part = "CopyBtn";\n' +
          "const Lazy = lazy(() => import(`../${part}.tsx`).then((m) => ({ default: m[part] })));\n\n" +
          "export function Shown({ secret }: { secret: string }) {\n" +
          "  return <Lazy value={secret} />;\n" +
          "}",
      },
    ],
  },
  // The state hook under another name: its setter is one the value list never
  // follows, so the state reads as a constant.
  {
    name: "a copy button fed from a prop through a renamed useState, declared only as copyable",
    edits: [
      {
        file: BALANCE,
        from: "export function BalanceView({",
        to:
          "export function Shown({ secret }: { secret: string }) {\n" +
          '  const [shown, setShown] = useLater("");\n' +
          "  useEffect(() => {\n    setShown(secret);\n  }, [secret]);\n" +
          "  return <CopyBtn value={shown} />;\n}\n\nexport function BalanceView({",
      },
      {
        file: BALANCE,
        from: 'import { FiatValue } from "./FiatValue";',
        to: 'import { FiatValue } from "./FiatValue";\nimport { useEffect, useState as useLater } from "react";',
      },
      { file: COPY_GUARD_TEST, from: COPYABLE_ANCHOR, to: `${COPYABLE_ANCHOR}\n    "${BALANCE}#Shown: shown",` },
    ],
  },
  // Needs no line in the list: `import.meta.glob` loads the button by a
  // pattern, and here the pattern does not even spell the file's name.
  {
    name: "a copy button loaded by import.meta.glob",
    edits: [
      {
        file: TESTNET_BADGE,
        from: 'import type { PhoenixNetwork } from "@/lib/cardano";',
        to:
          'import type { PhoenixNetwork } from "@/lib/cardano";\n\n' +
          "type Mods = Record<string, Record<string, (p: { value: string }) => JSX.Element>>;\n" +
          'const mods = (import.meta as unknown as { glob: (p: string, o: { eager: true }) => Mods }).glob("../C*.tsx", { eager: true });\n' +
          "const Btn = Object.values(Object.values(mods)[0])[0];\n\n" +
          "export function Shown({ secret }: { secret: string }) {\n" +
          "  return <Btn value={secret} />;\n" +
          "}",
      },
    ],
  },
  {
    name: "a copy button loaded by import.meta.glob through a variable cast to look like env",
    edits: [
      {
        file: TESTNET_BADGE,
        from: 'import type { PhoenixNetwork } from "@/lib/cardano";',
        to:
          'import type { PhoenixNetwork } from "@/lib/cardano";\n\n' +
          "type Mods = Record<string, Record<string, (p: { value: string }) => JSX.Element>>;\n" +
          "const meta = import.meta as unknown as { env?: unknown };\n" +
          'const mods = (meta as unknown as { glob: (p: string, o: { eager: true }) => Mods }).glob("../C*.tsx", { eager: true });\n' +
          "const Btn = Object.values(Object.values(mods)[0])[0];\n\n" +
          "export function Shown({ secret }: { secret: string }) {\n" +
          "  return <Btn value={secret} />;\n" +
          "}",
      },
    ],
  },
  {
    name: "a locale file that parses to null passes as a namespace with no keys",
    file: LOCALES_GATE,
    from: 'if (json === null || typeof json !== "object" || Array.isArray(json)) {',
    to: "if (false) {",
  },
  // ── The extension talking to real dApps: who answers which request, what a
  // read returns, and which error code a refusal carries. Every one of these
  // was a dead end for a site before it was fixed. ──
  {
    name: "an answer from another window settles the request (port check gone)",
    file: PENDING,
    from: "if (!w || w.port !== port) return false;",
    to: "if (!w) return false;",
  },
  {
    name: "request ids are a counter again, guessable and restarting per worker",
    file: PENDING,
    from: "newId: () => string = randomId",
    to: "newId: () => string = ((n) => () => String(++n))(0)",
  },
  {
    name: "a colliding id is not re-drawn, two requests share one",
    file: PENDING,
    from: "      while (waiting.has(id)) id = newId();\n",
    to: "",
  },
  {
    name: "closing a window settles every window's requests",
    file: PENDING,
    from: "        if (w.port !== port) continue;\n",
    to: "",
  },
  {
    name: "closing the old window unregisters the new one",
    file: PENDING,
    from: "windows.get(origin) === port",
    to: "windows.has(origin)",
  },
  {
    name: "own reward withdrawal: stake key justified but never signed",
    file: SIGN_FOREIGN,
    from: "\n        add(account.stakeKeyHashHex);",
    to: "",
  },
  {
    name: "a zero-ADA UTxO from the indexer is encoded instead of refused",
    file: UTXO_CBOR,
    from: "(!allowZero && n === BigInt(0))",
    to: "false",
  },
  {
    name: "getUtxos answers an empty list instead of the inputs signing reads",
    file: APPROVE,
    from: "return { ok: true, value: encodeInputsAsUtxosHex(list) };",
    to: "return { ok: true, value: [] as string[] }; /* MUT_GETUTXOS_EMPTY */",
    marker: "MUT_GETUTXOS_EMPTY",
  },
  {
    name: "getUtxos answers the full list when `amount` cannot be covered, instead of null",
    file: APPROVE,
    from: "if (!picked) return { ok: true, value: null };",
    to: "if (!picked) return { ok: true, value: encodeInputsAsUtxosHex(list) }; /* MUT_GETUTXOS_AMOUNT */",
    marker: "MUT_GETUTXOS_AMOUNT",
  },
  {
    name: "getUtxos `paginate` past the end answers an empty page, not PaginateError",
    file: APPROVE,
    from: 'if ("maxSize" in paged) return { ok: false, error: paginateError(paged.maxSize) };',
    to: 'if ("maxSize" in paged) return { ok: true, value: [] as string[] }; /* MUT_PAGINATE */',
    marker: "MUT_PAGINATE",
  },
  {
    name: "getBalance answers zero instead of the summed inputs",
    file: APPROVE,
    from: "value: encodeBalanceHex(await wp.getInputs())",
    to: 'value: "00"',
  },
  {
    name: "the window opens account 0 whatever account the person last used",
    file: APPROVE,
    from: "w.accountIndex ?? 0",
    to: "0",
  },
  {
    name: "signData parked on a screen whose approve button never enables",
    file: APPROVE,
    from: 'if (req.method === "signData") {',
    to: "if (false) {",
  },
  {
    name: "Reject on submitTx answers 2, which TxSendError reads as Failure",
    file: APPROVE,
    from: '? sendRefused(t("cip30_declined"))',
    to: '? /* MUT_SUBMIT_REJECT */ declined(t("cip30_declined"))',
    marker: "MUT_SUBMIT_REJECT",
  },
  {
    name: "Send on submitTx signs instead of broadcasting",
    file: APPROVE,
    from: 'req.method === "submitTx" ? broadcast() : sign()',
    to: "sign()",
  },
  {
    name: "the address count is a hard-coded English word again",
    file: APPROVE,
    from: '{t("cip30_address_count", { n: allAddresses(account).length })}',
    to: "{allAddresses(account).length} addresses",
  },
  {
    name: "Reject on the connect screen answers UserDeclined (2) instead of APIError.Refused (-3)",
    file: APPROVE,
    from: '<button onClick={() => answer({ ok: false, error: refused(t("cip30_declined")) })}>',
    to: '<button onClick={() => answer({ ok: false, error: declined(t("cip30_declined")) })}>',
  },
  {
    name: "a signing step that fails answers UserDeclined instead of ProofGeneration",
    file: APPROVE,
    from: "error: proofFailed(key ? t(key, { defaultValue: key }) : e instanceof Error ? e.message : String(e)),",
    to: "error: declined(key ? t(key, { defaultValue: key }) : e instanceof Error ? e.message : String(e)),",
  },
  {
    name: "a request arriving after the idle lock is served by whatever account the ref holds",
    file: APPROVE,
    from: "      if (acct !== account) {",
    to: "      if (false) {",
  },
  {
    name: "the idle lock leaves the port open",
    file: APPROVE,
    from: "      p.disconnect();",
    to: "      void p;",
  },
  {
    name: "the idle lock leaves the account in the ref that requests read",
    file: APPROVE,
    from: "      accountRef.current = null;",
    to: "      void 0; /* MUT_APPROVE_LOCK_REF */",
    marker: "MUT_APPROVE_LOCK_REF",
  },
  // ── signTx, both layers: each rule the screen applies, and the same rule
  // again in the function that holds the key. Each mutant plants its own
  // marker, and the runner reads the result only once the marker is in the
  // file. The drip-pot claim tests put back exactly one of these on a claim
  // that otherwise signs, and match the gate's own code or sentence. ──
  {
    name: "signer: a tx declaring its own script fails (is_valid = false) is signed",
    file: SIGN_FOREIGN,
    from: "if (Array.isArray(whole) && whole.length >= 3 && whole[2] === false) {",
    to: "if (false /* MUT_SF_INVALID */) {",
    marker: "MUT_SF_INVALID",
  },
  {
    name: "signer: a certificate from a website is signed",
    file: SIGN_FOREIGN,
    from: "if (countOf(b.get(4)) > 0) throw",
    to: "if (false /* MUT_SF_CERT */) throw",
    marker: "MUT_SF_CERT",
  },
  {
    name: "signer: a mint that creates tokens is signed",
    file: SIGN_FOREIGN,
    from: "if (!isNegativeInteger(qty)) throw",
    to: "if (false /* MUT_SF_MINT */) throw",
    marker: "MUT_SF_MINT",
  },
  {
    name: "signer: a body for another network is signed",
    file: SIGN_FOREIGN,
    from: "if (declaredNetwork !== undefined && Number(declaredNetwork) !== ledgerNetworkId) {",
    to: "if (false /* MUT_SF_NET */) {",
    marker: "MUT_SF_NET",
  },
  {
    name: "signer: collateral this wallet does not hold is passed over instead of refused",
    file: SIGN_FOREIGN,
    from: 'if (what === "collateral") throw',
    to: 'if (false /* MUT_SF_COLL */) throw',
    marker: "MUT_SF_COLL",
  },
  {
    name: "screen: a tx declaring its own script fails is described",
    file: TX_SUMMARY,
    from: "if (decoded.length >= 3 && decoded[2] === false) {",
    to: "if (false /* MUT_TS_INVALID */) {",
    marker: "MUT_TS_INVALID",
  },
  {
    name: "screen: a certificate is described as if nothing were handed over",
    file: TX_SUMMARY,
    from: 'if (n !== 0) bad("this transaction carries a certificate',
    to: 'if (false /* MUT_TS_CERT */) bad("this transaction carries a certificate',
    marker: "MUT_TS_CERT",
  },
  {
    name: "screen: a mint that creates tokens is described",
    file: TX_SUMMARY,
    from: "if (qty >= BigInt(0)) bad(",
    to: "if (false /* MUT_TS_MINT */) bad(",
    marker: "MUT_TS_MINT",
  },
  {
    name: "screen: a body for another network is described",
    file: TX_SUMMARY,
    from: "if (declaredNetwork !== undefined && Number(declaredNetwork) !== networkId) {",
    to: "if (false /* MUT_TS_NET */) {",
    marker: "MUT_TS_NET",
  },
  {
    name: "screen: collateral this wallet cannot value is skipped instead of refused",
    file: TX_SUMMARY,
    from: "    if (!held) {\n      bad(\"this transaction puts up collateral",
    to: "    if (!held) continue; /* MUT_TS_COLL */\n    if (false) {\n      bad(\"this transaction puts up collateral",
    marker: "MUT_TS_COLL",
  },
  {
    name: "screen: the collateral at risk is computed but never shown",
    file: TX_SUMMARY_VIEW,
    from: "{summary.collateral && (",
    to: "{/* MUT_VIEW_COLL */ false && summary.collateral && (",
    marker: "MUT_VIEW_COLL",
  },
  {
    name: "screen: the burn is computed but never shown",
    file: TX_SUMMARY_VIEW,
    from: "{summary.burns.length > 0 && (",
    to: "{/* MUT_VIEW_BURN */ false && summary.burns.length > 0 && (",
    marker: "MUT_VIEW_BURN",
  },
  {
    name: "getCollateral puts up more than the 5 ADA cap when a site asks",
    file: APPROVE,
    from: "if (want.lovelace > COLLATERAL_CAP_LOVELACE) return",
    to: "if (false /* MUT_COLL_CAP */) return",
    marker: "MUT_COLL_CAP",
  },
  {
    name: "signTx ignores partialSign = false and returns a partial witness set",
    file: APPROVE,
    from: "const partial = phase.req.params[1] === true;",
    to: "const partial = true; /* MUT_PARTIAL */",
    marker: "MUT_PARTIAL",
  },
  // ── Review round on the CIP-30 claim: what counts as change, what a coin
  // offered as collateral may hold, and what the screen claims about money. ──
  {
    // The screen grows its own copy of the rule — the old one, "a datum means
    // it left" — and drifts from the readers, which keep a datum at a key
    // address. The parity cases in ownUtxo.test.ts exist to catch exactly this.
    name: "screen: change is decided by a second copy of the rule that skips every datum",
    file: TX_SUMMARY,
    from: "const mine = ownAddress && walletOwnsOutput({ addressHex, datum, referenceScript: false });",
    to: "const mine = ownAddress && !datum; /* MUT_TS_OWN_DATUM */",
    marker: "MUT_TS_OWN_DATUM",
  },
  {
    name: "screen: change under a datum is counted but no longer listed with its datum flag",
    file: TX_SUMMARY,
    from: "      if (datum) {\n        toSelfWithDatum.push({",
    to: "      if (false /* MUT_TS_SELF_DATUM_LIST */) {\n        toSelfWithDatum.push({",
    marker: "MUT_TS_SELF_DATUM_LIST",
  },
  {
    name: "approval window: the change-under-a-datum section is not rendered",
    file: TX_SUMMARY_VIEW,
    from: "{summary.toSelfWithDatum.length > 0 && (",
    to: "{false /* MUT_VIEW_SELF_DATUM */ && (",
    marker: "MUT_VIEW_SELF_DATUM",
  },
  // ── The one rule for own UTxOs, and every reader that must use it ──
  {
    name: "own-utxo rule: a UTxO carrying a reference script is the wallet's to spend",
    file: OWN_UTXO,
    from: "  if (o.referenceScript) return false;",
    to: "  if (false /* MUT_OWN_REFSCRIPT */) return false;",
    marker: "MUT_OWN_REFSCRIPT",
  },
  {
    name: "own-utxo rule: a datum at a script address is the wallet's to spend",
    file: OWN_UTXO,
    from: "  if (o.datum && !paymentCredentialIsKey(o.addressHex)) return false;",
    to: "  if (false /* MUT_OWN_SCRIPT_DATUM */) return false;",
    marker: "MUT_OWN_SCRIPT_DATUM",
  },
  {
    name: "own-utxo rule: an inline datum that is not hex is read as a datum",
    file: OWN_UTXO,
    from: '    if (typeof inline !== "string" || !HEX_RE.test(inline)) {',
    to: "    if (false /* MUT_READ_DATUM_SHAPE */) {",
    marker: "MUT_READ_DATUM_SHAPE",
  },
  {
    name: "own-utxo rule: a datum hash that is not 32 bytes of hex is read as a datum",
    file: OWN_UTXO,
    from: '    if (typeof hash !== "string" || !/^[0-9a-f]{64}$/i.test(hash)) {',
    to: "    if (false /* MUT_READ_HASH_SHAPE */) {",
    marker: "MUT_READ_HASH_SHAPE",
  },
  {
    name: "Koios reader: drifts back to skipping every inline datum",
    file: PROVIDER,
    from: "    const chainDatum = readChainDatum(inlineHex, r.datum_hash, where);",
    to:
      "    if (r.inline_datum != null) continue; /* MUT_KOIOS_OLD_SKIP */\n" +
      "    const chainDatum = readChainDatum(inlineHex, r.datum_hash, where);",
    marker: "MUT_KOIOS_OLD_SKIP",
  },
  {
    name: "Koios reader: an inline datum not shaped { bytes } is read as no datum",
    file: PROVIDER,
    from: '      if (typeof d !== "object" || typeof d.bytes !== "string") {',
    to: "      if (false /* MUT_KOIOS_DATUM_SHAPE */) {",
    marker: "MUT_KOIOS_DATUM_SHAPE",
  },
  {
    name: "Blockfrost reader: drifts back to skipping every datum",
    file: BLOCKFROST,
    from: "      const chainDatum = readChainDatum(r.inline_datum, r.data_hash, `${r.tx_hash}#${r.output_index}`);",
    to:
      "      if (r.inline_datum != null || r.data_hash != null) continue; /* MUT_BF_OLD_SKIP */\n" +
      "      const chainDatum = readChainDatum(r.inline_datum, r.data_hash, `${r.tx_hash}#${r.output_index}`);",
    marker: "MUT_BF_OLD_SKIP",
  },
  {
    name: "CIP-30 reader: drifts back to skipping every datum",
    file: TX,
    from: '    if (!walletOwnsOutput({ addressHex: addrBuf.toString("hex"), datum, referenceScript })) continue;',
    to:
      "    if (datum) continue; /* MUT_CIP30_OLD_SKIP */\n" +
      '    if (!walletOwnsOutput({ addressHex: addrBuf.toString("hex"), datum, referenceScript })) continue;',
    marker: "MUT_CIP30_OLD_SKIP",
  },
  {
    name: "getUtxos: an input under a datum is described to the dApp without it",
    file: UTXO_CBOR,
    from: '    if (d === undefined) return Encoder.encode([ref, [addr, value]]).toString("hex");',
    to: '    if (true /* MUT_CBOR_DATUM */) return Encoder.encode([ref, [addr, value]]).toString("hex");',
    marker: "MUT_CBOR_DATUM",
  },
  {
    name: "getUtxos: an inline datum that is not hex is encoded anyway",
    file: UTXO_CBOR,
    from: '    if (d.kind === "inline" && HEX_RE.test(d.cborHex) && d.cborHex.length > 0) {',
    to: '    if (d.kind === "inline" /* MUT_CBOR_INLINE_SHAPE */) {',
    marker: "MUT_CBOR_INLINE_SHAPE",
  },
  {
    name: "getUtxos: a datum hash that is not 32 bytes is encoded anyway",
    file: UTXO_CBOR,
    from: '    } else if (d.kind === "hash" && /^[0-9a-f]{64}$/i.test(d.hashHex)) {',
    to: '    } else if (d.kind === "hash" /* MUT_CBOR_HASH_SHAPE */) {',
    marker: "MUT_CBOR_HASH_SHAPE",
  },
  {
    name: "screen: a collateral return carrying a datum is described",
    file: TX_SUMMARY,
    from: "if (r.datum) bad(\"this transaction's collateral return carries a datum",
    to: "if (false /* MUT_TS_COLL_RET_DATUM */) bad(\"this transaction's collateral return carries a datum",
    marker: "MUT_TS_COLL_RET_DATUM",
  },
  {
    // The coin filter alone is redundant now (`consider` checks the total), so
    // the mutant removes both: what it measures is "a single coin over the cap
    // is offered", not "one of two equal checks was dropped".
    name: "getCollateral offers a single coin larger than the 5 ADA cap",
    edits: [
      {
        file: UTXO_SELECT,
        from: ".filter((i) => (i.tokens ?? []).length === 0 && lovelaceOf(i) <= COLLATERAL_CAP_LOVELACE)",
        to: ".filter((i) => (i.tokens ?? []).length === 0)",
      },
      {
        file: UTXO_SELECT,
        from: "if (sum < target || sum > COLLATERAL_CAP_LOVELACE) return;",
        to: "if (sum < target || (coins.length > 1 && sum > COLLATERAL_CAP_LOVELACE /* MUT_COLL_COIN_CAP */)) return;",
      },
    ],
    marker: "MUT_COLL_COIN_CAP",
  },
  {
    name: "getCollateral combines coins whose sum is over the 5 ADA cap",
    file: UTXO_SELECT,
    from: "if (sum < target || sum > COLLATERAL_CAP_LOVELACE) return;",
    to: "if (sum < target || (coins.length === 1 && sum > COLLATERAL_CAP_LOVELACE /* MUT_COLL_SUM_CAP */)) return;",
    marker: "MUT_COLL_SUM_CAP",
  },
  {
    name: "getCollateral never tries two coins (the greedy miss: 4 / 2.5 / 2.5 for 4.5 ADA)",
    file: UTXO_SELECT,
    from: "      consider([pool[a]!, pool[b]!]);",
    to: "      void 0; /* MUT_COLL_PAIRS */",
    marker: "MUT_COLL_PAIRS",
  },
  {
    name: "getCollateral takes a single coin over a set with a smaller total",
    file: UTXO_SELECT,
    from: "if (single) consider([single]);",
    to: "if (single) return [single]; /* MUT_COLL_SINGLE_FIRST */",
    marker: "MUT_COLL_SINGLE_FIRST",
  },
  {
    name: "getCollateral searches the smallest sub-target coins, which dust can fill",
    file: UTXO_SELECT,
    from: "below.slice(below.length - COLLATERAL_SEARCH_POOL)",
    to: "below.slice(0, COLLATERAL_SEARCH_POOL) /* MUT_COLL_POOL_SMALLEST */",
    marker: "MUT_COLL_POOL_SMALLEST",
  },
  {
    name: "screen: a withdrawal from someone else's reward account reads as 'your staking rewards'",
    file: TX_SUMMARY_VIEW,
    from: "{summary.withdrawals - summary.foreignWithdrawals > 0 && (",
    to: "{summary.withdrawals /* MUT_VIEW_OWN_WD */ > 0 && (",
    marker: "MUT_VIEW_OWN_WD",
  },
  {
    name: "signData shows right-to-left text as text",
    file: SIGN_DATA,
    from: "if (RIGHT_TO_LEFT.test(text)) return null;",
    to: "if (false /* MUT_SD_RTL */) return null;",
    marker: "MUT_SD_RTL",
  },
  {
    name: "signData's right-to-left check goes back to the seven scripts the old list named",
    file: SIGN_DATA,
    from: "const RIGHT_TO_LEFT = /[\\u0590-\\u08ff\\ufb1d-\\ufdff\\ufe70-\\ufeff\\u{10800}-\\u{10fff}\\u{1e800}-\\u{1efff}]/u;",
    to: "const RIGHT_TO_LEFT = /* MUT_SD_RTL_SEVEN */ /[\\p{Script=Hebrew}\\p{Script=Arabic}\\p{Script=Syriac}\\p{Script=Thaana}\\p{Script=Nko}\\p{Script=Samaritan}\\p{Script=Mandaic}]/u;",
    marker: "MUT_SD_RTL_SEVEN",
  },
  {
    name: "signData shows format characters (Cf) as text",
    file: SIGN_DATA,
    from: "const NOT_DRAWN_AS_ITSELF = /[\\p{Cf}\\p{Zl}",
    to: "const NOT_DRAWN_AS_ITSELF = /* MUT_SD_CF */ /[\\p{Zl}",
    marker: "MUT_SD_CF",
  },
  {
    name: "signData shows the line and paragraph separators (Zl, Zp) as text",
    file: SIGN_DATA,
    // The marker sits outside the regex: inside a character class, `/* … */`
    // is a list of characters, and the class would refuse every letter.
    from: "const NOT_DRAWN_AS_ITSELF = /[\\p{Cf}\\p{Zl}\\p{Zp}\\p{Co}",
    to: "const NOT_DRAWN_AS_ITSELF = /* MUT_SD_ZLZP */ /[\\p{Cf}\\p{Co}",
    marker: "MUT_SD_ZLZP",
  },
  {
    name: "signData shows private-use code points (Co) as text",
    file: SIGN_DATA,
    from: "\\p{Co}\\p{Cn}]/u;",
    to: "\\p{Cn}]/u; /* MUT_SD_CO */",
    marker: "MUT_SD_CO",
  },
  {
    name: "signData shows unassigned code points (Cn) as text",
    file: SIGN_DATA,
    from: "\\p{Co}\\p{Cn}]/u;",
    to: "\\p{Co}]/u; /* MUT_SD_CN */",
    marker: "MUT_SD_CN",
  },
  {
    name: "Sign reads the wallet again instead of signing from the view the summary used",
    file: APPROVE,
    from: "const witnessSetHex = signForeignTx(cbor, account, phase.view, partial);",
    to: "const witnessSetHex = signForeignTx(cbor, account, walletViewFrom(await localPort(account).getInputs(), await localPort(account).getOwnedAddressesHex()) /* MUT_SIGN_REREAD */, partial);",
    marker: "MUT_SIGN_REREAD",
  },
  {
    name: "the signer no longer applies the screen's refusals (field 22, foreign collateral return, …)",
    file: SIGN_FOREIGN,
    // An empty summary, so the withdrawal rule below it still has a list to read.
    from: "    summary = summariseTx(txCborHex, view.ownAddressesHex, view.held, ledgerNetworkId);",
    to: "    summary = { ownRewardKeyHashes: [] } as unknown as TxSummary; /* MUT_SIGN_SHARED_RULES */",
    marker: "MUT_SIGN_SHARED_RULES",
  },
  {
    name: "a body naming the same input twice is counted twice",
    file: TX_SUMMARY,
    from: 'if (seenInputs.has(ref)) bad("this transaction names the same input twice");',
    to: 'if (false /* MUT_TS_DUP_INPUT */) bad("this transaction names the same input twice");',
    marker: "MUT_TS_DUP_INPUT",
  },
  {
    name: "the worker lets any extension page's port attach as a site's wallet window",
    file: WORKER,
    from: "  if (!fromWalletWindow(port)) return;",
    to: "  if (false /* MUT_WORKER_SENDER */) return;",
    marker: "MUT_WORKER_SENDER",
  },
  {
    name: "the worker accepts any sender URL that merely starts with approve.html",
    file: WORKER,
    from: "return url === page || url.startsWith(`${page}?`) || url.startsWith(`${page}#`);",
    to: "return url.startsWith(page) /* MUT_WORKER_PREFIX */;",
    marker: "MUT_WORKER_PREFIX",
  },
  // ── Review round three: the collateral cap on the signing path, the stake
  // witness agreement, the script-beside-foreign-inputs warning, a late summary,
  // a window without an id, signData text rules and screen, the no-amount
  // collateral rule, and each recipient's tokens and datum flag. ──
  {
    name: "approval window: a summary read for a request the person has left still lands (no cancel flag)",
    file: APPROVE,
    from: "        if (!cancelled) setPhase((cur) => (stillOnScreen(cur) ? { ...cur, summary, view } : cur));",
    to: "        /* MUT_APPROVE_CANCELLED */ setPhase((cur) => (stillOnScreen(cur) ? { ...cur, summary, view } : cur));",
    marker: "MUT_APPROVE_CANCELLED",
  },
  {
    name: "approval window: decidingFor accepts any decide screen, not only the one for this request",
    file: APPROVE,
    from: "  return cur.at === \"decide\" && cur.req === req;",
    to: "  return cur.at === \"decide\" /* MUT_APPROVE_REQ_GUARD */;",
    marker: "MUT_APPROVE_REQ_GUARD",
  },
  {
    name: "worker: a window opened without an id is waited on forever",
    file: WORKER,
    from: "    if (typeof created?.id !== \"number\") {",
    to: "    if (false /* MUT_WORKER_WINDOW_ID */) {",
    marker: "MUT_WORKER_WINDOW_ID",
  },
  {
    name: "signData shows DEL and the C1 controls (U+007F-U+009F) as text",
    file: SIGN_DATA,
    from: "  if (/[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f]/.test(text)) return null;",
    to: "  if (/[\\u0000-\\u0008\\u000b-\\u001f]/.test(text) /* MUT_SIGNDATA_C1 */) return null;",
    marker: "MUT_SIGNDATA_C1",
  },
  {
    name: "signData shows default-ignorable code points as text",
    file: SIGN_DATA,
    from: "  if (DRAWN_AS_NOTHING.test(text.replace(EMOJI_PRESENTATION, \"$1\"))) return null;",
    to: "  /* MUT_SIGNDATA_IGNORABLE */",
    marker: "MUT_SIGNDATA_IGNORABLE",
  },
  {
    name: "signData refuses a heart with its emoji presentation selector",
    file: SIGN_DATA,
    from: "  if (DRAWN_AS_NOTHING.test(text.replace(EMOJI_PRESENTATION, \"$1\"))) return null;",
    to: "  if (DRAWN_AS_NOTHING.test(text) /* MUT_SIGNDATA_EMOJI_VS */) return null;",
    marker: "MUT_SIGNDATA_EMOJI_VS",
  },
  {
    name: "signData shows text with three or more blank lines in a row",
    file: SIGN_DATA,
    from: "  if (BLANK_LINES.test(shape)) return null;",
    to: "  /* MUT_SIGNDATA_BLANK_LINES */",
    marker: "MUT_SIGNDATA_BLANK_LINES",
  },
  {
    name: "signData shows text that ends after several line breaks",
    file: SIGN_DATA,
    from: "  if (edges.some((w) => w.length > MAX_EDGE_WHITESPACE || w.split(\"\\n\").length > 2)) return null;",
    to: "  if (edges.some((w) => w.length > MAX_EDGE_WHITESPACE) /* MUT_SIGNDATA_EDGE_WS */) return null;",
    marker: "MUT_SIGNDATA_EDGE_WS",
  },
  {
    name: "signData counts only spaces and tabs as blank between line breaks",
    file: SIGN_DATA,
    from: "const BLANK_LINES = new RegExp(String.raw`\\n${INKLESS}*\\n${INKLESS}*\\n${INKLESS}*\\n`, \"u\");",
    to: "const BLANK_LINES = /* MUT_SIGNDATA_BLANK_SPACE_TAB */ /\\n[ \\t]*\\n[ \\t]*\\n[ \\t]*\\n/;",
    marker: "MUT_SIGNDATA_BLANK_SPACE_TAB",
  },
  {
    name: "signData's edge rule goes back to \\s, which has no Braille blank",
    edits: [
      {
        file: SIGN_DATA,
        from: "const LEADING_BLANK = new RegExp(String.raw`^(?:${INKLESS}|\\n)+`, \"u\");",
        to: "const LEADING_BLANK = /* MUT_SIGNDATA_EDGE_BACKSLASH_S */ /^\\s+/;",
      },
      {
        file: SIGN_DATA,
        from: "const TRAILING_BLANK = new RegExp(String.raw`(?:${INKLESS}|\\n)+$`, \"u\");",
        to: "const TRAILING_BLANK = /\\s+$/;",
      },
    ],
    marker: "MUT_SIGNDATA_EDGE_BACKSLASH_S",
  },
  {
    name: "signData's blank set drops the Braille blank U+2800",
    file: SIGN_DATA,
    from: "const INKLESS = String.raw`(?:(?!\\n)[\\p{White_Space}\\u2800\\u115f\\u1160\\u3164\\uffa0])`;",
    to: "const INKLESS = String.raw`(?:(?!\\n)[\\p{White_Space}\\u115f\\u1160\\u3164\\uffa0])` /* MUT_SIGNDATA_NO_BRAILLE */;",
    marker: "MUT_SIGNDATA_NO_BRAILLE",
  },
  {
    name: "signData's blank set is only space and tab again",
    file: SIGN_DATA,
    from: "const INKLESS = String.raw`(?:(?!\\n)[\\p{White_Space}\\u2800\\u115f\\u1160\\u3164\\uffa0])`;",
    to: "const INKLESS = String.raw`(?:[ \\t])` /* MUT_SIGNDATA_INKLESS_SPACE_TAB */;",
    marker: "MUT_SIGNDATA_INKLESS_SPACE_TAB",
  },
  {
    name: "signData counts a combining mark on blank space as ink again",
    file: SIGN_DATA,
    from: '      out += onBlank ? " " : c;',
    to: "      out += c; /* MUT_SIGNDATA_STRAY_MARK_INK */",
    marker: "MUT_SIGNDATA_STRAY_MARK_INK",
  },
  {
    name: "signData no longer measures how blank a long line is",
    file: SIGN_DATA,
    from: "  if (mostlyBlank(shape)) return null;",
    to: "  /* MUT_SIGNDATA_NO_DENSITY */",
    marker: "MUT_SIGNDATA_NO_DENSITY",
  },
  {
    name: "signData's density limit lets a line through at 49 blanks in 64",
    file: SIGN_DATA,
    from: "      if (i >= DENSITY_WINDOW - 1 && blanks > MAX_BLANKS_PER_WINDOW) return true;",
    to: "      if (i >= DENSITY_WINDOW - 1 && blanks > MAX_BLANKS_PER_WINDOW + 1) return true; /* MUT_SIGNDATA_DENSITY_OFF_BY_ONE */",
    marker: "MUT_SIGNDATA_DENSITY_OFF_BY_ONE",
  },
  {
    name: "signData shows a long blank run in the middle of a line as text",
    file: SIGN_DATA,
    from: "  if (LONG_INKLESS_RUN.test(shape)) return null;",
    to: "  /* MUT_SIGNDATA_MID_RUN */",
    marker: "MUT_SIGNDATA_MID_RUN",
  },
  {
    name: "signData lets 17 blank characters in a row through",
    file: SIGN_DATA,
    from: "const LONG_INKLESS_RUN = new RegExp(String.raw`${INKLESS}{${MAX_EDGE_WHITESPACE + 1}}`, \"u\");",
    to: "const LONG_INKLESS_RUN = new RegExp(String.raw`${INKLESS}{${MAX_EDGE_WHITESPACE + 2}}`, \"u\") /* MUT_SIGNDATA_MID_RUN_BOUND */;",
    marker: "MUT_SIGNDATA_MID_RUN_BOUND",
  },
  {
    name: "signData shows stacked combining marks as text",
    file: SIGN_DATA,
    from: "  if (STACKED_MARKS.test(text)) return null;",
    to: "  /* MUT_SIGNDATA_STACKED_MARKS */",
    marker: "MUT_SIGNDATA_STACKED_MARKS",
  },
  {
    name: "signData lets four combining marks in a row through",
    file: SIGN_DATA,
    from: "const STACKED_MARKS = /\\p{M}{4}/u;",
    to: "const STACKED_MARKS = /\\p{M}{5}/u /* MUT_SIGNDATA_MARKS_BOUND */;",
    marker: "MUT_SIGNDATA_MARKS_BOUND",
  },
  {
    name: "signData shows a grapheme cluster of any length as text",
    file: SIGN_DATA,
    from: "    if ([...segment].length > MAX_CLUSTER_CODE_POINTS) return null;",
    to: "    if ([...segment].length > MAX_CLUSTER_CODE_POINTS) continue /* MUT_SIGNDATA_CLUSTER */;",
    marker: "MUT_SIGNDATA_CLUSTER",
  },
  {
    name: "signData lets a 17-code-point grapheme cluster through",
    file: SIGN_DATA,
    from: "const MAX_CLUSTER_CODE_POINTS = 16;",
    to: "const MAX_CLUSTER_CODE_POINTS = 17 /* MUT_SIGNDATA_CLUSTER_BOUND */;",
    marker: "MUT_SIGNDATA_CLUSTER_BOUND",
  },
  {
    name: "signData shows text unchecked when the engine has no Intl.Segmenter",
    file: SIGN_DATA,
    from: "  if (typeof Intl === \"undefined\" || typeof Intl.Segmenter !== \"function\") return null;",
    to: "  if (typeof Intl === \"undefined\" || typeof Intl.Segmenter !== \"function\") return text /* MUT_SIGNDATA_NO_SEGMENTER */;",
    marker: "MUT_SIGNDATA_NO_SEGMENTER",
  },
  {
    name: "signData screen calls every key the stake key",
    file: DATA_SIGN_VIEW,
    from: "        {plan.kind === \"stake\" ? t(\"cip30_sign_data_key_stake\") : t(\"cip30_sign_data_key_payment\")}",
    to: "        {/* MUT_DATASIGN_KIND */ t(\"cip30_sign_data_key_stake\")}",
    marker: "MUT_DATASIGN_KIND",
  },
  {
    name: "signData screen labels a hex-only message as a text message",
    file: DATA_SIGN_VIEW,
    from: "        <p className=\"approve-note\">{t(\"cip30_sign_data_message_hex\")}</p>",
    to: "        <p className=\"approve-note\">{t(\"cip30_sign_data_message\") /* MUT_DATASIGN_HEX_LABEL */}</p>",
    marker: "MUT_DATASIGN_HEX_LABEL",
  },
  {
    name: "signData screen prints a wrong line count",
    file: DATA_SIGN_VIEW,
    from: "        {t(\"cip30_sign_data_size\", { bytes: size.bytes, lines: size.lines })}",
    to: "        {t(\"cip30_sign_data_size\", { bytes: size.bytes, lines: 1 /* MUT_DATASIGN_SIZE */ })}",
    marker: "MUT_DATASIGN_SIZE",
  },
  {
    name: "signData screen puts the message text in the scrolling box",
    file: DATA_SIGN_VIEW,
    from: "          <pre className=\"mono approve-sign-data\" data-testid=\"sign-data-text\">",
    to: "          <pre className=\"mono approve-sign-data approve-sign-data-scroll /* MUT_DATASIGN_TEXT_CUT */\" data-testid=\"sign-data-text\">",
    marker: "MUT_DATASIGN_TEXT_CUT",
  },
  {
    name: "signData message text box is cut to a height again in popup.css",
    file: POPUP_CSS,
    from: ".approve-sign-data { white-space: pre-wrap; word-break: break-all; overflow-wrap: anywhere; margin: 0; }",
    to: ".approve-sign-data { white-space: pre-wrap; word-break: break-all; overflow-wrap: anywhere; margin: 0; max-height: 160px; overflow-y: auto; /* MUT_POPUP_SIGN_DATA_CUT */ }",
    marker: "MUT_POPUP_SIGN_DATA_CUT",
  },
  {
    name: "signData text box lets a no-break-space run push the letters out of the box again",
    file: POPUP_CSS,
    from: ".approve-sign-data { white-space: pre-wrap; word-break: break-all; overflow-wrap: anywhere; margin: 0; }",
    to: ".approve-sign-data { white-space: pre-wrap; word-break: break-all; margin: 0; /* MUT_POPUP_SIGN_DATA_NO_WRAP_ANYWHERE */ }",
    marker: "MUT_POPUP_SIGN_DATA_NO_WRAP_ANYWHERE",
  },
  {
    name: "collateral that can lose more than 5 ADA is described and signed",
    file: TX_SUMMARY,
    from: "  if (risk > COLLATERAL_CAP_LOVELACE) {",
    to: "  if (false /* MUT_TS_COLL_OVER_CAP */) {",
    marker: "MUT_TS_COLL_OVER_CAP",
  },
  {
    name: "collateral holding tokens the return does not give back is described and signed",
    file: TX_SUMMARY,
    from: "    if ((retAssets.get(unit) ?? BigInt(0)) < qty) {",
    to: "    if (false /* MUT_TS_COLL_TOKENS */) {",
    marker: "MUT_TS_COLL_TOKENS",
  },
  {
    name: "the signer refuses the collateral cap under a generic key, not the screen's",
    file: SIGN_FOREIGN,
    from: "throw new LocalSignError(e.key ?? \"sign_foreign_undescribable\", e.message);",
    to: "throw new LocalSignError(\"sign_foreign_undescribable\" /* MUT_SIGN_KEEP_KEY */, e.message);",
    marker: "MUT_SIGN_KEEP_KEY",
  },
  {
    name: "the signer adds the stake witness when the account key and the summary disagree",
    file: SIGN_FOREIGN,
    from: "      if (accountKey !== counted.has(stakeHash)) {",
    to: "      if (false /* MUT_SIGN_STAKE_MISMATCH */) {",
    marker: "MUT_SIGN_STAKE_MISMATCH",
  },
  {
    name: "summary does not count inputs that are not this wallet's when a script runs",
    file: TX_SUMMARY,
    from: "  const foreignInputsUnderScript = scriptRuns ? inputList.length - mineCount : 0;",
    to: "  const foreignInputsUnderScript = 0; /* MUT_TS_SCRIPT_FOREIGN */ void scriptRuns;",
    marker: "MUT_TS_SCRIPT_FOREIGN",
  },
  {
    name: "screen: the script-beside-foreign-inputs warning is never shown",
    file: TX_SUMMARY_VIEW,
    from: "      {summary.foreignInputsUnderScript > 0 && (",
    to: "      {false /* MUT_VIEW_SCRIPT_FOREIGN */ && (",
    marker: "MUT_VIEW_SCRIPT_FOREIGN",
  },
  {
    name: "getCollateral() with no amount asks for exactly 5 ADA again",
    file: APPROVE,
    from: "        let target: bigint | undefined;\n",
    to: "        let target: bigint | undefined = COLLATERAL_CAP_LOVELACE; /* MUT_COLL_NOAMOUNT */\n",
    marker: "MUT_COLL_NOAMOUNT",
  },
  {
    name: "getCollateral() with no amount offers less than 1 ADA",
    file: UTXO_SELECT,
    from: "found.sum >= COLLATERAL_FLOOR_LOVELACE ?",
    to: "true /* MUT_COLL_FLOOR */ ?",
    marker: "MUT_COLL_FLOOR",
  },
  {
    name: "getCollateral() with no amount takes the smallest set, not the largest",
    file: UTXO_SELECT,
    from: "      if (sum < best.sum) return;",
    to: "      if (sum > best.sum) return; /* MUT_COLL_LARGEST */",
    marker: "MUT_COLL_LARGEST",
  },
  {
    name: "screen: a recipient's tokens are not printed on its line",
    file: TX_SUMMARY_VIEW,
    from: "the number is the decision. */}\n                <b>{formatAda(r.lovelace)} ADA</b>\n                {r.assets.map((a) => (",
    to: "the number is the decision. */}\n                <b>{formatAda(r.lovelace)} ADA</b>\n                {r.assets.filter(() => false /* MUT_VIEW_RECIPIENT_ASSETS */).map((a) => (",
    marker: "MUT_VIEW_RECIPIENT_ASSETS",
  },
  {
    name: "screen: a recipient's datum flag is not printed",
    file: TX_SUMMARY_VIEW,
    from: "{r.datum && <span className=\"approve-note\">{t(\"cip30_output_datum\")}</span>}",
    to: "{false /* MUT_VIEW_RECIPIENT_DATUM */ && <span className=\"approve-note\">{t(\"cip30_output_datum\")}</span>}",
    marker: "MUT_VIEW_RECIPIENT_DATUM",
  },
  // ── The grader of this file. Each rule in classifyRun deleted on its own:
  // a rule no test needs is a rule a refactor drops without a sound. The
  // runner has already imported the unmutated grader, so these runs are
  // graded by the real one. ──
  ...[
    ["a failed suite", "/Failed Suites|Unhandled Errors?|Transform failed/", "/MUT_CLASSIFY_SUITES|Unhandled Errors?|Transform failed/"],
    ["a transform failure", "/Failed Suites|Unhandled Errors?|Transform failed/", "/Failed Suites|Unhandled Errors?|MUT_CLASSIFY_TRANSFORM/"],
    ["the FAIL-header anchor of", 'const AFTER_FAIL = "^[ \\\\t]*FAIL[ \\\\t][^\\\\n]*\\\\n[ \\\\t]*(?:";', 'const AFTER_FAIL = "^\\\\s*(?:" /* MUT_CLASSIFY_ANCHOR */;'],
    ["the type-checked switch of", "  if ((compiled ? COMPILER_MISSES : TYPO_CLASS).test(text)) return \"broken\";", "  if (TYPO_CLASS.test(text) /* MUT_CLASSIFY_IGNORE_COMPILED */) return \"broken\";"],
    ["`is not defined` after a type-check among", 'const COMPILER_MISSES = new RegExp(AFTER_FAIL + ["ReferenceError: .* is not defined", "SyntaxError: "]', 'const COMPILER_MISSES = new RegExp(AFTER_FAIL + ["MUT_CLASSIFY_COMPILED_REF", "SyntaxError: "]'],
    ["a SyntaxError among", '      "SyntaxError: ",', '      "MUT_CLASSIFY_SYNTAX",'],
    ["`is not a function` among", '      "TypeError: .* is not a function",', '      "MUT_CLASSIFY_NOT_FUNCTION",'],
    ["`before initialization` among", "      \"ReferenceError: Cannot access '.*' before initialization\",", '      "MUT_CLASSIFY_BEFORE_INIT",'],
    ["`is not a constructor` among", '      "TypeError: .* is not a constructor",', '      "MUT_CLASSIFY_NOT_CONSTRUCTOR",'],
    ["`is not iterable` among", '      "TypeError: .* is not iterable",', '      "MUT_CLASSIFY_NOT_ITERABLE",'],
  ].map(([what, from, to]) => ({
    name: `classify-run: ${what} the broken rules is no longer read`,
    file: CLASSIFY_RUN,
    from,
    to,
    marker: /MUT_CLASSIFY_[A-Z_]+/.exec(to)[0],
  })),
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

const VITEST = [
  "vitest",
  "run",
  "--pool=forks",
  "--poolOptions.forks.maxForks=3",
  "--poolOptions.forks.minForks=1",
  ...TESTS,
];

// "pass", "caught" or "broken" for one run; the rules and why are in
// scripts/lib/classify-run.mjs, kept apart so a test can import them.

// `compiled`: every file the mutant edits passed the type-check, so the
// grader can leave the run-time errors a fair mutant raises to the tests.
const runTests = (compiled = false) => {
  const r = spawnSync("npx", VITEST, {
    cwd: REPO,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    maxBuffer: 64 * 1024 * 1024,
  });
  return classifyRun(r.status ?? 1, `${r.stdout ?? ""}\n${r.stderr ?? ""}\n${r.error ? String(r.error) : ""}`, { compiled });
};

const editsOf = (m) => m.edits ?? [m];
// A name filter, for re-measuring the guards one change touched. The summary
// line says how many ran out of how many, so a filtered run cannot be read
// as the whole list.
//
// `--typecheck-only` runs the compile step below for every selected mutant and
// no test at all: it lists the mutants that would be graded broken before a
// test starts, in seconds rather than the hours a full run takes.
const args = process.argv.slice(2);
const typecheckOnly = args.includes("--typecheck-only");
const only = args.find((a) => !a.startsWith("--"));
const RUN = only ? MUTANTS.filter((m) => m.name.includes(only)) : MUTANTS;
if (RUN.length === 0) {
  console.error(`No mutant name contains ${JSON.stringify(only)}.`);
  process.exit(1);
}
const originals = new Map();
for (const m of MUTANTS) for (const e of editsOf(m)) if (!originals.has(e.file)) originals.set(e.file, read(e.file));
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
let broken = 0;
let uncompiled = 0;
let staleUndeclared = 0;

// The compile step, before any test: a misspelt name in a mutant's `to` is a
// broken mutant even when the code under test catches the error it raises at
// run time, which `classifyRun` — reading only vitest's output — cannot see.
// Why and how: scripts/lib/typecheck-mutant.mjs. Measured 2026-11-12: built
// once in ~1.4 s, then ~150 ms per mutant; a whole `tsc --noEmit` is ~3 s.
const typechecker = createTypechecker(REPO);
const typecheckBaseline = typechecker.baseline([...originals.keys()]);
if (typecheckBaseline.typo.length || typecheckBaseline.other.length) {
  console.error("The unmutated tree does not type-check — fix that first:\n  " +
    [...typecheckBaseline.typo, ...typecheckBaseline.other].map((d) => d.text).join("\n  "));
  process.exit(1);
}

try {
  // Refuse to grade anything if the tree is already red: every mutation would
  // read as "caught" for a reason that has nothing to do with the mutation.
  const baseline = typecheckOnly ? "pass" : runTests();
  if (baseline !== "pass") {
    console.error("Baseline is already failing — fix that first; mutation results\n" +
      `measured against a red baseline mean nothing (baseline: ${baseline}).`);
    process.exit(1);
  }

  for (const m of RUN) {
    // Edits apply in order, each to the file as the previous ones left it.
    const next = new Map();
    let miss;
    for (const e of editsOf(m)) {
      const src = next.get(e.file) ?? originals.get(e.file);
      const hits = src.split(e.from).length - 1;
      if (hits !== 1) {
        miss = `matched ${hits}× in ${e.file}; expected 1`;
        break;
      }
      next.set(e.file, src.replace(e.from, e.to));
    }
    if (miss) {
      console.error(`  ANCHOR  ← ${m.name}\n          (${miss})`);
      unanchored += 1;
      continue;
    }
    // Checked in memory, before anything is written: a mutant that does not
    // compile never touches the tree.
    const compiled = typechecker.check(next);
    // `undeclared`: names a mutant uses on purpose without declaring them, for
    // a gate that reads source and never runs it (see the copy-guard entries).
    const typo = compiled.typo.filter((d) => !(m.undeclared ?? []).includes(d.name));
    // A name listed there that no diagnostic names is stale: the mutant no
    // longer does what the entry says, or the name now resolves. Either way
    // the list is no longer what it claims, so it is reported, not ignored.
    const named = new Set(compiled.typo.map((d) => d.name));
    const stale = (m.undeclared ?? []).filter((n) => !named.has(n));
    if (stale.length) {
      console.error(`  UNDECLARED STALE  ← ${m.name}\n          (\`undeclared\` lists ${stale.map((n) => JSON.stringify(n)).join(", ")}, which no compile diagnostic names` +
        (compiled.unchecked.length ? `; ${compiled.unchecked.join(", ")} is outside tsconfig.json, so nothing can name it` : "") + ")");
      staleUndeclared += 1;
      continue;
    }
    if (compiled.unchecked.length) {
      if (typecheckOnly) console.log(`  UNCHECKED ← ${m.name}\n          (outside tsconfig.json: ${compiled.unchecked.join(", ")})`);
      uncompiled += 1;
    }
    if (compiled.other.length && typecheckOnly) {
      // A type change can be the point of a mutant, so it is shown, not graded.
      console.log(`  TYPE    ← ${m.name}\n          ${compiled.other.map((d) => d.text).join("\n          ")}`);
    }
    if (typo.length) {
      console.error(`  MUTANT BROKEN  ← ${m.name}\n          (does not compile: ${typo.map((d) => d.text).join("; ")})`);
      broken += 1;
      continue;
    }
    if (typecheckOnly) continue;
    for (const [rel, text] of next) write(rel, text);
    // The marker is read back from disk, not from `next`: a write that went
    // somewhere else would otherwise grade the unmutated file.
    if (m.marker && ![...next.keys()].some((rel) => read(rel).includes(m.marker))) {
      for (const rel of next.keys()) write(rel, originals.get(rel));
      console.error(`  ANCHOR  ← ${m.name}\n          (marker ${m.marker} not found on disk)`);
      unanchored += 1;
      continue;
    }
    const result = runTests(compiled.unchecked.length === 0);
    for (const rel of next.keys()) write(rel, originals.get(rel));
    if (result === "broken") {
      console.error(`  MUTANT BROKEN  ← ${m.name}\n          (no test failed on behaviour: a syntax, compile or load error, an unhandled error, or a typo-class error such as "x is not defined")`);
      broken += 1;
      continue;
    }
    const caught = result === "caught";
    console.log(`  ${caught ? "RED   " : "GREEN "}  ← ${m.name}`);
    if (!caught) survived += 1;
  }
} finally {
  restoreAll();
}

const bad = survived + unanchored + broken + staleUndeclared;
if (typecheckOnly) {
  // Nothing was graded: the line must not read as a pinned count.
  console.log(
    `\ntype-check only, no test ran: ${RUN.length - broken - unanchored - staleUndeclared}/${RUN.length} compile` +
      (only ? ` (filter ${JSON.stringify(only)}: ${RUN.length} of ${MUTANTS.length} mutants)` : "") +
      (broken ? ` · ${broken} MUTANT BROKEN (misspelt name)` : "") +
      (unanchored ? ` · ${unanchored} anchor(s) no longer match the source` : "") +
      (staleUndeclared ? ` · ${staleUndeclared} UNDECLARED STALE (an \`undeclared\` name no diagnostic names)` : "") +
      (uncompiled ? ` · ${uncompiled} edit a file outside tsconfig.json (not type-checked)` : ""),
  );
  process.exit(broken + unanchored + staleUndeclared === 0 ? 0 : 1);
}
console.log(
  `\n${RUN.length - bad}/${RUN.length} guards pinned` +
    (only ? ` (filter ${JSON.stringify(only)}: ${RUN.length} of ${MUTANTS.length} mutants)` : "") +
    (survived ? ` · ${survived} removable with every test still green` : "") +
    (unanchored ? ` · ${unanchored} anchor(s) no longer match the source` : "") +
    (broken ? ` · ${broken} MUTANT BROKEN (did not run as a test failure)` : "") +
    (staleUndeclared ? ` · ${staleUndeclared} UNDECLARED STALE (an \`undeclared\` name no diagnostic names)` : ""),
);
process.exit(bad === 0 ? 0 : 1);
