/**
 * The Blockfrost REST dialect — the face Cnode's own chain access already speaks.
 *
 * This is an adapter, not an indexer. The platform runs Dolos on its own Cardano
 * nodes and Dolos serves `MiniBF`, a Blockfrost-compatible REST API; the point of
 * this file is that the wallet can read from that instead of from a public
 * third-party service, without a second copy of the chain logic. Blockfrost SaaS
 * speaks the same dialect, so the same code reaches either — the dialect is what
 * is implemented here, not a vendor.
 *
 * **What is verified and what is not.** The request shapes and field names below
 * are Blockfrost's documented API, which is stable and public. Byte-level parity
 * between that documentation and a specific Dolos build is **not** verified here
 * and must not be claimed: Cnode's own spec marks it `[VERIFY-ON-BUILD]` and
 * says in as many words not to assume 100% parity. Nothing in this repo can
 * settle that, because the MiniBF port is bound to loopback on the machines that
 * run it (`INV-không-mở-cổng-thừa`) and is not reachable from here. What this
 * file does is make the wallet ready for the endpoint the moment one exists, and
 * fail loudly rather than quietly if a field is missing when it arrives.
 *
 * **Two shape differences that would be silent bugs if unhandled**, both handled
 * below and both tested:
 *
 * - **Amounts are a list, and lovelace is an entry in it.** Koios returns a
 *   `balance` string plus a separate asset list; Blockfrost returns one array
 *   whose `unit` is either the literal `lovelace` or `policyId + assetNameHex`
 *   concatenated. Reading the first entry as ADA works right up until an address
 *   holds a token, and then it reports somebody's token count as their money.
 * - **An address that has never been used is a `404`, not an empty balance.**
 *   Treating that as an error breaks the address scan, which asks about
 *   addresses precisely because it does not yet know whether they were used;
 *   every scan would stop at the first unused address and under-report the
 *   wallet. Treating *every* 404 as empty would be the opposite mistake, so it
 *   is narrowed to the two endpoints where "not on chain yet" is a real answer.
 */
import "../node-globals";
import { Buffer } from "buffer";
import BigNumber from "bignumber.js";
import { types as tyTypes, utils as tyUtils } from "@stricahq/typhonjs";
import { ProviderUnreachableError } from "./provider";
import type { AddressBalance } from "./provider";

type ProtocolParams = tyTypes.ProtocolParams;

/** The lovelace entry's `unit`, spelled out rather than inferred from length. */
const LOVELACE = "lovelace";

export type BlockfrostEndpoint = { base: string; projectId?: string };

/** Marks a `404` that means "this address has never appeared on chain". */
export class NotOnChainError extends Error {
  constructor(path: string) {
    super(`${path} → not on chain`);
    this.name = "NotOnChainError";
  }
}

async function bf<T>(
  ep: BlockfrostEndpoint,
  path: string,
  init?: { method?: string; body?: BodyInit; contentType?: string },
): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (ep.projectId) headers.project_id = ep.projectId;
  if (init?.contentType) headers["content-type"] = init.contentType;

  let res: Response;
  try {
    res = await fetch(`${ep.base}${path}`, {
      method: init?.method ?? "GET",
      headers,
      body: init?.body,
    });
  } catch (cause) {
    // Same reasoning as the Koios path: a `TypeError` from `fetch` says nothing
    // about the server, and calling it silence is a wrong fact stated
    // confidently. See `ProviderUnreachableError`.
    throw new ProviderUnreachableError(`Chain endpoint ${path}`, cause);
  }
  if (res.status === 404) throw new NotOnChainError(path);
  if (!res.ok) {
    // Blockfrost puts a reason in the body and it is the only useful thing a
    // person has when a call is rejected — a bad key, a wrong network, a rate
    // limit. Replacing it with the status alone throws that away.
    const text = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`Chain endpoint ${path} → HTTP ${res.status}${text ? `: ${text}` : ""}`);
  }
  return (await res.json()) as T;
}

/**
 * Ceilings identical to the Koios path's, and for the identical reason.
 *
 * Duplicated deliberately rather than shared: these bound a *response*, and each
 * source is a separate response to bound. A shared table would make it look as
 * though one check covers both, which is exactly the reading that leaves the
 * second source unchecked when someone adds a third.
 */
