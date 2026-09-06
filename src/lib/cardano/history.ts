/**
 * Transaction history: what this wallet has already done.
 *
 * The wallet could show balances and build transactions, and then had nothing
 * to say about the ones it had sent. That gap is not cosmetic. A person who
 * cannot see a transaction cannot tell a payment that went through from one
 * that never left, cannot check what a dApp actually did after they approved
 * it, and has to go to a block explorer — handing a third party the link
 * between their addresses and their browser, which is the exact link the rest
 * of this module works to avoid.
 *
 * **The question this module answers is "what did this do to my money", not
 * "what does the indexer say".** A transaction is a movement between two sides
 * and the chain describes both; only one of them is the reader's. So every
 * amount here is signed from the wallet's point of view, and a transaction is
 * classified by what it did rather than by which endpoint returned it.
 *
 * Three things the chain reports that a naive reading gets wrong, all of them
 * money-visible:
 *
 * 1. **A withdrawal is income that never appears as an input.** Staking rewards
 *    enter a transaction through the withdrawals field. Reading inputs and
 *    outputs alone reports a transaction that drained a reward account as
 *    costing nothing — the same blind spot `txSummary.ts` had on the signing
 *    path, arrived at from the other direction.
 * 2. **Change is not a payment.** An output returning to the wallet's own
 *    address is the wallet's own money coming back. Counting it as sent turns
 *    "I paid 5 ADA" into "I paid 95".
 * 3. **The fee is already inside the difference.** Inputs cover outputs *and*
 *    the fee, so a net computed from inputs minus outputs has the fee in it.
 *    Subtracting it again double-counts.
 */
import "../node-globals";
import { koios, fetchTipBlockHeight } from "./provider";
import type { PhoenixNetwork } from "./address";

/** One asset moving, from this wallet's point of view. Negative means it left. */
export type AssetChange = {
  /** `policyId + assetNameHex`; the empty string is ADA. */
  unit: string;
  policyId: string;
  assetNameHex: string;
  amount: bigint;
};

/**
 * What a transaction did, in the terms a person asks about it.
 *
 * Deliberately not a mirror of the indexer's row: `sent`/`received` is the
 * reader's own direction, and the classification exists so the list can say
 * "Withdrawal" the way a person would, rather than making them infer it from
 * a field being non-empty.
 */
export type TxKind = "sent" | "received" | "internal" | "withdrawal" | "delegation" | "mint";

export type HistoryEntry = {
  txHash: string;
  /** Milliseconds since the epoch, so a caller can format it in the user's locale. */
  timeMs: number;
  blockHeight: number;
  /** Lovelace paid to the network. Always positive; already included in `net`. */
  fee: bigint;
  /** Staking rewards this transaction pulled into the wallet. */
  withdrawnLovelace: bigint;
  /**
   * Net change per asset, signed: negative left the wallet, positive arrived.
   *
   * Assets that came in and went straight back out do not appear at all — a
   * zero net is not news, and listing it invites the reader to add up numbers
   * that cancel.
   */
  net: AssetChange[];
  kind: TxKind;
  /** Counterparty addresses, bech32 and never truncated. Empty for pure receives. */
  counterparties: string[];
};

/** Thrown when a row cannot be read. Never a partial entry. */
export class HistoryError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "HistoryError";
  }
}

function bad(reason: string): never {
  throw new HistoryError(reason);
}

function asBigInt(v: unknown, what: string): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) bad(`${what} is not a whole number`);
    return BigInt(v);
  }
  if (typeof v === "string" && /^-?\d+$/.test(v)) return BigInt(v);
  return bad(`${what} is not a number this wallet can read`);
}

type KoiosAsset = { policy_id?: unknown; asset_name?: unknown; quantity?: unknown };
type KoiosIO = {
  payment_addr?: { bech32?: unknown } | null;
  value?: unknown;
  asset_list?: KoiosAsset[] | null;
};
type KoiosTx = {
  tx_hash?: unknown;
  tx_timestamp?: unknown;
  block_height?: unknown;
  fee?: unknown;
  inputs?: KoiosIO[] | null;
  outputs?: KoiosIO[] | null;
  withdrawals?: Array<{ amount?: unknown }> | null;
  assets_minted?: KoiosAsset[] | null;
  certificates?: unknown[] | null;
};

