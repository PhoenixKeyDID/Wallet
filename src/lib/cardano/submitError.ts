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

/**
 * What a website is told when its `submitTx` was refused with a 4xx other
 * than 400. Fixed on purpose: see `rejectionReasonForSite`.
 */
export const PROVIDER_REFUSED_REASON = "the wallet's chain provider refused the request";

/**
 * The reason a website receives for a definite rejection.
 *
 * Only a **400** is the node reading the transaction and saying no, and its
 * body is the ledger's reason — the one thing the site's developer can act on.
 * Every other 4xx is the chain provider talking about the *person's account
 * with it*: 401/403 an invalid or revoked project token, 402 a plan limit, 429
 * a rate limit. That body describes the user, not the transaction, so the site
 * gets a fixed sentence instead.
 *
 * The endpoint label is left out for every status, 400 included. `message`
 * starts with it (`Koios /submittx`, `Chain endpoint /tx/submit`), and that
 * tells the site which provider this wallet uses and whether it is a custom
 * one. The full `message` stays available to the wallet's own code.
 *
 * This shapes the text only. Whether an error is a rejection at all is still
 * `isDefiniteRejection`'s call, made before this is reached.
 */
export function rejectionReasonForSite(err: SubmitRejectedError): string {
  if (err.status !== 400) return PROVIDER_REFUSED_REASON;
  return err.detail ? `HTTP 400: ${err.detail}` : "HTTP 400";
}
