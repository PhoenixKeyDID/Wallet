import { describe, it, expect } from "vitest";
import { Buffer } from "buffer";
import BigNumber from "bignumber.js";
import { Encoder } from "@stricahq/cbors";
import { decodeValue, assetQuantity } from "../cip30";
import { decodeUtxosToInputs, decodeVkeyWitnesses } from "../tx";

const LAMP_POLICY = "ab".repeat(28);
const LAMP_NAME = "4c414d50"; // "LAMP"

function encodeValue(coin: number | string, assets: Array<[string, string, string]> = []): string {
  if (assets.length === 0) return Encoder.encode(new BigNumber(coin)).toString("hex");
  const byPolicy = new Map<Buffer, Map<Buffer, BigNumber>>();
  for (const [policy, name, qty] of assets) {
    const p = Buffer.from(policy, "hex");
    const inner = byPolicy.get(p) ?? new Map<Buffer, BigNumber>();
    inner.set(Buffer.from(name, "hex"), new BigNumber(qty));
    byPolicy.set(p, inner);
  }
  return Encoder.encode([new BigNumber(coin), byPolicy]).toString("hex");
}

describe("decodeValue (CIP-30 getBalance)", () => {
  it("bare coin → lovelace only", () => {
    const v = decodeValue(encodeValue(2_000_000));
    expect(v.lovelace).toBe(BigInt("2000000"));
    expect(v.assets).toHaveLength(0);
  });

  it("coin + multiasset → tokens parsed", () => {
    const v = decodeValue(encodeValue(3_500_000, [[LAMP_POLICY, LAMP_NAME, "500"]]));
    expect(v.lovelace).toBe(BigInt("3500000"));
    expect(v.assets).toHaveLength(1);
    expect(v.assets[0].policyId).toBe(LAMP_POLICY);
    expect(v.assets[0].assetNameHex).toBe(LAMP_NAME);
    expect(v.assets[0].quantity).toBe(BigInt("500"));
    expect(assetQuantity(v, LAMP_POLICY, LAMP_NAME)).toBe(BigInt("500"));
    expect(assetQuantity(v, LAMP_POLICY, "deadbeef")).toBe(BigInt("0"));
  });

  it("handles amounts above 2^53 without precision loss", () => {
    const big = "45000000000000000"; // 45 quadrillion lovelace
    const v = decodeValue(encodeValue(big));
    expect(v.lovelace).toBe(BigInt("45000000000000000"));
  });
});

describe("decodeUtxosToInputs", () => {
  it("decodes a legacy-array UTxO (address + coin)", () => {
    // a minimal testnet enterprise address (header 0x60 + 28-byte key hash)
    const addr = Buffer.concat([Buffer.from([0x60]), Buffer.alloc(28, 0x22)]);
    const txId = Buffer.alloc(32, 0x01);
    const utxo = [
      [txId, 0],
      [addr, new BigNumber(5_000_000)],
    ];
    const hex = Encoder.encode(utxo).toString("hex");
    const inputs = decodeUtxosToInputs([hex]);
    expect(inputs).toHaveLength(1);
    expect(inputs[0].txId).toBe("01".repeat(32));
    expect(inputs[0].index).toBe(0);
    expect(inputs[0].amount.toString()).toBe("5000000");
    expect(inputs[0].tokens).toHaveLength(0);
    expect(inputs[0].address.getBech32()).toMatch(/^addr_test1[0-9a-z]+$/);
  });
});

describe("decodeVkeyWitnesses", () => {
  it("extracts [pubkey, sig] pairs from a witness set (map key 0)", () => {
    const pub = Buffer.alloc(32, 0xaa);
    const sig = Buffer.alloc(64, 0xbb);
    const witnessSet = new Map<number, Array<[Buffer, Buffer]>>([[0, [[pub, sig]]]]);
    const hex = Encoder.encode(witnessSet).toString("hex");
    const ws = decodeVkeyWitnesses(hex);
    expect(ws).toHaveLength(1);
    expect(ws[0].publicKey.toString("hex")).toBe("aa".repeat(32));
    expect(ws[0].signature.toString("hex")).toBe("bb".repeat(64));
  });
  it("returns empty for a witness set with no vkey witnesses", () => {
    const hex = Encoder.encode(new Map()).toString("hex");
    expect(decodeVkeyWitnesses(hex)).toHaveLength(0);
  });
});
