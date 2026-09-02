/**
 * What a local account actually watches, measured against what the receive
 * screen will happily derive.
 *
 * `receive.test.ts` checks the warning's logic against derived fixtures. This
 * file checks the premise the warning rests on, against the real account: that
 * `allAddresses()` — the one list feeding both the balance
 * (`LocalWalletPanel`) and the inputs a spend is built from (`localPort`) —
 * genuinely does not contain the addresses the advanced panel can produce from
 * the very same account key.
 *
 * It lives under `keystore/` because it imports the keystore, which
 * `check:keystore-boundary` allows only here.
 */
import { describe, it, expect } from "vitest";
import { Buffer } from "buffer";
import { accountFromEntropy, allAddresses, GAP_LIMIT } from "../derive";
import { parseAcctXvk } from "../../cardano/xpub";
import { deriveReceiveAddress, unwatchedAmong } from "../../cardano/receive";
import type { PhoenixNetwork } from "../../cardano/address";

const NETWORK: PhoenixNetwork = 0;
const ENTROPY = Uint8Array.from(Buffer.alloc(32, 7));

const account = async () => accountFromEntropy(ENTROPY, 0, NETWORK);

describe("the addresses a local wallet can receive at but never sees", () => {
  it("watches base addresses only, GAP_LIMIT per chain", async () => {
    const acct = await account();
    expect(allAddresses(acct)).toHaveLength(GAP_LIMIT * 2);
  });

  it("does not watch the enterprise address of its own index 0", async () => {
    const acct = await account();
    const xvk = parseAcctXvk(acct.accountXvkHex);
    const ent = deriveReceiveAddress({ acctXvk: xvk, kind: "enterprise", index: 0, network: NETWORK });
    const watched = new Set(allAddresses(acct));

    // Same account, same index, same payment key — a different address kind.
    expect(watched.has(ent.address)).toBe(false);
    expect(unwatchedAmong([ent], watched)).toEqual([ent]);
  });

  it("does not watch its own base address one index past the gap limit", async () => {
    const acct = await account();
    const xvk = parseAcctXvk(acct.accountXvkHex);
    const watched = new Set(allAddresses(acct));

    const last = deriveReceiveAddress({ acctXvk: xvk, kind: "base", index: GAP_LIMIT - 1, network: NETWORK });
    const past = deriveReceiveAddress({ acctXvk: xvk, kind: "base", index: GAP_LIMIT, network: NETWORK });
    expect(watched.has(last.address)).toBe(true);
    expect(watched.has(past.address)).toBe(false);
  });

  /**
   * The reason the warning says "stranded", not "lost". An enterprise address
   * inside the gap limit reuses the payment key of the base address at the same
   * index, and the account already holds that key — so the wallet could sign for
   * it if it ever saw the UTxO. It never does, because the UTxO query is driven
   * by `allAddresses()`. Naming the difference matters: telling someone their
   * money is gone when it is reachable is its own kind of harm.
   */
  it("still holds the signing key for an enterprise address inside the gap", async () => {
    const acct = await account();
    const keyHash = acct.external[0]!.keyHashHex;
    expect(acct.keyByHash.has(keyHash)).toBe(true);
  });

  it("does not hold a key past the gap limit, so that one needs a rescan", async () => {
    const acct = await account();
    expect(acct.external).toHaveLength(GAP_LIMIT);
    expect(acct.external.every((a) => a.index < GAP_LIMIT)).toBe(true);
  });
});
