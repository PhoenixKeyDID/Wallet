import { describe, it, expect } from "vitest";
import { encodeFrames, parseFrame, FrameCollector } from "../qr";

function randomBytesDet(n: number): Uint8Array {
  // deterministic pseudo-bytes (no real randomness needed for a framing test)
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31 + 7) & 0xff;
  return out;
}

describe("air-gap QR framing", () => {
  it("single frame round-trips", () => {
    const payload = randomBytesDet(120);
    const frames = encodeFrames(payload, "unsigned-tx", "abc123");
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
    const frames = encodeFrames(payload, "witness", "tx01", 700);
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
    const a = encodeFrames(randomBytesDet(1000), "unsigned-tx", "aaa", 700);
    const b = encodeFrames(randomBytesDet(1000), "unsigned-tx", "bbb", 700);
    const c = new FrameCollector();
    c.add(a[0]);
    expect(() => c.add(b[1])).toThrow();
  });

  it("rejects a bad id", () => {
    expect(() => encodeFrames(randomBytesDet(10), "witness", "bad id!")).toThrow();
  });
});
