/**
 * Koios answering "yes" while handing back part of the answer.
 *
 * PostgREST caps a response at 1000 rows and does not say so in the status
 * line. Measured against the live service on 2026-09-05: `/pool_list` answers
 * HTTP 200 with `content-range: 0-999/*` and exactly 1000 rows, while the same
 * request carrying `Prefer: count=exact` answers HTTP **206** with
 * `content-range: 0-999/6163`. Both are `res.ok`, so a status check alone lets
 * the truncated one through — and a truncated UTxO list is a balance smaller
 * than the truth, offered to the user as a fact.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { koios, KoiosTruncatedError } from "../provider";

const reply = (status: number, range: string | null, body: unknown) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k: string) => (k.toLowerCase() === "content-range" ? range : null) },
      json: async () => body,
    })),
  );

afterEach(() => vi.unstubAllGlobals());

describe("koios — a partial answer is not an answer", () => {
  it("refuses a response the indexer cut short, even though it succeeded", async () => {
    reply(206, "0-999/6163", Array.from({ length: 1000 }, (_, i) => i));
    await expect(koios(0, "/address_utxos", { _addresses: [] })).rejects.toBeInstanceOf(
      KoiosTruncatedError,
    );
  });

  it("says how much it got and how much there was", async () => {
    reply(206, "0-999/6163", []);
    await expect(koios(0, "/address_utxos", { _addresses: [] })).rejects.toThrow(/1000 of 6163/);
  });

  it("accepts a complete answer that happens to be reported as a range", async () => {
    reply(200, "0-40/41", Array.from({ length: 41 }, (_, i) => i));
    await expect(koios(0, "/address_info", { _addresses: [] })).resolves.toHaveLength(41);
  });

  it("accepts an answer with no range header at all", async () => {
    reply(200, null, [{ ok: true }]);
    await expect(koios(0, "/tip")).resolves.toEqual([{ ok: true }]);
  });

  /**
   * `*` is what PostgREST returns when it did not count. Refusing on that would
   * fail every ordinary request; the `Prefer` header is what makes the real
   * total appear, and this pins that the unknown case stays permissive.
   */
  it("does not refuse when the total is unknown", async () => {
    reply(200, "0-9/*", Array.from({ length: 10 }, (_, i) => i));
    await expect(koios(0, "/tip")).resolves.toHaveLength(10);
  });

  it("still refuses a genuine HTTP failure", async () => {
    reply(503, null, {});
    await expect(koios(0, "/tip")).rejects.toThrow(/HTTP 503/);
  });
});
