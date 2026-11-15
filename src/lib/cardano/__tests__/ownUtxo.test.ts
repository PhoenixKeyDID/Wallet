/**
 * Which outputs at this wallet's addresses it counts as its own money.
 *
 * The LAMP drip-pot pays every claim to the claimer's key address under an
 * inline datum (a tag naming the pot). The ledger ignores a datum on a
 * key-locked input, so that LAMP is the wallet's to spend — and a wallet that
 * skipped every output carrying a datum received it and never showed or spent
 * it. These cases pin the rule on every reader (Koios, Blockfrost, CIP-30), on
 * the approval screen's "is this change" decision, on the CIP-30 answer a dApp
 * builds from, and on the transaction builder that spends such an input.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { Buffer } from "buffer";
import BigNumber from "bignumber.js";
import { CborTag, Decoder, Encoder } from "@stricahq/cbors";
import { utils as tyUtils, types as tyTypes } from "@stricahq/typhonjs";
import { fetchUtxos, fetchAddressBalance } from "../provider";
import { bfUtxos } from "../blockfrost";
import { resetChainSources } from "../chainSource";
import { decodeUtxosToInputs } from "../tx";
import { summariseTx } from "../txSummary";
import { encodeBalanceHex, encodeInputsAsUtxosHex } from "../utxoCbor";
import { sumAssets } from "../walletPort";
import { buildMultiSend } from "../send";
import { paymentCredentialIsKey, walletOwnsOutput, type WalletInput } from "../ownUtxo";

/** Enterprise address, KEY payment credential (header 0x60), preprod. */
const KEY_ADDR = "addr_test1vre6qly5vj7hmre72smsl3q5aae3cd49rennzmfplm9jl7csuup3g";
const KEY_HEX = (tyUtils.getAddressFromString(KEY_ADDR) as { getHex(): string }).getHex();
/** Enterprise address, SCRIPT payment credential (header 0x70), preprod. */
const SCRIPT_HEX = "70" + "44".repeat(28);
const SCRIPT_ADDR = tyUtils.getAddressFromHex(Buffer.from(SCRIPT_HEX, "hex")).getBech32();
const PAYEE = tyUtils.getAddressFromHex(Buffer.from("60" + "cc".repeat(28), "hex")).getBech32();

const LAMP_POLICY = "5a".repeat(28);
const LAMP_NAME = Buffer.from("LAMP", "utf8").toString("hex");
/** `Constr 0 []` — the smallest datum; the drip-pot's tag is a `Constr 0` too. */
const DATUM_CBOR = "d87980";
const DATUM_HASH = "ab".repeat(32);
// No scheme: fetch is stubbed and matches this base by string equality, and an
// absolute URL in an ungated test file trips check:urls.
const EP = { base: "chain.example/api/v0" };

type DatumKind = "none" | "inline" | "hash";

afterEach(() => {
  vi.unstubAllGlobals();
  resetChainSources();
});

// ─── how each reader is fed ─────────────────────────────────────────────────

function koiosRow(o: {
  txByte: string;
  address: string;
  datum: DatumKind;
  refScript?: boolean;
  lovelace?: string;
  lamp?: string;
}) {
  return {
    tx_hash: o.txByte.repeat(32),
    tx_index: 0,
    value: o.lovelace ?? "2000000",
    address: o.address,
    // Koios `_extended`: inline datum as `{ bytes, value }`, and its hash beside it.
    inline_datum: o.datum === "inline" ? { bytes: DATUM_CBOR, value: { constructor: 0, fields: [] } } : null,
    datum_hash: o.datum === "none" ? null : DATUM_HASH,
    reference_script: o.refScript ? { hash: "ef".repeat(28), type: "plutusV2" } : null,
    asset_list: o.lamp ? [{ policy_id: LAMP_POLICY, asset_name: LAMP_NAME, quantity: o.lamp }] : [],
  };
}

function koiosReplies(rows: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(rows), { status: 200, headers: { "content-type": "application/json" } })),
  );
}

