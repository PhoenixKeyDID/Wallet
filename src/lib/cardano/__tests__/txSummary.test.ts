/**
 * The decoder behind the "a website wants you to sign this" screen.
 *
 * These transactions are built by this repo's own builder rather than pasted in
 * as fixtures, so the decoder is read against bytes a real signer would accept.
 * A hand-written hex fixture proves the decoder agrees with whoever wrote the
 * fixture, which on the signing path is not the question.
 *
 * The refusals get as much attention as the successes. A wallet that describes
 * nine transactions correctly and the tenth — the strange one — incorrectly is
 * worse than one that describes nine and declines the tenth, because the tenth
 * is the one that was crafted.
 */
import { describe, it, expect } from "vitest";
import { Buffer } from "buffer";
import BigNumber from "bignumber.js";
import { Encoder } from "@stricahq/cbors";
import { utils as tyUtils, types as tyTypes } from "@stricahq/typhonjs";
import { summariseTx, UndescribableTxError } from "../txSummary";
import { buildMultiSend, buildSendOutputs } from "../send";
import { baseAddress, type PhoenixNetwork } from "../address";

const NETWORK: PhoenixNetwork = 0;

const PROTOCOL_PARAMS: tyTypes.ProtocolParams = {
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

const MINE = baseAddress("11".repeat(28), "22".repeat(28), NETWORK);
const MY_CHANGE = baseAddress("33".repeat(28), "22".repeat(28), NETWORK);
const PAYEE = baseAddress("cc".repeat(28), "dd".repeat(28), NETWORK);

const shelley = (b: string) => tyUtils.getAddressFromString(b) as tyTypes.ShelleyAddress;
const hexOf = (b: string) => (tyUtils.getAddressFromString(b) as { getHex(): string }).getHex();

const TXID = "11".repeat(32);
const ADA = (n: string) => BigInt(n);

function myUtxo(lovelace: string, assets: [string, bigint][] = []) {
  return {
    input: {
      txId: TXID,
      index: 0,
      amount: new BigNumber(lovelace),
      tokens: assets.map(([unit, qty]) => ({
        policyId: unit.slice(0, 56),
        assetName: unit.slice(56),
        amount: new BigNumber(qty.toString()),
      })),
      address: shelley(MINE),
    } as unknown as tyTypes.Input,
    held: {
      lovelace: BigInt(lovelace),
      assets: new Map(assets),
    },
  };
}

/** The wallet's own view: which addresses are mine, and what my inputs hold. */
function ownership(held: { lovelace: bigint; assets: Map<string, bigint> }) {
  return {
    addresses: [hexOf(MINE), hexOf(MY_CHANGE)],
    inputs: new Map([[`${TXID}#0`, held]]),
  };
}

function payment(
  adaOut: string,
  tokens: { policyId: string; assetNameHex: string; amount: string }[] = [],
  utxo = myUtxo("10000000"),
) {
  return buildMultiSend({
    outputs: buildSendOutputs([{ address: PAYEE, ada: adaOut, tokens }], NETWORK),
    inputs: [utxo.input],
    changeAddress: shelley(MY_CHANGE),
    protocolParams: PROTOCOL_PARAMS,
    ttl: 50_000_000,
  });
}

describe("summariseTx — what it costs this wallet", () => {
  it("reports the net cost, not the output total", () => {
    // 10 ADA in, 3 ADA out, ~7 ADA back as change. The output total is close to
    // 10; the honest number is 3 plus the fee. Showing the output total here is
    // the mistake this whole module exists to avoid.
    const utxo = myUtxo("10000000");
    const built = payment("3", [], utxo);
    const s = summariseTx(built.unsignedCbor, ownership(utxo.held).addresses, ownership(utxo.held).inputs);

    const ada = s.net.find((n) => n.unit === "");
    expect(ada).toBeDefined();
    expect(ada!.amount).toBe(ADA("3000000") + s.fee);
    expect(ada!.amount).toBeLessThan(ADA("10000000"));
  });

  it("names every recipient that is not this wallet, and no others", () => {
    const utxo = myUtxo("10000000");
    const built = payment("3", [], utxo);
    const own = ownership(utxo.held);
    const s = summariseTx(built.unsignedCbor, own.addresses, own.inputs);

    expect(s.toOthers).toHaveLength(1);
    expect(s.toOthers[0]!.address).toBe(PAYEE);
    expect(s.toOthers[0]!.lovelace).toBe(ADA("3000000"));
    // The change output goes to MY_CHANGE, which is ours — it must not appear
    // as a recipient. A user who sees their own change listed as a payment has
    // been shown a transaction twice the size of the real one.
    expect(s.toOthers.some((r) => r.address === MY_CHANGE)).toBe(false);
  });

  it("gives the address in full, never truncated", () => {
    const utxo = myUtxo("10000000");
    const own = ownership(utxo.held);
    const s = summariseTx(payment("3", [], utxo).unsignedCbor, own.addresses, own.inputs);
    expect(s.toOthers[0]!.address).toHaveLength(PAYEE.length);
    expect(s.toOthers[0]!.address).not.toContain("…");
  });

  it("counts how many of the inputs are this wallet's", () => {
    const utxo = myUtxo("10000000");
    const own = ownership(utxo.held);
    const s = summariseTx(payment("3", [], utxo).unsignedCbor, own.addresses, own.inputs);
    expect(s.ownInputs).toBe(1);
    expect(s.totalInputs).toBe(1);
  });

  it("reports the fee the transaction actually carries", () => {
    const utxo = myUtxo("10000000");
    const own = ownership(utxo.held);
    const built = payment("3", [], utxo);
    const s = summariseTx(built.unsignedCbor, own.addresses, own.inputs);
    expect(s.fee.toString()).toBe(built.fee);
  });

  it("shows a native token leaving as a separate line", () => {
    const unit = "ab".repeat(28) + "4142";
    const utxo = myUtxo("10000000", [[unit, BigInt(100)]]);
    const built = payment(
      "2",
      [{ policyId: unit.slice(0, 56), assetNameHex: unit.slice(56), amount: "40" }],
      utxo,
    );
    const own = ownership(utxo.held);
    const s = summariseTx(built.unsignedCbor, own.addresses, own.inputs);

    const tok = s.net.find((n) => n.unit === unit);
    expect(tok).toBeDefined();
    // 100 held, 40 sent, 60 back as change → 40 leaves.
    expect(tok!.amount).toBe(BigInt(40));
  });

  it("says nothing left when a token is only passed through to change", () => {
    const unit = "ab".repeat(28) + "4142";
    const utxo = myUtxo("10000000", [[unit, BigInt(100)]]);
    const built = payment("2", [], utxo);
    const own = ownership(utxo.held);
    const s = summariseTx(built.unsignedCbor, own.addresses, own.inputs);
    // All 100 come back in the change output, so the token is not in `net` at
    // all. Listing it as "0" would put a line on the screen about an asset that
    // is not moving.
    expect(s.net.some((n) => n.unit === unit)).toBe(false);
  });

  it("treats an input the wallet does not hold as costing it nothing", () => {
    const utxo = myUtxo("10000000");
    const built = payment("3", [], utxo);
    // Same transaction, but the wallet does not recognise the input.
    const s = summariseTx(built.unsignedCbor, ownership(utxo.held).addresses, new Map());
    expect(s.ownInputs).toBe(0);
    // Nothing of ours went in, and the change output comes back to us, so the
    // wallet is a net *receiver* here. Negative is the correct sign.
    const ada = s.net.find((n) => n.unit === "");
    expect(ada!.amount).toBeLessThan(BigInt(0));
  });
});

describe("summariseTx — what it refuses", () => {
  const own = ownership(myUtxo("10000000").held);

  const encodeBody = (entries: [number, unknown][]) =>
    Encoder.encode([new Map(entries), new Map(), true, null]).toString("hex");

  const outputTo = (addrBech32: string, lovelace: number) => [
    tyUtils.getAddressFromString(addrBech32).getBytes(),
    lovelace,
  ];

  it("refuses bytes that are not a transaction", () => {
    expect(() => summariseTx("deadbeef", own.addresses, own.inputs)).toThrow(UndescribableTxError);
  });

  it("refuses an empty string rather than describing an empty transaction", () => {
    expect(() => summariseTx("", own.addresses, own.inputs)).toThrow(UndescribableTxError);
  });

  // The list of body fields is an allow-list. Conway keeps adding them, and a
  // field this build has never seen may be ordinary or may be delegating the
  // user's voting power — indistinguishable from in here.
  it("refuses a transaction carrying a body field it does not know", () => {
    const cbor = encodeBody([
      [0, [[Buffer.from(TXID, "hex"), 0]]],
      [1, [outputTo(PAYEE, 3_000_000)]],
      [2, 170_000],
      [19, new Map()], // voting_procedures — deliberately not in the allow-list
    ]);
    expect(() => summariseTx(cbor, own.addresses, own.inputs)).toThrow(/cannot describe/);
  });

  it("refuses an output carrying an inline datum", () => {
    const withDatum = new Map<number, unknown>([
      [0, tyUtils.getAddressFromString(PAYEE).getBytes()],
      [1, 3_000_000],
      [2, [0, Buffer.from("00", "hex")]],
    ]);
    const cbor = encodeBody([
      [0, [[Buffer.from(TXID, "hex"), 0]]],
      [1, [withDatum]],
      [2, 170_000],
    ]);
    expect(() => summariseTx(cbor, own.addresses, own.inputs)).toThrow(/datum/);
  });

  it("refuses an output carrying a reference script", () => {
    const withScript = new Map<number, unknown>([
      [0, tyUtils.getAddressFromString(PAYEE).getBytes()],
      [1, 3_000_000],
      [3, Buffer.from("00", "hex")],
    ]);
    const cbor = encodeBody([
      [0, [[Buffer.from(TXID, "hex"), 0]]],
      [1, [withScript]],
      [2, 170_000],
    ]);
    expect(() => summariseTx(cbor, own.addresses, own.inputs)).toThrow(/script/);
  });

  it("refuses a malformed policy id rather than folding two assets into one", () => {
    const value = [3_000_000, new Map([[Buffer.from("aa", "hex"), new Map([[Buffer.from("bb", "hex"), 1]])]])];
    const cbor = encodeBody([
      [0, [[Buffer.from(TXID, "hex"), 0]]],
      [1, [[tyUtils.getAddressFromString(PAYEE).getBytes(), value]]],
      [2, 170_000],
    ]);
    expect(() => summariseTx(cbor, own.addresses, own.inputs)).toThrow(/policy id/);
  });

  it("refuses a negative amount", () => {
    const cbor = encodeBody([
      [0, [[Buffer.from(TXID, "hex"), 0]]],
      [1, [outputTo(PAYEE, -1)]],
      [2, 170_000],
    ]);
    expect(() => summariseTx(cbor, own.addresses, own.inputs)).toThrow(UndescribableTxError);
  });

  it("refuses a transaction with no outputs field it can read", () => {
    const cbor = encodeBody([
      [0, [[Buffer.from(TXID, "hex"), 0]]],
      [2, 170_000],
    ]);
    expect(() => summariseTx(cbor, own.addresses, own.inputs)).toThrow(/outputs/);
  });
});

describe("summariseTx — it notices the things it will not describe in detail", () => {
  const own = ownership(myUtxo("10000000").held);
  const encodeBody = (entries: [number, unknown][]) =>
    Encoder.encode([new Map(entries), new Map(), true, null]).toString("hex");

  it("counts certificates so the screen can refuse to call it a payment", () => {
    const cbor = encodeBody([
      [0, [[Buffer.from(TXID, "hex"), 0]]],
      [1, [[tyUtils.getAddressFromString(PAYEE).getBytes(), 3_000_000]]],
      [2, 170_000],
      [4, [[0, [0, Buffer.from("22".repeat(28), "hex")]]]],
    ]);
    const s = summariseTx(cbor, own.addresses, own.inputs);
    expect(s.certificates).toBe(1);
  });

  it("counts withdrawals", () => {
    const cbor = encodeBody([
      [0, [[Buffer.from(TXID, "hex"), 0]]],
      [1, [[tyUtils.getAddressFromString(PAYEE).getBytes(), 3_000_000]]],
      [2, 170_000],
      [5, new Map([[Buffer.from("e0" + "22".repeat(28), "hex"), 5_000_000]])],
    ]);
    expect(summariseTx(cbor, own.addresses, own.inputs).withdrawals).toBe(1);
  });
});
