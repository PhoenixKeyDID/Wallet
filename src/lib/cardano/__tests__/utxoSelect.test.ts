import { describe, it, expect } from "vitest";
import BigNumber from "bignumber.js";
import { Buffer } from "buffer";
import { Encoder } from "@stricahq/cbors";
import type { types as tyTypes } from "@stricahq/typhonjs";
import {
  decodeValueHex,
  selectForAmount,
  readPaginate,
  pageOf,
  selectCollateral,
  Cip30ArgumentError,
  COLLATERAL_CAP_LOVELACE,
} from "../utxoSelect";

const POLICY = "ab".repeat(28);
const input = (index: number, ada: number, tokens: [string, string, number][] = []) =>
  ({
    txId: "77".repeat(32),
    index,
    amount: new BigNumber(ada * 1_000_000),
    tokens: tokens.map(([policyId, assetName, amount]) => ({ policyId, assetName, amount: new BigNumber(amount) })),
    address: {} as tyTypes.ShelleyAddress,
  }) as unknown as tyTypes.Input;

describe("decodeValueHex", () => {
  it("reads a bare coin and a coin with assets", () => {
    expect(decodeValueHex(Encoder.encode(BigInt(2_000_000)).toString("hex")).lovelace).toBe(BigInt(2_000_000));
    const v = Encoder.encode([
      BigInt(1),
      new Map([[Buffer.from(POLICY, "hex"), new Map([[Buffer.from("4c414d50", "hex"), BigInt(7)]])]]),
    ]).toString("hex");
    expect(decodeValueHex(v).assets.get(POLICY + "4c414d50")).toBe(BigInt(7));
  });
  it("throws a Cip30ArgumentError on anything else", () => {
    for (const bad of ["", "zz", "abc", 5, Encoder.encode("text").toString("hex"), Encoder.encode(-1).toString("hex")]) {
      expect(() => decodeValueHex(bad)).toThrow(Cip30ArgumentError);
    }
  });
});

describe("selectForAmount", () => {
  const coins = [input(0, 2), input(1, 10), input(2, 3, [[POLICY, "4c414d50", 5]])];
  it("covers lovelace from the largest coin first", () => {
    expect(selectForAmount(coins, { lovelace: BigInt(9_000_000), assets: new Map() })!.map((i) => i.index)).toEqual([1]);
  });
  it("covers an asset from the coin holding it, then tops up lovelace", () => {
    const got = selectForAmount(coins, { lovelace: BigInt(12_000_000), assets: new Map([[POLICY + "4c414d50", BigInt(5)]]) });
    expect(got!.map((i) => i.index).sort()).toEqual([1, 2]);
  });
  it("answers null when the whole wallet falls short, in lovelace or in an asset", () => {
    expect(selectForAmount(coins, { lovelace: BigInt(16_000_000), assets: new Map() })).toBeNull();
    expect(selectForAmount(coins, { lovelace: BigInt(1), assets: new Map([[POLICY + "4c414d50", BigInt(6)]]) })).toBeNull();
  });
});

describe("paginate", () => {
  it("pages, and a page past the end gives maxSize = number of pages", () => {
    const list = [1, 2, 3, 4, 5];
    expect(pageOf(list, { page: 0, limit: 2 })).toEqual({ page: [1, 2] });
    expect(pageOf(list, { page: 2, limit: 2 })).toEqual({ page: [5] });
    expect(pageOf(list, { page: 3, limit: 2 })).toEqual({ maxSize: 3 });
    expect(pageOf([], { page: 0, limit: 2 })).toEqual({ page: [] });
    expect(pageOf([], { page: 1, limit: 2 })).toEqual({ maxSize: 0 });
  });
  it("refuses a paginate that is not one", () => {
    for (const bad of [null, 3, { page: 0 }, { page: -1, limit: 1 }, { page: 0, limit: 0 }, { page: 1.5, limit: 2 }]) {
      expect(() => readPaginate(bad)).toThrow(Cip30ArgumentError);
    }
  });
});

describe("selectCollateral", () => {
  it("prefers the single smallest pure-ADA coin that reaches the target", () => {
    const got = selectCollateral([input(0, 20), input(1, 6), input(2, 5, [[POLICY, "", 1]])], COLLATERAL_CAP_LOVELACE);
    expect(got!.map((i) => i.index)).toEqual([1]);
  });
  it("never offers a coin carrying tokens", () => {
    expect(selectCollateral([input(0, 50, [[POLICY, "", 1]])], COLLATERAL_CAP_LOVELACE)).toBeNull();
  });
  it("combines at most three coins, else null", () => {
    expect(selectCollateral([input(0, 2), input(1, 2), input(2, 2)], COLLATERAL_CAP_LOVELACE)!.length).toBe(3);
    expect(selectCollateral([input(0, 1), input(1, 1), input(2, 1), input(3, 1), input(4, 1)], COLLATERAL_CAP_LOVELACE)).toBeNull();
  });
});
