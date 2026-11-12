/**
 * Read a transaction a website handed us, and say what it does — or refuse.
 *
 * This exists for one screen: the one asking a person to sign something they
 * did not build. Everywhere else in this wallet the transaction was assembled
 * here, from a form the user filled in, so the review screen can describe it
 * from the inputs it already has. A dApp hands over opaque CBOR instead, and
 * the only honest options are to explain it or to decline.
 *
 * ## Refusing is a feature, and the default
 *
 * Every function below fails closed. An unknown field, an output shape this
 * decoder has not seen, a certificate type it cannot name — all of them stop
 * the signature. That is deliberately stricter than "sign it anyway and show
 * the hex": a hex string on an approval dialog is not information, it is the
 * appearance of information, and it trains people to click through. A wallet
 * that says *"this transaction does something I cannot describe, so I will not
 * sign it"* is one a user can actually act on.
 *
 * ## Net change, not the output total
 *
 * The number that matters is what leaves **this wallet**, and it is not the sum
 * of the outputs. A transaction spending 100 ADA and returning 95 as change has
 * an output total near 100 and costs the user 5. Showing the larger number is
 * alarming and wrong; showing it as the amount "sent" is worse, because the
 * user then approves a 5 ADA payment believing they checked a 100 ADA one.
 *
 * So: sum what this wallet's addresses put in, subtract what comes back to
 * them, and report the difference — per asset, ADA included.
 */
import "../node-globals";
import { Buffer } from "buffer";
import { Decoder } from "@stricahq/cbors";
import { utils as tyUtils } from "@stricahq/typhonjs";
import { walletOwnsOutput } from "./ownUtxo";
import { COLLATERAL_CAP_LOVELACE } from "./utxoSelect";

/** One asset's movement, from the wallet's point of view. Negative = incoming. */
export type NetChange = {
  /** `""` for ADA; otherwise policyId + assetNameHex. */
  unit: string;
  policyId: string;
  assetNameHex: string;
  /** Lovelace for ADA. Positive means it leaves this wallet. */
  amount: bigint;
};

export type Recipient = {
  /** bech32, always in full — a truncated address is where the swap hides. */
  address: string;
  lovelace: bigint;
  /**
   * Every token this output carries. Without these, a transaction splitting
   * tokens across several addresses shows only where the ADA goes, and the
   * tokens leave unseen.
   */
  assets: NetChange[];
  /**
   * True when this output comes back to one of the wallet's own addresses and
   * the wallet's UTxO reads will keep it (`walletOwnsOutput`). Always `false`
   * on an entry of `toOthers`: an output that is the wallet's is counted as
   * change, not listed.
   */
  mine: boolean;
  /**
   * The output carries a datum (inline, or by hash). Sending to a script with
   * a datum is how a contract keeps its state, so it is shown rather than
   * refused — the address and the amount are still what the person decides on.
   * An output to one of this wallet's key addresses under a datum is counted
   * as change and listed in `toSelfWithDatum`, with this flag set.
   */
  datum: boolean;
};

/**
 * What the transaction can take from this wallet if its script fails.
 *
 * When a Plutus script in the transaction fails, the ledger ignores the inputs
 * and outputs and takes the collateral instead, handing back only the
 * collateral return. That is a second, separate cost, and it is shown as one.
 */
export type CollateralRisk = {
  /** Lovelace lost if the script fails: collateral inputs minus the return. */
  riskLovelace: bigint;
  /** How many collateral inputs — every one of them this wallet's. */
  inputs: number;
};