const PARAM_CEILING = {
  minFeeA: 100_000,
  minFeeB: 100_000_000,
  stakeKeyDeposit: 1_000_000_000,
  utxoCostPerByte: 10_000_000,
} as const;

function checked(name: keyof typeof PARAM_CEILING, raw: string | number | undefined): BigNumber {
  if (raw === undefined || raw === null) {
    throw new Error(`the chain endpoint returned no ${name}`);
  }
  const v = new BigNumber(raw);
  if (!v.isFinite() || v.isNegative() || v.isGreaterThan(PARAM_CEILING[name])) {
    throw new Error(`the chain endpoint returned an implausible ${name}: ${String(raw)}`);
  }
  return v;
}

export async function bfProtocolParams(ep: BlockfrostEndpoint): Promise<ProtocolParams> {
  const p = await bf<{
    min_fee_a?: number;
    min_fee_b?: number;
    key_deposit?: string | number;
    coins_per_utxo_size?: string | number;
    collateral_percent?: number;
    price_step?: string | number;
    price_mem?: string | number;
    max_tx_size?: number;
    max_val_size?: string | number;
    min_fee_ref_script_cost_per_byte?: number;
  }>(ep, "/epochs/latest/parameters");
  if (p.max_tx_size === undefined || p.max_val_size === undefined) {
    throw new Error("the chain endpoint returned no transaction size limits");
  }
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

type LatestBlock = { slot?: number | null; height?: number | null };

/**
 * Absolute slot of the tip.
 *
 * Blockfrost's `slot` is the absolute slot, the same coordinate Koios calls
 * `abs_slot`. Named here so nobody later "fixes" it into `epoch_slot`, which
 * counts from the start of the epoch and would set every transaction's validity
 * interval to a moment days in the past.
 */
export async function bfTipSlot(ep: BlockfrostEndpoint): Promise<number> {
  const b = await bf<LatestBlock>(ep, "/blocks/latest");
  if (typeof b.slot !== "number") throw new Error("the chain endpoint returned no tip slot");
  return b.slot;
}

export async function bfTipBlockHeight(ep: BlockfrostEndpoint): Promise<number> {
  const b = await bf<LatestBlock>(ep, "/blocks/latest");
  if (typeof b.height !== "number") {
    throw new Error("the chain endpoint returned no tip block height");
  }
  return b.height;
}

type Amount = { unit?: unknown; quantity?: unknown };

function splitUnit(unit: string): { policyId: string; assetNameHex: string } {
  // A policy id is 28 bytes — 56 hex characters — and the asset name is whatever
  // follows. A shorter unit is not a policy id at all, and quietly slicing it
  // would produce a plausible-looking asset that does not exist.
  if (unit.length < 56) throw new Error(`the chain endpoint returned a malformed asset unit: ${unit}`);
  return { policyId: unit.slice(0, 56), assetNameHex: unit.slice(56) };
}

function readAmounts(
  amounts: Amount[],
  onLovelace: (q: bigint) => void,
  onAsset: (unit: string, policyId: string, assetNameHex: string, q: bigint) => void,
): void {
  for (const a of amounts) {
    if (typeof a.unit !== "string" || typeof a.quantity !== "string") {
      throw new Error("the chain endpoint returned an amount with no unit or quantity");
    }
    const q = BigInt(a.quantity);
    if (a.unit === LOVELACE) {
      onLovelace(q);
      continue;
    }
    const { policyId, assetNameHex } = splitUnit(a.unit);
    onAsset(a.unit, policyId, assetNameHex, q);
  }
}

export async function bfAddressBalance(
  ep: BlockfrostEndpoint,
  addresses: string[],
): Promise<AddressBalance> {
  let lovelace = BigInt("0");
  const byUnit = new Map<string, { policyId: string; assetNameHex: string; quantity: bigint }>();

  // One request per address: Blockfrost has no batch address endpoint, which is
  // a real cost difference against Koios and is stated rather than hidden. It is
  // also why `anyAddressFunded` keeps its early exit — a gap scan over an empty
  // account should stop, not walk the whole window.
  for (const addr of addresses) {
    let row: { amount?: Amount[] };
    try {
      row = await bf<{ amount?: Amount[] }>(ep, `/addresses/${encodeURIComponent(addr)}`);
    } catch (e) {
      // An address nobody has ever paid holds nothing. That is an answer, not a
      // failure — and reporting it as a failure is what would stop an address
      // scan at its first unused address.
      if (e instanceof NotOnChainError) continue;
      throw e;
    }
    readAmounts(
      row.amount ?? [],
      (q) => (lovelace += q),
      (unit, policyId, assetNameHex, q) => {
        const prev = byUnit.get(unit);
        byUnit.set(unit, { policyId, assetNameHex, quantity: (prev?.quantity ?? BigInt("0")) + q });
      },
    );
  }
  return { lovelace, assets: [...byUnit].map(([unit, v]) => ({ unit, ...v })) };
}

export async function bfUtxos(
  ep: BlockfrostEndpoint,
  addresses: string[],
): Promise<tyTypes.Input[]> {
  const out: tyTypes.Input[] = [];
  for (const addr of addresses) {
    let rows: Array<{
      tx_hash?: string;
      output_index?: number;
      amount?: Amount[];
      address?: string;
      inline_datum?: unknown;
      data_hash?: unknown;
      reference_script_hash?: unknown;
    }>;
    try {
      rows = await bf(ep, `/addresses/${encodeURIComponent(addr)}/utxos`);
    } catch (e) {
      if (e instanceof NotOnChainError) continue;
      throw e;
    }
    for (const r of rows) {
      // Same rule as the Koios path and the CIP-30 path: a UTxO carrying a datum
      // or a reference script usually belongs to a script. Spending it casually
      // can destroy a reference script other people depend on, and the datum is
      // not ours to reinterpret. `data_hash` is included because a datum can be
      // attached by hash rather than inline, and a wallet that skips only the
      // inline case would spend exactly the outputs whose meaning it cannot see.
      if (r.inline_datum != null || r.data_hash != null || r.reference_script_hash != null) continue;
      if (typeof r.tx_hash !== "string" || typeof r.output_index !== "number") {
        throw new Error("the chain endpoint returned an unspent output with no id");
      }
      let amount = new BigNumber(0);
      const tokens: tyTypes.Token[] = [];
      readAmounts(
        r.amount ?? [],
        (q) => (amount = new BigNumber(q.toString())),
        (_unit, policyId, assetNameHex, q) =>
          tokens.push({
            policyId,
            assetName: assetNameHex,
            amount: new BigNumber(q.toString()),
          }),
      );
      out.push({
        txId: r.tx_hash,
        index: r.output_index,
        amount,
        tokens,
        address: tyUtils.getAddressFromString(
          r.address ?? addr,
        ) as tyTypes.ShelleyAddress,
      });
    }
  }
  return out;
}

/**
 * Submit signed transaction bytes.
 *
 * The body is raw CBOR, not hex and not JSON — the same as the Koios path, and
 * the same trap: sending hex gets a rejection whose text is about malformed CBOR
 * rather than about the wallet having sent the wrong thing.
 */
export async function bfSubmitTx(ep: BlockfrostEndpoint, signedCborHex: string): Promise<string> {
  const headers: Record<string, string> = { "content-type": "application/cbor" };
  if (ep.projectId) headers.project_id = ep.projectId;
  const body = Buffer.from(signedCborHex, "hex");

  let res: Response;
  try {
    res = await fetch(`${ep.base}/tx/submit`, {
      method: "POST",
      headers,
      body: body as unknown as BodyInit,
    });
  } catch (cause) {
    throw new ProviderUnreachableError("Chain endpoint /tx/submit", cause);
  }
  const text = (await res.text()).trim();
  if (!res.ok) {
    throw new Error(`Chain endpoint /tx/submit → HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const hash = text.replace(/^"|"$/g, "");
  if (!/^[0-9a-f]{64}$/i.test(hash)) {
    throw new Error(`Chain endpoint /tx/submit returned no tx hash: ${text.slice(0, 300)}`);
  }
  return hash.toLowerCase();
}
