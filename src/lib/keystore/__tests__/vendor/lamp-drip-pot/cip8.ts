// VENDORED for tests only. Source: https://github.com/MagicLampEco/LAMP/blob/03d5c79373e402de229380d5907da00dc87abe68/Distribution/drip-pot/service/src/core/cip8.ts
// Copied verbatim at LAMP 03d5c79 (2026-11-12) except where a line says CHANGED. When LAMP changes this file, re-copy it.
// CHANGED: @ts-nocheck below — LAMP compiles this for ES2022 (bigint literals); this repo targets ES2017. It is type-checked in LAMP.
// @ts-nocheck
// cip8.ts — verify a CIP-30 `signData` result (COSE_Sign1 + COSE_Key, CIP-8) made by a STAKE key
// (SERVICE.md §3.2.2 steps 3–5). Every check fails closed with DRIPSVC-SIG-INVALID and a reason.
// CHANGED: the wallet does not depend on @noble/curves; ./ed25519.ts is a node:crypto (OpenSSL) RFC 8032 verifier with the same call shape.
import { ed25519 } from "./ed25519.js";

import { blake2b224, bytesEqual, fromHex, toHex } from "./bytes.js";
import { CborError, decodeCbor, encodeCbor, type Cbor } from "./cbor.js";
import { fail } from "./errors.js";

const ALG = 1n;
const ALG_EDDSA = -8n;
const KTY = 1n;
const KTY_OKP = 1n;
const CRV = -1n;
const CRV_ED25519 = 6n;
const X = -2n;

function sigInvalid(why: string): never {
  fail("DRIPSVC-SIG-INVALID", `chữ ký không hợp lệ: ${why}.`);
}

function asMap(v: Cbor, what: string): Map<Cbor, Cbor> {
  if (!(v instanceof Map)) sigInvalid(`${what} không phải CBOR map`);
  return v;
}

function decodeHex(hex: unknown, what: string): Cbor {
  if (typeof hex !== "string" || hex.length === 0 || hex.length > 8192) sigInvalid(`${what} phải là chuỗi hex`);
  let bytes: Uint8Array;
  try { bytes = fromHex(hex); } catch { sigInvalid(`${what} không phải hex`); }
  try { return decodeCbor(bytes); } catch (e) {
    sigInvalid(`${what} không giải được CBOR (${e instanceof CborError ? e.message : "lỗi"})`);
  }
}

/** Parsed COSE_Key: the Ed25519 public key `x`. */
export function parseCoseKey(keyHex: unknown): Uint8Array {
  const m = asMap(decodeHex(keyHex, "key"), "COSE_Key");
  if (m.get(KTY) !== KTY_OKP) sigInvalid("COSE_Key kty phải là OKP");
  if (m.get(CRV) !== CRV_ED25519) sigInvalid("COSE_Key crv phải là Ed25519");
  const alg = m.get(3n);
  if (alg !== undefined && alg !== ALG_EDDSA) sigInvalid("COSE_Key alg phải là EdDSA nếu có");
  const x = m.get(X);
  if (!(x instanceof Uint8Array) || x.length !== 32) sigInvalid("COSE_Key thiếu x 32 byte");
  return x;
}

export interface Cip8Expect {
  /** Raw reward-address bytes of `subject` (header + 28-byte stake key hash). */
  rewardAddressHex: string;
  /** Hash of the stake key credential of `subject`. */
  stakeKeyHash: string;
  /** Exact payload: utf8(message) rebuilt by the server. */
  payload: Uint8Array;
}

/**
 * §3.2.2 steps 3 → 5, in order, stop at the first failure. Returns the verified public key (hex)
 * so the journal can keep it as evidence.
 */
export function verifyCip8(signatureHex: unknown, keyHex: unknown, want: Cip8Expect): string {
  // 3. COSE_Key ⇒ blake2b_224(x) == stake key hash of `subject`.
  const x = parseCoseKey(keyHex);
  if (toHex(blake2b224(x)) !== want.stakeKeyHash.toLowerCase()) {
    sigInvalid("khoá ký không phải stake key của subject (blake2b_224(x) lệch)");
  }

  // 4. COSE_Sign1 headers + payload.
  let s = decodeHex(signatureHex, "signature");
  if (typeof s === "object" && s !== null && !(s instanceof Map) && !(s instanceof Uint8Array) && !Array.isArray(s)) {
    if (s.tag !== 18) sigInvalid(`COSE tag ${s.tag} không phải COSE_Sign1 (18)`);
    s = s.value;
  }
  if (!Array.isArray(s) || s.length !== 4) sigInvalid("COSE_Sign1 phải là mảng 4 phần tử");
  const [protectedBstr, unprotected, payload, signature] = s as [Cbor, Cbor, Cbor, Cbor];
  if (!(protectedBstr instanceof Uint8Array)) sigInvalid("header bảo vệ phải là bstr");
  let prot: Map<Cbor, Cbor>;
  try { prot = asMap(decodeCbor(protectedBstr), "header bảo vệ"); } catch (e) {
    if (e instanceof CborError) sigInvalid("header bảo vệ không giải được");
    throw e;
  }
  const unprot = asMap(unprotected, "header không bảo vệ");
  if (prot.get(ALG) !== ALG_EDDSA) sigInvalid("header bảo vệ alg phải là EdDSA");
  const addr = prot.get("address");
  if (!(addr instanceof Uint8Array) || !bytesEqual(addr, fromHex(want.rewardAddressHex))) {
    sigInvalid("header address không bằng hệt địa chỉ reward của subject");
  }
  for (const h of [prot, unprot]) {
    const hashed = h.get("hashed");
    if (hashed !== undefined && hashed !== false) sigInvalid("header hashed phải vắng hoặc false");
  }
  if (!(payload instanceof Uint8Array)) sigInvalid("payload vắng (detached) — không nhận");
  if (!bytesEqual(payload, want.payload)) sigInvalid("payload không bằng hệt thông điệp máy chủ đã cấp");
  if (!(signature instanceof Uint8Array) || signature.length !== 64) sigInvalid("chữ ký Ed25519 phải 64 byte");

  // 5. Ed25519 over Sig_structure = ["Signature1", protected, h'', payload].
  const toSign = encodeCbor(["Signature1", protectedBstr, new Uint8Array(0), payload]);
  let ok = false;
  try { ok = ed25519.verify(signature, toSign, x, { zip215: false }); } catch { ok = false; }
  if (!ok) sigInvalid("Ed25519 không khớp");
  return toHex(x);
}