export type TxSummary = {
  /** What each asset costs this wallet, fee included for ADA. */
  net: NetChange[];
  /** Outputs going somewhere that is not this wallet. */
  toOthers: Recipient[];
  /**
   * Outputs coming back to one of this wallet's addresses under a datum. They
   * are change — counted in `net` as coming back, because the wallet's UTxO
   * reads keep them and it can spend them — and they are still listed, so the
   * screen can say a datum rides on them. `mine` and `datum` are `true` on each.
   */
  toSelfWithDatum: Recipient[];
  fee: bigint;
  /** How many of the transaction's inputs are this wallet's. */
  ownInputs: number;
  totalInputs: number;
  withdrawals: number;
  /**
   * How many of `withdrawals` take rewards out of a reward account that is not
   * this wallet's. The screen says something different for those: the money is
   * somebody else's, and "this withdraws your staking rewards" would be false.
   */
  foreignWithdrawals: number;
  /** Tokens this transaction destroys, `amount` positive. Creating tokens is refused. */
  burns: NetChange[];
  /** Present when the transaction puts up collateral. */
  collateral: CollateralRisk | null;
  /**
   * Staking rewards this transaction pulls out of *this wallet's* reward
   * account. It is money that arrives and can leave in the same transaction,
   * so it belongs in `net` — and it is the one amount a screen reading only
   * inputs and outputs would miss entirely.
   */
  withdrawalLovelace: bigint;
};

/** Thrown when the transaction cannot be described. Never a partial answer. */
export class UndescribableTxError extends Error {
  /**
   * An i18n key (`sign_foreign_*`) for the refusals a person is meant to read
   * in their own language, set on the ones that guard money directly. The
   * screen shows it translated, and the signer refuses under the same key, so
   * the two layers name the same reason. Absent: `message` is the reason.
   */
  readonly key: string | undefined;
  constructor(reason: string, key?: string) {
    super(reason);
    this.name = "UndescribableTxError";
    this.key = key;
  }
}

/**
 * Declared (not an arrow const) so TypeScript treats a bare `bad(...)` as
 * unreachable-after. That is what lets the guards below read as
 * `if (!ok) bad(...)` and still narrow, instead of every one of them needing a
 * `return` in front — which is the kind of noise that gets "simplified" away
 * later, taking the refusal with it.
 */
function bad(why: string, key?: string): never {
  throw new UndescribableTxError(why, key);
}

const ADA: NetChange = { unit: "", policyId: "", assetNameHex: "", amount: BigInt(0) };

function asBigInt(v: unknown, what: string): bigint {
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v) || v < 0) bad(`${what} is not a whole non-negative number`);
    return BigInt(v);
  }
  if (typeof v === "bigint") {
    if (v < BigInt(0)) bad(`${what} is negative`);
    return v;
  }
  // @stricahq/cbors hands large integers back as BigNumber-like objects.
  if (v && typeof v === "object" && typeof (v as { toFixed?: unknown }).toFixed === "function") {
    const s = (v as { toFixed(n: number): string }).toFixed(0);
    if (!/^\d+$/.test(s)) bad(`${what} is not a whole non-negative number`);
    return BigInt(s);
  }
  return bad(`${what} is not a number this wallet can read`);
}

/** Decode a CBOR `value`: either a bare coin, or `[coin, {policy: {name: qty}}]`. */
function readValue(v: unknown): { lovelace: bigint; assets: Map<string, bigint> } {
  const assets = new Map<string, bigint>();
  if (!Array.isArray(v)) return { lovelace: asBigInt(v, "an output amount"), assets };
  if (v.length !== 2) bad("an output amount has an unexpected shape");
  const lovelace = asBigInt(v[0], "an output amount");
  const multi = v[1];
  if (!(multi instanceof Map)) bad("an output's native assets have an unexpected shape");
  for (const [policyRaw, namesRaw] of multi as Map<unknown, unknown>) {
    const policyId = Buffer.from(policyRaw as Buffer).toString("hex");
    if (!/^[0-9a-f]{56}$/.test(policyId)) bad("an output carries a malformed policy id");
    if (!(namesRaw instanceof Map)) bad("an output's assets have an unexpected shape");
    for (const [nameRaw, qtyRaw] of namesRaw as Map<unknown, unknown>) {
      const assetNameHex = Buffer.from(nameRaw as Buffer).toString("hex");
      const unit = policyId + assetNameHex;
      assets.set(unit, (assets.get(unit) ?? BigInt(0)) + asBigInt(qtyRaw, "an asset quantity"));
    }
  }
  return { lovelace, assets };
}

