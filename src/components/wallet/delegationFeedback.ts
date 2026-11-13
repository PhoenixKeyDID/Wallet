/**
 * What the screen says in the minutes between "submitted" and "on chain".
 *
 * A delegation is accepted by the node in a second and recorded by the indexer
 * a block or more later. Re-reading the account right after submit returns the
 * old answer, so the panel used to say "Not delegated" under a toast that said
 * "Delegation submitted" — and a person who sees both believes the second one
 * failed and delegates again, paying a second fee.
 */

import type { PhoenixNetwork } from "@/lib/cardano";

/**
 * A delegation this wallet sent and the chain has not shown yet. Held above
 * the tab switch, so leaving the Staking tab and coming back does not drop it,
 * and tied to the account and network it was sent from, so it never shows
 * under another one.
 */
export type SentDelegation = {
  poolId: string;
  /** Reward address (bech32) that signed the certificate. */
  account: string;
  network: PhoenixNetwork;
  /** `Date.now()` at submit. */
  sentAt: number;
};

/**
 * How long "waiting" stays an honest word. A delegation lands in a block or
 * two; ten minutes with no sign of it means it most likely never got in, and
 * the screen has to stop promising that it will.
 */
export const DELEGATION_UNSEEN_MS = 10 * 60_000;

/**
 * How long the screen keeps asking the chain. A delegation can still land
 * until its TTL (`tip + 7200` slots in `buildDelegation`, about 2 hours),
 * so the "not seen" warning must be able to clear itself until then; the
 * extra hour covers a slow tip read at build time.
 */
export const DELEGATION_WATCH_LIMIT_MS = 3 * 60 * 60_000;

/**
 * Validity window, in slots, of a vote-delegation transaction: `ttl = tip +`
 * this, on the Staking tab's Abstain and on every Governance-tab build. One
 * slot is one second on mainnet, preprod and preview, so the watch below is
 * derived from it — change the TTL here and the watch follows.
 */
export const VOTE_DELEGATION_TTL_SLOTS = 7200;

/**
 * How long a sent vote delegation is still worth waiting for. It cannot land
 * after its TTL, and `sentAt` is taken after the tip that TTL was counted from
 * was read, so `TTL slots × 1 s` after `sentAt` is an upper bound on when it
 * can still land. Kept apart from {@link DELEGATION_WATCH_LIMIT_MS}, which the
 * pool-delegation watch uses with its own margin: held past the TTL, the vote
 * watch would keep "Choose Abstain" hidden for an hour after the transaction
 * could no longer get in.
 */
export const VOTE_DELEGATION_WATCH_LIMIT_MS = VOTE_DELEGATION_TTL_SLOTS * 1000;

/**
 * A vote (DRep) delegation this wallet just sent and the chain has not shown
 * yet. Held above the tab switch, the same reason {@link SentDelegation} is:
 * the Staking and Governance tabs unmount when another tab is opened, and the
 * fact that one is already in flight must still be there on return — on both
 * tabs, since either one can send the next, paid, vote delegation. Set when
 * Staking signs Abstain and when Governance signs any choice (a DRep, Abstain,
 * No Confidence). No target is kept: the screens only need to know one is in
 * flight, so every sentence about it names no choice, and the chain is the
 * authority on what it becomes.
 */
export type SentVoteDelegation = {
  /** Reward address (bech32) that signed the vote-delegation certificate. */
  account: string;
  network: PhoenixNetwork;
  /** `Date.now()` at submit. */
  sentAt: number;
  /**
   * Hash of the submitted transaction, as the submit returned it. The primary
   * "landed" test: once the indexer has this transaction in a block, the
   * delegation is on chain whatever the account's DRep reads — which is the
   * only test that works when the new choice equals the old one (X → X,
   * Abstain again) or when the DRep before sending was never read. Checked on
   * the tabs' existing re-read timer; a found hash clears the record
   * (`WalletTabs`), and with it the waiting line on both tabs.
   */
  txHash: string;
  /**
   * The DRep the chain showed for this account just before sending (`null`:
   * none; absent: not read). A secondary signal only: a chain answer that
   * differs from it also means the new choice has landed. Equal, or absent,
   * says nothing — {@link txHash} decides those.
   */
  drepBefore?: string | null;
};

/**
 * Whether the chain's current answer shows the sent vote delegation landed by
 * the secondary, DRep-change signal: it is known, the answer before sending is
 * known, and they differ. `onChain` undefined = not read (or the read failed).
 * The primary signal — the transaction itself found in a block — clears the
 * record instead, so it is not asked here.
 */
export function voteDelegationLanded(
  sent: SentVoteDelegation | null,
  onChain: string | null | undefined,
): boolean {
  if (sent === null || sent.drepBefore === undefined || onChain === undefined) return false;
  return onChain !== sent.drepBefore;
}

