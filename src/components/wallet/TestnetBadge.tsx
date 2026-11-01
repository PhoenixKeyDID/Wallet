import { useTranslation } from "react-i18next";
import type { PhoenixNetwork } from "@/lib/cardano";

/**
 * "This is play money" — shown on the main screen whenever the open wallet is
 * on a test network.
 *
 * The network picker is on the create screen, and a person who skimmed it can
 * end up on Preprod believing the ADA they were sent is real. The one place
 * they look every time is the balance, so the reminder lives next to it. It
 * renders nothing on mainnet: a warning that is always on is wallpaper.
 */
export function TestnetBadge({ network }: { network: PhoenixNetwork }) {
  const { t } = useTranslation("wallet");
  if (network === 1) return null;
  return (
    <p
      role="note"
      className="rounded-brand-sm border border-amber-brand/40 px-2 py-1 text-xs text-amber-brand"
    >
      {t("network_testnet_badge", { name: network === 2 ? "Preview" : "Preprod" })}
    </p>
  );
}
