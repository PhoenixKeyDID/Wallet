/**
 * Read a set-typed field of a transaction someone else built.
 *
 * The Conway ledger CDDL gives every set two encodings, and both are correct:
 *
 *     set<a>          = #6.258([* a]) / [* a]
 *     nonempty_set<a> = #6.258([+ a]) / [+ a]
 *
 * (cardano-ledger, `eras/conway/impl/cddl/data/conway.cddl`).
 * Builders on current libraries (CSL 17, Lucid) emit the tagged form by
 * default. `@stricahq/cbors` decodes it to a `CborTag` whose `value` is the
 * array — never to a JavaScript `Set` — so a reader that only checks
 * `Array.isArray` refuses every such transaction, and a reader that skips what
 * it does not recognise skips the field altogether.
 *
 * This is the one place that unwraps a set, for the approval screen
 * (`summariseTx`) and the signer (`requiredKeysFor`) alike, so the two cannot
 * read the same bytes two ways. It is strict in both directions: a plain array
 * or tag 258 around an array is a set; anything else — another tag, tag 258
 * around something that is not an array, a map, a number — is a
 * `CborSetError`, never an empty list. Emptiness is the caller's question,
 * because `set` and `nonempty_set` differ there and each field has its own
 * existing answer.
 *
 * Unwrapping reads; it does not re-encode. Nothing here touches the bytes the
 * body hash is taken from.
 */
import "../node-globals";
import { CborTag, Encoder } from "@stricahq/cbors";

/** RFC 8742 "set" — the tag the Conway CDDL puts on a set. */
export const CBOR_SET_TAG = 258;

export type CborSetFault = "shape" | "duplicate";

export class CborSetError extends Error {
  constructor(readonly fault: CborSetFault, message: string) {
    super(message);
    this.name = "CborSetError";
  }
}

/**
 * The elements of a set-typed field, from either encoding.
 *
 * `unique: true` also refuses the same element twice — the ledger models the
 * field as a set, and a body naming one element twice describes something the
 * ledger will not do. Two elements are the same when they re-encode to the same
 * bytes: that compares values (an integer written in a longer form than it
 * needs is still the same integer), and the re-encoding is used for nothing but
 * this comparison.
 */
export function readCborSet(v: unknown, opts: { unique?: boolean } = {}): unknown[] {
  let list: unknown;
  if (Array.isArray(v)) list = v;
  else if (v instanceof CborTag && v.tag === CBOR_SET_TAG && Array.isArray(v.value)) list = v.value;
  else throw new CborSetError("shape", "not a set: neither an array nor tag 258 around one");
  const items = [...(list as unknown[])];
  if (opts.unique) {
    const seen = new Set<string>();
    for (const item of items) {
      let key: string;
      try {
        key = Encoder.encode(item).toString("hex");
      } catch {
        throw new CborSetError("shape", "a set element this wallet cannot read");
      }
      if (seen.has(key)) throw new CborSetError("duplicate", "the same element twice in a set");
      seen.add(key);
    }
  }
  return items;
}
