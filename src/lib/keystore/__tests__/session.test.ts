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

  /**
   * Opening an account is slow on purpose — Argon2id at the shipping cost, then
   * a whole account derived — so there is a window of hundreds of milliseconds
   * in which the user can press Lock, hide the tab, or let the idle timer fire.
   * Without the epoch, the derivation finishes afterwards and unlocks the wallet
   * again: the keys land in memory *after* the person deliberately put them
   * away, and the screen shows an open wallet they did not reopen.
   */
  it("refuses an unlock whose derivation started before the wallet was locked", () => {
    const s = new WalletSession(NEVER_LOCK_MS);
    s.unlock("w1", fakeAccount());
    const epoch = s.epoch(); // taken as a slow open begins
    s.lock(); // …and the user locks while it is still running
    const late = fakeAccount();
    expect(s.unlock("w1", late, epoch)).toBe(false);
    expect(s.get().status).toBe("locked");
    // Refusing is not enough: the keys were derived either way, so the refusal
    // has to be the thing that destroys them. Handing them back to a caller
    // that was just told its work is stale is handing them to whoever forgets.
    expect(late.wiped).toBe(1);
  });

  it("refuses an unlock overtaken by a second open of a different account", () => {
    const s = new WalletSession(NEVER_LOCK_MS);
    const epoch = s.epoch();
    s.unlock("w2", fakeAccount()); // a later open finished first
    const slow = fakeAccount();
    expect(s.unlock("w1", slow, epoch)).toBe(false);
    expect(slow.wiped).toBe(1);
    expect((s.get() as { walletId: string }).walletId).toBe("w2");
  });

  it("still unlocks when nothing moved underneath the derivation", () => {
    const s = new WalletSession(NEVER_LOCK_MS);
    const epoch = s.epoch();
    const acct = fakeAccount();
    expect(s.unlock("w1", acct, epoch)).toBe(true);
    expect(acct.wiped).toBe(0);
    expect(s.get().status).toBe("unlocked");
  });

  /**
   * `lock()` bumps the epoch even when already locked. A derivation started
   * while locked — the create-and-open path — must not install itself either,
   * and "was the wallet open when Lock was pressed" is not the question.
   */
  it("counts a lock that had nothing to lock", () => {
    const s = new WalletSession(NEVER_LOCK_MS);
    const epoch = s.epoch();
    s.lock();
    const late = fakeAccount();
    expect(s.unlock("w1", late, epoch)).toBe(false);
    expect(late.wiped).toBe(1);
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

  /**
   * The screen that shows a fresh recovery phrase runs *before* anything is
   * unlocked, so there is no account to wipe and nothing for the idle timer to
   * hold. What protects those 24 words is the panel hiding them when the tab
   * goes away, and that only happens because `lock()` notifies subscribers even
   * when the session was already locked. Take the notification away — an early
   * return when the status is not "unlocked" reads like an obvious tidy-up —
   * and the words stay legible on an unattended screen with nothing throwing.
   */
  it("notifies subscribers even when it was already locked, which is what hides a phrase mid-creation", () => {
    const s = new WalletSession(1000);
    let notifications = 0;
    s.subscribe(() => (notifications += 1));
    expect(s.get().status).toBe("locked"); // never unlocked: the create/restore flow
    const afterSubscribe = notifications;
    s.lock();
    expect(notifications).toBe(afterSubscribe + 1);
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

/**
 * `onLock` — a lock that HAPPENED, told apart from a lock the wallet is IN.
 *
 * `subscribe` delivers the current state first and every change after, which is
 * what a screen wants and the opposite of what a handler wants. The difference
 * is invisible while a wallet is open and decisive before one ever is: a
 * brand-new session reads `locked`, so a handler wired to `subscribe` runs its
 * walk-away cleanup on first paint. The cost was paid in the wallet-creation
 * screen, where that cleanup hid the recovery phrase behind "the wallet locked
 * while your recovery phrase was on screen" — shown to every person creating a
 * first wallet, at the one step whose entire job is to display those words.
 */
describe("session > onLock fires on the transition, not on the state", () => {
  it("stays silent when a wallet nobody has opened is subscribed to", () => {
    const s = new WalletSession();
    let fired = 0;
    s.onLock(() => (fired += 1));
    expect(fired).toBe(0);
  });

  it("stays silent when an already-open wallet is subscribed to", () => {
    const s = new WalletSession();
    s.unlock("w1", fakeAccount());
    let fired = 0;
    s.onLock(() => (fired += 1));
    expect(fired).toBe(0);
  });

  it("fires once when an open wallet locks", () => {
    const s = new WalletSession();
    s.unlock("w1", fakeAccount());
    let fired = 0;
    s.onLock(() => (fired += 1));
    s.lock();
    expect(fired).toBe(1);
  });

  it("does not fire again when an already-locked wallet is locked", () => {
    // `lock()` emits unconditionally — it bumps the epoch even when nothing was
    // open — so silence here has to come from `onLock` itself, not from the
    // absence of a notification.
    const s = new WalletSession();
    s.unlock("w1", fakeAccount());
    let fired = 0;
    s.onLock(() => (fired += 1));
    s.lock();
    s.lock();
    s.lock();
    expect(fired).toBe(1);
  });

  it("fires when the idle timer locks the wallet, not only the Lock button", () => {
    vi.useFakeTimers();
    const s = new WalletSession(1000);
    s.unlock("w1", fakeAccount());
    let fired = 0;
    s.onLock(() => (fired += 1));
    vi.advanceTimersByTime(1001);
    expect(fired).toBe(1);
  });

  it("fires again on the second lock of a wallet that was reopened", () => {
    const s = new WalletSession();
    let fired = 0;
    s.onLock(() => (fired += 1));
    s.unlock("w1", fakeAccount());
    s.lock();
    s.unlock("w2", fakeAccount());
    s.lock();
    expect(fired).toBe(2);
  });

  it("unsubscribes", () => {
    const s = new WalletSession();
    s.unlock("w1", fakeAccount());
    let fired = 0;
    const off = s.onLock(() => (fired += 1));
    off();
    s.lock();
    expect(fired).toBe(0);
  });
});
