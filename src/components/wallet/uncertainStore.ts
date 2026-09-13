/**
 * Where an unresolved submit is remembered, and why it has to outlive the page.
 *
 * A transaction was signed and handed to the network, and the reply did not
 * arrive. The notice that follows asks the reader to do one thing: copy the
 * hash and look it up before sending anything again. Looking it up means
 * waiting for the chain — a block, sometimes several.
 *
 * That wait is the same order of magnitude as the wallet's own idle lock, which
 * is five minutes. So the honest reading of "held in React state" is: **the
 * warning expires while the reader is doing exactly what it told them to do.**
 * When the session locks, `WalletTabs` unmounts, the hash is gone — nothing
 * held a second copy — and unlocking returns a clean screen with an armed Send
 * button. Reloading the page does the same. Neither requires a mistake.
 *
 * This was found twice. The first time the boundary was "switch tabs"; the fix
 * moved the state up one level, which moved the boundary to "session locks"
 * rather than removing it. A lock that lives in memory has *some* boundary, and
 * every one of them is crossed by waiting.
 *
 * ## Shape
 *
 * Plain functions over a `Storage`-like object rather than a hook, for one
 * reason: this runner has no DOM, so anything written as a hook could only be
 * checked by reading its source. These can be run.
 *
 * ## Keyed by wallet and network
 *
 * One global key would let an unresolved submit on account A lock account B,
 * and — worse in the other direction — let switching accounts clear it. The
 * question "did my money move" belongs to one address on one chain.
 *
 * ## Failure
 *
 * Every read is wrapped: Safari in private mode throws on `localStorage`, and a
 * wallet that refuses to open because it could not read a *warning* has turned
 * a safety feature into an outage. A read that throws returns `null`, and the
 * screen falls back to the in-memory lock it already had — no worse than before
 * this module existed. A **write** that throws is different and is not
 * swallowed silently: the caller is told, so it can keep the in-memory copy and
 * not promise durability it does not have.
 */

/** The part of `Storage` this needs. Lets a test pass a plain object. */
export type KeyValueStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

const PREFIX = "phoenix.uncertainSubmit";

/**
 * The storage key for one wallet on one chain.
 *
 * `changeAddress` is already this browser's own data and never leaves it. It is
 * used whole rather than truncated: two accounts of the same wallet share long
 * prefixes and suffixes, and a collision here would show account A's warning on
 * account B — a wrong fact about money, produced to save a few bytes.
 */
export function lockKey(network: number, changeAddress: string): string {
  return `${PREFIX}.${network}.${changeAddress}`;
}

/** A 64-character hex transaction id, and nothing else. */
const isTxHash = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/i.test(v);

/**
 * The unresolved submit for this wallet+network, or `null` if there is none.
 *
 * Anything stored that is not a transaction hash is treated as absent and
 * removed. The alternative — showing it — puts an attacker-chosen or
 * corruption-chosen string on screen as "your transaction id", which is the
 * one value on this notice the reader is told to act on.
 */
export function readLock(
  store: KeyValueStore | null | undefined,
  network: number,
  changeAddress: string,
): string | null {
  if (!store) return null;
  try {
    const raw = store.getItem(lockKey(network, changeAddress));
    if (raw === null) return null;
    if (!isTxHash(raw)) {
      try {
        store.removeItem(lockKey(network, changeAddress));
      } catch {
        // Cleaning up is a courtesy; failing to clean up is not a reason to
        // fail the read, which has already decided the answer is `null`.
      }
      return null;
    }
    return raw.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Remember an unresolved submit. Returns whether it will survive a reload.
 *
 * The boolean is the point. A caller that assumes it worked would show a notice
 * promising the hash is safe to come back to, in a browser where it is not.
 */
export function writeLock(
  store: KeyValueStore | null | undefined,
  network: number,
  changeAddress: string,
  txHash: string,
): boolean {
  if (!store || !isTxHash(txHash)) return false;
  try {
    store.setItem(lockKey(network, changeAddress), txHash.toLowerCase());
    return true;
  } catch {
    return false;
  }
}

/**
 * Forget it — only ever after the reader says they have checked.
 *
 * There is deliberately no timeout and no "clear on success of a later send":
 * the question this answers is whether one specific transaction landed, and
 * nothing that happens afterwards answers it.
 */
export function clearLock(
  store: KeyValueStore | null | undefined,
  network: number,
  changeAddress: string,
): void {
  if (!store) return;
  try {
    store.removeItem(lockKey(network, changeAddress));
  } catch {
    // Already unreadable; the in-memory copy is cleared by the caller either
    // way, and a stale key resurfacing is better than a crash on acknowledge.
  }
}

/** `window.localStorage`, or `null` where there is no window or it throws. */
export function browserStore(): KeyValueStore | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}
