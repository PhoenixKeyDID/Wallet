"use client";

import { useEffect, useRef, useState } from "react";
import { Buffer } from "buffer";
import { useTranslation } from "react-i18next";
import { utils as tyUtils, types as tyTypes } from "@stricahq/typhonjs";
import { toastApiError, toastSuccess } from "@/lib/toast";
import { CopyBtn } from "@/components/CopyBtn";
import {
  ConfirmGate,
  ChallengedValue,
  tailChallenge,
  CHALLENGE_LEN,
} from "@/components/wallet/ConfirmGate";
import { reportSignError } from "@/components/wallet/signError";
import {
  type Cip30Api,
  type PhoenixNetwork,
  type BuiltTx,
  type AssetAmount,
  decodeUtxosToInputs,
  signAndSubmitCip30,
  cip30NetworkId,
  fetchProtocolParams,
  fetchTipSlot,
  formatAda,
  assetLabel,
  readBalance,
} from "@/lib/cardano";
import {
  buildSendOutputs,
  buildMultiSend,
  normalizeSendOutputs,
  type RecipientRow,
  type SendOutput,
} from "@/lib/cardano/send";

/**
 * Multi-recipient, multi-asset Send tab (Lace-style): one or more assets to one
 * or more recipient addresses in a single transaction. Supersedes the
 * single-output `SendForm`. Same two-step safety: Review (build unsigned, show
 * every recipient/asset/fee in plain language) → Confirm & send (extension
 * signs, we merge the witness and submit). Never build blind.
 *
 * ⚠️ Beta: not yet security-audited. On mainnet it moves real value — the
 * review step and the "I checked the addresses" tick exist because an
 * on-chain send is irreversible.
 */
type TokenLine = { id: number; unit: string; amount: string };
type Recipient = { id: number; address: string; ada: string; tokens: TokenLine[] };

function blankRecipient(id: number): Recipient {
  return { id, address: "", ada: "", tokens: [] };
}

