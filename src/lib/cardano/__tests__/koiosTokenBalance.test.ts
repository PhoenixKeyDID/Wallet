/**
 * Tokens read from Koios — the shape that stopped existing.
 *
 * `/address_info` once carried `asset_list` beside `balance`, and the wallet
 * read it with `?? []`. Koios v1 stopped sending that field; measured
 * 2026-09-09 on preprod, the row's keys are exactly `address`, `balance`,
 * `script_address`, `stake_address`, `utxo_set`. Nothing failed. The ADA figure
 * stayed correct and every address reported holding no tokens — and an empty
 * token list is what most addresses genuinely have, so there was nothing to
 * notice. It surfaced only by asking a second source about the same address:
 * identical lovelace, three tokens instead of none.
 *
 * These cases exist so the next shape change is a red line rather than a
 * quieter wallet.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { fetchAddressBalance } from "../provider";
import { resetChainSources } from "../chainSource";

const ADDR = "addr_test1vre6qly5vj7hmre72smsl3q5aae3cd49rennzmfplm9jl7csuup3g";
const TOKEN = { policy_id: "a".repeat(56), asset_name: "4142", quantity: "7" };

function koiosReplies(row: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify([row]), { status: 200, headers: { "content-type": "application/json" } })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetChainSources();
});

describe("fetchAddressBalance > Koios moved the tokens, and the wallet follows", () => {
  it("reads tokens out of utxo_set when the row has no asset_list — today's shape", async () => {
    koiosReplies({ balance: "1000000", utxo_set: [{ asset_list: [TOKEN] }, { asset_list: [] }] });
    const bal = await fetchAddressBalance(0, [ADDR]);
    expect(bal.lovelace).toBe(BigInt("1000000"));
    expect(bal.assets).toEqual([
      { unit: TOKEN.policy_id + "4142", policyId: TOKEN.policy_id, assetNameHex: "4142", quantity: BigInt("7") },
    ]);
  });

  it("sums one token held across several utxos instead of reporting the last one", async () => {
    koiosReplies({
      balance: "1000000",
      utxo_set: [{ asset_list: [TOKEN] }, { asset_list: [{ ...TOKEN, quantity: "5" }] }],
    });
    const bal = await fetchAddressBalance(0, [ADDR]);
    expect(bal.assets[0].quantity).toBe(BigInt("12"));
  });

  it("still prefers a row-level asset_list where a deployment sends one", async () => {
    // And does not add the two together: the same holding appears in both
    // shapes, so summing them would double every balance.
    koiosReplies({ balance: "1000000", asset_list: [TOKEN], utxo_set: [{ asset_list: [TOKEN] }] });
    const bal = await fetchAddressBalance(0, [ADDR]);
    expect(bal.assets[0].quantity).toBe(BigInt("7"));
  });

  it("an address holding nothing reports nothing, and that is not an error", async () => {
    koiosReplies({ balance: "1000000", utxo_set: [{ asset_list: [] }] });
    const bal = await fetchAddressBalance(0, [ADDR]);
    expect(bal.assets).toEqual([]);
  });

  it("refuses to answer when the reply carries neither shape", async () => {
    // The exact failure this file is about: the question was not addressed, so
    // "no tokens" would be an invention. An address with no tokens and a reply
    // that cannot say must not look the same.
    koiosReplies({ balance: "1000000" });
    await expect(fetchAddressBalance(0, [ADDR])).rejects.toThrow(/token balances unknown/);
  });

  it("keeps the ADA figure exact while doing it", async () => {
    koiosReplies({ balance: "9997607002", utxo_set: [{ asset_list: [TOKEN] }] });
    expect((await fetchAddressBalance(0, [ADDR])).lovelace).toBe(BigInt("9997607002"));
  });
});
