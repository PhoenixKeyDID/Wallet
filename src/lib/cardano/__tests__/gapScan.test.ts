/**
 * The scan that decides how far to look.
 *
 * The probe is injected, so these run the real decision logic with no network:
 * each case says which address indices hold funds and asserts how deep the scan
 * concludes it must derive. The property that matters throughout is one-sided —
 * **never fewer addresses than are needed**. Deriving too many costs a query;
 * deriving too few is money that does not appear in a balance.
 */
import { describe, it, expect } from "vitest";
import { Buffer } from "buffer";
import { Bip32PrivateKey } from "@stricahq/bip32ed25519";
import { parseAcctXvk, keyHashAt } from "../xpub";
import { baseAddress } from "../address";
import { scanChainDepth } from "../gapScan";

const NETWORK = 0 as const;
const GAP = 20;
const STAKE = "ab".repeat(28);

async function xvk() {
  const entropy = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  const root = await Bip32PrivateKey.fromEntropy(entropy);
  return parseAcctXvk(
    root.deriveHardened(1852).deriveHardened(1815).deriveHardened(0)
      .toBip32PublicKey().toBytes().toString("hex"),
  );
}

/** A chain where exactly these indices hold funds. */
async function chainWithFundsAt(indices: number[]) {
  const k = await xvk();
  const funded = new Set(
    indices.map((i) => baseAddress(keyHashAt(k, 0, i), STAKE, NETWORK)),
  );
  const seen: string[][] = [];
  const probe = async (addresses: string[]) => {
    seen.push(addresses);
    return addresses.some((a) => funded.has(a));
  };
  return { k, probe, seen };
}

const run = async (indices: number[], maxDepth = 200) => {
  const { k, probe, seen } = await chainWithFundsAt(indices);
  const depth = await scanChainDepth({
    acctXvk: k, chain: 0, stakeKeyHashHex: STAKE, network: NETWORK,
    gapLimit: GAP, probe, maxDepth,
  });
  return { depth, batches: seen.length };
};

describe("scanChainDepth", () => {
  it("stops at the gap limit for a wallet that has never been used", async () => {
    const { depth, batches } = await run([]);
    expect(depth).toBe(GAP);
    // One batch probed, then nothing. A fresh wallet must not cost 10 queries.
    expect(batches).toBe(1);
  });

  it("looks one gap past the last address that holds anything", async () => {
    // Index 19 is used, so 20..39 have to be checked before the wallet may say
    // "that is all" — stopping at 20 here is the bug, not the baseline.
    expect((await run([0, 3, 19])).depth).toBe(2 * GAP);
    // …while funds that stop early still only cost the one extra batch.
    expect((await run([0, 3])).depth).toBe(2 * GAP);
  });

  it("keeps going for funds past the gap limit — the bug this exists for", async () => {
    // A wallet used steadily up to index 25. Today's code derives 0..19 and
    // stops, so indices 20..25 are invisible and the balance reads smaller than
    // the truth with nothing on screen saying anything was skipped.
    const used = Array.from({ length: 26 }, (_, i) => i);
    const { depth, batches } = await run(used);
    expect(depth).toBeGreaterThan(25);
    expect(depth).toBe(60); // batches 0 and 1 held funds; one full gap beyond
    expect(batches).toBe(3);
  });

  it("follows a long history all the way out", async () => {
    const used = Array.from({ length: 138 }, (_, i) => i);
    const { depth, batches } = await run(used);
    expect(depth).toBeGreaterThan(137);
    expect(batches).toBe(8); // 0..6 hold funds, batch 7 is the empty one
  });

  it("does not stop at a hole, only at a whole empty gap", async () => {
    // Nothing between 6 and 29. That is a hole, not a gap of 20 *consecutive*
    // unused addresses, because batch 1 (20..39) still holds something — so a
    // scan that stopped at the first quiet stretch would hide index 30.
    const { depth } = await run([5, 30]);
    expect(depth).toBeGreaterThan(30);
    expect(depth).toBe(60);
  });

  /**
   * The standard's own limit, pinned so nobody later reads this module as
   * promising more than a gap scan can give.
   *
   * Funds beyond `gapLimit` consecutive unused addresses are not found by any
   * BIP-44 scan, here or in Lace. Stopping is correct behaviour, not a bug — but
   * it is only correct because no wallet *hands out* an address that far ahead.
   * The receive screen can, which is why an address it derives past the scan
   * carries its own warning rather than relying on this to catch it.
   */
  it("does not cross a gap wider than the limit, and that is the standard", async () => {
    const { depth } = await run([25]); // 0..19 never used: 20 consecutive empty
    expect(depth).toBe(GAP);
  });

  it("never returns fewer addresses than the highest funded index it can reach", async () => {
    for (const top of [0, 19, 20, 21, 59, 60, 61, 99]) {
      const used = Array.from({ length: top + 1 }, (_, i) => i);
      const { depth } = await run(used);
      expect(depth, `index ${top} must be inside the derived range`).toBeGreaterThan(top);
    }
  });

  it("stops at maxDepth rather than looping when the probe always says yes", async () => {
    const k = await xvk();
    let calls = 0;
    const depth = await scanChainDepth({
      acctXvk: k, chain: 0, stakeKeyHashHex: STAKE, network: NETWORK,
      gapLimit: GAP, maxDepth: 100,
      probe: async () => { calls += 1; return true; },
    });
    expect(depth).toBe(100);
    expect(calls).toBe(5); // 100 / 20, then the start passes maxDepth
  });

  it("refuses a nonsense gap limit or depth instead of scanning oddly", async () => {
    const k = await xvk();
    const base = {
      acctXvk: k, chain: 0, stakeKeyHashHex: STAKE, network: NETWORK,
      probe: async () => false,
    };
    await expect(scanChainDepth({ ...base, gapLimit: 0, maxDepth: 100 })).rejects.toThrow();
    await expect(scanChainDepth({ ...base, gapLimit: -1, maxDepth: 100 })).rejects.toThrow();
    await expect(scanChainDepth({ ...base, gapLimit: 20, maxDepth: 10 })).rejects.toThrow();
  });

  it("scans the internal chain separately from the external one", async () => {
    // Change addresses live on chain 1 and have their own history; scanning one
    // chain and applying its answer to the other would miss change entirely.
    const k = await xvk();
    const internalFunded = new Set(
      Array.from({ length: 31 }, (_, i) => baseAddress(keyHashAt(k, 1, i), STAKE, NETWORK)),
    );
    const probe = async (a: string[]) => a.some((x) => internalFunded.has(x));
    const ext = await scanChainDepth({
      acctXvk: k, chain: 0, stakeKeyHashHex: STAKE, network: NETWORK,
      gapLimit: GAP, probe, maxDepth: 200,
    });
    const int = await scanChainDepth({
      acctXvk: k, chain: 1, stakeKeyHashHex: STAKE, network: NETWORK,
      gapLimit: GAP, probe, maxDepth: 200,
    });
    expect(ext).toBe(GAP);
    expect(int).toBeGreaterThan(30);
  });
});
