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

/** Enable a wallet by its `window.cardano` key; throws a readable error if absent. */
export async function enableWallet(key: string): Promise<Cip30Api> {
  const w = getWallet(key);
  if (!w) throw new Error(`Wallet "${key}" not found. Install or unlock it, then retry.`);
  return w.enable();
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
