/**
 * One shape for "the wallet the user is spending from", whichever it is.
 *
 * `signer.ts` already said this was the intent — *"both take the same `BuiltTx`
 * … that is what keeps the send, staking and governance builders from having to
 * know which mode is in use"* — but nothing implemented it, so the panels took a
 * raw `Cip30Api` and `signAndSubmitLocal` had no caller anywhere in the UI. A
 * wallet created in this app held funds it could not move from this app: the
 * user had to restore the recovery phrase into Lace to spend. That gap is what
 * this file closes.
 *
 * ## Why the port hands back decoded inputs, not CIP-30 hex
 *
 * The obvious shortcut is to make the local side impersonate a `Cip30Api`, so
 * nothing else changes. It would mean encoding the account's UTxOs to CBOR for
 * the panel to immediately decode them back — a serializer written for no other
 * reason, sitting on the path where a mistake spends the wrong input. The seam
 * belongs one level up, where both sides already have what the builder wants.
 *
 * ## Why `signAndSubmit` is one call and not `sign` then `submit`
 *
 * Between those two steps sits the case that loses money: a submit whose
 * outcome is unknown. Both implementations already handle it the same way, by
 * raising `SubmitUncertainError` carrying the hash so the UI can say "this may
 * have gone through — check before resending" instead of inviting a second
 * send. Splitting the call would put that decision back in every caller.
 */
import type { types as tyTypes } from "@stricahq/typhonjs";
import type { AssetAmount, Cip30Api } from "./cip30";
import { cip30NetworkId, type PhoenixNetwork } from "./address";
import { blake2b224, fromHex, toHex } from "./hash";
import { decodeUtxosToInputs, signAndSubmitCip30, type BuiltTx } from "./tx";

export type WalletPort = {
  /**
   * Where the signature comes from. The UI must be able to say this out loud:
   * "an extension is holding your key" and "this page is holding your key" are
   * different promises to the person about to press send.
   */
  kind: "cip30" | "local";
  /** Spendable inputs, already decoded — never a half-open CBOR string. */
  getInputs(): Promise<tyTypes.Input[]>;
  /** Hex reward (stake) address. Hex because that is what CIP-30 returns. */
  getRewardAddressHex(): Promise<string>;
  /**
   * One address to hand out, hex, or `null` when the wallet can offer none.
   *
   * Deliberately not `getUnusedAddresses()` passed through. That is a CIP-30
   * question — "which of my addresses has the chain never seen" — and a local
   * account cannot answer it, because an account object knows its addresses and
   * nothing about their history. Asking the narrower question the screen
   * actually has ("what do I show this person?") is a question both sides can
   * answer truthfully, and each answers it the best way it can.
   */
  getReceiveAddressHex(): Promise<string | null>;
  /**
   * Every address this wallet will admit to owning, hex.
   *
   * Used by the receive screen's "is this account key really yours?" check, so
   * an empty list is meaningful: it means *undecidable*, not *not yours*. Both
   * implementations must therefore return everything they know, and neither may
   * substitute a guess — a wrong `owned` set turns the check that exists to
   * catch a pasted attacker key into the thing that blesses it.
   */
  getOwnedAddressesHex(): Promise<string[]>;
  /**
   * blake2b-224 of the dRep public key, or `null` when this wallet cannot say.
   *
   * CIP-95 `getPubDRepKey` is an optional extension, so the CIP-30 side probes
   * for it and reports `null` when it is absent — governance stays visible and
   * the build fails with a clear message rather than the tab disappearing. A
   * local account derived the dRep key itself (chain 3) and simply knows.
   * Never throws: a missing governance key is not a reason to break the page.
   */
  getDrepKeyHashHex(): Promise<string | null>;
  /**
   * Sign and put on the wire. Raises `SubmitUncertainError` when unsure.
   *
   * Takes a `PhoenixNetwork`, not a CIP-30 network id, and the difference
   * matters: CIP-30 answers `0` for **every** testnet, so preprod and preview
   * are the same number to it. A local account is bound to one of them at
   * derivation time, so handing the CIP-30 id down here would make a preview
   * wallet fail its own network check against preprod. Each side narrows to
   * what its own counterpart understands, and no caller has to remember which.
   */
  signAndSubmit(built: BuiltTx, network: PhoenixNetwork): Promise<string>;
};

/**
 * Which native tokens these inputs actually hold, summed per asset.
 *
 * The send form used to read this from CIP-30 `getBalance()`, which no local
 * account has. Deriving it from the same inputs the transaction will be built
 * from is not just the portable answer, it is the more truthful one: a balance
 * call reports everything the wallet owns, including value locked in UTxOs that
 * carry a datum or a reference script — which the builder skips. Offering those
 * in a send form is offering to spend something the next step will not touch.
 */
