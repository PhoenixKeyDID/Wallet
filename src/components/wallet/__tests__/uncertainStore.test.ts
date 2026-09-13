import { describe, it, expect } from "vitest";
import { utils as tyUtils } from "@stricahq/typhonjs";
import { baseAddress, enterpriseScriptAddress, type PhoenixNetwork } from "@/lib/cardano/address";
import {
  accountKeyFrom,
  lockKey,
  readLock,
  writeLock,
  clearLock,
  type KeyValueStore,
} from "../uncertainStore";

/**
 * The warning has to survive the wait it asks for.
 *
 * An unresolved submit tells the reader to copy the transaction id and look it
 * up before sending anything again. Looking it up means waiting for the chain.
 * The wallet idle-locks after five minutes, which is the same order — so a
 * warning that lives only in React state expires while the reader is doing
 * exactly what it told them to do, and they come back to an armed Send button
 * with no id anywhere.
 *
 * That boundary has now moved twice (panel → tabs → session), which is the
 * argument for putting it outside memory rather than one level further up.
 */

const HASH = "a".repeat(64);
const OTHER = "b".repeat(64);
const ADDR = "00deadbeef";

function memoryStore(seed: Record<string, string> = {}): KeyValueStore & { map: Map<string, string> } {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

/** A store that throws on everything, like Safari with site data blocked. */
const hostileStore: KeyValueStore = {
  getItem() {
    throw new Error("SecurityError");
  },
  setItem() {
    throw new Error("QuotaExceededError");
  },
  removeItem() {
    throw new Error("SecurityError");
  },
};

describe("uncertain lock > survives the reload it has to survive", () => {
  it("comes back after the store is re-read, which is what a remount does", () => {
    const s = memoryStore();
    expect(writeLock(s, 0, ADDR, HASH)).toBe(true);
    expect(readLock(s, 0, ADDR)).toBe(HASH);
  });

  it("is forgotten only when cleared — nothing else clears it", () => {
    const s = memoryStore();
    writeLock(s, 0, ADDR, HASH);
    // Deliberately not cleared by a later successful send, a timeout, or a
    // different write: the question is whether ONE transaction landed, and
    // nothing that happens afterwards answers it.
    writeLock(s, 1, ADDR, OTHER);
    expect(readLock(s, 0, ADDR)).toBe(HASH);
    clearLock(s, 0, ADDR);
    expect(readLock(s, 0, ADDR)).toBeNull();
  });
});

describe("uncertain lock > belongs to one wallet on one chain", () => {
  it("does not leak across networks", () => {
    const s = memoryStore();
    writeLock(s, 0, ADDR, HASH);
    expect(readLock(s, 1, ADDR)).toBeNull();
    expect(readLock(s, 2, ADDR)).toBeNull();
  });

  it("does not leak across accounts", () => {
    const s = memoryStore();
    writeLock(s, 0, ADDR, HASH);
    expect(readLock(s, 0, "00cafebabe")).toBeNull();
  });

  it("gives two different wallets two different keys", () => {
    expect(lockKey(0, ADDR)).not.toBe(lockKey(0, "00cafebabe"));
    expect(lockKey(0, ADDR)).not.toBe(lockKey(2, ADDR));
  });
});

describe("uncertain lock > refuses to show anything that is not a transaction id", () => {
  // The id is the one value on this notice the reader is told to act on. A
  // stored string that is not a hash — corruption, or anything else with write
  // access to this origin — must not reach the screen wearing that label.
  const JUNK = ["", "not-a-hash", "zz".repeat(32), "a".repeat(63), "a".repeat(65), "<script>"];

  for (const junk of JUNK) {
    it(`ignores ${JSON.stringify(junk.slice(0, 16))} and removes it`, () => {
      const s = memoryStore({ [lockKey(0, ADDR)]: junk });
      expect(readLock(s, 0, ADDR)).toBeNull();
      expect(s.map.has(lockKey(0, ADDR))).toBe(false);
    });
  }

  it("refuses to write one too, and says so", () => {
    const s = memoryStore();
    expect(writeLock(s, 0, ADDR, "nope")).toBe(false);
    expect(readLock(s, 0, ADDR)).toBeNull();
  });

  it("normalises case, so the same id is not two different locks", () => {
    const s = memoryStore();
    writeLock(s, 0, ADDR, HASH.toUpperCase());
    expect(readLock(s, 0, ADDR)).toBe(HASH);
  });
});

describe("uncertain lock > a browser that refuses storage is not an outage", () => {
  it("reads as absent rather than throwing", () => {
    // A wallet that will not open because it could not read a *warning* has
    // turned a safety feature into an outage.
    expect(() => readLock(hostileStore, 0, ADDR)).not.toThrow();
    expect(readLock(hostileStore, 0, ADDR)).toBeNull();
  });

  it("reports the write as not durable instead of pretending", () => {
    // The boolean is the point: a caller that assumed success would show a
    // notice promising the id is safe to come back to, in a browser where it
    // is not.
    expect(writeLock(hostileStore, 0, ADDR, HASH)).toBe(false);
  });

  it("clears without throwing, so acknowledging never crashes", () => {
    expect(() => clearLock(hostileStore, 0, ADDR)).not.toThrow();
  });

  it("treats a missing store the same way", () => {
    expect(readLock(null, 0, ADDR)).toBeNull();
    expect(writeLock(null, 0, ADDR, HASH)).toBe(false);
    expect(() => clearLock(undefined, 0, ADDR)).not.toThrow();
  });
});

describe("accountKeyFrom > the key does not rotate when the money moves", () => {
  // The defect this exists for: a change address is chosen as the first
  // internal address holding no UTxO *right now*. If the uncertain transaction
  // really did land, its own change output occupies that address, so the next
  // unlock resolves a different one. Keyed on the address, the lock vanishes on
  // exactly the branch where the money moved — the branch the warning is for.
  const PAY_A = "11".repeat(28);
  const PAY_B = "22".repeat(28); // same account, next internal address
  const STAKE_1 = "33".repeat(28);
  const STAKE_2 = "44".repeat(28); // a different account

  const hexOfBech32 = (bech: string) =>
    (tyUtils.getAddressFromString(bech) as { getHex(): string }).getHex();

  const addr = (pay: string, stake: string, net: PhoenixNetwork) =>
    hexOfBech32(baseAddress(pay, stake, net));

  it("gives two addresses of ONE account the same key", () => {
    // This single assertion is the whole fix. With the old keying the two sides
    // differ, and the lock written before the rotation cannot be read after it.
    expect(accountKeyFrom(addr(PAY_A, STAKE_1, 0))).toBe(accountKeyFrom(addr(PAY_B, STAKE_1, 0)));
  });

  it("still separates two accounts", () => {
    expect(accountKeyFrom(addr(PAY_A, STAKE_1, 0))).not.toBe(
      accountKeyFrom(addr(PAY_A, STAKE_2, 0)),
    );
  });

  it("survives the rotation end to end: written before, read after", () => {
    const store = memoryStore();
    const before = accountKeyFrom(addr(PAY_A, STAKE_1, 0));
    expect(writeLock(store, 0, before, HASH)).toBe(true);
    const after = accountKeyFrom(addr(PAY_B, STAKE_1, 0));
    expect(readLock(store, 0, after)).toBe(HASH);
  });

  it("falls back to one shared slot rather than to something that rotates", () => {
    // An address with no stake half, and an unparseable one. Both must land on
    // a key that is stable, even at the cost of two such accounts sharing it:
    // sharing shows account B a warning it can dismiss, rotating loses the
    // warning entirely and that is how the same amount leaves twice.
    const enterprise = hexOfBech32(enterpriseScriptAddress("55".repeat(28), 0));
    expect(accountKeyFrom(enterprise)).toBe(accountKeyFrom("not hex at all"));
    expect(accountKeyFrom("not hex at all")).toBe(accountKeyFrom(""));
    expect(accountKeyFrom(enterprise)).not.toBe(enterprise);
  });

  it("does not collide across networks even with the same account", () => {
    const preprod = lockKey(0, accountKeyFrom(addr(PAY_A, STAKE_1, 0)));
    const mainnet = lockKey(1, accountKeyFrom(addr(PAY_A, STAKE_1, 1)));
    expect(preprod).not.toBe(mainnet);
  });
});
