/**
 * CIP-30 dApp-connector consumer.
 *
 * Phoenix web acts as a dApp that talks to the user's existing extension wallet
 * (Lace / Eternl / …). The wallet holds the keys and does all signing; Phoenix
 * only reads and builds. This is one of the three no-seed-online connect modes
 * (the others: watch-only xpub in `xpub.ts`, air-gap QR in `qr.ts`).
 *
 * Spec surface: `PhoenixKey-Specs/PhoenixKey-DappConnector-Feat.md`.
 */
import { Buffer } from "buffer";
import { Decoder } from "@stricahq/cbors";

// ─── CIP-30 API shapes ────────────────────────────────────────────────────────

export type Cip30Api = {
  getNetworkId(): Promise<number>;
  getUtxos(amount?: string, paginate?: unknown): Promise<string[] | null>;
  getBalance(): Promise<string>;
  getUsedAddresses(paginate?: unknown): Promise<string[]>;
  getUnusedAddresses(): Promise<string[]>;
  getChangeAddress(): Promise<string>;
  getRewardAddresses(): Promise<string[]>;
  signTx(tx: string, partialSign?: boolean): Promise<string>;
  signData(addr: string, payload: string): Promise<{ signature: string; key: string }>;
  submitTx(tx: string): Promise<string>;
};

export type Cip30Wallet = {
  /** the object key under `window.cardano`, e.g. "lace", "eternl". */
  key: string;
  apiVersion: string;
  name: string;
  icon: string;
  enable(): Promise<Cip30Api>;
  isEnabled(): Promise<boolean>;
};

type InjectedWallet = Omit<Cip30Wallet, "key">;

function cardanoRoot(): Record<string, InjectedWallet> | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { cardano?: Record<string, InjectedWallet> }).cardano;
}

/** Enumerate injected CIP-30 wallets (objects exposing `enable` + `apiVersion`). */
export function listWallets(): Cip30Wallet[] {
  const root = cardanoRoot();
  if (!root) return [];
  const out: Cip30Wallet[] = [];
  for (const key of Object.keys(root)) {
    const w = root[key];
    if (w && typeof w.enable === "function" && typeof w.apiVersion === "string") {
      out.push({ key, ...w });
    }
  }
  return out;
}

export function getWallet(key: string): Cip30Wallet | undefined {
  return listWallets().find((w) => w.key === key);
}

// ─── Connecting ───────────────────────────────────────────────────────────────

/**
 * Why connecting needs a clock.
 *
 * `enable()` is allowed to hang forever. The extension is supposed to show an
 * approval popup and settle the promise, but it can fail to settle at all: the
 * popup opens behind the window, the wallet is locked and never surfaces the
 * prompt, a previous request is still pending, or the user dismisses the popup
 * by clicking elsewhere — most wallets do NOT reject in that last case. A
 * promise that never settles is not a promise that rejects, so `try/catch`
 * around it can never fire: the only way out is to stop waiting.
 *
 * CIP-30 has no abort. We cannot cancel the wallet's side of the work — we can
 * only stop waiting for it and let the abandoned promise settle into the void.
 * If it resolves later, that API object is discarded.
 *
 * Two stages, because a single hard cut is hostile: at `slowAfterMs` the caller
 * is told the wait is unusual (so it can point at the hidden popup) WITHOUT
 * cancelling — someone typing their wallet password must not be interrupted —
 * and only at `timeoutMs` do we give up. The user-facing Cancel button matters
 * more than either timer: it hands control back immediately.
 */
export type ConnectFailure = "not_found" | "timeout" | "cancelled" | "bad_api";

export class WalletConnectError extends Error {
  constructor(
    readonly reason: ConnectFailure,
    message: string,
  ) {
    super(message);
    this.name = "WalletConnectError";
  }
}

/** Tell the user the wait is unusual — does NOT cancel. */
export const CONNECT_SLOW_MS = 8_000;
/**
 * Stop waiting. Deliberately generous: a locked wallet needs a password, and
 * cutting someone off mid-typing costs more than the extra wait.
 */
export const CONNECT_TIMEOUT_MS = 90_000;

