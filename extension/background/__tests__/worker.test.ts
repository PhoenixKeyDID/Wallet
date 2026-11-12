/**
 * Which ports the worker lets answer for a site.
 *
 * A port's name is picked by whoever calls `chrome.runtime.connect`, so any
 * page of this extension could open one called `WALLET_PORT` and send a
 * `hello` naming a site. The worker must only take that from the approval
 * window, `approve.html`, judged from `port.sender.url` — which the browser
 * fills in, not the caller.
 *
 * What is observed is `isEnabled` for a granted site: it answers `true` only
 * while a wallet window is attached for that site. So a refused `hello` reads
 * `false`, an accepted one `true`.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { CHANNEL, WALLET_PORT } from "../../src/rpc/protocol";

const EXT = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const SITES = {
  popup: "https://popup.example",
  lookalike: "https://lookalike.example",
  nosender: "https://nosender.example",
  web: "https://web.example",
  window: "https://dex.example",
} as const;

type Listener = (m: unknown) => void;
let onConnect: (p: unknown) => void;
let onMessage: (msg: unknown, sender: unknown, send: (r: unknown) => void) => boolean | undefined;

beforeAll(async () => {
  const granted = Object.fromEntries(Object.values(SITES).map((o) => [o, true]));
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      onConnect: { addListener: (cb: typeof onConnect) => void (onConnect = cb) },
      onMessage: { addListener: (cb: typeof onMessage) => void (onMessage = cb) },
      getURL: (path: string) => `${EXT}/${path}`,
    },
    storage: {
      session: {
        // Every test site is granted: the question here is only whether a window is attached.
        get: async (key: string) => ({ [key]: granted }),
        set: async () => {},
      },
    },
    windows: {
      create: async () => ({ id: 1 }),
      update: async () => ({}),
      onRemoved: { addListener: () => {}, removeListener: () => {} },
    },
  };
  await import("../worker");
});

/** Open a port as the browser would hand it to the worker, and say hello for `origin`. */
function connectAndHello(sender: { url?: string } | undefined, origin: string) {
  let listener: Listener = () => {};
  const port = {
    name: WALLET_PORT,
    sender,
    postMessage: () => {},
    onMessage: { addListener: (cb: Listener) => void (listener = cb) },
    onDisconnect: { addListener: () => {} },
  };
  onConnect(port);
  listener({ type: "hello", origin });
}

function isEnabled(origin: string): Promise<unknown> {
  return new Promise((resolve) => {
    const kept = onMessage(
      { channel: CHANNEL, kind: "req", id: `ie-${origin}`, method: "isEnabled", params: [] },
      { origin, frameId: 0 },
      (r) => resolve((r as { value?: unknown }).value),
    );
    expect(kept).toBe(true);
  });
}

describe("only the approval window's port may attach for a site", () => {
  it("refuses a port opened by another extension page (the toolbar popup)", async () => {
    connectAndHello({ url: `${EXT}/popup.html` }, SITES.popup);
    expect(await isEnabled(SITES.popup)).toBe(false);
  });

  it("refuses a URL that merely starts with approve.html", async () => {
    connectAndHello({ url: `${EXT}/approve.html.evil?origin=x` }, SITES.lookalike);
    expect(await isEnabled(SITES.lookalike)).toBe(false);
  });

  it("refuses a port with no sender URL", async () => {
    connectAndHello(undefined, SITES.nosender);
    expect(await isEnabled(SITES.nosender)).toBe(false);
  });

  it("refuses a port whose sender is a web page", async () => {
    connectAndHello({ url: "https://web.example/approve.html" }, SITES.web);
    expect(await isEnabled(SITES.web)).toBe(false);
  });

  it("accepts the approval window, opened with its ?origin= query", async () => {
    connectAndHello({ url: `${EXT}/approve.html?origin=${encodeURIComponent(SITES.window)}` }, SITES.window);
    expect(await isEnabled(SITES.window)).toBe(true);
  });
});