function bfRow(o: { txByte: string; address: string; datum: DatumKind; refScript?: boolean; lovelace?: string; lamp?: string }) {
  return {
    tx_hash: o.txByte.repeat(32),
    output_index: 0,
    address: o.address,
    amount: [
      { unit: "lovelace", quantity: o.lovelace ?? "2000000" },
      ...(o.lamp ? [{ unit: LAMP_POLICY + LAMP_NAME, quantity: o.lamp }] : []),
    ],
    // Blockfrost: inline datum as CBOR hex, and `data_hash` set for both kinds.
    inline_datum: o.datum === "inline" ? DATUM_CBOR : null,
    data_hash: o.datum === "none" ? null : DATUM_HASH,
    reference_script_hash: o.refScript ? "ef".repeat(28) : null,
  };
}

function bfReplies(addr: string, rows: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      // The reader pages (`?count=100&page=N`); every row here fits on page 1.
      const ok = url === `${EP.base}/addresses/${encodeURIComponent(addr)}/utxos?count=100&page=1`;
      const body = ok ? rows : {};
      return { ok, status: ok ? 200 : 404, text: async () => JSON.stringify(body), json: async () => body };
    }),
  );
}

function datumOption(datum: DatumKind): unknown {
  if (datum === "inline") return [1, new CborTag(Buffer.from(DATUM_CBOR, "hex"), 24)];
  if (datum === "hash") return [0, Buffer.from(DATUM_HASH, "hex")];
  return undefined;
}

/** A CIP-30 `TransactionUnspentOutput` in the Babbage map form. */
function cip30Hex(o: { txByte: string; addressHex: string; datum: DatumKind; refScript?: boolean }): string {
  const out = new Map<number, unknown>([
    [0, Buffer.from(o.addressHex, "hex")],
    [1, 2_000_000],
  ]);
  const d = datumOption(o.datum);
  if (d !== undefined) out.set(2, d);
  if (o.refScript) out.set(3, new CborTag(Encoder.encode([2, Buffer.from("4e4d01000033222220051200120011", "hex")]), 24));
  return Encoder.encode([[Buffer.from(o.txByte.repeat(32), "hex"), 0], out]).toString("hex");
}

// ─── the rule itself ────────────────────────────────────────────────────────

describe("walletOwnsOutput — the one rule", () => {
  it("reads the payment credential from the header: even Shelley types are keys, odd ones scripts", () => {
    for (const t of [0, 2, 4, 6]) expect(paymentCredentialIsKey(`${t}0` + "11".repeat(28))).toBe(true);
    for (const t of [1, 3, 5, 7]) expect(paymentCredentialIsKey(`${t}0` + "11".repeat(28))).toBe(false);
    // Byron and reward addresses are not "a key payment credential" here.
    expect(paymentCredentialIsKey("82" + "00".repeat(20))).toBe(false);
    expect(paymentCredentialIsKey("e0" + "11".repeat(28))).toBe(false);
    expect(() => paymentCredentialIsKey("")).toThrow(/no header byte/);
  });

  it("keeps a datum at a key address, skips one at a script address, skips any reference script", () => {
    expect(walletOwnsOutput({ addressHex: KEY_HEX, datum: true, referenceScript: false })).toBe(true);
    expect(walletOwnsOutput({ addressHex: KEY_HEX, datum: false, referenceScript: false })).toBe(true);
    expect(walletOwnsOutput({ addressHex: SCRIPT_HEX, datum: true, referenceScript: false })).toBe(false);
    expect(walletOwnsOutput({ addressHex: SCRIPT_HEX, datum: false, referenceScript: false })).toBe(true);
    expect(walletOwnsOutput({ addressHex: KEY_HEX, datum: false, referenceScript: true })).toBe(false);
    expect(walletOwnsOutput({ addressHex: KEY_HEX, datum: true, referenceScript: true })).toBe(false);
  });
});

// ─── each reader ─────────────────────────────────────────────────────────────

