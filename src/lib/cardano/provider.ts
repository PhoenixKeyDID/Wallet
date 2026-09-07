/**
 * Chain data provider — Koios (public, key-less) for protocol params and
 * watch-only address balances/UTxOs.
 *
 * Why Koios and not Blockfrost: Blockfrost needs a project key that must not be
 * exposed to the browser. Koios is a free public REST indexer with permissive
 * CORS, fine for read-only client calls. When the PhoenixKey backend exposes a
 * UTxO/params proxy (`PhoenixKey-Wallet-API-v2`), swap `PROVIDER_BASE` for it.
 */
import "../node-globals";
import { Buffer } from "buffer";
import BigNumber from "bignumber.js";
import { types as tyTypes, utils as tyUtils } from "@stricahq/typhonjs";

type ProtocolParams = tyTypes.ProtocolParams;
import type { PhoenixNetwork } from "./address";

const KOIOS_BASE: Record<"mainnet" | "preprod" | "preview", string> = {
  mainnet: "https://api.koios.rest/api/v1",
  preprod: "https://preprod.koios.rest/api/v1",
  preview: "https://preview.koios.rest/api/v1",
};

/**
 * The one host this wallet contacts that is not a chain indexer.
 *
 * It lives in this file rather than beside the code that uses it because this
 * file is the single answer to "who can this wallet talk to":
 * `scripts/check-extension-package.mjs` requires every host in the extension's
 * `host_permissions` to appear as a URL literal *here*, and CODEOWNERS gates
 * this file. Putting the constant next to `price.ts` would either break that
 * gate or force it to read a second file — and a gate that reads two files is a
 * gate with two places to forget.
 *
 * What the request carries: the string `cardano` and a currency code. No
 * address, no balance, no wallet identifier — the price of ADA is the same
 * whether or not the asker holds any. What the other end sees is an IP and the
 * fact that somebody asked. That is a smaller exposure than the indexer, which
 * necessarily sees the addresses; it is not zero, which is why it is written
 * down here and in §10 rather than left to be inferred from a fetch call.
 */
export const PRICE_BASE = "https://api.coingecko.com/api/v3";

function koiosBase(network: PhoenixNetwork): string {
  if (network === 1) return KOIOS_BASE.mainnet;
  if (network === 2) return KOIOS_BASE.preview;
  return KOIOS_BASE.preprod;
}

/**
 * Thrown when Koios answered successfully with only part of the answer.
 *
 * Separate from a plain network error because it is the opposite failure: the
 * request worked, the JSON parses, and the array is the wrong length. A wallet
 * that treats it as data reports a balance smaller than the truth and offers
 * coin selection over UTxOs the account does not appear to have — the failure a
 * person reads as "my money is gone".
 */
export class KoiosTruncatedError extends Error {
  constructor(path: string, got: number, total: number) {
    super(`Koios ${path} returned ${got} of ${total} rows`);
    this.name = "KoiosTruncatedError";
  }
}

/**
 * A bound the *caller* asked for — not a bound the server imposed.
 *
 * The difference is the whole reason this exists. `KoiosTruncatedError` below
 * catches a server that answered part of an unbounded question, which for a
 * balance or a UTxO set is a wrong number wearing the clothes of a right one.
 * But "the most recent 25 transactions" is a question that is *complete* at 25,
 * and PostgREST answers a deliberate `limit` with the same `206` and the same
 * short content-range as a truncation. Without a way to say which was asked,
 * either the guard fires on every paged read, or it is switched off for all of
 * them.
 *
 * Measured 2026-09-06 on the live indexer, and both halves matter:
 * `/address_txs` unbounded on a busy script address answered **HTTP 504** after
 * two minutes, and on an ordinary address answered `200` with rows ordered
 * newest-first; the same request with `limit=5&order=block_height.desc`
 * answered `206 content-range: 0-4/34` in under a second. So the bound is not
 * only about the guard — unbounded is the shape that does not come back.
 */
export type KoiosPage = {
  limit: number;
  /** PostgREST ordering, e.g. `block_height.desc`. Ask explicitly: a page of
   *  "some rows" is only the newest ones if the server was told to sort. */
  order?: string;
};

