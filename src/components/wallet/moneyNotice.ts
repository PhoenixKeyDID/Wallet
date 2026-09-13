"use client";

/**
 * The two decisions a money screen makes before it is allowed to say something.
 *
 * Each lived inline in a component, which is why each was wrong in a different
 * file and nothing could see either one. They are pure functions here so the
 * rule is written once and can be checked without rendering anything — this
 * repo's test runner has no DOM, and a rule that can only be verified by looking
 * at a screen is a rule nobody verifies twice.
 *
 * **What is deliberately NOT here: the key strings.** Moving `t("…")` arguments
 * behind a function would hide them from `scripts/check-i18n-keys.mjs`, which
 * reads string literals at the call site — so a key with no translation would
 * stop being findable, which is the defect that gate was built for. The
 * predicate moves; the literal stays where the gate can see it.
 */

import type { PhoenixNetwork, WalletPort } from "@/lib/cardano";

/**
 * Whether pressing Confirm will make a separate window appear.
 *
 * Four screens said *"your wallet (Lace / Eternl) will pop up to approve this"*
 * unconditionally, including for this wallet's own self-custody accounts, where
 * no extension exists and nothing pops up. Waiting for a window that never opens
 * reads as a click that did not register, and the next thing a person does is
 * click again — on the Send screen, that is how one amount goes out twice.
 */
export function usesExtensionPopup(kind: WalletPort["kind"]): boolean {
  return kind === "cip30";
}

/**
 * Whether a balance on this network has a price in ordinary money.
 *
 * Only mainnet ADA does. Test ADA is handed out by a faucet, so applying the
 * mainnet rate to it produces a figure with no referent — a preprod wallet
 * holding 10 000 test ADA read as tens of millions of đồng, in the reader's own
 * currency, on the screen they opened to find out what they have.
 *
 * Written as "is mainnet" rather than "is not preprod" so that a network id
 * added later defaults to unpriced, which is the side of this question that
 * cannot mislead.
 */
export function hasFiatPrice(network: PhoenixNetwork): boolean {
  return network === 1;
}

/**
 * What a balance read is doing, as far as the screen is concerned.
 *
 * Three states because the boolean it replaces answered the wrong question:
 * `balanceOk === false` meant both "the read has not come back" and "the read
 * failed", and both printed the failure sentence. So every unlock, every account
 * switch and every refresh announced that the balance could not be read — under
 * a figure showing 0 — for the seconds the read was in flight. On a wallet that
 * is the worst sentence to say when it is not true: the reader is told their
 * money is unaccounted for, it then appears, and the warning has taught them to
 * ignore it before the day it is real.
 */
export type BalanceState = "loading" | "ok" | "failed";
