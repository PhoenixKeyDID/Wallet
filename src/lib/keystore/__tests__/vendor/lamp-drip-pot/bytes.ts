// VENDORED for tests only. Source: https://github.com/MagicLampEco/LAMP/blob/03d5c79373e402de229380d5907da00dc87abe68/Distribution/drip-pot/service/src/core/bytes.ts
// Copied verbatim at LAMP 03d5c79 (2026-11-12) except where a line says CHANGED. When LAMP changes this file, re-copy it.
// bytes.ts — hashing and hex helpers. One place, so every hash in the service is the same function.
import { blake2b } from "@noble/hashes/blake2b";
import { sha256 } from "@noble/hashes/sha256";

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

export function toHex(b: Uint8Array): string {
  return Buffer.from(b).toString("hex");
}

const HEX = /^(?:[0-9a-fA-F]{2})*$/;

/** Strict hex decode: odd length or a non-hex character throws (never truncates). */
export function fromHex(h: string): Uint8Array {
  if (typeof h !== "string" || !HEX.test(h)) throw new Error("not a hex string");
  return new Uint8Array(Buffer.from(h, "hex"));
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

export const blake2b256 = (b: Uint8Array): Uint8Array => blake2b(b, { dkLen: 32 });
export const blake2b224 = (b: Uint8Array): Uint8Array => blake2b(b, { dkLen: 28 });
export const sha256Bytes = (b: Uint8Array): Uint8Array => sha256(b);
export const sha256Hex = (b: Uint8Array | string): string => toHex(sha256(typeof b === "string" ? utf8(b) : b));

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