describe("fetchUtxos (Koios) — a datum at a key address is the wallet's", () => {
  it("keeps an inline datum and a datum hash, with the datum; skips a reference script", async () => {
    koiosReplies([
      koiosRow({ txByte: "a1", address: KEY_ADDR, datum: "inline" }),
      koiosRow({ txByte: "a2", address: KEY_ADDR, datum: "hash" }),
      koiosRow({ txByte: "a3", address: KEY_ADDR, datum: "none", refScript: true }),
      koiosRow({ txByte: "a4", address: KEY_ADDR, datum: "none" }),
    ]);
    const got = await fetchUtxos(0, [KEY_ADDR]);
    expect(got.map((u) => [u.txId.slice(0, 2), u.chainDatum])).toEqual([
      ["a1", { kind: "inline", cborHex: DATUM_CBOR }],
      ["a2", { kind: "hash", hashHex: DATUM_HASH }],
      ["a4", undefined],
    ]);
  });

  it("skips a datum at a script address", async () => {
    koiosReplies([koiosRow({ txByte: "a5", address: SCRIPT_ADDR, datum: "inline" })]);
    expect(await fetchUtxos(0, [SCRIPT_ADDR])).toEqual([]);
  });

  it("puts the LAMP held under a datum into the balance the send form and getBalance read", async () => {
    koiosReplies([
      koiosRow({ txByte: "a6", address: KEY_ADDR, datum: "inline", lovelace: "1300000", lamp: "1000000000" }),
      koiosRow({ txByte: "a7", address: KEY_ADDR, datum: "none", lovelace: "5000000" }),
    ]);
    const inputs = await fetchUtxos(0, [KEY_ADDR]);
    expect(sumAssets(inputs)).toEqual([
      { unit: LAMP_POLICY + LAMP_NAME, policyId: LAMP_POLICY, assetNameHex: LAMP_NAME, quantity: BigInt(1_000_000_000) },
    ]);
    const bal = Decoder.decode(Buffer.from(encodeBalanceHex(inputs), "hex")).value as [bigint | number, Map<Buffer, Map<Buffer, bigint | number>>];
    expect(BigInt(bal[0])).toBe(BigInt(6_300_000));
    const lamp = bal[1].get([...bal[1].keys()][0]!)!;
    expect(BigInt([...lamp.values()][0]!)).toBe(BigInt(1_000_000_000));
  });

  it("refuses an inline datum in a shape it cannot read, rather than reading it as no datum", async () => {
    koiosReplies([{ ...koiosRow({ txByte: "a8", address: KEY_ADDR, datum: "none" }), inline_datum: DATUM_CBOR }]);
    await expect(fetchUtxos(0, [KEY_ADDR])).rejects.toThrow(/inline datum this wallet cannot read/);
  });

  it("refuses a datum hash that is not 32 bytes of hex", async () => {
    koiosReplies([{ ...koiosRow({ txByte: "a9", address: KEY_ADDR, datum: "none" }), datum_hash: "xyz" }]);
    await expect(fetchUtxos(0, [KEY_ADDR])).rejects.toThrow(/datum hash this wallet cannot read/);
  });
});

describe("fetchAddressBalance (Koios) — the displayed balance already counts LAMP under a datum", () => {
  // `/address_info` sums the address; it has no datum filter to change. Pinned
  // so the displayed balance and the spendable set are known to agree here.
  it("counts the tokens of a utxo_set entry that carries a datum", async () => {
    koiosReplies([
      {
        balance: "1300000",
        utxo_set: [{ inline_datum: { bytes: DATUM_CBOR }, asset_list: [{ policy_id: LAMP_POLICY, asset_name: LAMP_NAME, quantity: "1000000000" }] }],
      },
    ]);
    const bal = await fetchAddressBalance(0, [KEY_ADDR]);
    expect(bal.lovelace).toBe(BigInt(1_300_000));
    expect(bal.assets).toEqual([
      { unit: LAMP_POLICY + LAMP_NAME, policyId: LAMP_POLICY, assetNameHex: LAMP_NAME, quantity: BigInt(1_000_000_000) },
    ]);
  });
});