export function sumAssets(inputs: tyTypes.Input[]): AssetAmount[] {
  const byUnit = new Map<string, AssetAmount>();
  for (const input of inputs) {
    for (const token of input.tokens ?? []) {
      const policyId = token.policyId;
      const assetNameHex = token.assetName ?? "";
      // A policy id is 28 bytes. Without this check `policyId + assetNameHex`
      // is ambiguous: `{aa, bb}` and `{aabb, ""}` both spell the unit `aabb`,
      // and their quantities would be added together under whichever policy id
      // arrived first. The CIP-30 side cannot produce a short policy id — it
      // decodes 28 raw bytes — but the local side takes these straight from the
      // indexer's JSON, which is outside data.
      if (!/^[0-9a-f]{56}$/i.test(policyId)) {
        throw new Error(`indexer returned a malformed policy id: ${policyId}`);
      }
      // Refuse a quantity that is not a whole, non-negative number rather than
      // rounding it. `toFixed(0)` turns 1.5 into 2 and 0.4 into 0 — inventing a
      // token the wallet does not hold, or hiding one it does, and both land in
      // the picker the user chooses what to spend from. Loud is correct here:
      // the send form catches this and says the balance could not be read,
      // which is true, instead of offering a number that is quietly wrong.
      const amount = token.amount;
      if (!amount.isFinite() || !amount.isInteger() || amount.isNegative()) {
        throw new Error(`indexer returned a malformed token amount: ${amount.toString()}`);
      }
      const unit = policyId + assetNameHex;
      const quantity = BigInt(amount.toFixed(0));
      const seen = byUnit.get(unit);
      if (seen) seen.quantity += quantity;
      else byUnit.set(unit, { unit, policyId, assetNameHex, quantity });
    }
  }
  return [...byUnit.values()];
}

/** The extension path: reads and signing both delegated to the connected wallet. */
export function cip30Port(api: Cip30Api): WalletPort {
  return {
    kind: "cip30",
    async getInputs() {
      const hex = await api.getUtxos();
      if (!hex || hex.length === 0) return [];
      return decodeUtxosToInputs(hex);
    },
    async getRewardAddressHex() {
      const addrs = await api.getRewardAddresses();
      const hex = addrs?.[0];
      if (!hex) throw new Error("stake_account_error");
      return hex;
    },
    async getReceiveAddressHex() {
      const unused = await api.getUnusedAddresses();
      if (unused && unused.length > 0) return unused[0] ?? null;
      // A wallet that has spent everything reports no unused address. Reusing a
      // used one is worse for privacy and better than showing the person
      // nothing when they are trying to be paid.
      const used = await api.getUsedAddresses();
      return used?.[0] ?? null;
    },
    async getOwnedAddressesHex() {
      const [used, unused] = await Promise.all([api.getUsedAddresses(), api.getUnusedAddresses()]);
      return [...(used ?? []), ...(unused ?? [])];
    },
    async getDrepKeyHashHex() {
      try {
        // CIP-95 lives either on the api object or under a `cip95` namespace,
        // depending on the wallet. Both spellings are in the wild, and a wallet
        // may expose BOTH — so the function and the object it is called on must
        // come from the SAME branch. Picking them independently (`cip95 ?? api`
        // for one, `api.getPubDRepKey ?? …` for the other) calls the top-level
        // function with the namespace as `this`, which throws inside any wallet
        // whose api is a class reading private state. That failure is invisible:
        // it lands in the catch below and the governance tab reports "your
        // wallet does not support this" to a wallet that does.
        const anyApi = api as unknown as {
          getPubDRepKey?: () => Promise<string>;
          cip95?: { getPubDRepKey?: () => Promise<string> };
        };
        const holder = typeof anyApi.getPubDRepKey === "function" ? anyApi : anyApi.cip95;
        const fn = holder?.getPubDRepKey;
        if (!holder || typeof fn !== "function") return null;

        const bytes = fromHex(await fn.call(holder));
        // An ed25519 public key is 32 bytes, and nothing else may be hashed.
        //
        // This check is the difference between a wrong answer and no answer. A
        // CBOR-wrapped key (`5820` + 32 bytes = 34) and an extended key
        // (`pubkey‖chaincode` = 64) are both even-length hex, so they parse
        // cleanly and hash to a perfectly well-formed 56-hex string. Measured:
        // the same key as raw/CBOR/extended gives f9dca21a…, 88d98393… and
        // 3d913cd6… — three different dRep ids, one of them yours.
        //
        // Signing under a wrong id fails closed, because the node wants a
        // witness nobody can produce. Displaying one does not: the governance
        // screen shows this hash as the user's dRep id to publish, and anyone
        // delegating to it hands their voting power to a credential no one
        // controls — Conway does not require a dRep to be registered before it
        // can be delegated to, so nothing anywhere reports an error.
        if (bytes.length !== 32) return null;
        return toHex(blake2b224(bytes));
      } catch {
        return null;
      }
    },
    signAndSubmit: (built, network) =>
      signAndSubmitCip30(api, built, cip30NetworkId(network)),
  };
}
