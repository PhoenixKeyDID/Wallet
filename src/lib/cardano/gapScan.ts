/**
 * How far along a chain a wallet has to look before it can say "that is all".
 *
 * `buildAccount` derives a fixed `GAP_LIMIT` addresses per chain and stops.
 * BIP-44 asks for something different: keep going until `GAP_LIMIT` *consecutive*
 * addresses are unused. The difference is not academic. A wallet restored from a
 * long-lived Lace or Eternl account reports a balance **smaller than the truth**,
 * with nothing on screen saying anything was skipped — the failure mode a person
 * reads as "my money is gone".
 *
 * ## "Used" here means "holds funds now", and that is deliberate
 *
 * The strict BIP-44 predicate is *was this address ever in a transaction*, which
 * needs address history. This module asks the narrower question the indexer can
 * answer with an endpoint already proven in this repo: does the address hold
 * anything right now.
 *
 * For the bug above, the narrow question is the whole answer. Funds live in
 * UTxOs, every UTxO carries min-ADA, so **every address holding money has a
 * positive balance** — a scan driven by this predicate finds all of it. What it
 * does not find is an address that was used and then emptied, which matters for
 * *choosing* the next receive or change address (reuse costs privacy, not
 * funds). That is a separate, lesser problem, and it is the one already recorded
 * against `localPort`'s change selection. Conflating the two would be claiming a
 * history scan this does not do.
 *
 * ## Batch in, batch out — no per-address attribution
 *
 * The scan never asks which address in a batch is funded, only whether any is.
 * That keeps it on `fetchAddressBalance`, whose response shape this repo already
 * relies on, instead of a per-address endpoint whose row format would have to be
 * taken on trust. The cost is that the answer is a multiple of the gap limit:
 * conservative in the safe direction — it derives more than strictly needed,
 * never fewer.
 */
import type { PhoenixNetwork } from "./address";
import type { Bip32PublicKey } from "@stricahq/bip32ed25519";
import { keyHashAt } from "./xpub";
import { baseAddress } from "./address";

/** Does any address in this batch hold funds? Injected so the scan is testable. */
export type BatchFundedProbe = (addresses: string[]) => Promise<boolean>;

export type ScanArgs = {
  acctXvk: Bip32PublicKey;
  /** BIP-44 chain: 0 external, 1 internal. */
  chain: number;
  stakeKeyHashHex: string;
  network: PhoenixNetwork;
  gapLimit: number;
  probe: BatchFundedProbe;
  /**
   * Hard stop, so a probe that answers "yes" forever cannot spin.
   *
   * A wallet is not infinite, but a broken indexer — or one that treats an
   * unknown address as funded — is a loop with a network call in it. The cap
   * turns that into a wrong answer instead of a hang, and the wrong answer is
   * on the safe side: too many addresses derived, none missed.
   */
  maxDepth: number;
};

/**
 * Addresses to derive on this chain: at least `gapLimit`, and one full gap
 * beyond the last batch that held anything.
 */
export async function scanChainDepth(args: ScanArgs): Promise<number> {
  const { acctXvk, chain, stakeKeyHashHex, network, gapLimit, probe, maxDepth } = args;
  if (!Number.isInteger(gapLimit) || gapLimit <= 0) throw new Error("gapLimit must be a positive integer");
  if (!Number.isInteger(maxDepth) || maxDepth < gapLimit) throw new Error("maxDepth must be at least gapLimit");

  let lastFundedBatch = -1;
  for (let batch = 0; ; batch += 1) {
    const start = batch * gapLimit;
    if (start >= maxDepth) break;
    // Stop once a whole gap-limit batch past the last funded one came back empty.
    if (batch > lastFundedBatch + 1) break;
    const addresses: string[] = [];
    for (let i = start; i < start + gapLimit; i += 1) {
      addresses.push(baseAddress(keyHashAt(acctXvk, chain, i), stakeKeyHashHex, network));
    }
    if (await probe(addresses)) lastFundedBatch = batch;
  }
  const depth = (lastFundedBatch + 2) * gapLimit;
  return Math.min(Math.max(gapLimit, depth), maxDepth);
}
