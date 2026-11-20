/**
 * The node answered, and the answer was no.
 *
 * Its own module, with no imports, because four files need it and any of the
 * obvious homes would close an import cycle.
 *
 * ## Why this has to be a distinct type
 *
 * A submit ends one of two ways, and the wallet must not confuse them:
 *
 * - **Rejected.** The node read the transaction and refused it — bad inputs,
 *   expired TTL, fee too low. Nothing was recorded, no hash exists anywhere,
 *   and the person should fix the transaction and send again.
 * - **Unknown.** The bytes went out and no answer came back. It may be
 *   on-chain. Sending again is how the same amount leaves twice, so the screen
 *   locks and asks for the hash to be looked up.
 *
 * Before this type existed, the local-signing path put *both* into
 * `SubmitUncertainError`, because the only thing it had to go on was a string.
 * The result was the worse half of each: a preprod wallet whose transaction the
 * node had definitively rejected showed the lock, the alarm, and an instruction
 * to go look up a hash that **does not exist on any explorer**. A person who
 * does what that screen asks finds nothing, and learns that this notice means
 * nothing — which is exactly how the one real occurrence gets dismissed.
 *
 * ## The 4xx / 5xx line
 *
 * Every `4xx` is *answered* as this transaction did not get in: usually the
 * node saying no, sometimes the provider failing before it reached one. Only
 * one 400 of that second kind has been measured as never reaching a node (see
 * `rejectionReasonForSite`); the rest are not proven pre-node either way, and
 * whether they should keep the id to look up instead is the open question in
 * issue #71. `5xx` is the node or a proxy failing, and a
 * failure on the way back cannot tell you whether the transaction got through
 * on the way in — so `5xx` stays **unknown**, along with timeouts and dropped
 * connections. The split is deliberately on the side of caution: a rejection
 * misread as unknown costs one confusing screen, while an unknown misread as a
 * rejection invites a second payment.
 */
export class SubmitRejectedError extends Error {
  constructor(
    /**
     * HTTP status from the submit endpoint — **4xx or 5xx**.
     *
     * It said "always 4xx", which was false and false in the direction that
     * costs money: both throw sites pass `res.status` for every non-ok reply.
     * A reader who believed it would take `instanceof SubmitRejectedError` as
     * enough and drop `isDefiniteRejection`, turning a 503 — a failure on the
     * way back, which says nothing about the way in — into "the node said no",
     * and inviting a second payment. Call `isDefiniteRejection` first.
     */
    readonly status: number,
    /** What the node said, already truncated by the caller. */
    readonly detail: string,
    /** Which endpoint answered, for a message a reader can act on. */
    readonly endpoint: string,
  ) {
    super(`${endpoint} → HTTP ${status}: ${detail}`);
    this.name = "SubmitRejectedError";
  }
}

/**
 * True when this error means the node definitively refused the transaction.
 *
 * A function rather than a bare `instanceof` at each call site: the status
 * check belongs with the type, and a caller that forgets it would treat a 5xx
 * as a rejection, which is the direction that loses money.
 */
export function isDefiniteRejection(err: unknown): err is SubmitRejectedError {
  return err instanceof SubmitRejectedError && err.status >= 400 && err.status < 500;
}

/**
 * What a website is told when its `submitTx` was refused and the reply carries
 * no ledger reason the site could act on. Fixed on purpose: see
 * `rejectionReasonForSite`.
 */
export const PROVIDER_REFUSED_REASON = "the wallet's chain provider refused the request";

/**
 * Words that only the ledger's own rule failures use.
 *
 * Era-prefixed constructors (`ConwayIncompleteWithdrawals`,
 * `ConwayMempoolFailure`, `BabbageOutputTooSmallUTxO`), the `…UTxO` rule names
 * (`BadInputsUTxO`, `ValueNotConservedUTxO`, `FeeTooSmallUTxO`), the failures
 * named after the ledger rule that raised them, which carry that rule's name in
 * capitals (`MissingVKeyWitnessesUTXOW`, `StakeKeyNotRegisteredDELEG`), the two
 * names a failing script reports (`ValidationTagMismatch`, `PlutusFailure`),
 * and the two wrappers a node puts around them. Those inner names are the ones
 * a developer acts on: without them a missing signature, a failing script and
 * an unregistered stake key all read as the same `ConwayUtxowFailure`.
 *
 * The era prefix does not count when an era *type tag* follows or is part of
 * the word (`ConwayEra`, `ShelleyBasedEraConway`, `ShelleyToBabbageEraBabbage`,
 * `ConwayEraOnwardsConway`), nor for an era's value type (`MaryValue`) or a
 * redeemer's purpose tag (`ConwaySpending`, `ConwayMinting`…): tags travel
 * inside provider errors that also carry internal paths (`connection to
 * /ipc/node.socket refused`), and none of them names a rule.
 *
 * Every name must stand as a token of its own: a word glued to a letter,
 * digit, `_`, `.`, `/`, `-`, `@` or `=`, preceded by `:`, `\`, `&` or `?`, or
 * followed by `:` and a word — is part of a host name, a path, a URL or a
 * `key=value` pair (`ConwayRelay01_internal`, `/var/run/ShelleyHost/x`,
 * `C:\relays\ConwayRelay`, `?a=1&ConwayRelayHost`,
 * `user@ConwayHostPrimary:5432`, `upstream=ConwayRelayEuWest`,
 * `PgPrimary:cexplorer`) and gives nothing, and so does
 * `TxValidationErrorInCardanoMode`. A name followed by `: ` and a message
 * (`ConwayNodeUnavailable: dial tcp …`) still stands alone.
 *
 * The match is on the *shape* of a name, not on a list of the ledger's rules:
 * `ConwayNodeUnavailable` or `LedgerUTxO` standing alone would pass too, and
 * so would one quoted as a JSON value (`"upstream":"ConwayRelayEuWest"`) —
 * quotes cannot be refused, because real rule names arrive quoted in a JSON
 * body. That is why only the matched names reach the site
 * (`rejectionReasonForSite`), never the text around them: a provider message
 * that happens to hold a rule-shaped word gives the site that one word, never
 * the address or path next to it.
 */
