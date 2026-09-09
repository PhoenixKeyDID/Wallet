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
import { fetchAddressBalance, fetchUtxos } from "../provider";
import { resetChainSources } from "../chainSource";

const ADDR = "addr_test1vre6qly5vj7hmre72smsl3q5aae3cd49rennzmfplm9jl7csuup3g";
const TOKEN = { policy_id: "a".repeat(56), asset_name: "4142", quantity: "7" };
/** A second, distinguishable token — so a case can tell which shape won. */
const OTHER = { policy_id: "b".repeat(56), asset_name: "4344", quantity: "3" };

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

  it("does not add the two shapes together when both carry the same holding", async () => {
    // The same tokens described twice, once per shape. Summing them would
    // double every balance on a deployment that sends both.
    koiosReplies({ balance: "1000000", asset_list: [TOKEN], utxo_set: [{ asset_list: [TOKEN] }] });
    const bal = await fetchAddressBalance(0, [ADDR]);
    expect(bal.assets[0].quantity).toBe(BigInt("7"));
  });

  it("prefers a non-empty row-level asset_list over utxo_set", async () => {
    // Deliberately a *different* token in each shape. The previous case cannot
    // tell the two branches apart — it puts one token in both, so removing the
    // preference entirely still produces 7. This one fails if the wrong branch
    // wins, which is what "pinned" has to mean.
    koiosReplies({ balance: "1000000", asset_list: [TOKEN], utxo_set: [{ asset_list: [OTHER] }] });
    const bal = await fetchAddressBalance(0, [ADDR]);
    expect(bal.assets).toEqual([
      { unit: TOKEN.policy_id + "4142", policyId: TOKEN.policy_id, assetNameHex: "4142", quantity: BigInt("7") },
    ]);
  });

  it("an EMPTY row-level asset_list must not hide tokens sitting in utxo_set", async () => {
    // How a field is usually retired: emptied, not removed, so the response
    // shape stays stable. `Array.isArray([])` is true, so a plain preference
    // lets the empty array win and the wallet reports "no tokens" for an
    // address whose own reply lists them — the original bug, restored by the
    // fix for it.
    koiosReplies({ balance: "1000000", asset_list: [], utxo_set: [{ asset_list: [TOKEN] }] });
    const bal = await fetchAddressBalance(0, [ADDR]);
    expect(bal.assets).toHaveLength(1);
    expect(bal.assets[0].quantity).toBe(BigInt("7"));
  });

  it("refuses when utxo_set has entries but not one of them carries asset_list", async () => {
    // The same refusal one level down. Measured on live preprod 2026-09-09,
    // Koios v1 emits `asset_list` on every entry — `[]` for an ADA-only UTxO
    // (`addr_test1vqutu…`) and populated when there are tokens
    // (`addr_test1wp5eh…`). So no entry carrying the key means the shape moved,
    // not that the address is empty, and `?? []` per entry would answer the
    // question anyway.
    koiosReplies({ balance: "1000000", utxo_set: [{ tx_hash: "aa" }, { tx_hash: "bb" }] });
    await expect(fetchAddressBalance(0, [ADDR])).rejects.toThrow(/token balances unknown/);
  });

  it("refuses the same way when an EMPTY row-level field sits above the moved leaf", async () => {
    // The previous case and this one differ by exactly one key. Guarding only
    // "the row field is absent" let this one through silently, because the
    // branch that reads `perUtxo` is taken whenever the row list is *empty* —
    // absent or not. A deployment retiring the field at both levels at once is
    // the realistic way to arrive here.
    koiosReplies({ balance: "1000000", asset_list: [], utxo_set: [{ tx_hash: "aa" }] });
    await expect(fetchAddressBalance(0, [ADDR])).rejects.toThrow(/token balances unknown/);
  });

  it("an empty utxo_set is an address with nothing, not a shape change", async () => {
    // No entries means no evidence of a moved field. Refusing here would make
    // an ordinary empty address look like a broken indexer.
    koiosReplies({ balance: "1000000", utxo_set: [] });
    const bal = await fetchAddressBalance(0, [ADDR]);
    expect(bal.assets).toEqual([]);
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

/**
 * The sibling endpoint, which decides transaction inputs rather than a number
 * on a screen.
 *
 * `/address_info` and `/address_utxos` carry a field of the same name from the
 * same indexer. The first one lost it. Patching only the first would be taking
 * the scope of a fix from the scope of its symptom — and this is the more
 * expensive half: a wrong balance misinforms, wrong inputs build a transaction
 * the ledger rejects, so the wallet stops sending and blames a ledger rule.
 */
const UTXO = {
  tx_hash: "c".repeat(64),
  tx_index: 0,
  value: "2000000",
  address: ADDR,
  inline_datum: null,
  reference_script: null,
};

describe("fetchUtxos > a UTxO whose tokens are unknown is not a UTxO with no tokens", () => {
  it("refuses when the leaf carries no asset_list at all", async () => {
    // Measured on live Koios preprod 2026-09-09: this endpoint puts `asset_list`
    // on every leaf, `[]` included. A leaf without it is a shape change, not an
    // ADA-only UTxO, and the two must not read the same.
    koiosReplies(UTXO);
    await expect(fetchUtxos(0, [ADDR])).rejects.toThrow(/tokens on this UTxO are unknown/);
  });

  it("names the UTxO it could not read", async () => {
    // Which one matters: the caller is holding a list, and a message that says
    // only "something was wrong" leaves them nothing to look at.
    koiosReplies(UTXO);
    await expect(fetchUtxos(0, [ADDR])).rejects.toThrow(new RegExp(`${"c".repeat(64)}#0`));
  });

  it("accepts an empty asset_list, because that is an ordinary ADA-only UTxO", async () => {
    // The direction that decides whether the rule survives: 41 of 41 leaves on
    // a live ADA-only address came back exactly like this.
    koiosReplies({ ...UTXO, asset_list: [] });
    const utxos = await fetchUtxos(0, [ADDR]);
    expect(utxos).toHaveLength(1);
    expect(utxos[0].tokens).toEqual([]);
  });

  it("carries the tokens through when they are there", async () => {
    koiosReplies({ ...UTXO, asset_list: [TOKEN] });
    const utxos = await fetchUtxos(0, [ADDR]);
    expect(utxos[0].tokens).toHaveLength(1);
    expect(utxos[0].tokens[0].policyId).toBe(TOKEN.policy_id);
    expect(utxos[0].tokens[0].amount.toString()).toBe("7");
  });
});
