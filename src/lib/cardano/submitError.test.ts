import { describe, it, expect, afterEach, vi } from "vitest";
import { submitTx } from "./provider";
import { bfSubmitTx } from "./blockfrost";
import {
  PROVIDER_REFUSED_REASON,
  SUBMIT_DETAIL_LIMIT,
  SubmitRejectedError,
  isDefiniteRejection,
  rejectionReasonForSite,
} from "./submitError";

/**
 * Both submit doors report a rejection as a *type*, not as a sentence.
 *
 * The filter that uses this already had tests, and they proved nothing about
 * this half: they handed `signAndSubmitLocal` a ready-made `SubmitRejectedError`
 * and checked it passed through. Measured — replacing either `throw new
 * SubmitRejectedError(…)` with a plain `throw new Error(\`… HTTP …\`)` left the
 * whole suite green. The classic shape: the right sentence was asserted present,
 * the wrong one was never asserted absent, and the two ends were never joined.
 *
 * What a regression there costs, concretely: a local wallet submits on preprod,
 * the node refuses it outright (`BadInputsUTxO`, expired TTL, fee too low), the
 * 4xx arrives as an untyped `Error`, `isDefiniteRejection` says no, and the
 * wallet locks every money screen and tells the reader to look up a transaction
 * id that exists nowhere. That is the exact defect this type was added to
 * remove, rebuilt with nothing going red.
 *
 * Two doors, because there are two: Koios and the Blockfrost-shaped endpoint.
 * Leaving one untested is how a caller ends up filtering the one it has seen.
 */

const PREPROD = 0 as const;
const SIGNED = "84a4".padEnd(64, "0");
const BF = { base: "https://chain.example/api/v0", projectId: "" };

afterEach(() => {
  vi.unstubAllGlobals();
});

const stub = (status: number, body: string) =>
  vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status })));

const DOORS: Array<[string, () => Promise<string>]> = [
  ["Koios", () => submitTx(PREPROD, SIGNED)],
  ["Blockfrost-shaped", () => bfSubmitTx(BF, SIGNED)],
];

describe("submit > a rejection arrives as SubmitRejectedError, from either door", () => {
  for (const [door, call] of DOORS) {
    it(`${door}: a 400 is typed, carries the status, and counts as definite`, async () => {
      stub(400, "BadInputsUTxO (TxIn (TxId ...))");
      const err = await call().catch((e: unknown) => e);
      expect(err, door).toBeInstanceOf(SubmitRejectedError);
      expect((err as SubmitRejectedError).status, door).toBe(400);
      expect(isDefiniteRejection(err), door).toBe(true);
      // The node's own words survive to the screen. "Something went wrong"
      // cannot tell anyone which input was bad.
      expect((err as Error).message, door).toContain("BadInputsUTxO");
    });

    it(`${door}: a 503 is typed too, and does NOT count as definite`, async () => {
      // The boundary from the other side, and the half that loses money if it
      // slips: a gateway that dies *after* forwarding the transaction produces
      // a 5xx, and that transaction may well be on chain. Treating it as a
      // refusal invites a second payment.
      stub(503, "upstream unavailable");
      const err = await call().catch((e: unknown) => e);
      expect(err, door).toBeInstanceOf(SubmitRejectedError);
      expect((err as SubmitRejectedError).status, door).toBe(503);
      expect(isDefiniteRejection(err), door).toBe(false);
    });

    // Issue #71: a proxy can answer 400 for bytes a node already read, and
    // the body is the only thing that can tell the two 400s apart. Reported
    // as a rejection, the site is told the send failed, rebuilds the payment
    // from other inputs, and the person pays twice.
    it.each([
      "upstream connect error or disconnect/reset before headers",
      "<html><body>400 Bad Request</body></html>",
      "malformed request: expected application/cbor",
    ])(`${door}: a 400 whose body names no ledger rule is NOT definite: %s`, async (body) => {
      stub(400, body);
      const err = await call().catch((e: unknown) => e);
      expect(err, door).toBeInstanceOf(SubmitRejectedError);
      expect((err as SubmitRejectedError).status, door).toBe(400);
      expect(isDefiniteRejection(err), door).toBe(false);
    });
  }
});