const LEDGER_REASON =
  /(?<![\w./@:=\\&?-])(?:(?:Shelley|Allegra|Mary|Alonzo|Babbage|Conway)(?!(?:Spending|Minting|Certifying|Rewarding|Voting|Proposing)\b)(?![A-Za-z]*Era|[A-Za-z]*Value\b)[A-Z][A-Za-z]+|[A-Z][A-Za-z]*UTxO|[A-Z][A-Za-z]*[a-z](?:UTXOW|UTXOS|UTXO|DELEGS|DELEG|DELPL|POOL|GOVCERT|CERTS|CERT|GOV|LEDGERS|LEDGER|PPUP|MIR)|ApplyTxError|TxValidationError|ValidationTagMismatch|PlutusFailure)(?![\w./@=-]|:\w)/g;

/**
 * How many characters of a refused body the two submit paths keep (Koios in
 * `provider.ts`, the chain endpoint in `blockfrost.ts`). Shared so
 * `ledgerNames` knows when the last word may have been cut in half.
 */
export const SUBMIT_DETAIL_LIMIT = 300;

/**
 * The ledger rules that wrap another rule's failure: `ApplyTxError`, a rule's
 * `…Failure` that carries the failure of the rule below it
 * (`ConwayUtxowFailure (UtxoFailure (UtxosFailure (…`, `ConwayCertsFailure
 * (CertFailure (DelegFailure (…`), and the Babbage-era bridge
 * (`AlonzoInBabbageUtxoPredFailure`).
 *
 * A closed set, unlike `LEDGER_REASON`: this decides whose *argument* is read,
 * and a provider's own `…Failure` (`ConwayRelayFailure`, `DbFailure`) must not
 * open one. `ConwayMempoolFailure` is left out on purpose: it carries free
 * text, not a rule.
 */
const NESTING_WRAPPER =
  /^(?:ApplyTxError|(?:Shelley|Allegra|Mary|Alonzo|Babbage|Conway)?(?:Utxow|Utxos|Utxo|Certs|Cert|Delegs|Deleg|Delpl|Pool|GovCert|Gov|Ledgers|Ledger|Ppup|Mir|Bbody)Failure|[A-Z][a-z]+In[A-Z][a-z]+(?:Utxow|Utxos|Utxo)PredFailure)$/;

/**
 * A name, then ` (`, then the constructor inside it. The inner name is a
 * lookahead, so the next match can start on it: `A (B (C` gives `A→B`, then
 * `B→C`.
 *
 * The inner one is the failure a ledger rule raised, read from where the node
 * puts it rather than from its spelling. `InsufficientCollateral`,
 * `WrongNetwork`, `PPViewHashesDontMatch`, `MissingRedeemers` carry no era
 * prefix and no rule suffix, and they are what tells one rejection from
 * another. It counts only when the outer name was itself accepted (by
 * `LEDGER_REASON`, or as the inner name of an accepted wrapper) and is a
 * `NESTING_WRAPPER`. So the chain is walked from the outside in, and
 * `DbFailure (Postgres10 …)` or `ConwayRelayFailure (Koios …)` gives nothing,
 * even after a real `ApplyTxError` in the same body.
 *
 * The inner name is letters only and stands as a token by the same rules as
 * `LEDGER_REASON`, so a numbered host (`ConwayUtxowFailure (ConwayRelay01)`)
 * or a `host:database` pair (`ConwayUtxowFailure (PgPrimary:cexplorer)`)
 * gives nothing — a wrapper the body earned, where the `ApplyTxError` gate in
 * `ledgerNames` is not what keeps the host home. A letters-only word
 * (`ApplyTxError (KoiosPrimaryReplica)`) is not kept out by that either; the
 * gate is what keeps it home.
 */
