/**
 * Where a sent, not-yet-seen vote delegation is remembered across a session
 * lock and a page reload.
 *
 * The record (`SentVoteDelegation`) is what stops either tab offering a second,
 * paid vote delegation while the first one is still on its way. Held only in
 * `WalletTabs` state, it died with the component: the local wallet locks when
 * the page is hidden, which unmounts the tabs, and unlocking brought back
 * "this account has no DRep" with the Abstain button armed — within the same
 * minute or two the waiting line had just asked the reader to wait. A reload
 * did the same. That is the boundary `uncertainStore` already describes for
 * the unresolved-submit warning, and it is crossed the same way: by waiting.
 *
 * Same shape and keying as `uncertainStore` — plain functions over a
 * `Storage`-like object, one slot per network and stake credential, with that
 * module's fallback slot — and its helpers are reused rather than copied, so
 * the two cannot drift.
 *
 * Unlike the unresolved-submit warning this record has a natural end: the
 * transaction cannot land after its TTL, so a record older than
 * `VOTE_DELEGATION_WATCH_LIMIT_MS` is dropped on read and reported as expired,
 * which lets the screen say so once instead of going quiet.
 *
 * ## Failure
 *
 * A read that throws returns "none" — the screen is then no worse than before
 * this module existed. A stored value that is not the record's shape in the
 * fields this build knows is removed and treated as none: no field is guessed,
 * because a guessed `sentAt` or `account` would hide the Abstain offer on the
 * wrong account or for the wrong length of time. A field this build does not
 * know is skipped instead of fatal: the record was written by a newer build of
 * this wallet (`resend` was one, `drepBefore` and `target` before it), and a
 * tab on the older build reading it as malformed removed it — which fired a
 * `storage` event, so every up-to-date tab dropped its pending line while the
 * transaction was still on its way.
 */

import type { PhoenixNetwork } from "@/lib/cardano";
import { VOTE_DELEGATION_WATCH_LIMIT_MS, type SentVoteDelegation } from "./delegationFeedback";
import { isTxHash, slotKey, type KeyValueStore } from "./uncertainStore";

const PREFIX = "phoenix.sentVoteDelegation";

/** The storage key for one account on one chain (same rules as `lockKey`). */
export function voteDelegationKey(network: number, accountKey: string): string {
  return slotKey(PREFIX, network, accountKey);
}

export type StoredVoteDelegation =
  | { kind: "none" }
  | { kind: "live"; sent: SentVoteDelegation }
  | { kind: "expired"; sent: SentVoteDelegation };

/**
 * The stored text as a record for `network`, or `null` if it is anything else.
 * The fields this build knows (the ones named below), exactly: a missing one,
 * one with the wrong shape, or a record for another network is "not ours".
 *
 * A field this build does not know is skipped, not fatal: the record was
 * written by a newer build of this wallet (`resend` was one such field,
 * `drepBefore` and `target` before it), and a tab on the older build reading
 * it as malformed removed it — the `storage` event that fires on removal then
 * dropped the pending line on every up-to-date tab while the transaction was
 * still on its way. The skipped field is not guessed at and not rewritten:
 * this build keeps only what it understands.
 *
 * `target` is optional on read: records written before it existed (at most
 * one watch window, two hours, old) are still read, and judged by the older
 * "differs from the DRep before" rule (`voteDelegationConfirmed`). Dropping
 * them instead would bring the Abstain offer back while a vote delegation may
 * still be on its way — the paid double-send this record exists to stop —
 * while keeping them costs at most a waiting line held to its watch limit.
 * A `target` that is present but not a non-empty string is malformed.
 */
function parseRecord(raw: string, network: number): SentVoteDelegation | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const { account, sentAt, txHash, drepBefore, target, resend } = o;
  if (typeof account !== "string" || account.length === 0) return null;
  if (o.network !== network || (network !== 0 && network !== 1 && network !== 2)) return null;
  if (typeof sentAt !== "number" || !Number.isSafeInteger(sentAt) || sentAt < 0) return null;
  if (!isTxHash(txHash)) return null;
  const sent: SentVoteDelegation = {
    account,
    network: network as PhoenixNetwork,
    sentAt,
    txHash: txHash.toLowerCase(),
  };
  if ("drepBefore" in o) {
    if (drepBefore !== null && typeof drepBefore !== "string") return null;
    sent.drepBefore = drepBefore;
  }
  if ("target" in o) {
    if (typeof target !== "string" || target.length === 0) return null;
    sent.target = target;
  }
  if ("resend" in o) {
    if (resend !== true) return null;
    sent.resend = true;
  }
  return sent;
}

function remove(store: KeyValueStore, key: string): void {
  try {
    store.removeItem(key);
  } catch {
    // Cleaning up is a courtesy; the read has already decided its answer.
  }
}

/**
 * The sent vote delegation stored for this account on this chain.
 *
 * - `live`: still able to land at `now`.
 * - `expired`: past its watch limit — removed here, and returned once so the
 *   screen can say it ran out rather than silently forget it.
 * - `none`: nothing stored, unreadable storage, or a malformed value (removed).
 *
 * A `sentAt` further in the future than the whole watch window cannot have
 * been written by this wallet's clock and is treated as malformed.
 */