/** Accumulate one side of the transaction into `into`, for rows the wallet owns. */
function tally(
  rows: KoiosIO[] | null | undefined,
  own: ReadonlySet<string>,
  into: Map<string, bigint>,
  sign: bigint,
  strangers?: Set<string>,
): void {
  for (const r of rows ?? []) {
    const addr = r.payment_addr?.bech32;
    if (typeof addr !== "string" || addr.length === 0) {
      // An output with no readable address is not something to skip quietly:
      // it is a chunk of the transaction this wallet cannot account for, and
      // every number derived from it would be short by that much.
      bad("this transaction moves value through an address this wallet cannot read");
    }
    if (!own.has(addr)) {
      if (strangers) strangers.add(addr);
      continue;
    }
    into.set("", (into.get("") ?? BigInt(0)) + sign * asBigInt(r.value, "an amount"));
    for (const a of r.asset_list ?? []) {
      const policyId = typeof a.policy_id === "string" ? a.policy_id : bad("an asset has no policy");
      const nameHex = typeof a.asset_name === "string" ? a.asset_name : "";
      const unit = policyId + nameHex;
      into.set(unit, (into.get(unit) ?? BigInt(0)) + sign * asBigInt(a.quantity, "an asset amount"));
    }
  }
}

/**
 * Turn one indexer row into an entry told from this wallet's side.
 *
 * Exported for the tests, which pin the three miscounts in the module docstring
 * against fixtures rather than against a live chain.
 */
export function readTx(row: KoiosTx, ownAddresses: ReadonlySet<string>): HistoryEntry {
  const txHash = typeof row.tx_hash === "string" ? row.tx_hash : bad("a row has no transaction id");
  const fee = asBigInt(row.fee ?? 0, "the fee");

  // Spent by us, returned to us. `net = returned - spent` is negative when
  // money left, which is the sign a reader expects on a payment.
  const spent = new Map<string, bigint>();
  const returned = new Map<string, bigint>();
  const strangers = new Set<string>();
  tally(row.inputs, ownAddresses, spent, BigInt(1));
  tally(row.outputs, ownAddresses, returned, BigInt(1), strangers);

  let withdrawn = BigInt(0);
  for (const w of row.withdrawals ?? []) withdrawn += asBigInt(w.amount ?? 0, "a withdrawal amount");

  const units = new Set([...spent.keys(), ...returned.keys()]);
  const net: AssetChange[] = [];
  for (const unit of units) {
    let delta = (returned.get(unit) ?? BigInt(0)) - (spent.get(unit) ?? BigInt(0));
    // Rewards arrive without ever being an input, so they are added here rather
    // than found above. Without this the row reads as "cost you the fee" for a
    // transaction that in fact paid you.
    if (unit === "") delta -= withdrawn;
    if (delta === BigInt(0)) continue;
    net.push({
      unit,
      policyId: unit.slice(0, 56),
      assetNameHex: unit.slice(56),
      amount: delta,
    });
  }

  const touchedUs = spent.size > 0;
  const minted = (row.assets_minted ?? []).length > 0;
  const delegated = (row.certificates ?? []).length > 0;

  // Order matters: a transaction can be several of these at once, and the label
  // should name the reason the person is looking at it. Money moving to someone
  // else is that reason whenever it happened.
  let kind: TxKind;
  if (withdrawn > BigInt(0) && strangers.size === 0) kind = "withdrawal";
  else if (minted) kind = "mint";
  // A delegation costs a fee and pays nobody, so its ADA is always negative —
  // testing the sign would classify every one of them as an ordinary internal
  // move. What separates it is that no stranger received anything.
  else if (delegated && strangers.size === 0) kind = "delegation";
  else if (!touchedUs) kind = "received";
  else if (strangers.size === 0) kind = "internal";
  else kind = "sent";

  return {
    txHash,
    timeMs: Number(asBigInt(row.tx_timestamp ?? 0, "a timestamp")) * 1000,
    blockHeight: Number(asBigInt(row.block_height ?? 0, "a block height")),
    fee,
    withdrawnLovelace: withdrawn,
    net,
    kind,
    counterparties: [...strangers],
  };
}

/**
 * What a row is allowed to show, given how much the wallet knows about itself.
 *
 * A pure function rather than a branch inside the panel, because this is the
 * decision that either shows a wrong number or admits to not knowing, and a
 * decision that important should be pinned by a test rather than by reading
 * JSX. Named states rather than a nullable amount for the same reason: `null`
 * would let a caller render "0 ADA" without noticing it had been told nothing.
 */
export type RowDisplay =
  | { show: true; ada: bigint; tokens: AssetChange[] }
  | { show: false; reason: "owned_set_incomplete" };

/**
 * `ownedIsComplete` is load-bearing, not cosmetic.
 *
 * A CIP-30 extension answers with the addresses it chooses to admit to, which
 * is a subset of the ones it owns. Every address it withheld is read here as a
 * stranger's, so the wallet's own change becomes a payment: a 5 ADA send off a
 * 100 ADA input reads as "sent 95". The number is plausible, which is what
 * makes it worse than no number at all.
 */
