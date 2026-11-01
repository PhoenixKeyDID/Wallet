import { describe, it, expect } from "vitest";
import { encodeFrames, parseFrame, frameId, FrameCollector, FRAME_ID_HEX_LEN } from "../qr";

const ID_A = "a".repeat(32);
const ID_B = "b".repeat(32);

function randomBytesDet(n: number): Uint8Array {
  // deterministic pseudo-bytes (no real randomness needed for a framing test)
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31 + 7) & 0xff;
  return out;
}

describe("air-gap QR framing", () => {
  it("single frame round-trips", () => {
    const payload = randomBytesDet(120);
    const frames = encodeFrames(payload, "unsigned-tx", frameId(payload));
    expect(frames).toHaveLength(1);
    const c = new FrameCollector();
    const st = c.add(frames[0]);
    expect(st.done).toBe(true);
    const { kind, payload: got } = c.assemble();
    expect(kind).toBe("unsigned-tx");
    expect([...got]).toEqual([...payload]);
  });

  it("multi-frame chunking reassembles in any order", () => {
    const payload = randomBytesDet(1800);
    const frames = encodeFrames(payload, "witness", ID_A, 700);
    expect(frames.length).toBe(3);
    const c = new FrameCollector();
    // add out of order
    c.add(frames[2]);
    c.add(frames[0]);
    const st = c.add(frames[1]);
    expect(st).toEqual({ done: true, received: 3, total: 3 });
    const { payload: got } = c.assemble();
    expect([...got]).toEqual([...payload]);
  });

  it("parseFrame rejects non-PHXAIR text", () => {
    expect(() => parseFrame("hello world")).toThrow();
  });

  it("rejects mixing frames from different transfers", () => {
    const a = encodeFrames(randomBytesDet(1000), "witness", ID_A, 700);
    const b = encodeFrames(randomBytesDet(1000), "witness", ID_B, 700);
    const c = new FrameCollector();
    c.add(a[0]);
    expect(() => c.add(b[1])).toThrow();
  });

  it("rejects a bad id", () => {
    expect(() => encodeFrames(randomBytesDet(10), "witness", "bad id!")).toThrow();
  });

  it("frameId is 128 bits: 32 lowercase hex chars", () => {
    expect(FRAME_ID_HEX_LEN).toBe(32);
    expect(frameId(randomBytesDet(50))).toMatch(/^[0-9a-f]{32}$/);
  });

  it("refuses any id that is not exactly 32 hex chars — no 8-char fallback", () => {
    const payload = randomBytesDet(200);
    const full = frameId(payload);
    const good = encodeFrames(payload, "unsigned-tx", full)[0];
    expect(parseFrame(good).id).toBe(full);
    // The old 8-char tag of the same payload is still a prefix of its hash, and still refused.
    for (const id of [full.slice(0, 8), full.slice(0, 31), full + "0", full.toUpperCase()]) {
      expect(() => encodeFrames(payload, "witness", id)).toThrow(/32 lowercase hex/);
      expect(() => parseFrame(good.replace(`|${full}|`, `|${id}|`))).toThrow(/32 lowercase hex/);
    }
  });

  it("forces an unsigned-tx id to be frameId(payload) (integrity binding)", () => {
    const payload = randomBytesDet(200);
    // A well-formed id that is not frameId(payload) is rejected for the spend path.
    expect(ID_A).not.toBe(frameId(payload));
    expect(() => encodeFrames(payload, "unsigned-tx", ID_A)).toThrow(/integrity tag/);
    // The correct id is accepted.
    expect(encodeFrames(payload, "unsigned-tx", frameId(payload))).toHaveLength(1);
  });

  it("assemble() rejects a tampered unsigned-tx chunk", () => {
    const payload = randomBytesDet(1500);
    const id = frameId(payload);
    const frames = encodeFrames(payload, "unsigned-tx", id, 700);
    expect(frames.length).toBe(3);
    // Forge a chunk for seq 1 that keeps the header (same id/total) but swaps the
    // body for GENUINELY DIFFERENT bytes — the per-seq overwrite guard is bypassed
    // because this seq is still unseen when the forged frame arrives.
    const otherBytes = randomBytesDet(1500).map((b) => b ^ 0xff);
    const tampered = encodeFrames(otherBytes, "witness", id, 700)[1]
      .replace("|witness|", "|unsigned-tx|");
    const c = new FrameCollector();
    c.add(frames[0]);
    c.add(tampered); // accepted at add() — integrity is only checkable once whole
    c.add(frames[2]);
    expect(() => c.assemble()).toThrow(/integrity check/);
  });
});
