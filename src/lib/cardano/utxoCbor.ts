/**
 * The two CIP-30 reads a dApp builds a transaction from — `getUtxos` and
 * `getBalance` — encoded from the wallet's own inputs.
 *
 * `tx.ts` has the other direction (`decodeUtxosToInputs`, for the Connect mode
 * that *reads* another wallet). This file is what lets this wallet *answer*
 * those calls, and without it the extension refused both: no dApp could build
 * a transaction against it at all.
 *
 * ## The inputs, and only the inputs
 *
 * Both functions take the same `Input[]` the signing path resolves witnesses
 * against (`WalletPort.getInputs`). A dApp is then handed exactly the set this
 * wallet can sign for: a UTxO it reports and cannot sign is a transaction that
 * fails at the last step, and a UTxO it can sign and does not report is money
 * the dApp never offers to spend.
 *
 * The consequence for `getBalance` is stated rather than hidden: it is the
 * balance of those inputs, so value parked in UTxOs carrying an inline datum or
 * a reference script — which `fetchUtxos` skips on purpose — is not in it.
 *
 * ## Refuse, never round
 *
 * The amounts come from an indexer's JSON, which is outside data. A quantity
 * that is not a whole, positive number, or a policy id that is not 28 bytes, is
 * thrown on — encoding it would hand the dApp a UTxO the ledger does not have,
 * and the transaction built on it would bounce with a message about a ledger
 * rule instead of the indexer.
 */
import "../node-globals";
import { Buffer } from "buffer";
import { Encoder } from "@stricahq/cbors";
import type { types as tyTypes } from "@stricahq/typhonjs";

type Input = tyTypes.Input;

const HEX_RE = /^(?:[0-9a-f]{2})*$/i;

function wholeAmount(v: { isFinite(): boolean; isInteger(): boolean; toFixed(n: number): string }, what: string, allowZero: boolean): bigint {
  if (!v || !v.isFinite() || !v.isInteger()) throw new Error(`malformed ${what}: not a whole number`);
  const n = BigInt(v.toFixed(0));
  if (n < BigInt(0) || (!allowZero && n === BigInt(0))) throw new Error(`malformed ${what}: ${n}`);
  return n;
}

/**
 * Ledger `value`: a bare coin when there are no tokens, else
 * `[coin, { policy: { name: qty } }]`. Policies and names are kept in the order
 * they were first seen; CIP-30 asks for valid CBOR, not canonical CBOR.
 */
function encodeValue(lovelace: bigint, tokens: tyTypes.Token[]): unknown {
  if (tokens.length === 0) return lovelace;
  const byPolicy = new Map<string, Map<string, bigint>>();
  for (const tk of tokens) {
    if (!/^[0-9a-f]{56}$/i.test(tk.policyId)) throw new Error(`malformed policy id: ${tk.policyId}`);
    const name = tk.assetName ?? "";
    if (!HEX_RE.test(name) || name.length > 64) throw new Error(`malformed asset name: ${name}`);
    const qty = wholeAmount(tk.amount, "token amount", false);
    const names = byPolicy.get(tk.policyId.toLowerCase()) ?? new Map<string, bigint>();
    names.set(name.toLowerCase(), (names.get(name.toLowerCase()) ?? BigInt(0)) + qty);
    byPolicy.set(tk.policyId.toLowerCase(), names);
  }
  const multiasset = new Map<Buffer, Map<Buffer, bigint>>();
  for (const [policy, names] of byPolicy) {
    const inner = new Map<Buffer, bigint>();
    for (const [name, qty] of names) inner.set(Buffer.from(name, "hex"), qty);
    multiasset.set(Buffer.from(policy, "hex"), inner);
  }
  return [lovelace, multiasset];
}

/**
 * CIP-30 `getUtxos()`: one hex `TransactionUnspentOutput` per input —
 * `[[tx_hash, index], [address, value]]`.
 *
 * The output is the legacy array form with no datum, which is truthful for
 * these inputs and no others: `fetchUtxos` drops every UTxO carrying an inline
 * datum or a reference script before it gets here.
 */
export function encodeInputsAsUtxosHex(inputs: Input[]): string[] {
  return inputs.map((i) => {
    if (!/^[0-9a-f]{64}$/i.test(i.txId)) throw new Error(`malformed tx id: ${i.txId}`);
    if (!Number.isInteger(i.index) || i.index < 0) throw new Error(`malformed output index: ${i.index}`);
    const lovelace = wholeAmount(i.amount, "lovelace amount", false);
    const addr = Buffer.from(i.address.getHex(), "hex");
    const value = encodeValue(lovelace, i.tokens ?? []);
    return Encoder.encode([[Buffer.from(i.txId, "hex"), i.index], [addr, value]]).toString("hex");
  });
}

/** CIP-30 `getBalance()`: the summed `value` of the same inputs, as hex CBOR. */
export function encodeBalanceHex(inputs: Input[]): string {
  let lovelace = BigInt(0);
  const tokens: tyTypes.Token[] = [];
  for (const i of inputs) {
    lovelace += wholeAmount(i.amount, "lovelace amount", false);
    for (const tk of i.tokens ?? []) tokens.push(tk);
  }
  return Encoder.encode(encodeValue(lovelace, tokens)).toString("hex");
}
