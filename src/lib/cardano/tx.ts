/**
 * Transaction building for the browser wallet — pure JS via @stricahq/typhonjs.
 *
 * ⚠️ EXPERIMENTAL / UNAUDITED. This module moves funds. It has unit tests for
 * the UTxO decoder but has NOT been verified end-to-end on-chain in this
 * environment. Keep it behind the dev-warning banner and test on preprod with
 * throwaway funds before trusting it. Never spend value you cannot lose.
 *
 * Flow (CIP-30 mode): build unsigned tx from the extension's UTxOs → the
 * extension signs (partialSign) → merge the returned witness set → submit.
 * The same unsigned CBOR feeds the air-gap QR path (`qr.ts`) once the offline
 * signer ships.
 */
import { Buffer } from "buffer";
import BigNumber from "bignumber.js";
import { Decoder } from "@stricahq/cbors";
import { Transaction, utils as tyUtils, types as tyTypes } from "@stricahq/typhonjs";
import { assertSameNetwork, type Cip30Api } from "./cip30";

type ProtocolParams = tyTypes.ProtocolParams;
type Input = tyTypes.Input;
type Output = tyTypes.Output;
type Token = tyTypes.Token;
type ShelleyAddress = tyTypes.ShelleyAddress;

/**
 * Coerce a CBOR-decoded integer to BigNumber, refusing anything that is not one.
 *
 * The input comes from the extension, i.e. from outside. `new BigNumber(String(undefined))`
 * is `NaN` and BigNumber does NOT throw on it — the NaN then flows into an input
 * amount, through the coin selection, and out as a malformed transaction or a
 * nonsense fee. Reject at the boundary so a broken wallet is a clear error, not
 * silent arithmetic damage.
 */
function coerceBig(v: unknown): BigNumber {
  const n =
    v instanceof BigNumber
      ? v
      : typeof v === "number"
        ? new BigNumber(v)
        : v && typeof (v as { toFixed?: (n: number) => string }).toFixed === "function"
          ? new BigNumber((v as { toFixed: (n: number) => string }).toFixed(0))
          : new BigNumber(String(v));
  if (!n.isFinite()) throw new Error("wallet returned a non-numeric amount in a UTxO");
  return n;
}

function decodeValue(value: unknown): { ada: BigNumber; tokens: Token[] } {
  if (!Array.isArray(value)) return { ada: coerceBig(value), tokens: [] };
  const [coin, multiasset] = value as [unknown, Map<Buffer, Map<Buffer, unknown>> | undefined];
  const tokens: Token[] = [];
  if (multiasset instanceof Map) {
    multiasset.forEach((names, policy) => {
      const policyId = Buffer.from(policy).toString("hex");
      names.forEach((qty, name) => {
        tokens.push({
          policyId,
          assetName: Buffer.from(name).toString("hex"),
          amount: coerceBig(qty),
        });
      });
    });
  }
  return { ada: coerceBig(coin), tokens };
}

/**
 * Decode a CIP-30 `getUtxos()` array (hex TransactionUnspentOutput) into typhon
 * `Input`s. Handles both legacy-array and Babbage-map output forms.
 *
 * UTxOs that carry an inline datum (Babbage output key 2) or a reference script
 * (key 3) are SKIPPED: they are special-purpose (a deployed reference script, a
 * script-locked output) and casually spending them in a plain payment would
 * destroy the deployed script or drop the datum. A normal payment wallet's
 * spendable UTxOs have neither, so this only filters what should never be spent
 * here — never silently swallows ordinary funds.
 *
 * Duplicates are dropped by `txId#index`: a UTxO listed twice would be spent
 * twice in the same transaction, which the ledger rejects outright — better to
 * de-duplicate here than to hand the user an unexplainable submit failure.
 */
