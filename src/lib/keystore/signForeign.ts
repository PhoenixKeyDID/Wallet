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
 * Everything the approval screen refuses: `requiredKeysFor` runs
 * `summariseTx` over the same bytes and the same `WalletView`, so the two
 * layers share one list of refusals instead of keeping two.
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
import { assertNoDuplicateMapKeys, DuplicateMapKeyError } from "../cardano/cborDupKeys";
import { blake2b256, toHex } from "../cardano/hash";
import { isKeyRewardAccountOn, summariseTx, UndescribableTxError, type TxSummary } from "../cardano/txSummary";
import { LocalSignError, type Account } from "./index";

/** One UTxO the wallet holds, as the approval screen valued it. */
export type HeldInput = {
  /** bech32 of the address the UTxO sits at. */
  address: string;
  lovelace: bigint;
  /** policyId + assetNameHex → quantity. */
  assets: Map<string, bigint>;
};

/**
 * The wallet as the approval screen saw it: which addresses are its own and
 * which UTxOs it holds, keyed `txid#index`.
 *
 * The screen describes a transaction from this view and the signer signs from
 * the SAME object. Reading the wallet a second time at signing would let an
 * input the description never counted — change that landed in between, an
 * indexer that caught up — be attributed to the wallet and signed for, under a
 * screen that said it cost only the fee.
 */
export type WalletView = {
  ownAddressesHex: readonly string[];
  held: ReadonlyMap<string, HeldInput>;
  /**
   * UTxOs this wallet owns at one of its key addresses that carry a reference
   * script. The readers keep these OUT of `held` — spending one destroys
   * published code — but they are still the wallet's, and this wallet's key can
   * sign one away. Kept apart so the summary can refuse a transaction that
   * spends one instead of counting it as a stranger's input whose value never
   * reaches the screen. Empty when the reader supplied none.
   */
  heldWithScript: ReadonlyMap<string, HeldInput>;
};

/** One of the wallet's UTxOs, in the shape both input lists arrive in. */
type ViewInput = {
  txId: string;
  index: number;
  amount: { toFixed(n: number): string };
  tokens?: readonly { policyId: string; assetName?: string; amount: { toFixed(n: number): string } }[];
  address: { getBech32(): string };
};

/**
 * Build the view from the wallet's input list, refusing a shape it cannot
 * value.
 *
 * `inputsWithScript` are the wallet's own UTxOs the readers keep OUT of the
 * spendable set because they carry a reference script. They are valued the same
 * way and kept in `heldWithScript`, so the summary can refuse a transaction
 * that spends one rather than mistake it for a stranger's input. A reader that
 * does not surface them passes none, and `heldWithScript` is empty.
 */
export function walletViewFrom(
  inputs: readonly ViewInput[],
  ownAddressesHex: readonly string[],
  inputsWithScript: readonly ViewInput[] = [],
): WalletView {
  const whole = (v: { toFixed(n: number): string }, what: string): bigint => {
    const s = v.toFixed(0);
    if (!/^\d+$/.test(s)) throw new LocalSignError("sign_foreign_unreadable_own_utxo", what);
    return BigInt(s);
  };
  const collect = (list: readonly ViewInput[]): Map<string, HeldInput> => {
    const m = new Map<string, HeldInput>();
    for (const i of list) {
      const ref = `${i.txId}#${i.index}`;
      if (m.has(ref)) throw new LocalSignError("sign_foreign_unreadable_own_utxo", ref);
      const assets = new Map<string, bigint>();
      for (const tk of i.tokens ?? []) {
        const unit = tk.policyId + (tk.assetName ?? "");
        assets.set(unit, (assets.get(unit) ?? BigInt(0)) + whole(tk.amount, ref));
      }
      m.set(ref, { address: i.address.getBech32(), lovelace: whole(i.amount, ref), assets });
    }
    return m;
  };
  return {
    ownAddressesHex: [...ownAddressesHex],
    held: collect(inputs),
    heldWithScript: collect(inputsWithScript),
  };
}

