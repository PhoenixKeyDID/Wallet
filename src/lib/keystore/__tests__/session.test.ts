/**
 * Auto-lock behaviour.
 *
 * This file exists mostly to pin one number. Lace's browser extension ships
 * `DEFAULT_INACTIVITY_TIMEOUT_MS = INDEFINITE` — it never auto-locks unless
 * the user turns it on (their mobile build defaults to five minutes). An
 * unattended laptop is the ordinary case, not the exotic one, so this wallet
 * defaults the other way. A regression that flipped it back would not fail any
 * other test, and nobody would notice until a wallet was left open.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  WalletSession,
  DEFAULT_LOCK_TIMEOUT_MS,
  NEVER_LOCK_MS,
  LOCK_TIMEOUT_OPTIONS_MS,
} from "../session";
import type { Account } from "../derive";

afterEach(() => vi.useRealTimers());

/** Enough of an Account to observe wiping, without deriving real keys. */
function fakeAccount(): Account & { wiped: number } {
  const a = {
    accountIndex: 0,
    network: 0 as const,
    accountXvkHex: "",
    stakeKeyHashHex: "",
    drepKeyHashHex: "",
    rewardAddress: "",
    external: [],
    internal: [],
    keyByHash: new Map(),
    wiped: 0,
    wipe() {
      a.wiped += 1;
    },
  };
  return a as unknown as Account & { wiped: number };
}

describe("wallet session", () => {
  it("defaults to locking after five minutes, not never", () => {
    expect(DEFAULT_LOCK_TIMEOUT_MS).toBe(300_000);
    expect(DEFAULT_LOCK_TIMEOUT_MS).toBeLessThan(NEVER_LOCK_MS);
    expect(LOCK_TIMEOUT_OPTIONS_MS).toContain(DEFAULT_LOCK_TIMEOUT_MS);
  });

  it("locks itself once the idle window passes, and wipes the keys", () => {
    vi.useFakeTimers();
    const s = new WalletSession(1000);
    const acct = fakeAccount();
    s.unlock("w1", acct);
    expect(s.get().status).toBe("unlocked");

    vi.advanceTimersByTime(999);
    expect(s.get().status).toBe("unlocked");

    vi.advanceTimersByTime(1);
    expect(s.get().status).toBe("locked");
    expect(acct.wiped).toBe(1);
  });

  it("stays open while the user is doing things", () => {
    vi.useFakeTimers();
    const s = new WalletSession(1000);
    s.unlock("w1", fakeAccount());
    for (let i = 0; i < 5; i += 1) {
      vi.advanceTimersByTime(800);
      s.touch();
    }
    expect(s.get().status).toBe("unlocked");
    vi.advanceTimersByTime(1001);
    expect(s.get().status).toBe("locked");
  });

  it("wipes the previous account when a second wallet is unlocked", () => {
    const s = new WalletSession(NEVER_LOCK_MS);
    const first = fakeAccount();
    s.unlock("w1", first);
    s.unlock("w2", fakeAccount());
    // Two unlocked accounts would double the key material in memory for
    // nothing the user asked for.
    expect(first.wiped).toBe(1);
    expect((s.get() as { walletId: string }).walletId).toBe("w2");
  });

  it("honours an explicit never — but only when asked", () => {
    vi.useFakeTimers();
    const s = new WalletSession(NEVER_LOCK_MS);
    s.unlock("w1", fakeAccount());
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(s.get().status).toBe("unlocked");
    expect(s.msRemaining()).toBe(Infinity);
  });

  it("lock() is idempotent, so a button, a timer and a page-hide can all call it", () => {
    const s = new WalletSession(1000);
    const acct = fakeAccount();
    s.unlock("w1", acct);
    s.lock();
    s.lock();
    s.lock();
    expect(s.get().status).toBe("locked");
    expect(acct.wiped).toBe(1); // wiped once, not three times
  });

  it("tells subscribers the moment it locks", () => {
    vi.useFakeTimers();
    const s = new WalletSession(1000);
    const seen: string[] = [];
    s.subscribe((st) => seen.push(st.status));
    s.unlock("w1", fakeAccount());
    vi.advanceTimersByTime(1001);
    expect(seen[0]).toBe("locked"); // subscribe fires with current state
    expect(seen.at(-1)).toBe("locked");
    expect(seen).toContain("unlocked");
  });

  it("shortening the timeout takes effect on the open session immediately", () => {
    vi.useFakeTimers();
    const s = new WalletSession(60_000);
    s.unlock("w1", fakeAccount());
    s.setTimeout(1000);
    vi.advanceTimersByTime(1001);
    expect(s.get().status).toBe("locked");
  });
});
