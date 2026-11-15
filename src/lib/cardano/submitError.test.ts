import { describe, it, expect, afterEach, vi } from "vitest";
import { submitTx } from "./provider";
import { bfSubmitTx } from "./blockfrost";
import {
  PROVIDER_REFUSED_REASON,
  SubmitRejectedError,
  isDefiniteRejection,
  rejectionReasonForSite,
} from "./submitError";

/**
 * Both submit doors report a rejection as a *type*, not as a sentence.
 *
 * The filter that uses this already had tests, and they proved nothing about
 * this half: they handed `signAndSubmitLocal` a ready-made `SubmitRejectedError`
 * and checked it passed through. Measured — replacing either `throw new
 * SubmitRejectedError(…)` with a plain `throw new Error(\`… HTTP …\`)` left the
 * whole suite green. The classic shape: the right sentence was asserted present,
 * the wrong one was never asserted absent, and the two ends were never joined.
 *
 * What a regression there costs, concretely: a local wallet submits on preprod,
 * the node refuses it outright (`BadInputsUTxO`, expired TTL, fee too low), the
 * 4xx arrives as an untyped `Error`, `isDefiniteRejection` says no, and the
 * wallet locks every money screen and tells the reader to look up a transaction
 * id that exists nowhere. That is the exact defect this type was added to
 * remove, rebuilt with nothing going red.
 *
 * Two doors, because there are two: Koios and the Blockfrost-shaped endpoint.
 * Leaving one untested is how a caller ends up filtering the one it has seen.
 */

const PREPROD = 0 as const;
const SIGNED = "84a4".padEnd(64, "0");
const BF = { base: "https://chain.example/api/v0", projectId: "" };

afterEach(() => {
  vi.unstubAllGlobals();
});

const stub = (status: number, body: string) =>
  vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status })));

const DOORS: Array<[string, () => Promise<string>]> = [
  ["Koios", () => submitTx(PREPROD, SIGNED)],
  ["Blockfrost-shaped", () => bfSubmitTx(BF, SIGNED)],
];

describe("submit > a rejection arrives as SubmitRejectedError, from either door", () => {
  for (const [door, call] of DOORS) {
    it(`${door}: a 400 is typed, carries the status, and counts as definite`, async () => {
      stub(400, "BadInputsUTxO (TxIn (TxId ...))");
      const err = await call().catch((e: unknown) => e);
      expect(err, door).toBeInstanceOf(SubmitRejectedError);
      expect((err as SubmitRejectedError).status, door).toBe(400);
      expect(isDefiniteRejection(err), door).toBe(true);
      // The node's own words survive to the screen. "Something went wrong"
      // cannot tell anyone which input was bad.
      expect((err as Error).message, door).toContain("BadInputsUTxO");
    });

    it(`${door}: a 503 is typed too, and does NOT count as definite`, async () => {
      // The boundary from the other side, and the half that loses money if it
      // slips: a gateway that dies *after* forwarding the transaction produces
      // a 5xx, and that transaction may well be on chain. Treating it as a
      // refusal invites a second payment.
      stub(503, "upstream unavailable");
      const err = await call().catch((e: unknown) => e);
      expect(err, door).toBeInstanceOf(SubmitRejectedError);
      expect((err as SubmitRejectedError).status, door).toBe(503);
      expect(isDefiniteRejection(err), door).toBe(false);
    });
  }
});

describe("submit > isDefiniteRejection says no to everything else", () => {
  it("a bare Error is not a rejection, however its message reads", () => {
    // The shape a regression would produce. Asserted explicitly so that the
    // predicate cannot be "loosened" into reading messages.
    expect(isDefiniteRejection(new Error("Koios /submittx → HTTP 400: nope"))).toBe(false);
  });

  it("a dropped connection is not a rejection", () => {
    expect(isDefiniteRejection(new TypeError("Failed to fetch"))).toBe(false);
    expect(isDefiniteRejection(undefined)).toBe(false);
    expect(isDefiniteRejection(null)).toBe(false);
  });
});

/**
 * What a website is told about a rejection (issue #59, point 10).
 *
 * Driven through both doors with a real reply body, so the test sees the error
 * exactly as the approval window receives it. The site used to get `message`
 * whole: `<endpoint label> → HTTP <status>: <body>`.
 */
describe("submit > the reason a site receives for a rejection", () => {
  it("a 400 carries the node's reason, without the label that names the provider", async () => {
    for (const [door, call] of DOORS) {
      stub(400, "BadInputsUTxO (spent)");
      const err = await call().catch((e: unknown) => e);
      expect(isDefiniteRejection(err), door).toBe(true);
      const reason = rejectionReasonForSite(err as SubmitRejectedError);
      expect(reason, door).toBe("HTTP 400: BadInputsUTxO (spent)");
      expect(reason, door).not.toMatch(/koios|chain endpoint|submittx|tx\/submit/i);
    }
  });

  it.each([401, 402, 403, 429])(
    "a %i is about the person's provider account: the site gets a fixed reason, not the body",
    async (status) => {
      const body = '{"status_code":403,"error":"Forbidden","message":"Invalid project token."}';
      for (const [door, call] of DOORS) {
        stub(status, body);
        const err = await call().catch((e: unknown) => e);
        // The classification is untouched: still a definite rejection.
        expect(isDefiniteRejection(err), door).toBe(true);
        // The wallet's own copy still has everything.
        expect((err as Error).message, door).toContain("Invalid project token");
        const reason = rejectionReasonForSite(err as SubmitRejectedError);
        expect(reason, door).toBe(PROVIDER_REFUSED_REASON);
        expect(reason, door).not.toContain("project token");
        expect(reason, door).not.toContain(String(status));
        expect(reason, door).not.toMatch(/koios|chain endpoint|blockfrost/i);
      }
    },
  );

  it("a 400 with an empty body still says 400, and nothing else", () => {
    expect(rejectionReasonForSite(new SubmitRejectedError(400, "", "Koios /submittx"))).toBe("HTTP 400");
  });
});
