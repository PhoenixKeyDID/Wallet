// VENDORED for tests only. Source: https://github.com/MagicLampEco/LAMP/blob/03d5c79373e402de229380d5907da00dc87abe68/Distribution/drip-pot/service/src/core/cbor.ts
// Copied verbatim at LAMP 03d5c79 (2026-11-12) except where a line says CHANGED. When LAMP changes this file, re-copy it.
// CHANGED: @ts-nocheck below — LAMP compiles this for ES2022 (bigint literals); this repo targets ES2017. It is type-checked in LAMP.
// @ts-nocheck
// cbor.ts — the small, strict CBOR subset COSE (CIP-8) needs. Definite lengths only, no floats,
// trailing bytes rejected: a wallet signature that does not parse exactly is refused, not repaired.

export type Cbor =
  | bigint
  | Uint8Array
  | string
  | Cbor[]
  | Map<Cbor, Cbor>
  | boolean
  | null
  | { tag: number; value: Cbor };

export class CborError extends Error {}

class Reader {
  pos = 0;
  constructor(readonly b: Uint8Array) {}
  byte(): number {
    if (this.pos >= this.b.length) throw new CborError("truncated");
    return this.b[this.pos++]!;
  }
  take(n: number): Uint8Array {
    if (this.pos + n > this.b.length) throw new CborError("truncated");
    const out = this.b.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  arg(info: number): bigint {
    if (info < 24) return BigInt(info);
    const len = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : -1;
    if (len < 0) throw new CborError(`unsupported additional info ${info} (indefinite length refused)`);
    let v = 0n;
    for (const x of this.take(len)) v = (v << 8n) | BigInt(x);
    return v;
  }
}

function small(n: bigint, what: string): number {
  if (n > 1_000_000n) throw new CborError(`${what} too long`);
  return Number(n);
}

function item(r: Reader, depth: number): Cbor {
  if (depth > 16) throw new CborError("nesting too deep");
  const ib = r.byte();
  const major = ib >> 5;
  const info = ib & 0x1f;
  switch (major) {
    case 0: return r.arg(info);
    case 1: return -1n - r.arg(info);
    case 2: return r.take(small(r.arg(info), "bytes"));
    case 3: {
      const raw = r.take(small(r.arg(info), "text"));
      return new TextDecoder("utf-8", { fatal: true }).decode(raw);
    }
    case 4: {
      const n = small(r.arg(info), "array");
      const out: Cbor[] = [];
      for (let i = 0; i < n; i++) out.push(item(r, depth + 1));
      return out;
    }
    case 5: {
      const n = small(r.arg(info), "map");
      const m = new Map<Cbor, Cbor>();
      for (let i = 0; i < n; i++) {
        const k = item(r, depth + 1);
        if (typeof k !== "bigint" && typeof k !== "string") throw new CborError("map key must be int or text");
        for (const existing of m.keys()) if (existing === k) throw new CborError("duplicate map key");
        m.set(k, item(r, depth + 1));
      }
      return m;
    }
    case 6: return { tag: Number(r.arg(info)), value: item(r, depth + 1) };
    case 7:
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22) return null;
      throw new CborError(`unsupported simple/float value ${info}`);
    default:
      throw new CborError("unreachable major type");
  }
}

/** Decode exactly one item; trailing bytes are an error. */
export function decodeCbor(bytes: Uint8Array): Cbor {
  const r = new Reader(bytes);
  const v = item(r, 0);
  if (r.pos !== bytes.length) throw new CborError(`${bytes.length - r.pos} trailing byte(s)`);
  return v;
}

function head(major: number, n: bigint): number[] {
  if (n < 0n) throw new CborError("negative length");
  if (n < 24n) return [(major << 5) | Number(n)];
  const bytes = n < 0x100n ? 1 : n < 0x10000n ? 2 : n < 0x100000000n ? 4 : 8;
  const out = [(major << 5) | (bytes === 1 ? 24 : bytes === 2 ? 25 : bytes === 4 ? 26 : 27)];
  for (let i = bytes - 1; i >= 0; i--) out.push(Number((n >> BigInt(8 * i)) & 0xffn));
  return out;
}

/** Deterministic encoder for the same subset (map keys kept in insertion order). */
export function encodeCbor(v: Cbor): Uint8Array {
  const out: number[] = [];
  const go = (x: Cbor): void => {
    if (typeof x === "bigint") { out.push(...(x >= 0n ? head(0, x) : head(1, -1n - x))); return; }
    if (x instanceof Uint8Array) { out.push(...head(2, BigInt(x.length)), ...x); return; }
    if (typeof x === "string") { const t = new TextEncoder().encode(x); out.push(...head(3, BigInt(t.length)), ...t); return; }
    if (Array.isArray(x)) { out.push(...head(4, BigInt(x.length))); x.forEach(go); return; }
    if (x instanceof Map) { out.push(...head(5, BigInt(x.size))); for (const [k, val] of x) { go(k); go(val); } return; }
    if (x === true) { out.push(0xf5); return; }
    if (x === false) { out.push(0xf4); return; }
    if (x === null) { out.push(0xf6); return; }
    out.push(...head(6, BigInt(x.tag))); go(x.value);
  };
  go(v);
  return new Uint8Array(out);
}
