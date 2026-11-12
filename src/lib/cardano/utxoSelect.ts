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
 * How many sub-target coins the pair/triple search looks at. C(40, 3) = 9 880
 * triples — instant — whereas a wallet of dust could otherwise ask for
 * millions. Only coins below `target` take part in combinations (a combination
 * holding a coin that reaches `target` alone always sums to more than that
 * coin, so it can never win), and when there are more than this many the
 * LARGEST are kept: under a 5 ADA cap, what a combination has to do is reach
 * `target`, and the smallest coins are the ones least able to.
 */
export const COLLATERAL_SEARCH_POOL = 40;

/**
 * Pure-ADA inputs that reach `target` and together hold at most
 * `COLLATERAL_CAP_LOVELACE`, using at most `MAX_COLLATERAL_INPUTS` of them.
 * `null` when no such set exists — CIP-30's answer for "this wallet has no
 * suitable collateral".
 *
 * Every set of one, two and three coins is considered (pairs and triples
 * within `COLLATERAL_SEARCH_POOL`), and the winner is the smallest total, then
 * the fewest coins, then the lowest `txid#index` list — so the answer is
 * deterministic and puts the least ADA at stake. A greedy pick was not enough:
 * 4 / 2.5 / 2.5 ADA against a 4.5 ADA target took the 4, could not add a 2.5
 * under the cap, and answered `null` while 2.5 + 2.5 was right there.
 *
 * The cap bounds what is *offered*, not only what is asked for. Collateral that
 * is taken takes the whole input, so a wallet holding a single 1000 ADA coin
 * that answers a 5 ADA request with that coin has put 1000 ADA at stake. An
 * input carrying tokens is never offered for the same reason: a site asking for
 * 5 ADA of collateral must not be able to put someone's tokens at stake with it.
 *
 * With no `target` (a `getCollateral()` call without `amount`), the site has
 * not said how much it needs, so the wallet offers the most it is willing to:
 * the pure-ADA set with the LARGEST total that stays within the cap, then the
 * fewest coins, then the lowest `txid#index` list — and only when that total
 * reaches `COLLATERAL_FLOOR_LOVELACE`. Using the cap as the target instead
 * answered only a wallet whose coins summed to exactly 5 ADA.
 */
export function selectCollateral(inputs: tyTypes.Input[], target?: bigint): tyTypes.Input[] | null {
  if (target === undefined) return selectLargestCollateral(inputs);
  if (target > COLLATERAL_CAP_LOVELACE) return null;
  const byAscThenRef = (a: tyTypes.Input, b: tyTypes.Input) => {
    const d = lovelaceOf(a) - lovelaceOf(b);
    return d > ZERO ? 1 : d < ZERO ? -1 : refOf(a) < refOf(b) ? -1 : refOf(a) > refOf(b) ? 1 : 0;
  };
  const pure = inputs
    .filter((i) => (i.tokens ?? []).length === 0 && lovelaceOf(i) <= COLLATERAL_CAP_LOVELACE)
    .sort(byAscThenRef);

  let best: { sum: bigint; coins: tyTypes.Input[] } | null = null;
  const consider = (coins: tyTypes.Input[]) => {
    const sum = coins.reduce((s, i) => s + lovelaceOf(i), ZERO);
    if (sum < target || sum > COLLATERAL_CAP_LOVELACE) return;
    if (best) {
      if (sum > best.sum) return;
      if (sum === best.sum) {
        if (coins.length > best.coins.length) return;
        if (coins.length === best.coins.length) {
          const a = coins.map(refOf).join(",");
          const b = best.coins.map(refOf).join(",");
          if (a >= b) return;
        }
      }
    }
    best = { sum, coins };
  };

  // One coin: the smallest that reaches `target` (the list is ascending).
  const single = pure.find((i) => lovelaceOf(i) >= target);
  if (single) consider([single]);

  // Two and three coins, from sub-target coins only. Indices ascend, so each
  // set is visited once and its coins are already in ascending order.
  const below = pure.filter((i) => lovelaceOf(i) < target);
  const pool = below.length > COLLATERAL_SEARCH_POOL ? below.slice(below.length - COLLATERAL_SEARCH_POOL) : below;
  for (let a = 0; a < pool.length; a++) {
    for (let b = a + 1; b < pool.length; b++) {
      consider([pool[a]!, pool[b]!]);
      if (MAX_COLLATERAL_INPUTS < 3) continue;
      for (let c = b + 1; c < pool.length; c++) consider([pool[a]!, pool[b]!, pool[c]!]);
    }
  }
  return best ? (best as { coins: tyTypes.Input[] }).coins : null;
}

/** Below this, a no-amount `getCollateral()` answers `null`: too little to cover a script's collateral. */
export const COLLATERAL_FLOOR_LOVELACE = BigInt(1_000_000);

/** `selectCollateral` without a target: the largest pure-ADA total within the cap, from 1 ADA. */
function selectLargestCollateral(inputs: tyTypes.Input[]): tyTypes.Input[] | null {
  const byAscThenRef = (a: tyTypes.Input, b: tyTypes.Input) => {
    const d = lovelaceOf(a) - lovelaceOf(b);
    return d > ZERO ? 1 : d < ZERO ? -1 : refOf(a) < refOf(b) ? -1 : refOf(a) > refOf(b) ? 1 : 0;
  };
  const pure = inputs
    .filter((i) => (i.tokens ?? []).length === 0 && lovelaceOf(i) <= COLLATERAL_CAP_LOVELACE)
    .sort(byAscThenRef);
  // Combinations come from the largest coins: they are the ones that get a
  // total closest to the cap. Single coins are all considered.
  const pool = pure.length > COLLATERAL_SEARCH_POOL ? pure.slice(pure.length - COLLATERAL_SEARCH_POOL) : pure;

  let best: { sum: bigint; coins: tyTypes.Input[] } | null = null;
  const consider = (coins: tyTypes.Input[]) => {
    const sum = coins.reduce((s, i) => s + lovelaceOf(i), ZERO);
    if (sum > COLLATERAL_CAP_LOVELACE) return;
    if (best) {
      if (sum < best.sum) return;
      if (sum === best.sum) {
        if (coins.length > best.coins.length) return;
        if (coins.length === best.coins.length && coins.map(refOf).join(",") >= best.coins.map(refOf).join(",")) {
          return;
        }
      }
    }
    best = { sum, coins };
  };
  for (const coin of pure) consider([coin]);
  for (let a = 0; a < pool.length; a++) {
    for (let b = a + 1; b < pool.length; b++) {
      consider([pool[a]!, pool[b]!]);
      if (MAX_COLLATERAL_INPUTS < 3) continue;
      for (let c = b + 1; c < pool.length; c++) consider([pool[a]!, pool[b]!, pool[c]!]);
    }
  }
  const found = best as { sum: bigint; coins: tyTypes.Input[] } | null;
  return found && found.sum >= COLLATERAL_FLOOR_LOVELACE ? found.coins : null;
}
