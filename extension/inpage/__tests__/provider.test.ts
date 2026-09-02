/**
 * `window.cardano.phoenix` as a dApp actually meets it.
 *
 * The other extension tests check rules; this one runs the real provider module
 * against a fake page and a fake extension, because the provider's whole job is
 * plumbing and plumbing is not something a rule test can exercise.
 *
 * The case that motivated it: Phoenix's web build connects to Phoenix's own
 * extension. The web build's `assertCip30Api` rejects any wallet missing a
 * mandatory method, so a method dropped from `buildApi` would make this wallet
 * refuse itself — and the message a user would read blames their wallet. The
 * two files never import each other, so nothing but a test connects them.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { CHANNEL, CIP30_MANDATORY_METHODS } from "../../src/rpc/protocol";
import { REQUIRED_API_METHODS } from "../../../src/lib/cardano/cip30";

type Listener = (ev: { source: unknown; data: unknown }) => void;

/**
 * A page with an extension attached to it.
 *
 * `answer` is what the content script would relay back. Replies are posted
 * with the id the provider chose, which the test never reads from the outside
 * — it reads it off the request, exactly as the real content script does.
 */
function fakePage(answer: (method: string, params: unknown[]) => unknown) {
  const listeners: Listener[] = [];
  const seen: { method: string; id: string }[] = [];
  const win = {
    postMessage(data: unknown, _target: string) {
      const d = data as { channel?: string; kind?: string; id?: string; method?: string; params?: unknown[] };
      // Everything is delivered back to the window, requests included — that is
      // what postMessage does. The provider must ignore its own request.
      for (const fn of [...listeners]) fn({ source: win, data });
      if (d.channel !== CHANNEL || d.kind !== "req") return;
      seen.push({ method: d.method!, id: d.id! });
      let res: unknown;
      try {
        res = { channel: CHANNEL, kind: "res", id: d.id, ok: true, value: answer(d.method!, d.params ?? []) };
      } catch (e) {
        res = { channel: CHANNEL, kind: "res", id: d.id, ok: false, error: { code: -3, info: String(e) } };
      }
      queueMicrotask(() => {
        for (const fn of [...listeners]) fn({ source: win, data: res });
      });
    },
    addEventListener(_t: string, fn: Listener) { listeners.push(fn); },
    removeEventListener(_t: string, fn: Listener) {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
  } as Record<string, unknown>;
  return { win, seen };
}

/** Load the provider fresh against a given page. It captures globals on import. */
async function load(answer: (m: string, p: unknown[]) => unknown) {
  const page = fakePage(answer);
  vi.stubGlobal("window", page.win);
  vi.resetModules();
  await import("../provider");
  const cardano = (page.win as { cardano?: Record<string, any> }).cardano!;
  return { ...page, wallet: cardano.phoenix, cardano };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("the object a dApp finds on the page", () => {
  it("publishes under window.cardano.phoenix", async () => {
    const { wallet } = await load(() => true);
    expect(wallet).toBeTruthy();
    expect(wallet.name).toBe("Phoenix");
    expect(typeof wallet.enable).toBe("function");
    expect(typeof wallet.isEnabled).toBe("function");
    // The icon is inline: a connect dialog must not fetch an image over the
    // network, where whoever controls it controls what the user sees.
    expect(wallet.icon.startsWith("data:image/svg+xml;base64,")).toBe(true);
  });

  it("cannot be replaced by the page once published", async () => {
    const { cardano } = await load(() => true);
    const impostor = { name: "Phoenix", enable: async () => ({}) };
    expect(() => {
      Object.defineProperty(cardano, "phoenix", { value: impostor });
    }).toThrow();
    expect(cardano.phoenix.name).toBe("Phoenix");
    expect(cardano.phoenix).not.toBe(impostor);
  });

  it("does not clobber a wallet that got there first", async () => {
    const page = fakePage(() => true);
    const other = { name: "Someone else" };
    (page.win as { cardano?: unknown }).cardano = { phoenix: other, lace: {} };
    vi.stubGlobal("window", page.win);
    vi.resetModules();
    await import("../provider");
    expect((page.win as { cardano: Record<string, unknown> }).cardano.phoenix).toBe(other);
  });
});

describe("enable() — the api handed back", () => {
  it("has every method the CIP-30 contract requires", async () => {
    const { wallet } = await load(() => true);
    const api = await wallet.enable();
    for (const m of CIP30_MANDATORY_METHODS) {
      expect(typeof api[m], `provider is missing ${m}`).toBe("function");
    }
  });

  /**
   * The load-bearing one. If these two lists ever drift, Phoenix's web build
   * refuses to connect to Phoenix's own extension.
   */
  it("satisfies the exact check this repo's web build runs on injected wallets", async () => {
    const { wallet } = await load(() => true);
    const api = await wallet.enable();
    const missing = REQUIRED_API_METHODS.filter((m) => typeof api[m] !== "function");
    expect(missing).toEqual([]);
  });

  it("routes a call through to the extension and returns its answer", async () => {
    const { wallet, seen } = await load((m) => (m === "getNetworkId" ? 0 : true));
    const api = await wallet.enable();
    await expect(api.getNetworkId()).resolves.toBe(0);
    expect(seen.map((s) => s.method)).toEqual(["enable", "getNetworkId"]);
  });

  it("surfaces the extension's refusal as an error, not as a value", async () => {
    const { wallet } = await load((m) => {
      if (m === "getUtxos") throw new Error("no grant for this origin");
      return true;
    });
    const api = await wallet.enable();
    // A rejected promise is the contract. Resolving `undefined` would read to a
    // dApp as "this wallet holds nothing", which is a different and worse lie
    // than "this wallet said no".
    await expect(api.getUtxos()).rejects.toThrow(/no grant for this origin/);
    await expect(api.getUtxos()).rejects.toMatchObject({ name: "PhoenixApiError", code: -3 });
  });
});

describe("replies the page fakes to itself", () => {
  /**
   * Ids are unguessable so a page cannot answer a request the wallet has not
   * answered yet. It changes nothing about what the wallet does — but it stops
   * a page producing a convincing screenshot of "the user approved".
   */
  it("ignores a reply carrying an id it never issued", async () => {
    const { wallet, win } = await load((m) => (m === "getBalance" ? "beef" : true));
    const api = await wallet.enable();
    const p = api.getBalance();
    (win.postMessage as (d: unknown, t: string) => void)(
      { channel: CHANNEL, kind: "res", id: "guessed-id", ok: true, value: "00" },
      "*",
    );
    await expect(p).resolves.toBe("beef");
  });

  it("ignores traffic on another channel", async () => {
    const { wallet, win } = await load((m) => (m === "getBalance" ? "beef" : true));
    const api = await wallet.enable();
    const p = api.getBalance();
    (win.postMessage as (d: unknown, t: string) => void)(
      { channel: "some-other-wallet", kind: "res", id: "x", ok: true, value: "00" },
      "*",
    );
    await expect(p).resolves.toBe("beef");
  });
});
