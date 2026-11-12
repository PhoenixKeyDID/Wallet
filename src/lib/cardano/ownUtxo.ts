/**
 * Which unspent outputs at this wallet's addresses it counts as its own money —
 * one rule, read by every UTxO reader and by the approval screen.
 *
 * ## The rule
 *
 * An output is the wallet's to spend unless:
 *
 * - it carries a **reference script**. Spending it destroys published code
 *   that other transactions may be reading by reference, and a payment wallet
 *   has no business deciding that; or
 * - it carries a **datum** AND its payment credential is a **script**. Such an
 *   output is locked by that script and the datum is the script's state; this
 *   wallet holds no witness for it.
 *
 * An output whose payment credential is a **key** is the wallet's, datum or not
 * — inline datum and datum hash alike. The ledger ignores the datum on an input
 * locked by a key: spending it needs only the key's signature, no datum in the
 * witness set and no script. The LAMP drip-pot depends on exactly this: every
 * claim pays the LAMP to the claimer's key address under an inline datum that
 * tags the pot it came from (LAMP `Distribution/drip-pot/SERVICE.md §3.4`). A
 * wallet that skipped those outputs would receive the LAMP and never show or
 * spend it.
 *
 * ## Why one function
 *
 * The readers (Koios and Blockfrost `fetchUtxos`, CIP-30 `decodeUtxosToInputs`)
 * decide what the wallet can spend; `summariseTx` decides whether an output to
 * one of the wallet's own addresses is change or money leaving. If those two
 * answers ever differ, the approval screen lies: an output counted as change
 * that the wallet then cannot see is money gone while the screen said it came
 * back. So both call this, and nothing else decides it.
 */
import { Buffer } from "buffer";
import type { types as tyTypes } from "@stricahq/typhonjs";

/**
 * The datum an own UTxO carries on chain, kept so the CIP-30 `getUtxos` answer
 * can describe the output as it really is.
 *
 * This is information about the output, never a witness: it is deliberately
 * NOT typhon's `plutusData`, which would put the datum into the witness set of
 * every transaction that spends the input — a datum the ledger does not need
 * for a key-locked input, and an extra byte cost at best.
 */
export type ChainDatum = { kind: "inline"; cborHex: string } | { kind: "hash"; hashHex: string };

/** A spendable input with the datum it carries on chain, if any. */
export type WalletInput = tyTypes.Input & { chainDatum?: ChainDatum };

/** What the rule needs to know about one output. */
export type OutputFacts = { addressHex: string; datum: boolean; referenceScript: boolean };

/**
 * True when the address's payment credential is a key hash.
 *
 * Shelley header types 0, 2, 4, 6 (base, base with script stake, pointer,
 * enterprise) have a key payment credential; the odd types have a script one.
 * Byron (8) and reward addresses (14, 15) are not "key" here: a Byron output
 * has no payment credential in this sense, and a reward address holds no UTxO.
 */
export function paymentCredentialIsKey(addressHex: string): boolean {
  if (!/^[0-9a-f]{2}/i.test(addressHex)) throw new Error("an address with no header byte");
  const type = parseInt(addressHex.slice(0, 2), 16) >> 4;
  return type === 0 || type === 2 || type === 4 || type === 6;
}

/** The rule above. Every reader and the approval screen call this. */
export function walletOwnsOutput(o: OutputFacts): boolean {
  if (o.referenceScript) return false;
  if (o.datum && !paymentCredentialIsKey(o.addressHex)) return false;
  return true;
}

const HEX_RE = /^(?:[0-9a-f]{2})+$/i;

/**
 * The datum fields of an indexer row, read strictly. A field that is present
 * but not hex is a shape this wallet does not know, and is thrown on: reading
 * it as "no datum" would describe the output to a dApp as something it is not.
 * `where` names the UTxO, so the message points at something.
 */
export function readChainDatum(inline: unknown, hash: unknown, where: string): ChainDatum | undefined {
  if (inline != null) {
    if (typeof inline !== "string" || !HEX_RE.test(inline)) {
      throw new Error(`the chain endpoint returned an inline datum this wallet cannot read on ${where}`);
    }
    return { kind: "inline", cborHex: inline.toLowerCase() };
  }
  if (hash != null) {
    if (typeof hash !== "string" || !/^[0-9a-f]{64}$/i.test(hash)) {
      throw new Error(`the chain endpoint returned a datum hash this wallet cannot read on ${where}`);
    }
    return { kind: "hash", hashHex: hash.toLowerCase() };
  }
  return undefined;
}

/** Address bytes as hex, for the header check. */
export function addressHexOf(address: { getHex(): string } | Buffer): string {
  return Buffer.isBuffer(address) ? address.toString("hex") : address.getHex();
}
