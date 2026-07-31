"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toastApiError } from "@/lib/toast";
import {
  parseAcctXvk,
  deriveWatchWallet,
  fetchAddressBalance,
  type WatchWallet,
  type PhoenixNetwork,
} from "@/lib/cardano";
import { BalanceView, type DisplayAsset } from "./BalanceView";
import { CopyBtn } from "@/components/CopyBtn";

export function WatchOnlyPanel() {
  const { t } = useTranslation("wallet");
  const [xvk, setXvk] = useState("");
  // Default to mainnet: a real user pasting their real key on preprod would see a
  // misleading 0-ADA balance and think their funds vanished.
  const [network, setNetwork] = useState<PhoenixNetwork>(1);
  const [wallet, setWallet] = useState<WatchWallet | null>(null);
  const [lovelace, setLovelace] = useState<bigint>(BigInt("0"));
  const [assets, setAssets] = useState<DisplayAsset[]>([]);
  const [balanceOk, setBalanceOk] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setBusy(true);
    setBalanceOk(false);
    // Derivation is local and must not be blocked by a network failure, so the
    // balance fetch is caught separately — a bad xvk still surfaces its error,
    // an unreachable indexer shows the addresses with balance marked unavailable.
    let derived: WatchWallet;
    try {
      derived = deriveWatchWallet(parseAcctXvk(xvk), network, 5);
      setWallet(derived);
    } catch (err) {
      setWallet(null);
      toastApiError(err);
      setBusy(false);
      return;
    }
    try {
      const bal = await fetchAddressBalance(
        network,
        derived.addresses.map((a) => a.address),
      );
      setLovelace(bal.lovelace);
      setAssets(bal.assets);
      setBalanceOk(true);
    } catch (err) {
      toastApiError(err);
    } finally {
      setBusy(false);
    }
  };

  const inputCls =
    "w-full rounded-brand-sm border border-border-soft bg-bg0 px-3 py-2 text-sm mono focus:border-border-amber outline-none";

  return (
    <div className="space-y-4">
      <div className="rounded-brand border border-border-soft bg-bg1 p-5 space-y-3">
        <p className="text-sm text-text-dim">{t("watch_intro")}</p>
        <p className="text-xs text-amber-brand">⚠ {t("never_paste_seed")}</p>
        <label className="block">
          <span className="text-xs text-text-hint">{t("acct_xvk_label")}</span>
          <textarea
            className={inputCls + " h-20 resize-none break-all"}
            placeholder="acct_xvk1... / hex (128)"
            value={xvk}
            onChange={(e) => setXvk(e.target.value)}
          />
        </label>
        <details className="text-xs text-text-hint">
          <summary className="cursor-pointer hover:text-text-dim">{t("acct_xvk_help")}</summary>
          <p className="mt-1 text-text-dim">{t("acct_xvk_help_body")}</p>
        </details>
        <div className="flex gap-2 items-center">
          <select
            value={network}
            onChange={(e) => setNetwork(Number(e.target.value) as PhoenixNetwork)}
            className="rounded-brand-sm border border-border-soft bg-bg0 px-2 py-2 text-sm"
          >
            <option value={1}>{t("network_mainnet")}</option>
            <option value={0}>preprod</option>
            <option value={2}>preview</option>
          </select>
          <button
            type="button"
            disabled={busy || !xvk.trim()}
            onClick={load}
            className="flex-1 p-2.5 rounded-brand border border-border-soft bg-bg1 hover:bg-bg2 text-sm disabled:opacity-50"
          >
            {busy ? t("loading") : t("view_balance")}
          </button>
        </div>
        <p className="text-xs text-text-hint">{t("koios_privacy_note")}</p>
      </div>

      {wallet && (
        <>
          {balanceOk ? (
            <BalanceView lovelace={lovelace} assets={assets} />
          ) : (
            <div className="rounded-brand border border-border-soft bg-bg1 p-5 text-sm text-text-hint">
              {t("balance_unavailable")}
            </div>
          )}
          <div className="rounded-brand border border-border-soft bg-bg1 p-5 space-y-2">
            <p className="mono text-xs uppercase tracking-wider text-text-hint">
              {t("derived_addresses")}
            </p>
            {wallet.addresses.map((a) => (
              <div key={a.index} className="flex items-center gap-2 text-xs">
                <span className="text-text-hint w-6">#{a.index}</span>
                <span className="mono text-text-dim truncate flex-1">{a.address}</span>
                <CopyBtn value={a.address} />
              </div>
            ))}
            <div className="flex items-center gap-2 text-xs pt-2 border-t border-border-soft mt-2">
              <span className="text-text-hint w-14">stake</span>
              <span className="mono text-text-dim truncate flex-1">{wallet.stakeAddress}</span>
              <CopyBtn value={wallet.stakeAddress} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
