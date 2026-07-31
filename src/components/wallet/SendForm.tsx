"use client";

import { useState } from "react";
import { Buffer } from "buffer";
import { useTranslation } from "react-i18next";
import { utils as tyUtils, types as tyTypes } from "@stricahq/typhonjs";
import { toastApiError, toastSuccess } from "@/lib/toast";
import {
  type Cip30Api,
  decodeUtxosToInputs,
  buildPaymentTx,
  signAndSubmitCip30,
  fetchProtocolParams,
  fetchTipSlot,
  formatAda,
  toNetworkId,
  type BuiltTx,
  type PhoenixNetwork,
} from "@/lib/cardano";

/**
 * Send ADA via the connected CIP-30 wallet. Two steps so nothing is signed
 * blindly:
 * 1) Review — assemble the unsigned tx and show recipient + amount + fee.
 * 2) Confirm & send — the extension signs; we merge the witness and submit.
 *
 * ⚠️ Beta: not yet security-audited. On mainnet it moves real ADA — the review
 * step and the "I checked the address" tick exist because an on-chain send is
 * irreversible.
 */
export function SendForm({
  api,
  networkId,
  onDone,
}: {
  api: Cip30Api;
  networkId: number;
  onDone: () => void;
}) {
  const { t } = useTranslation("wallet");
  const [to, setTo] = useState("");
  const [ada, setAda] = useState("");
  // CIP-30 getNetworkId() returns 0 for EVERY testnet, so it cannot tell preprod
  // from preview. Let the user pick when on testnet; mainnet (1) is unambiguous.
  const [testnetVariant, setTestnetVariant] = useState<PhoenixNetwork>(0);
  const [built, setBuilt] = useState<BuiltTx | null>(null);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);

  const isMainnet = networkId === 1;
  const network: PhoenixNetwork = isMainnet ? 1 : testnetVariant;

  const parseLovelace = (v: string): bigint => {
    if (!/^\d+(\.\d{1,6})?$/.test(v.trim())) throw new Error(t("invalid_amount"));
    const [whole, frac = ""] = v.trim().split(".");
    return BigInt(whole) * BigInt("1000000") + BigInt(frac.padEnd(6, "0"));
  };

  const build = async () => {
    setBusy(true);
    setBuilt(null);
    setChecked(false);
    try {
      const lovelace = parseLovelace(ada);
      const toAddress = tyUtils.getAddressFromString(to.trim()) as tyTypes.ShelleyAddress;
      // Reject a recipient on the wrong network BEFORE building (mainnet addr in
      // a testnet wallet or vice-versa only fails at submit otherwise).
      if (
        typeof (toAddress as { getNetworkId?: () => number }).getNetworkId === "function" &&
        (toAddress as { getNetworkId: () => number }).getNetworkId() !== toNetworkId(network)
      ) {
        throw new Error(t("addr_wrong_network"));
      }
      const [utxosHex, params, tip, changeHex] = await Promise.all([
        api.getUtxos(),
        fetchProtocolParams(network),
        fetchTipSlot(network),
        api.getChangeAddress(),
      ]);
      if (!utxosHex || utxosHex.length === 0) throw new Error(t("no_utxos"));
      const inputs = decodeUtxosToInputs(utxosHex);
      const changeAddress = tyUtils.getAddressFromHex(
        Buffer.from(changeHex, "hex"),
      ) as tyTypes.ShelleyAddress;
      const b = buildPaymentTx({
        toAddress,
        lovelace,
        changeAddress,
        inputs,
        protocolParams: params,
        ttl: tip + 7200,
      });
      setBuilt(b);
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
      const hash = await signAndSubmitCip30(api, built);
      toastSuccess("send_submitted", { hash: hash.slice(0, 12) });
      setBuilt(null);
      setChecked(false);
      setTo("");
      setAda("");
      onDone();
    } catch (err) {
      // A failed submit leaves `built.transaction` already carrying the witness
      // the extension added; signing it again would push a DUPLICATE witness and
      // bloat the tx. Drop the built tx so a retry rebuilds a clean one.
      setBuilt(null);
      setChecked(false);
      toastApiError(err);
    } finally {
      setBusy(false);
    }
  };

  const inputCls =
    "w-full rounded-brand-sm border border-border-soft bg-bg0 px-3 py-2 text-sm mono focus:border-border-amber outline-none";

  const shortAddr = (a: string) => (a.length > 24 ? `${a.slice(0, 12)}…${a.slice(-8)}` : a);

  return (
    <div className="rounded-brand border border-border-soft bg-bg1 p-5 space-y-3">
      <p className="text-xs text-text-hint">
        {isMainnet ? t("send_note_mainnet") : t("send_note_testnet")}
      </p>

      {!built ? (
        <>
          <label className="block">
            <span className="text-xs text-text-hint">{t("send_to")}</span>
            <input
              className={inputCls}
              placeholder="addr..."
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="text-xs text-text-hint">{t("send_amount")}</span>
            <input
              className={inputCls}
              placeholder="1.5"
              inputMode="decimal"
              value={ada}
              onChange={(e) => setAda(e.target.value)}
            />
          </label>
          {!isMainnet && (
            <label className="block">
              <span className="text-xs text-text-hint">{t("network_label")}</span>
              <select
                value={testnetVariant}
                onChange={(e) => setTestnetVariant(Number(e.target.value) as PhoenixNetwork)}
                className="w-full rounded-brand-sm border border-border-soft bg-bg0 px-2 py-2 text-sm"
              >
                <option value={0}>preprod</option>
                <option value={2}>preview</option>
              </select>
            </label>
          )}
          <button
            type="button"
            disabled={busy || !to || !ada}
            onClick={build}
            className="w-full p-3 rounded-brand border border-border-soft bg-bg1 hover:bg-bg2 text-sm disabled:opacity-50"
          >
            {busy ? t("building") : t("review")}
          </button>
        </>
      ) : (
        <div className="space-y-3">
          <p className="text-sm font-semibold">{t("send_review_title")}</p>
          <div className="rounded-brand-sm bg-bg0 p-3 text-sm space-y-2">
            <div className="flex justify-between gap-3">
              <span className="text-text-hint shrink-0">{t("send_to")}</span>
              <span className="mono text-right break-all">{shortAddr(to.trim())}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-text-hint">{t("send_amount")}</span>
              <span className="mono font-semibold">{ada} ADA</span>
            </div>
            <div className="flex justify-between border-t border-border-soft pt-2">
              <span className="text-text-hint">{t("est_fee")}</span>
              <span className="mono">{formatAda(BigInt(built.fee))} ADA</span>
            </div>
          </div>

          <label className="flex items-start gap-2 text-xs text-text-dim cursor-pointer">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
              className="mt-0.5"
            />
            <span>{t("send_verify_checkbox")}</span>
          </label>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                setBuilt(null);
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
        </div>
      )}
    </div>
  );
}
