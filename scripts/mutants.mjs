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
// A gate is worth mutating too. "Is this guard pinned" and "is the thing that
// checks the guard pinned" are different questions, and the second one has gone
// unanswered here before: two table rows named after a detector were going red
// because a *count* elsewhere fell, not because the detector did its job.
const NOTICE_TEST = "src/components/wallet/__tests__/moneyNotice.test.ts";
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
];

/**
 * Each entry deletes or reverts exactly one guard. `from` must appear once —
 * if a refactor moves the code, this file fails loudly rather than quietly
 * measuring nothing, which is the failure mode it was written to prevent.
 */
const MUTANTS = [
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
    from: "          pieces.push(...via);",
    to: "          void via;",
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
    name: "collateral inputs (field 13) allowed again — a second spend path the approval screen cannot show",
    file: TX_SUMMARY,
    from: "  11, // script_data_hash\n",
    to: "  11, // script_data_hash\n  13,\n",
  },
  {
    name: "collateral return (field 16) allowed again — a second spend path the approval screen cannot show",
    file: TX_SUMMARY,
    from: "  11, // script_data_hash\n",
    to: "  11, // script_data_hash\n  16,\n",
  },
  {
    name: "collateral total (field 17) allowed again — a second spend path the approval screen cannot show",
    file: TX_SUMMARY,
    from: "  11, // script_data_hash\n",
    to: "  11, // script_data_hash\n  17,\n",
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

const editsOf = (m) => m.edits ?? [m];
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

try {
  // Refuse to grade anything if the tree is already red: every mutation would
  // read as "caught" for a reason that has nothing to do with the mutation.
  if (runTests() !== 0) {
    console.error("Baseline is already failing — fix that first; mutation results\n" +
      "measured against a red baseline mean nothing.");
    process.exit(1);
  }

  for (const m of MUTANTS) {
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
    for (const [rel, text] of next) write(rel, text);
    const caught = runTests() !== 0;
    for (const rel of next.keys()) write(rel, originals.get(rel));
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