/**
 * One look-up of the sent vote-delegation transaction, for a tab's re-read
 * timer. Calls `onLanded(txHash)` only on a definite "it is in a block" AND a
 * fresh account read that already shows a vote delegation; "not yet", a failed
 * look-up and a failed or empty re-read all do nothing — a failure is "not
 * known", and must neither clear the waiting line nor be shown as "not in".
 *
 * Why the second read: `/tx_status` and the account endpoint can be answered
 * by Koios instances that lag each other. Clearing on the hash alone let the
 * same tick's account read still say "no DRep", so the Staking tab offered
 * Abstain again — a second, paid vote delegation — and stopped re-reading. A
 * transaction seen at zero confirmations and then rolled back fails the same
 * re-read, so it keeps the record too; the record still ends at
 * {@link VOTE_DELEGATION_WATCH_LIMIT_MS} like any other.
 *
 * `confirmOnChain` is the tab's own re-read: it resolves `true` only when that
 * read succeeded and shows a vote delegation (a DRep, Abstain or No
 * Confidence). Returns a release that drops a late answer (the tab moved on,
 * or unmounted).
 */
export function lookUpVoteTx(
  sent: SentVoteDelegation | null,
  lookUp: (network: PhoenixNetwork, txHash: string) => Promise<boolean>,
  confirmOnChain: (sent: SentVoteDelegation) => Promise<boolean>,
  onLanded: (txHash: string) => void,
): () => void {
  if (sent === null) return () => {};
  let alive = true;
  const { network, txHash } = sent;
  lookUp(network, txHash)
    .then((seen) => (alive && seen ? confirmOnChain(sent) : false))
    .then(
      (onChain) => {
        if (alive && onChain) onLanded(txHash);
      },
      () => {},
    );
  return () => {
    alive = false;
  };
}

/** When a sent vote delegation can no longer land (see {@link VOTE_DELEGATION_WATCH_LIMIT_MS}). */
export function voteDelegationExpiresAt(sent: SentVoteDelegation): number {
  return sent.sentAt + VOTE_DELEGATION_WATCH_LIMIT_MS;
}

/**
 * A moment as the reader's own clock shows it, `HH:MM` in local time. Used in
 * the sentences that say when a vote delegation was sent or stops being able
 * to land, so the time can be matched against the History tab.
 */
export function clockTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export type VoteDelegationWatch = { kind: "none" } | { kind: "pending" } | { kind: "unseen" };

/**
 * Where a just-sent vote delegation stands, by the clock alone:
 *
 * - `none`: nothing sent, sent from another account or network, or past
 *   {@link VOTE_DELEGATION_WATCH_LIMIT_MS} — it can no longer land, so the
 *   screens go back to reading the chain directly.
 * - `pending`: within {@link DELEGATION_UNSEEN_MS} of sending — the usual wait.
 * - `unseen`: longer than that, still inside the validity window — it most
 *   likely did not get in, but still can until the window closes.
 *
 * Whether the chain already shows it is the caller's half: each tab looks the
 * transaction up by {@link SentVoteDelegation.txHash} on its re-read timer and
 * reports a hit, which drops the record. On top of that the Staking tab reads
 * any recorded DRep as "landed", since it only offers Abstain to an account
 * that had none, and the Governance tab reads a DRep different from the one
 * before sending as "landed".
 */
export function voteDelegationWatch(
  sent: SentVoteDelegation | null,
  account: string | null,
  network: PhoenixNetwork,
  now: number,
): VoteDelegationWatch {
  if (sent === null || sent.account !== account || sent.network !== network) return { kind: "none" };
  const age = now - sent.sentAt;
  if (age >= VOTE_DELEGATION_WATCH_LIMIT_MS) return { kind: "none" };
  if (age > DELEGATION_UNSEEN_MS) return { kind: "unseen" };
  return { kind: "pending" };
}

/**
 * Whether a just-sent vote delegation may still land ({@link voteDelegationWatch}
 * is `pending` or `unseen`). While true neither tab may offer a vote delegation
 * as though none were in flight.
 */
export function voteDelegationPending(
  sent: SentVoteDelegation | null,
  account: string | null,
  network: PhoenixNetwork,
  now: number,
): boolean {
  return voteDelegationWatch(sent, account, network, now).kind !== "none";
}

export type DelegationWatch =
  | { kind: "none" }
  | { kind: "settled" }
  | { kind: "pending"; poolId: string }
  | { kind: "unseen"; poolId: string };

/**
 * What the screen should say about a sent delegation, given what the chain
 * shows for this account now.
 *
 * - `none`: nothing sent, or it was sent from another account or network.
 * - `settled`: the chain shows the pool that was sent.
 * - `pending`: not on chain yet, still within {@link DELEGATION_UNSEEN_MS}.
 * - `unseen`: past that limit and still not on chain.
 */
export function delegationWatch(
  sent: SentDelegation | null,
  account: string | null,
  network: PhoenixNetwork,
  onChain: string | null | undefined,
  now: number,
): DelegationWatch {
  if (sent === null || sent.account !== account || sent.network !== network) return { kind: "none" };
  if (onChain === sent.poolId) return { kind: "settled" };
  if (now - sent.sentAt > DELEGATION_UNSEEN_MS) return { kind: "unseen", poolId: sent.poolId };
  return { kind: "pending", poolId: sent.poolId };
}

/** Hardened account indexes stop below 2^31. */
const MAX_ACCOUNT_INDEX = 2 ** 31 - 1;

/**
 * The index the switch-account form opens on. Pre-filling the account that is
 * already open made the obvious next press — enter the password, open — reload
 * the same account and look like nothing happened.
 */
export function nextAccountIndex(current: number): number {
  return current < MAX_ACCOUNT_INDEX ? current + 1 : current;
}
