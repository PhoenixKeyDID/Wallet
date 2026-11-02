/**
 * The web-page vault store answers when the browser has KEPT the write, not
 * when it has merely accepted it.
 *
 * A request's `success` fires inside a transaction that can still abort — a
 * full quota is the ordinary case — and the abort comes after. The fake below
 * is the smallest IndexedDB that lets a test choose what the commit does, so
 * each case says which of the two events the store is trusting.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { vaultStore, type StoredWallet } from "../storage";

type Outcome = "complete" | "abort" | "request-error" | "throw";

type FakeReq = {
  result?: unknown;
  error?: unknown;
  onsuccess?: () => void;
  onerror?: () => void;
};

function fakeIndexedDB(outcome: Outcome) {
  const closed: number[] = [];
  let opened = 0;
  const data = new Map<string, unknown>();
  const indexedDB = {
    open() {
      const id = ++opened;
      const db = {
        objectStoreNames: { contains: () => true },
        createObjectStore() {},
        close: () => closed.push(id),
        transaction() {
          const t: {
            error: unknown;
            oncomplete?: () => void;
            onabort?: () => void;
            onerror?: () => void;
            objectStore: () => unknown;
          } = {
            error: null,
            objectStore: () => ({
              put: (w: StoredWallet) => {
                // structured clone runs synchronously inside put()
                if (outcome === "throw") throw new Error("DataCloneError");
                return request(() => (data.set(w.id, w), w.id));
              },
              get: (k: string) => request(() => data.get(k)),
              getAll: () => request(() => [...data.values()]),
              delete: (k: string) => request(() => (data.delete(k), undefined)),
            }),
          };
          const request = (op: () => unknown) => {
            const r: FakeReq = {};
            setTimeout(() => {
              if (outcome === "request-error") {
                // Spec order (IndexedDB §5.10 then §5.5): the error event
                // reaches the request and bubbles to the transaction while
                // `transaction.error` is still null; only the abort that
                // follows sets it.
                r.error = new Error("ConstraintError");
                r.onerror?.();
                t.onerror?.();
                t.error = r.error;
                t.onabort?.();
                return;
              }
              r.result = op();
              r.onsuccess?.();
              // The commit is a separate, later step.
              setTimeout(() => {
                if (outcome === "abort") {
                  t.error = new Error("QuotaExceededError");
                  t.onabort?.();
                } else {
                  t.oncomplete?.();
                }
              }, 0);
            }, 0);
            return r;
          };
          return t;
        },
      };
      const req: FakeReq & { onupgradeneeded?: () => void } = { result: db };
      setTimeout(() => req.onsuccess?.(), 0);
      return req;
    },
  };
  return { indexedDB, closed, opened: () => opened };
}

const wallet = { id: "w1" } as StoredWallet;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("idb vault store", () => {
  it("a put the browser commits resolves, and the database is closed", async () => {
    const f = fakeIndexedDB("complete");
    vi.stubGlobal("indexedDB", f.indexedDB);
    await expect(vaultStore().put(wallet)).resolves.toBeUndefined();
    expect(f.closed).toEqual([1]);
  });

  it("a put whose commit aborts after the request succeeded rejects", async () => {
    const f = fakeIndexedDB("abort");
    vi.stubGlobal("indexedDB", f.indexedDB);
    await expect(vaultStore().put(wallet)).rejects.toThrow("QuotaExceededError");
    expect(f.closed).toEqual([1]);
  });

  it("a put whose request fails rejects and still closes the database", async () => {
    const f = fakeIndexedDB("request-error");
    vi.stubGlobal("indexedDB", f.indexedDB);
    await expect(vaultStore().put(wallet)).rejects.toThrow("ConstraintError");
    expect(f.closed).toEqual([1]);
  });

  it("a put that throws before any request exists rejects and still closes the database", async () => {
    const f = fakeIndexedDB("throw");
    vi.stubGlobal("indexedDB", f.indexedDB);
    await expect(vaultStore().put(wallet)).rejects.toThrow("DataCloneError");
    expect(f.closed).toEqual([1]);
  });

  it("a read hands out the value read inside the transaction", async () => {
    const f = fakeIndexedDB("complete");
    vi.stubGlobal("indexedDB", f.indexedDB);
    const store = vaultStore();
    await store.put(wallet);
    await expect(store.get("w1")).resolves.toEqual(wallet);
    await expect(store.list()).resolves.toEqual([wallet]);
    expect(f.closed).toEqual([1, 2, 3]);
  });

  it("a remove whose commit aborts rejects", async () => {
    const f = fakeIndexedDB("abort");
    vi.stubGlobal("indexedDB", f.indexedDB);
    await expect(vaultStore().remove("w1")).rejects.toThrow("QuotaExceededError");
  });
});