/** A mint quantity: a whole number that may be negative (a burn). */
function asSignedBigInt(v: unknown, what: string): bigint {
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) bad(`${what} is not a whole number`);
    return BigInt(v);
  }
  if (typeof v === "bigint") return v;
  if (v && typeof v === "object" && typeof (v as { toFixed?: unknown }).toFixed === "function") {
    const s = (v as { toFixed(n: number): string }).toFixed(0);
    if (!/^-?\d+$/.test(s)) bad(`${what} is not a whole number`);
    return BigInt(s);
  }
  return bad(`${what} is not a number this wallet can read`);
}

type ReadOutput = { addressHex: string; lovelace: bigint; assets: Map<string, bigint>; datum: boolean };

/** An output address as bech32, in full, or a refusal when it is not one. */
function bech32Of(addressHex: string): string {
  try {
    return tyUtils.getAddressFromHex(Buffer.from(addressHex, "hex")).getBech32();
  } catch {
    return bad("this transaction pays an address this wallet cannot read");
  }
}

/** Decode one output into an address and a value, refusing shapes we cannot read. */
function readOutput(o: unknown): ReadOutput {
  if (Array.isArray(o)) {
    // Legacy: [address, value, ?datum_hash]
    if (o.length < 2 || o.length > 3) bad("an output has an unexpected shape");
    const addressHex = Buffer.from(o[0] as Buffer).toString("hex");
    return { addressHex, ...readValue(o[1]), datum: o.length === 3 };
  }
  if (o instanceof Map) {
    // Babbage+: {0: address, 1: value, 2: datum_option, 3: script_ref}
    const m = o as Map<unknown, unknown>;
    if (!m.has(0) || !m.has(1)) bad("an output has an unexpected shape");
    for (const k of m.keys()) {
      if (![0, 1, 2, 3].includes(Number(k))) bad("an output has a field this wallet cannot describe");
    }
    // A reference script means the output publishes code, and this decoder
    // cannot say what that code does. A datum is different: it is the state a
    // contract keeps beside the money, and the money still goes where the
    // address says — so it is shown, not refused.
    if (m.has(3)) bad("an output carries a script — this wallet cannot describe what it does");
    const addressHex = Buffer.from(m.get(0) as Buffer).toString("hex");
    return { addressHex, ...readValue(m.get(1)), datum: m.has(2) };
  }
  return bad("an output has an unexpected shape");
}

/**
 * The network an address is for, from its header byte; `null` for Byron.
 *
 * Shelley headers carry the network in the low nibble (`0` testnets, `1`
 * mainnet). Byron addresses (`0x8_`) encode it elsewhere and are left to the
 * ledger.
 */
function addressNetwork(addressHex: string): number | null {
  const header = parseInt(addressHex.slice(0, 2), 16);
  if (Number.isNaN(header)) bad("an output pays an address this wallet cannot read");
  if (header >> 4 === 0x8) return null;
  return header & 0x0f;
}

const toNetChange = (unit: string, amount: bigint): NetChange => ({
  unit,
  policyId: unit.slice(0, 56),
  assetNameHex: unit.slice(56),
  amount,
});

/**
 * Body fields this decoder understands well enough to sign in the presence of.
 *
 * The list is an allow-list, and the refusal below is the point. Conway keeps
 * adding fields; a transaction carrying one this build has never seen may be
 * perfectly ordinary, or may be delegating the user's voting power, and from in
 * here the two are indistinguishable. Anything unrecognised stops the signature
 * and says so, which is a wallet the user can trust to be out of its depth
 * loudly rather than quietly.
 */
const KNOWN_BODY_KEYS = new Set([
  0, // inputs
  1, // outputs
  2, // fee
  3, // ttl
  4, // certificates
  5, // withdrawals
  7, // auxiliary_data_hash
  8, // validity_interval_start
  9, // mint
  11, // script_data_hash
  13, // collateral inputs — described below, never ignored
  14, // required_signers
  15, // network_id
  16, // collateral return
  17, // total collateral
  18, // reference_inputs
]);

