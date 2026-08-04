import { describe, it, expect } from "vitest";
import { tailChallenge, allChallengesMet } from "../ConfirmGate";

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

describe("allChallengesMet — every destination must be confirmed", () => {
  it("accepts a single correct answer", () => {
    expect(allChallengesMet(["9k7z"], ["9k7z"])).toBe(true);
  });

  it("rejects a single wrong answer", () => {
    expect(allChallengesMet(["9k7z"], ["9k7x"])).toBe(false);
  });

  it("REJECTS when only the first of several is answered", () => {
    // The Wallet#7 gap: a multi-recipient send used to gate recipient #1 only,
    // so a poisoned recipient #2 was never looked at.
    expect(allChallengesMet(["aaaa", "bbbb"], ["aaaa", ""])).toBe(false);
    expect(allChallengesMet(["aaaa", "bbbb"], ["aaaa"])).toBe(false);
    expect(allChallengesMet(["aaaa", "bbbb", "cccc"], ["aaaa", "bbbb", "xxxx"])).toBe(false);
  });

  it("accepts only when every answer is correct", () => {
    expect(allChallengesMet(["aaaa", "bbbb", "cccc"], ["aaaa", "bbbb", "cccc"])).toBe(true);
  });

  it("is order-sensitive — right tails in the wrong slots do not pass", () => {
    expect(allChallengesMet(["aaaa", "bbbb"], ["bbbb", "aaaa"])).toBe(false);
  });

  it("ignores case and surrounding whitespace, as the input does", () => {
    expect(allChallengesMet(["9K7Z", "AbCd"], [" 9k7z ", "abcd"])).toBe(true);
  });

  it("never passes on an empty challenge set", () => {
    expect(allChallengesMet([], [])).toBe(false);
  });

  it("never passes an unanswerable blank challenge", () => {
    // A blank challenge cannot be typed, so treating it as satisfied would
    // silently unlock the confirm button for a destination nobody checked.
    expect(allChallengesMet(["aaaa", ""], ["aaaa", ""])).toBe(false);
    expect(allChallengesMet(["   "], ["   "])).toBe(false);
  });
});
