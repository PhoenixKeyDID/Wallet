/**
 * The build-time endpoint, and the ways it can be wrong without looking wrong.
 *
 * Every case here is one where the wallet still runs and still shows numbers —
 * which is why none of them would be caught by opening the page. A build that
 * reads the wrong chain, or silently reads none, looks exactly like a build that
 * works.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { chainSourceFromEnv, readBuildEnv } from "../chainEnv";
import { getChainSource, setChainSource, resetChainSources } from "../chainSource";

describe("chainSourceFromEnv > nothing set is a normal build, not a failure", () => {
  it("returns null on an empty environment", () => {
    expect(chainSourceFromEnv(0, {})).toBeNull();
  });

  it("treats a blank string as unset, because a shell exports those by accident", () => {
    expect(chainSourceFromEnv(0, { VITE_BLOCKFROST_PROJECT_ID_PREPROD: "   " })).toBeNull();
  });
});

describe("chainSourceFromEnv > each network reads its own variable", () => {
  const env = {
    VITE_BLOCKFROST_PROJECT_ID_MAINNET: "id-main",
    VITE_BLOCKFROST_PROJECT_ID_PREPROD: "id-preprod",
    VITE_BLOCKFROST_PROJECT_ID_PREVIEW: "id-preview",
  };

  it("mainnet takes the mainnet id and the mainnet host", () => {
    const src = chainSourceFromEnv(1, env);
    expect(src).toEqual({ kind: "blockfrost", base: "https://cardano-mainnet.blockfrost.io/api/v0", projectId: "id-main" });
  });

  it("preprod takes the preprod id and the preprod host", () => {
    expect(chainSourceFromEnv(0, env)).toMatchObject({ base: expect.stringContaining("preprod"), projectId: "id-preprod" });
  });

  it("preview takes the preview id and the preview host", () => {
    expect(chainSourceFromEnv(2, env)).toMatchObject({ base: expect.stringContaining("preview"), projectId: "id-preview" });
  });

  it("a mainnet-only build leaves preprod alone rather than borrowing the key", () => {
    // The failure this blocks is silent: a preprod read answered by a mainnet
    // node returns a confident, entirely wrong balance, not an error.
    expect(chainSourceFromEnv(0, { VITE_BLOCKFROST_PROJECT_ID_MAINNET: "id-main" })).toBeNull();
  });
});

describe("chainSourceFromEnv > both bundlers, one meaning", () => {
  it("reads Next's prefix", () => {
    expect(chainSourceFromEnv(0, { NEXT_PUBLIC_BLOCKFROST_PROJECT_ID_PREPROD: "id" })).toMatchObject({ projectId: "id" });
  });

  it("prefers Vite's when a build somehow carries both", () => {
    const src = chainSourceFromEnv(0, {
      VITE_BLOCKFROST_PROJECT_ID_PREPROD: "from-vite",
      NEXT_PUBLIC_BLOCKFROST_PROJECT_ID_PREPROD: "from-next",
    });
    expect(src).toMatchObject({ projectId: "from-vite" });
  });
});

describe("chainSourceFromEnv > a base with no key is the self-hosted case", () => {
  it("carries no projectId at all rather than an empty one", () => {
    const src = chainSourceFromEnv(0, { VITE_CHAIN_BASE_PREPROD: "https://chain.example/api/v0" });
    expect(src).toEqual({ kind: "blockfrost", base: "https://chain.example/api/v0" });
    expect(src && "projectId" in src).toBe(false);
  });

  it("a base overrides the vendor host while keeping the key", () => {
    const src = chainSourceFromEnv(0, {
      VITE_CHAIN_BASE_PREPROD: "https://chain.example/api/v0",
      VITE_BLOCKFROST_PROJECT_ID_PREPROD: "id",
    });
    expect(src).toEqual({ kind: "blockfrost", base: "https://chain.example/api/v0", projectId: "id" });
  });
});

describe("readBuildEnv > runs in a browser-shaped world without throwing", () => {
  it("returns an object even where neither bundler inlined anything", () => {
    expect(typeof readBuildEnv()).toBe("object");
  });
});

describe("getChainSource > the build environment is a fallback, never an override", () => {
  beforeEach(() => resetChainSources());
  afterEach(() => {
    resetChainSources();
    vi.unstubAllEnvs();
  });

  it("defaults to Koios when the build was given nothing", () => {
    expect(getChainSource(0)).toEqual({ kind: "koios" });
  });

  it("an explicit setChainSource wins over the build environment", () => {
    vi.stubEnv("VITE_BLOCKFROST_PROJECT_ID_PREPROD", "from-build");
    setChainSource(0, { kind: "blockfrost", base: "https://explicit.example/api/v0" });
    expect(getChainSource(0)).toEqual({ kind: "blockfrost", base: "https://explicit.example/api/v0" });
  });

  it("picks up a build-time endpoint when no host configured one", () => {
    vi.stubEnv("VITE_BLOCKFROST_PROJECT_ID_PREPROD", "from-build");
    expect(getChainSource(0)).toMatchObject({ kind: "blockfrost", projectId: "from-build" });
  });

  it("a malformed build value falls back to the default instead of taking the wallet down", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("VITE_CHAIN_BASE_PREPROD", "http://chain.example/api/v0");
    expect(getChainSource(0)).toEqual({ kind: "koios" });
    // And it must say so — a wallet that silently ignores the endpoint its
    // operator configured is the same failure as reading the wrong one.
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });
});