describe("submit > isDefiniteRejection says no to everything else", () => {
  it("a bare Error is not a rejection, however its message reads", () => {
    // The shape a regression would produce. Asserted explicitly so that the
    // predicate cannot be "loosened" into reading messages.
    expect(isDefiniteRejection(new Error("Koios /submittx → HTTP 400: nope"))).toBe(false);
  });

  it("a dropped connection is not a rejection", () => {
    expect(isDefiniteRejection(new TypeError("Failed to fetch"))).toBe(false);
    expect(isDefiniteRejection(undefined)).toBe(false);
    expect(isDefiniteRejection(null)).toBe(false);
  });

  // The measured pre-node 400 earns "definite" only as the measured body
  // itself, from its start and closed at `does not exist`: quoted inside a
  // longer proxy message, or cut short of its close, it is one of the
  // unproven ones.
  it("a 400 that quotes the measured socket words inside a longer proxy message is not definite", () => {
    expect(
      isDefiniteRejection(
        new SubmitRejectedError(400, "proxy: TxCmdTxSubmitConnectionError: Network.Socket.connect: <socket: 14>: does not exist, retried upstream", "Koios /submittx"),
      ),
    ).toBe(false);
  });

  it("a 400 that stops short of the socket error's close is not definite", () => {
    expect(
      isDefiniteRejection(
        new SubmitRejectedError(400, "TxCmdTxSubmitConnectionError: Network.Socket.connect: <socket: 14>: connection refused", "Koios /submittx"),
      ),
    ).toBe(false);
  });
});

/**
 * What a website is told about a rejection (issue #59, point 10).
 *
 * Driven through both doors with a real reply body, so the test sees the error
 * exactly as the approval window receives it. The site used to get `message`
 * whole: `<endpoint label> → HTTP <status>: <body>`.
 */
