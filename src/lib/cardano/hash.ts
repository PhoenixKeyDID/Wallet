/**
 * Cardano credential hashing — Blake2b, matching rust_core.
 *
 * - Blake2b-224 (28 bytes): payment/stake key-hash and script-hash credential.
 * - Blake2b-256 (32 bytes): anchor asset-name (`blake2b_256(did)`) and tx-body hash.
 *
 * Reuses `@noble/hashes/blake2b` — the same primitive already vetted in
 * `src/lib/sdvc/crypto.ts`. No new crypto is introduced here.
 */
import { blake2b } from "@noble/hashes/blake2b";

/** Blake2b-224 — Cardano credential/script hash width (CIP-19). */
export function blake2b224(data: Uint8Array): Uint8Array {
  return blake2b(data, { dkLen: 28 });
}

/** Blake2b-256 — anchor asset-name and transaction-body hash width. */
export function blake2b256(data: Uint8Array): Uint8Array {
  return blake2b(data, { dkLen: 32 });
}

/** Lowercase hex of a byte array. */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Parse a hex string (with optional `0x`) into bytes; throws on odd/invalid input. */
export function fromHex(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error("hex string has odd length");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error(`invalid hex at position ${i * 2}`);
    out[i] = byte;
  }
  return out;
}
