import { describe, it, expect } from "vitest";
import {
  DELEGATION_UNSEEN_MS,
  delegationWatch,
  nextAccountIndex,
  type SentDelegation,
} from "../delegationFeedback";
import en from "../../../../locales/en/wallet.json";
import vi from "../../../../locales/vi/wallet.json";
import ja from "../../../../locales/ja/wallet.json";
import zh from "../../../../locales/zh/wallet.json";

const POOL_A = "pool1aaaa";
const POOL_B = "pool1bbbb";
const ACCOUNT = "stake_test1uqaccount";
const OTHER = "stake_test1uqother";
const T0 = 1_700_000_000_000;
const sent: SentDelegation = { poolId: POOL_A, account: ACCOUNT, network: 2, sentAt: T0 };

describe("delegationWatch", () => {
  it("is none when nothing was sent", () => {
    expect(delegationWatch(null, ACCOUNT, 2, null, T0)).toEqual({ kind: "none" });
  });

  it("is none under another account or another network", () => {
    expect(delegationWatch(sent, OTHER, 2, null, T0)).toEqual({ kind: "none" });
    expect(delegationWatch(sent, null, 2, null, T0)).toEqual({ kind: "none" });
    expect(delegationWatch(sent, ACCOUNT, 0, null, T0)).toEqual({ kind: "none" });
  });

  it("is pending while the chain shows no delegation or the previous pool", () => {
    expect(delegationWatch(sent, ACCOUNT, 2, null, T0)).toEqual({ kind: "pending", poolId: POOL_A });
    expect(delegationWatch(sent, ACCOUNT, 2, undefined, T0 + 1000)).toEqual({ kind: "pending", poolId: POOL_A });
    expect(delegationWatch(sent, ACCOUNT, 2, POOL_B, T0 + 1000)).toEqual({ kind: "pending", poolId: POOL_A });
  });

  it("is settled once the chain shows the pool that was sent, however late", () => {
    expect(delegationWatch(sent, ACCOUNT, 2, POOL_A, T0)).toEqual({ kind: "settled" });
    expect(delegationWatch(sent, ACCOUNT, 2, POOL_A, T0 + 3 * DELEGATION_UNSEEN_MS)).toEqual({ kind: "settled" });
  });

  it("stops saying pending after the unseen limit", () => {
    expect(delegationWatch(sent, ACCOUNT, 2, null, T0 + DELEGATION_UNSEEN_MS)).toEqual({ kind: "pending", poolId: POOL_A });
    expect(delegationWatch(sent, ACCOUNT, 2, null, T0 + DELEGATION_UNSEEN_MS + 1)).toEqual({ kind: "unseen", poolId: POOL_A });
    expect(DELEGATION_UNSEEN_MS).toBe(10 * 60_000);
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

  it("stake delegation has a pending line and an unseen line, both naming the pool", () => {
    for (const [lng, l] of Object.entries(locales)) {
      expect(l.stake_delegate_pending, lng).toContain("{{pool}}");
      expect(l.stake_delegate_unseen, lng).toContain("{{pool}}");
      expect(l.stake_delegate_unseen, lng).not.toBe(l.stake_delegate_pending);
    }
  });

  it("the switch-account help no longer opens by denying a fault", () => {
    expect(en.local_account_switch_help).not.toMatch(/fault/i);
    expect(vi.local_account_switch_help).not.toMatch(/trục trặc/);
    expect(ja.local_account_switch_help).not.toMatch(/異常/);
    expect(zh.local_account_switch_help).not.toMatch(/故障/);
  });
});