/**
 * Collateral (13 inputs, 16 return, 17 total) is a second way for the
 * transaction to spend, so it is described as one — or the transaction is
 * refused.
 *
 * When a script in the transaction fails, the ledger ignores the inputs and
 * outputs entirely and takes the collateral inputs instead, handing back only
 * the collateral return — to whatever address the transaction names. None of
 * that appears in `net` or `toOthers`, which are computed from fields 0 and 1.
 * So a page can put a large UTxO of this wallet into field 13, point the return
 * at itself, attach a script built to fail, and a screen reading only the
 * ordinary path truthfully reports *"leaves the wallet: 0.2 ADA"*. The ledger
 * spends the rest. The signature comes for free: a witness authorises a key,
 * not an input.
 *
 * So the amount at risk is computed and shown, and every way of making that
 * number wrong is a refusal rather than a guess:
 *
 * - a collateral input this wallet cannot value — the set of UTxOs it holds is
 *   open, and one it has not scanned would otherwise count as nobody's;
 * - a collateral return paying anyone but this wallet — then the whole
 *   collateral is at risk, and "minus the return" would understate it;
 * - tokens in the collateral that the return does not give back in full, or a
 *   return naming tokens the collateral never held;
 * - a declared total that disagrees with inputs minus return;
 * - an amount at risk above `COLLATERAL_CAP_LOVELACE` (5 ADA).
 *
 * The cap is the protection, and the printed amount is the worst case under
 * it. The collateral is taken when a script in the transaction fails, and the
 * page built the transaction, so the page decides whether one does. A
 * transaction that declares its own script fails (`is_valid = false`) is
 * refused as well, but that refusal guards little: the flag is outside the
 * signed body, so a page can get a signature on the `true` version and submit
 * `false` with the same witness — or simply attach a script that fails.
 */
function readCollateral(
  b: Map<number, unknown>,
  own: Set<string>,
  ownInputs: ReadonlyMap<string, { lovelace: bigint; assets: Map<string, bigint> }>,
  networkId: 0 | 1,
): CollateralRisk | null {
  const raw = b.get(13);
  if (raw === undefined) {
    if (b.has(16) || b.has(17)) bad("this transaction names a collateral return or total but no collateral");
    return null;
  }
  const list = raw instanceof Set ? [...raw] : raw;
  if (!Array.isArray(list) || list.length === 0) bad("this transaction's collateral has an unexpected shape");

  let inLovelace = BigInt(0);
  const inAssets = new Map<string, bigint>();
  const seen = new Set<string>();
  for (const i of list) {
    if (!Array.isArray(i) || i.length < 2) bad("a collateral input has an unexpected shape");
    const ref = `${Buffer.from(i[0] as Buffer).toString("hex")}#${Number(i[1])}`;
    if (seen.has(ref)) bad("this transaction names the same collateral input twice");
    seen.add(ref);
    const held = ownInputs.get(ref);
    if (!held) {
      bad("this transaction puts up collateral this wallet cannot account for — it cannot say what you would lose if the script fails");
    }
    inLovelace += held.lovelace;
    for (const [unit, qty] of held.assets) inAssets.set(unit, (inAssets.get(unit) ?? BigInt(0)) + qty);
  }

  let retLovelace = BigInt(0);
  let retAssets = new Map<string, bigint>();
  if (b.has(16)) {
    const r = readOutput(b.get(16));
    if (!own.has(r.addressHex.toLowerCase())) {
      bad("this transaction sends the collateral return to an address that is not this wallet — if the script fails, all of the collateral is lost");
    }
    if (r.datum) bad("this transaction's collateral return carries a datum — this wallet cannot describe what it is for");
    if (addressNetwork(r.addressHex) !== networkId) bad("this transaction's collateral return is for another network");
    retLovelace = r.lovelace;
    retAssets = r.assets;
  }

  for (const [unit, qty] of inAssets) {
    if ((retAssets.get(unit) ?? BigInt(0)) < qty) {
      bad(
        "this transaction puts up tokens as collateral and does not give them back — if the script fails, they are lost",
        "sign_foreign_collateral_tokens",
      );
    }
  }
  for (const [unit, qty] of retAssets) {
    if (qty > (inAssets.get(unit) ?? BigInt(0))) bad("this transaction's collateral return names tokens the collateral does not hold");
  }
  if (retLovelace > inLovelace) bad("this transaction's collateral return is larger than its collateral");

  const risk = inLovelace - retLovelace;
  if (b.has(17) && asBigInt(b.get(17), "the collateral total") !== risk) {
    bad("this transaction declares a collateral total that does not match its collateral and return");
  }
  // The cap. Printing the amount at risk is not enough on its own: the page
  // that built the transaction also decides whether its script fails, so a
  // 10 000 ADA coin in field 13 with no return is 10 000 ADA the page can
  // burn, under a screen that says so in one line beneath a 0.2 ADA cost.
  // The wallet never offers more than `COLLATERAL_CAP_LOVELACE` from
  // `getCollateral`, and it does not sign for more either.
  if (risk > COLLATERAL_CAP_LOVELACE) {
    bad(
      "this transaction can lose more than 5 ADA of this wallet's collateral if its script fails — this wallet does not put up that much",
      "sign_foreign_collateral_over_cap",
    );
  }
  return { riskLovelace: risk, inputs: list.length };
}

