import { describe, it, expect } from "vitest";
import { nextAccountIndex, pendingPoolId } from "../delegationFeedback";
import en from "../../../../locales/en/wallet.json";
import vi from "../../../../locales/vi/wallet.json";
import ja from "../../../../locales/ja/wallet.json";
import zh from "../../../../locales/zh/wallet.json";

const POOL_A = "pool1aaaa";
const POOL_B = "pool1bbbb";

describe("pendingPoolId", () => {
  it("is null when nothing was sent from this screen", () => {
    expect(pendingPoolId(null, null)).toBeNull();
    expect(pendingPoolId(null, POOL_A)).toBeNull();
  });

  it("holds the sent pool while the chain still shows no delegation", () => {
    expect(pendingPoolId(POOL_A, null)).toBe(POOL_A);
    expect(pendingPoolId(POOL_A, undefined)).toBe(POOL_A);
  });

  it("holds the sent pool while the chain still shows the previous pool", () => {
    expect(pendingPoolId(POOL_B, POOL_A)).toBe(POOL_B);
  });

  it("clears once the chain shows the pool that was sent", () => {
    expect(pendingPoolId(POOL_A, POOL_A)).toBeNull();
  });
});

describe("nextAccountIndex", () => {
  it("opens the form on the account after the one in use", () => {
    expect(nextAccountIndex(0)).toBe(1);
    expect(nextAccountIndex(7)).toBe(8);
  });

  it("does not step past the last hardened index", () => {
    expect(nextAccountIndex(2 ** 31 - 2)).toBe(2 ** 31 - 1);
    expect(nextAccountIndex(2 ** 31 - 1)).toBe(2 ** 31 - 1);
  });
});

describe("wording", () => {
  const locales = { en, vi, ja, zh } as Record<string, Record<string, string>>;

  it("vote delegation has its own submitted message, distinct from a governance action", () => {
    for (const [lng, l] of Object.entries(locales)) {
      expect(l.gov_delegation_submitted, lng).toContain("{{hash}}");
      expect(l.gov_delegation_submitted, lng).not.toBe(l.gov_submitted);
    }
  });

  it("stake delegation has a pending line that names the pool", () => {
    for (const [lng, l] of Object.entries(locales)) {
      expect(l.stake_delegate_pending, lng).toContain("{{pool}}");
    }
  });

  it("the switch-account help no longer opens by denying a fault", () => {
    expect(en.local_account_switch_help).not.toMatch(/fault/i);
    expect(vi.local_account_switch_help).not.toMatch(/trục trặc/);
    expect(ja.local_account_switch_help).not.toMatch(/異常/);
    expect(zh.local_account_switch_help).not.toMatch(/故障/);
  });
});