export function decodeUtxosToInputs(utxosHex: string[]): Input[] {
  const inputs: Input[] = [];
  const seen = new Set<string>();
  for (const hex of utxosHex) {
    const { value } = Decoder.decode(Buffer.from(hex, "hex"));
    const [input, output] = value as [[Buffer, number], unknown];
    const txId = Buffer.from(input[0]).toString("hex");
    const index = Number(input[1]);
    const ref = `${txId}#${index}`;
    if (seen.has(ref)) continue;

    let addrBuf: Buffer;
    let amountValue: unknown;
    if (Array.isArray(output)) {
      // legacy: [address, value, ?datum_hash] — a bare datum-hash is spendable.
      addrBuf = Buffer.from(output[0] as Buffer);
      amountValue = output[1];
    } else if (output instanceof Map) {
      // Babbage: {0: address, 1: value, 2: ?inline-datum, 3: ?reference-script}
      if (output.has(2) || output.has(3)) continue; // skip datum/script-ref UTxOs
      addrBuf = Buffer.from(output.get(0) as Buffer);
      amountValue = output.get(1);
    } else {
      throw new Error("unrecognised UTxO output format");
    }

    const { ada, tokens } = decodeValue(amountValue);
    const address = tyUtils.getAddressFromHex(addrBuf) as ShelleyAddress;
    seen.add(ref);
    inputs.push({ txId, index, amount: ada, tokens, address });
  }
  return inputs;
}

export type SendRequest = {
  toAddress: ShelleyAddress;
  lovelace: bigint;
  tokens?: Token[];
  changeAddress: ShelleyAddress;
  inputs: Input[];
  protocolParams: ProtocolParams;
  ttl: number;
};

export type BuiltTx = {
  transaction: Transaction;
  unsignedCbor: string;
  hash: string;
  fee: string;
};

/** Build a simple payment (ADA + optional native tokens). Returns unsigned CBOR. */
export function buildPaymentTx(req: SendRequest): BuiltTx {
  const output: Output = {
    address: req.toAddress,
    amount: new BigNumber(req.lovelace.toString()),
    tokens: req.tokens ?? [],
  };
  const tx = new Transaction({ protocolParams: req.protocolParams }).paymentTransaction({
    inputs: req.inputs,
    outputs: [output],
    changeAddress: req.changeAddress,
    ttl: req.ttl,
  });
  const built = tx.buildTransaction();
  return { transaction: tx, unsignedCbor: built.payload, hash: built.hash, fee: tx.getFee().toString() };
}

/** Decode a CIP-30 witness-set CBOR into typhon VKeyWitnesses (map key 0). */
export function decodeVkeyWitnesses(witnessSetHex: string): tyTypes.VKeyWitness[] {
  const { value } = Decoder.decode(Buffer.from(witnessSetHex, "hex"));
  const set = value instanceof Map ? value.get(0) : undefined;
  if (!Array.isArray(set)) return [];
  return (set as Array<[Buffer, Buffer]>).map(([publicKey, signature]) => ({
    publicKey: Buffer.from(publicKey),
    signature: Buffer.from(signature),
  }));
}

/**
 * CIP-30 signing: hand the unsigned tx to the extension for a partial sign,
 * merge the returned vkey witnesses, and submit. Returns the tx hash.
 *
 * `expectedNetworkId` is the CIP-30 network id captured when the wallet
 * connected (mainnet 1, any testnet 0). It is a REQUIRED parameter, not an
 * option: this is the one chokepoint every signing path in the app passes
 * through, so making it impossible to omit is what guarantees no flow can sign
 * against a wallet that silently switched networks. See `assertSameNetwork`.
 */
export async function signAndSubmitCip30(
  api: Cip30Api,
  built: BuiltTx,
  expectedNetworkId: number,
): Promise<string> {
  await assertSameNetwork(api, expectedNetworkId);
  const witnessSetHex = await api.signTx(built.unsignedCbor, true);
  for (const w of decodeVkeyWitnesses(witnessSetHex)) built.transaction.addWitness(w);
  const signed = built.transaction.buildTransaction();
  try {
    return await api.submitTx(signed.payload);
  } catch (err) {
    // TxSendError.Refused (1) is the wallet declining to send: the transaction
    // never left, and saying so plainly is safe. Anything else — a node error,
    // a dropped connection, a timeout inside the extension — leaves the one
    // question that matters unanswered: did it go out or not? Answering that
    // with a bare "failed" is what makes people send the same money twice.
    if (err && typeof err === "object" && (err as { code?: unknown }).code === 1) throw err;
    throw new SubmitUncertainError(signed.hash, err);
  }
}

/**
 * The transaction was signed and handed over, but the submit did not come back
 * with an answer. It may be on the network already. The hash is the way out:
 * with it the user can look the transaction up before deciding to resend, which
 * is the only safe way to resolve the doubt.
 */
export class SubmitUncertainError extends Error {
  constructor(
    readonly txHash: string,
    override readonly cause: unknown,
  ) {
    super(`Transaction ${txHash} was signed, but its submission was not confirmed.`);
    this.name = "SubmitUncertainError";
  }
}