/**
 * The transaction id: blake2b-256 of the body exactly as it was serialised.
 *
 * What a person looks up on an explorer when a submit came back with no answer
 * and the bytes may already be on chain.
 */
export function txIdOf(txCborHex: string): string {
  return toHex(blake2b256(bodyBytes(Buffer.from(txCborHex, "hex"))));
}

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

/** How many entries a CBOR list/set/map holds; anything else is not a transaction. */
function countOf(v: unknown): number {
  if (v === undefined) return 0;
  if (Array.isArray(v)) return v.length;
  if (v instanceof Set || v instanceof Map) return v.size;
  throw new LocalSignError("sign_foreign_not_a_tx");
}

/** A mint quantity below zero — a burn. Zero and anything positive are not. */
function isNegativeInteger(v: unknown): boolean {
  if (typeof v === "number") return Number.isSafeInteger(v) && v < 0;
  if (typeof v === "bigint") return v < BigInt(0);
  // @stricahq/cbors hands large integers back as BigNumber-like objects.
  if (v && typeof v === "object" && typeof (v as { toFixed?: unknown }).toFixed === "function") {
    return /^-\d+$/.test((v as { toFixed(n: number): string }).toFixed(0)) && (v as { toFixed(n: number): string }).toFixed(0) !== "-0";
  }
  return false;
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
  view: WalletView,
): RequiredKeys {
  const txBytes = Buffer.from(txCborHex, "hex");
  if (txBytes.length === 0) throw new LocalSignError("sign_foreign_not_a_tx");
  // A duplicate map key lets a dangerous field hide behind a harmless one: the
  // decoder keeps the later value, so `{… 4:[cert], 4:[] }` reads as having no
  // certificate. The screen refuses it (`summariseTx`, run at the end here) and
  // this function, which touches the keys, refuses it up front — the body hash
  // is taken from these same bytes, so a body that cannot be read unambiguously
  // must never reach the signer.
  try {
    assertNoDuplicateMapKeys(txBytes);
  } catch (e) {
    if (e instanceof DuplicateMapKeyError) throw new LocalSignError("sign_foreign_duplicate_key");
    // Any OTHER failure means the bytes are not CBOR this walker can follow —
    // malformed, truncated, a reserved encoding, an indefinite-length outer
    // array. Giving a verdict here would mask the specific refusals below
    // (`bodyBytes`' encoding check, then the decoder), which name the problem
    // with the right error. A well-formed transaction the decoder can read is
    // always one this walker can read too, so nothing carrying a real duplicate
    // key reaches the signer by falling through this branch.
  }
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

  // `is_valid = false` is the transaction declaring its own script fails; if
  // one does, the ledger takes the collateral and does nothing else. The
  // screen refuses it (`summariseTx`) and so does this function. Read from the
  // whole transaction, since the flag sits beside the body, not in it — which
  // is also why this refusal is not a protection: the witness signs the body
  // hash only, so a page can have the `true` version signed and submit the
  // same body with `false`, or attach a script that fails. The collateral is
  // protected by the 5 ADA cap `summariseTx` applies (run at the end of this
  // function), not by this check.
  let whole: unknown;
  try {
    whole = Decoder.decode(txBytes).value;
  } catch {
    throw new LocalSignError("sign_foreign_not_a_tx");
  }
  if (Array.isArray(whole) && whole.length >= 3 && whole[2] === false) {
    throw new LocalSignError("sign_foreign_declared_invalid");
  }

  const need: string[] = [];
  const add = (hashHex: string) => {
    if (!need.includes(hashHex)) need.push(hashHex);
  };

  // ── What this wallet refuses to sign for a website, whatever the screen said ─
  //
  // The approval window refuses these too, and says why (`txSummary.ts`). They
  // are repeated here, with their own error keys, because this is the function
  // that touches the keys. The full set the screen refuses is applied at the
  // end of this function by running the screen's own `summariseTx`.

  // The network the body names is the network the signature is for. A body for
  // another network is refused before any key is looked at.
  const ledgerNetworkId = account.network === 1 ? 1 : 0;
  const declaredNetwork = b.get(15);
  if (declaredNetwork !== undefined && Number(declaredNetwork) !== ledgerNetworkId) {
    throw new LocalSignError("sign_foreign_wrong_network", String(declaredNetwork));
  }

  // Every certificate. A certificate does not move money on the screen, it
  // hands over a standing right — the stake to a pool, the vote to a DRep —
  // and this wallet cannot yet show the person whom it goes to. Until it can,
  // no certificate from a website is signed, of any kind, aimed at anyone.
  if (countOf(b.get(4)) > 0) throw new LocalSignError("sign_foreign_certificate");

  // Minting. A burn takes tokens out of existence and is shown on the screen;
  // creating tokens is a policy saying yes, and a policy that wants this
  // wallet's key wants it for a reason the screen cannot read.
  const mint = b.get(9);
  if (mint !== undefined) {
    if (!(mint instanceof Map)) throw new LocalSignError("sign_foreign_not_a_tx");
    for (const names of mint.values()) {
      if (!(names instanceof Map)) throw new LocalSignError("sign_foreign_not_a_tx");
      for (const qty of names.values()) {
        if (!isNegativeInteger(qty)) throw new LocalSignError("sign_foreign_mint");
      }
    }
  }

  const keyOfOwnInput = (i: unknown, what: "input" | "collateral"): string | null => {
    if (!Array.isArray(i) || i.length < 2) throw new LocalSignError("sign_foreign_not_a_tx");
    const ref = `${Buffer.from(i[0] as Buffer).toString("hex")}#${Number(i[1])}`;
    const addr = view.held.get(ref)?.address;
    if (!addr) {
      // Somebody else's input is somebody else's to sign. Somebody else's
      // collateral is not: the screen can only say what this wallet risks if
      // every collateral input is one it can value.
      if (what === "collateral") throw new LocalSignError("sign_foreign_collateral_not_own", ref);
      return null;
    }
    const parsed = tyUtils.getAddressFromString(addr) as {
      paymentCredential?: { hash?: Buffer | Uint8Array };
    };
    const hash = parsed.paymentCredential?.hash;
    if (!hash) throw new LocalSignError("sign_foreign_unreadable_own_address");
    return Buffer.from(hash).toString("hex");
  };

  const rawInputs = b.get(0);
  const inputList = rawInputs instanceof Set ? [...rawInputs] : rawInputs;
  if (!Array.isArray(inputList)) throw new LocalSignError("sign_foreign_not_a_tx");
  for (const i of inputList) {
    const k = keyOfOwnInput(i, "input");
    if (k) add(k);
  }

  // Collateral inputs need their key's witness exactly like spent inputs do —
  // the ledger only takes collateral from key-locked outputs, and checks the
  // key signed. A collateral UTxO at a different address than the fee input
  // is the ordinary case, not an edge one.
  const rawCollateral = b.get(13);
  if (rawCollateral !== undefined) {
    const list = rawCollateral instanceof Set ? [...rawCollateral] : rawCollateral;
    if (!Array.isArray(list)) throw new LocalSignError("sign_foreign_not_a_tx");
    for (const i of list) {
      const k = keyOfOwnInput(i, "collateral");
      if (k) add(k);
    }
  }

  // ── Every refusal the approval screen applies, applied here by the same code ─
  //
  // The checks above are this function's own and stay, because they name the
  // reason precisely. They do not cover everything the screen refuses: a body
  // field outside the allow-list (20, 21, 22 — treasury donations, proposals,
  // votes — and anything later), a collateral return paid to an address that
  // is not this wallet, a declared collateral total that disagrees with the
  // collateral, collateral that can lose more than 5 ADA, the same input
  // named twice. Re-implementing those here would be a second copy that
  // drifts from the first. So the screen's own function is run over the same
  // bytes and the same wallet view, and its refusal is this function's
  // refusal. A screen that forgets to describe still cannot get a witness for
  // a transaction the description would have refused. It runs before the
  // withdrawal keys below, because which withdrawals are this wallet's is
  // read from its answer.
  let summary: TxSummary;
  try {
    summary = summariseTx(txCborHex, view.ownAddressesHex, view.held, ledgerNetworkId, view.heldWithScript);
  } catch (e) {
    // A refusal the screen names by key (the collateral cap, tokens in the
    // collateral) is refused here under the same key.
    if (e instanceof UndescribableTxError) throw new LocalSignError(e.key ?? "sign_foreign_undescribable", e.message);
    throw e;
  }

  // Everything added above is justified by an input this wallet was able to
  // attribute to itself. One more key can be justified, but only by the body
  // saying what it is for — never by the transaction simply naming it.
  const justified = new Set(need);

  // A withdrawal moves this wallet's staking rewards. Signing it needs the
  // stake key, and the reward account in the body says whose rewards they are:
  // one header byte, then the 28-byte key hash.
  //
  // Two sources answer "is this withdrawal ours": the account's stake key,
  // which decides whether a witness can be made, and the summary, which
  // decided whether the screen counted the rewards as leaving this wallet
  // (from the stake part of `view.ownAddressesHex`). A witness is added only
  // when both say yes. When they disagree — a view with no addresses, an
  // address list from another account — the screen described one transaction
  // and the key would sign another, so it is a refusal.
  const counted = new Set(summary.ownRewardKeyHashes);
  const withdrawals = b.get(5);
  if (withdrawals instanceof Map) {
    for (const rewardAccount of withdrawals.keys()) {
      const raw = Buffer.from(rewardAccount as Buffer);
      if (raw.length !== 29) continue;
      const stakeHash = raw.subarray(1).toString("hex");
      const accountKey = isKeyRewardAccountOn(raw, ledgerNetworkId) && stakeHash === account.stakeKeyHashHex;
      if (accountKey !== counted.has(stakeHash)) {
        throw new LocalSignError("sign_foreign_withdrawal_mismatch", stakeHash);
      }
      if (accountKey) {
        justified.add(account.stakeKeyHashHex);
        // Justified AND needed: the ledger will not move these rewards without
        // the stake key's witness, whether or not field 14 names it. Leaving it
        // to field 14 meant every dApp that (correctly) omits it got back a
        // witness set the node rejects.
        add(account.stakeKeyHashHex);
      }
    }
  }

  // `required_signers` (field 14) names key hashes outright, and the page that
  // sent this transaction wrote that field. Honouring it as written turns the
  // wallet into an oracle: name the stake key and the wallet signs the staking
  // rewards away, while the approval screen — which reads inputs and outputs —
  // describes a transaction that costs nothing. So a named hash is only ever
  // *matched* against what the body already justified. A hash this wallet holds
  // but cannot explain is a refusal, not a signature. A hash it does not hold is
  // left alone, because that one is a genuine "another wallet must also sign",
  // which is what `partialSign` exists to answer.
  const signers = b.get(14);
  const signerList = signers instanceof Set ? [...signers] : signers;
  if (Array.isArray(signerList)) {
    for (const s of signerList) {
      const hashHex = Buffer.from(s as Buffer).toString("hex");
      if (!justified.has(hashHex) && account.keyByHash.has(hashHex)) {
        throw new LocalSignError("sign_unjustified_signer", hashHex);
      }
      add(hashHex);
    }
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
  view: WalletView,
  partialSign: boolean,
): string {
  const { keyHashes, bodyHashHex } = requiredKeysFor(txCborHex, account, view);

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
