/**
 * Chain data provider — Koios (public, key-less) for protocol params and
 * watch-only address balances/UTxOs.
 *
 * Why Koios and not Blockfrost: Blockfrost needs a project key that must not be
 * exposed to the browser. Koios is a free public REST indexer with permissive
 * CORS, fine for read-only client calls. When the PhoenixKey backend exposes a
 * UTxO/params proxy (`PhoenixKey-Wallet-API-v2`), swap `PROVIDER_BASE` for it.
 */
import { Buffer } from "buffer";
import BigNumber from "bignumber.js";
import { types as tyTypes } from "@stricahq/typhonjs";

type ProtocolParams = tyTypes.ProtocolParams;
import type { PhoenixNetwork } from "./address";

const KOIOS_BASE: Record<"mainnet" | "preprod" | "preview", string> = {
  mainnet: "https://api.koios.rest/api/v1",
  preprod: "https://preprod.koios.rest/api/v1",
  preview: "https://preview.koios.rest/api/v1",
};

function koiosBase(network: PhoenixNetwork): string {
  if (network === 1) return KOIOS_BASE.mainnet;
  if (network === 2) return KOIOS_BASE.preview;
  return KOIOS_BASE.preprod;
}

export async function koios<T>(network: PhoenixNetwork, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${koiosBase(network)}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Koios ${path} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

/**
 * Plausibility bounds on the numbers the indexer hands us.
 *
 * Koios is a public, key-less service and it is the one input on the build path
 * that no wallet re-checks: the UTxOs, the signature and the submit all go
 * through the user's extension, but the fee and min-ADA arithmetic is done here
 * from these values. A hostile or simply broken indexer cannot spend anyone's
 * money with them — it can only inflate what a transaction the user started
 * costs, and both our own review screen and the extension's signing popup show
 * that number before anything is signed. So this is not the thing standing
 * between the user and a loss; it is a cheap upper bound that turns a garbage
 * response into a refusal instead of a transaction nobody meant to build.
 *
 * The ceilings sit far above real chain values (mainnet today: minFeeA 44,
 * minFeeB 155381, keyDeposit 2 ADA, utxoCostPerByte 4310), so a genuine
 * parameter change will not trip them.
 */
const PARAM_CEILING = {
  minFeeA: 100_000,
  minFeeB: 100_000_000, // 100 ADA of flat fee — absurd, but not impossible-in-principle
  stakeKeyDeposit: 1_000_000_000, // 1000 ADA
  utxoCostPerByte: 10_000_000,
} as const;

function checked(name: keyof typeof PARAM_CEILING, raw: string | number): BigNumber {
  const v = new BigNumber(raw);
  if (!v.isFinite() || v.isNegative() || v.isGreaterThan(PARAM_CEILING[name])) {
    throw new Error(`Koios returned an implausible ${name}: ${String(raw)}`);
  }
  return v;
}

/**
 * Current protocol parameters in typhon's `ProtocolParams` shape. Koios
 * `/epoch_params` returns the latest epoch first.
 */
export async function fetchProtocolParams(network: PhoenixNetwork): Promise<ProtocolParams> {
  const rows = await koios<
    Array<{
      min_fee_a: number;
      min_fee_b: number;
      key_deposit: string | number;
      coins_per_utxo_size: string | number;
      collateral_percent: number;
      price_step: number;
      price_mem: number;
      max_tx_size: number;
      max_val_size: string | number;
      min_fee_ref_script_cost_per_byte?: number;
    }>
  >(network, "/epoch_params");
  const p = rows[0];
  if (!p) throw new Error("Koios returned no protocol params");
  return {
    minFeeA: checked("minFeeA", p.min_fee_a),
    minFeeB: checked("minFeeB", p.min_fee_b),
    stakeKeyDeposit: checked("stakeKeyDeposit", p.key_deposit),
    utxoCostPerByte: checked("utxoCostPerByte", p.coins_per_utxo_size),
    collateralPercent: new BigNumber(p.collateral_percent ?? 150),
    priceSteps: new BigNumber(p.price_step ?? 0),
    priceMem: new BigNumber(p.price_mem ?? 0),
    maxTxSize: p.max_tx_size,
    maxValueSize: Number(p.max_val_size),
    minFeeRefScriptCostPerByte: new BigNumber(p.min_fee_ref_script_cost_per_byte ?? 15),
  };
}

/** Current chain tip absolute slot — used to set a transaction TTL. */
export async function fetchTipSlot(network: PhoenixNetwork): Promise<number> {
  const rows = await koios<Array<{ abs_slot: number }>>(network, "/tip");
  const slot = rows[0]?.abs_slot;
  if (typeof slot !== "number") throw new Error("Koios returned no tip slot");
  return slot;
}

export type AddressBalance = {
  lovelace: bigint;
  assets: { unit: string; policyId: string; assetNameHex: string; quantity: bigint }[];
};

/** Aggregate balance across one or more bech32 addresses (watch-only view). */
export async function fetchAddressBalance(
  network: PhoenixNetwork,
  addresses: string[],
): Promise<AddressBalance> {
  if (addresses.length === 0) return { lovelace: BigInt("0"), assets: [] };
  const rows = await koios<
    Array<{
      balance: string;
      asset_list: Array<{ policy_id: string; asset_name: string | null; quantity: string }> | null;
    }>
  >(network, "/address_info", { _addresses: addresses });

  let lovelace = BigInt("0");
  const byUnit = new Map<string, { policyId: string; assetNameHex: string; quantity: bigint }>();
  for (const r of rows) {
    lovelace += BigInt(r.balance ?? "0");
    for (const a of r.asset_list ?? []) {
      const assetNameHex = a.asset_name ?? "";
      const unit = a.policy_id + assetNameHex;
      const prev = byUnit.get(unit);
      const quantity = (prev?.quantity ?? BigInt("0")) + BigInt(a.quantity);
      byUnit.set(unit, { policyId: a.policy_id, assetNameHex, quantity });
    }
  }
  return {
    lovelace,
    assets: [...byUnit.entries()].map(([unit, v]) => ({ unit, ...v })),
  };
}

/** ADA (6-decimals) display string from a lovelace bigint. */
export function formatAda(lovelace: bigint): string {
  const neg = lovelace < BigInt("0");
  const abs = neg ? -lovelace : lovelace;
  const whole = abs / BigInt("1000000");
  const frac = (abs % BigInt("1000000")).toString().padStart(6, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole.toString()}${frac ? "." + frac : ""}`;
}

/** Convenience: assetNameHex → utf8 label if printable, else the hex. */
export function assetLabel(assetNameHex: string): string {
  try {
    const txt = Buffer.from(assetNameHex, "hex").toString("utf8");
    return /^[\x20-\x7e]+$/.test(txt) ? txt : assetNameHex;
  } catch {
    return assetNameHex;
  }
}

export { tyTypes };
