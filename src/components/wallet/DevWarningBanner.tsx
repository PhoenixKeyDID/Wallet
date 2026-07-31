"use client";

import { useTranslation } from "react-i18next";

/**
 * Persistent, non-dismissable development warning for the web wallet.
 * The wallet is unaudited and must not be used to recover valuable wallets.
 */
export function DevWarningBanner() {
  const { t } = useTranslation("wallet");
  return (
    <div
      role="alert"
      className="border border-border-amber bg-amber-brand/10 text-amber-brand rounded-brand px-4 py-3 flex gap-3 items-start"
    >
      <span aria-hidden className="text-lg leading-none mt-0.5">
        ⚠️
      </span>
      <div className="text-sm">
        <p className="font-semibold">{t("dev_warning_title")}</p>
        <p className="text-text-dim mt-0.5">{t("dev_warning_body")}</p>
      </div>
    </div>
  );
}
