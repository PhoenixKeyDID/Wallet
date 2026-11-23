import { useTranslation } from "react-i18next";
import { mintConfirmKey, unconfirmedForeignActions, type TxSummary } from "../../src/lib/cardano/txSummary";
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
export function TxSummaryView({
  summary,
  confirmed = new Set<string>(),
  onConfirm,
  locks = true,
}: {
  summary: TxSummary;
  /**
   * Whether this screen is about to put a signature on the transaction. False
   * for `submitTx`: nothing is signed there, so the per-withdrawal boxes and
   * the "signing stays locked" note would describe a lock that does not exist.
   * The list itself is still shown.
   */
  locks?: boolean;
  /**
   * The entries the person has confirmed: foreign withdrawals by reward account
   * (hex), created tokens by `mintConfirmKey(unit)`.
   */
  confirmed?: ReadonlySet<string>;
  /**
   * Record one confirmation, under the same key as `confirmed`. Absent: the
   * boxes are shown but cannot be ticked, so a screen that forgets to wire this
   * can never unlock signing.
   */
  onConfirm?: (key: string, checked: boolean) => void;
}) {
  const { t } = useTranslation("wallet");
  const awaiting = unconfirmedForeignActions(summary, confirmed);
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
      {/* Each of them by name, and whether a Plutus script runs for it. */}
      {summary.foreignInputList.length > 0 && (
        <>
          <p className="approve-heading">{t("cip30_foreign_inputs_heading")}</p>
          <ul data-testid="foreign-input-list">
            {summary.foreignInputList.map((f) => (
              <li key={`${f.txId}#${f.index}`}>
                <span className="mono approve-addr">{`${f.txId}#${f.index}`}</span>
                <span className="approve-note">
                  {/* The redeemers come from the page, outside what is
                      signed. "No redeemer" is a fact only when the body
                      commits to no script data; otherwise the page can add
                      one after the signature. */}
                  {f.redeemer
                    ? t("cip30_input_redeemer")
                    : summary.scriptDataCommitted
                      ? t("cip30_input_redeemer_unknown")
                      : t("cip30_input_no_redeemer")}
                </span>
              </li>
            ))}
          </ul>
        </>
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
      {/* Every withdrawal that is not this wallet's, one by one, each with its
          own box. Signing stays locked until every box is ticked: a script
          account runs its script for the withdrawal, and a contract can count
          that run as a vote carried by this signature. */}
      {summary.foreignWithdrawalList.length > 0 && (
        <>
          <p className="approve-heading">{t("cip30_foreign_actions_heading")}</p>
          <ul data-testid="foreign-withdrawal-list">
            {summary.foreignWithdrawalList.map((w) => (
              <li key={w.rewardAccountHex} className="approve-payout">
                <b>{formatAda(w.lovelace)} ADA</b>
                <span className="mono approve-addr">{w.stakeAddress}</span>
                <span className="approve-note">
                  {w.credential === "script" ? t("cip30_withdrawal_script") : t("cip30_withdrawal_key")}
                </span>
                {w.redeemer && <span className="approve-error">{t("cip30_withdrawal_redeemer")}</span>}
                {!w.redeemer && w.credential === "script" && summary.scriptDataCommitted && (
                  <span className="approve-error">{t("cip30_withdrawal_redeemer_unknown")}</span>
                )}
                {locks && (
                <label>
                  <input
                    type="checkbox"
                    data-testid={`confirm-${w.rewardAccountHex}`}
                    checked={confirmed.has(w.rewardAccountHex)}
                    disabled={!onConfirm}
                    onChange={(e) => onConfirm?.(w.rewardAccountHex, e.currentTarget.checked)}
                  />
                  {t("cip30_withdrawal_confirm")}
                </label>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {/* Every token the transaction creates, one by one — by unit, not by
          policy — each with its own box. The policy counts this signature as
          its yes; this wallet cannot read what the policy checks or what the
          token stands for, so the person decides each unit. */}
      {summary.foreignMintList.length > 0 && (
        <>
          <p className="approve-heading">{t("cip30_mints_heading")}</p>
          <p className="approve-note">{t("cip30_mints_note")}</p>
          <ul data-testid="foreign-mint-list">
            {summary.foreignMintList.map((m) => (
              <li key={m.unit} className="approve-payout">
                <b title={m.policyId}>{`${m.quantity.toString()} ${assetLabel(m)}`}</b>
                {m.script && <span className="approve-error">{t("cip30_mint_script")}</span>}
                {locks && (
                <label>
                  <input
                    type="checkbox"
                    data-testid={`confirm-mint-${m.unit}`}
                    checked={confirmed.has(mintConfirmKey(m.unit))}
                    disabled={!onConfirm}
                    onChange={(e) => onConfirm?.(mintConfirmKey(m.unit), e.currentTarget.checked)}
                  />
                  {t("cip30_mint_confirm")}
                </label>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {locks && awaiting.length > 0 && (
        <p className="approve-error" role="alert" data-testid="sign-locked">
          {t("cip30_sign_locked")}
        </p>
      )}
    </div>
  );
}
