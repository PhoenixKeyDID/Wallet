/**
 * Stand-in for `@noble/curves/ed25519` in the vendored LAMP verifier.
 *
 * Plain RFC 8032 Ed25519 verification through `node:crypto` (OpenSSL). It is
 * deliberately a different implementation from the one that signs —
 * `@stricahq/bip32ed25519`, built on `elliptic` — so a test that signs with one
 * and verifies with the other cannot pass on a bug the two happen to share.
 * The RFC 8032 §7.1 vectors in `signData.test.ts` pin this module itself.
 */
import { createPublicKey, verify as nodeVerify } from "node:crypto";

/** DER prefix of an Ed25519 SubjectPublicKeyInfo (RFC 8410); the 32-byte key follows. */
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function verifyEd25519(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(publicKey)]), format: "der", type: "spki" });
  return nodeVerify(null, Buffer.from(message), key, Buffer.from(signature));
}

export const ed25519 = {
  verify: (signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array, _opts?: { zip215?: boolean }) =>
    verifyEd25519(signature, message, publicKey),
};