export type EnableOptions = {
  /** Give up after this many ms. `0`/`Infinity` waits forever (old behaviour). */
  timeoutMs?: number;
  /** Fired once when the wait passes `slowAfterMs`. Advisory only. */
  onSlow?: () => void;
  slowAfterMs?: number;
  /** Abort the wait — the user pressed Cancel. */
  signal?: AbortSignal;
};

/**
 * A hostile or broken extension can inject anything under `window.cardano`, and
 * `enable()` can resolve to an object that is missing the methods we are about
 * to call with the user's money. Fail here, at the boundary, rather than with
 * "api.signTx is not a function" halfway through a send.
 */
const REQUIRED_API_METHODS = [
  "getNetworkId",
  "getUtxos",
  "getBalance",
  "getChangeAddress",
  "getRewardAddresses",
  "signTx",
  "submitTx",
] as const;

function assertCip30Api(v: unknown, key: string): Cip30Api {
  const api = v as Record<string, unknown> | null;
  const missing = api
    ? REQUIRED_API_METHODS.filter((m) => typeof api[m] !== "function")
    : [...REQUIRED_API_METHODS];
  if (missing.length > 0) {
    throw new WalletConnectError(
      "bad_api",
      `Wallet "${key}" returned an incomplete CIP-30 API (missing: ${missing.join(", ")}).`,
    );
  }
  return v as Cip30Api;
}

/**
 * Enable a wallet by its `window.cardano` key. Rejects with a
 * `WalletConnectError` when the wallet is absent, the wait times out, the user
 * cancels, or the returned object is not a usable CIP-30 API.
 */