const WRAPPED_RULE = /(?<![\w./@:=\\&?-])([A-Z][A-Za-z]*) \((?=([A-Z][A-Za-z]*)(?![\w./@=-]|:\w))/g;

/**
 * Ledger rule names in `detail`, each once, in the order they appear.
 *
 * A body cut at `SUBMIT_DETAIL_LIMIT` may end inside a word, and the trailing
 * guard matches at the end of the string, so `…ValidationTa` would pass as a
 * name. When the body is that long, a name that touches its end is dropped.
 *
 * `ApplyTxError` opens its wrapper only when `ShelleyTxValidationError` was
 * accepted ahead of it. It is the one wrapper that also stands alone as a
 * name, so a provider's own message can carry the word with any letters-only
 * word in brackets behind it: measured, `upstream ApplyTxError
 * (KoiosPrimaryReplica) at pg` and `ApplyTxError (UtxoFailure
 * (InternalRelaySecret))` reached the site as `HTTP 400: ApplyTxError
 * KoiosPrimaryReplica` and `… UtxoFailure InternalRelaySecret`. Every
 * measured node body that wraps in `ApplyTxError (` carries
 * `ShelleyTxValidationError` ahead of the wrapper (`… ShelleyTxValidationError
 * ShelleyBasedEraConway (ApplyTxError (…`; the cardano-submit-api JSON quotes
 * it as a kind), so that is what earns the wrapper. Without it the wrapper
 * stays closed: the names that stand on their own still travel (`ApplyTxError
 * (ConwayUtxowFailure (BadInputsUTxO` gives all three), and a chain that hangs
 * only off the lone `ApplyTxError` stays home with it.
 */
function ledgerNames(detail: string): string[] {
  const accepted = new Map<number, string>();
  for (const m of detail.matchAll(LEDGER_REASON)) accepted.set(m.index, m[0]);
  // Where `ShelleyTxValidationError` was accepted — what earns an
  // `ApplyTxError (` wrapper (see above).
  const shelleyAt = [...accepted].filter(([, name]) => name === "ShelleyTxValidationError").map(([at]) => at);
  for (const m of detail.matchAll(WRAPPED_RULE)) {
    if (accepted.get(m.index) === m[1] && NESTING_WRAPPER.test(m[1])) {
      if (m[1] === "ApplyTxError" && !shelleyAt.some((at) => at < m.index)) continue;
      accepted.set(m.index + m[1].length + 2, m[2]);
    }
  }
  const found = [...accepted].sort((a, b) => a[0] - b[0]);
  const cut = detail.length >= SUBMIT_DETAIL_LIMIT;
  const whole = found.filter(([at, name]) => !(cut && at + name.length === detail.length));
  return [...new Set(whole.map(([, name]) => name))];
}

/**
 * The reason a website receives for a definite rejection.
 *
 * When the body names **ledger** rules, the site gets those names, each once,
 * in the order they appear in the body (`ShelleyTxValidationError ApplyTxError
 * ConwayUtxowFailure FeeTooSmallUTxO`) — the one thing its developer can act
 * on — and none of the text between them. That loses information, not only
 * words. Some of the dropped arguments are this transaction's own data, which
 * the site already has, but others are the ledger's own findings, and they go
 * with them: `FeeTooSmallUTxO (Mismatch {supplied = Coin 170000, required =
 * Coin 171234})` reaches the site without the required fee the ledger worked
 * out, and a `PlutusFailure` without its script trace. The names tell the
 * site which rule to fix; the numbers and the trace stay in the wallet's own
 * copy of the error. Any other words in the body are the provider's. A body
 * with no such name gets a fixed sentence, as does:
 *
 * - 401/403 an invalid or revoked project token, 402 a plan limit, 429 a rate
 *   limit. That body describes the person's account with the provider, not the
 *   transaction.
 * - A 400 that is not the ledger. The status alone does not say the node read
 *   anything: Koios was measured answering **400** with
 *   `TxCmdTxSubmitConnectionError: Network.Socket.connect: <socket: 14>: does
 *   not exist` — its own backend failing to reach a node — for the same bytes
 *   that, a moment earlier, got a real `ConwayIncompleteWithdrawals`. Passing
 *   that through tells a website how the wallet's provider is wired inside.
 *
 * The endpoint label is left out for every status. `message` starts with it
 * (`Koios /submittx`, `Chain endpoint /tx/submit`), and that tells the site
 * which provider this wallet uses and whether it is a custom one. The full
 * `message` stays available to the wallet's own code.
 *
 * This shapes the text only. Whether an error is a rejection at all is still
 * `isDefiniteRejection`'s call, made before this is reached. That call stays on
 * the status. Only the socket 400 above was measured as never reaching a
 * node; other non-ledger 400s are not proven pre-node either way — they are
 * still answered as a rejection, just not with the provider's words, and
 * whether they should keep the id to look up instead is the open question in
 * issue #71. A ledger refusal that a proxy turns into a 5xx
 * stays *unknown* — the direction that cannot cost a second payment.
 */
export function rejectionReasonForSite(err: SubmitRejectedError): string {
  if (err.status !== 400) return PROVIDER_REFUSED_REASON;
  const names = ledgerNames(err.detail);
  if (names.length === 0) return PROVIDER_REFUSED_REASON;
  return `HTTP 400: ${names.join(" ")}`;
}