export function SendPanel({
  api,
  network,
  changeAddress,
}: {
  api: Cip30Api;
  network: PhoenixNetwork;
  changeAddress: string;
}) {
  const { t } = useTranslation("wallet");
  const nextId = useRef(1);
  const [recipients, setRecipients] = useState<Recipient[]>([blankRecipient(0)]);
  const [heldAssets, setHeldAssets] = useState<AssetAmount[]>([]);
  const [built, setBuilt] = useState<BuiltTx | null>(null);
  const [reviewOutputs, setReviewOutputs] = useState<SendOutput[] | null>(null);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);

  const isMainnet = network === 1;

  useEffect(() => {
    let cancelled = false;
    readBalance(api)
      .then((bal) => {
        if (!cancelled) setHeldAssets(bal.assets);
      })
      .catch((err) => toastApiError(err));
    return () => {
      cancelled = true;
    };
  }, [api]);

  const addRecipient = () => setRecipients((rs) => [...rs, blankRecipient(nextId.current++)]);
  const removeRecipient = (id: number) => setRecipients((rs) => rs.filter((r) => r.id !== id));
  const updateRecipient = (id: number, patch: Partial<Recipient>) =>
    setRecipients((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const addTokenLine = (recipientId: number) =>
    setRecipients((rs) =>
      rs.map((r) =>
        r.id === recipientId
          ? { ...r, tokens: [...r.tokens, { id: nextId.current++, unit: "", amount: "" }] }
          : r,
      ),
    );
  const removeTokenLine = (recipientId: number, lineId: number) =>
    setRecipients((rs) =>
      rs.map((r) => (r.id === recipientId ? { ...r, tokens: r.tokens.filter((l) => l.id !== lineId) } : r)),
    );
  const updateTokenLine = (recipientId: number, lineId: number, patch: Partial<TokenLine>) =>
    setRecipients((rs) =>
      rs.map((r) =>
        r.id === recipientId
          ? { ...r, tokens: r.tokens.map((l) => (l.id === lineId ? { ...l, ...patch } : l)) }
          : r,
      ),
    );

  const assetByUnit = (unit: string) => heldAssets.find((a) => a.unit === unit);

  const build = async () => {
    setBusy(true);
    setBuilt(null);
    setReviewOutputs(null);
    setChecked(false);
    setTxHash(null);
    try {
      // A row with an amount typed but no asset chosen used to be filtered out
      // in silence: the user reviewed a transaction that no longer contained
      // the token they had just entered, and nothing on screen said it had been
      // dropped. Refuse to build instead — a half-filled row is a mistake, and
      // the only safe reading of a mistake is to stop.
      for (const r of recipients) {
        if (r.tokens.some((l) => !l.unit && l.amount.trim())) {
          throw new Error(t("token_row_no_asset"));
        }
      }
      const rows: RecipientRow[] = recipients.map((r) => ({
        address: r.address,
        ada: r.ada,
        tokens: r.tokens
          .filter((l) => l.unit)
          .map((l) => {
            const asset = assetByUnit(l.unit);
            return {
              policyId: asset?.policyId ?? l.unit.slice(0, 56),
              assetNameHex: asset?.assetNameHex ?? l.unit.slice(56),
              amount: l.amount,
            };
          }),
      }));

      let outputs: SendOutput[];
      try {
        outputs = buildSendOutputs(rows, network);
      } catch (err) {
        const key = err instanceof Error && err.message ? err.message : "invalid_amount";
        throw new Error(t(key));
      }

      const [utxosHex, params, tip] = await Promise.all([
        api.getUtxos(),
        fetchProtocolParams(network),
        fetchTipSlot(network),
      ]);
      if (!utxosHex || utxosHex.length === 0) throw new Error(t("no_utxos"));
      const inputs = decodeUtxosToInputs(utxosHex);
      const changeAddr = tyUtils.getAddressFromHex(
        Buffer.from(changeAddress, "hex"),
      ) as tyTypes.ShelleyAddress;

      const b = buildMultiSend({
        outputs,
        inputs,
        changeAddress: changeAddr,
        protocolParams: params,
        ttl: tip + 7200,
      });
      setBuilt(b);
      // Show the EFFECTIVE outputs (min-UTxO applied) so the review's per-row
      // ADA and the total match what actually leaves the wallet — a token-only
      // row is not silently shown as "0 ADA".
      setReviewOutputs(normalizeSendOutputs(outputs, params));
    } catch (err) {
      toastApiError(err);
    } finally {
      setBusy(false);
    }
  };

  const signSubmit = async () => {
    if (!built) return;
    setBusy(true);
    try {
      const hash = await signAndSubmitCip30(api, built, cip30NetworkId(network));
      toastSuccess("send_submitted", { hash: hash.slice(0, 12) });
      setTxHash(hash);
      setBuilt(null);
      setReviewOutputs(null);
      setChecked(false);
      setRecipients([blankRecipient(nextId.current++)]);
    } catch (err) {
      // A failed submit leaves `built.transaction` already carrying the witness
      // the extension added; signing it again would push a DUPLICATE witness
      // and bloat the tx. Drop the built tx so a retry rebuilds a clean one.
      setBuilt(null);
      setReviewOutputs(null);
      setChecked(false);
      reportSignError(err, t);
    } finally {
      setBusy(false);
    }
  };

  const inputCls =
    "w-full rounded-brand-sm border border-border-soft bg-bg0 px-3 py-2 text-sm mono focus:border-border-amber outline-none";
  const netLabel = network === 1 ? t("net_mainnet") : network === 2 ? t("net_preview") : t("net_preprod");
  const anyTokenOutput = (reviewOutputs ?? []).some((o) => o.tokens.length > 0);

  const canBuild =
    recipients.length > 0 &&
    recipients.every(
      (r) =>
        r.address.trim() &&
        (r.ada.trim() || r.tokens.some((l) => l.unit && l.amount.trim())),
    );

  const totalLovelace = (reviewOutputs ?? []).reduce((sum, o) => sum + o.lovelace, BigInt("0"));

  return (
    <div className="rounded-brand border border-border-soft bg-bg1 p-5 space-y-4">
      <p className="text-xs text-text-hint">
        {isMainnet ? t("send_multi_note_mainnet") : t("send_multi_note_testnet")}
      </p>

      {txHash && !built && (
        <div className="rounded-brand-sm border border-border-teal bg-teal-brand/10 p-3 space-y-1">
          <p className="text-sm font-medium text-teal-brand">{t("sent_success_title")}</p>
          <div className="flex items-center gap-2">
            <span className="mono text-xs text-text-dim truncate">{txHash}</span>
            <CopyBtn value={txHash} />
          </div>
        </div>
      )}

      {!built ? (
        <div className="space-y-4">
          <p className="mono text-xs uppercase tracking-wider text-text-hint">{t("recipients_title")}</p>
          {recipients.map((r, idx) => (
            <div key={r.id} className="rounded-brand-sm border border-border-soft bg-bg0 p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs text-text-hint">#{idx + 1}</span>
                {recipients.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeRecipient(r.id)}
                    className="text-xs text-text-hint hover:text-text-dim"
                  >
                    {t("remove")}
                  </button>
                )}
              </div>
              <label className="block">
                <span className="text-xs text-text-hint">{t("send_to")}</span>
                <input
                  className={inputCls}
                  placeholder="addr..."
                  value={r.address}
                  onChange={(e) => updateRecipient(r.id, { address: e.target.value })}
                />
              </label>
              <label className="block">
                <span className="text-xs text-text-hint">{t("send_amount")}</span>
                <input
                  className={inputCls}
                  placeholder="1.5"
                  inputMode="decimal"
                  value={r.ada}
                  onChange={(e) => updateRecipient(r.id, { ada: e.target.value })}
                />
              </label>

              {r.tokens.length > 0 && (
                <div className="space-y-2">
                  <span className="text-xs text-text-hint">{t("assets_label")}</span>
                  {/* Token amounts are RAW on-chain units (no decimal scaling),
                      unlike the ADA field above — call it out so nobody types "5"
                      expecting 5 display-tokens of a 6-decimal asset. */}
                  <p className="text-[11px] text-amber-brand">{t("token_raw_unit_note")}</p>
                  {r.tokens.map((line) => (
                    <div key={line.id} className="flex gap-2 items-center">
                      <select
                        value={line.unit}
                        onChange={(e) => updateTokenLine(r.id, line.id, { unit: e.target.value })}
                        className="flex-1 rounded-brand-sm border border-border-soft bg-bg0 px-2 py-2 text-sm"
                      >
                        <option value="">{t("choose_asset")}</option>
                        {heldAssets.map((a) => (
                          <option key={a.unit} value={a.unit}>
                            {assetLabel(a.assetNameHex)} ({a.quantity.toString()})
                          </option>
                        ))}
                      </select>
                      <input
                        className={inputCls + " w-28"}
                        placeholder="0"
                        inputMode="numeric"
                        value={line.amount}
                        onChange={(e) => updateTokenLine(r.id, line.id, { amount: e.target.value })}
                      />
                      <button
                        type="button"
                        onClick={() => removeTokenLine(r.id, line.id)}
                        className="text-xs text-text-hint hover:text-text-dim shrink-0"
                      >
                        {t("remove")}
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <button
                type="button"
                onClick={() => addTokenLine(r.id)}
                disabled={heldAssets.length === 0}
                className="text-xs text-teal-brand hover:underline disabled:opacity-40 disabled:no-underline"
              >
                + {t("add_asset")}
              </button>
              {heldAssets.length === 0 && (
                <p className="text-[11px] text-text-hint">{t("no_tokens_held")}</p>
              )}
            </div>
          ))}

          <button
            type="button"
            onClick={addRecipient}
            className="w-full p-2.5 rounded-brand border border-border-soft bg-bg1 hover:bg-bg2 text-sm"
          >
            + {t("add_recipient")}
          </button>

          <button
            type="button"
            disabled={busy || !canBuild}
            onClick={build}
            className="w-full p-3 rounded-brand border border-border-soft bg-bg1 hover:bg-bg2 text-sm disabled:opacity-50"
          >
            {busy ? t("building") : t("review")}
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold">{t("send_review_title")}</p>
            <span
              className={
                "text-[11px] mono px-2 py-0.5 rounded-brand-sm border " +
                (isMainnet
                  ? "border-border-amber text-amber-brand bg-amber-brand/10"
                  : "border-border-soft text-text-hint bg-bg0")
              }
            >
              {netLabel}
            </span>
          </div>
          <div className="rounded-brand-sm bg-bg0 p-3 text-sm space-y-3">
            {(reviewOutputs ?? []).map((o, idx) => (
              <div key={idx} className="space-y-1 border-b border-border-soft pb-2 last:border-b-0 last:pb-0">
                <div className="space-y-1">
                  <span className="text-text-hint text-xs">
                    {t("send_to")} #{idx + 1}
                  </span>
                  {/* Full address, wrapped — a truncated address makes the verify
                      checkbox meaningless against address-poisoning. EVERY
                      recipient has its challenged tail marked, because every one
                      must be retyped. Marking it here rather than printing it
                      beside the input means the eye must cross the real address
                      to find it (Wallet#7). */}
                  <div className="flex items-start gap-2">
                    <ChallengedValue
                      value={o.address.getBech32()}
                      className="mono text-xs break-all flex-1"
                    />
                    <CopyBtn value={o.address.getBech32()} />
                  </div>
                </div>
                {o.lovelace > BigInt("0") && (
                  <div className="flex justify-between">
                    <span className="text-text-hint">ADA</span>
                    <span className="mono font-semibold">{formatAda(o.lovelace)} ADA</span>
                  </div>
                )}
                {o.tokens.map((tk, tIdx) => (
                  <div key={tIdx} className="flex justify-between">
                    <span className="text-text-hint">{assetLabel(tk.assetNameHex)}</span>
                    <span className="mono font-semibold">{tk.amount.toString()}</span>
                  </div>
                ))}
              </div>
            ))}
            <div className="flex justify-between border-t border-border-soft pt-2">
              <span className="text-text-hint">{t("total_ada")}</span>
              <span className="mono">{formatAda(totalLovelace)} ADA</span>
            </div>
            <div className="flex justify-between">
              <span className="text-text-hint">{t("est_fee")}</span>
              <span className="mono">{formatAda(BigInt(built.fee))} ADA</span>
            </div>
            <div className="flex justify-between font-semibold">
              <span>{t("total_with_fee")}</span>
              <span className="mono">{formatAda(totalLovelace + BigInt(built.fee))} ADA</span>
            </div>
          </div>

          {anyTokenOutput && <p className="text-[11px] text-text-hint">{t("send_min_ada_note")}</p>}

          {/* Final check: retype the marked tail of EVERY recipient. On an
              irreversible send a checkbox is a reflex; retyping each destination
              tail forces the eyes onto every address actually being paid.
              Gating only #1 left the other outputs unchecked (Wallet#7). */}
          <ConfirmGate
            network={network}
            alwaysChallenge
            challenge={(reviewOutputs ?? []).map((o) =>
              tailChallenge(o.address.getBech32()),
            )}
            challengeHint={(reviewOutputs ?? []).map((_, i) =>
              t("confirm_gate_hint_send", { n: i + 1, len: CHALLENGE_LEN }),
            )}
            checkboxLabel={t("send_verify_checkbox")}
            confirmed={checked}
            onChange={setChecked}
          />

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                setBuilt(null);
                setReviewOutputs(null);
                setChecked(false);
              }}
              className="flex-1 p-3 rounded-brand border border-border-soft bg-bg1 hover:bg-bg2 text-sm"
            >
              {t("cancel")}
            </button>
            <button
              type="button"
              disabled={busy || !checked}
              onClick={signSubmit}
              className="flex-1 p-3 rounded-brand border border-border-amber bg-amber-brand/10 hover:bg-amber-brand/20 text-sm text-amber-brand disabled:opacity-50"
            >
              {busy ? t("submitting") : t("confirm_send")}
            </button>
          </div>
          <p className="text-[11px] text-text-hint text-center">{t("extension_popup_hint")}</p>
        </div>
      )}
    </div>
  );
}
