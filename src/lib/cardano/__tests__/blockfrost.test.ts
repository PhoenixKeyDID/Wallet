/**
 * Reading the chain from the platform's own node instead of a public indexer.
 *
 * Cnode runs Dolos on Cardano nodes it operates, and Dolos serves a
 * Blockfrost-compatible REST face. These tests pin the adapter that speaks that
 * dialect — against fixtures, because the endpoint itself is bound to loopback
 * on the machines that run it and is not reachable from a test. What they can
 * and do pin is every place where the dialect differs from Koios in a way that
 * would produce a **plausible wrong number** rather than a failure.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  bfProtocolParams,
  bfTipSlot,
  bfTipBlockHeight,
  bfAddressBalance,
  bfUtxos,
  bfSubmitTx,
  NotOnChainError,
} from "../blockfrost";
import { ProviderUnreachableError } from "../provider";
import {
  setChainSource,
  getChainSource,
  resetChainSources,
  validateChainSource,
  DEFAULT_CHAIN_SOURCE,
} from "../chainSource";

const EP = { base: "https://chain.example/api/v0" };

/** A bech32 preprod address, used where the adapter decodes one. */
const ADDR =
  "addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp";

/** Route by path so one stub can serve a call that makes several requests. */
function routes(map: Record<string, { status?: number; body?: unknown; text?: string }>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = url.replace(EP.base, "");
      const hit = map[path] ?? map[Object.keys(map).find((k) => path.startsWith(k)) ?? ""];
      if (!hit) return { ok: false, status: 404, text: async () => "", json: async () => ({}) };
      const status = hit.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => hit.text ?? JSON.stringify(hit.body ?? {}),
        json: async () => hit.body ?? {},
      };
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetChainSources();
});

describe("chain source — swapping where the chain is read from", () => {
  it("defaults to the indexer the wallet shipped with, so nothing moves on its own", () => {
    expect(getChainSource(0)).toEqual(DEFAULT_CHAIN_SOURCE);
    expect(DEFAULT_CHAIN_SOURCE.kind).toBe("koios");
  });

  it("keeps one endpoint per network", () => {
    setChainSource(0, { kind: "blockfrost", base: "https://preprod.example/api/v0" });
    expect(getChainSource(0)).toMatchObject({ base: "https://preprod.example/api/v0" });
    // Mainnet untouched: pointing a mainnet read at a preprod node returns a
    // confident zero rather than an error, so the two must not share a slot.
    expect(getChainSource(1)).toEqual(DEFAULT_CHAIN_SOURCE);
  });

  it("refuses plain http to anywhere but loopback", () => {
    expect(() => validateChainSource({ kind: "blockfrost", base: "http://chain.example/api/v0" })).toThrow(
      /only https/,
    );
    expect(() =>
      validateChainSource({ kind: "blockfrost", base: "http://localhost:3000/api/v0" }),
    ).not.toThrow();
  });

  it("refuses a base that is not a URL, carries a query, or ends in a slash", () => {
    expect(() => validateChainSource({ kind: "blockfrost", base: "chain.example" })).toThrow(/not a URL/);
    expect(() =>
      validateChainSource({ kind: "blockfrost", base: "https://chain.example/api/v0?k=1" }),
    ).toThrow(/no query/);
    expect(() => validateChainSource({ kind: "blockfrost", base: "https://chain.example/api/v0/" })).toThrow(
      /must not end/,
    );
  });
});

