import { describe, it, expect, vi as vitest } from "vitest";
import {
  DELEGATION_UNSEEN_MS,
  DELEGATION_WATCH_LIMIT_MS,
  VOTE_DELEGATION_TTL_SLOTS,
  VOTE_DELEGATION_WATCH_LIMIT_MS,
  WITHDRAWAL_WATCH_LIMIT_MS,
  clockTime,
  delegationWatch,
  lookUpVoteTx,
  nextAccountIndex,
  voteDelegationConfirmed,
  voteDelegationLanded,
  voteDelegationExpiresAt,
  voteDelegationPending,
  voteDelegationWatch,
  withdrawalTxAnswered,
  withdrawalWatch,
  type SentDelegation,
  type SentVoteDelegation,
  type SentWithdrawal,
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

/**
 * Round 4: the chain must show the TARGET that was sent, not just any vote
 * delegation. `/tx_status` and `/account_info` can be answered by Koios
 * instances that lag each other, so right after the transaction is seen the
 * account can still read the DRep held before — non-null, and wrong.
 */
describe("voteDelegationConfirmed — the sent target, not any vote delegation", () => {
  const OLD = "drep1old";
  const NEW = "drep1new";
  const base: SentVoteDelegation = { account: ACCOUNT, network: 2, sentAt: T0, txHash: "ab".repeat(32) };

  it("X → Y: the old DRep X does not confirm; Y does", () => {
    const sent = { ...base, drepBefore: OLD, target: NEW };
    expect(voteDelegationConfirmed(sent, OLD)).toBe(false);
    expect(voteDelegationConfirmed(sent, NEW)).toBe(true);
    expect(voteDelegationConfirmed(sent, null)).toBe(false);
    expect(voteDelegationConfirmed(sent, undefined)).toBe(false);
  });

  it("X → X: the target read back confirms (the hash look-up said it is in a block)", () => {
    expect(voteDelegationConfirmed({ ...base, drepBefore: OLD, target: OLD }, OLD)).toBe(true);
  });

  it("Abstain: only drep_always_abstain confirms, not No Confidence or a DRep", () => {
    const sent = { ...base, drepBefore: null, target: "drep_always_abstain" };
    expect(voteDelegationConfirmed(sent, "drep_always_abstain")).toBe(true);
    expect(voteDelegationConfirmed(sent, "drep_always_no_confidence")).toBe(false);
    expect(voteDelegationConfirmed(sent, OLD)).toBe(false);
  });

  it("one DRep written as hex in two cases is the same DRep", () => {
    const hex = "ab".repeat(28);
    expect(voteDelegationConfirmed({ ...base, target: hex }, hex.toUpperCase())).toBe(true);
  });

  it("a record from before `target` existed: differs from the DRep before, or never", () => {
    expect(voteDelegationConfirmed({ ...base, drepBefore: OLD }, OLD)).toBe(false);
    expect(voteDelegationConfirmed({ ...base, drepBefore: OLD }, NEW)).toBe(true);
    expect(voteDelegationConfirmed({ ...base, drepBefore: null }, NEW)).toBe(true);
    // DRep before never read: no read can tell old from new; the record waits
    // out its watch limit instead of ending on a stale answer.
    expect(voteDelegationConfirmed({ ...base }, NEW)).toBe(false);
  });

  it("the DRep-change signal on the Governance tab needs the target, and a change", () => {
    expect(voteDelegationLanded({ ...base, drepBefore: OLD, target: NEW }, NEW)).toBe(true);
    expect(voteDelegationLanded({ ...base, drepBefore: OLD, target: NEW }, "drep1third")).toBe(false);
    expect(voteDelegationLanded({ ...base, drepBefore: OLD, target: OLD }, OLD)).toBe(false);
    expect(voteDelegationLanded({ ...base, target: NEW }, NEW)).toBe(false);
    expect(voteDelegationLanded({ ...base, drepBefore: null, target: NEW }, NEW)).toBe(true);
  });

  it("#66: a send-back (X → Y landed, then X) is never ended by a read showing X", () => {
    // A Koios instance that has not applied X → Y still answers X: a read
    // cannot tell that from X landed. The hash look-up decides instead.
    expect(voteDelegationLanded({ ...base, drepBefore: NEW, target: OLD, resend: true }, OLD)).toBe(false);
    // Control: the same record not marked as a send-back is ended by that read.
    expect(voteDelegationLanded({ ...base, drepBefore: NEW, target: OLD }, OLD)).toBe(true);
    // The hash path still confirms it once the read shows the target.
    expect(voteDelegationConfirmed({ ...base, drepBefore: NEW, target: OLD, resend: true }, OLD)).toBe(true);
  });

  it("lookUpVoteTx tells the tab once the look-up has answered, whatever the answer", async () => {
    const flush = () => new Promise((r) => setTimeout(r, 0));
    const settled = vitest.fn();
    lookUpVoteTx(base, async () => false, async () => true, vitest.fn(), settled);
    lookUpVoteTx(base, async () => Promise.reject(new Error("down")), async () => true, vitest.fn(), settled);
    const landed = vitest.fn();
    lookUpVoteTx(base, async () => true, async () => true, landed, settled);
    lookUpVoteTx(base, async () => true, async () => true, vitest.fn(), settled)();
    await flush();
    expect(settled).toHaveBeenCalledTimes(3);
    expect(landed).toHaveBeenCalledWith(base.txHash);
  });
});

describe("clock time of a vote delegation", () => {
  it("formats local HH:MM, zero-padded, when it falls on the reader's day", () => {
    const now = new Date(2026, 10, 13, 12, 0).getTime();
    expect(clockTime(new Date(2026, 10, 13, 7, 5).getTime(), now)).toBe("07:05");
    expect(clockTime(new Date(2026, 10, 13, 23, 59).getTime(), now)).toBe("23:59");
  });

  it("puts the date in front when the moment falls on another local day", () => {
    // Sent at 23:30: the window closes at 01:30 the next day. "until 01:30"
    // alone reads as a time already gone.
    const sentAt = new Date(2026, 10, 13, 23, 30).getTime();
    expect(clockTime(sentAt + VOTE_DELEGATION_WATCH_LIMIT_MS, sentAt)).toBe("2026-11-14 01:30");
    // Read the next morning, the evening before is not "today" either.
    expect(clockTime(sentAt, new Date(2026, 10, 14, 0, 10).getTime())).toBe("2026-11-13 23:30");
    // Same day and month, another year.
    expect(clockTime(new Date(2025, 10, 13, 8, 0).getTime(), new Date(2026, 10, 13, 8, 0).getTime())).toBe(
      "2025-11-13 08:00",
    );
  });

  it("expires at sentAt plus the watch limit", () => {
    const sent: SentVoteDelegation = { account: ACCOUNT, network: 0, sentAt: T0, txHash: "ab".repeat(32) };
    expect(voteDelegationExpiresAt(sent)).toBe(T0 + VOTE_DELEGATION_WATCH_LIMIT_MS);
  });
});

describe("withdrawalWatch — a sent withdrawal, until a later read or the TTL says it is over", () => {
  const AMOUNT = BigInt(5_000_000);
  const w: SentWithdrawal = { account: ACCOUNT, network: 0, amount: AMOUNT, sentAt: T0, txHash: "cd".repeat(32) };
  const LATER = T0 + 20_000;

  it("is none with nothing sent", () => {
    expect(withdrawalWatch(null, ACCOUNT, 0, AMOUNT, LATER, null, LATER)).toBe("none");
  });

  // Each input below would release (or hold) the record on its own account and
  // network, so an answer other than `none` means the key check is gone.
  it("is none for another account, whatever the read says", () => {
    expect(withdrawalWatch(w, OTHER, 0, AMOUNT, LATER, null, LATER)).toBe("none");
    expect(withdrawalWatch(w, OTHER, 0, BigInt(0), LATER, null, LATER)).toBe("none");
    expect(withdrawalWatch(w, null, 0, AMOUNT, LATER, null, LATER)).toBe("none");
  });

  it("is none for another network, whatever the read says", () => {
    expect(withdrawalWatch(w, ACCOUNT, 2, AMOUNT, LATER, null, LATER)).toBe("none");
    expect(withdrawalWatch(w, ACCOUNT, 1, BigInt(0), LATER, null, LATER)).toBe("none");
  });

  it("holds while a later read still shows the amount withdrawn", () => {
    expect(withdrawalWatch(w, ACCOUNT, 0, AMOUNT, LATER, null, LATER)).toBe("held");
  });

  it("holds while nothing has been read, or the read failed", () => {
    expect(withdrawalWatch(w, ACCOUNT, 0, undefined, LATER, null, LATER)).toBe("held");
    expect(withdrawalWatch(w, ACCOUNT, 0, BigInt(0), null, null, LATER)).toBe("held");
  });

  it("opens the door on a later read showing less than was withdrawn", () => {
    expect(withdrawalWatch(w, ACCOUNT, 0, BigInt(0), LATER, null, LATER)).toBe("open");
    expect(withdrawalWatch(w, ACCOUNT, 0, AMOUNT - BigInt(1), T0 + 1, null, LATER)).toBe("open");
  });

  // A Conway withdrawal must equal the whole balance when it lands: a later
  // read of MORE means it landed and a new epoch paid out, or the balance grew
  // first and the node can no longer take it. Either way it is over.
  it("opens the door on a later read showing MORE than was withdrawn", () => {
    expect(withdrawalWatch(w, ACCOUNT, 0, AMOUNT + BigInt(1_000_000), LATER, null, LATER)).toBe("open");
  });

  it("holds when the read showing another balance started before or as the withdrawal was sent", () => {
    expect(withdrawalWatch(w, ACCOUNT, 0, BigInt(0), T0, null, LATER)).toBe("held");
    expect(withdrawalWatch(w, ACCOUNT, 0, AMOUNT + BigInt(1), T0, null, LATER)).toBe("held");
    expect(withdrawalWatch(w, ACCOUNT, 0, BigInt(0), T0 - 1, null, LATER)).toBe("held");
  });

  it("releases once the validity window has closed, even on the old balance", () => {
    expect(withdrawalWatch(w, ACCOUNT, 0, AMOUNT, LATER, null, T0 + WITHDRAWAL_WATCH_LIMIT_MS - 1)).toBe("held");
    expect(withdrawalWatch(w, ACCOUNT, 0, AMOUNT, LATER, null, T0 + WITHDRAWAL_WATCH_LIMIT_MS)).toBe("released");
    expect(withdrawalWatch(w, ACCOUNT, 0, undefined, null, null, T0 + WITHDRAWAL_WATCH_LIMIT_MS)).toBe("released");
  });

  // Review of #57: a transaction dropped from the mempool never moves the
  // balance, and the door held "waiting" for the whole validity window.
  const PAST = T0 + DELEGATION_UNSEEN_MS + 20_000;
  const notIn = (askedAt: number) => ({ txHash: w.txHash, seen: false, askedAt });
  it("is unseen once a look-up started past the threshold says the transaction is not in a block", () => {
    expect(withdrawalWatch(w, ACCOUNT, 0, AMOUNT, PAST, notIn(PAST), PAST)).toBe("unseen");
    expect(withdrawalWatch(w, ACCOUNT, 0, undefined, null, notIn(PAST), PAST)).toBe("unseen");
  });

  it("stays held past the threshold when the only 'not in a block' was asked before it", () => {
    expect(withdrawalWatch(w, ACCOUNT, 0, AMOUNT, PAST, notIn(T0 + DELEGATION_UNSEEN_MS), PAST)).toBe("held");
    expect(withdrawalWatch(w, ACCOUNT, 0, AMOUNT, PAST, null, PAST)).toBe("held");
  });

  it("does not take another transaction's answer for this one", () => {
    expect(withdrawalWatch(w, ACCOUNT, 0, AMOUNT, PAST, { ...notIn(PAST), txHash: "ef".repeat(32) }, PAST)).toBe("held");
  });

  it("found in a block: a read of exactly the amount is stale until the window closes", () => {
    const seen = { txHash: w.txHash, seen: true, askedAt: PAST };
    expect(withdrawalWatch(w, ACCOUNT, 0, AMOUNT, PAST, seen, PAST)).toBe("held");
    expect(withdrawalWatch(w, ACCOUNT, 0, BigInt(0), PAST, seen, PAST)).toBe("open");
    expect(withdrawalWatch(w, ACCOUNT, 0, AMOUNT, PAST, seen, T0 + WITHDRAWAL_WATCH_LIMIT_MS)).toBe("released");
  });

  it("a hash once found in a block stays found; another hash starts over", () => {
    const seen = withdrawalTxAnswered(null, w.txHash, true, LATER);
    expect(withdrawalTxAnswered(seen, w.txHash, false, PAST)).toEqual({ txHash: w.txHash, seen: true, askedAt: LATER });
    expect(withdrawalTxAnswered(notIn(LATER), w.txHash, false, PAST)).toEqual(notIn(PAST));
    expect(withdrawalTxAnswered(seen, "ef".repeat(32), false, PAST)).toEqual({ txHash: "ef".repeat(32), seen: false, askedAt: PAST });
  });
});
