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
import { describe, it, expect, vi, afterEach } from "vitest";
import { assertNoRedirect, bfTipSlot, bfSubmitTx } from "../blockfrost";
import { koios, submitTx } from "../provider";
import { fetchAdaPrice, forgetPrice } from "../price";

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

/**
 * The wiring, which is a separate question from the rule.
 *
 * The cases above prove `assertNoRedirect` refuses a redirect. They prove
 * nothing about whether anything calls it, or whether the `fetch` beneath it
 * was told not to follow the redirect in the first place. Measured: deleting
 * `redirect: "manual"` from all four call sites left the suite at 521 green,
 * and so did deleting all four `assertNoRedirect(…)` lines. Two one-line
 * deletions, either of which silently retires the guarantee.
 *
 * The failure is silent by construction, which is why it needs a test rather
 * than a reviewer: a followed redirect answers `200` with ordinary-looking
 * JSON, from a host the receive screen never named.
 */
const SIGNED_TX = "84a300818258" + "00".repeat(40);

/**
 * Every outbound path, so a new one cannot be added without being seen.
 *
 * The price service is here even though it is not the chain: the README names
 * the indexer and the price service as the only hosts this wallet contacts, and
 * a followed redirect makes that sentence false in the place nobody checks — the
 * price arrives, the figure is plausible, and a third party nobody listed has
 * seen each user's IP. The two paths that are deliberately absent are the
 * backend client in `src/lib/api.ts`, argued at its call site, and this list is
 * where to notice if a third joins them.
 */
const CHAIN_CALLS: Array<{ name: string; run: () => Promise<unknown> }> = [
  { name: "koios read", run: () => koios(0, "/tip") },
  { name: "koios submit", run: () => submitTx(0, SIGNED_TX) },
  { name: "blockfrost read", run: () => bfTipSlot({ base: "https://example.invalid/api/v0" }) },
  {
    name: "blockfrost submit",
    run: () => bfSubmitTx({ base: "https://example.invalid/api/v0" }, SIGNED_TX),
  },
  // `forgetPrice()` first: a cached reading short-circuits the fetch, and a
  // case that never reaches the network proves nothing about it either way.
  {
    name: "price service",
    run: () => {
      forgetPrice();
      return fetchAdaPrice("usd");
    },
  },
];

afterEach(() => vi.unstubAllGlobals());

describe("chain reads > every call site tells fetch not to follow a redirect", () => {
  for (const { name, run } of CHAIN_CALLS) {
    it(`${name} passes redirect: "manual"`, async () => {
      // Asserted at the call, not at the response. A caller that omits this
      // never sees a 3xx at all — `fetch` follows it and hands back the final
      // reply — so `assertNoRedirect` downstream is looking at the wrong host's
      // answer and finds nothing wrong with it.
      const seen: RequestInit[] = [];
      vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
        seen.push(init);
        return Promise.resolve(
          new Response("[]", { status: 200, headers: { "content-type": "application/json" } }),
        );
      });
      await run().catch(() => {
        // Shape errors past the fetch are none of this case's business; the
        // question is only what was handed to `fetch`.
      });
      expect(seen.length).toBeGreaterThan(0);
      for (const init of seen) expect(init.redirect).toBe("manual");
    });
  }
});

describe("chain reads > every call site refuses the redirect it gets", () => {
  for (const { name, run } of CHAIN_CALLS) {
    it(`${name} rejects, naming the host`, async () => {
      // The other half: the `fetch` is configured correctly and a 302 comes
      // back. Something has to look at it. Deleting the `assertNoRedirect` line
      // from a call site is the mutation this case exists to kill.
      vi.stubGlobal("fetch", () =>
        Promise.resolve(
          new Response(null, { status: 302, headers: { location: "https://elsewhere.invalid/" } }),
        ),
      );
      await expect(run()).rejects.toThrow(/redirect/i);
    });
  }
});
