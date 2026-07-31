import { describe, it, expect } from "vitest";
import { tailChallenge } from "../ConfirmGate";

describe("tailChallenge — the retype target", () => {
  it("returns the last 4 characters by default", () => {
    expect(tailChallenge("addr1qxy9k7z")).toBe("9k7z");
    expect(tailChallenge("pool1abcdef")).toBe("cdef");
  });

  it("is shorter-safe: a value ≤ n is returned whole", () => {
    expect(tailChallenge("ab")).toBe("ab");
    expect(tailChallenge("abcd")).toBe("abcd");
  });

  it("honours a custom length", () => {
    expect(tailChallenge("drep1qqqqzzzz", 5)).toBe("qzzzz");
  });

  it("trims surrounding whitespace before slicing", () => {
    expect(tailChallenge("  addr1wxyz  ")).toBe("wxyz");
  });

  it("never throws on empty / nullish input", () => {
    expect(tailChallenge("")).toBe("");
    // @ts-expect-error — defensive: real callers pass a string, but undefined must not crash
    expect(tailChallenge(undefined)).toBe("");
  });

  it("the challenge is a strict tail of the source (anti-poisoning invariant)", () => {
    const addr = "addr1q9x8y7z6w5v4u3t2s1r0q";
    const c = tailChallenge(addr);
    expect(addr.endsWith(c)).toBe(true);
    expect(c.length).toBe(4);
  });
});
