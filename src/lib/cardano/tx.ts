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
import type { Cip30Api } from "./cip30";

type ProtocolParams = tyTypes.ProtocolParams;
type Input = tyTypes.Input;
type Output = tyTypes.Output;
type Token = tyTypes.Token;
type ShelleyAddress = tyTypes.ShelleyAddress;

function coerceBig(v: unknown): BigNumber {
  if (v instanceof BigNumber) return v;
  if (typeof v === "number") return new BigNumber(v);
  if (v && typeof (v as { toFixed?: (n: number) => string }).toFixed === "function") {
    return new BigNumber((v as { toFixed: (n: number) => string }).toFixed(0));
  }
  return new BigNumber(String(v));
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
 */
export function decodeUtxosToInputs(utxosHex: string[]): Input[] {
  const inputs: Input[] = [];
  for (const hex of utxosHex) {
    const { value } = Decoder.decode(Buffer.from(hex, "hex"));
    const [input, output] = value as [[Buffer, number], unknown];
    const txId = Buffer.from(input[0]).toString("hex");
    const index = Number(input[1]);

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
 */
export async function signAndSubmitCip30(api: Cip30Api, built: BuiltTx): Promise<string> {
  const witnessSetHex = await api.signTx(built.unsignedCbor, true);
  for (const w of decodeVkeyWitnesses(witnessSetHex)) built.transaction.addWitness(w);
  const signed = built.transaction.buildTransaction();
  return api.submitTx(signed.payload);
}
