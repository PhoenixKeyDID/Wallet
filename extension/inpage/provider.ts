/**
 * `window.cardano.phoenix` — what a dApp sees.
 *
 * This file runs in the **page's** world, not the extension's, which is the
 * whole reason it is a separate bundle: `window.cardano` has to be reachable by
 * the site's own JavaScript, and a content script's isolated world is not. That
 * also means every line here is standing in hostile territory. The page can
 * redefine `Object`, `Promise`, `Array.prototype.map`, `postMessage` — anything.
 *
 * So this file holds **no secrets and makes no decisions**. It is a letterbox.
 * Every question of "is this allowed" is answered in the background worker,
 * against an origin the browser reports and this file cannot influence. The
 * worst a hostile page can do to the code below is lie to itself.
 *
 * Two habits follow from that, and both look like paranoia until you need them:
 * primitives are captured at load time, before the page has run; and replies
 * are matched by an id the page never sees, so a page that echoes our own
 * messages back cannot resolve its own request.
 */
import {
  CHANNEL,
  API_ERROR,
  type ApiError,
  type Response as RpcResponse,
} from "../src/rpc/protocol";

// Captured now, at `document_start`, before any page script has had a chance to
// replace them. Reaching for `window.postMessage` later would be reaching for
// whatever the page has since put there.
const post = window.postMessage.bind(window);
const addListener = window.addEventListener.bind(window);
const removeListener = window.removeEventListener.bind(window);
const randomUUID =
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID.bind(crypto)
    : null;
const getRandomValues =
  typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function"
    ? crypto.getRandomValues.bind(crypto)
    : null;

/**
 * A request id the page cannot guess.
 *
 * Not decoration. Messages travel over `window.postMessage`, which the page can
 * both read and send — so a counter would let a page answer our own pending
 * request with a value of its choosing, before the extension replies. It would
 * be answering itself, which changes nothing about what the wallet does; but it
 * would let a page fake "the user approved" to its own UI, and a screenshot of
 * that is a convincing thing to show someone.
 */
let counter = 0;
function newId(): string {
  if (randomUUID) return randomUUID();
  if (getRandomValues) {
    const b = getRandomValues(new Uint8Array(16));
    let s = "";
    for (const x of b) s += x.toString(16).padStart(2, "0");
    return s;
  }
  // No crypto at all: still unique within this page, just not unguessable.
  counter += 1;
  return `f${counter}-${String(Date.now())}`;
}

class PhoenixApiError extends Error {
  code: number;
  info: string;
  constructor(err: ApiError) {
    super(err.info);
    this.name = "PhoenixApiError";
    this.code = err.code;
    this.info = err.info;
  }
}

const pending = new Map<string, { resolve(v: unknown): void; reject(e: unknown): void }>();

addListener("message", (ev: MessageEvent) => {
  // `source !== window` filters out frames and other windows; the content
  // script relays into this window, so anything from elsewhere is not ours.
  if (ev.source !== window) return;
  const d = ev.data as Partial<RpcResponse> | null;
  if (!d || typeof d !== "object" || d.channel !== CHANNEL || d.kind !== "res") return;
  if (typeof d.id !== "string") return;
  const slot = pending.get(d.id);
  if (!slot) return;
  pending.delete(d.id);
  if (d.ok) slot.resolve((d as { value: unknown }).value);
  else slot.reject(new PhoenixApiError((d as { error: ApiError }).error));
});

/**
 * Send one request and wait.
 *
 * No timeout, on purpose. The thing on the other end of a `signTx` is a person
 * reading a screen, and there is no number of seconds after which "they are
 * still deciding" becomes "this failed". A dApp that wants to give up can stop
 * awaiting; a wallet that gives up on the user's behalf has thrown away an
 * answer they were in the middle of giving.
 */
function call(method: string, params: unknown[]): Promise<unknown> {
  const id = newId();
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      post({ channel: CHANNEL, kind: "req", id, method, params }, "*");
    } catch (e) {
      pending.delete(id);
      reject(
        new PhoenixApiError({
          code: API_ERROR.InternalError,
          info: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  });
}

/** The object handed back by `enable()`: CIP-30's full API surface. */
function buildApi() {
  const api = {
    getNetworkId: () => call("getNetworkId", []) as Promise<number>,
    getUtxos: (amount?: string, paginate?: unknown) =>
      call("getUtxos", [amount, paginate]) as Promise<string[] | undefined>,
    getCollateral: (params?: unknown) =>
      call("getCollateral", [params]) as Promise<string[] | undefined>,
    getBalance: () => call("getBalance", []) as Promise<string>,
    getUsedAddresses: (paginate?: unknown) =>
      call("getUsedAddresses", [paginate]) as Promise<string[]>,
    getUnusedAddresses: () => call("getUnusedAddresses", []) as Promise<string[]>,
    getChangeAddress: () => call("getChangeAddress", []) as Promise<string>,
    getRewardAddresses: () => call("getRewardAddresses", []) as Promise<string[]>,
    signTx: (tx: string, partialSign?: boolean) =>
      call("signTx", [tx, partialSign === true]) as Promise<string>,
    signData: (addr: string, payload: string) =>
      call("signData", [addr, payload]) as Promise<{ signature: string; key: string }>,
    submitTx: (tx: string) => call("submitTx", [tx]) as Promise<string>,
    experimental: {},
  };
  return api;
}

const wallet = {
  apiVersion: "0.1.0",
  name: "Phoenix",
  // Inline so the page never fetches anything from us, and so the icon in a
  // connect dialog cannot be swapped by whoever controls the network.
  icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHRleHQgeT0iMTkiIGZvbnQtc2l6ZT0iMjAiPvCflJE8L3RleHQ+PC9zdmc+",
  supportedExtensions: [] as { cip: number }[],
  isEnabled: () => call("isEnabled", []) as Promise<boolean>,
  enable: async (extensions?: unknown) => {
    await call("enable", [extensions]);
    return buildApi();
  },
};

/**
 * Publish under `window.cardano.phoenix`, without fighting anyone for the slot.
 *
 * CIP-30 has every wallet writing into one shared object, so this must not
 * clobber `window.cardano` if a wallet got here first — and must not be
 * clobbered either. Defining the property as non-writable and non-configurable
 * means a page (or a later extension) that tries to replace `phoenix` with its
 * own object fails instead of silently becoming the thing dApps call. It also
 * means loading twice is a no-op rather than a crash.
 */
function publish(): void {
  const w = window as unknown as { cardano?: Record<string, unknown> };
  if (!w.cardano) {
    try {
      Object.defineProperty(w, "cardano", { value: {}, writable: true, configurable: true });
    } catch {
      return; // someone has locked it down; nothing safe left to do
    }
  }
  const root = w.cardano;
  if (!root || typeof root !== "object") return;
  if (Object.prototype.hasOwnProperty.call(root, "phoenix")) return;
  try {
    Object.defineProperty(root, "phoenix", {
      value: wallet,
      writable: false,
      configurable: false,
      enumerable: true,
    });
  } catch {
    /* another wallet has frozen the object; leave it alone */
  }
}

publish();

export {};