describe("bfUtxos (Blockfrost) — a datum at a key address is the wallet's", () => {
  it("keeps an inline datum and a datum hash, with the datum; skips a reference script", async () => {
    bfReplies(KEY_ADDR, [
      bfRow({ txByte: "b1", address: KEY_ADDR, datum: "inline" }),
      bfRow({ txByte: "b2", address: KEY_ADDR, datum: "hash" }),
      bfRow({ txByte: "b3", address: KEY_ADDR, datum: "none", refScript: true }),
      bfRow({ txByte: "b4", address: KEY_ADDR, datum: "none" }),
    ]);
    const got = await bfUtxos(EP, [KEY_ADDR]);
    expect(got.map((u) => [u.txId.slice(0, 2), u.chainDatum])).toEqual([
      ["b1", { kind: "inline", cborHex: DATUM_CBOR }],
      ["b2", { kind: "hash", hashHex: DATUM_HASH }],
      ["b4", undefined],
    ]);
  });

  it("skips a datum at a script address", async () => {
    bfReplies(SCRIPT_ADDR, [bfRow({ txByte: "b5", address: SCRIPT_ADDR, datum: "hash" })]);
    expect(await bfUtxos(EP, [SCRIPT_ADDR])).toEqual([]);
  });

  it("puts the LAMP held under a datum into the balance the send form reads", async () => {
    bfReplies(KEY_ADDR, [bfRow({ txByte: "b6", address: KEY_ADDR, datum: "inline", lovelace: "1300000", lamp: "1000000000" })]);
    expect(sumAssets(await bfUtxos(EP, [KEY_ADDR]))).toEqual([
      { unit: LAMP_POLICY + LAMP_NAME, policyId: LAMP_POLICY, assetNameHex: LAMP_NAME, quantity: BigInt(1_000_000_000) },
    ]);
  });

  it("refuses an inline datum that is not hex, rather than handing a dApp bytes that are not a datum", async () => {
    bfReplies(KEY_ADDR, [{ ...bfRow({ txByte: "b7", address: KEY_ADDR, datum: "none" }), inline_datum: "not-hex" }]);
    await expect(bfUtxos(EP, [KEY_ADDR])).rejects.toThrow(/inline datum this wallet cannot read/);
    bfReplies(KEY_ADDR, [{ ...bfRow({ txByte: "b8", address: KEY_ADDR, datum: "none" }), inline_datum: { bytes: DATUM_CBOR } }]);
    await expect(bfUtxos(EP, [KEY_ADDR])).rejects.toThrow(/inline datum this wallet cannot read/);
  });
});

describe("decodeUtxosToInputs (CIP-30) — a datum at a key address is the wallet's", () => {
  it("keeps an inline datum, a Babbage datum hash and a legacy datum hash; skips a reference script", () => {
    const legacyHash = Encoder.encode([
      [Buffer.from("c3".repeat(32), "hex"), 0],
      [Buffer.from(KEY_HEX, "hex"), 2_000_000, Buffer.from(DATUM_HASH, "hex")],
    ]).toString("hex");
    const got = decodeUtxosToInputs([
      cip30Hex({ txByte: "c1", addressHex: KEY_HEX, datum: "inline" }),
      cip30Hex({ txByte: "c2", addressHex: KEY_HEX, datum: "hash" }),
      legacyHash,
      cip30Hex({ txByte: "c4", addressHex: KEY_HEX, datum: "none", refScript: true }),
    ]);
    expect(got.map((u) => u.txId.slice(0, 2))).toEqual(["c1", "c2", "c3"]);
  });

  it("skips a datum at a script address, Babbage and legacy alike", () => {
    const legacyHash = Encoder.encode([
      [Buffer.from("c6".repeat(32), "hex"), 0],
      [Buffer.from(SCRIPT_HEX, "hex"), 2_000_000, Buffer.from(DATUM_HASH, "hex")],
    ]).toString("hex");
    expect(decodeUtxosToInputs([cip30Hex({ txByte: "c5", addressHex: SCRIPT_HEX, datum: "inline" }), legacyHash])).toEqual([]);
  });
});

// ─── the readers and the approval screen cannot disagree ────────────────────

