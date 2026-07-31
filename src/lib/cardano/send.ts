/**
 * Multi-recipient, multi-asset send (ADA + native tokens) via CIP-30.
 *
 * Supersedes the single-output `SendForm.tsx` builder with a Lace-style send:
 * one or more assets to one or more recipient addresses in a single tx. Same
 * two-step safety as `SendForm` — build unsigned → review in plain language →
 * sign+submit. Never build blind.
 *
 * ⚠️ EXPERIMENTAL / UNAUDITED — see `tx.ts` header. This module moves funds.
 */
import BigNumber from "bignumber.js";
import { Transaction, utils as tyUtils, types as tyTypes } from "@stricahq/typhonjs";
import { toNetworkId, type PhoenixNetwork, type BuiltTx } from "@/lib/cardano";

type ProtocolParams = tyTypes.ProtocolParams;
type Input = tyTypes.Input;
type Output = tyTypes.Output;
type TyToken = tyTypes.Token;
type ShelleyAddress = tyTypes.ShelleyAddress;

/** One native-token amount attached to a send row. Not typhon's `Token` shape
 *  (that uses `assetName` + a `BigNumber` amount) — this is the plain-JS shape
 *  the UI works with; `buildMultiSend` converts it. */
export type Token = {
  policyId: string;
  assetNameHex: string;
  amount: bigint;
};

/** A single already-parsed, already-validated recipient output. */
export type SendOutput = {
  address: ShelleyAddress;
  lovelace: bigint;
  tokens: Token[];
};

/** A raw recipient row as typed by the user, before parsing/validation. */
export type RecipientRow = {
  address: string;
  /** Decimal ADA string, e.g. "1.5". Empty/"0" is fine when tokens carry the row. */
  ada: string;
  tokens: Array<{ policyId: string; assetNameHex: string; amount: string }>;
};

const HEX_RE = /^[0-9a-fA-F]*$/;

/**
 * Decimal ADA string → lovelace BigInt. Same rule as `SendForm.tsx`: up to 6
 * decimals, `BigInt("1000000")` scaling (target is ES2017 — no BigInt literals).
 */
export function parseAdaToLovelace(v: string): bigint {
  const trimmed = v.trim();
  if (trimmed === "") return BigInt("0");
  if (!/^\d+(\.\d{1,6})?$/.test(trimmed)) throw new Error("invalid_amount");
  const [whole, frac = ""] = trimmed.split(".");
  return BigInt(whole) * BigInt("1000000") + BigInt(frac.padEnd(6, "0"));
}

/** Raw integer token-quantity string → BigInt. Tokens have no universal decimals
 *  metadata on-chain, so this is the bare unit amount (must be a positive integer). */
export function parseTokenAmount(v: string): bigint {
  const trimmed = v.trim();
  if (!/^\d+$/.test(trimmed)) throw new Error("invalid_amount");
  const n = BigInt(trimmed);
  if (n <= BigInt("0")) throw new Error("invalid_amount");
  return n;
}

/**
 * Parse + validate raw UI rows into `SendOutput[]`:
 *  - resolves each bech32 address via `tyUtils.getAddressFromString`
 *  - rejects a recipient on the wrong network BEFORE build (mainnet address in
 *    a testnet wallet, or vice-versa, would otherwise only fail at submit)
 *  - rejects malformed/zero amounts and malformed policy/asset ids
 *
 * Throws an i18n key as the `Error.message` on the first bad row — mirrors
 * `SendForm.tsx`'s `t("invalid_amount")`-as-thrown-message convention, so
 * callers can `t(err.message)` when surfacing it.
 */
