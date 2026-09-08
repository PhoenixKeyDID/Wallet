/**
 * What `lock()` actually destroys.
 *
 * `session.lock()` calls `account.wipe()`, and `session.ts` describes a locked
 * wallet as one whose keys are not in memory. That sentence was only true of
 * the leaves: `wipe()` zeroed each `PrivateKey` in `keyByHash` and left the
 * account extended key — and, on the `accountFromEntropy` path, the root —
 * untouched. Either one regenerates every key that had just been scrubbed, so
 * the lock removed the copies and kept the master.
 *
 * These tests pin the two facts the fix rests on: that zeroing the buffer a key
 * object hands back really does scrub that key, and that after a wipe no key
 * material survives in the account.
 *
 * Not pinned here, because the objects are deliberately not exposed: that the
 * *specific* `acct` and `root` instances inside `buildAccount` /
 * `accountFromEntropy` are the ones zeroed. That is held by review and by the
 * types, not by this file.
 */
import { describe, expect, it } from "vitest";
import { accountFromEntropy, accountKey, rootKeyFromEntropy } from "../derive";

const ENTROPY = new Uint8Array(32).fill(7);
const isAllZero = (b: Uint8Array) => b.every((x) => x === 0);

describe("scrubbing extended keys", () => {
  it("zeroing the buffer an extended key hands back scrubs the key itself", async () => {
    const root = await rootKeyFromEntropy(ENTROPY);
    const acct = accountKey(root, 0);

    expect(isAllZero(acct.toBytes())).toBe(false);
    acct.toBytes().fill(0);
    // A copy would leave the original intact and the whole mitigation useless.
    expect(isAllZero(acct.toBytes())).toBe(true);
  });

  it("the same holds for a leaf private key", async () => {
    const root = await rootKeyFromEntropy(ENTROPY);
    const prv = accountKey(root, 0).derive(0).derive(0).toPrivateKey();

    expect(isAllZero(prv.toBytes())).toBe(false);
    prv.toBytes().fill(0);
    expect(isAllZero(prv.toBytes())).toBe(true);
  });
});

describe("account.wipe()", () => {
  it("leaves no signing key behind", async () => {
    const account = await accountFromEntropy(ENTROPY, 0, 0);
    const keys = [...account.keyByHash.values()];
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k) => isAllZero(k.toBytes()))).toBe(false);

    account.wipe();

    expect(account.keyByHash.size).toBe(0);
    expect(keys.every((k) => isAllZero(k.toBytes()))).toBe(true);
  });

  it("survives being called twice — a lock must never throw", async () => {
    const account = await accountFromEntropy(ENTROPY, 0, 0);
    account.wipe();
    expect(() => account.wipe()).not.toThrow();
  });

  it("does not destroy a root the caller still owns", async () => {
    // `buildAccount` is called with a root the caller keeps; only
    // `accountFromEntropy`, which creates its own root, may scrub it.
    const root = await rootKeyFromEntropy(ENTROPY);
    const { buildAccount } = await import("../derive");
    const first = buildAccount(root, 0, 0);
    first.wipe();

    const second = buildAccount(root, 0, 0);
    expect(second.external[0]?.address).toBeTruthy();
    expect(isAllZero(root.toBytes())).toBe(false);
  });
});
