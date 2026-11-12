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
import { createRegistry, type WindowPort } from "./pending";

// Only what is used, structurally typed — this repo does not carry
// `@types/chrome`, and a hand-written surface is one a reviewer can check.
type Port = {
  name: string;
  /** Set by the browser, not by the other end: which page opened this port. */
  sender?: { url?: string };
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
    onRemoved: {
      addListener(cb: (id: number) => void): void;
      removeListener(cb: (id: number) => void): void;
    };
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

/**
 * Which window serves which site, and which window owes which answer. The
 * rules — unguessable ids, an answer only counts on the port the request went
 * down — live in `pending.ts`, where they are tested.
 */
const registry = createRegistry(() => ({
  ok: false,
  error: refused("The wallet window was closed."),
}));
/** Requests to open a window that have not been answered yet. */
const opening = new Map<string, Promise<WindowPort | null>>();

/**
 * Whether this port was opened by the wallet window, `approve.html` of this
 * extension, judged from the URL the browser recorded for the sender.
 *
 * The port's name is chosen by whoever calls `connect`, so it says nothing.
 * Any page of this extension can open a port by that name — the toolbar
 * popup, an options page, a future one — and its `hello` would then name an
 * origin and be served that origin's requests, with no unlocked screen behind
 * it showing anyone what is being asked. Only the approval window is allowed
 * to answer for a site. The comparison is the exact page plus its query or
 * fragment: a bare prefix test would also accept `approve.html.evil`.
 */
function fromWalletWindow(port: Port): boolean {
  const url = port.sender?.url;
  if (typeof url !== "string") return false;
  const page = chrome.runtime.getURL("approve.html");
  return url === page || url.startsWith(`${page}?`) || url.startsWith(`${page}#`);
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== WALLET_PORT) return;
  if (!fromWalletWindow(port)) return;
  let origin: string | null = null;
  port.onMessage.addListener((raw) => {
    const m = raw as { type?: string; origin?: string; id?: unknown; result?: unknown };
    if (m?.type === "hello" && typeof m.origin === "string" && origin === null) {
      // The window tells us which origin it is serving. This is safe to trust
      // in a way the page's own claim is not: the port was opened by this
      // extension's `approve.html` (`fromWalletWindow`, from the URL the
      // browser recorded), and the origin it names was handed to it by us when
      // we opened it. Once, per port: a window serves the one site it was opened
      // for, and a second hello naming another is not something to honour.
      origin = m.origin;
      registry.attach(origin, port);
      return;
    }
    if (m?.type === "result") registry.answer(port, m.id, m.result);
  });
  port.onDisconnect.addListener(() => {
    // Every request this window still owed has just lost its only possible
    // answer. Say so rather than leaving the page's promise hanging forever —
    // and touch nothing that belongs to another window for the same site.
    registry.detach(port, origin);
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
function walletWindow(origin: string): Promise<WindowPort | null> {
  const live = registry.windowFor(origin);
  if (live) return Promise.resolve(live);
  const already = opening.get(origin);
  if (already) return already;

  const p = (async () => {
    const url = `${chrome.runtime.getURL("approve.html")}?origin=${encodeURIComponent(origin)}`;
    const waiter = registry.whenAttached(origin);
    let created: { id?: number };
    try {
      created = await chrome.windows.create({ url, type: "popup", width: 420, height: 680, focused: true });
    } catch {
      waiter.cancel();
      return null;
    }
    // Wait for the window to unlock and say hello. There is a person reading a
    // screen at the other end of this, so there is no clock on it — see the
    // same reasoning in the inpage provider. What does end the wait is the
    // window going away: closing it before unlocking is a "no", and the page
    // hears it at once instead of after a timer nobody chose.
    return new Promise<WindowPort | null>((resolve) => {
      const onRemoved = (id: number) => {
        if (id !== created.id) return;
        chrome.windows.onRemoved.removeListener(onRemoved);
        waiter.cancel();
        resolve(registry.windowFor(origin) ?? null);
      };
      chrome.windows.onRemoved.addListener(onRemoved);
      void waiter.attached.then((port) => {
        chrome.windows.onRemoved.removeListener(onRemoved);
        resolve(port);
      });
    });
  })();

  opening.set(origin, p);
  p.finally(() => opening.delete(origin)).catch(() => {});
  return p;
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
    return { channel: CHANNEL, kind: "res", id: req.id, ok: true, value: granted && registry.windowFor(origin) !== undefined };
  }

  if (need !== "enable" && !granted) {
    return fail(refused("This site has not been connected to the wallet."));
  }

  const w = await walletWindow(origin);
  if (!w) return fail(refused("The wallet window could not be opened."));

  const raw = (await registry.ask(w, origin, req.method, req.params)) as
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
