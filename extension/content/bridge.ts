/**
 * The relay between the page and the extension.
 *
 * It runs in the content script's isolated world: it can see the page's DOM and
 * its `window.postMessage` traffic, but the page cannot reach any variable in
 * here. That isolation is the only thing separating "a site asked" from "a site
 * pretended the user asked".
 *
 * It is written to be boring. It adds nothing to a request, it decides nothing,
 * and it never touches a key. Its one job is to carry bytes across a boundary
 * the page cannot cross, and the reason it must stay this small is that the
 * origin attached to its messages is what the background trusts — so any
 * cleverness in here would be cleverness inside the trusted path.
 */
import { CHANNEL, parseRequest, internal, type Response as RpcResponse } from "../src/rpc/protocol";

type Runtime = {
  getURL(path: string): string;
  sendMessage(message: unknown): Promise<unknown>;
  id?: string;
};

const runtime = (globalThis as unknown as { chrome?: { runtime?: Runtime } }).chrome?.runtime;

/**
 * Load the page-world provider from a file, not from a string.
 *
 * The provider has to run in the page's world to be reachable as
 * `window.cardano.phoenix`, and the way to get it there is a `<script src>`
 * pointing at a `web_accessible_resource`. Injecting the source inline instead
 * would need `'unsafe-inline'` somewhere, and a wallet that relaxes a CSP to
 * install itself has taught every page on the web a worse habit.
 *
 * The tag is removed once it has run: it has already executed by then, and
 * leaving an extension URL in the DOM tells any script on the page which wallet
 * is installed before the user has chosen to say so.
 */
function injectProvider(): void {
  if (!runtime) return;
  try {
    const s = document.createElement("script");
    s.src = runtime.getURL("inpage.js");
    s.async = false; // run before the page's own scripts look for window.cardano
    const parent = document.head ?? document.documentElement;
    parent.insertBefore(s, parent.firstChild);
    s.remove();
  } catch {
    // A page with a CSP that forbids our script tag simply does not get a
    // provider. That is a page we cannot serve, not an error to report to it.
  }
}

function reply(res: RpcResponse): void {
  window.postMessage(res, window.location.origin);
}

window.addEventListener("message", (ev: MessageEvent) => {
  // Only this window's own page may ask. `ev.source !== window` excludes every
  // iframe: a frame's message arrives with `source` set to the frame, and a
  // frame that wants a wallet has its own content script and its own origin.
  if (ev.source !== window) return;
  const req = parseRequest(ev.data);
  if (!req) return;

  if (!runtime) {
    reply({ channel: CHANNEL, kind: "res", id: req.id, ok: false, error: internal("no runtime") });
    return;
  }

  // Nothing is added to the message. The background reads the origin from the
  // browser's own record of who sent it, which is the only version of the
  // origin a page has no way to influence.
  runtime
    .sendMessage(req)
    .then((res) => {
      const r = res as RpcResponse | undefined;
      if (r && typeof r === "object" && r.channel === CHANNEL && r.kind === "res") reply(r);
      else
        reply({
          channel: CHANNEL,
          kind: "res",
          id: req.id,
          ok: false,
          error: internal("the wallet did not answer"),
        });
    })
    .catch((e: unknown) => {
      // A service worker that was asleep and failed to wake, or an extension
      // being updated underneath us. The page gets an error, not silence — a
      // promise that never settles is the one outcome a dApp cannot handle.
      reply({
        channel: CHANNEL,
        kind: "res",
        id: req.id,
        ok: false,
        error: internal(e instanceof Error ? e.message : String(e)),
      });
    });
});

injectProvider();

export {};
