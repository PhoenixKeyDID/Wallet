/**
 * `fetchTxSeen` — "is this transaction in a block?" with three answers:
 * yes, no, and "could not tell" (a throw). The third must never collapse into
 * either of the first two: "no" keeps a warning up that should go, "yes"
 * clears one that should stay.
 *
 * Row shapes are the ones measured on preprod 2026-11-13 (see the function).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { fetchTxSeen } from "../history";

const HASH = "f99169187752d781d564816caf9c192b65857b1c58e5086dc6ba035d5b07dc79";

function stubReply(body: unknown, status = 200) {
  const fetchMock = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchTxSeen", () => {
  it("a transaction in a block (even the tip block, 0 confirmations) is seen", async () => {
    const f = stubReply([{ tx_hash: HASH, num_confirmations: 0 }]);
    await expect(fetchTxSeen(0, HASH)).resolves.toBe(true);
    const [url, init] = f.mock.calls[0] as unknown as [string, { method: string; body: string }];
    expect(url).toMatch(/preprod\.koios\.rest\/api\/v1\/tx_status$/);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ _tx_hashes: [HASH] });
  });

  it("a hash the indexer does not have in a block is not seen", async () => {
    stubReply([{ tx_hash: HASH, num_confirmations: null }]);
    await expect(fetchTxSeen(0, HASH)).resolves.toBe(false);
  });

  it("an answer about another hash, no row, or a non-count is a failure, not a no", async () => {
    stubReply([{ tx_hash: "00".repeat(32), num_confirmations: 5 }]);
    await expect(fetchTxSeen(0, HASH)).rejects.toThrow();
    stubReply([]);
    await expect(fetchTxSeen(0, HASH)).rejects.toThrow();
    stubReply([{ tx_hash: HASH, num_confirmations: "3" }]);
    await expect(fetchTxSeen(0, HASH)).rejects.toThrow();
    stubReply([{ tx_hash: HASH }]);
    await expect(fetchTxSeen(0, HASH)).rejects.toThrow();
  });

  it("an HTTP error is a failure", async () => {
    stubReply({}, 503);
    await expect(fetchTxSeen(0, HASH)).rejects.toThrow();
  });
});