export async function koios<T>(
  network: PhoenixNetwork,
  path: string,
  body?: unknown,
  page?: KoiosPage,
): Promise<T> {
  const query = page
    ? `?limit=${encodeURIComponent(String(page.limit))}` +
      (page.order ? `&order=${encodeURIComponent(page.order)}` : "")
    : "";
  const res = await fetch(`${koiosBase(network)}${path}${query}`, {
    method: body ? "POST" : "GET",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      // Koios is PostgREST, and PostgREST caps a response at 1000 rows without
      // saying so in the status: measured 2026-09-05 on `/pool_list`, HTTP 200
      // with `content-range: 0-999/*` and exactly 1000 rows, the other 5163
      // simply absent. Asking for an exact count is what makes the cap visible
      // — the same request answers `206` with `content-range: 0-999/6163`.
      prefer: "count=exact",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  // `res.ok` covers 200–299, so it is true for the 206 that says "partial".
  // Checking the range rather than the status is what closes that.
  if (!res.ok) throw new Error(`Koios ${path} → HTTP ${res.status}`);

  // A short answer to a question that asked to be short is not a truncated
  // answer. PostgREST reports both the same way — `206` and a content-range that
  // stops before the total — so only the caller can tell them apart, and the
  // caller says which it asked by passing `page`.
  const range = page ? null : res.headers?.get("content-range");
  if (range) {
    const m = /^(\d+)-(\d+)\/(\d+)$/.exec(range.trim());
    if (m) {
      const end = Number(m[2]);
      const total = Number(m[3]);
      if (end + 1 < total) throw new KoiosTruncatedError(path, end + 1, total);
    }
  }
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

/**
 * Block height of the chain tip.
 *
 * Separate from `fetchTipSlot` because they answer different questions and are
 * not interchangeable: a slot is a time coordinate and is what a transaction's
 * validity interval is expressed in, while a block height counts blocks and is
 * what a confirmation count is measured in. Slots pass whether or not a block
 * is minted, so subtracting slots would overstate confirmations — on mainnet by
 * roughly a factor of twenty.
 */
export async function fetchTipBlockHeight(network: PhoenixNetwork): Promise<number> {
  const rows = await koios<Array<{ block_no: number }>>(network, "/tip");
  const height = rows[0]?.block_no;
  if (typeof height !== "number") throw new Error("Koios returned no tip block height");
  return height;
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

/**
 * Spendable UTxOs for a set of addresses, in the shape the transaction builder
 * takes.
 *
 * UTxOs carrying an inline datum or a reference script are skipped, the same
 * rule `decodeUtxosToInputs` applies to the CIP-30 path. Such a UTxO usually
 * belongs to a script — spending it casually can destroy a reference script
 * other people depend on, and the datum is not ours to reinterpret.
 */
export async function fetchUtxos(
  network: PhoenixNetwork,
  addresses: string[],
): Promise<tyTypes.Input[]> {
  if (addresses.length === 0) return [];
  const rows = await koios<
    Array<{
      tx_hash: string;
      tx_index: number;
      value: string;
      address: string;
      inline_datum: unknown;
      reference_script: unknown;
      asset_list: Array<{ policy_id: string; asset_name: string | null; quantity: string }> | null;
    }>
  >(network, "/address_utxos", { _addresses: addresses, _extended: true });

  const out: tyTypes.Input[] = [];
  for (const r of rows) {
    if (r.inline_datum != null || r.reference_script != null) continue;
    out.push({
      txId: r.tx_hash,
      index: r.tx_index,
      amount: new BigNumber(r.value),
      tokens: (r.asset_list ?? []).map((a) => ({
        policyId: a.policy_id,
        assetName: a.asset_name ?? "",
        amount: new BigNumber(a.quantity),
      })),
      address: tyUtils.getAddressFromString(r.address) as tyTypes.ShelleyAddress,
    });
  }
  return out;
}

/**
 * Submit a signed transaction.
 *
 * Koios `/submittx` takes the raw CBOR bytes, not hex and not JSON, so this is
 * the one call that does not go through `koios()`. A non-2xx response carries
 * the node's rejection reason in the body, and that text is the only useful
 * thing a user or a developer has when a transaction bounces — so it is put
 * into the error rather than swallowed behind the status code.
 */
export async function submitTx(network: PhoenixNetwork, signedCborHex: string): Promise<string> {
  const body = Buffer.from(signedCborHex, "hex");
  const res = await fetch(`${koiosBase(network)}/submittx`, {
    method: "POST",
    headers: { "content-type": "application/cbor" },
    body: body as unknown as BodyInit,
  });
  const text = (await res.text()).trim();
  if (!res.ok) throw new Error(`Koios /submittx → HTTP ${res.status}: ${text.slice(0, 300)}`);
  const hash = text.replace(/^"|"$/g, "");
  if (!/^[0-9a-f]{64}$/i.test(hash)) {
    throw new Error(`Koios /submittx returned no tx hash: ${text.slice(0, 300)}`);
  }
  return hash.toLowerCase();
}

export { tyTypes };

/**
 * Does any address in this batch hold anything?
 *
 * The probe `gapScan` runs on. It asks `fetchAddressBalance`, whose response
 * shape is already load-bearing elsewhere in this file, rather than a
 * per-address history endpoint whose row format would have to be taken on
 * trust — a wrong assumption there would silently under-report a balance, which
 * is the exact bug the scan exists to fix.
 *
 * Every UTxO carries min-ADA, so an address holding anything at all has a
 * positive lovelace balance; there is no "holds only tokens" case to miss.
 */
export async function anyAddressFunded(
  network: PhoenixNetwork,
  addresses: string[],
): Promise<boolean> {
  if (addresses.length === 0) return false;
  const { lovelace } = await fetchAddressBalance(network, addresses);
  return lovelace > BigInt("0");
}
