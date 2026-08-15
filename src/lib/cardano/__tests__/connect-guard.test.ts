import { describe, it, expect, vi, afterEach } from "vitest";
import {
  enableWallet,
  assertSameNetwork,
  isConnectRefused,
  WalletConnectError,
  NetworkMismatchError,
  CONNECT_SLOW_MS,
  CONNECT_TIMEOUT_MS,
  type Cip30Api,
} from "../cip30";
import { cip30NetworkId } from "../address";
import { signAndSubmitCip30, SubmitUncertainError, type BuiltTx } from "../tx";

/**
 * Two failures this file exists to pin down, both of which cost the user
 * something real and neither of which a type checker can see:
 *
 *  1. `enable()` never settling — the connect spinner turns forever with no way
 *     out. A promise that hangs is not a promise that rejects, so only a race
 *     against a timer (or the user's Cancel) can end the wait.
 *  2. The wallet switching networks after connect — the app keeps using the
 *     network captured at connect, so a preprod-grade confirmation can end up
 *     in front of a mainnet signature.
 */

// ─── window.cardano test double ───────────────────────────────────────────────

type FakeWallet = {
  apiVersion: string;
  name: string;
  icon: string;
  enable: () => Promise<unknown>;
  isEnabled: () => Promise<boolean>;
};

function installWallets(wallets: Record<string, Partial<FakeWallet>>): void {
  const root: Record<string, FakeWallet> = {};
  for (const [key, w] of Object.entries(wallets)) {
    root[key] = {
      apiVersion: "0.1.0",
      name: key,
      icon: "",
      enable: async () => fullApi(),
      isEnabled: async () => true,
      ...w,
    } as FakeWallet;
  }
  (globalThis as { window?: unknown }).window = { cardano: root };
}

function fullApi(overrides: Partial<Cip30Api> = {}): Cip30Api {
  return {
    getNetworkId: vi.fn().mockResolvedValue(0),
    getUtxos: vi.fn().mockResolvedValue([]),
    getBalance: vi.fn().mockResolvedValue("00"),
    getUsedAddresses: vi.fn().mockResolvedValue([]),
    getUnusedAddresses: vi.fn().mockResolvedValue([]),
    getChangeAddress: vi.fn().mockResolvedValue("01cc"),
    getRewardAddresses: vi.fn().mockResolvedValue(["e0dd"]),
    signTx: vi.fn().mockResolvedValue("a0"),
    signData: vi.fn().mockResolvedValue({ signature: "s", key: "k" }),
    submitTx: vi.fn().mockResolvedValue("txhash"),
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { window?: unknown }).window;
});

// ─── enableWallet ─────────────────────────────────────────────────────────────

