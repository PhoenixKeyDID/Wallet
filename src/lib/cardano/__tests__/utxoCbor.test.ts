/**
 * `getUtxos` / `getBalance` as a dApp reads them: CBOR it can decode back to
 * exactly the inputs this wallet holds — and a loud refusal, never a rounded
 * number, when the indexer handed over something that is not a ledger value.
 */
import { describe, it, expect } from "vitest";
import { Buffer } from "buffer";
import BigNumber from "bignumber.js";
import { Decoder } from "@stricahq/cbors";
import { utils as tyUtils, types as tyTypes } from "@stricahq/typhonjs";
import { encodeBalanceHex, encodeInputsAsUtxosHex } from "../utxoCbor";
import { decodeUtxosToInputs } from "../tx";
import { baseAddress } from "../address";

const ADDR = tyUtils.getAddressFromString(
  baseAddress("ab".repeat(28), "cd".repeat(28), 0),
) as tyTypes.ShelleyAddress;
const POLICY = "11".repeat(28);
const OTHER_POLICY = "22".repeat(28);
const NAME = Buffer.from("LAMP", "utf8").toString("hex");

const input = (txByte: string, index: number, lovelace: string, tokens: tyTypes.Token[] = []): tyTypes.Input => ({
  txId: txByte.repeat(32),
  index,
  amount: new BigNumber(lovelace),
  tokens,
  address: ADDR,
});
const token = (policyId: string, assetName: string, amount: string): tyTypes.Token => ({
  policyId,
  assetName,
  amount: new BigNumber(amount),
});

describe("encodeInputsAsUtxosHex", () => {
  it("round-trips through the CIP-30 decoder: same refs, address, ADA and tokens", () => {
    const inputs = [
      input("aa", 0, "2000000"),
      input("bb", 3, "1500000", [token(POLICY, NAME, "7"), token(OTHER_POLICY, "", "1")]),
    ];
    const back = decodeUtxosToInputs(encodeInputsAsUtxosHex(inputs));
    expect(back.map((i) => `${i.txId}#${i.index}`)).toEqual([`${"aa".repeat(32)}#0`, `${"bb".repeat(32)}#3`]);
    expect(back.map((i) => i.amount.toFixed(0))).toEqual(["2000000", "1500000"]);
    expect(back[1]!.tokens.map((t) => [t.policyId, t.assetName, t.amount.toFixed(0)])).toEqual([
      [POLICY, NAME, "7"],
      [OTHER_POLICY, "", "1"],
    ]);
    expect(back.every((i) => i.address.getHex() === ADDR.getHex())).toBe(true);
  });

  it("an ADA-only UTxO carries a bare coin, not `[coin, {}]`", () => {
    const [hex] = encodeInputsAsUtxosHex([input("aa", 0, "2000000")]);
    const [, output] = Decoder.decode(Buffer.from(hex!, "hex")).value as [unknown, [Buffer, unknown]];
    expect(typeof output[1] === "number" || typeof output[1] === "bigint").toBe(true);
  });

  it("an empty wallet is an empty list — the read itself failing is a different path", () => {
    expect(encodeInputsAsUtxosHex([])).toEqual([]);
  });

  it.each([
    ["fractional ADA", input("aa", 0, "1.5")],
    ["zero ADA", input("aa", 0, "0")],
    ["a short policy id", input("aa", 0, "2000000", [token("11", NAME, "1")])],
    ["a fractional token amount", input("aa", 0, "2000000", [token(POLICY, NAME, "0.4")])],
    ["a zero token amount", input("aa", 0, "2000000", [token(POLICY, NAME, "0")])],
    ["a non-hex asset name", input("aa", 0, "2000000", [token(POLICY, "LAMP", "1")])],
    ["a short tx id", { ...input("aa", 0, "2000000"), txId: "aa" }],
  ])("refuses %s rather than encoding a UTxO the ledger does not have", (_why, bad) => {
    expect(() => encodeInputsAsUtxosHex([bad])).toThrow(/malformed/);
  });
});

describe("encodeBalanceHex", () => {
  it("sums ADA and every token across the same inputs", () => {
    const hex = encodeBalanceHex([
      input("aa", 0, "2000000", [token(POLICY, NAME, "5")]),
      input("bb", 1, "3000000", [token(POLICY, NAME, "2"), token(OTHER_POLICY, "", "1")]),
    ]);
    const [coin, multi] = Decoder.decode(Buffer.from(hex, "hex")).value as [
      unknown,
      Map<Buffer, Map<Buffer, unknown>>,
    ];
    expect(String(coin)).toBe("5000000");
    const flat = [...multi].flatMap(([p, names]) =>
      [...names].map(([n, q]) => [Buffer.from(p).toString("hex"), Buffer.from(n).toString("hex"), String(q)]),
    );
    expect(flat).toEqual([
      [POLICY, NAME, "7"],
      [OTHER_POLICY, "", "1"],
    ]);
  });

  it("an ADA-only balance is a bare coin", () => {
    const v = Decoder.decode(Buffer.from(encodeBalanceHex([input("aa", 0, "4000000")]), "hex")).value;
    expect(String(v)).toBe("4000000");
  });
});
