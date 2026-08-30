/**
 * Where the vault sits at rest.
 *
 * Two backends, one interface, because this wallet ships in two places and the
 * key material must not care which:
 *
 * - **Browser extension** → `chrome.storage.local`. Preferred when present:
 *   it lives in the extension's own origin, which page scripts cannot reach.
 * - **Web page** → IndexedDB.
 *
 * Not `localStorage`, in either case. It is synchronous (so a big encrypted
 * blob blocks the main thread), it is string-only, and — the reason that
 * actually matters — it is the first place every credential-stealing script
 * looks, because it is trivially enumerable in one line. IndexedDB is no
 * stronger a boundary in principle, but it is not the default target, and on
 * an extension the origin separation is a real boundary rather than a
 * cosmetic one.
 *
 * Nothing here is a substitute for the vault's own encryption. Storage is
 * assumed readable by an attacker who reaches the machine; the password is
 * what stands between them and the key.
 */
import type { Vault } from "./vault";

const DB_NAME = "phoenix-wallet";
const STORE = "vaults";
const DB_VERSION = 1;

/** A stored wallet: the encrypted vault plus non-secret display metadata. */
export type StoredWallet = {
  id: string;
  label: string;
  vault: Vault;
  /** Cached so the list can render before anything is unlocked. */
  firstAddress: string;
  network: number;
  createdAt: string;
};

export interface VaultStore {
  list(): Promise<StoredWallet[]>;
  get(id: string): Promise<StoredWallet | undefined>;
  put(w: StoredWallet): Promise<void>;
  remove(id: string): Promise<void>;
}

// ─── chrome.storage.local (extension) ─────────────────────────────────────────

type ChromeLike = {
  storage?: {
    local?: {
      get(keys: string | string[] | null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
    };
  };
};

/**
 * Extension pages are served from their own scheme. This is the one thing a
 * script running in a web page cannot forge: it can define `globalThis.chrome`,
 * it can define `chrome.runtime.id`, it can hand back any object it likes — but
 * it cannot change the document's own protocol.
 *
 * That matters because the previous rule was "does `chrome.storage.local`
 * exist". A script on any page could satisfy it with six lines, and two things
 * followed. The vault got written into the attacker's object instead of
 * IndexedDB, handing over the encrypted blob to grind the password offline. And
 * `isExtensionContext()` returned true, which is what suppresses the "this is a
 * web page, an unlocked key is reachable by any script here" warning — so the
 * UI reassured the user in exactly the case the warning exists for.
 *
 * The API check stays as well, because the scheme alone does not prove the
 * storage API is present. It is the scheme that carries the security weight.
 */
const EXTENSION_PROTOCOLS = new Set([
  "chrome-extension:",
  "moz-extension:",
  "safari-web-extension:",
  "ms-browser-extension:",
]);

function inExtensionOrigin(): boolean {
  const proto = (globalThis as { location?: { protocol?: string } }).location?.protocol;
  return typeof proto === "string" && EXTENSION_PROTOCOLS.has(proto);
}

function chromeLocal() {
  if (!inExtensionOrigin()) return undefined;
  const c = (globalThis as unknown as { chrome?: ChromeLike; browser?: ChromeLike });
  return c.browser?.storage?.local ?? c.chrome?.storage?.local;
}

const CHROME_KEY = "phoenix.wallets";

function chromeStore(): VaultStore {
  const area = chromeLocal()!;
  const all = async (): Promise<Record<string, StoredWallet>> => {
    const got = await area.get(CHROME_KEY);
    return (got[CHROME_KEY] as Record<string, StoredWallet> | undefined) ?? {};
  };
  return {
    async list() {
      return Object.values(await all());
    },
    async get(id) {
      return (await all())[id];
    },
    async put(w) {
      const map = await all();
      map[w.id] = w;
      await area.set({ [CHROME_KEY]: map });
    },
    async remove(id) {
      const map = await all();
      delete map[id];
      await area.set({ [CHROME_KEY]: map });
    },
  };
}

// ─── IndexedDB (web page) ─────────────────────────────────────────────────────

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexeddb_open_failed"));
  });
}

function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = run(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error("indexeddb_request_failed"));
        t.oncomplete = () => db.close();
      }),
  );
}

function idbStore(): VaultStore {
  return {
    list: () => tx<StoredWallet[]>("readonly", (s) => s.getAll() as IDBRequest<StoredWallet[]>),
    get: (id) => tx<StoredWallet | undefined>("readonly", (s) => s.get(id)),
    put: (w) => tx("readwrite", (s) => s.put(w)).then(() => undefined),
    remove: (id) => tx("readwrite", (s) => s.delete(id)).then(() => undefined),
  };
}

// ─── in-memory (SSR and tests) ────────────────────────────────────────────────

function memoryStore(): VaultStore {
  const map = new Map<string, StoredWallet>();
  return {
    async list() {
      return [...map.values()];
    },
    async get(id) {
      return map.get(id);
    },
    async put(w) {
      map.set(w.id, w);
    },
    async remove(id) {
      map.delete(id);
    },
  };
}

/**
 * Pick a backend. Extension storage wins where it exists; a page with no
 * IndexedDB (server render, a locked-down browser) gets a memory store that
 * forgets on reload rather than throwing — the UI reports "no wallet saved",
 * which is true, instead of crashing.
 */
export function vaultStore(): VaultStore {
  if (chromeLocal()) return chromeStore();
  if (typeof indexedDB !== "undefined") return idbStore();
  return memoryStore();
}

/**
 * True when running inside a browser extension rather than a web page.
 *
 * Answered from the document's own scheme, not from whether an object called
 * `chrome` happens to exist — see `inExtensionOrigin` above for why the second
 * question has a different answer than it looks like it has.
 */
export function isExtensionContext(): boolean {
  return Boolean(chromeLocal());
}

/** Opaque id for a new wallet — display only, never key material. */
export function newWalletId(): string {
  const b = crypto.getRandomValues(new Uint8Array(8));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
