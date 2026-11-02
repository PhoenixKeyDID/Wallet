/**
 * What the screen says in the minutes between "submitted" and "on chain".
 *
 * A delegation is accepted by the node in a second and recorded by the indexer
 * a block or more later. Re-reading the account right after submit returns the
 * old answer, so the panel used to say "Not delegated" under a toast that said
 * "Delegation submitted" — and a person who sees both believes the second one
 * failed and delegates again, paying a second fee.
 */

/**
 * The pool a delegation was sent to, for as long as the chain does not show it
 * yet. `null` once the chain agrees, or when nothing was sent from this screen.
 */
export function pendingPoolId(
  submitted: string | null,
  onChain: string | null | undefined,
): string | null {
  return submitted !== null && submitted !== onChain ? submitted : null;
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
