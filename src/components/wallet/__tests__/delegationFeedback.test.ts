import { describe, it, expect, vi as vitest } from "vitest";
import {
  DELEGATION_UNSEEN_MS,
  DELEGATION_WATCH_LIMIT_MS,
  VOTE_DELEGATION_TTL_SLOTS,
  VOTE_DELEGATION_WATCH_LIMIT_MS,
  clockTime,
  delegationWatch,
  lookUpVoteTx,
  nextAccountIndex,
  voteDelegationLanded,
  voteDelegationExpiresAt,
  voteDelegationPending,
  voteDelegationWatch,
  type SentDelegation,
  type SentVoteDelegation,
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

describe("voteDelegationWatch", () => {
  const vote: SentVoteDelegation = { account: ACCOUNT, network: 2, sentAt: T0, txHash: "aa".repeat(32) };

  it("is none when nothing was sent, or under another account or network", () => {
    expect(voteDelegationWatch(null, ACCOUNT, 2, T0)).toEqual({ kind: "none" });
    expect(voteDelegationWatch(vote, OTHER, 2, T0)).toEqual({ kind: "none" });
    expect(voteDelegationWatch(vote, null, 2, T0)).toEqual({ kind: "none" });
    expect(voteDelegationWatch(vote, ACCOUNT, 0, T0)).toEqual({ kind: "none" });
  });

  it("is pending up to the unseen limit, then unseen", () => {
    expect(voteDelegationWatch(vote, ACCOUNT, 2, T0 + DELEGATION_UNSEEN_MS)).toEqual({ kind: "pending" });
    expect(voteDelegationWatch(vote, ACCOUNT, 2, T0 + DELEGATION_UNSEEN_MS + 1)).toEqual({ kind: "unseen" });
  });

  it("lets go when the transaction's validity window closes, not an hour later", () => {
    // `ttl = tip + VOTE_DELEGATION_TTL_SLOTS`, one slot per second.
    expect(VOTE_DELEGATION_WATCH_LIMIT_MS).toBe(VOTE_DELEGATION_TTL_SLOTS * 1000);
    expect(VOTE_DELEGATION_TTL_SLOTS).toBe(7200);
    expect(VOTE_DELEGATION_WATCH_LIMIT_MS).toBeLessThan(DELEGATION_WATCH_LIMIT_MS);
    expect(voteDelegationWatch(vote, ACCOUNT, 2, T0 + VOTE_DELEGATION_WATCH_LIMIT_MS - 1)).toEqual({ kind: "unseen" });
    expect(voteDelegationWatch(vote, ACCOUNT, 2, T0 + VOTE_DELEGATION_WATCH_LIMIT_MS)).toEqual({ kind: "none" });
    expect(voteDelegationPending(vote, ACCOUNT, 2, T0 + VOTE_DELEGATION_WATCH_LIMIT_MS)).toBe(false);
    expect(voteDelegationPending(vote, ACCOUNT, 2, T0 + DELEGATION_UNSEEN_MS + 1)).toBe(true);
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

  it("vote delegation has a pending line and an unseen line that name no choice", () => {
    for (const [lng, l] of Object.entries(locales)) {
      expect(l.vote_delegation_pending, lng).toBeTruthy();
      expect(l.vote_delegation_unseen, lng).toBeTruthy();
      expect(l.vote_delegation_unseen, lng).not.toBe(l.vote_delegation_pending);
      // The same line follows an Abstain, a DRep and No Confidence alike.
      expect(l.vote_delegation_pending, lng).not.toContain(l.gov_abstain);
      expect(l.vote_delegation_unseen, lng).not.toContain(l.gov_abstain);
    }
  });

  it("the vote-delegation lines carry the clock time they name", () => {
    for (const [lng, l] of Object.entries(locales)) {
      expect(l.vote_delegation_unseen, lng).toContain("{{time}}");
      expect(l.vote_delegation_expired, lng).toContain("{{time}}");
      expect(l.gov_delegate_inflight_warn, lng).toContain("{{time}}");
      // The plain waiting line promises nothing about the Withdraw button.
      expect(l.vote_delegation_pending, lng).toContain(l.withdraw_rewards);
      expect(l.vote_delegation_pending_plain, lng).not.toContain(l.withdraw_rewards);
    }
  });

  it("user-facing text writes DRep, never dRep", () => {
    for (const [lng, l] of Object.entries(locales)) {
      for (const [k, v] of Object.entries(l)) expect(v, `${lng}.${k}`).not.toContain("dRep");
    }
  });

  it("the switch-account help no longer opens by denying a fault", () => {
    expect(en.local_account_switch_help).not.toMatch(/fault/i);
    expect(vi.local_account_switch_help).not.toMatch(/trục trặc/);
    expect(ja.local_account_switch_help).not.toMatch(/異常/);
    expect(zh.local_account_switch_help).not.toMatch(/故障/);
  });
});

describe("lookUpVoteTx — the transaction itself, found in a block", () => {
  const TX = "ab".repeat(32);
  const vote: SentVoteDelegation = { account: ACCOUNT, network: 2, sentAt: T0, txHash: TX };
  const flush = () => new Promise((r) => setTimeout(r, 0));

  const onChain = async () => true;

  it("reports the hash once the look-up says it is in a block and the re-read shows a vote delegation", async () => {
    const lookUp = vitest.fn(async () => true);
    const confirm = vitest.fn(async () => true);
    const onLanded = vitest.fn();
    lookUpVoteTx(vote, lookUp, confirm, onLanded);
    await flush();
    expect(lookUp).toHaveBeenCalledWith(2, TX);
    expect(confirm).toHaveBeenCalledWith(vote);
    expect(onLanded).toHaveBeenCalledWith(TX);
  });

  it("does nothing on 'not yet', on a failed look-up, or after release", async () => {
    const onLanded = vitest.fn();
    lookUpVoteTx(vote, async () => false, onChain, onLanded);
    lookUpVoteTx(vote, async () => Promise.reject(new Error("koios down")), onChain, onLanded);
    const release = lookUpVoteTx(vote, async () => true, onChain, onLanded);
    release();
    lookUpVoteTx(null, async () => true, onChain, onLanded);
    await flush();
    expect(onLanded).not.toHaveBeenCalled();
  });

  it("in a block but the account re-read still shows none, or fails: keeps waiting", async () => {
    const onLanded = vitest.fn();
    lookUpVoteTx(vote, async () => true, async () => false, onLanded);
    lookUpVoteTx(vote, async () => true, async () => Promise.reject(new Error("koios down")), onLanded);
    await flush();
    expect(onLanded).not.toHaveBeenCalled();
  });

  it("does not re-read the account when the transaction is not in a block", async () => {
    const confirm = vitest.fn(async () => true);
    lookUpVoteTx(vote, async () => false, confirm, vitest.fn());
    await flush();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("the DRep-change signal stays secondary: equal or unread says nothing", () => {
    expect(voteDelegationLanded({ ...vote, drepBefore: "drep1x" }, "drep1x")).toBe(false);
    expect(voteDelegationLanded({ ...vote }, "drep1x")).toBe(false);
    expect(voteDelegationLanded({ ...vote, drepBefore: null }, "drep1x")).toBe(true);
  });
});

describe("clock time of a vote delegation", () => {
  it("formats local HH:MM, zero-padded", () => {
    expect(clockTime(new Date(2026, 10, 13, 7, 5).getTime())).toBe("07:05");
    expect(clockTime(new Date(2026, 10, 13, 23, 59).getTime())).toBe("23:59");
  });

  it("expires at sentAt plus the watch limit", () => {
    const sent: SentVoteDelegation = { account: ACCOUNT, network: 0, sentAt: T0, txHash: "ab".repeat(32) };
    expect(voteDelegationExpiresAt(sent)).toBe(T0 + VOTE_DELEGATION_WATCH_LIMIT_MS);
  });
});