export function rowDisplay(entry: HistoryEntry, ownedIsComplete: boolean): RowDisplay {
  if (!ownedIsComplete) return { show: false, reason: "owned_set_incomplete" };
  return {
    show: true,
    ada: entry.net.find((n) => n.unit === "")?.amount ?? BigInt(0),
    tokens: entry.net.filter((n) => n.unit !== ""),
  };
}

/**
 * How many blocks deep this transaction is, or `null` when that is unknowable.
 *
 * `null` when the tip is behind the entry, which happens for real: the tip and
 * the transaction list are two calls, and a block can be minted between them.
 * Clamping to zero or to one would answer a question nobody could act on, and
 * "1 confirmation" is precisely the answer a person waits on before treating a
 * payment as settled.
 */
export function confirmationsOf(entry: HistoryEntry, tipBlockHeight: number | null): number | null {
  if (tipBlockHeight === null) return null;
  if (entry.blockHeight <= 0 || tipBlockHeight < entry.blockHeight) return null;
  return tipBlockHeight - entry.blockHeight + 1;
}

/** Transaction hashes touching these addresses, newest first. */
export async function fetchAddressTxHashes(
  network: PhoenixNetwork,
  addresses: string[],
): Promise<string[]> {
  if (addresses.length === 0) return [];
  const rows = await koios<Array<{ tx_hash?: unknown }>>(network, "/address_txs", {
    _addresses: addresses,
  });
  const out: string[] = [];
  for (const r of rows) {
    if (typeof r.tx_hash !== "string") bad("the indexer listed a transaction with no id");
    out.push(r.tx_hash);
  }
  return out;
}

/**
 * Full detail for the given transactions, told from this wallet's side.
 *
 * The detail flags are not optional extras: Koios omits inputs, withdrawals and
 * asset lists unless asked, and every one of them is load-bearing here. Without
 * `_inputs` nothing can be attributed to the wallet at all; without
 * `_withdrawals` a rewards transaction reads as free money with no source;
 * without `_assets` a token transfer shows up as a bare ADA movement; without
 * `_certs` the certificate list arrives empty and every delegation is labelled
 * an ordinary internal move.
 *
 * The last one is the reason to name them all explicitly rather than trust the
 * defaults: measured against the live indexer on 2026-09-06, `/tx_info` returns
 * all of these **keys** whether or not they were asked for, and merely leaves
 * them empty. So a missing flag does not fail — it answers "there were none",
 * which is the shape of a wrong number rather than of an error.
 */
export async function fetchTxDetails(
  network: PhoenixNetwork,
  txHashes: string[],
  ownAddresses: Iterable<string>,
): Promise<HistoryEntry[]> {
  if (txHashes.length === 0) return [];
  const own = new Set(ownAddresses);
  const rows = await koios<KoiosTx[]>(network, "/tx_info", {
    _tx_hashes: txHashes,
    _inputs: true,
    _withdrawals: true,
    _assets: true,
    _certs: true,
  });
  return rows.map((r) => readTx(r, own)).sort((a, b) => b.timeMs - a.timeMs);
}

/**
 * A page of history, plus the chain height it was read against.
 *
 * The height travels with the entries because a confirmation count is not a
 * property of a transaction — it is the distance between that transaction and
 * the tip at the moment of asking. Storing a number of confirmations on an
 * entry would freeze a value that goes stale every twenty seconds; carrying the
 * tip lets the screen subtract, and lets it say *nothing* when it does not know.
 */
export type HistoryPage = {
  entries: HistoryEntry[];
  /** Block height of the chain tip when this page was read. */
  tipBlockHeight: number;
};

/**
 * The wallet's recent history, newest first.
 *
 * `limit` bounds the detail call rather than the listing: `/address_txs` is one
 * cheap row per transaction, while `/tx_info` carries every input and output of
 * each one. Asking for detail on a thousand transactions to show twenty is how
 * a wallet becomes slow on exactly the accounts that have the most history.
 */
export async function fetchHistory(
  network: PhoenixNetwork,
  addresses: string[],
  limit = 25,
): Promise<HistoryPage> {
  const [hashes, tipBlockHeight] = await Promise.all([
    fetchAddressTxHashes(network, addresses),
    fetchTipBlockHeight(network),
  ]);
  if (hashes.length === 0) return { entries: [], tipBlockHeight };
  return {
    entries: await fetchTxDetails(network, hashes.slice(0, limit), addresses),
    tipBlockHeight,
  };
}
