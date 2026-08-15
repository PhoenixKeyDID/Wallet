import { describe, it, expect, vi, afterEach } from "vitest";
import { listWallets, getWallet } from "../cip30";
import { fetchProtocolParams } from "../provider";

/**
 * Two inputs this module cannot choose and cannot trust: the object graph any
 * extension writes into `window.cardano`, and the JSON a public indexer returns.
 *
 * Neither can steal funds on its own — signing and submit both go through the
 * user's extension. What they CAN do is make the wallet unusable, or make it
 * build a transaction nobody meant to build. Both used to succeed.
 */

// ─── window.cardano — a page we do not own ───────────────────────────────────

type Root = Record<string, unknown>;

function install(root: Root): void {
  (globalThis as { window?: unknown }).window = { cardano: root };
}

/** A wallet entry that behaves. */
function good(name: string): Record<string, unknown> {
  return {
    apiVersion: "0.1.0",
    name,
    icon: "",
    enable: async () => ({}),
    isEnabled: async () => true,
  };
}

/** An entry whose property is a getter that throws when read. */
function withThrowingGetter(prop: string): Record<string, unknown> {
  const w = good("hostile");
  Object.defineProperty(w, prop, {
    enumerable: true,
    get() {
      throw new Error(`boom: ${prop}`);
    },
  });
  return w;
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  vi.restoreAllMocks();
});

describe("listWallets against a page it does not control", () => {
  it("still lists the working wallets when another entry's getter throws", () => {
    // The bug: `{ key, ...w }` spread invoked every enumerable getter, so ONE
    // hostile entry threw before the array existed and the panel said "no
    // wallet installed" — the user's real Lace made unreachable by someone
    // else's object.
    install({ lace: good("Lace"), evil: withThrowingGetter("name"), eternl: good("Eternl") });
    const keys = listWallets().map((w) => w.key);
    expect(keys).toContain("lace");
    expect(keys).toContain("eternl");
  });

  it.each(["name", "icon", "apiVersion"])(
    "survives a throwing `%s` on an entry",
    (prop) => {
      install({ evil: withThrowingGetter(prop), lace: good("Lace") });
      expect(listWallets().map((w) => w.key)).toContain("lace");
    },
  );

  it("keeps a hostile entry that is otherwise usable, with the bad field blank", () => {
    // A throwing `name` is not proof of malice — it may be a broken extension.
    // We degrade the field, not the entry: the user can still pick it.
    install({ evil: withThrowingGetter("name") });
    const [w] = listWallets();
    expect(w?.key).toBe("evil");
    expect(w?.name).toBe("");
  });

  it("drops an entry whose apiVersion cannot be read — it is not a CIP-30 wallet", () => {
    install({ evil: withThrowingGetter("apiVersion") });
    expect(listWallets()).toEqual([]);
  });

  it("ignores non-wallet junk parked under window.cardano", () => {
    install({ nulled: null, str: "hello", num: 7, noEnable: { apiVersion: "0.1.0" } });
    expect(listWallets()).toEqual([]);
  });

  it("returns an empty list rather than throwing when there is no window", () => {
    delete (globalThis as { window?: unknown }).window;
    expect(listWallets()).toEqual([]);
    expect(getWallet("lace")).toBeUndefined();
  });

  it("getWallet finds a real wallet past a hostile neighbour", () => {
    install({ evil: withThrowingGetter("icon"), lace: good("Lace") });
    expect(getWallet("lace")?.name).toBe("Lace");
  });
});

// ─── Koios — an indexer we do not run ────────────────────────────────────────

const REAL_PARAMS = {
  min_fee_a: 44,
  min_fee_b: 155381,
  key_deposit: "2000000",
  coins_per_utxo_size: "4310",
  collateral_percent: 150,
  price_step: 0.0000721,
  price_mem: 0.0577,
  max_tx_size: 16384,
  max_val_size: "5000",
};

function mockKoios(row: Record<string, unknown>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, json: async () => [row] } as unknown as Response),
  );
}

describe("fetchProtocolParams plausibility bounds", () => {
  it("accepts today's real mainnet values", async () => {
    mockKoios(REAL_PARAMS);
    const p = await fetchProtocolParams(0);
    expect(p.minFeeA.toNumber()).toBe(44);
    expect(p.stakeKeyDeposit.toNumber()).toBe(2_000_000);
  });

  it.each([
    ["min_fee_a", 999_999_999],
    ["min_fee_b", 999_999_999_999],
    ["key_deposit", "9000000000000"],
    ["coins_per_utxo_size", "999999999"],
  ])("refuses an absurd %s instead of building with it", async (field, value) => {
    mockKoios({ ...REAL_PARAMS, [field]: value });
    await expect(fetchProtocolParams(0)).rejects.toThrow(/implausible/);
  });

  it("refuses a negative value", async () => {
    mockKoios({ ...REAL_PARAMS, min_fee_a: -1 });
    await expect(fetchProtocolParams(0)).rejects.toThrow(/implausible/);
  });

  it("refuses garbage that BigNumber would silently turn into NaN", async () => {
    // `new BigNumber("")` is NaN and does NOT throw — without the finite check
    // the whole fee calculation would go NaN and the failure would surface
    // somewhere far away from its cause.
    mockKoios({ ...REAL_PARAMS, key_deposit: "" });
    await expect(fetchProtocolParams(0)).rejects.toThrow(/implausible/);
  });

  it("says so when the indexer returns no rows at all", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => [] } as unknown as Response),
    );
    await expect(fetchProtocolParams(0)).rejects.toThrow(/no protocol params/);
  });
});
