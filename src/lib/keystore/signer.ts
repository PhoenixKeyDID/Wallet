/**
 * Local signing — the in-page counterpart to `signAndSubmitCip30`.
 *
 * The two paths deliberately converge: both take the same `BuiltTx`, both end
 * by merging vkey witnesses into the same `Transaction` and submitting the same
 * bytes. Only the source of the signature differs. That is what keeps the send,
 * staking and governance builders from having to know which mode is in use.
 *
 * ## Signing exactly the required keys, and no more
 *
 * The fee was computed while building, from the number of witnesses the
 * transaction expects. Adding an extra witness makes the transaction bigger
 * than the fee paid for, and the node rejects it; missing one makes it
 * invalid. So the signer does not guess and does not sign "everything it
 * owns" — it asks the builder, via `getRequiredWitnesses()`, which key hashes
 * need a signature, and answers exactly those.
 *
 * If a required hash is not one of ours, that is a bug or a tampered
 * transaction, and it fails loudly rather than producing a half-signed
 * transaction that dies at the node with an opaque error.
 */
import { Buffer } from "buffer";
import type { types as tyTypes } from "@stricahq/typhonjs";
import type { BuiltTx } from "../cardano/tx";
import { SubmitUncertainError } from "../cardano/tx";
import type { Account } from "./derive";

export class LocalSignError extends Error {
  constructor(
    readonly key: string,
    readonly detail?: string,
  ) {
    super(detail ? `${key}: ${detail}` : key);
    this.name = "LocalSignError";
  }
}

/**
 * Produce the vkey witnesses this transaction requires, using the account's
 * in-memory keys. Pure: it does not mutate the transaction.
 */
export function witnessesFor(built: BuiltTx, account: Account): tyTypes.VKeyWitness[] {
  const required = [...built.transaction.getRequiredWitnesses().keys()];
  if (required.length === 0) throw new LocalSignError("sign_no_required_witnesses");

  const bodyHash = Buffer.from(built.hash, "hex");
  if (bodyHash.length !== 32) throw new LocalSignError("sign_bad_body_hash");

  return required.map((keyHashHex) => {
    const prv = account.keyByHash.get(keyHashHex);
    if (!prv) throw new LocalSignError("sign_key_not_in_wallet", keyHashHex);
    return {
      publicKey: prv.toPublicKey().toBytes(),
      signature: prv.sign(bodyHash),
    };
  });
}

/** How the signed bytes reach the network. Injected so tests never touch it. */
export type Submitter = (signedCborHex: string) => Promise<string>;

/**
 * Sign with local keys and submit.
 *
 * `expectedNetwork` mirrors the guard on the CIP-30 path. There is no
 * extension to drift out from under us here, but the account itself is bound
 * to a network at derivation time (its addresses carry the network tag), and a
 * mismatch means the UI is about to send a transaction built for one chain
 * signed by an account belonging to another. Refusing costs nothing.
 */
export async function signAndSubmitLocal(
  built: BuiltTx,
  account: Account,
  expectedNetwork: number,
  submit: Submitter,
): Promise<string> {
  if (account.network !== expectedNetwork) {
    throw new LocalSignError(
      "sign_network_mismatch",
      `account=${account.network} expected=${expectedNetwork}`,
    );
  }

  for (const w of witnessesFor(built, account)) built.transaction.addWitness(w);
  const signed = built.transaction.buildTransaction();

  try {
    return await submit(signed.payload);
  } catch (err) {
    // Same reasoning as the CIP-30 path: a submit whose outcome is unknown
    // must hand back the hash, because resending blind is how people pay
    // twice. There is no "user declined" case here — the user already
    // confirmed, and nothing else can decline on their behalf.
    throw new SubmitUncertainError(signed.hash, err);
  }
}
