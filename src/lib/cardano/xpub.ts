/**
 * Watch-only derivation from an account extended public key (`acct_xvk`).
 *
 * Implements the CKDpub soft-derivation of
 * `Legacy/spec-proposals-2026-07-10/PhoenixKey-Connector-CIP30-Feat-Math.md §B.1`:
 *
 *   payment_pub_i = CKDpub(acct_xvk, 0) → CKDpub(·, i)   -- chain 0 (external)
 *   stake_pub     = CKDpub(acct_xvk, 2) → CKDpub(·, 0)   -- chain 2 (stake)
 *   drep_pub      = CKDpub(acct_xvk, 3) → CKDpub(·, 0)   -- chain 3 (CIP-105)
 *   addr_i        = base_addr(pkh(payment_pub_i), pkh(stake_pub))
 *
 * Invariant M2-WATCH: `acct_xvk` is a PUBLIC key (64 bytes = 32 pubkey ‖ 32
 * chaincode). No private key is derivable from it — this module can view and
 * build, never sign. Signing always happens off this device.
 */
import { Buffer } from "buffer";
import { bech32 } from "bech32";
import { Bip32PublicKey } from "@stricahq/bip32ed25519";
import { baseAddress, rewardAddress, type PhoenixNetwork } from "./address";
import { toHex } from "./hash";

const ACCT_XVK_LEN = 64;
/** bech32 length cap — an `acct_xvk` (64 bytes) encodes to ~110 chars, over the default 90. */
const BECH32_LIMIT = 256;

/**
 * Accept an `acct_xvk` as hex (128 chars) or bech32 (`acct_xvk1…` / `xpub1…`)
 * and return a Bip32PublicKey. Rejects anything that is not exactly 64 bytes —
 * a 32-byte plain public key or a private key is refused (M2-WATCH / I-CONN-2).
 */
export function parseAcctXvk(input: string): Bip32PublicKey {
  const s = input.trim();
  let bytes: Buffer;
  if (/^[0-9a-fA-F]+$/.test(s)) {
    if (s.length !== ACCT_XVK_LEN * 2) {
      throw new Error(`acct_xvk hex must be ${ACCT_XVK_LEN} bytes (128 hex chars)`);
    }
    bytes = Buffer.from(s, "hex");
  } else {
    const { words } = bech32.decode(s, BECH32_LIMIT);
    bytes = Buffer.from(bech32.fromWords(words));
    if (bytes.length !== ACCT_XVK_LEN) {
      throw new Error(
        `decoded key is ${bytes.length} bytes, expected ${ACCT_XVK_LEN} — not an account extended PUBLIC key`,
      );
    }
  }
  return Bip32PublicKey.fromBytes(bytes);
}

/** Highest soft (non-hardened) derivation index. `acct_xvk` is a public key, so
 *  only soft children exist; anything ≥ 2³¹ is a hardened index that CANNOT be
 *  derived from a public key. */
export const MAX_SOFT_INDEX = 0x7fffffff;

/** 28-byte blake2b-224 key-hash (hex) of the soft-derived child at chain/index. */
export function keyHashAt(xvk: Bip32PublicKey, chain: number, index: number): string {
  // Fail with a clear message rather than letting the library throw an opaque
  // "can not derive hardened public key" for an out-of-range index.
  for (const n of [chain, index]) {
    if (!Number.isInteger(n) || n < 0 || n > MAX_SOFT_INDEX) {
      throw new Error(`derivation index ${n} out of range (0..${MAX_SOFT_INDEX}, soft only)`);
    }
  }
  return toHex(xvk.derive(chain).derive(index).toPublicKey().hash());
}

export type WatchAddress = {
  index: number;
  /** external payment address (base address, chain 0). */
  address: string;
  paymentKeyHash: string;
};

export type WatchWallet = {
  /** external receive addresses, index 0..count-1. */
  addresses: WatchAddress[];
  /** shared stake (reward) address, chain 2 / index 0. */
  stakeAddress: string;
  stakeKeyHash: string;
  /** CIP-105 DRep key-hash, chain 3 / index 0 (for governance display). */
  drepKeyHash: string;
};

/**
 * Derive the first `count` external addresses + the stake/DRep credentials of a
 * watch-only wallet from its `acct_xvk`.
 */
export function deriveWatchWallet(
  xvk: Bip32PublicKey,
  network: PhoenixNetwork,
  count = 5,
): WatchWallet {
  const stakeKeyHash = keyHashAt(xvk, 2, 0);
  const drepKeyHash = keyHashAt(xvk, 3, 0);
  const addresses: WatchAddress[] = [];
  for (let i = 0; i < count; i++) {
    const paymentKeyHash = keyHashAt(xvk, 0, i);
    addresses.push({
      index: i,
      paymentKeyHash,
      address: baseAddress(paymentKeyHash, stakeKeyHash, network),
    });
  }
  return {
    addresses,
    stakeKeyHash,
    stakeAddress: rewardAddress(stakeKeyHash, network),
    drepKeyHash,
  };
}
