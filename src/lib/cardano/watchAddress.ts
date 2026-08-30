import "../node-globals";
import { utils as tyUtils, address as tyAddress } from "@stricahq/typhonjs";
import { toNetworkId, type PhoenixNetwork } from "@/lib/cardano";

/**
 * Validate a single bech32 address for the watch-only-by-address view.
 *
 * This is the *safer* of the two watch-only inputs and the spec says so
 * (`docs/Phoenix Wallet-Feat.md` §7): one address links nothing and amplifies
 * nothing, while an `acct_xvk` exposes the whole account's history and turns any
 * single leaked child key into a total loss (§2.2). Nothing derives here — the
 * address is used exactly as given.
 *
 * Rejects, with a distinct reason for each so the UI can say which mistake it is:
 *  - not an address at all;
 *  - a Byron/legacy address, which carries no network id and would otherwise
 *    slip past the network check and then break `getBech32()`;
 *  - a reward (stake) address: it holds no UTxO, so `/address_info` answers
 *    successfully with nothing and the view shows a confident 0;
 *  - a well-formed address belonging to a different network. That last one
 *    matters most here: a mainnet address watched on preprod returns a real,
 *    successful "0 ADA", which reads as "my money is gone" rather than "wrong
 *    network".
 */
export function parseWatchAddress(input: string, network: PhoenixNetwork): string {
  const s = input.trim();
  if (!s) throw new Error("watch_addr_required");

  let address: unknown;
  try {
    address = tyUtils.getAddressFromString(s);
  } catch {
    throw new Error("watch_addr_invalid");
  }

  // A stake address parses fine and even has a network id, so it would sail
  // through every check below and then read as an empty wallet.
  if (address instanceof tyAddress.RewardAddress) throw new Error("watch_addr_is_stake");

  const getNet = (address as { getNetworkId?: () => number }).getNetworkId;
  if (typeof getNet !== "function") throw new Error("watch_addr_invalid");
  if (getNet.call(address) !== toNetworkId(network)) throw new Error("addr_wrong_network");

  const getBech32 = (address as { getBech32?: () => string }).getBech32;
  if (typeof getBech32 !== "function") throw new Error("watch_addr_invalid");
  return getBech32.call(address);
}