describe("enableWallet — the wait always ends", () => {
  it("resolves normally when the wallet answers", async () => {
    installWallets({ lace: {} });
    const api = await enableWallet("lace");
    expect(typeof api.signTx).toBe("function");
  });

  it("gives up on a wallet that never settles, instead of hanging forever", async () => {
    vi.useFakeTimers();
    installWallets({ lace: { enable: () => new Promise<never>(() => {}) } });

    const p = enableWallet("lace", { timeoutMs: 1_000 }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    const err = await p;

    expect(err).toBeInstanceOf(WalletConnectError);
    expect((err as WalletConnectError).reason).toBe("timeout");
  });

  it("warns that the wait is slow WITHOUT cancelling it", async () => {
    vi.useFakeTimers();
    let release: (v: Cip30Api) => void = () => {};
    installWallets({ lace: { enable: () => new Promise<Cip30Api>((r) => (release = r)) } });

    const onSlow = vi.fn();
    const p = enableWallet("lace", { onSlow, slowAfterMs: 100, timeoutMs: 10_000 });

    await vi.advanceTimersByTimeAsync(100);
    expect(onSlow).toHaveBeenCalledTimes(1);

    // The hint must not have ended the wait: the wallet can still answer.
    release(fullApi());
    await expect(p).resolves.toBeTruthy();
  });

  it("does not fire the slow hint when the wallet answers promptly", async () => {
    vi.useFakeTimers();
    installWallets({ lace: {} });
    const onSlow = vi.fn();
    const p = enableWallet("lace", { onSlow, slowAfterMs: 5_000 });
    await vi.advanceTimersByTimeAsync(0);
    await p;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onSlow).not.toHaveBeenCalled();
  });

  it("Cancel ends the wait immediately, without waiting for any timer", async () => {
    installWallets({ lace: { enable: () => new Promise<never>(() => {}) } });
    const ac = new AbortController();
    const p = enableWallet("lace", { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toMatchObject({ reason: "cancelled" });
  });

  it("refuses an already-aborted signal without touching the wallet", async () => {
    const enable = vi.fn();
    installWallets({ lace: { enable } });
    const ac = new AbortController();
    ac.abort();
    await expect(enableWallet("lace", { signal: ac.signal })).rejects.toMatchObject({
      reason: "cancelled",
    });
    expect(enable).not.toHaveBeenCalled();
  });

  it("reports a missing wallet as not_found", async () => {
    installWallets({ lace: {} });
    await expect(enableWallet("eternl")).rejects.toMatchObject({ reason: "not_found" });
  });

  it("turns a synchronous throw inside enable() into a rejection", async () => {
    installWallets({
      lace: {
        enable: (() => {
          throw new Error("boom");
        }) as unknown as () => Promise<unknown>,
      },
    });
    await expect(enableWallet("lace")).rejects.toThrow("boom");
  });

  it("rejects an api object missing the methods we would sign with", async () => {
    // A hostile or half-broken extension can resolve to anything at all.
    installWallets({ evil: { enable: async () => ({ getNetworkId: async () => 1 }) } });
    const err = await enableWallet("evil").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WalletConnectError);
    expect((err as WalletConnectError).reason).toBe("bad_api");
    expect((err as Error).message).toContain("signTx");
  });

  it("passes a wallet's own rejection through untouched", async () => {
    const refusal = { code: -3, info: "user declined" };
    installWallets({ lace: { enable: () => Promise.reject(refusal) } });
    await expect(enableWallet("lace")).rejects.toBe(refusal);
  });

  it("waits forever when the caller explicitly asks for no timeout", async () => {
    vi.useFakeTimers();
    installWallets({ lace: { enable: () => new Promise<never>(() => {}) } });
    let settled = false;
    void enableWallet("lace", { timeoutMs: 0 }).finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(settled).toBe(false);
  });

  it("the slow hint comes well before the give-up point", () => {
    expect(CONNECT_SLOW_MS).toBeLessThan(CONNECT_TIMEOUT_MS);
  });
});

describe("isConnectRefused", () => {
  it("recognises APIError.Refused (-3), which is not an Error object", () => {
    expect(isConnectRefused({ code: -3, info: "nope" })).toBe(true);
  });
  it("does not confuse it with the sign-time UserDeclined codes", () => {
    expect(isConnectRefused({ code: 2 })).toBe(false);
    expect(isConnectRefused({ code: 3 })).toBe(false);
    expect(isConnectRefused(new Error("x"))).toBe(false);
    expect(isConnectRefused(null)).toBe(false);
  });
});

// ─── network drift ────────────────────────────────────────────────────────────

describe("cip30NetworkId", () => {
  it("maps rust_core ids onto the CIP-30 id space", () => {
    expect(cip30NetworkId(1)).toBe(1); // mainnet
    expect(cip30NetworkId(0)).toBe(0); // preprod
    expect(cip30NetworkId(2)).toBe(0); // preview — CIP-30 cannot tell it from preprod
  });
});

describe("assertSameNetwork", () => {
  it("passes when the wallet is still where it was at connect", async () => {
    await expect(assertSameNetwork(fullApi(), 0)).resolves.toBeUndefined();
  });

  it("throws when the wallet moved to mainnet after connecting on a testnet", async () => {
    const api = fullApi({ getNetworkId: vi.fn().mockResolvedValue(1) });
    await expect(assertSameNetwork(api, 0)).rejects.toBeInstanceOf(NetworkMismatchError);
  });

  it("throws when the wallet moved off mainnet", async () => {
    const api = fullApi({ getNetworkId: vi.fn().mockResolvedValue(0) });
    const err = await assertSameNetwork(api, 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkMismatchError);
    expect((err as NetworkMismatchError).expected).toBe(1);
    expect((err as NetworkMismatchError).actual).toBe(0);
  });
});

describe("signAndSubmitCip30 — the guard sits before the signature", () => {
  const built = {
    transaction: {
      addWitness: vi.fn(),
      buildTransaction: () => ({ payload: "signedcbor", hash: "h" }),
    },
    unsignedCbor: "unsignedcbor",
    hash: "h",
    fee: "170000",
  } as unknown as BuiltTx;

  it("submits when the network still matches", async () => {
    const api = fullApi();
    await expect(signAndSubmitCip30(api, built, 0)).resolves.toBe("txhash");
    expect(api.signTx).toHaveBeenCalledWith("unsignedcbor", true);
  });

  it("refuses to even ASK for a signature once the network drifted", async () => {
    const api = fullApi({ getNetworkId: vi.fn().mockResolvedValue(1) });
    await expect(signAndSubmitCip30(api, built, 0)).rejects.toBeInstanceOf(NetworkMismatchError);
    // The point of checking first: no signature request, no submit, nothing
    // left the wallet — so "nothing was sent" is a true statement to show.
    expect(api.signTx).not.toHaveBeenCalled();
    expect(api.submitTx).not.toHaveBeenCalled();
  });
});

describe("signAndSubmitCip30 — \"did it go out?\" must never be left unanswered", () => {
  const built = {
    transaction: {
      addWitness: vi.fn(),
      buildTransaction: () => ({ payload: "signedcbor", hash: "abc123" }),
    },
    unsignedCbor: "unsignedcbor",
    hash: "abc123",
    fee: "170000",
  } as unknown as BuiltTx;

  it("carries the tx hash out when the submit gives no answer", async () => {
    // A node error or a dropped connection does NOT mean the transaction is
    // gone — it may be on-chain. The hash is what lets the user check instead
    // of guessing, and guessing here means paying twice.
    const api = fullApi({ submitTx: vi.fn().mockRejectedValue({ code: 2, info: "node error" }) });
    const err = await signAndSubmitCip30(api, built, 0).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SubmitUncertainError);
    expect((err as SubmitUncertainError).txHash).toBe("abc123");
    expect((err as SubmitUncertainError).cause).toMatchObject({ code: 2 });
  });

  it("passes a wallet's outright refusal (TxSendError.Refused = 1) through as-is", async () => {
    // Refused means it never left. Dressing that up as "it might have been
    // sent" would send the user hunting for a transaction that does not exist.
    const refusal = { code: 1, info: "refused" };
    const api = fullApi({ submitTx: vi.fn().mockRejectedValue(refusal) });
    await expect(signAndSubmitCip30(api, built, 0)).rejects.toBe(refusal);
  });

  it("does not dress up a pre-signature failure as an uncertain submit", async () => {
    const api = fullApi({ signTx: vi.fn().mockRejectedValue({ code: 2, info: "user declined" }) });
    const err = await signAndSubmitCip30(api, built, 0).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(SubmitUncertainError);
    expect(api.submitTx).not.toHaveBeenCalled();
  });
});