describe("one rule: every reader keeps exactly the outputs the approval screen counts as change", () => {
  // A 100 ADA input, 4.8 ADA to a payee, 95 ADA to the address under test.
  // The screen says it is change iff the payee is the only recipient listed.
  const TXID = "f0".repeat(32);
  const held = new Map([[`${TXID}#0`, { lovelace: BigInt(100_000_000), assets: new Map<string, bigint>() }]]);
  function screenCountsAsChange(addressHex: string, datum: DatumKind): boolean {
    const out = new Map<number, unknown>([
      [0, Buffer.from(addressHex, "hex")],
      [1, 95_000_000],
    ]);
    const d = datumOption(datum);
    if (d !== undefined) out.set(2, d);
    const body = new Map<number, unknown>([
      [0, [[Buffer.from(TXID, "hex"), 0]]],
      [1, [[tyUtils.getAddressFromString(PAYEE).getBytes(), 4_800_000], out]],
      [2, 200_000],
    ]);
    const cbor = Encoder.encode([body, new Map(), true, null]).toString("hex");
    const s = summariseTx(cbor, [KEY_HEX, SCRIPT_HEX], held, 0);
    return s.toOthers.every((r) => r.address === PAYEE);
  }
  async function koiosKeeps(address: string, datum: DatumKind): Promise<boolean> {
    koiosReplies([koiosRow({ txByte: "d1", address, datum })]);
    return (await fetchUtxos(0, [address])).length === 1;
  }
  async function bfKeeps(address: string, datum: DatumKind): Promise<boolean> {
    bfReplies(address, [bfRow({ txByte: "d2", address, datum })]);
    return (await bfUtxos(EP, [address])).length === 1;
  }
  function cip30Keeps(addressHex: string, datum: DatumKind): boolean {
    return decodeUtxosToInputs([cip30Hex({ txByte: "d3", addressHex, datum })]).length === 1;
  }

  const cases: Array<[string, string, string, DatumKind, boolean]> = [
    ["key, no datum", KEY_ADDR, KEY_HEX, "none", true],
    ["key, inline datum", KEY_ADDR, KEY_HEX, "inline", true],
    ["key, datum hash", KEY_ADDR, KEY_HEX, "hash", true],
    ["script, no datum", SCRIPT_ADDR, SCRIPT_HEX, "none", true],
    ["script, inline datum", SCRIPT_ADDR, SCRIPT_HEX, "inline", false],
    ["script, datum hash", SCRIPT_ADDR, SCRIPT_HEX, "hash", false],
  ];
  for (const [name, bech, hex, datum, expected] of cases) {
    it(`${name}: Koios, Blockfrost, CIP-30 and the screen all say ${expected ? "the wallet's" : "not the wallet's"}`, async () => {
      const answers = {
        koios: await koiosKeeps(bech, datum),
        blockfrost: await bfKeeps(bech, datum),
        cip30: cip30Keeps(hex, datum),
        screen: screenCountsAsChange(hex, datum),
      };
      expect(answers).toEqual({ koios: expected, blockfrost: expected, cip30: expected, screen: expected });
    });
  }
});

// ─── what a dApp is told ─────────────────────────────────────────────────────

describe("encodeInputsAsUtxosHex — an input under a datum is described with the datum", () => {
  const address = tyUtils.getAddressFromString(KEY_ADDR) as tyTypes.ShelleyAddress;
  const base = (txByte: string): WalletInput => ({
    txId: txByte.repeat(32),
    index: 1,
    amount: new BigNumber("1300000"),
    tokens: [{ policyId: LAMP_POLICY, assetName: LAMP_NAME, amount: new BigNumber("1000000000") }],
    address,
  });

  it("an inline datum: Babbage map, key 2 = [1, #6.24(datum bytes)]", () => {
    const [hex] = encodeInputsAsUtxosHex([{ ...base("e1"), chainDatum: { kind: "inline", cborHex: DATUM_CBOR } }]);
    const [, out] = Decoder.decode(Buffer.from(hex!, "hex")).value as [unknown, Map<number, unknown>];
    expect(out).toBeInstanceOf(Map);
    const opt = out.get(2) as [number, CborTag];
    expect(opt[0]).toBe(1);
    expect(opt[1].tag).toBe(24);
    expect(Buffer.from(opt[1].value).toString("hex")).toBe(DATUM_CBOR);
    expect(Buffer.from(out.get(0) as Buffer).toString("hex")).toBe(KEY_HEX);
    expect(out.has(3)).toBe(false);
  });

  it("a datum hash: Babbage map, key 2 = [0, hash]", () => {
    const [hex] = encodeInputsAsUtxosHex([{ ...base("e2"), chainDatum: { kind: "hash", hashHex: DATUM_HASH } }]);
    const [, out] = Decoder.decode(Buffer.from(hex!, "hex")).value as [unknown, Map<number, unknown>];
    const opt = out.get(2) as [number, Buffer];
    expect(opt[0]).toBe(0);
    expect(Buffer.from(opt[1]).toString("hex")).toBe(DATUM_HASH);
  });

  it("no datum: still the legacy two-element array", () => {
    const [hex] = encodeInputsAsUtxosHex([base("e3")]);
    const [, out] = Decoder.decode(Buffer.from(hex!, "hex")).value as [unknown, unknown[]];
    expect(Array.isArray(out)).toBe(true);
    expect(out).toHaveLength(2);
  });

  it("round-trips through the CIP-30 decoder: the input under a datum is read back with its LAMP", () => {
    const hexes = encodeInputsAsUtxosHex([{ ...base("e4"), chainDatum: { kind: "inline", cborHex: DATUM_CBOR } }]);
    const [back] = decodeUtxosToInputs(hexes);
    expect(back?.txId).toBe("e4".repeat(32));
    expect(back?.tokens.map((t) => [t.policyId, t.assetName, t.amount.toString()])).toEqual([[LAMP_POLICY, LAMP_NAME, "1000000000"]]);
  });

  it("refuses an inline datum that is not hex rather than encoding bytes that are not it", () => {
    expect(() =>
      encodeInputsAsUtxosHex([{ ...base("e5"), chainDatum: { kind: "inline", cborHex: "zz" } }]),
    ).toThrow(/malformed datum/);
  });

  it("refuses a datum hash that is not 32 bytes rather than encoding a hash the chain does not have", () => {
    expect(() =>
      encodeInputsAsUtxosHex([{ ...base("e6"), chainDatum: { kind: "hash", hashHex: "ab" } }]),
    ).toThrow(/malformed datum/);
  });
});

