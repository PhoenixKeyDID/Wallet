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
import { CborTag, Encoder } from "@stricahq/cbors";
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
    const s = summariseTx(built.unsignedCbor, ownership(utxo.held).addresses, ownership(utxo.held).inputs, 0);

    const ada = s.net.find((n) => n.unit === "");
    expect(ada).toBeDefined();
    expect(ada!.amount).toBe(ADA("3000000") + s.fee);
    expect(ada!.amount).toBeLessThan(ADA("10000000"));
  });

  it("names every recipient that is not this wallet, and no others", () => {
    const utxo = myUtxo("10000000");
    const built = payment("3", [], utxo);
    const own = ownership(utxo.held);
    const s = summariseTx(built.unsignedCbor, own.addresses, own.inputs, 0);

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
    const s = summariseTx(payment("3", [], utxo).unsignedCbor, own.addresses, own.inputs, 0);
    expect(s.toOthers[0]!.address).toHaveLength(PAYEE.length);
    expect(s.toOthers[0]!.address).not.toContain("…");
  });

  it("counts how many of the inputs are this wallet's", () => {
    const utxo = myUtxo("10000000");
    const own = ownership(utxo.held);
    const s = summariseTx(payment("3", [], utxo).unsignedCbor, own.addresses, own.inputs, 0);
    expect(s.ownInputs).toBe(1);
    expect(s.totalInputs).toBe(1);
  });

  it("reports the fee the transaction actually carries", () => {
    const utxo = myUtxo("10000000");
    const own = ownership(utxo.held);
    const built = payment("3", [], utxo);
    const s = summariseTx(built.unsignedCbor, own.addresses, own.inputs, 0);
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
    const s = summariseTx(built.unsignedCbor, own.addresses, own.inputs, 0);

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
    const s = summariseTx(built.unsignedCbor, own.addresses, own.inputs, 0);
    // All 100 come back in the change output, so the token is not in `net` at
    // all. Listing it as "0" would put a line on the screen about an asset that
    // is not moving.
    expect(s.net.some((n) => n.unit === unit)).toBe(false);
  });

  it("treats an input the wallet does not hold as costing it nothing", () => {
    const utxo = myUtxo("10000000");
    const built = payment("3", [], utxo);
    // Same transaction, but the wallet does not recognise the input.
    const s = summariseTx(built.unsignedCbor, ownership(utxo.held).addresses, new Map(), 0);
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
    expect(() => summariseTx("deadbeef", own.addresses, own.inputs, 0)).toThrow(UndescribableTxError);
  });

  it("refuses an empty string rather than describing an empty transaction", () => {
    expect(() => summariseTx("", own.addresses, own.inputs, 0)).toThrow(UndescribableTxError);
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
    expect(() => summariseTx(cbor, own.addresses, own.inputs, 0)).toThrow(/cannot describe/);
  });

  // Collateral is a second spend path: if a script fails, the ledger takes the
  // collateral inputs and pays out only the collateral return, and neither
  // appears in `net` or `toOthers`. A dApp claim needs collateral, so it is
  // described rather than refused — but only when every collateral input is
  // this wallet's (otherwise the amount at risk is unknowable) and the return
  // comes back here with every token. The screen then shows the ADA at risk.
  describe("collateral — a second spend path, shown with the amount at risk", () => {
    const BIG_OWN = `${"44".repeat(32)}`; // another UTxO of this wallet, 1000 ADA
    const TOKEN_POLICY = "ab".repeat(28);
    const TOKEN_NAME = "4142";
    const ordinary: [number, unknown][] = [
      [0, [[Buffer.from(TXID, "hex"), 0]]],
      [1, [outputTo(PAYEE, 200_000), outputTo(MY_CHANGE, 9_600_000)]],
      [2, 200_000],
    ];
    const collateralFromWallet: [number, unknown] = [13, [[Buffer.from(BIG_OWN, "hex"), 0]]];
    const returnToPage: [number, unknown] = [16, outputTo(PAYEE, 1_000_000)];
    const returnToMe: [number, unknown] = [16, outputTo(MY_CHANGE, 995_000_000)];
    const totalCollateral: [number, unknown] = [17, 5_000_000];
    const withBig = (assets: [string, bigint][] = []) =>
      new Map([
        ...own.inputs,
        [`${BIG_OWN}#0`, { lovelace: BigInt(1_000_000_000), assets: new Map<string, bigint>(assets) }],
      ]);
    const tokenValue = (lovelace: number, qty: number) => [
      lovelace,
      new Map([[Buffer.from(TOKEN_POLICY, "hex"), new Map([[Buffer.from(TOKEN_NAME, "hex"), qty]])]]),
    ];

    // Control: the ordinary path alone is describable, and reports a small
    // cost and no collateral.
    it("describes the same transaction once collateral is removed", () => {
      const s = summariseTx(encodeBody(ordinary), own.addresses, withBig(), 0);
      expect(s.net).toEqual([{ unit: "", policyId: "", assetNameHex: "", amount: BigInt(200_000 + 200_000) }]);
      expect(s.collateral).toBeNull();
    });

    it("reports collateral minus return as the amount at risk", () => {
      const cbor = encodeBody([...ordinary, collateralFromWallet, returnToMe]);
      const s = summariseTx(cbor, own.addresses, withBig(), 0);
      expect(s.collateral).toEqual({ riskLovelace: BigInt(5_000_000), inputs: 1 });
    });

    it("accepts a declared total that matches, and reports it", () => {
      const cbor = encodeBody([...ordinary, collateralFromWallet, returnToMe, totalCollateral]);
      expect(summariseTx(cbor, own.addresses, withBig(), 0).collateral!.riskLovelace).toBe(BigInt(5_000_000));
    });

    // With no return the whole 1000 ADA input is at risk, and the page that
    // built the transaction decides whether its script fails. Printing the
    // number was the old answer; the cap refuses it.
    it("refuses the whole 1000 ADA input at risk when there is no return: above the 5 ADA cap", () => {
      const cbor = encodeBody([...ordinary, collateralFromWallet]);
      expect(() => summariseTx(cbor, own.addresses, withBig(), 0)).toThrow(
        expect.objectContaining({ key: "sign_foreign_collateral_over_cap" }),
      );
    });

    it("refuses the attack: this wallet's UTxO as collateral, return aimed at the page", () => {
      const cbor = encodeBody([...ordinary, collateralFromWallet, returnToPage]);
      expect(() => summariseTx(cbor, own.addresses, withBig(), 0)).toThrow(/collateral return .*not this wallet/);
    });

    // An input the wallet does not recognise has an unknown value, so the
    // amount at risk would be a guess.
    it("refuses collateral the wallet does not recognise", () => {
      const cbor = encodeBody([...ordinary, collateralFromWallet]);
      expect(() => summariseTx(cbor, own.addresses, own.inputs, 0)).toThrow(/collateral this wallet cannot account for/);
    });

    it("refuses tokens put up as collateral with no return giving them back", () => {
      const cbor = encodeBody([...ordinary, collateralFromWallet]);
      const held = withBig([[TOKEN_POLICY + TOKEN_NAME, BigInt(7)]]);
      expect(() => summariseTx(cbor, own.addresses, held, 0)).toThrow(/tokens as collateral/);
    });

    it("refuses a return that gives back only some of the collateral tokens", () => {
      const partial: [number, unknown] = [16, [tyUtils.getAddressFromString(MY_CHANGE).getBytes(), tokenValue(995_000_000, 6)]];
      const cbor = encodeBody([...ordinary, collateralFromWallet, partial]);
      const held = withBig([[TOKEN_POLICY + TOKEN_NAME, BigInt(7)]]);
      expect(() => summariseTx(cbor, own.addresses, held, 0)).toThrow(/tokens as collateral/);
    });

    it("describes token collateral when the return gives every token back", () => {
      const full: [number, unknown] = [16, [tyUtils.getAddressFromString(MY_CHANGE).getBytes(), tokenValue(995_000_000, 7)]];
      const cbor = encodeBody([...ordinary, collateralFromWallet, full]);
      const held = withBig([[TOKEN_POLICY + TOKEN_NAME, BigInt(7)]]);
      expect(summariseTx(cbor, own.addresses, held, 0).collateral!.riskLovelace).toBe(BigInt(5_000_000));
    });

    it("refuses a declared total that does not match collateral minus return", () => {
      const cbor = encodeBody([...ordinary, collateralFromWallet, returnToMe, [17, 4_000_000]]);
      expect(() => summariseTx(cbor, own.addresses, withBig(), 0)).toThrow(/collateral total/);
    });

    // The return comes back to this wallet's address with the right amount;
    // only the datum differs between these two cases. A return under a datum
    // is refused outright: the screen does not describe what the datum is for,
    // and a collateral return has no reason to carry one.
    const returnMapToMe = (datum?: unknown): [number, unknown] => [
      16,
      new Map<number, unknown>([
        [0, tyUtils.getAddressFromString(MY_CHANGE).getBytes()],
        [1, 995_000_000],
        ...(datum === undefined ? [] : ([[2, datum]] as [number, unknown][])),
      ]),
    ];
    it("describes a Babbage-shaped collateral return with no datum (control)", () => {
      const cbor = encodeBody([...ordinary, collateralFromWallet, returnMapToMe()]);
      expect(summariseTx(cbor, own.addresses, withBig(), 0).collateral).toEqual({
        riskLovelace: BigInt(5_000_000),
        inputs: 1,
      });
    });
    it("refuses a collateral return that carries a datum", () => {
      const inline = encodeBody([...ordinary, collateralFromWallet, returnMapToMe([1, Buffer.from("d87980", "hex")])]);
      expect(() => summariseTx(inline, own.addresses, withBig(), 0)).toThrow(/collateral return carries a datum/);
      const byHash = encodeBody([...ordinary, collateralFromWallet, returnMapToMe([0, Buffer.alloc(32, 0xab)])]);
      expect(() => summariseTx(byHash, own.addresses, withBig(), 0)).toThrow(/collateral return carries a datum/);
    });

    it("refuses a collateral return on its own", () => {
      const cbor = encodeBody([...ordinary, returnToMe]);
      expect(() => summariseTx(cbor, own.addresses, own.inputs, 0)).toThrow(/no collateral/);
    });

    it("refuses a declared collateral total on its own", () => {
      const cbor = encodeBody([...ordinary, totalCollateral]);
      expect(() => summariseTx(cbor, own.addresses, own.inputs, 0)).toThrow(/no collateral/);
    });

    it("refuses the same collateral input named twice", () => {
      const twice: [number, unknown] = [13, [[Buffer.from(BIG_OWN, "hex"), 0], [Buffer.from(BIG_OWN, "hex"), 0]]];
      const cbor = encodeBody([...ordinary, twice]);
      expect(() => summariseTx(cbor, own.addresses, withBig(), 0)).toThrow(/twice/);
    });

    it("keeps the generic wording for fields that are not collateral", () => {
      const cbor = encodeBody([...ordinary, [19, new Map()]]);
      expect(() => summariseTx(cbor, own.addresses, own.inputs, 0)).toThrow(/field 19/);
    });
  });

  // A datum is the state a contract keeps beside the money; the money still
  // goes where the address says. A claim pays a script output with a datum, so
  // it is shown, not refused.
  it("describes an output carrying an inline datum and flags it", () => {
    const withDatum = new Map<number, unknown>([
      [0, tyUtils.getAddressFromString(PAYEE).getBytes()],
      [1, 3_000_000],
      [2, [1, Buffer.from("d87980", "hex")]],
    ]);
    const cbor = encodeBody([
      [0, [[Buffer.from(TXID, "hex"), 0]]],
      [1, [withDatum]],
      [2, 170_000],
    ]);
    const s = summariseTx(cbor, own.addresses, own.inputs, 0);
    expect(s.toOthers).toEqual([
      { address: PAYEE, lovelace: BigInt(3_000_000), assets: [], datum: true, mine: false },
    ]);
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
    expect(() => summariseTx(cbor, own.addresses, own.inputs, 0)).toThrow(/script/);
  });

  it("refuses a malformed policy id rather than folding two assets into one", () => {
    const value = [3_000_000, new Map([[Buffer.from("aa", "hex"), new Map([[Buffer.from("bb", "hex"), 1]])]])];
    const cbor = encodeBody([
      [0, [[Buffer.from(TXID, "hex"), 0]]],
      [1, [[tyUtils.getAddressFromString(PAYEE).getBytes(), value]]],
      [2, 170_000],
    ]);
    expect(() => summariseTx(cbor, own.addresses, own.inputs, 0)).toThrow(/policy id/);
  });

  it("refuses a negative amount", () => {
    const cbor = encodeBody([
      [0, [[Buffer.from(TXID, "hex"), 0]]],
      [1, [outputTo(PAYEE, -1)]],
      [2, 170_000],
    ]);
    expect(() => summariseTx(cbor, own.addresses, own.inputs, 0)).toThrow(UndescribableTxError);
  });

  it("refuses a transaction with no outputs field it can read", () => {
    const cbor = encodeBody([
      [0, [[Buffer.from(TXID, "hex"), 0]]],
      [2, 170_000],
    ]);
    expect(() => summariseTx(cbor, own.addresses, own.inputs, 0)).toThrow(/outputs/);
  });
});

