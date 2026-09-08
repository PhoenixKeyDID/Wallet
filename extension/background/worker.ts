/**
 * The service worker: it decides who may ask, and it holds no keys.
 *
 * Everything a page asks for arrives here first, because this is the only place
 * that learns the origin from the browser rather than from the message. It
 * checks the request against the rules in `rpc/protocol.ts`, and then — for
 * anything that needs a wallet at all — hands it to a **wallet window** the
 * user can see.
 *
 * ## Why a window, and not this worker, does the work
 *
 * Every operation here needs an unlocked account: even `getUtxos` needs the
 * addresses, which come from the seed. The obvious design keeps the unlocked
 * wallet in this worker, and that is exactly what the popup's own docstring
 * refuses — *"it means the wallet is not sitting unlocked in a background
 * worker for hours while nobody is looking at it"*. A service worker has no
 * window, so there is nothing on screen to tell the user their keys are in
 * memory, and nothing to close when they want them gone.
 *
 * So the keys live in a window: the user opens it, unlocks it, and can see it.
 * While it is open the site can ask; when it is closed the connection is gone
 * and the keys with it. "Disconnect" is a thing the user can do by closing a
 * window, which needs no extra UI and cannot be misunderstood.
 *
 * ## Grants last as long as the browser session, and no longer
 *
 * A remembered grant needs a screen to review and revoke it, and a wallet whose
 * revocation screen does not exist yet should not be handing out permissions
 * that outlive the browser. `chrome.storage.session` is cleared when the
 * browser closes, which is a revocation UI that cannot have a bug in it.
 */
import {
  CHANNEL,
  parseRequest,
  requirementOf,
  originOf,
  refused,
  internal,
  invalid,
  type ApiError,
  type Request,
  WALLET_PORT,
  type Response as RpcResponse,
} from "../src/rpc/protocol";

// Only what is used, structurally typed — this repo does not carry
// `@types/chrome`, and a hand-written surface is one a reviewer can check.
type Port = {
  name: string;
  postMessage(m: unknown): void;
  onMessage: { addListener(cb: (m: unknown) => void): void };
  onDisconnect: { addListener(cb: () => void): void };
};
type Chrome = {
  runtime: {
    onMessage: {
      addListener(
        cb: (
          msg: unknown,
          sender: { origin?: string; frameId?: number; url?: string },
          send: (r: unknown) => void,
        ) => boolean | undefined,
      ): void;
    };
    onConnect: { addListener(cb: (p: Port) => void): void };
    getURL(path: string): string;
  };
  storage: {
    session: {
      get(keys: string | string[] | null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
  };
  windows: {
    create(o: Record<string, unknown>): Promise<{ id?: number }>;
    update(id: number, o: Record<string, unknown>): Promise<unknown>;
  };
};

const chrome = (globalThis as unknown as { chrome: Chrome }).chrome;

const GRANTS_KEY = "phoenix.cip30.grants";

/** Origins the user has said yes to, this browser session. */
async function grants(): Promise<Record<string, true>> {
  const got = await chrome.storage.session.get(GRANTS_KEY);
  const v = got[GRANTS_KEY];
  return v && typeof v === "object" ? (v as Record<string, true>) : {};
}

async function grant(origin: string): Promise<void> {
  const all = await grants();
  all[origin] = true;
  await chrome.storage.session.set({ [GRANTS_KEY]: all });
}

// ─── The open wallet windows, by origin ──────────────────────────────────────

type Wallet = { port: Port; nextId: number; waiting: Map<number, (r: unknown) => void> };
const wallets = new Map<string, Wallet>();
/** Requests to open a window that have not been answered yet. */
const opening = new Map<string, Promise<Wallet | null>>();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== WALLET_PORT) return;
  let origin: string | null = null;
  port.onMessage.addListener((raw) => {
    const m = raw as { type?: string; origin?: string; id?: number; result?: unknown };
    if (m?.type === "hello" && typeof m.origin === "string") {
      // The window tells us which origin it is serving. This is safe to trust
      // in a way the page's own claim is not: the port comes from inside the
      // extension, and the origin it names was handed to it by us when we
      // opened it.
      origin = m.origin;
      wallets.set(origin, { port, nextId: 1, waiting: new Map() });
      return;
    }
    if (m?.type === "result" && typeof m.id === "number" && origin) {
      const w = wallets.get(origin);
      const settle = w?.waiting.get(m.id);
      if (settle) {
        w!.waiting.delete(m.id);
        settle(m.result);
      }
    }
  });
  port.onDisconnect.addListener(() => {
    if (!origin) return;
    const w = wallets.get(origin);
    // Every request still in flight has just lost its only possible answer.
    // Say so rather than leaving the page's promise hanging forever.
    for (const settle of w?.waiting.values() ?? []) {
      settle({ ok: false, error: refused("The wallet window was closed.") });
    }
    wallets.delete(origin);
  });
});

