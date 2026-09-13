import { describe, it, expect, afterEach, vi } from "vitest";
import { submitTx } from "./provider";
import { bfSubmitTx } from "./blockfrost";
import { SubmitRejectedError, isDefiniteRejection } from "./submitError";

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
