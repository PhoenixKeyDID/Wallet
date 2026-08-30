/**
 * The unlocked session — how long keys stay usable, and what ends that.
 *
 * A locked wallet is a wallet whose keys are not in memory. Every path back to
 * spendable keys goes through the password, so the only question this file
 * answers is: how long after the last thing the user did should the keys stay?
 *
 * That first sentence is a claim, so here is exactly what it does and does not
 * cover. `lock()` calls `Account.wipe()`, which zeroes every derived private
 * key, the account extended key, and — on the `accountFromEntropy` path — the
 * root. It used to zero only the derived keys, which meant a lock scrubbed the
 * leaves and left the trunk that regenerates them; that is fixed and pinned by
 * `__tests__/wipe.test.ts`. The panel additionally clears the password field,
 * because a password held across a lock is the thing that undoes the lock.
 *
 * What survives, stated rather than glossed: a recovery phrase being shown
 * during wallet creation, before any vault exists. Destroying it would throw
 * away a wallet the user is halfway through writing down, and a wallet that
 * punishes you for opening your password manager teaches you to screenshot the
 * words instead. The panel hides it on lock rather than destroying it, which
 * answers the threat the walk-away timer is actually for — someone reading the
 * screen — and does not pretend to answer a different one.
 *
 * **Default: 5 minutes.** Worth stating why, because the obvious reference
 * gets this wrong: Lace's browser extension ships
 * `DEFAULT_INACTIVITY_TIMEOUT_MS = INDEFINITE` — it does not auto-lock at all
 * unless the user goes and turns it on (their mobile build defaults to 5
 * minutes). An unattended laptop is the ordinary case, not the exotic one, so
 * the safe value is the default here and the indefinite one is opt-in.
 *
 * The timer is a convenience boundary, not a security boundary: anything that
 * can already run code in this context can read the keys while unlocked. What
 * it genuinely buys is the walk-away case — a shared machine, a borrowed
 * laptop, a screen left open — and that is worth having by default.
 */
import type { Account } from "./derive";

export const LOCK_TIMEOUT_OPTIONS_MS = [
  60_000,
  120_000,
  300_000,
  900_000,
  1_800_000,
  3_600_000,
] as const;

/** Five minutes. See the note above on why this is not "never". */
export const DEFAULT_LOCK_TIMEOUT_MS = 300_000;

/** Opt-in only, and the UI must say what it costs. */
export const NEVER_LOCK_MS = Number.MAX_SAFE_INTEGER;

export type SessionState =
  | { status: "locked" }
  | { status: "unlocked"; account: Account; walletId: string; expiresAt: number };

type Listener = (state: SessionState) => void;

/**
 * Holds at most one unlocked account.
 *
 * One, not many: a second unlocked account doubles the material in memory for
 * no gain the user asked for. Switching wallets re-locks the previous one.
 */
export class WalletSession {
  private state: SessionState = { status: "locked" };
  private timer: ReturnType<typeof setTimeout> | undefined;
  private listeners = new Set<Listener>();

  constructor(private timeoutMs: number = DEFAULT_LOCK_TIMEOUT_MS) {}

  get(): SessionState {
    return this.state;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.state);
  }

  setTimeout(ms: number): void {
    this.timeoutMs = ms;
    if (this.state.status === "unlocked") this.touch();
  }

  getTimeout(): number {
    return this.timeoutMs;
  }

  /** Put an unlocked account in, replacing (and wiping) any previous one. */
  unlock(walletId: string, account: Account): void {
    if (this.state.status === "unlocked") this.state.account.wipe();
    this.state = { status: "unlocked", account, walletId, expiresAt: 0 };
    this.touch();
  }

  /** Restart the idle countdown — call on any deliberate user action. */
  touch(): void {
    if (this.state.status !== "unlocked") return;
    if (this.timer) clearTimeout(this.timer);
    this.state = { ...this.state, expiresAt: nowMs() + this.timeoutMs };
    if (this.timeoutMs < NEVER_LOCK_MS) {
      this.timer = setTimeout(() => this.lock(), this.timeoutMs);
    }
    this.emit();
  }

  /**
   * Drop the keys. Idempotent, so the UI can call it from a button, a timer
   * and a page-hide handler without coordinating between them.
   */
  lock(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.state.status === "unlocked") this.state.account.wipe();
    this.state = { status: "locked" };
    this.emit();
  }

  /** Milliseconds until auto-lock, or `Infinity` when locking is off. */
  msRemaining(): number {
    if (this.state.status !== "unlocked") return 0;
    if (this.timeoutMs >= NEVER_LOCK_MS) return Infinity;
    return Math.max(0, this.state.expiresAt - nowMs());
  }
}

function nowMs(): number {
  return Date.now();
}
