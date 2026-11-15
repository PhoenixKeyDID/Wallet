/**
 * Which wallet window answers for which site, and which window owes the
 * answer to which request.
 *
 * Pure — no `chrome` — so the rules below are tested directly rather than
 * read off a service worker nobody can run in a test.
 *
 * ## A request belongs to the window it was sent to
 *
 * The first version kept one table per *origin*, numbered requests from 1 in
 * each new window, and matched an answer by `(origin, number)`. Two windows for
 * the same site — the old one left open behind the browser, a new one opened
 * after it — both numbered from 1, so the old window's answer to its request
 * #1 settled the new window's request #1. The site received a result for a
 * request nobody had approved, from a screen that had never shown it.
 *
 * So now:
 *
 * - **An id is unguessable and unique across the worker**, not a counter per
 *   window. Nothing can name a request it was not handed.
 * - **Every request remembers the port it was sent down**, and an answer
 *   arriving on any other port is dropped — even with the right id.
 * - **A closing window settles only its own requests**, and unregisters itself
 *   for its site only if it is still the window registered there. The old
 *   window closing must not tear down the new one.
 */

/** The part of a `chrome.runtime.Port` this file needs. */
export type WindowPort = { postMessage(m: unknown): void };

type Waiting = { port: WindowPort; settle: (result: unknown) => void };

/** What a window's request is settled with when the window goes away first. */
export type ClosedAnswer = () => unknown;

function randomId(): string {
  // `crypto.randomUUID` exists in service workers and in Node ≥19; a fallback
  // that used `Math.random` would be exactly the guessable id this replaces.
  return globalThis.crypto.randomUUID();
}

export function createRegistry(closedAnswer: ClosedAnswer, newId: () => string = randomId) {
  const windows = new Map<string, WindowPort>();
  const waiting = new Map<string, Waiting>();
  const attachWaiters = new Map<string, Set<(p: WindowPort) => void>>();

  return {
    /** A window announced it is the signer for `origin`. The newest one wins. */
    attach(origin: string, port: WindowPort): void {
      windows.set(origin, port);
      const ws = attachWaiters.get(origin);
      attachWaiters.delete(origin);
      for (const w of ws ?? []) w(port);
    },

    windowFor(origin: string): WindowPort | undefined {
      return windows.get(origin);
    },

    /**
     * Resolve once a window attaches for `origin`. Returns the cancel function
     * as well, so the caller can stop waiting when the window it opened is
     * closed before it ever said hello.
     */
    whenAttached(origin: string): { attached: Promise<WindowPort>; cancel: () => void } {
      let cb!: (p: WindowPort) => void;
      const attached = new Promise<WindowPort>((resolve) => {
        cb = resolve;
      });
      const set = attachWaiters.get(origin) ?? new Set();
      set.add(cb);
      attachWaiters.set(origin, set);
      return {
        attached,
        cancel: () => {
          attachWaiters.get(origin)?.delete(cb);
        },
      };
    },

    /** Send one request down `port`, and wait for that port's answer to it. */
    ask(port: WindowPort, origin: string, method: string, params: unknown[]): Promise<unknown> {
      let id = newId();
      // Unique within the worker, not just unlikely to collide.
      while (waiting.has(id)) id = newId();
      return new Promise((resolve) => {
        waiting.set(id, { port, settle: resolve });
        port.postMessage({ type: "request", id, origin, method, params });
      });
    },

    /**
     * An answer arrived on `port`. Settles the request only if that request was
     * sent down this same port; reports whether it did.
     */
    answer(port: WindowPort, id: unknown, result: unknown): boolean {
      if (typeof id !== "string") return false;
      const w = waiting.get(id);
      if (!w || w.port !== port) return false;
      waiting.delete(id);
      w.settle(result);
      return true;
    },

    /** `port` went away. Settle what it still owed; unregister it if current. */
    detach(port: WindowPort, origin: string | null): void {
      for (const [id, w] of waiting) {
        if (w.port !== port) continue;
        waiting.delete(id);
        w.settle(closedAnswer());
      }
      if (origin !== null && windows.get(origin) === port) windows.delete(origin);
    },

    /** For tests: how many requests are still owed an answer. */
    pendingCount(): number {
      return waiting.size;
    },
  };
}

export type Registry = ReturnType<typeof createRegistry>;
