import { describe, it, expect, vi } from "vitest";
import {
  buildCip30Provider,
  buildDappProvider,
  CIP30_PROVIDER_METHODS,
  CIP30_READ_METHODS,
  KNOWN_DAPPS,
  getKnownDapp,
  EMBEDDED_DAPP_BROWSER_ENABLED,
  type Cip30Provider,
} from "../cardano/connect";
import type { Cip30Api } from "../cardano/cip30";

/**
 * A fully-mocked connected wallet. Each method returns a sentinel so we can
 * prove the provider delegates rather than inventing its own answer.
 */
function mockApi(): Cip30Api {
  return {
    getNetworkId: vi.fn().mockResolvedValue(0),
    getUtxos: vi.fn().mockResolvedValue(["deadbeef"]),
    getBalance: vi.fn().mockResolvedValue("1a000f4240"),
    getUsedAddresses: vi.fn().mockResolvedValue(["01aa"]),
    getUnusedAddresses: vi.fn().mockResolvedValue(["01bb"]),
    getChangeAddress: vi.fn().mockResolvedValue("01cc"),
    getRewardAddresses: vi.fn().mockResolvedValue(["e0dd"]),
    signTx: vi.fn().mockResolvedValue("a10081"),
    signData: vi.fn().mockResolvedValue({ signature: "sig", key: "key" }),
    submitTx: vi.fn().mockResolvedValue("txhash"),
  };
}

describe("buildCip30Provider — surface", () => {
  it("exposes every required CIP-30 method as a function", () => {
    const p = buildCip30Provider(mockApi());
    for (const m of CIP30_PROVIDER_METHODS) {
      expect(typeof (p as unknown as Record<string, unknown>)[m]).toBe("function");
    }
  });
});

describe("buildCip30Provider — read methods delegate to the api", () => {
  it("getNetworkId delegates and returns the wallet's value", async () => {
    const api = mockApi();
    const p = buildCip30Provider(api);
    await expect(p.getNetworkId()).resolves.toBe(0);
    expect(api.getNetworkId).toHaveBeenCalledTimes(1);
  });

  it("getUtxos forwards its arguments unchanged", async () => {
    const api = mockApi();
    const p = buildCip30Provider(api);
    await expect(p.getUtxos("100", { page: 1 })).resolves.toEqual(["deadbeef"]);
    expect(api.getUtxos).toHaveBeenCalledWith("100", { page: 1 });
  });

  it("every read method delegates exactly once to its api counterpart", async () => {
    const api = mockApi();
    const p = buildCip30Provider(api) as unknown as Record<string, () => Promise<unknown>>;
    for (const m of CIP30_READ_METHODS) {
      await p[m]();
      expect((api as unknown as Record<string, ReturnType<typeof vi.fn>>)[m]).toHaveBeenCalledTimes(1);
    }
  });
});

describe("buildCip30Provider — sign/submit delegate to the connected wallet", () => {
  it("signTx forwards cbor + partialSign flag and returns the witness set", async () => {
    const api = mockApi();
    const p = buildCip30Provider(api);
    await expect(p.signTx("ffff", true)).resolves.toBe("a10081");
    expect(api.signTx).toHaveBeenCalledWith("ffff", true);
  });

  it("submitTx delegates to the wallet's submit", async () => {
    const api = mockApi();
    const p = buildCip30Provider(api);
    await expect(p.submitTx("ffff")).resolves.toBe("txhash");
    expect(api.submitTx).toHaveBeenCalledWith("ffff");
  });
});

describe("buildCip30Provider — guards force a review before signing", () => {
  it("runs beforeSign before delegating to the wallet", async () => {
    const api = mockApi();
    const order: string[] = [];
    const beforeSign = vi.fn(async () => {
      order.push("review");
    });
    (api.signTx as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push("sign");
      return "a10081";
    });
    const p = buildCip30Provider(api, { beforeSign });
    await p.signTx("ffff");
    expect(beforeSign).toHaveBeenCalledWith("tx", "ffff");
    expect(order).toEqual(["review", "sign"]);
  });

  it("a rejected review aborts signing (the wallet is never asked)", async () => {
    const api = mockApi();
    const p: Cip30Provider = buildCip30Provider(api, {
      beforeSign: async () => {
        throw new Error("user cancelled");
      },
    });
    await expect(p.signTx("ffff")).rejects.toThrow("user cancelled");
    expect(api.signTx).not.toHaveBeenCalled();
  });
});

describe("KNOWN_DAPPS registry is well-formed", () => {
  it("contains the curated Minswap and SundaeSwap entries", () => {
    const ids = KNOWN_DAPPS.map((d) => d.id);
    expect(ids).toContain("minswap");
    expect(ids).toContain("sundaeswap");
  });

  it("every entry has the required, well-formed fields", () => {
    for (const d of KNOWN_DAPPS) {
      expect(d.id).toMatch(/^[a-z0-9-]+$/);
      expect(d.name.length).toBeGreaterThan(0);
      expect(d.url).toMatch(/^https:\/\//);
      expect(d.emoji.length).toBeGreaterThan(0);
      expect(d.descKey.length).toBeGreaterThan(0);
      expect(d.description.length).toBeGreaterThan(0);
      expect(["dex", "lending", "identity", "other"]).toContain(d.category);
      expect(["extension", "cip45"]).toContain(d.connectMode);
    }
  });

  it("ids are unique", () => {
    const ids = KNOWN_DAPPS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("getKnownDapp resolves a slug and misses safely", () => {
    expect(getKnownDapp("minswap")?.name).toBe("Minswap");
    expect(getKnownDapp("nope")).toBeUndefined();
  });
});

describe("safety posture", () => {
  it("the embedded dApp browser is OFF by default", () => {
    expect(EMBEDDED_DAPP_BROWSER_ENABLED).toBe(false);
  });
});

describe("buildDappProvider — a real transport can never blind-sign", () => {
  it("throws when the required guards are missing", () => {
    // @ts-expect-error — a production transport MUST pass both guards
    expect(() => buildDappProvider(mockApi())).toThrow();
    // @ts-expect-error — a partial guard set is still refused
    expect(() => buildDappProvider(mockApi(), { beforeSign: async () => {} })).toThrow();
  });

  it("returns a working provider when both guards are supplied", () => {
    const p = buildDappProvider(mockApi(), {
      beforeSign: async () => {},
      beforeSubmit: async () => {},
    });
    expect(typeof p.signTx).toBe("function");
  });
});

describe("curated dApp URLs are pinned", () => {
  // If this fails, a PR changed a launcher URL. Curation IS the security
  // boundary (repo is public) — the reviewer must consciously re-approve the
  // exact origin, not let a homoglyph/look-alike slip through unnoticed.
  it("KNOWN_DAPPS urls are exactly the reviewed canonical origins", () => {
    const byId = Object.fromEntries(KNOWN_DAPPS.map((d) => [d.id, d.url]));
    expect(byId).toEqual({
      minswap: "https://minswap.org/",
      sundaeswap: "https://app.sundae.fi/",
    });
  });
});
