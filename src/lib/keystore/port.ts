/**
 * The local-key side of `WalletPort`.
 *
 * This file lives inside `src/lib/keystore/` on purpose, and it is the reason
 * `check:keystore-boundary` did not have to be widened to add spending. The
 * boundary rule — only `LocalWalletPanel` may import the keystore — is what
 * lets the spec describe Connect, Watch-only and custody as key-free modes. If
 * this adapter sat in `src/lib/cardano/` next to its CIP-30 twin, every panel
 * importing the port would transitively pull the keystore in, and that sentence
 * would quietly stop being true. So the twin lives here, `LocalWalletPanel`
 * constructs it, and the panels below receive an already-built port that could
 * have come from either side.
 *
 * ## Reads come from the indexer, not from the account
 *
 * An account object knows its addresses; it does not know which of them hold
 * money. So `getInputs` asks Koios, exactly as the balance view does. That also
 * means local spending inherits the same constraint as local balances: it works
 * where Koios is reachable, which today is inside the extension.
 *
 * ## Change goes to an internal address that currently holds nothing
 *
 * BIP-44 puts change on the internal chain (role 1), which the external chain
 * never advertises — sending change back to a receive address publishes it. We
 * cannot ask the indexer "was this ever used", only "does it hold anything now",
 * so this picks the first internal address with no live UTxO and falls back to
 * index 0. That is weaker than a real gap scan and stronger than always
 * reusing one address, which is what the obvious version does.
 */
import "../node-globals";
import { utils as tyUtils, type types as tyTypes } from "@stricahq/typhonjs";
import { fetchUtxos, submitTx } from "../cardano/provider";
import type { PhoenixNetwork } from "../cardano/address";
import type { BuiltTx } from "../cardano/tx";
import type { WalletPort } from "../cardano/walletPort";
import { allAddresses, type Account, type DerivedAddress } from "./derive";
import { signAndSubmitLocal } from "./signer";

const hexOf = (bech32: string): string =>
  (tyUtils.getAddressFromString(bech32) as { getHex(): string }).getHex();

/**
 * First address in `candidates` that holds nothing right now, else the first.
 *
 * "Holds nothing" is not "never used" — an address that received and then spent
 * everything looks identical to a virgin one from here. A real gap scan needs
 * the indexer's address *history*, which is a bigger ask than the balance query
 * this wallet already makes. Falling back to index 0 keeps the wallet correct
 * (funds are always reachable) at the cost of address reuse in the exhausted
 * case, which is a privacy loss, not a loss of money.
 */
function firstUnoccupied(candidates: DerivedAddress[], inputs: tyTypes.Input[]): string | null {
  const occupied = new Set(inputs.map((i) => i.address.getBech32()));
  const chosen = candidates.find((a) => !occupied.has(a.address)) ?? candidates[0];
  return chosen?.address ?? null;
}

/**
 * Pick where change should land: an internal address holding no UTxO right now,
 * else the first internal address. Never an external one — BIP-44 puts change
 * on the internal chain precisely so that sending change to a receive address
 * does not publish an address the owner is still handing out.
 */
export function changeAddressFor(account: Account, inputs: tyTypes.Input[]): string {
  const chosen = firstUnoccupied(account.internal, inputs);
  if (!chosen) throw new Error("account has no internal addresses");
  return chosen;
}

/**
 * The change address the feature tabs should build with, hex, resolved once.
 *
 * The tabs take `changeAddress` as a plain string because CIP-30 hands one over
 * at connect time and two panels decode it synchronously while rendering. A
 * local account has to go ask the indexer instead, so this is the seam where
 * that asymmetry is absorbed: resolve it when the wallet unlocks, then the tabs
 * cannot tell the two modes apart.
 *
 * Resolved once per unlock, not per transaction, so two transactions signed in
 * the same session may share a change address. That is address reuse, not a
 * lost output — and the alternative, re-probing inside the builder, would put a
 * network round trip on the path between "review" and "sign".
 */
export async function changeAddressHexFor(account: Account): Promise<string> {
  let inputs: tyTypes.Input[] = [];
  try {
    inputs = await fetchUtxos(account.network, allAddresses(account));
  } catch {
    /* an unreachable indexer must not stop the wallet opening */
  }
  return hexOf(changeAddressFor(account, inputs));
}

/**
 * Wrap an unlocked account as a `WalletPort`.
 *
 * The network is taken from the account and cannot be passed in, which is not a
 * convenience. This used to accept `network` alongside `account`, and the two
 * were then used on different axes: reads and the submit went to the network
 * *argument*, while the only safety check — `signAndSubmitLocal` — compared the
 * account against the network the *tab* asked for. Nothing compared the
 * argument to the account at all.
 *
 * That gap is invisible on Cardano's testnets, because preprod and preview share
 * one address prefix: a preprod account handed `network = 2` reads real preview
 * UTxOs, passes the check (`account.network === expected`, both 0), and submits
 * a transaction built from preprod protocol parameters and a preprod TTL to
 * preview. Removing the parameter removes the axis.
 */
export function localPort(account: Account): WalletPort {
  const network = account.network;
  return {
    kind: "local",
    getInputs: () => fetchUtxos(network, allAddresses(account)),
    getRewardAddressHex: async () => hexOf(account.rewardAddress),
    async getReceiveAddressHex() {
      // Ask the indexer which external addresses are currently empty, so the
      // person is normally handed a fresh one instead of the same index 0
      // forever. A provider outage must not leave the receive screen blank —
      // an address that works is worth more here than an address nobody has
      // seen, so a failed probe falls back to the first external address.
      let inputs: tyTypes.Input[] = [];
      try {
        inputs = await fetchUtxos(network, allAddresses(account));
      } catch {
        /* fall through to index 0 */
      }
      const chosen = firstUnoccupied(account.external, inputs);
      return chosen === null ? null : hexOf(chosen);
    },
    // The whole set, external and internal. A local account knows this exactly,
    // which is the one place the local side is strictly better informed than
    // CIP-30: it cannot be a partial view.
    getOwnedAddressesHex: async () => allAddresses(account).map(hexOf),
    // No CIP-95 probe needed: chain 3 was derived alongside the payment and
    // stake keys, so this wallet is the one case that can answer without asking.
    getDrepKeyHashHex: async () => account.drepKeyHashHex,
    // `signAndSubmitLocal` compares against `account.network`, so preprod and
    // preview stay distinguishable here in a way the CIP-30 path cannot manage.
    signAndSubmit: (built: BuiltTx, expected: PhoenixNetwork) =>
      signAndSubmitLocal(built, account, expected, (cbor) => submitTx(network, cbor)),
  };
}
