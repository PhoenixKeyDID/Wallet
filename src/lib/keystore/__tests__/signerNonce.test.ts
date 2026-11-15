/**
 * The signing library, held to RFC 8032 byte for byte.
 *
 * `@stricahq/bip32ed25519` produces every witness this wallet makes. Two
 * properties of it are what keep a key secret, and neither is visible from the
 * outside of a passing signature:
 *
 * - the nonce `r` is `SHA-512(kR ‖ M)` — derived from the secret right half of
 *   the extended key, as RFC 8032 §5.1.6 does. A library that took `r` from the
 *   message alone would hand the private scalar to anyone holding two
 *   signatures (or, here, one: `a = (S − r)·h⁻¹`);
 * - signing the RFC's own test keys gives the RFC's own signatures.
 *
 * The version is pinned exactly in `package.json`; these tests are what a bump
 * has to get through.
 */
import { describe, it, expect } from "vitest";
import { Buffer } from "buffer";
import { createHash, randomBytes } from "node:crypto";
import { PrivateKey } from "@stricahq/bip32ed25519";

const L = (BigInt(1) << BigInt(252)) + BigInt("27742317777372353535851937790883648493");
const le = (b: Uint8Array) => BigInt("0x" + (Buffer.from(b).reverse().toString("hex") || "0"));
const sha512 = (...parts: Uint8Array[]) => createHash("sha512").update(Buffer.concat(parts.map((p) => Buffer.from(p)))).digest();

/** RFC 8032 §5.1.5 key expansion: SHA-512 of the seed, left half clamped. */
function expanded(seedHex: string): Buffer {
  const h = sha512(Buffer.from(seedHex, "hex"));
  h[0]! &= 248;
  h[31]! &= 127;
  h[31]! |= 64;
  return h;
}

function randomExtended(kR?: Buffer): Buffer {
  const kL = randomBytes(32);
  kL[0]! &= 248;
  kL[31]! &= 63;
  kL[31]! |= 64;
  return Buffer.concat([kL, kR ?? randomBytes(32)]);
}

describe("RFC 8032 §7.1 known answers, through the wallet's signing library", () => {
  const vectors = [
    {
      sk: "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
      pk: "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
      msg: "",
      sig: "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
    },
    {
      sk: "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb",
      pk: "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
      msg: "72",
      sig: "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00",
    },
  ];
  it.each(vectors)("signs pk $pk to the RFC's exact bytes", (v) => {
    const prv = new PrivateKey(expanded(v.sk));
    expect(prv.toPublicKey().toBytes().toString("hex")).toBe(v.pk);
    expect(Buffer.from(prv.sign(Buffer.from(v.msg, "hex"))).toString("hex")).toBe(v.sig);
  });
});

describe("the nonce comes from the secret half of the key, not from the message", () => {
  it("is deterministic for the same key and message", () => {
    const k = randomExtended();
    const msg = randomBytes(32);
    expect(Buffer.from(new PrivateKey(k).sign(msg)).equals(Buffer.from(new PrivateKey(k).sign(msg)))).toBe(true);
  });

  it("changes R when only kR changes — so R depends on a secret", () => {
    const k1 = randomExtended();
    const k2 = Buffer.concat([k1.subarray(0, 32), randomBytes(32)]);
    const msg = randomBytes(32);
    const r1 = Buffer.from(new PrivateKey(k1).sign(msg)).subarray(0, 32);
    const r2 = Buffer.from(new PrivateKey(k2).sign(msg)).subarray(0, 32);
    expect(r1.equals(r2)).toBe(false);
  });

  it("satisfies S = SHA-512(kR‖M) + h·a, and the message-only nonce recovers nothing", () => {
    const k = randomExtended();
    const msg = randomBytes(32);
    const prv = new PrivateKey(k);
    const sig = Buffer.from(prv.sign(msg));
    const pub = prv.toPublicKey().toBytes();
    const S = le(sig.subarray(32));
    const h = le(sha512(sig.subarray(0, 32), pub, msg)) % L;
    const a = le(k.subarray(0, 32)) % L;
    const rRfc = le(sha512(k.subarray(32), msg)) % L;
    expect((rRfc + h * a) % L).toBe(S);

    // The attack this rules out: assume r = SHA-512(M) and solve for a.
    const modpow = (b: bigint, x: bigint, m: bigint) => {
      let r = BigInt(1);
      b %= m;
      while (x > BigInt(0)) {
        if (x & BigInt(1)) r = (r * b) % m;
        b = (b * b) % m;
        x >>= BigInt(1);
      }
      return r;
    };
    const rNaive = le(sha512(msg)) % L;
    const recovered = ((((S - rNaive) % L) + L) % L) * modpow(h, L - BigInt(2), L) % L;
    expect(recovered === a).toBe(false);
  });
});
