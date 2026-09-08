import { describe, it, expect } from "vitest";
import { Buffer } from "buffer";
import { Bip32PrivateKey } from "@stricahq/bip32ed25519";
import { parseAcctXvk, deriveWatchWallet } from "./xpub";
import { deriveReceiveAddress, deriveReceiveRange, unwatchedAmong } from "./receive";

/**
 * Same test acct_xvk construction as `__tests__/xpub.test.ts`: a fixed 16-byte
 * BIP-39 entropy → m/1852'/1815'/0' account key. Reused here (not imported,
 * `xpub.test.ts` is a private test file) so this suite has no dependency on
 * another agent's test module.
 */
async function acctXvkHex(): Promise<string> {
  const entropy = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  const root = await Bip32PrivateKey.fromEntropy(entropy);
  const xprv = root.deriveHardened(1852).deriveHardened(1815).deriveHardened(0);
  return xprv.toBip32PublicKey().toBytes().toString("hex");
}

describe("deriveReceiveAddress", () => {
  it("golden vector: base/index-0 matches deriveWatchWallet's address 0", async () => {
    const xvk = parseAcctXvk(await acctXvkHex());
    const watch = deriveWatchWallet(xvk, 0, 1);
    const derived = deriveReceiveAddress({ acctXvk: xvk, kind: "base", index: 0, network: 0 });
    expect(derived.address).toBe(watch.addresses[0].address);
    expect(derived.path).toBe("m/1852'/1815'/0'/0/0");
  });

  it("enterprise address differs from base address at the same index", async () => {
    const xvk = parseAcctXvk(await acctXvkHex());
    const base = deriveReceiveAddress({ acctXvk: xvk, kind: "base", index: 0, network: 0 });
    const enterprise = deriveReceiveAddress({ acctXvk: xvk, kind: "enterprise", index: 0, network: 0 });
    expect(enterprise.address).not.toBe(base.address);
    // Enterprise (no stake credential) is shorter than base (payment+stake).
    expect(enterprise.address.length).toBeLessThan(base.address.length);
  });

  it("different indices produce different addresses (both kinds)", async () => {
    const xvk = parseAcctXvk(await acctXvkHex());
    for (const kind of ["base", "enterprise"] as const) {
      const a0 = deriveReceiveAddress({ acctXvk: xvk, kind, index: 0, network: 0 });
      const a1 = deriveReceiveAddress({ acctXvk: xvk, kind, index: 1, network: 0 });
      expect(a1.address).not.toBe(a0.address);
      expect(a1.path).toBe("m/1852'/1815'/0'/0/1");
    }
  });

  it("is deterministic", async () => {
    const xvk = parseAcctXvk(await acctXvkHex());
    const a = deriveReceiveAddress({ acctXvk: xvk, kind: "base", index: 3, network: 0 });
    const b = deriveReceiveAddress({ acctXvk: xvk, kind: "base", index: 3, network: 0 });
    expect(a.address).toBe(b.address);
  });

  it("rejects a negative or non-integer index", async () => {
    const xvk = parseAcctXvk(await acctXvkHex());
    expect(() => deriveReceiveAddress({ acctXvk: xvk, kind: "base", index: -1, network: 0 })).toThrow();
    expect(() => deriveReceiveAddress({ acctXvk: xvk, kind: "base", index: 1.5, network: 0 })).toThrow();
  });
});

describe("deriveReceiveRange", () => {
  it("returns `count` addresses starting at `start`, index-distinct", async () => {
    const xvk = parseAcctXvk(await acctXvkHex());
    const range = deriveReceiveRange({ acctXvk: xvk, kind: "base", start: 2, count: 5, network: 0 });
    expect(range).toHaveLength(5);
    expect(range.map((r) => r.index)).toEqual([2, 3, 4, 5, 6]);
    expect(new Set(range.map((r) => r.address)).size).toBe(5);
  });

  it("matches deriveReceiveAddress for each index in the range", async () => {
    const xvk = parseAcctXvk(await acctXvkHex());
    const range = deriveReceiveRange({ acctXvk: xvk, kind: "enterprise", start: 0, count: 3, network: 0 });
    for (const r of range) {
      const single = deriveReceiveAddress({ acctXvk: xvk, kind: "enterprise", index: r.index, network: 0 });
      expect(r.address).toBe(single.address);
    }
  });
});

/**
 * The green tick and the address it sits beside answer different questions.
 *
 * These tests exist because the screen showed ✓ — correctly, the key *was* the
 * user's — above an address the connected wallet does not watch. The first two
 * establish that the gap is real rather than theoretical, using the wallet's
 * own derivation; the rest pin the behaviour of the warning.
 */
describe("unwatchedAmong — the tick is about the key, the warning is about the address", () => {
  const AS_OWNED = async (kind: "base" | "enterprise", start: number, count: number) => {
    const xvk = parseAcctXvk(await acctXvkHex());
    return deriveReceiveRange({ acctXvk: xvk, kind, start, count, network: 0 });
  };

  it("flags an enterprise address even though the key is the wallet's own", async () => {
    // A local account watches base addresses only, so this address is derived
    // from the user's own key and is invisible to the balance query and to the
    // inputs the spend path collects. Silence here is the failure.
    const watched = new Set((await AS_OWNED("base", 0, 20)).map((d) => d.address));
    const shown = await AS_OWNED("enterprise", 0, 1);
    expect(unwatchedAmong(shown, watched)).toEqual(shown);
  });

  it("flags an index past the wallet's scan, at the same address kind", async () => {
    // GAP_LIMIT is 20. Index 40 is the same kind, the same key, and not scanned.
    const watched = new Set((await AS_OWNED("base", 0, 20)).map((d) => d.address));
    const shown = await AS_OWNED("base", 40, 1);
    expect(unwatchedAmong(shown, watched)).toHaveLength(1);
    expect(unwatchedAmong(shown, watched)[0]!.path).toBe("m/1852'/1815'/0'/0/40");
  });

  it("says nothing about an address the wallet did list", async () => {
    const watched = new Set((await AS_OWNED("base", 0, 20)).map((d) => d.address));
    expect(unwatchedAmong(await AS_OWNED("base", 3, 1), watched)).toEqual([]);
    expect(unwatchedAmong(await AS_OWNED("base", 0, 20), watched)).toEqual([]);
  });

  it("reports only the addresses that are missing, not the whole batch", async () => {
    // "Show next 5" from index 18 straddles the boundary: 18 and 19 are watched,
    // 20-22 are not. Warning about all five would train people to ignore it.
    const watched = new Set((await AS_OWNED("base", 0, 20)).map((d) => d.address));
    const shown = await AS_OWNED("base", 18, 5);
    expect(unwatchedAmong(shown, watched).map((d) => d.index)).toEqual([20, 21, 22]);
  });

  it("stays silent when the wallet listed nothing, because that is undecidable", async () => {
    // An empty list means "we could not compare", which the screen already
    // reports as "could not verify". Reading it as "unwatched" would put a
    // funds-at-risk warning on a perfectly ordinary address.
    const shown = await AS_OWNED("base", 0, 3);
    expect(unwatchedAmong(shown, new Set())).toEqual([]);
  });
});