// ─── spending it ─────────────────────────────────────────────────────────────

describe("buildMultiSend — spending an input under a datum at a key address", () => {
  const PARAMS: tyTypes.ProtocolParams = {
    minFeeA: new BigNumber(44),
    minFeeB: new BigNumber(155381),
    stakeKeyDeposit: new BigNumber(2_000_000),
    utxoCostPerByte: new BigNumber(4310),
    collateralPercent: new BigNumber(150),
    priceSteps: new BigNumber(0),
    priceMem: new BigNumber(0),
    maxTxSize: 16384,
    maxValueSize: 5000,
    minFeeRefScriptCostPerByte: new BigNumber(15),
  };

  it("builds from the reader's output: no datum witness, no script data hash, every token conserved", async () => {
    // The only coin is the drip-pot shape: 10 ADA + 1000 LAMP under an inline datum.
    koiosReplies([koiosRow({ txByte: "f1", address: KEY_ADDR, datum: "inline", lovelace: "10000000", lamp: "1000000000" })]);
    const inputs = await fetchUtxos(0, [KEY_ADDR]);
    expect(inputs).toHaveLength(1);
    const built = buildMultiSend({
      outputs: [{ address: tyUtils.getAddressFromString(PAYEE) as tyTypes.ShelleyAddress, lovelace: BigInt(2_000_000), tokens: [] }],
      inputs,
      changeAddress: tyUtils.getAddressFromString(KEY_ADDR) as tyTypes.ShelleyAddress,
      protocolParams: PARAMS,
      ttl: 50_000_000,
    });
    const [body, witnesses] = Decoder.decode(Buffer.from(built.unsignedCbor, "hex")).value as [
      Map<number, unknown>,
      Map<number, unknown>,
    ];

    // It spends the datum input.
    const ins = body.get(0) as unknown;
    const raw = ins instanceof CborTag ? ins.value : ins;
    const insList = [...(raw as Iterable<[Buffer, number]>)];
    expect(insList.map(([id, ix]) => `${Buffer.from(id).toString("hex")}#${Number(ix)}`)).toEqual([`${"f1".repeat(32)}#0`]);

    // A key-locked input needs no datum and no script: nothing Plutus in the
    // witness set (3 V1 scripts, 4 datums, 5 redeemers, 6/7 V2/V3 scripts), and
    // no script data hash (11) in the body.
    for (const k of [3, 4, 5, 6, 7]) expect(witnesses.has(k)).toBe(false);
    expect(body.has(11)).toBe(false);

    // Value is conserved: ADA in = ADA out + fee, and all 1000 LAMP land in
    // the outputs, none under a datum.
    const outs = body.get(1) as unknown[];
    let ada = BigInt(0);
    let lamp = BigInt(0);
    for (const o of outs) {
      const isMap = o instanceof Map;
      const value = isMap ? (o as Map<number, unknown>).get(1) : (o as unknown[])[1];
      if (isMap) expect((o as Map<number, unknown>).has(2)).toBe(false);
      else expect((o as unknown[]).length).toBe(2);
      if (Array.isArray(value)) {
        ada += BigInt(value[0] as number);
        for (const names of (value[1] as Map<Buffer, Map<Buffer, number>>).values()) {
          for (const q of names.values()) lamp += BigInt(q);
        }
      } else {
        ada += BigInt(value as number);
      }
    }
    expect(ada + BigInt(built.fee)).toBe(BigInt(10_000_000));
    expect(lamp).toBe(BigInt(1_000_000_000));
  });
});
