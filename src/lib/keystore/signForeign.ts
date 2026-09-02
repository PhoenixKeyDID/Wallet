/**
 * Sign a transaction this wallet did not build.
 *
 * `signer.ts` signs a `BuiltTx`: a typhon `Transaction` that knows its own body
 * hash and can list the key hashes it requires. A website hands over CBOR and
 * nothing else, so both of those have to be worked out from the bytes — and
 * getting either wrong is not a failure, it is a signature over something other
 * than what the user was shown.
 *
 * ## The body hash is taken from the bytes, and re-encoding is not allowed
 *
 * The hash a witness signs is blake2b-256 of the **transaction body as it was
 * serialised**, not of a re-encoding of a decoded body. CBOR has more than one
 * valid encoding for the same data, so decode-then-re-encode can produce
 * different bytes, a different hash, and a witness that verifies against a
 * transaction nobody has. So the body's original byte range is sliced out of
 * the input and hashed as-is.
 *
 * ## Only the keys the transaction actually needs
 *
 * One witness per required key, and no more. A spare witness makes the
 * transaction larger than the fee already computed for it and the node rejects
 * the whole thing — so "sign with everything we hold" is a real bug, not
 * belt-and-braces. It is also a privacy leak: every extra public key tells the
 * chain another address belongs to this wallet.
 *
 * ## What it refuses
 *
 * A key the wallet does not hold. `partialSign: false` with any required key
 * missing — because that flag is the dApp promising the wallet can complete the
 * signature alone, and a wallet that returns a partial set anyway hands back
 * something that looks signed and is not.
 */
import "../node-globals";
import { Buffer } from "buffer";
import { Decoder, Encoder } from "@stricahq/cbors";
import { utils as tyUtils } from "@stricahq/typhonjs";
import { blake2b256, toHex } from "../cardano/hash";
import { LocalSignError, type Account } from "./index";

/** What the wallet must be able to sign for, derived from the body. */
export type RequiredKeys = {
  /** Payment/stake key hashes, hex, in the order they were found. */
  keyHashes: string[];
  /** blake2b-256 of the body exactly as it was serialised. */
  bodyHashHex: string;
};

/**
 * Find the body's byte range inside the transaction, without re-encoding it.
 *
 * `@stricahq/cbors` decodes a whole value at a time and reports no offsets, so
 * the length of the first element has to be discovered. Re-encoding the decoded
 * body instead would be far simpler and is the trap: CBOR admits more than one
 * valid encoding of the same data, the ledger hashes the bytes it was *given*,
 * and a re-encoded body that differs by a single length prefix yields a witness
 * that verifies against a transaction that does not exist.
 *
 * So the length is found by binary search on "does this prefix decode exactly?"
 * The decoder's three answers are strictly ordered — measured against it:
 * `Insufficient data` below the true length, success at it, `Remaining Bytes`
 * above — which is what makes the search sound rather than a guess. Fourteen
 * decodes settle a 16 KB transaction.
 */
function bodyBytes(txBytes: Buffer): Buffer {
  const header = txBytes[0];
  if (header === undefined) throw new LocalSignError("sign_foreign_not_a_tx");
  // 0x80 | n: a definite-length array of n elements, n < 24. Every Cardano
  // transaction is a 4-element array; an indefinite-length or larger header is
  // refused rather than guessed at, because a wrong offset is a wrong hash and
  // nothing downstream would notice.
  if ((header & 0xe0) !== 0x80 || (header & 0x1f) > 23 || (header & 0x1f) < 2) {
    throw new LocalSignError("sign_foreign_unexpected_encoding");
  }
  const rest = txBytes.subarray(1);

  let lo = 1;
  let hi = rest.length;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      Decoder.decode(rest.subarray(0, mid));
      found = mid;
      break;
    } catch (e) {
      // "Remaining Bytes" means the prefix already contained a whole value and
      // then some, so the body is shorter. Anything else means it ran out.
      if (/remaining/i.test((e as Error).message)) hi = mid - 1;
      else lo = mid + 1;
    }
  }
  if (found <= 0) throw new LocalSignError("sign_foreign_unexpected_encoding");
  return Buffer.from(rest.subarray(0, found));
}

