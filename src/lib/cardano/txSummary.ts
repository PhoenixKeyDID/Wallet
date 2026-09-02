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
  /** True when this output comes back to one of the wallet's own addresses. */
  mine: boolean;
};

export type TxSummary = {
  /** What each asset costs this wallet, fee included for ADA. */
  net: NetChange[];
  /** Outputs going somewhere that is not this wallet. */
  toOthers: Recipient[];
  fee: bigint;
  /** How many of the transaction's inputs are this wallet's. */
  ownInputs: number;
  totalInputs: number;
  /** Set when the transaction does something this decoder will not describe. */
  certificates: number;
  withdrawals: number;
  mints: number;
};

/** Thrown when the transaction cannot be described. Never a partial answer. */
export class UndescribableTxError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "UndescribableTxError";
  }
}

/**
 * Declared (not an arrow const) so TypeScript treats a bare `bad(...)` as
 * unreachable-after. That is what lets the guards below read as
 * `if (!ok) bad(...)` and still narrow, instead of every one of them needing a
 * `return` in front — which is the kind of noise that gets "simplified" away
 * later, taking the refusal with it.
 */
function bad(why: string): never {
  throw new UndescribableTxError(why);
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

/** Decode one output into an address and a value, refusing shapes we cannot read. */
function readOutput(o: unknown): { addressHex: string; lovelace: bigint; assets: Map<string, bigint> } {
  if (Array.isArray(o)) {
    // Legacy: [address, value, ?datum_hash]
    if (o.length < 2) bad("an output has an unexpected shape");
    const addressHex = Buffer.from(o[0] as Buffer).toString("hex");
    return { addressHex, ...readValue(o[1]) };
  }
  if (o instanceof Map) {
    // Babbage+: {0: address, 1: value, 2: datum_option, 3: script_ref}
    const m = o as Map<unknown, unknown>;
    if (!m.has(0) || !m.has(1)) bad("an output has an unexpected shape");
    // An inline datum or a reference script means the output is doing something
    // beyond paying an address, and this decoder cannot say what. Refuse rather
    // than describe it as an ordinary payment.
    if (m.has(2)) bad("an output carries a datum — this wallet cannot describe what it is for");
    if (m.has(3)) bad("an output carries a script — this wallet cannot describe what it does");
    const addressHex = Buffer.from(m.get(0) as Buffer).toString("hex");
    return { addressHex, ...readValue(m.get(1)) };
  }
  return bad("an output has an unexpected shape");
}

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
  13, // collateral inputs
  14, // required_signers
  15, // network_id
  16, // collateral_return
  17, // total_collateral
  18, // reference_inputs
]);

/**
 * Describe a signed-or-unsigned transaction from the wallet's point of view.
 *
 * `ownAddressesHex` and `ownInputRefs` are what make the answer specific to
 * this wallet: without them "net change" is not defined. `ownInputRefs` is the
 * set of `txid#index` the wallet holds, so an input can be attributed without
 * asking the chain what it pays to.
 */
export function summariseTx(
  txCborHex: string,
  ownAddressesHex: Iterable<string>,
  ownInputs: Map<string, { lovelace: bigint; assets: Map<string, bigint> }>,
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

  const own = new Set<string>();
  for (const hex of ownAddressesHex) own.add(hex.toLowerCase());

  // ── inputs ────────────────────────────────────────────────────────────────
  const rawInputs = b.get(0);
  const inputList = rawInputs instanceof Set ? [...rawInputs] : rawInputs;
  if (!Array.isArray(inputList)) bad("this transaction has no inputs this wallet can read");
  let spentLovelace = BigInt(0);
  const spentAssets = new Map<string, bigint>();
  let mineCount = 0;
  for (const i of inputList) {
    if (!Array.isArray(i) || i.length < 2) bad("an input has an unexpected shape");
    const ref = `${Buffer.from(i[0] as Buffer).toString("hex")}#${Number(i[1])}`;
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
  for (const o of rawOutputs) {
    const { addressHex, lovelace, assets } = readOutput(o);
    const mine = own.has(addressHex.toLowerCase());
    if (mine) {
      returnedLovelace += lovelace;
      for (const [unit, qty] of assets) {
        returnedAssets.set(unit, (returnedAssets.get(unit) ?? BigInt(0)) + qty);
      }
    } else {
      let address: string;
      try {
        address = tyUtils.getAddressFromHex(Buffer.from(addressHex, "hex")).getBech32();
      } catch {
        return bad("this transaction pays an address this wallet cannot read");
      }
      toOthers.push({ address, lovelace, mine: false });
    }
  }

  const fee = asBigInt(b.get(2) ?? 0, "the fee");

  // ── net ───────────────────────────────────────────────────────────────────
  const net: NetChange[] = [];
  const adaOut = spentLovelace - returnedLovelace;
  if (adaOut !== BigInt(0)) net.push({ ...ADA, amount: adaOut });
  const units = new Set([...spentAssets.keys(), ...returnedAssets.keys()]);
  for (const unit of units) {
    const delta = (spentAssets.get(unit) ?? BigInt(0)) - (returnedAssets.get(unit) ?? BigInt(0));
    if (delta === BigInt(0)) continue;
    net.push({
      unit,
      policyId: unit.slice(0, 56),
      assetNameHex: unit.slice(56),
      amount: delta,
    });
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
    fee,
    ownInputs: mineCount,
    totalInputs: inputList.length,
    certificates: countOf(b.get(4)),
    withdrawals: countOf(b.get(5)),
    mints: countOf(b.get(9)),
  };
}
