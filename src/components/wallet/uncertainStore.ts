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
 * ## Keyed by the stake credential, not the change address
 *
 * One global key would let an unresolved submit on account A lock account B,
 * and — worse in the other direction — let switching accounts clear it. The
 * question "did my money move" belongs to one account on one chain.
 *
 * "One account" must not be spelled `changeAddress`, and this is the third
 * boundary this module has had to move. A change address is chosen as *the
 * first internal address holding no UTxO right now* — so if the uncertain
 * transaction did land, its own change output occupies that address, and the
 * next unlock resolves the next one. The key would rotate **on exactly the
 * branch where the money moved**, which is the branch the warning exists for.
 * The same rotation happens for a CIP-30 wallet, which hands over a fresh
 * change address whenever it likes.
 *
 * A Shelley base address carries two credentials. The payment half rotates;
 * the **stake half is the account** — every address this wallet derives for one
 * account shares it, and two accounts never do. It is also readable
 * synchronously from the hex the tabs already hold, which the reward address is
 * not, and that matters because the lock has to be known before the first
 * render arms a Send button.
 *
 * An address with no stake half falls back to one slot per network — that is
 * enterprise and pointer addresses, a base address whose stake half is a
 * script, and anything unparseable. Two such accounts then share a slot, and
 * the honest description of that is **not** "fails safe", because it fails in
 * both directions and only one of them is harmless:
 *
 *   - *showing*: account B sees account A's warning. Harmless — B reads it,
 *     looks the hash up, finds it is not theirs, dismisses it.
 *   - *clearing*: B pressing "I have checked" erases A's warning. Not
 *     harmless, and it is the same loss this module exists to prevent.
 *
 * It is still the right fallback, but for a narrower reason than "safe": it is
 * the only non-rotating answer available once the address stops carrying an
 * account identity, and rotation loses the warning on *every* such account
 * rather than on the rare pair that collide. Both failures need two accounts of
 * this shape in one browser; rotation needed only one account and one
 * successful transaction. If that ever stops being rare, the fix is a second
 * identity source, not a cleverer key.
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

import "../../lib/node-globals";
import { utils as tyUtils } from "@stricahq/typhonjs";

/** The part of `Storage` this needs. Lets a test pass a plain object. */
export type KeyValueStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

const PREFIX = "phoenix.uncertainSubmit";

/**
 * The slot used when an address has no stake half, or cannot be read at all.
 *
 * Shared per network on purpose — see the header. It must not be derived from
 * anything that rotates, and "one slot" is the only such answer left once the
 * address stops telling us which account it belongs to.
 */
const SHARED_SLOT = "network";

/**
 * The account this address belongs to, as a string that does not rotate.
 *
 * Takes the hex the tabs already hold. Never throws: a hash that cannot be
 * parsed still has to produce *some* key, because the alternative is a wallet
 * that cannot record a warning at all.
 */
export function accountKeyFrom(changeAddressHex: string): string {
  try {
    const addr = tyUtils.getAddressFromHex(Buffer.from(changeAddressHex, "hex"));
    const stake = (addr as { stakeCredential?: { hash?: Buffer } }).stakeCredential;
    const hash = stake?.hash;
    if (!hash || hash.length === 0) return SHARED_SLOT;
    return hash.toString("hex");
  } catch {
    return SHARED_SLOT;
  }
}

/**
 * The storage key for one account on one chain.
 *
 * `accountKey` is already this browser's own data and never leaves it. It is
 * used whole rather than truncated: a collision here would show account A's
 * warning on account B — a wrong fact about money, produced to save a few
 * bytes.
 */
export function lockKey(network: number, accountKey: string): string {
  return `${PREFIX}.${network}.${accountKey}`;
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
  accountKey: string,
): string | null {
  if (!store) return null;
  try {
    const raw = store.getItem(lockKey(network, accountKey));
    if (raw === null) return null;
    if (!isTxHash(raw)) {
      try {
        store.removeItem(lockKey(network, accountKey));
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
  accountKey: string,
  txHash: string,
): boolean {
  if (!store || !isTxHash(txHash)) return false;
  try {
    store.setItem(lockKey(network, accountKey), txHash.toLowerCase());
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
  accountKey: string,
): void {
  if (!store) return;
  try {
    store.removeItem(lockKey(network, accountKey));
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
