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
      {/* The transaction spends inputs that are not this wallet's: a script
          (Plutus or native, possibly supplied by a reference input) may be
          what this signature unlocks, and their value is not in the amount
          above. Shown, not refused — a drip-pot claim is this shape. */}
      {summary.foreignInputs > 0 && (
        <p className="approve-error" data-testid="foreign-inputs">
          {t("cip30_foreign_inputs", { n: summary.foreignInputs })}
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
                {r.assets.map((a) => (
                  <b key={a.unit}>{` + ${a.amount.toString()} ${assetLabel(a)}`}</b>
                ))}
                <span className="mono approve-addr">{r.address}</span>
                {r.datum && <span className="approve-note">{t("cip30_output_datum")}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
      {/* Change under a datum: counted as coming back above, because the
          wallet sees and can spend it, and still listed here so the datum on
          it is not hidden. */}
      {summary.toSelfWithDatum.length > 0 && (
        <>
          <p className="approve-heading">{t("cip30_to_self_with_datum")}</p>
          <ul>
            {summary.toSelfWithDatum.map((r, i) => (
              <li key={i} className="approve-payout">
                <b>{formatAda(r.lovelace)} ADA</b>
                {r.assets.map((a) => (
                  <b key={a.unit}>{` + ${a.amount.toString()} ${assetLabel(a)}`}</b>
                ))}
                <span className="mono approve-addr">{r.address}</span>
                <span className="approve-note">{t("cip30_output_datum")}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {summary.burns.length > 0 && (
        <>
          <p className="approve-heading">{t("cip30_burns")}</p>
          <ul>
            {summary.burns.map((b) => (
              <li key={b.unit}>{`${b.amount.toString()} ${assetLabel(b)}`}</li>
            ))}
          </ul>
        </>
      )}
      {summary.collateral && (
        <>
          <p className="approve-error">
            {t("cip30_collateral_risk", { ada: formatAda(summary.collateral.riskLovelace) })}
          </p>
          <p className="approve-note">{t("cip30_collateral_explain")}</p>
        </>
      )}
      {/* "Your staking rewards" only for this wallet's own reward account; a
          withdrawal from another account is someone else's money and says so. */}
      {summary.withdrawals - summary.foreignWithdrawals > 0 && (
        <p className="approve-error">{t("cip30_extra_actions")}</p>
      )}
      {summary.foreignWithdrawals > 0 && <p className="approve-error">{t("cip30_foreign_withdrawal")}</p>}
    </div>
  );
}
