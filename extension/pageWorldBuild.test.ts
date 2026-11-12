/**
 * The page-world build, run for real into a temporary directory.
 *
 * `check:package` grades a staged package, so on its own it cannot notice the
 * build going back to emitting ES modules for `content.js` and `inpage.js` — the
 * shape that left `window.cardano.phoenix` undefined in Chrome, because a
 * content script and a `<script src>` are classic scripts and throw on their
 * first `import`. This runs `buildPageWorld` and applies the browser's rule to
 * what it wrote.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { buildPageWorld, PAGE_WORLD_RECEIPT } from "./vite.config";

let out: string;
let modules: Record<string, string[]>;

beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), "phoenix-page-world-"));
  modules = await buildPageWorld(out);
}, 60_000);

afterAll(() => rmSync(out, { recursive: true, force: true }));

describe("buildPageWorld", () => {
  it("writes exactly the two page-world files and the receipt, and no shared chunk", () => {
    expect(readdirSync(out).sort()).toEqual([PAGE_WORLD_RECEIPT, "content.js", "inpage.js"].sort());
  });

  for (const f of ["content.js", "inpage.js"]) {
    it(`emits ${f} as a self-contained classic script`, () => {
      const src = readFileSync(join(out, f), "utf8");
      // The browser's rule: a classic script refuses import/export declarations.
      expect(() => new vm.Script(src, { filename: f })).not.toThrow();
      expect(src).not.toMatch(/(?:^|[\s;])(?:import|export)\s*[{*\w"']/m);
      expect(src).not.toMatch(/(?<![\w$.])import\s*\(/);
      expect(src.length).toBeLessThan(32 * 1024);
    });
  }

  it("records the modules it bundled, and they are only the relay and the rules", () => {
    expect(modules).toEqual({
      "content.js": ["extension/content/bridge.ts", "extension/src/rpc/protocol.ts"],
      "inpage.js": ["extension/inpage/provider.ts", "extension/src/rpc/protocol.ts"],
    });
    expect(JSON.parse(readFileSync(join(out, PAGE_WORLD_RECEIPT), "utf8"))).toEqual(modules);
  });

  it("puts the provider on window.cardano when inpage.js runs as a plain script", async () => {
    // A minimal page: the provider captures postMessage/addEventListener at load
    // and installs itself; isEnabled must settle once the bridge answers.
    const src = readFileSync(join(out, "inpage.js"), "utf8");
    const listeners: Array<(ev: { source: unknown; data: unknown }) => void> = [];
    const win: Record<string, unknown> = {};
    Object.assign(win, {
      location: { origin: "https://dapp.example" },
      addEventListener: (_t: string, fn: (ev: { source: unknown; data: unknown }) => void) => listeners.push(fn),
      removeEventListener: () => {},
      postMessage: (msg: { id?: string; kind?: string; channel?: string }) => {
        if (msg.kind !== "req") return;
        queueMicrotask(() =>
          listeners.forEach((fn) =>
            fn({ source: win, data: { channel: msg.channel, kind: "res", id: msg.id, ok: true, value: false } }),
          ),
        );
      },
    });
    win.window = win;
    const ctx = vm.createContext({ window: win, crypto: globalThis.crypto, Object, Promise, setTimeout, clearTimeout });
    new vm.Script(src, { filename: "inpage.js" }).runInContext(ctx);
    const cardano = win.cardano as Record<string, { apiVersion: string; name: string; isEnabled(): Promise<unknown> }>;
    expect(cardano?.phoenix?.name).toBe("Phoenix");
    expect(cardano.phoenix.apiVersion).toBe("0.1.0");
    await expect(cardano.phoenix.isEnabled()).resolves.toBe(false);
  });
});
