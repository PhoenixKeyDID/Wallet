"use client";

import { useTranslation } from "react-i18next";
import type { WalletPort } from "@/lib/cardano";
import { usesExtensionPopup } from "./moneyNotice";

/**
 * One line under a Confirm button saying what is about to happen when it is
 * pressed. Which line depends on who holds the key.
 *
 * Four screens each printed the same sentence — "your wallet (Lace / Eternl)
 * will pop up to approve this" — unconditionally, including for the wallet's own
 * self-custody accounts, where no extension is involved and nothing pops up. A
 * person waiting for a window that will never open concludes the click did not
 * register, and clicks again. On the Send screen that is how the same amount
 * gets sent twice.
 *
 * The line is worth keeping rather than dropping, because the CIP-30 case is the
 * one where a person genuinely does have to look somewhere else on their screen.
 * What it needed was to be true in both modes, which `port.kind` already knows.
 */
export function SignHint({ port }: { port: WalletPort }) {
  const { t } = useTranslation("wallet");
  return (
    <p className="text-[11px] text-text-hint text-center">
      {/* The keys stay written out here, not behind the predicate:
          `check:i18n-keys` reads literals at the call site, and a key it cannot
          see is a key that can lose its translation unnoticed. */}
      {usesExtensionPopup(port.kind) ? t("extension_popup_hint") : t("local_sign_hint")}
    </p>
  );
}
