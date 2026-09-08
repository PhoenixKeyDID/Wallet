/**
 * A web page must not be able to talk itself into being an extension.
 *
 * `chrome.storage.local` is an object. Any script on any page can define one,
 * and until the origin check landed, defining one was enough to (a) take
 * delivery of the encrypted vault and (b) turn off the banner that tells the
 * user an unlocked key is reachable from the page. Both of those are decided
 * by `isExtensionContext()`, so both are pinned here.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { isExtensionContext } from "../storage";

type Mutable = Record<string, unknown>;
const g = globalThis as Mutable;

function withGlobals(protocol: string | undefined, chrome: unknown) {
  const hadLocation = "location" in g;
  const oldLocation = g.location;
  const hadChrome = "chrome" in g;
  const oldChrome = g.chrome;

  if (protocol === undefined) delete g.location;
  else Object.defineProperty(g, "location", { value: { protocol }, configurable: true });
  if (chrome === undefined) delete g.chrome;
  else g.chrome = chrome;

  return () => {
    if (hadLocation) Object.defineProperty(g, "location", { value: oldLocation, configurable: true });
    else delete g.location;
    if (hadChrome) g.chrome = oldChrome;
    else delete g.chrome;
  };
}

const fakeStorage = {
  storage: { local: { get: vi.fn(), set: vi.fn(), remove: vi.fn() } },
};

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

describe("isExtensionContext", () => {
  it("refuses a web page that has defined its own chrome.storage.local", () => {
    restore = withGlobals("https:", fakeStorage);
    expect(isExtensionContext()).toBe(false);
  });

  it("refuses a web page that also fakes chrome.runtime.id", () => {
    restore = withGlobals("https:", { ...fakeStorage, runtime: { id: "aaaabbbbccccdddd" } });
    expect(isExtensionContext()).toBe(false);
  });

  it("refuses http and file pages too", () => {
    for (const proto of ["http:", "file:", "blob:", "data:"]) {
      restore?.();
      restore = withGlobals(proto, fakeStorage);
      expect(isExtensionContext(), proto).toBe(false);
    }
  });

  it("accepts a real extension page", () => {
    restore = withGlobals("chrome-extension:", fakeStorage);
    expect(isExtensionContext()).toBe(true);
  });

  it("accepts Firefox and Safari extension schemes", () => {
    for (const proto of ["moz-extension:", "safari-web-extension:"]) {
      restore?.();
      restore = withGlobals(proto, fakeStorage);
      expect(isExtensionContext(), proto).toBe(true);
    }
  });

  it("is false on an extension scheme with no storage API", () => {
    restore = withGlobals("chrome-extension:", undefined);
    expect(isExtensionContext()).toBe(false);
  });

  it("is false where there is no location at all (server render)", () => {
    restore = withGlobals(undefined, fakeStorage);
    expect(isExtensionContext()).toBe(false);
  });
});
