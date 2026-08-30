import { describe, it, expect } from "vitest";
import { parseWatchAddress } from "../watchAddress";

/**
 * Watch-only by a single address (Wallet#6). The check that earns its place is
 * the network one: a mainnet address watched on preprod does not error — the
 * indexer answers, successfully, with 0 ADA. To the person looking at it that
 * reads as "my money is gone", which is the worst possible way to be wrong.
 */
const MAINNET =
  "addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x";
const TESTNET =
  "addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp";

describe("parseWatchAddress", () => {
  it("accepts a mainnet address on mainnet and returns it normalised", () => {
    expect(parseWatchAddress(MAINNET, 1)).toBe(MAINNET);
  });

  it("accepts a testnet address on preprod and on preview", () => {
    expect(parseWatchAddress(TESTNET, 0)).toBe(TESTNET);
    expect(parseWatchAddress(TESTNET, 2)).toBe(TESTNET);
  });

  it("trims surrounding whitespace from a pasted address", () => {
    expect(parseWatchAddress(`  ${MAINNET}\n`, 1)).toBe(MAINNET);
  });

  it("REJECTS a mainnet address watched on a testnet — the 0-ADA trap", () => {
    expect(() => parseWatchAddress(MAINNET, 0)).toThrow("addr_wrong_network");
    expect(() => parseWatchAddress(MAINNET, 2)).toThrow("addr_wrong_network");
  });

  it("REJECTS a testnet address watched on mainnet", () => {
    expect(() => parseWatchAddress(TESTNET, 1)).toThrow("addr_wrong_network");
  });

  it("rejects an empty input with its own reason", () => {
    expect(() => parseWatchAddress("   ", 1)).toThrow("watch_addr_required");
  });

  it("rejects something that is not an address", () => {
    expect(() => parseWatchAddress("not-an-address", 1)).toThrow("watch_addr_invalid");
    expect(() => parseWatchAddress("acct_xvk1abc", 1)).toThrow("watch_addr_invalid");
  });

  it("rejects a stake address — it holds no UTxO, so watching it shows a false 0", () => {
    expect(() =>
      parseWatchAddress("stake1uyehkck0lajq8gr28t9uxnuvgcqrc6070x3k9r8048z8y5gh6ffgw", 1),
    ).toThrow("watch_addr_is_stake");
  });
});
