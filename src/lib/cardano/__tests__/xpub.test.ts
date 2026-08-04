import { describe, it, expect } from "vitest";
import { Buffer } from "buffer";
import { Bip32PrivateKey } from "@stricahq/bip32ed25519";
import { bech32 } from "bech32";
import { parseAcctXvk, deriveWatchWallet } from "../xpub";
import { toHex } from "../hash";

/**
 * Watch-only correctness is proven by equivalence, not a hard-coded vector:
 * CKDpub (soft, public-only) MUST yield the same child key-hash as deriving the
 * private child and taking its public key. That is exactly the invariant a
 * signer (rust_core `cardano.rs`, deriving from the seed) relies on — so if this
 * holds, a watch-only wallet shows the same addresses the signer will spend.
 */
async function acctFromSeed(): Promise<{ xprv: Bip32PrivateKey }> {
  const entropy = Buffer.from("00112233445566778899aabbccddeeff", "hex"); // 16-byte BIP-39 entropy
  const root = await Bip32PrivateKey.fromEntropy(entropy);
  // m/1852'/1815'/0'
  const xprv = root.deriveHardened(1852).deriveHardened(1815).deriveHardened(0);
  return { xprv };
}

describe("parseAcctXvk", () => {
  it("accepts a 64-byte hex account xvk", async () => {
    const { xprv } = await acctFromSeed();
    const xvkHex = xprv.toBip32PublicKey().toBytes().toString("hex");
    expect(xvkHex).toHaveLength(128);
    expect(() => parseAcctXvk(xvkHex)).not.toThrow();
  });
  it("rejects a 32-byte key (not extended / public-only guard)", () => {
    expect(() => parseAcctXvk("aa".repeat(32))).toThrow();
  });
  it("rejects wrong-length hex", () => {
    expect(() => parseAcctXvk("aa".repeat(10))).toThrow();
  });

  /**
   * Length does not identify an ACCOUNT key: root/addr/stake/policy xvk are all
   * 64 bytes. A root key silently derives `m/0/i` instead of
   * `m/1852'/1815'/0'/role/i` — addresses that look valid and that no wallet
   * will ever scan, so anything received there is lost in practice.
   */
  it("accepts bech32 acct_xvk and xpub", async () => {
    const { xprv } = await acctFromSeed();
    const bytes = xprv.toBip32PublicKey().toBytes();
    const words = bech32.toWords(bytes);
    expect(() => parseAcctXvk(bech32.encode("acct_xvk", words, 256))).not.toThrow();
    expect(() => parseAcctXvk(bech32.encode("xpub", words, 256))).not.toThrow();
  });

  it("rejects a 64-byte bech32 key that is not account-level", async () => {
    const { xprv } = await acctFromSeed();
    const words = bech32.toWords(xprv.toBip32PublicKey().toBytes());
    for (const hrp of ["root_xvk", "addr_xvk", "stake_xvk", "policy_xvk"]) {
      expect(() => parseAcctXvk(bech32.encode(hrp, words, 256))).toThrow(
        /not an account extended public key/i,
      );
    }
  });
});

describe("CKDpub soft derivation equals private-then-public", () => {
  it("payment key-hashes match for indices 0..4", async () => {
    const { xprv } = await acctFromSeed();
    const xvk = parseAcctXvk(xprv.toBip32PublicKey().toBytes().toString("hex"));
    const watch = deriveWatchWallet(xvk, 0, 5);

    for (let i = 0; i < 5; i++) {
      // private path: acct/0/i → public → hash
      const priv = xprv.derive(0).derive(i).toBip32PublicKey().toPublicKey().hash();
      expect(watch.addresses[i].paymentKeyHash).toBe(toHex(priv));
    }
  });

  it("stake key-hash matches private derivation (chain 2/0)", async () => {
    const { xprv } = await acctFromSeed();
    const xvk = parseAcctXvk(xprv.toBip32PublicKey().toBytes().toString("hex"));
    const watch = deriveWatchWallet(xvk, 0, 1);
    const priv = xprv.derive(2).derive(0).toBip32PublicKey().toPublicKey().hash();
    expect(watch.stakeKeyHash).toBe(toHex(priv));
  });

  it("addresses are deterministic and index-distinct", async () => {
    const { xprv } = await acctFromSeed();
    const xvk = parseAcctXvk(xprv.toBip32PublicKey().toBytes().toString("hex"));
    const a = deriveWatchWallet(xvk, 0, 3);
    const b = deriveWatchWallet(xvk, 0, 3);
    expect(a.addresses.map((x) => x.address)).toEqual(b.addresses.map((x) => x.address));
    expect(new Set(a.addresses.map((x) => x.address)).size).toBe(3);
    expect(a.stakeAddress).toMatch(/^stake_test1[0-9a-z]+$/);
  });
});