/**
 * Get the wallet window for this origin, opening one if needed.
 *
 * `chrome.windows.create`, never the toolbar popup. The popup is destroyed the
 * moment it loses focus, and `LocalWalletPanel` locks the wallet on
 * `visibilitychange` — so an approval flow in the popup would lock the wallet
 * at the exact instant the user looked at anything else, including the dialog
 * they were reading. A real window survives being looked away from.
 */
function walletWindow(origin: string): Promise<Wallet | null> {
  const live = wallets.get(origin);
  if (live) return Promise.resolve(live);
  const already = opening.get(origin);
  if (already) return already;

  const p = (async () => {
    const url = `${chrome.runtime.getURL("approve.html")}?origin=${encodeURIComponent(origin)}`;
    try {
      await chrome.windows.create({ url, type: "popup", width: 420, height: 680, focused: true });
    } catch {
      return null;
    }
    // Wait for the window to unlock and say hello. There is a person reading a
    // screen at the other end of this, so it does not time out — see the same
    // reasoning in the inpage provider.
    for (let i = 0; i < 600; i++) {
      const w = wallets.get(origin);
      if (w) return w;
      await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  })();

  opening.set(origin, p);
  p.finally(() => opening.delete(origin)).catch(() => {});
  return p;
}

/** Ask the wallet window to carry out one request, and wait for its answer. */
function ask(w: Wallet, origin: string, method: string, params: unknown[]): Promise<unknown> {
  const id = w.nextId++;
  return new Promise((resolve) => {
    w.waiting.set(id, resolve);
    w.port.postMessage({ type: "request", id, origin, method, params });
  });
}

// ─── The one entry point ─────────────────────────────────────────────────────

async function handle(req: Request, sender: { origin?: string; frameId?: number }): Promise<RpcResponse> {
  const fail = (error: ApiError): RpcResponse =>
    ({ channel: CHANNEL, kind: "res", id: req.id, ok: false, error });

  const decided = originOf(sender);
  if ("error" in decided) return fail(decided.error);
  const origin = decided.origin;

  const need = requirementOf(req.method);
  if (need === "refused") return fail(invalid(`Unknown method "${req.method}".`));

  const granted = (await grants())[origin] === true;

  if (need === "open") {
    // `isEnabled` must not open a window or ask anything: it is the call a page
    // makes on load to decide whether to show a "connect" button, and a wallet
    // that pops a window for it is a wallet nobody keeps installed.
    return { channel: CHANNEL, kind: "res", id: req.id, ok: true, value: granted && wallets.has(origin) };
  }

  if (need !== "enable" && !granted) {
    return fail(refused("This site has not been connected to the wallet."));
  }

  const w = await walletWindow(origin);
  if (!w) return fail(refused("The wallet window could not be opened."));

  const raw = (await ask(w, origin, req.method, req.params)) as
    | { ok: true; value: unknown }
    | { ok: false; error: ApiError }
    | undefined;

  if (!raw || typeof raw !== "object") return fail(internal("The wallet window gave no answer."));
  if (!raw.ok) return fail(raw.error);
  // Only a completed `enable` creates the grant — the window has by then shown
  // the origin to the user and been told yes.
  if (need === "enable") await grant(origin);
  return { channel: CHANNEL, kind: "res", id: req.id, ok: true, value: raw.value };
}

chrome.runtime.onMessage.addListener((msg, sender, send) => {
  const req = parseRequest(msg);
  if (!req) return undefined;
  handle(req, sender).then(send, (e: unknown) =>
    send({
      channel: CHANNEL,
      kind: "res",
      id: req.id,
      ok: false,
      error: internal(e instanceof Error ? e.message : String(e)),
    }),
  );
  return true; // keep the message channel open for the async reply
});

export {};
