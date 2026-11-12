/**
 * The worker's table of who owes which answer, attacked the way it was broken.
 *
 * The reported path: two wallet windows for the same site, both numbering
 * requests from 1. The old window's answer to its #1 settled the new window's
 * #1, and the site received a result for a request no screen had shown.
 */
import { describe, it, expect } from "vitest";
import { createRegistry, type WindowPort } from "../pending";

type Sent = { type: string; id: string; origin: string; method: string; params: unknown[] };

function fakePort(): WindowPort & { sent: Sent[] } {
  const sent: Sent[] = [];
  return { sent, postMessage: (m: unknown) => void sent.push(m as Sent) };
}

const CLOSED = { ok: false, closed: true };
const ORIGIN = "https://dex.example";

/** Resolves to "pending" if `p` has not settled after the microtask queue drains. */
async function state<T>(p: Promise<T>): Promise<T | "pending"> {
  return Promise.race([p, new Promise<"pending">((r) => setTimeout(() => r("pending"), 0))]);
}

describe("pending requests belong to the window they were sent to", () => {
  it("an old window cannot answer a request sent to the new window, even with its id", async () => {
    const reg = createRegistry(() => CLOSED);
    const oldWin = fakePort();
    const newWin = fakePort();
    reg.attach(ORIGIN, oldWin);
    reg.attach(ORIGIN, newWin);

    const p = reg.ask(newWin, ORIGIN, "signTx", ["84a4"]);
    const id = newWin.sent[0]!.id;

    // The old window replays the id — the exact thing the per-origin table let through.
    expect(reg.answer(oldWin, id, { ok: true, value: "forged" })).toBe(false);
    expect(await state(p)).toBe("pending");

    expect(reg.answer(newWin, id, { ok: true, value: "real" })).toBe(true);
    expect(await p).toEqual({ ok: true, value: "real" });
  });

  it("the second window does not restart numbering: ids never repeat across windows", () => {
    const reg = createRegistry(() => CLOSED);
    const a = fakePort();
    const b = fakePort();
    reg.attach(ORIGIN, a);
    void reg.ask(a, ORIGIN, "getUtxos", []);
    reg.attach(ORIGIN, b);
    void reg.ask(b, ORIGIN, "getUtxos", []);
    expect(a.sent[0]!.id).not.toBe(b.sent[0]!.id);
    // Not a counter: a page or a stale window cannot guess the next one.
    for (const id of [a.sent[0]!.id, b.sent[0]!.id]) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });

  it("a colliding id from the generator is re-drawn, never shared by two requests", () => {
    const ids = ["same", "same", "other"];
    const reg = createRegistry(() => CLOSED, () => ids.shift()!);
    const a = fakePort();
    void reg.ask(a, ORIGIN, "getUtxos", []);
    void reg.ask(a, ORIGIN, "getBalance", []);
    expect(a.sent.map((m) => m.id)).toEqual(["same", "other"]);
  });

  it("closing the old window settles only its own requests and leaves the new one registered", async () => {
    const reg = createRegistry(() => CLOSED);
    const oldWin = fakePort();
    const newWin = fakePort();
    reg.attach(ORIGIN, oldWin);
    const oldReq = reg.ask(oldWin, ORIGIN, "getUtxos", []);
    reg.attach(ORIGIN, newWin);
    const newReq = reg.ask(newWin, ORIGIN, "signTx", ["84a4"]);

    reg.detach(oldWin, ORIGIN);

    expect(await oldReq).toEqual(CLOSED);
    expect(await state(newReq)).toBe("pending");
    expect(reg.windowFor(ORIGIN)).toBe(newWin);
  });

  it("closing the current window unregisters it and settles what it owed", async () => {
    const reg = createRegistry(() => CLOSED);
    const w = fakePort();
    reg.attach(ORIGIN, w);
    const p = reg.ask(w, ORIGIN, "signTx", ["84a4"]);
    reg.detach(w, ORIGIN);
    expect(await p).toEqual(CLOSED);
    expect(reg.windowFor(ORIGIN)).toBeUndefined();
    expect(reg.pendingCount()).toBe(0);
  });

  it("an answer is used once: a replay of a settled id does nothing", async () => {
    const reg = createRegistry(() => CLOSED);
    const w = fakePort();
    const p = reg.ask(w, ORIGIN, "getUtxos", []);
    const id = w.sent[0]!.id;
    expect(reg.answer(w, id, { ok: true, value: 1 })).toBe(true);
    expect(reg.answer(w, id, { ok: true, value: 2 })).toBe(false);
    expect(await p).toEqual({ ok: true, value: 1 });
  });

  it("whenAttached resolves with the window that says hello, and cancel stops it", async () => {
    const reg = createRegistry(() => CLOSED);
    const w = fakePort();
    const waiting = reg.whenAttached(ORIGIN);
    const cancelled = reg.whenAttached(ORIGIN);
    cancelled.cancel();
    reg.attach(ORIGIN, w);
    expect(await waiting.attached).toBe(w);
    expect(await state(cancelled.attached)).toBe("pending");
  });
});
