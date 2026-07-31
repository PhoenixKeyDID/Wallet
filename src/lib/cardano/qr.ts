/**
 * Air-gap QR framing (multi-part) for offline co-signing.
 *
 * The online browser holds only the watch-only key; to spend, it shows an
 * UNSIGNED transaction as animated QR frames, the offline device (holding the
 * seed) signs and shows back a witness QR, and the browser assembles + submits.
 * No secret ever crosses the air gap — only unsigned-tx CBOR and vkey witnesses
 * (`PhoenixKey-DappConnector-Feat §C.4`, `Rebirthme-Tech:268`).
 *
 * This module is the transport contract shared with the PhoenixKey mobile signer
 * (see inbox letter to MobileCore). It is standalone and does not enable signing
 * on its own — the mobile counterpart must ship first (phase 2).
 *
 * Frame text format (one QR each), pipe-delimited so it is human-inspectable:
 *   PHXAIR|<v>|<kind>|<seq>|<total>|<id>|<b64url-chunk>
 *
 * INTEGRITY: for an `unsigned-tx` transfer the `<id>` is NOT a free label — it
 * is `frameId(payload)` = `blake2b_256(payload)` truncated to 8 hex chars. The
 * receiver recomputes it after reassembling and rejects the payload on any
 * mismatch, so an injected or reordered chunk cannot assemble into a DIFFERENT
 * transaction than the one the sender framed. `witness` frames reuse that same
 * id only to correlate the reply (a witness is verified by the ledger, not by
 * this tag), so their id is not self-checked.
 */
import { blake2b256, toHex } from "./hash";

const MAGIC = "PHXAIR";
const VERSION = 1;

export type AirKind = "unsigned-tx" | "witness";

export type AirFrame = {
  version: number;
  kind: AirKind;
  seq: number;
  total: number;
  /** short transfer id tying frames of one payload together. */
  id: string;
  chunk: string;
};

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Integrity tag for a payload: first 8 hex chars of its blake2b-256 hash. */
export function frameId(payload: Uint8Array): string {
  return toHex(blake2b256(payload)).slice(0, 8);
}

/**
 * Split a CBOR payload into QR frames. For an `unsigned-tx` transfer `id` MUST
 * equal `frameId(payload)` (the integrity binding — see the module header); for
 * a `witness` transfer it is the correlation tag echoing the unsigned-tx's id.
 * `chunkBytes` bounds each frame's raw payload so the encoded QR stays
 * comfortably scannable (~700 bytes → medium QR at ECC-M).
 */
export function encodeFrames(
  payload: Uint8Array,
  kind: AirKind,
  id: string,
  chunkBytes = 700,
): string[] {
  if (!/^[0-9a-zA-Z]{1,16}$/.test(id)) throw new Error("air-gap id must be 1–16 alphanumerics");
  if (kind === "unsigned-tx" && id !== frameId(payload)) {
    throw new Error("unsigned-tx id must be frameId(payload) — integrity tag mismatch");
  }
  const total = Math.max(1, Math.ceil(payload.length / chunkBytes));
  const frames: string[] = [];
  for (let seq = 0; seq < total; seq++) {
    const slice = payload.subarray(seq * chunkBytes, (seq + 1) * chunkBytes);
    frames.push(`${MAGIC}|${VERSION}|${kind}|${seq}|${total}|${id}|${b64urlEncode(slice)}`);
  }
  return frames;
}

/** Parse one QR frame; throws on a frame that is not a PHXAIR frame. */
export function parseFrame(text: string): AirFrame {
  const parts = text.trim().split("|");
  if (parts.length !== 7 || parts[0] !== MAGIC) throw new Error("not a PHXAIR frame");
  const [, vStr, kind, seqStr, totalStr, id, chunk] = parts;
  const version = Number(vStr);
  if (version !== VERSION) throw new Error(`unsupported PHXAIR version ${vStr}`);
  if (kind !== "unsigned-tx" && kind !== "witness") throw new Error(`unknown kind ${kind}`);
  return { version, kind, seq: Number(seqStr), total: Number(totalStr), id, chunk };
}

/**
 * Accumulate scanned frames of one payload. Feed frames as they are scanned;
 * `done` flips true once every seq 0..total-1 for the same `id` is present.
 */
export class FrameCollector {
  private id: string | null = null;
  private kind: AirKind | null = null;
  private total = 0;
  private chunks = new Map<number, string>();

  add(text: string): { done: boolean; received: number; total: number } {
    const f = parseFrame(text);
    if (!Number.isInteger(f.seq) || !Number.isInteger(f.total) || f.total < 1) {
      throw new Error("frame has an invalid seq/total");
    }
    if (f.seq < 0 || f.seq >= f.total) throw new Error("frame seq out of range");
    if (this.id === null) {
      this.id = f.id;
      this.kind = f.kind;
      this.total = f.total;
    } else if (f.id !== this.id || f.kind !== this.kind || f.total !== this.total) {
      // Every frame of one transfer must agree on id, kind and total; a mismatch
      // means a stray/hostile frame — refuse it rather than silently merge.
      throw new Error("frame does not match the transfer in progress");
    }
    const existing = this.chunks.get(f.seq);
    if (existing !== undefined && existing !== f.chunk) {
      throw new Error(`conflicting data for frame ${f.seq}`);
    }
    this.chunks.set(f.seq, f.chunk);
    return { done: this.chunks.size === this.total, received: this.chunks.size, total: this.total };
  }

  /** Assemble the full payload once `done`; throws if any frame is missing. */
  assemble(): { kind: AirKind; payload: Uint8Array } {
    if (this.id === null || this.chunks.size !== this.total) {
      throw new Error("cannot assemble: frames still missing");
    }
    const parts: Uint8Array[] = [];
    for (let i = 0; i < this.total; i++) {
      const c = this.chunks.get(i);
      if (c === undefined) throw new Error(`missing frame ${i}`);
      parts.push(b64urlDecode(c));
    }
    const len = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(len);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.length;
    }
    // Integrity gate: for the spend path (unsigned-tx) the id is a hash of the
    // payload, so a tampered/injected chunk that survived reassembly is caught
    // here — the reassembled bytes must hash back to the id the sender framed.
    if (this.kind === "unsigned-tx" && frameId(out) !== this.id) {
      throw new Error("assembled payload fails its integrity check (id mismatch)");
    }
    return { kind: this.kind!, payload: out };
  }
}