/**
 * Which keys this transaction needs from this wallet.
 *
 * Inputs are attributed by looking each one up in what the wallet holds: an
 * input's address is not in the transaction, only its `txid#index`, so there is
 * no way to know whose it is without the wallet's own UTxO view. An input the
 * wallet does not recognise contributes no key — it is somebody else's to sign.
 */
export function requiredKeysFor(
  txCborHex: string,
  account: Account,
  ownInputAddressByRef: Map<string, string>,
): RequiredKeys {
  const txBytes = Buffer.from(txCborHex, "hex");
  if (txBytes.length === 0) throw new LocalSignError("sign_foreign_not_a_tx");
  const body = bodyBytes(txBytes);
  const bodyHashHex = toHex(blake2b256(body));

  let decoded: unknown;
  try {
    decoded = Decoder.decode(body).value;
  } catch {
    throw new LocalSignError("sign_foreign_not_a_tx");
  }
  if (!(decoded instanceof Map)) throw new LocalSignError("sign_foreign_not_a_tx");
  const b = decoded as Map<number, unknown>;

  const need: string[] = [];
  const add = (hashHex: string) => {
    if (!need.includes(hashHex)) need.push(hashHex);
  };

  const rawInputs = b.get(0);
  const inputList = rawInputs instanceof Set ? [...rawInputs] : rawInputs;
  if (!Array.isArray(inputList)) throw new LocalSignError("sign_foreign_not_a_tx");
  for (const i of inputList) {
    if (!Array.isArray(i) || i.length < 2) throw new LocalSignError("sign_foreign_not_a_tx");
    const ref = `${Buffer.from(i[0] as Buffer).toString("hex")}#${Number(i[1])}`;
    const addr = ownInputAddressByRef.get(ref);
    if (!addr) continue;
    const parsed = tyUtils.getAddressFromString(addr) as {
      paymentCredential?: { hash?: Buffer | Uint8Array };
    };
    const hash = parsed.paymentCredential?.hash;
    if (!hash) throw new LocalSignError("sign_foreign_unreadable_own_address");
    add(Buffer.from(hash).toString("hex"));
  }

  // `required_signers` (field 14) names key hashes outright. A transaction can
  // demand a signature from a key that owns none of the inputs — that is what
  // the field is for — so it must be honoured or the signature is incomplete.
  const signers = b.get(14);
  const signerList = signers instanceof Set ? [...signers] : signers;
  if (Array.isArray(signerList)) {
    for (const s of signerList) add(Buffer.from(s as Buffer).toString("hex"));
  }

  return { keyHashes: need, bodyHashHex };
}

/**
 * Produce the witness set CIP-30 `signTx` must return, as CBOR hex.
 *
 * The return value is **only the witness set**, never the whole transaction —
 * CIP-30 is explicit about that, and a wallet returning a full transaction here
 * makes every dApp that merges the answer produce a malformed one.
 */
export function signForeignTx(
  txCborHex: string,
  account: Account,
  ownInputAddressByRef: Map<string, string>,
  partialSign: boolean,
): string {
  const { keyHashes, bodyHashHex } = requiredKeysFor(txCborHex, account, ownInputAddressByRef);

  const bodyHash = Buffer.from(bodyHashHex, "hex");
  if (bodyHash.length !== 32) throw new LocalSignError("sign_bad_body_hash");

  const witnesses: [Buffer, Buffer][] = [];
  const missing: string[] = [];
  for (const hashHex of keyHashes) {
    const prv = account.keyByHash.get(hashHex);
    if (!prv) {
      missing.push(hashHex);
      continue;
    }
    witnesses.push([Buffer.from(prv.toPublicKey().toBytes()), Buffer.from(prv.sign(bodyHash))]);
  }

  if (missing.length > 0 && !partialSign) {
    // The dApp said this wallet could finish the signature by itself. It cannot,
    // and returning what it has would look like success.
    throw new LocalSignError("sign_key_not_in_wallet", missing.join(","));
  }
  if (witnesses.length === 0) {
    // Nothing to contribute. Returning an empty witness set would be a wallet
    // reporting that it signed while having signed nothing.
    throw new LocalSignError("sign_no_required_witnesses");
  }

  return Encoder.encode(new Map<number, unknown>([[0, witnesses]])).toString("hex");
}