export async function enableWallet(key: string, opts: EnableOptions = {}): Promise<Cip30Api> {
  const w = getWallet(key);
  if (!w) {
    throw new WalletConnectError(
      "not_found",
      `Wallet "${key}" not found. Install or unlock it, then retry.`,
    );
  }

  const {
    timeoutMs = CONNECT_TIMEOUT_MS,
    slowAfterMs = CONNECT_SLOW_MS,
    onSlow,
    signal,
  } = opts;

  if (signal?.aborted) throw new WalletConnectError("cancelled", "Connect cancelled.");

  // `.then()` rather than a bare call: a wallet may throw synchronously, and
  // that must become a rejection like any other failure, not blow up the caller.
  const pending = Promise.resolve().then(() => w.enable());
  // We may walk away from this promise. Attach a sink so an eventual rejection
  // of the abandoned request does not surface as an unhandled rejection.
  pending.catch(() => {});

  let slowTimer: ReturnType<typeof setTimeout> | undefined;
  let hardTimer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  try {
    const api = await new Promise<unknown>((resolve, reject) => {
      pending.then(resolve, reject);
      if (onSlow && slowAfterMs > 0 && Number.isFinite(slowAfterMs)) {
        slowTimer = setTimeout(onSlow, slowAfterMs);
      }
      if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
        hardTimer = setTimeout(() => {
          reject(
            new WalletConnectError(
              "timeout",
              `Wallet "${key}" did not answer within ${Math.round(timeoutMs / 1000)}s.`,
            ),
          );
        }, timeoutMs);
      }
      if (signal) {
        onAbort = () => reject(new WalletConnectError("cancelled", "Connect cancelled."));
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
    return assertCip30Api(api, key);
  } finally {
    if (slowTimer) clearTimeout(slowTimer);
    if (hardTimer) clearTimeout(hardTimer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Did the user press "Reject" on the connection prompt?
 *
 * CIP-30 wallets reject with a bare `{ code, info }` object, NOT an Error.
 * `APIError.Refused = -3` is what `enable()` returns when the user declines —
 * a different code from the `TxSignError.UserDeclined = 2` raised when they
 * decline a *signature*. Without this the extension's own English `info` string
 * leaks straight to the user, one wording per wallet.
 */
export function isConnectRefused(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { code?: unknown }).code === -3;
}

// ─── Network drift ────────────────────────────────────────────────────────────

export class NetworkMismatchError extends Error {
  constructor(
    readonly expected: number,
    readonly actual: number,
  ) {
    super(
      `Wallet network changed since connect (was networkId ${expected}, now ${actual}). ` +
        `Reconnect before signing.`,
    );
    this.name = "NetworkMismatchError";
  }
}

/**
 * Re-read the wallet's network and compare it with the one captured at connect.
 *
 * The network is read ONCE when the wallet connects, but every extension lets
 * the user switch networks afterwards without disconnecting. Everything
 * downstream is keyed off the stale value: protocol params, tip slot, and — the
 * dangerous one — whether the confirm gate treats this as real money. Someone
 * who connects on preprod, switches Lace to mainnet, then sends, gets the
 * testnet-grade single checkbox over a mainnet transaction.
 *
 * Call this immediately before every signature request, not at connect: the
 * window that matters is the one between the user reviewing and the wallet
 * signing.
 *
 * LIMIT: CIP-30 `getNetworkId()` returns 0 for every testnet, so this catches
 * testnet↔mainnet drift — the case that costs real money — but cannot see a
 * preprod↔preview switch. That ambiguity is in the protocol, not here.
 */
export async function assertSameNetwork(api: Cip30Api, expectedNetworkId: number): Promise<void> {
  const actual = await api.getNetworkId();
  if (actual !== expectedNetworkId) throw new NetworkMismatchError(expectedNetworkId, actual);
}

// ─── Value / UTxO decoding ────────────────────────────────────────────────────

export type AssetAmount = {
  /** policyId (28-byte hex) + assetNameHex, concatenated (the CIP-30 "unit"). */
  unit: string;
  policyId: string;
  assetNameHex: string;
  quantity: bigint;
};

export type ParsedValue = {
  lovelace: bigint;
  assets: AssetAmount[];
};

function toBigInt(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(v);
  // @stricahq/cbors decodes large uints as BigNumber. `.toFixed(0)` avoids the
  // exponential notation `.toString()` can emit above 1e20 (which BigInt rejects).
  if (v && typeof (v as { toFixed?: (n: number) => string }).toFixed === "function") {
    return BigInt((v as { toFixed: (n: number) => string }).toFixed(0));
  }
  if (v && typeof (v as { toString?: () => string }).toString === "function") {
    return BigInt((v as { toString: () => string }).toString());
  }
  throw new Error("cannot coerce CBOR integer");
}

/**
 * Decode a CIP-30 CBOR `Value`. A Value is either a bare coin (uint) or
 * `[coin, multiasset]` where multiasset = { policyId(bytes) → { assetName(bytes) → uint } }.
 */
export function decodeValue(cborHex: string): ParsedValue {
  const decoded = Decoder.decode(Buffer.from(cborHex, "hex"));
  const value = decoded.value;
  if (!Array.isArray(value)) {
    return { lovelace: toBigInt(value), assets: [] };
  }
  const [coin, multiasset] = value as [unknown, Map<Buffer, Map<Buffer, unknown>> | undefined];
  const assets: AssetAmount[] = [];
  if (multiasset && typeof (multiasset as Map<Buffer, unknown>).forEach === "function") {
    (multiasset as Map<Buffer, Map<Buffer, unknown>>).forEach((names, policy) => {
      const policyId = Buffer.from(policy).toString("hex");
      names.forEach((qty, name) => {
        const assetNameHex = Buffer.from(name).toString("hex");
        assets.push({
          unit: policyId + assetNameHex,
          policyId,
          assetNameHex,
          quantity: toBigInt(qty),
        });
      });
    });
  }
  return { lovelace: toBigInt(coin), assets };
}

/** Sum a wallet's total balance from its `getBalance()` CBOR value. */
export async function readBalance(api: Cip30Api): Promise<ParsedValue> {
  return decodeValue(await api.getBalance());
}

/** Quantity of a specific native token (by policyId+assetNameHex) in a parsed value. */
export function assetQuantity(value: ParsedValue, policyId: string, assetNameHex: string): bigint {
  const unit = policyId.toLowerCase() + assetNameHex.toLowerCase();
  return value.assets.find((a) => a.unit.toLowerCase() === unit)?.quantity ?? BigInt("0");
}