describe("summariseTx — it notices the things it will not describe in detail", () => {
  const own = ownership(myUtxo("10000000").held);
  const encodeBody = (entries: [number, unknown][]) =>
    Encoder.encode([new Map(entries), new Map(), true, null]).toString("hex");

  it("refuses a certificate outright — the screen cannot say whom it hands the stake or the vote to", () => {
    const cbor = encodeBody([
      [0, [[Buffer.from(TXID, "hex"), 0]]],
      [1, [[tyUtils.getAddressFromString(PAYEE).getBytes(), 3_000_000]]],
      [2, 170_000],
      [4, [[0, [0, Buffer.from("22".repeat(28), "hex")]]]],
    ]);
    expect(() => summariseTx(cbor, own.addresses, own.inputs, 0)).toThrow(/certificate/);
  });

  it("counts withdrawals", () => {
    const cbor = encodeBody([
      [0, [[Buffer.from(TXID, "hex"), 0]]],
      [1, [[tyUtils.getAddressFromString(PAYEE).getBytes(), 3_000_000]]],
      [2, 170_000],
      [5, new Map([[Buffer.from("e0" + "22".repeat(28), "hex"), 5_000_000]])],
    ]);
    const s = summariseTx(cbor, own.addresses, own.inputs, 0);
    expect(s.withdrawals).toBe(1);
    expect(s.foreignWithdrawals).toBe(0);
  });

  // A reward account whose stake key hash is not this wallet's: the screen
  // must not say "your staking rewards" for it.
  it("counts a withdrawal from someone else's reward account as foreign, and not into net", () => {
    const cbor = encodeBody([
      [0, [[Buffer.from(TXID, "hex"), 0]]],
      [1, [[tyUtils.getAddressFromString(PAYEE).getBytes(), 3_000_000]]],
      [2, 170_000],
      [
        5,
        new Map([
          [Buffer.from("e0" + "99".repeat(28), "hex"), 7_000_000],
          [Buffer.from("e0" + "22".repeat(28), "hex"), 5_000_000],
        ]),
      ],
    ]);
    const s = summariseTx(cbor, own.addresses, own.inputs, 0);
    expect(s.withdrawals).toBe(2);
    expect(s.foreignWithdrawals).toBe(1);
    expect(s.withdrawalLovelace).toBe(BigInt(5_000_000));
  });

  // The 28 bytes after the header are this wallet's stake key hash, but the
  // header says another network (0xe1 on a testnet wallet) or a script
  // credential (0xf0): neither account is this wallet's.
  it.each([
    ["on another network", "e1"],
    ["under a script credential", "f0"],
  ])("counts a withdrawal from an account with this wallet's stake hash %s as foreign", (_label, header) => {
    const ownStake = own.addresses.find((h) => h.length === 114)!.slice(58);
    const cbor = encodeBody([
      [0, [[Buffer.from(TXID, "hex"), 0]]],
      [1, [[tyUtils.getAddressFromString(PAYEE).getBytes(), 3_000_000]]],
      [2, 170_000],
      [5, new Map([[Buffer.from(header + ownStake, "hex"), 5_000_000]])],
    ]);
    const s = summariseTx(cbor, own.addresses, own.inputs, 0);
    expect(s.foreignWithdrawals).toBe(1);
    expect(s.ownRewardKeyHashes).toEqual([]);
    expect(s.withdrawalLovelace).toBe(BigInt(0));
    // The same hash under the right header is this wallet's — the case above
    // is refused for its header, not for its hash.
    const mine = encodeBody([
      [0, [[Buffer.from(TXID, "hex"), 0]]],
      [1, [[tyUtils.getAddressFromString(PAYEE).getBytes(), 3_000_000]]],
      [2, 170_000],
      [5, new Map([[Buffer.from("e0" + ownStake, "hex"), 5_000_000]])],
    ]);
    expect(summariseTx(mine, own.addresses, own.inputs, 0).ownRewardKeyHashes).toEqual([ownStake]);
  });
});

