/**
 * The node answered, and the answer was no.
 *
 * Its own module, with no imports, because four files need it and any of the
 * obvious homes would close an import cycle.
 *
 * ## Why this has to be a distinct type
 *
 * A submit ends one of two ways, and the wallet must not confuse them:
 *
 * - **Rejected.** The node read the transaction and refused it — bad inputs,
 *   expired TTL, fee too low. Nothing was recorded, no hash exists anywhere,
 *   and the person should fix the transaction and send again.
 * - **Unknown.** The bytes went out and no answer came back. It may be
 *   on-chain. Sending again is how the same amount leaves twice, so the screen
 *   locks and asks for the hash to be looked up.
 *
 * Before this type existed, the local-signing path put *both* into
 * `SubmitUncertainError`, because the only thing it had to go on was a string.
 * The result was the worse half of each: a preprod wallet whose transaction the
 * node had definitively rejected showed the lock, the alarm, and an instruction
 * to go look up a hash that **does not exist on any explorer**. A person who
 * does what that screen asks finds nothing, and learns that this notice means
 * nothing — which is exactly how the one real occurrence gets dismissed.
 *
 * ## The 4xx / 5xx line
 *
 * `4xx` is the node saying no. `5xx` is the node or a proxy failing, and a
 * failure on the way back cannot tell you whether the transaction got through
 * on the way in — so `5xx` stays **unknown**, along with timeouts and dropped
 * connections. The split is deliberately on the side of caution: a rejection
 * misread as unknown costs one confusing screen, while an unknown misread as a
 * rejection invites a second payment.
 */
export class SubmitRejectedError extends Error {
  constructor(
    /**
     * HTTP status from the submit endpoint — **4xx or 5xx**.
     *
     * It said "always 4xx", which was false and false in the direction that
     * costs money: both throw sites pass `res.status` for every non-ok reply.
     * A reader who believed it would take `instanceof SubmitRejectedError` as
     * enough and drop `isDefiniteRejection`, turning a 503 — a failure on the
     * way back, which says nothing about the way in — into "the node said no",
     * and inviting a second payment. Call `isDefiniteRejection` first.
     */
    readonly status: number,
    /** What the node said, already truncated by the caller. */
    readonly detail: string,
    /** Which endpoint answered, for a message a reader can act on. */
    readonly endpoint: string,
  ) {
    super(`${endpoint} → HTTP ${status}: ${detail}`);
    this.name = "SubmitRejectedError";
  }
}

/**
 * True when this error means the node definitively refused the transaction.
 *
 * A function rather than a bare `instanceof` at each call site: the status
 * check belongs with the type, and a caller that forgets it would treat a 5xx
 * as a rejection, which is the direction that loses money.
 */
export function isDefiniteRejection(err: unknown): err is SubmitRejectedError {
  return err instanceof SubmitRejectedError && err.status >= 400 && err.status < 500;
}
