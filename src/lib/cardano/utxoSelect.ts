/**
 * The three questions CIP-30 lets a website ask about this wallet's coins
 * beyond "list them all": cover this amount (`getUtxos(amount)`), give me one
 * page (`getUtxos(_, paginate)`), and which coins may be put up as collateral
 * (`getCollateral`).
 *
 * All three answer from the same inputs the signing path resolves, and all
 * three can say "no" in the shape CIP-30 gives for it: `null` when the wallet
 * cannot cover the amount, `PaginateError { maxSize }` for a page past the end.
 * A guess in either place is worse than a refusal — a dApp that asked for an
 * amount reads any non-null answer as "this covers it" and builds on it.
 */
import "../node-globals";
import { Buffer } from "buffer";
import { Decoder } from "@stricahq/cbors";
import type { types as tyTypes } from "@stricahq/typhonjs";

export type Wanted = { lovelace: bigint; assets: Map<string, bigint> };

export class Cip30ArgumentError extends Error {}

const HEX = /^(?:[0-9a-fA-F]{2})+$/;
const ZERO = BigInt(0);

function whole(v: unknown, what: string): bigint {
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === "bigint" && v >= ZERO) return v;
  if (v && typeof v === "object" && typeof (v as { toFixed?: unknown }).toFixed === "function") {
    const s = (v as { toFixed(n: number): string }).toFixed(0);
    if (/^\d+$/.test(s)) return BigInt(s);
  }
  throw new Cip30ArgumentError(`${what} is not a whole non-negative number`);
}

/** CIP-30 `cbor<value>`: a bare coin, or `[coin, { policy: { name: qty } }]`. */
export function decodeValueHex(hex: unknown): Wanted {
  if (typeof hex !== "string" || !HEX.test(hex)) throw new Cip30ArgumentError("amount is not CBOR hex");
  let v: unknown;
  try {
    v = Decoder.decode(Buffer.from(hex, "hex")).value;
  } catch {
    throw new Cip30ArgumentError("amount is not valid CBOR");
  }
  const assets = new Map<string, bigint>();
  if (!Array.isArray(v)) return { lovelace: whole(v, "amount"), assets };
  if (v.length !== 2 || !(v[1] instanceof Map)) throw new Cip30ArgumentError("amount has an unexpected shape");
  const lovelace = whole(v[0], "amount");
  for (const [p, names] of v[1] as Map<unknown, unknown>) {
    if (!Buffer.isBuffer(p) || p.length !== 28 || !(names instanceof Map)) {
      throw new Cip30ArgumentError("amount carries a malformed policy");
    }
    for (const [n, q] of names as Map<unknown, unknown>) {
      if (!Buffer.isBuffer(n) || n.length > 32) throw new Cip30ArgumentError("amount carries a malformed asset name");
      const unit = p.toString("hex") + n.toString("hex");
      assets.set(unit, (assets.get(unit) ?? ZERO) + whole(q, "asset quantity"));
    }
  }
  return { lovelace, assets };
}

const lovelaceOf = (i: tyTypes.Input) => BigInt(i.amount.toFixed(0));
const qtyOf = (i: tyTypes.Input, unit: string) =>
  (i.tokens ?? [])
    .filter((t) => t.policyId + (t.assetName ?? "") === unit)
    .reduce((s, t) => s + BigInt(t.amount.toFixed(0)), ZERO);
const refOf = (i: tyTypes.Input) => `${i.txId}#${i.index}`;
/** Largest first, ties broken by reference — the same inputs always give the same answer. */
const byDesc = (key: (i: tyTypes.Input) => bigint) => (a: tyTypes.Input, b: tyTypes.Input) => {
  const d = key(b) - key(a);
  return d > ZERO ? 1 : d < ZERO ? -1 : refOf(a) < refOf(b) ? -1 : 1;
};

/**
 * Inputs that together hold at least `want`, or `null` when the wallet as a
 * whole does not. Each asset is covered first from the inputs holding most of
 * it, then lovelace from the largest remaining inputs.
 */
