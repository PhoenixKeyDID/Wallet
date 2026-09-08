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
  /**
   * Bumped every time what-is-open changes. See `unlock`.
   *
   * Starts at 0 and only ever increases, so a caller can hold a number across
   * an `await` and ask afterwards whether the world moved underneath it.
   */
  private generation = 0;

  constructor(private timeoutMs: number = DEFAULT_LOCK_TIMEOUT_MS) {}

  get(): SessionState {
    return this.state;
  }

  /**
   * A ticket to be handed back to `unlock` after a slow derivation.
   *
   * Opening an account is not instant: the password goes through Argon2id at
   * the shipping cost (`t=2, m=19456` KiB) and then a whole account is derived,
   * which is hundreds of milliseconds at best and seconds on a loaded machine.
   * The user can press Lock during that window, or walk away and let the idle
   * timer fire, or hide the tab. Without this, the derivation finishes
   * afterwards and unlocks the wallet again — the keys land in memory *after*
   * the person deliberately put them away, and the screen shows an open wallet.
   */
  epoch(): number {
    return this.generation;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  /**
   * Fires when the wallet **becomes** locked — never for a lock it was already in.
   *
   * `subscribe` hands over the current state before it hands over any change,
   * which is the right shape for painting a screen and the wrong one for
   * reacting to an event. A `locked` reading arrives on every subscribe,
   * including the first one of a session nobody has opened yet; a caller that
   * reads it as "the wallet just locked" runs its walk-away handling against a
   * wallet that was never open. That is not hypothetical — it is why every
   * person creating their first wallet was told, over the words they were
   * supposed to be writing down, that the wallet had locked while their
   * recovery phrase was on screen.
   *
   * Locking an already-locked session is not an event here even though `lock()`
   * emits for it: nothing changed hands, so a listener has nothing to undo.
   * `lock()` still bumps the epoch in that case, and for its own reason — see
   * there.
   */
  onLock(fn: () => void): () => void {
    let wasUnlocked = this.state.status === "unlocked";
    return this.subscribe((s) => {
      const nowUnlocked = s.status === "unlocked";
      if (wasUnlocked && !nowUnlocked) fn();
      wasUnlocked = nowUnlocked;
    });
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

  /**
   * Put an unlocked account in, replacing (and wiping) any previous one.
   *
   * `expectedEpoch` makes the call conditional: pass the value `epoch()`
   * returned *before* the derivation started, and if anything changed what is
   * open in the meantime — a lock, a timeout, another account finishing first —
   * this refuses and **wipes the account it was handed** rather than installing
   * it. Returns whether it took effect.
   *
   * The refusal wipes rather than returning the account to the caller because
   * the caller has just been told its work is stale, and a stale caller is
   * exactly who forgets. The keys exist either way; the question is only
   * whether anything is still responsible for them.
   *
   * Omitting `expectedEpoch` keeps the old unconditional behaviour, which is
   * right for a caller that derived nothing and cannot be stale.
   */
  unlock(walletId: string, account: Account, expectedEpoch?: number): boolean {
    if (expectedEpoch !== undefined && expectedEpoch !== this.generation) {
      account.wipe();
      return false;
    }
    if (this.state.status === "unlocked") this.state.account.wipe();
    this.generation += 1;
    this.state = { status: "unlocked", account, walletId, expiresAt: 0 };
    this.touch();
    return true;
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
    // Bumped unconditionally, including when already locked. A derivation that
    // started before this call must not install its result afterwards, and
    // whether the wallet happened to be open when the user pressed Lock is not
    // the question being asked.
    this.generation += 1;
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
