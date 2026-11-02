/**
 * Protocol parameters on a network with more than 1000 epochs.
 *
 * Preview passed 1000 epochs (1470 on 2026-11-02). Reading the whole
 * `/epoch_params` table came back cut at Koios' 1000-row cap, the truncation
 * guard refused it, and no transaction could be built on that network. The fake
 * below answers the way PostgREST does: an unbounded request gets 1000 rows and
 * a `206`, a bounded one gets exactly what it asked for.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchLatestEpochParams, fetchProtocolParams } from "../provider";

const EPOCHS = 1470;
const row = (epoch_no: number) => ({
  epoch_no,
  min_fee_a: 44,
  min_fee_b: 155381,
  key_deposit: "2000000",
  coins_per_utxo_size: "4310",
  collateral_percent: 150,
  price_step: 0.0000721,
  price_mem: 0.0577,
  max_tx_size: 16384,
  max_val_size: "5000",
  drep_deposit: epoch_no === EPOCHS - 1 ? "500000000" : "1",
});

const urls: string[] = [];
const postgrest = () =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async (u: string) => {
      urls.push(u);
      const q = new URL(u).searchParams;
      const desc = q.get("order") === "epoch_no.desc";
      const all = Array.from({ length: EPOCHS }, (_, i) => row(desc ? EPOCHS - 1 - i : i));
      const n = Math.min(Number(q.get("limit") ?? 1000), 1000);
      const body = all.slice(0, n);
      return {
        ok: true,
        status: n < EPOCHS && !q.get("limit") ? 206 : 200,
        headers: {
          get: (k: string) =>
            k.toLowerCase() === "content-range" ? `0-${n - 1}/${EPOCHS}` : null,
        },
        json: async () => body,
      };
    }),
  );

afterEach(() => {
  vi.unstubAllGlobals();
  urls.length = 0;
});

describe("epoch params past 1000 epochs", () => {
  it("builds protocol parameters instead of failing on the row cap", async () => {
    postgrest();
    const p = await fetchProtocolParams(2);
    expect(p.minFeeA.toString()).toBe("44");
    expect(urls).toHaveLength(1);
  });

  it("reads the newest epoch, not the first one in the table", async () => {
    postgrest();
    const p = await fetchLatestEpochParams<{ epoch_no: number; drep_deposit: string }>(2);
    expect(p?.epoch_no).toBe(EPOCHS - 1);
    expect(p?.drep_deposit).toBe("500000000");
  });

  it("asks for one row ordered newest first", async () => {
    postgrest();
    await fetchLatestEpochParams(2);
    const q = new URL(urls[0]).searchParams;
    expect(q.get("limit")).toBe("1");
    expect(q.get("order")).toBe("epoch_no.desc");
  });
});
