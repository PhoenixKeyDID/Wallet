/**
 * A redirect on the chain read is refused, not followed.
 *
 * Nothing guarded this. Turning `assertNoRedirect` into a no-op left the suite
 * fully green, which is the shape of a rule that exists only in a comment.
 *
 * What it protects is a sentence the wallet already shows: the receive screen
 * names one host as the party that learns which addresses this wallet looks up.
 * A redirect makes that sentence false — the addresses go somewhere the screen
 * did not name — and it does so silently, because a followed redirect answers
 * with ordinary-looking data. That is why this is refused rather than logged.
 */
import { describe, it, expect } from "vitest";
import { assertNoRedirect } from "../blockfrost";

/** The shape Node returns under `redirect: "manual"`: the real 3xx. */
const nodeRedirect = (status: number) =>
  ({ type: "default", status }) as unknown as Response;

/** The shape a browser returns under `redirect: "manual"`: opaque, status 0. */
const browserRedirect = () =>
  ({ type: "opaqueredirect", status: 0 }) as unknown as Response;

const ok = () => ({ type: "default", status: 200 }) as unknown as Response;

const BASE = "https://api.koios.rest/api/v1";

describe("assertNoRedirect > refuses a redirect on both runtimes", () => {
  it("refuses the real 3xx Node hands back", () => {
    // 308 rather than 301: a permanent redirect is the one an operator adds on
    // purpose and never thinks about again, so it is the one that would sit in
    // front of a wallet for months.
    expect(() => assertNoRedirect(nodeRedirect(308), "/address_info", BASE)).toThrow();
  });

  it("refuses the opaque response a browser hands back", () => {
    // Status 0, so any check written as `status >= 300` alone passes it — and
    // the browser is the runtime that actually ships. A check that understood
    // only the Node shape would be green here and inert in the extension.
    expect(() => assertNoRedirect(browserRedirect(), "/address_info", BASE)).toThrow();
  });

  it("names the host the receive screen names, and what to do", () => {
    // The message has a job beyond being red: a redirect looks identical to a
    // misconfigured endpoint from the outside, and without the host in the
    // sentence the reader has no way to tell which one they are looking at.
    let message = "";
    try {
      assertNoRedirect(nodeRedirect(302), "/address_info", BASE);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("api.koios.rest");
    expect(message).toContain("/address_info");
    expect(message).toMatch(/final address/);
  });

  it("lets an ordinary answer through", () => {
    // The direction that decides whether the rule survives: a check that also
    // refuses correct responses is a check somebody deletes.
    expect(() => assertNoRedirect(ok(), "/address_info", BASE)).not.toThrow();
  });

  it("lets a 4xx through, because that is the error path's business", () => {
    // A 404 on this route means "this address has never appeared on chain",
    // which `NotOnChainError` reads further down. Swallowing it here would turn
    // a new wallet into a broken one.
    expect(() =>
      assertNoRedirect({ type: "default", status: 404 } as unknown as Response, "/address_info", BASE),
    ).not.toThrow();
  });
});