describe("blockfrost adapter — the shapes that would be silent wrong numbers", () => {
  it("reads lovelace from the entry that says lovelace, not from the first entry", async () => {
    // The trap: Koios hands back a `balance` field; this dialect hands back one
    // list where ADA is an entry among the tokens, and its position is not
    // guaranteed. Taking `amount[0]` reports a token count as somebody's money.
    routes({
      [`/addresses/${encodeURIComponent(ADDR)}`]: {
        body: {
          amount: [
            { unit: "a".repeat(56) + "4d59544f4b454e", quantity: "42" },
            { unit: "lovelace", quantity: "5000000" },
          ],
        },
      },
    });
    const bal = await bfAddressBalance(EP, [ADDR]);
    expect(bal.lovelace).toBe(BigInt("5000000"));
    expect(bal.assets).toEqual([
      { unit: "a".repeat(56) + "4d59544f4b454e", policyId: "a".repeat(56), assetNameHex: "4d59544f4b454e", quantity: BigInt("42") },
    ]);
  });

  it("treats an address that has never been used as empty, not as a failure", async () => {
    // A 404 here is the chain saying "nothing has ever been paid to this". The
    // address scan asks about addresses precisely because it does not yet know;
    // raising would stop it at the first unused one and under-report the wallet.
    routes({ [`/addresses/${encodeURIComponent(ADDR)}`]: { status: 404 } });
    const bal = await bfAddressBalance(EP, [ADDR]);
    expect(bal).toEqual({ lovelace: BigInt("0"), assets: [] });
  });

  it("still fails on a server error, which is not the same as an unused address", async () => {
    routes({ [`/addresses/${encodeURIComponent(ADDR)}`]: { status: 500, text: "upstream is down" } });
    await expect(bfAddressBalance(EP, [ADDR])).rejects.toThrow(/HTTP 500: upstream is down/);
  });

  it("refuses an asset unit too short to contain a policy id", async () => {
    routes({
      [`/addresses/${encodeURIComponent(ADDR)}`]: { body: { amount: [{ unit: "abcd", quantity: "1" }] } },
    });
    await expect(bfAddressBalance(EP, [ADDR])).rejects.toThrow(/malformed asset unit/);
  });

  it("skips unspent outputs carrying a datum by hash, not only an inline one", async () => {
    // A datum attached by hash is still a datum: the output's meaning lives
    // off-chain and is not ours to reinterpret. Skipping only `inline_datum`
    // would spend exactly the outputs the wallet cannot read.
    routes({
      [`/addresses/${encodeURIComponent(ADDR)}/utxos`]: {
        body: [
          { tx_hash: "a".repeat(64), output_index: 0, address: ADDR, amount: [{ unit: "lovelace", quantity: "2000000" }], data_hash: "b".repeat(64) },
          { tx_hash: "c".repeat(64), output_index: 1, address: ADDR, amount: [{ unit: "lovelace", quantity: "3000000" }] },
        ],
      },
    });
    const utxos = await bfUtxos(EP, [ADDR]);
    expect(utxos).toHaveLength(1);
    expect(utxos[0].txId).toBe("c".repeat(64));
    expect(utxos[0].amount.toString()).toBe("3000000");
  });

  it("reads the tip slot as the absolute slot, which is what a TTL is measured in", async () => {
    routes({ "/blocks/latest": { body: { slot: 87654321, height: 3210987, epoch_slot: 42 } } });
    await expect(bfTipSlot(EP)).resolves.toBe(87654321);
    await expect(bfTipBlockHeight(EP)).resolves.toBe(3210987);
  });

  it("refuses a tip with no slot rather than defaulting one", async () => {
    routes({ "/blocks/latest": { body: { height: 10 } } });
    await expect(bfTipSlot(EP)).rejects.toThrow(/no tip slot/);
  });

  it("refuses protocol parameters outside the plausible range", async () => {
    routes({
      "/epochs/latest/parameters": {
        body: { min_fee_a: 44, min_fee_b: 999_999_999_999, key_deposit: "2000000", coins_per_utxo_size: "4310", max_tx_size: 16384, max_val_size: "5000" },
      },
    });
    await expect(bfProtocolParams(EP)).rejects.toThrow(/implausible minFeeB/);
  });

  it("refuses parameters that are simply missing", async () => {
    routes({ "/epochs/latest/parameters": { body: { min_fee_a: 44, max_tx_size: 16384, max_val_size: "5000" } } });
    await expect(bfProtocolParams(EP)).rejects.toThrow(/returned no minFeeB/);
  });

  it("returns the transaction hash a submit answered with", async () => {
    routes({ "/tx/submit": { text: `"${"d".repeat(64)}"` } });
    await expect(bfSubmitTx(EP, "00")).resolves.toBe("d".repeat(64));
  });

  it("keeps the node's rejection text, which is the only thing a bounced transaction leaves", async () => {
    routes({ "/tx/submit": { status: 400, text: "ValueNotConservedUTxO" } });
    await expect(bfSubmitTx(EP, "00")).rejects.toThrow(/ValueNotConservedUTxO/);
  });

  it("names an unreachable endpoint as unreachable, not as a silent server", async () => {
    // The same distinction the Koios path makes: `fetch` throwing says nothing
    // about the server, and calling it silence sends people to the wrong machine.
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    await expect(bfTipSlot(EP)).rejects.toBeInstanceOf(ProviderUnreachableError);
    await expect(bfSubmitTx(EP, "00")).rejects.toBeInstanceOf(ProviderUnreachableError);
  });

  it("exports NotOnChainError as its own type so callers can tell it apart", () => {
    expect(new NotOnChainError("/x")).toBeInstanceOf(Error);
    expect(new NotOnChainError("/x").name).toBe("NotOnChainError");
  });
});

