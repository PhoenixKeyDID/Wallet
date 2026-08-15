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
 */

import { NetworkMismatchError } from "@/lib/cardano/cip30";
import { SubmitUncertainError } from "@/lib/cardano/tx";
import { toastApiError, toastError } from "@/lib/toast";

type Translate = (key: string, values?: Record<string, unknown>) => string;

export function reportSignError(err: unknown, t: Translate): void {
  if (err instanceof NetworkMismatchError) {
    toastError(t("network_changed_reconnect"));
    return;
  }
  if (err instanceof SubmitUncertainError) {
    toastError(t("submit_uncertain", { hash: err.txHash }));
    return;
  }
  toastApiError(err);
}