describe("submit > the reason a site receives for a rejection", () => {
  it("a 400 carries the node's reason, without the label that names the provider", async () => {
    for (const [door, call] of DOORS) {
      stub(400, "BadInputsUTxO (spent)");
      const err = await call().catch((e: unknown) => e);
      expect(isDefiniteRejection(err), door).toBe(true);
      const reason = rejectionReasonForSite(err as SubmitRejectedError);
      expect(reason, door).toBe("HTTP 400: BadInputsUTxO");
      expect(reason, door).not.toMatch(/koios|chain endpoint|submittx|tx\/submit/i);
    }
  });

  it.each([401, 402, 403, 429])(
    "a %i is about the person's provider account: the site gets a fixed reason, not the body",
    async (status) => {
      const body = '{"status_code":403,"error":"Forbidden","message":"Invalid project token."}';
      for (const [door, call] of DOORS) {
        stub(status, body);
        const err = await call().catch((e: unknown) => e);
        // The classification is untouched: still a definite rejection.
        expect(isDefiniteRejection(err), door).toBe(true);
        // The wallet's own copy still has everything.
        expect((err as Error).message, door).toContain("Invalid project token");
        const reason = rejectionReasonForSite(err as SubmitRejectedError);
        expect(reason, door).toBe(PROVIDER_REFUSED_REASON);
        expect(reason, door).not.toContain("project token");
        expect(reason, door).not.toContain(String(status));
        expect(reason, door).not.toMatch(/koios|chain endpoint|blockfrost/i);
      }
    },
  );

  it("a 400 with an empty body gets the fixed reason: there is no ledger reason to pass on", () => {
    expect(rejectionReasonForSite(new SubmitRejectedError(400, "", "Koios /submittx"))).toBe(PROVIDER_REFUSED_REASON);
  });

  // Measured on preprod (Koios /submittx, the same signed bytes sent three
  // times): a real ledger refusal, then a 400 whose body was Koios's own
  // backend failing to reach a node. The status was 400 both times.
  const SOCKET_400 =
    "TxCmdTxSubmitConnectionError: Network.Socket.connect: <socket: 14>: does not exist (No such file or directory)";

  it("a 400 that is the provider's own backend failing does not reach the site", async () => {
    for (const [door, call] of DOORS) {
      stub(400, SOCKET_400);
      const err = await call().catch((e: unknown) => e);
      // Still a definite "did not get in": the node was never reached.
      expect(isDefiniteRejection(err), door).toBe(true);
      // The wallet's own copy keeps the provider's words.
      expect((err as Error).message, door).toContain("TxCmdTxSubmitConnectionError");
      const reason = rejectionReasonForSite(err as SubmitRejectedError);
      expect(reason, door).toBe(PROVIDER_REFUSED_REASON);
      expect(reason, door).not.toMatch(/socket|TxCmd|No such file/i);
    }
  });

  it.each([
    [
      'ConwayIncompleteWithdrawals (NonEmptyMap (fromList [(AccountAddress {aaNetworkId = Testnet}, Mismatch (RelEQ) {supplied: Coin 15486, expected: Coin 0})]))',
      "ConwayIncompleteWithdrawals",
    ],
    [
      'ConwayMempoolFailure "All inputs are spent. Transaction has probably already been included"',
      "ConwayMempoolFailure",
    ],
    [
      '{"status_code":400,"error":"Bad Request","message":"\\"transaction submit error ShelleyTxValidationError ShelleyBasedEraConway (ApplyTxError (ConwayUtxowFailure (UtxoFailure (FeeTooSmallUTxO (Coin 170000) (Coin 168000))) :| []))\\""}',
      "ShelleyTxValidationError ApplyTxError ConwayUtxowFailure UtxoFailure FeeTooSmallUTxO",
    ],
    ["BabbageOutputTooSmallUTxO [(addr, 900000)]", "BabbageOutputTooSmallUTxO"],
    // The inner names are what tells these three apart; the wrappers are the same.
    [
      'transaction submit error ShelleyTxValidationError ShelleyBasedEraConway (ApplyTxError (ConwayUtxowFailure (MissingVKeyWitnessesUTXOW (fromList [KeyHash {unKeyHash = "abc"}])) :| []))',
      "ShelleyTxValidationError ApplyTxError ConwayUtxowFailure MissingVKeyWitnessesUTXOW",
    ],
    [
      'transaction submit error ShelleyTxValidationError ShelleyBasedEraConway (ApplyTxError (ConwayUtxowFailure (UtxoFailure (UtxosFailure (ValidationTagMismatch (IsValid True) (FailedUnexpectedly (PlutusFailure "The machine terminated because of an error" :| [])))))) :| []))',
      "ShelleyTxValidationError ApplyTxError ConwayUtxowFailure UtxoFailure UtxosFailure ValidationTagMismatch PlutusFailure",
    ],
    [
      'ApplyTxError (ConwayCertsFailure (CertFailure (DelegFailure (StakeKeyNotRegisteredDELEG (KeyHashObj (KeyHash "ab"))))) :| [])',
      "ApplyTxError ConwayCertsFailure CertFailure DelegFailure StakeKeyNotRegisteredDELEG",
    ],
    // cardano-submit-api's JSON: the value type (MaryValue) is not a rule, and
    // TxValidationErrorInCardanoMode is a tag, not the TxValidationError wrapper.
    [
      '{"contents":{"contents":{"contents":{"era":"ShelleyBasedEraConway","error":["ConwayUtxowFailure (UtxoFailure (ValueNotConservedUTxO (MaryValue (Coin 1) (MultiAsset (fromList []))) (MaryValue (Coin 2) (MultiAsset (fromList [])))))"],"kind":"ShelleyTxValidationError"},"tag":"TxValidationErrorInCardanoMode"},"tag":"TxCmdTxSubmitValidationError"},"tag":"TxSubmitFail"}',
      "ConwayUtxowFailure UtxoFailure ValueNotConservedUTxO ShelleyTxValidationError",
    ],
    // Failures with no era prefix and no rule suffix come from where the node
    // puts them: the constructor right inside a wrapper.
    [
      "transaction submit error ShelleyTxValidationError ShelleyBasedEraConway (ApplyTxError (ConwayUtxowFailure (UtxoFailure (InsufficientCollateral (DeltaCoin 100) (Coin 200))) :| []))",
      "ShelleyTxValidationError ApplyTxError ConwayUtxowFailure UtxoFailure InsufficientCollateral",
    ],
    [
      "transaction submit error ShelleyTxValidationError ShelleyBasedEraConway (ApplyTxError (ConwayUtxowFailure (UtxoFailure (NoCollateralInputs)) :| []))",
      "ShelleyTxValidationError ApplyTxError ConwayUtxowFailure UtxoFailure NoCollateralInputs",
    ],
    [
      'transaction submit error ShelleyTxValidationError ShelleyBasedEraConway (ApplyTxError (ConwayUtxowFailure (PPViewHashesDontMatch (SJust (SafeHash "a")) SNothing) :| []))',
      "ShelleyTxValidationError ApplyTxError ConwayUtxowFailure PPViewHashesDontMatch",
    ],
    [
      "transaction submit error ShelleyTxValidationError ShelleyBasedEraConway (ApplyTxError (ConwayUtxowFailure (UtxoFailure (WrongNetwork Testnet (fromList [addr]))) :| []))",
      "ShelleyTxValidationError ApplyTxError ConwayUtxowFailure UtxoFailure WrongNetwork",
    ],
    [
      "transaction submit error ShelleyTxValidationError ShelleyBasedEraConway (ApplyTxError (ConwayUtxowFailure (MissingRequiredDatums (fromList []) (fromList [])) :| []))",
      "ShelleyTxValidationError ApplyTxError ConwayUtxowFailure MissingRequiredDatums",
    ],
    // A redeemer's purpose tag (ConwaySpending) is the transaction's own data,
    // not a rule; the rule is MissingRedeemers.
    [
      'transaction submit error ShelleyTxValidationError ShelleyBasedEraConway (ApplyTxError (ConwayUtxowFailure (MissingRedeemers [(ConwaySpending (AsIx 0),ScriptHash "ab")]) :| []))',
      "ShelleyTxValidationError ApplyTxError ConwayUtxowFailure MissingRedeemers",
    ],
    // A rule-suffixed name stands on its own, with no wrapper before it.
    ["MissingVKeyWitnessesUTXOW (fromList [KeyHash {unKeyHash = \"abc\"}])", "MissingVKeyWitnessesUTXOW"],
    // Two failures of the same rule: each name once.
    [
      "ApplyTxError (ConwayUtxowFailure (BadInputsUTxO a) :| [ConwayUtxowFailure (BadInputsUTxO b)])",
      "ApplyTxError ConwayUtxowFailure BadInputsUTxO",
    ],
  ])("a 400 the ledger wrote reaches the site as the rule names in it: %s", (detail, names) => {
    expect(rejectionReasonForSite(new SubmitRejectedError(400, detail, "Koios /submittx"))).toBe(`HTTP 400: ${names}`);
  });

  // The match is on the shape of a name, so a provider message can hold a
  // rule-shaped word next to an internal address. Only that word travels.
  it.each([
    ["ConwayNodeUnavailable: dial tcp 10.1.2.3:3001: connect: connection refused", "ConwayNodeUnavailable", "10.1.2.3"],
    ["Error querying LedgerUTxO from db-sync at postgres://db:5432/cexplorer", "LedgerUTxO", "postgres://"],
    [
      "TxSubmitFail ShelleyBasedEraConway: connection to /ipc/node.socket refused; last ApplyTxError cached at 10.0.3.7:3001",
      "ApplyTxError",
      "/ipc/",
    ],
  ])("a 400 that mixes a rule-shaped word with provider text gives the site only the word: %s", (detail, names, leak) => {
    const reason = rejectionReasonForSite(new SubmitRejectedError(400, detail, "Koios /submittx"));
    expect(reason).toBe(`HTTP 400: ${names}`);
    expect(reason).not.toContain(leak);
    expect(reason).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });

  // Era type tags travel inside provider errors that carry internal paths and
  // name no rule; the era prefix alone must not let them through.
  it.each([
    'TxSubmitFail ShelleyBasedEraConway: connection to /ipc/node.socket refused',
    'TxCmdEraConsensusModeMismatch (Just "/ipc/node.socket") (AnyConsensusMode CardanoMode) (AnyCardanoEra ConwayEra)',
    // Era witnesses carry the tag inside the word.
    "TxSubmitFail ShelleyToBabbageEraBabbage: connection to /ipc/node.socket refused",
    "TxSubmitFail ConwayEraOnwardsConway: connection to /ipc/node.socket refused",
  ])("a 400 that only names an era type tag gets the fixed reason: %s", (detail) => {
    const reason = rejectionReasonForSite(new SubmitRejectedError(400, detail, "Koios /submittx"));
    expect(reason).toBe(PROVIDER_REFUSED_REASON);
    expect(reason).not.toContain("/ipc/");
  });

  // A word glued to a host name or a path is part of it, not a name of its own.
  it.each([
    "ConwayRelay01_internal.eu-west-1 refused",
    "connection to /var/run/ShelleyHostSecret refused",
    "ConwayMempoolFailure.eu-west-1.koios.internal unreachable",
    "dial tcp ConwayRelay-03: no route to host",
  ])("a 400 whose rule-shaped word is part of a host or a path gets the fixed reason: %s", (detail) => {
    expect(rejectionReasonForSite(new SubmitRejectedError(400, detail, "Koios /submittx"))).toBe(PROVIDER_REFUSED_REASON);
  });

  // The wrapper-and-constructor shape alone is not the ledger: with no ledger
  // wrapper before it, a provider's own `…Failure (` gives nothing.
  it.each([
    "UpstreamFailure (Connection refused to 10.0.0.3)",
    "ConwaySpending (AsIx 0)",
    // A ledger wrapper's name the body did not earn: nothing accepted it.
    "upstream UtxoFailure (PostgresPrimary at db.internal)",
  ])("a 400 with a wrapper shape but no ledger wrapper gets the fixed reason: %s", (detail) => {
    expect(rejectionReasonForSite(new SubmitRejectedError(400, detail, "Koios /submittx"))).toBe(PROVIDER_REFUSED_REASON);
  });

  // The inner name is read only through a chain of ledger wrappers walked from
  // the outside in. A provider's own `…Failure (` opens none, even after a
  // real wrapper in the same body, and neither does `ConwayMempoolFailure`,
  // whose argument is free text.
  it.each([
    ["ConwayRelayFailure (Koios backend unreachable)", "ConwayRelayFailure", "Koios"],
    ["TxSubmitFail ApplyTxError cached; DbFailure (Postgres10 at db.internal)", "ApplyTxError", "Postgres10"],
    ["ConwayMempoolFailure (KoiosSecretRelay) at 10.0.0.1", "ConwayMempoolFailure", "KoiosSecretRelay"],
    // Not even a known rule's name: only a ledger wrapper opens its argument.
    ["ConwayRelayFailure (InsufficientCollateral) upstream", "ConwayRelayFailure", "InsufficientCollateral"],
  ])("a provider word inside a wrapper that is not a ledger wrapper stays home: %s", (detail, names, leak) => {
    const reason = rejectionReasonForSite(new SubmitRejectedError(400, detail, "Koios /submittx"));
    expect(reason).toBe(`HTTP 400: ${names}`);
    expect(reason).not.toContain(leak);
  });

  // A host inside a URL or a config pair is part of it.
  it.each([
    "postgres://user@ConwayHostPrimary:5432 refused",
    "upstream=ConwayRelayEuWest:3001 refused",
    "upstream ConwayRelayEuWest:3001 refused",
    "relay at host:ConwayRelayEuWest refused",
    "C:\\relays\\ConwayRelaySecret refused",
    "GET /x?ConwayRelayHost refused",
    "GET /x?a=1&ConwayRelayHost refused",
    "ConwayRelayHost:cexplorer refused",
  ])("a 400 whose rule-shaped word is a host in a URL or config gets the fixed reason: %s", (detail) => {
    expect(rejectionReasonForSite(new SubmitRejectedError(400, detail, "Koios /submittx"))).toBe(PROVIDER_REFUSED_REASON);
  });

  // Inside an era-prefixed wrapper the inner name stands as a token by the
  // same rules as a name on its own: a numbered host or a `host:database` pair
  // gives nothing.
  it.each([
    ["upstream ConwayUtxowFailure (KoiosPrimaryDb02) at pg", "KoiosPrimary"],
    ["ConwayUtxowFailure (ConwayRelay01) refused", "ConwayRelay"],
    ["ConwayUtxowFailure (PgPrimary:cexplorer) failed", "PgPrimary"],
    // A `host:database` pair whose host is spelled like a known rule is still a host.
    ["ConwayUtxowFailure (MissingRedeemers:cexplorer) failed", "MissingRedeemers"],
  ])("a host inside an era-prefixed ledger wrapper stays home: %s", (detail, leak) => {
    const reason = rejectionReasonForSite(new SubmitRejectedError(400, detail, "Koios /submittx"));
    expect(reason).toBe("HTTP 400: ConwayUtxowFailure");
    expect(reason).not.toContain(leak);
  });

  // An era-prefixed wrapper stands alone as a name too, so a provider can
  // write one with a letters-only word of its own behind it. The inner name
  // travels only when it is a known rule, another wrapper, or a name that
  // stands on its own.
  it.each([
    ["upstream ConwayUtxowFailure (KoiosPrimaryReplica) at pg", "ConwayUtxowFailure", "KoiosPrimaryReplica"],
    ["BabbageUtxowFailure (InternalRelaySecret)", "BabbageUtxowFailure", "InternalRelaySecret"],
    ["ConwayLedgerFailure (PgBouncerPrimary) refused", "ConwayLedgerFailure", "PgBouncerPrimary"],
    ["AlonzoInBabbageUtxoPredFailure (InternalRelaySecret)", "AlonzoInBabbageUtxoPredFailure", "InternalRelaySecret"],
    ["ConwayUtxowFailure (UtxoFailure (InternalRelaySecret))", "ConwayUtxowFailure UtxoFailure", "InternalRelaySecret"],
  ])("a letters-only provider word inside an era-prefixed wrapper stays home: %s", (detail, names, leak) => {
    const reason = rejectionReasonForSite(new SubmitRejectedError(400, detail, "Koios /submittx"));
    expect(reason).toBe(`HTTP 400: ${names}`);
    expect(reason).not.toContain(leak);
  });

  // The closed set is the ledger's own: a rule with no era prefix and no rule
  // suffix still reaches the site through the wrapper it hangs from,
  // including names an older ledger prints (`TriesToForgeADA`,
  // `MissingRequiredSigners`).
  it.each([
    [
      "transaction submit error ShelleyTxValidationError ShelleyBasedEraConway (ApplyTxError (ConwayUtxowFailure (UnspendableUTxONoDatumHash (fromList [])) :| []))",
      "ShelleyTxValidationError ApplyTxError ConwayUtxowFailure UnspendableUTxONoDatumHash",
    ],
    [
      "transaction submit error ShelleyTxValidationError ShelleyBasedEraBabbage (ApplyTxError (UtxowFailure (UtxoFailure (AlonzoInBabbageUtxoPredFailure (TriesToForgeADA))) :| []))",
      "ShelleyTxValidationError ApplyTxError UtxowFailure UtxoFailure AlonzoInBabbageUtxoPredFailure TriesToForgeADA",
    ],
    [
      "transaction submit error ShelleyTxValidationError ShelleyBasedEraBabbage (ApplyTxError (UtxowFailure (AlonzoInBabbageUtxowPredFailure (MissingRequiredSigners (fromList []))) :| []))",
      "ShelleyTxValidationError ApplyTxError UtxowFailure AlonzoInBabbageUtxowPredFailure MissingRequiredSigners",
    ],
    [
      "transaction submit error ShelleyTxValidationError ShelleyBasedEraConway (ApplyTxError (ConwayUtxowFailure (UtxoFailure (TooManyExUnits (ExUnits 1 2) (ExUnits 0 0)))) :| []))",
      "ShelleyTxValidationError ApplyTxError ConwayUtxowFailure UtxoFailure TooManyExUnits",
    ],
  ])("a ledger rule with no prefix and no suffix reaches the site: %s", (detail, names) => {
    expect(rejectionReasonForSite(new SubmitRejectedError(400, detail, "Koios /submittx"))).toBe(`HTTP 400: ${names}`);
  });

  // The bridges between eras are named one by one, not by their shape: a
  // provider word spelled like one (`SecretInHostUtxoPredFailure`) is no
  // wrapper and no rule, so it stays home.
  it.each([
    ["ConwayUtxowFailure (SecretInHostUtxoPredFailure)", "ConwayUtxowFailure", "SecretInHost"],
    ["ConwayUtxowFailure (UtxoFailure (KoiosInRelayUtxowPredFailure (InsufficientCollateral 1 2)))", "ConwayUtxowFailure UtxoFailure", "KoiosInRelay"],
  ])("a provider word shaped like an era bridge stays home: %s", (detail, names, leak) => {
    const reason = rejectionReasonForSite(new SubmitRejectedError(400, detail, "Koios /submittx"));
    expect(reason).toBe(`HTTP 400: ${names}`);
    expect(reason).not.toContain(leak);
  });

  // Issue #75, point 2: the letters-only counterpart of the hosts above. The
  // wrapper match kept out only a word carrying digits or a `host:db` shape,
  // so a provider's own word travelled: measured, `upstream ApplyTxError
  // (KoiosPrimaryReplica) at pg` reached the site as `HTTP 400: ApplyTxError
  // KoiosPrimaryReplica` and `ApplyTxError (UtxoFailure (InternalRelaySecret))`
  // as `HTTP 400: ApplyTxError UtxoFailure InternalRelaySecret`. `ApplyTxError
  // (` now opens only when it follows `ShelleyTxValidationError`, which every
  // measured node body that wraps in it carries ahead of it. Two guards now
  // stop the first case: a letters-only word that is no known rule
  // (`UNPREFIXED_RULE`) gives nothing even inside an open wrapper. So with the
  // ApplyTxError gate removed the first case stays green, and what tells the
  // gate is there is the second case and the chain test below
  // (`UtxoFailure`, `NoCollateralInputs` both pass every other test).
  it.each([
    ["upstream ApplyTxError (KoiosPrimaryReplica) at pg", "KoiosPrimaryReplica"],
    ["ApplyTxError (UtxoFailure (InternalRelaySecret))", "InternalRelaySecret"],
  ])("a provider word inside a lone ApplyTxError wrapper stays home: %s", (detail, leak) => {
    const reason = rejectionReasonForSite(new SubmitRejectedError(400, detail, "Koios /submittx"));
    expect(reason).toBe("HTTP 400: ApplyTxError");
    expect(reason).not.toContain(leak);
  });

  // The cost of that gate, stated: a wrapper chain that hangs only off a lone
  // `ApplyTxError` — no era-prefixed wrapper to re-enter, no name that stands
  // on its own — stays home with it. `UtxoFailure` and `NoCollateralInputs`
  // travel only through the wrapper they hang from.
  it("a wrapper chain that hangs only off a lone ApplyTxError stays home with it", () => {
    expect(
      rejectionReasonForSite(new SubmitRejectedError(400, "ApplyTxError (UtxoFailure (NoCollateralInputs))", "Koios /submittx")),
    ).toBe("HTTP 400: ApplyTxError");
  });

  // The wrapper the body earned still opens: a Babbage body, where the chain
  // hangs off `ApplyTxError` with nothing that stands on its own
  // (`UtxowFailure` carries no era prefix and no rule suffix), and
  // `ShelleyTxValidationError` ahead of it.
  it("an ApplyTxError that follows ShelleyTxValidationError still opens its wrapper", () => {
    expect(
      rejectionReasonForSite(
        new SubmitRejectedError(
          400,
          "transaction submit error ShelleyTxValidationError ShelleyBasedEraBabbage (ApplyTxError (UtxowFailure (BabbageOutputTooSmallUTxO [(addr, 900000)])) :| [])",
          "Koios /submittx",
        ),
      ),
    ).toBe("HTTP 400: ShelleyTxValidationError ApplyTxError UtxowFailure BabbageOutputTooSmallUTxO");
  });

  // What earns the wrapper is `ShelleyTxValidationError` AHEAD of it, not
  // anywhere in the body: the same word after the wrapper opens nothing, so a
  // provider message cannot open a lone `ApplyTxError (` by naming it later.
  it.each([
    ["upstream ApplyTxError (KoiosPrimaryReplica) at pg; ShelleyTxValidationError", "KoiosPrimaryReplica"],
    ["ApplyTxError (UtxoFailure (InternalRelaySecret)) ShelleyTxValidationError", "InternalRelaySecret"],
  ])("a ShelleyTxValidationError after an ApplyTxError wrapper does not open it: %s", (detail, leak) => {
    const reason = rejectionReasonForSite(new SubmitRejectedError(400, detail, "Koios /submittx"));
    expect(reason).toBe("HTTP 400: ApplyTxError ShelleyTxValidationError");
    expect(reason).not.toContain(leak);
  });

  // Ahead is not enough: it must be right ahead, in the shape the node writes
  // (`ShelleyTxValidationError ShelleyBasedEra<Era> (ApplyTxError (`). The
  // same word earlier in the body, with other text between, opens nothing.
  it.each([
    ["ShelleyTxValidationError seen earlier; upstream ApplyTxError (KoiosPrimaryReplica) at pg", "KoiosPrimaryReplica"],
    ["proxy: ShelleyTxValidationError retry; ApplyTxError (UtxoFailure (InternalRelaySecret))", "InternalRelaySecret"],
    ["ShelleyTxValidationError ShelleyBasedEraConway; then ApplyTxError (UtxoFailure (NoCollateralInputs))", "NoCollateralInputs"],
  ])("a ShelleyTxValidationError that is not right ahead of ApplyTxError does not open it: %s", (detail, leak) => {
    const reason = rejectionReasonForSite(new SubmitRejectedError(400, detail, "Koios /submittx"));
    expect(reason).toBe("HTTP 400: ShelleyTxValidationError ApplyTxError");
    expect(reason).not.toContain(leak);
  });

  // The era between them is a closed set of the ledger's eras: a provider
  // that writes the node's shape with an era of its own opens nothing.
  it.each([
    ["upstream ShelleyTxValidationError ShelleyBasedEraKoios (ApplyTxError (UtxoFailure (InternalRelaySecret)))", "InternalRelaySecret"],
    ["ShelleyTxValidationError ShelleyBasedEraMainnetRelay (ApplyTxError (UtxoFailure (NoCollateralInputs)))", "NoCollateralInputs"],
  ])("an era outside the ledger's eras does not open ApplyTxError: %s", (detail, leak) => {
    const reason = rejectionReasonForSite(new SubmitRejectedError(400, detail, "Koios /submittx"));
    expect(reason).toBe("HTTP 400: ShelleyTxValidationError ApplyTxError");
    expect(reason).not.toContain(leak);
  });

  // Without the ShelleyTxValidationError ahead of it, the names that stand on
  // their own still travel: the chain re-enters at the era-prefixed wrapper.
  it("names that stand on their own still travel without a ShelleyTxValidationError ahead", () => {
    expect(
      rejectionReasonForSite(
        new SubmitRejectedError(400, "ApplyTxError (ConwayUtxowFailure (UtxoFailure (FeeTooSmallUTxO 1 2)))", "Koios /submittx"),
      ),
    ).toBe("HTTP 400: ApplyTxError ConwayUtxowFailure UtxoFailure FeeTooSmallUTxO");
  });

  // Quotes cannot be refused: real rule names arrive quoted in a JSON body.
  // A provider word shaped like a rule, quoted as a JSON value, is the known
  // residue of matching on shape: it goes out as that one word, nothing more.
  it("a quoted rule-shaped value goes out as that one word, never the text around it", () => {
    expect(
      rejectionReasonForSite(new SubmitRejectedError(400, '{"upstream":"ConwayRelayEuWest","host":"10.0.0.1","status":"down"}', "Koios /submittx")),
    ).toBe("HTTP 400: ConwayRelayEuWest");
    expect(
      rejectionReasonForSite(new SubmitRejectedError(400, '{"error":["ApplyTxError (ConwayUtxowFailure (UtxoFailure (FeeTooSmallUTxO 1 2)))"]}', "Koios /submittx")),
    ).toBe("HTTP 400: ApplyTxError ConwayUtxowFailure UtxoFailure FeeTooSmallUTxO");
  });

  // Both submit paths keep only the first SUBMIT_DETAIL_LIMIT characters. A
  // cut inside a name must not hand the site half a name.
  // `upTo` is where the cut falls; the padding moves the body so the cut lands
  // right there.
  const cutAt = (upTo: string, rest: string) => {
    const tail =
      "transaction submit error ShelleyTxValidationError ShelleyBasedEraConway (ApplyTxError (ConwayUtxowFailure (UtxoFailure (UtxosFailure (ValidationTagMismatch (IsValid True) (FailedUnexpectedly (PlutusFailure ";
    const end = tail.indexOf(upTo) + upTo.length;
    const body = '{"message":"' + " ".repeat(SUBMIT_DETAIL_LIMIT - 12 - end) + tail + rest;
    return body.slice(0, SUBMIT_DETAIL_LIMIT);
  };

  it.each([
    // Cut inside a name read through its wrapper.
    ["(UtxosFailure (ValidationTa", "ShelleyTxValidationError ApplyTxError ConwayUtxowFailure UtxoFailure UtxosFailure"],
    // Cut inside a name that matches on its own shape.
    ["(ApplyTxError (ConwayUtxowFai", "ShelleyTxValidationError ApplyTxError"],
  ])("a body cut inside a name does not give the site the half before the cut: …%s", (upTo, names) => {
    const cut = cutAt(upTo, "\\\" :| [])))))");
    expect(cut.length).toBe(SUBMIT_DETAIL_LIMIT);
    expect(cut.endsWith(upTo)).toBe(true);
    expect(rejectionReasonForSite(new SubmitRejectedError(400, cut, "Koios /submittx"))).toBe(`HTTP 400: ${names}`);
  });

  it("a body shorter than the cut keeps the name at its end", () => {
    expect(rejectionReasonForSite(new SubmitRejectedError(400, "ApplyTxError (ConwayUtxowFailure (MissingRedeemers", "Koios /submittx"))).toBe(
      "HTTP 400: ApplyTxError ConwayUtxowFailure MissingRedeemers",
    );
  });

  // Only the site's reason is asserted: nothing here says this body never
  // reached a node.
  it.each([
    "Internal error: upstream connect error or disconnect/reset before headers",
    "Conway", // the era name alone is not a rule failure
    "malformed request: expected application/cbor",
    "<html><body>400 Bad Request</body></html>",
  ])("a 400 with no ledger rule in it gets the fixed reason: %s", (detail) => {
    expect(rejectionReasonForSite(new SubmitRejectedError(400, detail, "Koios /submittx"))).toBe(PROVIDER_REFUSED_REASON);
  });

  // The status decides first: a 4xx other than 400 is about the person's
  // provider account even when its body quotes a ledger rule (a quota page
  // echoing the transaction it refused, say), so the body still stays home.
  it.each([401, 403, 429])("a %i whose body reads like a ledger rule still gets the fixed reason", (status) => {
    const detail = "ConwayMempoolFailure ApplyTxError FeeTooSmallUTxO — quota exceeded for this project";
    expect(rejectionReasonForSite(new SubmitRejectedError(status, detail, "Koios /submittx"))).toBe(PROVIDER_REFUSED_REASON);
  });
});