/**
 * The field that carries the value, and what happens when it stops arriving.
 *
 * This is the sibling of the Koios `asset_list` defect, on the dialect a
 * self-hosted Dolos speaks. It was left in place when that one was fixed —
 * the patch took its scope from the symptom rather than the cause — and this
 * half is the more expensive one, because `bfUtxos` chooses what to spend.
 *
 * "The vendor would never change this" is not an argument available here: the
 * documented reason this adapter exists is that the endpoint may be somebody's
 * own node, and the wallet cannot tell which it is talking to.
 */
const UTXO_ROW = { tx_hash: "d".repeat(64), output_index: 0 };
const AMOUNT = [{ unit: "lovelace", quantity: "2000000" }];

describe("blockfrost adapter — an output with no amount is not an empty output", () => {
  it("refuses a UTxO whose amount did not arrive", async () => {
    routes({ "/addresses/": { body: [UTXO_ROW] } });
    await expect(bfUtxos(EP, [ADDR])).rejects.toThrow(/what it holds is unknown/);
  });

  it("names the UTxO, so the caller has something to look at", async () => {
    routes({ "/addresses/": { body: [UTXO_ROW] } });
    await expect(bfUtxos(EP, [ADDR])).rejects.toThrow(new RegExp(`${"d".repeat(64)}#0`));
  });

  it("accepts an ordinary output and reads its lovelace", async () => {
    // The direction that decides whether the rule survives: refusing correct
    // responses is what gets a check deleted rather than fixed.
    routes({ "/addresses/": { body: [{ ...UTXO_ROW, amount: AMOUNT }] } });
    const utxos = await bfUtxos(EP, [ADDR]);
    expect(utxos).toHaveLength(1);
    expect(utxos[0].amount.toString()).toBe("2000000");
  });

  it("refuses an address row with no amount rather than calling the wallet empty", async () => {
    // Cheaper to be wrong about than the one above — it only misinforms — but
    // wrong in a way nobody can see: a funded wallet reads as empty, and a gap
    // scan reads the same row as an unused address and stops walking.
    routes({ "/addresses/": { body: {} } });
    await expect(bfAddressBalance(EP, [ADDR])).rejects.toThrow(/reporting it as empty would hide funds/);
  });

  it("still treats a never-used address as holding nothing, which it does", async () => {
    // The one case where "no balance" is the true answer, and it arrives as a
    // 404 rather than a missing field. Conflating the two would stop every gap
    // scan at its first unused address.
    routes({ "/addresses/": { status: 404, body: {} } });
    const bal = await bfAddressBalance(EP, [ADDR]);
    expect(bal.lovelace).toBe(BigInt(0));
  });
});
