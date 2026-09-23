import { useTranslation } from "react-i18next";
import type { TxSummary } from "../../src/lib/cardano/txSummary";
import { assetLabel, formatAda } from "../../src/lib/cardano/provider";

/**
 * What a website's transaction does to this wallet, as the approval window
 * shows it.
 *
 * Kept apart from `approve.tsx` for one reason: that file renders itself the
 * moment it is imported, and reaching its decide screen needs an unlocked vault,
 * a `chrome.runtime` port and the network. None of that is what this block
 * promises. What it promises — every token that moves is named together with
 * its policy id, every recipient that is not this wallet is printed in full
 * with its amount — is checked on a rendered screen in
 * `TxSummaryView.test.tsx`. The transaction here was built by the website, so
 * the website also chose every name this block prints; a name with no policy
 * id beside it is whatever the website wanted it to say.
 */
export function TxSummaryView({ summary }: { summary: TxSummary }) {
  const { t } = useTranslation("wallet");
  return (
    <div className="approve-summary">
      <p className="approve-heading">{t("cip30_leaves_wallet")}</p>
      <ul>
        {summary.net.length === 0 && <li>{t("cip30_nothing_leaves")}</li>}
        {summary.net.map((n) => (
          <li key={n.unit || "ada"}>
            {n.unit === ""
              ? `${formatAda(n.amount < BigInt(0) ? -n.amount : n.amount)} ADA`
              : `${(n.amount < BigInt(0) ? -n.amount : n.amount).toString()} ${assetLabel(n)}`}
            {n.amount < BigInt(0) && ` ${t("cip30_incoming")}`}
          </li>
        ))}
      </ul>
      <p className="approve-note">
        {t("cip30_fee")}: {formatAda(summary.fee)} ADA
      </p>
      {summary.withdrawalLovelace > BigInt(0) && (
        <p className="approve-note">
          {t("cip30_withdrawal")}: {formatAda(summary.withdrawalLovelace)} ADA
        </p>
      )}
      {summary.ownInputs < summary.totalInputs && (
        <p className="approve-error">
          {t("cip30_unknown_inputs", {
            known: summary.ownInputs,
            total: summary.totalInputs,
          })}
        </p>
      )}
      {summary.toOthers.length > 0 && (
        <>
          <p className="approve-heading">{t("cip30_paying")}</p>
          <ul>
            {summary.toOthers.map((r, i) => (
              <li key={i} className="approve-payout">
                {/* Amount first: an address with no number beside it is a
                    line people skim past, and the number is the decision. */}
                <b>{formatAda(r.lovelace)} ADA</b>
                <span className="mono approve-addr">{r.address}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {(summary.certificates > 0 || summary.withdrawals > 0 || summary.mints > 0) && (
        <p className="approve-error">{t("cip30_extra_actions")}</p>
      )}
    </div>
  );
}