export function selectForAmount(inputs: tyTypes.Input[], want: Wanted): tyTypes.Input[] | null {
  const chosen = new Map<string, tyTypes.Input>();
  for (const [unit, need] of want.assets) {
    let have = [...chosen.values()].reduce((s, i) => s + qtyOf(i, unit), ZERO);
    for (const i of [...inputs].filter((x) => qtyOf(x, unit) > ZERO).sort(byDesc((x) => qtyOf(x, unit)))) {
      if (have >= need) break;
      if (chosen.has(refOf(i))) continue;
      chosen.set(refOf(i), i);
      have += qtyOf(i, unit);
    }
    if (have < need) return null;
  }
  let lovelace = [...chosen.values()].reduce((s, i) => s + lovelaceOf(i), ZERO);
  for (const i of [...inputs].sort(byDesc(lovelaceOf))) {
    if (lovelace >= want.lovelace) break;
    if (chosen.has(refOf(i))) continue;
    chosen.set(refOf(i), i);
    lovelace += lovelaceOf(i);
  }
  if (lovelace < want.lovelace) return null;
  return [...chosen.values()];
}

export type Paginate = { page: number; limit: number };

/** CIP-30 `Paginate`, or a refusal saying why it is not one. */
export function readPaginate(p: unknown): Paginate {
  const o = p as { page?: unknown; limit?: unknown } | null;
  if (!o || typeof o !== "object") throw new Cip30ArgumentError("paginate is not an object");
  const { page, limit } = o;
  if (typeof page !== "number" || !Number.isSafeInteger(page) || page < 0) {
    throw new Cip30ArgumentError("paginate.page must be a whole number from 0");
  }
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1) {
    throw new Cip30ArgumentError("paginate.limit must be a whole number from 1");
  }
  return { page, limit };
}

/**
 * One page of `list`, or `{ maxSize }` when the page is past the end.
 *
 * `maxSize` is the number of pages that exist at this `limit` — the bound a
 * dApp needs to stop asking. Page 0 of an empty list is an empty page, not an
 * error: there is nothing past the end of nothing.
 */
export function pageOf<T>(list: T[], p: Paginate): { page: T[] } | { maxSize: number } {
  const maxSize = Math.ceil(list.length / p.limit);
  if (p.page > 0 && p.page >= maxSize) return { maxSize };
  return { page: list.slice(p.page * p.limit, (p.page + 1) * p.limit) };
}

/** CIP-30 lets a wallet refuse to put up more than this as collateral; this one does. */
export const COLLATERAL_CAP_LOVELACE = BigInt(5_000_000);
/** The ledger accepts at most this many collateral inputs (`maxCollateralInputs`, Babbage/Conway). */
export const MAX_COLLATERAL_INPUTS = 3;

/**
 * Pure-ADA inputs that reach `target` and together hold at most
 * `COLLATERAL_CAP_LOVELACE`, preferring one input as close above `target` as
 * possible, else the largest ones that still fit under the cap, up to the
 * ledger's limit. `null` when no such set exists — CIP-30's answer for "this
 * wallet has no suitable collateral".
 *
 * The cap bounds what is *offered*, not only what is asked for. Collateral that
 * is taken takes the whole input, so a wallet holding a single 1000 ADA coin
 * that answers a 5 ADA request with that coin has put 1000 ADA at stake. An
 * input carrying tokens is never offered for the same reason: a site asking for
 * 5 ADA of collateral must not be able to put someone's tokens at stake with it.
 */
export function selectCollateral(inputs: tyTypes.Input[], target: bigint): tyTypes.Input[] | null {
  const pure = inputs.filter(
    (i) => (i.tokens ?? []).length === 0 && lovelaceOf(i) <= COLLATERAL_CAP_LOVELACE,
  );
  const single = pure
    .filter((i) => lovelaceOf(i) >= target)
    .sort((a, b) => {
      const d = lovelaceOf(a) - lovelaceOf(b);
      return d > ZERO ? 1 : d < ZERO ? -1 : refOf(a) < refOf(b) ? -1 : 1;
    })[0];
  if (single) return [single];
  const out: tyTypes.Input[] = [];
  let sum = ZERO;
  for (const i of [...pure].sort(byDesc(lovelaceOf))) {
    if (out.length === MAX_COLLATERAL_INPUTS) break;
    if (sum + lovelaceOf(i) > COLLATERAL_CAP_LOVELACE) continue;
    out.push(i);
    sum += lovelaceOf(i);
    if (sum >= target) return out;
  }
  return null;
}
