"use client";

/**
 * One place to turn a failed signature or submission into something a person
 * can act on.
 *
 * Every money flow in this app (send, staking, governance) ends at the same
 * `signAndSubmitCip30` call, so they must also end at the same explanation.
 * Three copies of this logic drift apart, and the branch that drifts is always
 * the rare one — which here is the branch that decides whether the user's money
 * moved or not.
 *
 * Three outcomes, three different things to say:
 *   • network drifted  → nothing was sent, reconnect.
 *   • submit uncertain → it may already be on-chain; check the hash BEFORE
 *     resending. Never call this a plain failure.
 *   • everything else  → the normal error path (`toastApiError` already
 *     recognises a user pressing Cancel in the wallet popup).
 *
 * ## Why this returns something instead of only speaking
 *
 * A banner is the wrong shape for the uncertain outcome, and it was the shape
 * this had. The banner said "it may already be on-chain, check the hash BEFORE
 * sending again" and then disappeared after six seconds — while the form behind
 * it had already been re-armed by the same `catch` block. So the screen ended in
 * the one state the sentence exists to prevent: a ready Send button, no hash in
 * sight, and a person who now has no way to check the thing they were told to
 * check. Following the instruction and paying twice were the same click.
 *
 * A caller cannot draw a persistent notice for an outcome it was never told
 * about, so the outcome is returned rather than only announced. `reported` means
 * the caller has nothing left to do; `uncertain` means the caller must keep the
 * hash on screen and must not re-arm the action until the person says they have
 * checked.
 */

import { NetworkMismatchError } from "@/lib/cardano/cip30";
import { SubmitUncertainError } from "@/lib/cardano/tx";
import { toastApiError, toastError } from "@/lib/toast";

type Translate = (key: string, values?: Record<string, unknown>) => string;

/** What the caller still has to do about an error this function has explained. */
export type SignErrorOutcome =
  /** Said in full; nothing is pending. */
  | { kind: "reported" }
  /**
   * The transaction was signed and may be on-chain. The caller owes the person
   * this hash, on screen, until they dismiss it themselves.
   */
  | { kind: "uncertain"; txHash: string };

export function reportSignError(err: unknown, t: Translate): SignErrorOutcome {
  if (err instanceof NetworkMismatchError) {
    toastError(t("network_changed_reconnect"));
    return { kind: "reported" };
  }
  if (err instanceof SubmitUncertainError) {
    toastError(t("submit_uncertain", { hash: err.txHash }));
    return { kind: "uncertain", txHash: err.txHash };
  }
  toastApiError(err);
  return { kind: "reported" };
}