describe("summariseTx — an output to this wallet's key address under a datum is change", () => {
  // The wallet holds 100 ADA. The page takes 4.8 ADA and sends 95 ADA back to
  // the wallet's own key address — under a datum. The ledger ignores a datum on
  // a key-locked input, so the wallet's UTxO reads keep that output and the
  // wallet can spend it: the 95 ADA is change, and the cost is 5 ADA. The datum
  // is still shown (`toSelfWithDatum`). This is the LAMP drip-pot claim's shape.
  const held = new Map([[`${TXID}#0`, { lovelace: BigInt(100_000_000), assets: new Map<string, bigint>() }]]);
  const addresses = [hexOf(MINE), hexOf(MY_CHANGE)];
  const encodeBody = (entries: [number, unknown][]) =>
    Encoder.encode([new Map(entries), new Map(), true, null]).toString("hex");
  const mineBytes = () => tyUtils.getAddressFromString(MINE).getBytes();
  const tx = (back: unknown) =>
    encodeBody([
      [0, [[Buffer.from(TXID, "hex"), 0]]],
      [1, [[tyUtils.getAddressFromString(PAYEE).getBytes(), 4_800_000], back]],
      [2, 200_000],
    ]);
  const backTo = (datum?: unknown, to: Buffer = mineBytes()) =>
    new Map<number, unknown>([
      [0, to],
      [1, 95_000_000],
      ...(datum === undefined ? [] : ([[2, datum]] as [number, unknown][])),
    ]);

  it("control: without a datum the 95 ADA is change, the cost is 5 ADA, and nothing is flagged", () => {
    const s = summariseTx(tx(backTo()), addresses, held, 0);
    expect(s.net).toEqual([{ unit: "", policyId: "", assetNameHex: "", amount: BigInt(5_000_000) }]);
    expect(s.toOthers.map((r) => r.address)).toEqual([PAYEE]);
    expect(s.toSelfWithDatum).toEqual([]);
  });

  const change = (s: ReturnType<typeof summariseTx>) => {
    expect(s.net).toEqual([{ unit: "", policyId: "", assetNameHex: "", amount: BigInt(5_000_000) }]);
    expect(s.toOthers.map((r) => r.address)).toEqual([PAYEE]);
    expect(s.toSelfWithDatum).toEqual([{ address: MINE, lovelace: BigInt(95_000_000), assets: [], mine: true, datum: true }]);
  };

  it("an inline datum: the 95 ADA is change, the cost is 5 ADA, and the datum is flagged", () => {
    change(summariseTx(tx(backTo([1, new CborTag(Buffer.from("d87980", "hex"), 24)])), addresses, held, 0));
  });
  it("a datum hash (Babbage shape): the same", () => {
    change(summariseTx(tx(backTo([0, Buffer.alloc(32, 0xab)])), addresses, held, 0));
  });
  it("a datum hash (legacy shape): the same", () => {
    change(summariseTx(tx([mineBytes(), 95_000_000, Buffer.alloc(32, 0xab)]), addresses, held, 0));
  });

  // The other half of the rule. A script-locked output under a datum is the
  // script's, not the wallet's, even if the caller counts the address as its
  // own: the wallet holds no witness for it and its readers skip it, so here
  // it is money that leaves, listed with the datum flag.
  it("a datum at a script address the caller calls its own: the whole 100 ADA leaves", () => {
    const script = Buffer.from("70" + "44".repeat(28), "hex");
    const scriptBech = tyUtils.getAddressFromHex(script).getBech32();
    const s = summariseTx(tx(backTo([1, new CborTag(Buffer.from("d87980", "hex"), 24)], script)), [...addresses, script.toString("hex")], held, 0);
    expect(s.net).toEqual([{ unit: "", policyId: "", assetNameHex: "", amount: BigInt(100_000_000) }]);
    expect(s.toOthers).toContainEqual({ address: scriptBech, lovelace: BigInt(95_000_000), assets: [], mine: false, datum: true });
    expect(s.toSelfWithDatum).toEqual([]);
  });
});
