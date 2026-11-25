/**
 * The sent vote delegation, kept on disk so a session lock or a reload does not
 * bring back an armed "Choose Abstain" while the first one is still on its way.
 */
import { describe, it, expect } from "vitest";
import { VOTE_DELEGATION_WATCH_LIMIT_MS, type SentVoteDelegation } from "../delegationFeedback";
import { lockKey } from "../uncertainStore";
import {
  clearSentVote,
  leftVoteKey,
  readLeftVote,
  readSentVote,
  rememberLeftVote,
  voteDelegationKey,
  writeSentVote,
} from "../voteDelegationStore";
import type { KeyValueStore } from "../uncertainStore";

const ACCT_KEY = "aa".repeat(28);
const T0 = 1_700_000_000_000;
const HASH = "ab".repeat(32);
const SENT: SentVoteDelegation = {
  account: "stake_test1uqaccount",
  network: 0,
  sentAt: T0,
  txHash: HASH,
  drepBefore: null,
};

function memStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k)! : null),
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

describe("voteDelegationStore", () => {
  it("round-trips a record, keyed per network and account like the uncertain-submit lock", () => {
    const store = memStore();
    expect(writeSentVote(store, ACCT_KEY, SENT)).toBe(true);
    expect(readSentVote(store, 0, ACCT_KEY, T0 + 60_000)).toEqual({ kind: "live", sent: SENT });
    // Another network, another account: not this record.
    expect(readSentVote(store, 2, ACCT_KEY, T0 + 60_000)).toEqual({ kind: "none" });
    expect(readSentVote(store, 0, "bb".repeat(28), T0 + 60_000)).toEqual({ kind: "none" });
    // Same key derivation as the lock, under its own prefix.
    expect(voteDelegationKey(0, ACCT_KEY).split(".").slice(-2)).toEqual(lockKey(0, ACCT_KEY).split(".").slice(-2));
    expect(voteDelegationKey(0, ACCT_KEY)).not.toBe(lockKey(0, ACCT_KEY));
  });

  it("keeps an absent drepBefore absent (not read), rather than inventing null", () => {
    const store = memStore();
    const { drepBefore: _omit, ...noBefore } = SENT;
    writeSentVote(store, ACCT_KEY, noBefore);
    const got = readSentVote(store, 0, ACCT_KEY, T0);
    expect(got.kind).toBe("live");
    expect(got.kind === "live" && "drepBefore" in got.sent).toBe(false);
  });

  it("keeps the sent target, and still reads a record written before the target existed", () => {
    const store = memStore();
    const withTarget = { ...SENT, target: "drep_always_abstain" };
    writeSentVote(store, ACCT_KEY, withTarget);
    expect(readSentVote(store, 0, ACCT_KEY, T0)).toEqual({ kind: "live", sent: withTarget });

    // An older record (no `target`): read, not dropped — dropping it would
    // bring the Abstain offer back while that delegation may still land.
    store.setItem(
      voteDelegationKey(0, ACCT_KEY),
      JSON.stringify({ account: SENT.account, network: 0, sentAt: T0, txHash: HASH, drepBefore: "drep1old" }),
    );
    const got = readSentVote(store, 0, ACCT_KEY, T0);
    expect(got).toEqual({ kind: "live", sent: { ...SENT, drepBefore: "drep1old" } });
    expect(got.kind === "live" && "target" in got.sent).toBe(false);
  });

  it("a target that is there but not a non-empty string is malformed", () => {
    for (const target of ["", 7, null]) {
      const store = memStore();
      store.setItem(
        voteDelegationKey(0, ACCT_KEY),
        JSON.stringify({ account: SENT.account, network: 0, sentAt: T0, txHash: HASH, target }),
      );
      expect(readSentVote(store, 0, ACCT_KEY, T0)).toEqual({ kind: "none" });
      expect(store.data.size).toBe(0);
    }
  });

  it("drops a record past its watch limit and reports it once as expired", () => {
    const store = memStore();
    writeSentVote(store, ACCT_KEY, SENT);
    expect(readSentVote(store, 0, ACCT_KEY, T0 + VOTE_DELEGATION_WATCH_LIMIT_MS - 1).kind).toBe("live");
    expect(readSentVote(store, 0, ACCT_KEY, T0 + VOTE_DELEGATION_WATCH_LIMIT_MS)).toEqual({
      kind: "expired",
      sent: SENT,
    });
    expect(store.data.size).toBe(0);
    expect(readSentVote(store, 0, ACCT_KEY, T0 + VOTE_DELEGATION_WATCH_LIMIT_MS)).toEqual({ kind: "none" });
  });

  it("drops a malformed value and treats it as none, without guessing a field", () => {
    const key = voteDelegationKey(0, ACCT_KEY);
    const bad = [
      "not json",
      "null",
      "[]",
      JSON.stringify({ ...SENT, txHash: "abc" }),
      JSON.stringify({ ...SENT, sentAt: "1700000000000" }),
      JSON.stringify({ ...SENT, account: "" }),
      JSON.stringify({ ...SENT, network: 2 }),
      JSON.stringify({ ...SENT, drepBefore: 5 }),
      JSON.stringify({ account: SENT.account, network: 0, txHash: HASH }),
      // A send time further ahead than the whole window: not this clock's.
      JSON.stringify({ ...SENT, sentAt: T0 + 2 * VOTE_DELEGATION_WATCH_LIMIT_MS }),
    ];
    for (const raw of bad) {
      const store = memStore();
      store.setItem(key, raw);
      expect(readSentVote(store, 0, ACCT_KEY, T0), raw).toEqual({ kind: "none" });
      expect(store.data.has(key), raw).toBe(false);
    }
  });

  it("#74: a record carrying a field this build does not know is read, not removed", () => {
    // A tab on an older build treated such a record as malformed and removed
    // it; the removal's `storage` event then dropped the pending line on every
    // up-to-date tab while the transaction was still on its way. Same story
    // as when `drepBefore` and `target` were added.
    const key = voteDelegationKey(0, ACCT_KEY);
    const cases: [Record<string, unknown>, SentVoteDelegation][] = [
      [{ futureMark: true }, { ...SENT, drepBefore: null }],
      [{ drepBefore2: null, note: "x" }, { ...SENT, drepBefore: null }],
      // A known optional field alongside an unknown one: both read as they are.
      [{ resend: true, later: 3 }, { ...SENT, drepBefore: null, resend: true }],
    ];
    for (const [extra, want] of cases) {
      const store = memStore();
      store.setItem(
        key,
        JSON.stringify({ account: SENT.account, network: 0, sentAt: T0, txHash: HASH, drepBefore: null, ...extra }),
      );
      expect(readSentVote(store, 0, ACCT_KEY, T0), JSON.stringify(extra)).toEqual({ kind: "live", sent: want });
      // Not removed by the read.
      expect(store.data.has(key), JSON.stringify(extra)).toBe(true);
    }
  });

  it("a storage that throws reads as none and writes as not durable", () => {
    const broken: KeyValueStore = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceeded");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
    };
    expect(readSentVote(broken, 0, ACCT_KEY, T0)).toEqual({ kind: "none" });
    expect(writeSentVote(broken, ACCT_KEY, SENT)).toBe(false);
    expect(() => clearSentVote(broken, 0, ACCT_KEY, HASH)).not.toThrow();
    expect(readSentVote(null, 0, ACCT_KEY, T0)).toEqual({ kind: "none" });
  });

  it("clears only the record for the given hash", () => {
    const store = memStore();
    writeSentVote(store, ACCT_KEY, SENT);
    clearSentVote(store, 0, ACCT_KEY, "cd".repeat(32));
    expect(readSentVote(store, 0, ACCT_KEY, T0).kind).toBe("live");
    clearSentVote(store, 0, ACCT_KEY, HASH.toUpperCase());
    expect(readSentVote(store, 0, ACCT_KEY, T0)).toEqual({ kind: "none" });
  });

  it("#66: keeps the send-back mark; a mark other than true is malformed", () => {
    const store = memStore();
    const resend: SentVoteDelegation = { ...SENT, drepBefore: "drep1y", target: "drep1x", resend: true };
    writeSentVote(store, ACCT_KEY, resend);
    expect(readSentVote(store, 0, ACCT_KEY, T0)).toEqual({ kind: "live", sent: resend });
    for (const mark of [false, "true", 1, null]) {
      store.setItem(
        voteDelegationKey(0, ACCT_KEY),
        JSON.stringify({ account: SENT.account, network: 0, sentAt: T0, txHash: HASH, resend: mark }),
      );
      expect(readSentVote(store, 0, ACCT_KEY, T0)).toEqual({ kind: "none" });
    }
  });

  it("#66: remembers the choice last moved away from, for one watch window", () => {
    const store = memStore();
    expect(readLeftVote(store, 0, ACCT_KEY, T0)).toBeNull();
    rememberLeftVote(store, 0, ACCT_KEY, "drep1x", T0);
    expect(readLeftVote(store, 0, ACCT_KEY, T0 + 60_000)).toBe("drep1x");
    // Another network, another account: not this memory.
    expect(readLeftVote(store, 2, ACCT_KEY, T0)).toBeNull();
    expect(readLeftVote(store, 0, "bb".repeat(28), T0)).toBeNull();
    expect(leftVoteKey(0, ACCT_KEY)).not.toBe(voteDelegationKey(0, ACCT_KEY));
    // Past the window it is dropped.
    expect(readLeftVote(store, 0, ACCT_KEY, T0 + VOTE_DELEGATION_WATCH_LIMIT_MS)).toBeNull();
    expect(store.data.size).toBe(0);
  });

  it("#66: a malformed memory is dropped, not guessed", () => {
    for (const raw of ["{", "[]", JSON.stringify({ drep: "", at: T0 }), JSON.stringify({ drep: "drep1x" }),
      JSON.stringify({ drep: "drep1x", at: T0, extra: 1 })]) {
      const store = memStore();
      store.setItem(leftVoteKey(0, ACCT_KEY), raw);
      expect(readLeftVote(store, 0, ACCT_KEY, T0)).toBeNull();
      expect(store.data.size).toBe(0);
    }
  });
});