export function readSentVote(
  store: KeyValueStore | null | undefined,
  network: number,
  accountKey: string,
  now: number,
): StoredVoteDelegation {
  if (!store) return { kind: "none" };
  const key = voteDelegationKey(network, accountKey);
  try {
    const raw = store.getItem(key);
    if (raw === null) return { kind: "none" };
    const sent = parseRecord(raw, network);
    if (sent === null || sent.sentAt - now > VOTE_DELEGATION_WATCH_LIMIT_MS) {
      remove(store, key);
      return { kind: "none" };
    }
    if (now - sent.sentAt >= VOTE_DELEGATION_WATCH_LIMIT_MS) {
      remove(store, key);
      return { kind: "expired", sent };
    }
    return { kind: "live", sent };
  } catch {
    return { kind: "none" };
  }
}

/**
 * Remember a sent vote delegation under its own network. Returns whether it
 * will survive a reload; `false` (no storage, a full quota, a hash that is not
 * one) leaves the caller's in-memory copy as the only one.
 */
export function writeSentVote(
  store: KeyValueStore | null | undefined,
  accountKey: string,
  sent: SentVoteDelegation,
): boolean {
  if (!store || !isTxHash(sent.txHash)) return false;
  const record: Record<string, unknown> = {
    account: sent.account,
    network: sent.network,
    sentAt: sent.sentAt,
    txHash: sent.txHash.toLowerCase(),
  };
  if (sent.drepBefore !== undefined) record.drepBefore = sent.drepBefore;
  if (sent.target !== undefined) record.target = sent.target;
  if (sent.resend === true) record.resend = true;
  try {
    store.setItem(voteDelegationKey(sent.network, accountKey), JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

/**
 * Forget the stored record for `txHash` — only that one: a newer record sent
 * meanwhile (another hash) stays. A stored value that is not a record at all
 * is removed too; it was never going to be read back.
 */
export function clearSentVote(
  store: KeyValueStore | null | undefined,
  network: number,
  accountKey: string,
  txHash: string,
): void {
  if (!store) return;
  const key = voteDelegationKey(network, accountKey);
  try {
    const raw = store.getItem(key);
    if (raw === null) return;
    const sent = parseRecord(raw, network);
    if (sent === null || sent.txHash === txHash.toLowerCase()) store.removeItem(key);
  } catch {
    // Unreadable storage: the in-memory copy is cleared by the caller either
    // way, and a stale record expires on its own at its watch limit.
  }
}

const LEFT_PREFIX = "phoenix.leftVoteDelegation";

/** The storage key for the choice an account last moved away from. */
export function leftVoteKey(network: number, accountKey: string): string {
  return slotKey(LEFT_PREFIX, network, accountKey);
}

/**
 * Remember that a sent vote delegation landed and moved this account away
 * from `drep` (the record's `drepBefore`). Read back by `readLeftVote` when the
 * next choice is sent: sending `drep` again is a send-back, and an account
 * read from a Koios instance that has not applied the move yet still shows
 * `drep` (`SentVoteDelegation.resend`). One slot: the last move only. Two
 * moves inside one indexer lag (X → Y → Z, then X) are not covered.
 */
export function rememberLeftVote(
  store: KeyValueStore | null | undefined,
  network: number,
  accountKey: string,
  drep: string,
  at: number,
): void {
  if (!store || drep.length === 0) return;
  try {
    store.setItem(leftVoteKey(network, accountKey), JSON.stringify({ drep, at }));
  } catch {
    // Not kept: the next send-back is then judged as any other choice, which
    // is what there was before this memory existed.
  }
}

/**
 * The choice this account last moved away from, if that move landed within
 * one watch window (`VOTE_DELEGATION_WATCH_LIMIT_MS`) of `now`; otherwise, or
 * on a malformed value (removed), `null`. Indexer instances lag each other by
 * minutes, not hours: a move older than the window is not what a lagging read
 * still shows, and keeping it would only stop reads ending records for good.
 */
export function readLeftVote(
  store: KeyValueStore | null | undefined,
  network: number,
  accountKey: string,
  now: number,
): string | null {
  if (!store) return null;
  const key = leftVoteKey(network, accountKey);
  try {
    const raw = store.getItem(key);
    if (raw === null) return null;
    let v: unknown;
    try {
      v = JSON.parse(raw);
    } catch {
      v = null;
    }
    const o = typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    if (
      o === null ||
      Object.keys(o).length !== 2 ||
      typeof o.drep !== "string" ||
      o.drep.length === 0 ||
      typeof o.at !== "number" ||
      !Number.isSafeInteger(o.at)
    ) {
      remove(store, key);
      return null;
    }
    if (Math.abs(now - o.at) >= VOTE_DELEGATION_WATCH_LIMIT_MS) {
      remove(store, key);
      return null;
    }
    return o.drep;
  } catch {
    return null;
  }
}
