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
