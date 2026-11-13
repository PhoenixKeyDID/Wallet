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
import { sameVoteTarget } from "@/lib/cardano/governance";

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
 * No Confidence). The screens' sentences about it still name no choice; the
 * {@link target} is kept so that the chain's answer can be checked against
 * what was sent, not merely for being non-empty.
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
  /**
   * The choice sent, as the account endpoint names it (`voteTargetId`): a
   * `drep1…` id, `drep_always_abstain` or `drep_always_no_confidence`. The
   * record ends only when the chain shows THIS: an account read that still
   * shows the old DRep after `/tx_status` has seen the transaction (the two
   * endpoints can be served by Koios instances that lag each other) must not
   * end it. Absent only on a record written by an earlier version of this
   * wallet; {@link voteDelegationConfirmed} then falls back to "differs from
   * {@link drepBefore}".
   */
  target?: string;
};

/**
 * Whether the chain's vote delegation `onChain` is the one `sent` asked for:
 * the target when it is known; for an older record without one, a delegation
 * different from the one read before sending (unknown before ⟹ never: the
 * record then waits out its watch limit, at most two hours). `null` (no
 * delegation) and `undefined` (not read) never confirm.
 */
export function voteDelegationConfirmed(
  sent: SentVoteDelegation,
  onChain: string | null | undefined,
): boolean {
  if (onChain === undefined || onChain === null) return false;
  if (sent.target !== undefined) return sameVoteTarget(onChain, sent.target);
  return sent.drepBefore !== undefined && onChain !== sent.drepBefore;
}

/**
 * Whether the chain's current answer shows the sent vote delegation landed by
 * the secondary, DRep-change signal: the answer before sending is known, the
 * chain now shows the sent choice ({@link voteDelegationConfirmed}), and that
 * is a change. `onChain` undefined = not read (or the read failed). When the
 * choice equals the DRep before (X → X), or the DRep before was never read, a
 * read cannot tell old from new and this says nothing; the primary signal —
 * the transaction itself found in a block — decides those, and clears the
 * record instead, so it is not asked here.
 */
export function voteDelegationLanded(
  sent: SentVoteDelegation | null,
  onChain: string | null | undefined,
): boolean {
  if (sent === null || sent.drepBefore === undefined) return false;
  if (!voteDelegationConfirmed(sent, onChain)) return false;
  if (sent.drepBefore === null || sent.target === undefined) return true;
  return !sameVoteTarget(sent.drepBefore, sent.target);
}

/**
 * One look-up of the sent vote-delegation transaction, for a tab's re-read
 * timer. Calls `onLanded(txHash)` only on a definite "it is in a block" AND a
 * fresh account read that already shows the sent choice; "not yet", a failed
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
 * read succeeded and {@link voteDelegationConfirmed} accepts it — the chain
 * shows the sent target, not just any vote delegation (an old DRep still
 * read from a lagging instance is not the new one). Returns a release that
 * drops a late answer (the tab moved on, or unmounted).
 *
 * `onSettled(txHash)` runs once the whole look-up has answered, whatever the
 * answer (also after `onLanded`, and after a failure), unless released first.
 * The tabs hold the "not seen" line back until then for the record they are
 * showing, so a tab opened past {@link DELEGATION_UNSEEN_MS} does not say "not
 * seen" before it has asked.
 */
export function lookUpVoteTx(
  sent: SentVoteDelegation | null,
  lookUp: (network: PhoenixNetwork, txHash: string) => Promise<boolean>,
  confirmOnChain: (sent: SentVoteDelegation) => Promise<boolean>,
  onLanded: (txHash: string) => void,
  onSettled?: (txHash: string) => void,
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
    )
    .then(() => {
      if (alive) onSettled?.(txHash);
    });
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
 * reports a hit confirmed by an account read showing the sent target
 * ({@link voteDelegationConfirmed}), which drops the record. On top of that
 * the Staking tab stops its line once any DRep is recorded, since it only
 * offers Abstain to an account that had none, and the Governance tab stops
 * its line once the chain shows the sent target in place of a different one
 * ({@link voteDelegationLanded}).
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