/** Read field 9, refusing any token created, and return what is destroyed. */
function readBurns(raw: unknown): NetChange[] {
  if (raw === undefined) return [];
  if (!(raw instanceof Map)) bad("this transaction mints in a shape this wallet cannot read");
  const burns: NetChange[] = [];
  for (const [policyRaw, namesRaw] of raw as Map<unknown, unknown>) {
    const policyId = Buffer.from(policyRaw as Buffer).toString("hex");
    if (!/^[0-9a-f]{56}$/.test(policyId)) bad("this transaction mints under a malformed policy id");
    if (!(namesRaw instanceof Map)) bad("this transaction mints in a shape this wallet cannot read");
    for (const [nameRaw, qtyRaw] of namesRaw as Map<unknown, unknown>) {
      const qty = asSignedBigInt(qtyRaw, "a mint quantity");
      // Creating tokens is a minting policy saying yes, and a policy that asks
      // for this wallet's key asks for a reason this screen cannot read.
      if (qty >= BigInt(0)) bad("this transaction creates tokens — this wallet only signs transactions that destroy them");
      burns.push(toNetChange(policyId + Buffer.from(nameRaw as Buffer).toString("hex"), -qty));
    }
  }
  return burns;
}

/**
 * Describe a signed-or-unsigned transaction from the wallet's point of view.
 *
 * `ownAddressesHex` and `ownInputRefs` are what make the answer specific to
 * this wallet: without them "net change" is not defined. `ownInputRefs` is the
 * set of `txid#index` the wallet holds, so an input can be attributed without
 * asking the chain what it pays to.
 *
 * `networkId` is the ledger's number for the account's network — `1` mainnet,
 * `0` every testnet. A body naming another one, or paying an address on
 * another one, is refused before anything else is described: the person is
 * looking at a wallet for one network and would be signing for another.
 */
