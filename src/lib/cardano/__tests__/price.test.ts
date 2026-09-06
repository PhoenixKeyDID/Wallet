/**
 * The fiat line — and the refusals that keep it from lying.
 *
 * The figures below are a real reading taken from the price service on
 * 2026-09-06 (`{"cardano":{"usd":0.217973,"vnd":5680.07,"eur":0.187681,
 * "jpy":34.13}}`), so the fixtures have the shape and the magnitude the service
 * actually returns — including that one ADA is a fraction of a dollar and
 * several thousand đồng, which is the spread that makes a hard-coded two
 * decimal places wrong.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readPrice, formatFiat, forgetPrice, PriceError, type AdaPrice } from "../price";

const AT = 1_788_710_000_000;
const BODY = { cardano: { usd: 0.217973, vnd: 5680.07, eur: 0.187681, jpy: 34.13 } };

beforeEach(() => forgetPrice());

describe("readPrice — a wrong number about your own money is worse than none", () => {
  it("reads the rate for the currency asked for", () => {
    expect(readPrice(BODY, "usd", AT)).toEqual({ currency: "usd", rate: 0.217973, atMs: AT });
    expect(readPrice(BODY, "vnd", AT).rate).toBe(5680.07);
  });

  /**
   * The shape that matters: an answer arrives, parses, and contains nothing for
   * the currency asked. Coercing that to zero would print a balance of $0.00
   * over a wallet holding money.
   */
  it("refuses an answer that has no figure for the currency", () => {
    expect(() => readPrice({ cardano: {} }, "usd", AT)).toThrow(PriceError);
    expect(() => readPrice({ cardano: { usd: null } }, "usd", AT)).toThrow(PriceError);
    expect(() => readPrice({}, "usd", AT)).toThrow(PriceError);
    expect(() => readPrice(null, "usd", AT)).toThrow(PriceError);
  });

  it("refuses a rate that is not a plausible number", () => {
    expect(() => readPrice({ cardano: { usd: 0 } }, "usd", AT)).toThrow(PriceError);
    expect(() => readPrice({ cardano: { usd: -1 } }, "usd", AT)).toThrow(PriceError);
    expect(() => readPrice({ cardano: { usd: Number.NaN } }, "usd", AT)).toThrow(PriceError);
    expect(() => readPrice({ cardano: { usd: 1e12 } }, "usd", AT)).toThrow(PriceError);
    expect(() => readPrice({ cardano: { usd: "0.21" } }, "usd", AT)).toThrow(PriceError);
  });

  it("carries the moment it was read, because a rate is a reading and not a quote", () => {
    expect(readPrice(BODY, "eur", AT).atMs).toBe(AT);
  });
});

describe("formatFiat", () => {
  const usd: AdaPrice = { currency: "usd", rate: 0.217973, atMs: AT };
  const vnd: AdaPrice = { currency: "vnd", rate: 5680.07, atMs: AT };

  it("converts lovelace, not ADA", () => {
    // 100 ADA = 100_000_000 lovelace. Reading the lovelace figure as ADA would
    // overstate every balance by a million.
    expect(formatFiat(BigInt(100_000_000), usd, "en-US")).toBe("$21.80");
  });

  /**
   * The đồng has no minor unit and the dollar has two. Hard-coding two decimals
   * would print a figure no Vietnamese reader writes.
   *
   * The assertion looks for the minor unit *before the symbol*, not at the end
   * of the string: `vi-VN` writes the symbol last (`568.007 ₫`), so an
   * end-anchored check passes whether or not the decimals are there — which is
   * how the first version of this test sat green over a deliberately broken
   * `formatFiat`.
   */
  it("uses the currency's own precision", () => {
    const dong = formatFiat(BigInt(100_000_000), vnd, "vi-VN");
    expect(dong).toContain("₫");
    expect(dong).not.toMatch(/[.,]\d{2}\s*₫/);
    // And the other direction, so the test pins a precision rather than an
    // absence: the dollar keeps its two.
    expect(formatFiat(BigInt(100_000_000), usd, "en-US")).toMatch(/\.\d{2}$/);
  });

  it("shows nothing owed on an empty wallet rather than a missing line", () => {
    expect(formatFiat(BigInt(0), usd, "en-US")).toBe("$0.00");
  });
});