export function buildSendOutputs(rows: RecipientRow[], network: PhoenixNetwork): SendOutput[] {
  if (rows.length === 0) throw new Error("no_recipients");
  const targetNetworkId = toNetworkId(network);
  return rows.map((row) => {
    const addrStr = row.address.trim();
    if (!addrStr) throw new Error("send_to_required");

    let address: ShelleyAddress;
    try {
      address = tyUtils.getAddressFromString(addrStr) as ShelleyAddress;
    } catch {
      throw new Error("invalid_address");
    }
    // Only Shelley-era addresses carry a network id. A Byron/legacy address has
    // no `getNetworkId`, so it would slip past the network check and later break
    // `getBech32()` in the review — reject it outright rather than mislabel it.
    const getNet = (address as { getNetworkId?: () => number }).getNetworkId;
    if (typeof getNet !== "function") throw new Error("invalid_address");
    if (getNet.call(address) !== targetNetworkId) throw new Error("addr_wrong_network");

    const lovelace = parseAdaToLovelace(row.ada);
    const tokens: Token[] = row.tokens.map((tk) => {
      const policyId = tk.policyId.trim().toLowerCase();
      const assetNameHex = tk.assetNameHex.trim().toLowerCase();
      if (policyId.length !== 56 || !HEX_RE.test(policyId)) throw new Error("invalid_asset");
      if (!HEX_RE.test(assetNameHex) || assetNameHex.length > 64) throw new Error("invalid_asset");
      return { policyId, assetNameHex, amount: parseTokenAmount(tk.amount) };
    });

    if (lovelace <= BigInt("0") && tokens.length === 0) throw new Error("invalid_amount");
    return { address, lovelace, tokens };
  });
}

function toTyTokens(tokens: Token[]): TyToken[] {
  return tokens.map((tk) => ({
    policyId: tk.policyId,
    assetName: tk.assetNameHex,
    amount: new BigNumber(tk.amount.toString()),
  }));
}

/**
 * Return the outputs as they will actually appear on-chain: any token-bearing
 * output whose ADA is below the protocol minimum-UTxO gets bumped UP to that
 * minimum. This covers both the token-only case (0 ADA) and a token+dust case
 * (e.g. 0.3 ADA with a token bundle whose minimum is ~1.2 ADA) — the user
 * should never need to know Cardano's minUTxO rule.
 *
 * The review UI MUST render these effective amounts (not the raw typed ADA), so
 * the summary the user confirms equals the value that actually leaves the
 * wallet — no hidden ADA on token-only rows.
 */
export function normalizeSendOutputs(
  outputs: SendOutput[],
  protocolParams: ProtocolParams,
): SendOutput[] {
  const tx = new Transaction({ protocolParams });
  return outputs.map((o) => {
    if (o.tokens.length === 0) return o;
    const min = BigInt(
      tx
        .calculateMinUtxoAmountBabbage({
          address: o.address,
          amount: new BigNumber(o.lovelace.toString()),
          tokens: toTyTokens(o.tokens),
        })
        .toString(),
    );
    return o.lovelace < min ? { ...o, lovelace: min } : o;
  });
}

export type BuildMultiSendRequest = {
  outputs: SendOutput[];
  inputs: Input[];
  changeAddress: ShelleyAddress;
  protocolParams: ProtocolParams;
  ttl: number;
};

/**
 * Build a multi-output, multi-asset payment tx. Mirrors `tx.ts:buildPaymentTx`
 * but for N recipients, each carrying ADA and/or native tokens, in one tx.
 * Outputs are normalized (min-UTxO bump) first, so the built tx matches exactly
 * what `normalizeSendOutputs` shows in the review.
 */
export function buildMultiSend(req: BuildMultiSendRequest): BuiltTx {
  if (req.outputs.length === 0) throw new Error("no_recipients");
  const tx = new Transaction({ protocolParams: req.protocolParams });

  const normalized = normalizeSendOutputs(req.outputs, req.protocolParams);
  const outputs: Output[] = normalized.map((o) => ({
    address: o.address,
    amount: new BigNumber(o.lovelace.toString()),
    tokens: toTyTokens(o.tokens),
  }));

  const prepared = tx.paymentTransaction({
    inputs: req.inputs,
    outputs,
    changeAddress: req.changeAddress,
    ttl: req.ttl,
  });
  const built = prepared.buildTransaction();
  return {
    transaction: prepared,
    unsignedCbor: built.payload,
    hash: built.hash,
    fee: prepared.getFee().toString(),
  };
}