export function summariseTx(
  txCborHex: string,
  ownAddressesHex: Iterable<string>,
  ownInputs: ReadonlyMap<string, { lovelace: bigint; assets: Map<string, bigint> }>,
  networkId: 0 | 1,
): TxSummary {
  let decoded: unknown;
  try {
    decoded = Decoder.decode(Buffer.from(txCborHex, "hex")).value;
  } catch (e) {
    return bad(`this is not a transaction this wallet can read (${(e as Error).message})`);
  }
  if (!Array.isArray(decoded) || decoded.length < 1) bad("this is not a transaction");
  const body = decoded[0];
  if (!(body instanceof Map)) bad("this transaction has no body this wallet can read");
  const b = body as Map<number, unknown>;

  for (const key of b.keys()) {
    if (!KNOWN_BODY_KEYS.has(Number(key)))
      bad(`this transaction uses a feature this wallet cannot describe (field ${String(key)})`);
  }

  // ── network, first ────────────────────────────────────────────────────────
  const declaredNetwork = b.get(15);
  if (declaredNetwork !== undefined && Number(declaredNetwork) !== networkId) {
    bad(`this transaction is for another network (network id ${String(declaredNetwork)}, this wallet is on ${networkId})`);
  }

  // `is_valid = false` is the transaction saying its own script fails. If a
  // script does fail, the ledger takes the collateral and nothing else happens
  // (if none fails, the ledger rejects the mismatch). Refusing it here only
  // stops the honest-looking case. The flag sits beside the body, not in it,
  // so the signature does not cover it — and the page that built the
  // transaction can as easily attach a script that fails. This is not what
  // protects the collateral. What does is the cap in `readCollateral`: this
  // wallet signs no transaction that can lose more than 5 ADA of collateral,
  // and the screen prints the amount under that cap.
  if (decoded.length >= 3 && decoded[2] === false) {
    bad("this transaction declares that its own script fails — signing it gives up its collateral");
  }

  // ── certificates: none ────────────────────────────────────────────────────
  // A certificate does not move money on this screen; it hands over a standing
  // right — the stake to a pool, the vote to a DRep — and this decoder cannot
  // show the person whom it goes to. Counting it under a general warning was
  // a summary that read "leaves the wallet: 0.2 ADA" for a transaction handing
  // the whole voting power to someone else. So none is signed, of any kind.
  const rawCerts = b.get(4);
  if (rawCerts !== undefined) {
    const n = rawCerts instanceof Set ? rawCerts.size : Array.isArray(rawCerts) ? rawCerts.length : -1;
    if (n !== 0) bad("this transaction carries a certificate (staking, voting or registration) — this wallet does not sign those for a website");
  }

  const own = new Set<string>();
  for (const hex of ownAddressesHex) own.add(hex.toLowerCase());

  // ── inputs ────────────────────────────────────────────────────────────────
  const rawInputs = b.get(0);
  const inputList = rawInputs instanceof Set ? [...rawInputs] : rawInputs;
  if (!Array.isArray(inputList)) bad("this transaction has no inputs this wallet can read");
  let spentLovelace = BigInt(0);
  const spentAssets = new Map<string, bigint>();
  let mineCount = 0;
  // The same input twice is refused, as it is for collateral. The ledger
  // spends a UTxO once, but a body in array form can list it twice, and every
  // line below would count this wallet's coin twice — reporting a cost the
  // transaction does not have, which is the wrong number the person agrees to.
  const seenInputs = new Set<string>();
  for (const i of inputList) {
    if (!Array.isArray(i) || i.length < 2) bad("an input has an unexpected shape");
    const ref = `${Buffer.from(i[0] as Buffer).toString("hex")}#${Number(i[1])}`;
    if (seenInputs.has(ref)) bad("this transaction names the same input twice");
    seenInputs.add(ref);
    const held = ownInputs.get(ref);
    if (!held) continue; // someone else's input; it costs this wallet nothing
    mineCount += 1;
    spentLovelace += held.lovelace;
    for (const [unit, qty] of held.assets) {
      spentAssets.set(unit, (spentAssets.get(unit) ?? BigInt(0)) + qty);
    }
  }

  // ── outputs ───────────────────────────────────────────────────────────────
  const rawOutputs = b.get(1);
  if (!Array.isArray(rawOutputs)) bad("this transaction has no outputs this wallet can read");
  let returnedLovelace = BigInt(0);
  const returnedAssets = new Map<string, bigint>();
  const toOthers: Recipient[] = [];
  const toSelfWithDatum: Recipient[] = [];
  for (const o of rawOutputs) {
    const { addressHex, lovelace, assets, datum } = readOutput(o);
    const net = addressNetwork(addressHex);
    if (net !== null && net !== networkId) bad("this transaction pays an address on another network");
    // Change is what the wallet will see and spend again after signing, and
    // that is decided by the same function its UTxO reads use
    // (`walletOwnsOutput`), never by a second copy of the rule here. An output
    // to one of its key addresses under a datum is change: the readers keep
    // it, because the ledger ignores a datum on a key-locked input — the LAMP
    // drip-pot pays every claim that way. If the readers skipped it and this
    // counted it, a page could send 95 ADA to the wallet's own address under a
    // datum and the screen would report a 5 ADA cost; with one function the
    // two cannot drift. `readOutput` refuses a reference script outright, so
    // `referenceScript` is false for every output that reaches this line.
    const ownAddress = own.has(addressHex.toLowerCase());
    const mine = ownAddress && walletOwnsOutput({ addressHex, datum, referenceScript: false });
    if (mine) {
      returnedLovelace += lovelace;
      for (const [unit, qty] of assets) {
        returnedAssets.set(unit, (returnedAssets.get(unit) ?? BigInt(0)) + qty);
      }
      if (datum) {
        toSelfWithDatum.push({
          address: bech32Of(addressHex),
          lovelace,
          assets: [...assets].map(([unit, qty]) => toNetChange(unit, qty)),
          mine: true,
          datum: true,
        });
      }
    } else {
      toOthers.push({
        address: bech32Of(addressHex),
        lovelace,
        assets: [...assets].map(([unit, qty]) => toNetChange(unit, qty)),
        mine: false,
        datum,
      });
    }
  }

  const fee = asBigInt(b.get(2) ?? 0, "the fee");

  // ── withdrawals ───────────────────────────────────────────────────────────
  // A withdrawal takes staking rewards out of a reward account and hands them
  // to the transaction to spend. Nothing about that shows up in the inputs, so
  // a summary built from inputs and outputs alone reports a transaction that
  // drains the rewards as costing nothing — and, once a change output is added,
  // as money coming *in*. The reward account says whose rewards these are: one
  // header byte then the 28-byte stake key hash, which is also the last 28
  // bytes of every base address this wallet owns.
  const ownStakeHashes = new Set<string>();
  for (const hex of own) {
    if (hex.length === 114) ownStakeHashes.add(hex.slice(58));
  }
  let withdrawnLovelace = BigInt(0);
  let foreignWithdrawals = 0;
  const rawWithdrawals = b.get(5);
  if (rawWithdrawals !== undefined) {
    if (!(rawWithdrawals instanceof Map)) bad("this transaction withdraws in a shape this wallet cannot read");
    for (const [rewardAccount, amount] of rawWithdrawals as Map<unknown, unknown>) {
      const raw = Buffer.from(rewardAccount as Buffer);
      if (raw.length !== 29) bad("this transaction withdraws from an account this wallet cannot read");
      // Somebody else's rewards are somebody else's money; they neither arrive
      // here nor leave here.
      if (!ownStakeHashes.has(raw.subarray(1).toString("hex"))) {
        foreignWithdrawals += 1;
        continue;
      }
      withdrawnLovelace += asBigInt(amount, "a withdrawal amount");
    }
  }

  // ── net ───────────────────────────────────────────────────────────────────
  const net: NetChange[] = [];
  const adaOut = spentLovelace + withdrawnLovelace - returnedLovelace;
  if (adaOut !== BigInt(0)) net.push({ ...ADA, amount: adaOut });
  const units = new Set([...spentAssets.keys(), ...returnedAssets.keys()]);
  for (const unit of units) {
    const delta = (spentAssets.get(unit) ?? BigInt(0)) - (returnedAssets.get(unit) ?? BigInt(0));
    if (delta === BigInt(0)) continue;
    net.push(toNetChange(unit, delta));
  }

  const countOf = (v: unknown): number => {
    if (v === undefined) return 0;
    if (Array.isArray(v)) return v.length;
    if (v instanceof Set) return v.size;
    if (v instanceof Map) return v.size;
    return bad("this transaction has a field this wallet cannot count");
  };

  return {
    net,
    toOthers,
    toSelfWithDatum,
    fee,
    ownInputs: mineCount,
    totalInputs: inputList.length,
    withdrawals: countOf(b.get(5)),
    foreignWithdrawals,
    burns: readBurns(b.get(9)),
    collateral: readCollateral(b, own, ownInputs, networkId),
    withdrawalLovelace: withdrawnLovelace,
  };
}
