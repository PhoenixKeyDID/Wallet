"use client";

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toastApiError } from "@/lib/toast";
import {
  listWallets,
  enableWallet,
  readBalance,
  type Cip30Api,
  type Cip30Wallet,
} from "@/lib/cardano";
import { BalanceView } from "./BalanceView";
import { SendForm } from "./SendForm";

type Connected = {
  key: string;
  name: string;
  api: Cip30Api;
  networkId: number;
  changeAddress: string;
};

export function Cip30Panel() {
  const { t } = useTranslation("wallet");
  const [wallets, setWallets] = useState<Cip30Wallet[]>([]);
  const [conn, setConn] = useState<Connected | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [lovelace, setLovelace] = useState<bigint>(BigInt("0"));
  const [assets, setAssets] = useState<
    { unit: string; policyId: string; assetNameHex: string; quantity: bigint }[]
  >([]);
  const [showSend, setShowSend] = useState(false);

  useEffect(() => {
    // Read the browser-injected `window.cardano` once after mount — an external
    // system unavailable during SSR, static after the extension injects it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setWallets(listWallets());
  }, []);

  const recheck = () => setWallets(listWallets());

  const connect = async (key: string, name: string) => {
    setBusy(key);
    try {
      const api = await enableWallet(key);
      const [networkId, changeAddress] = await Promise.all([
        api.getNetworkId(),
        api.getChangeAddress(),
      ]);
      setConn({ key, name, api, networkId, changeAddress });
      const bal = await readBalance(api);
      setLovelace(bal.lovelace);
      setAssets(bal.assets);
    } catch (err) {
      toastApiError(err);
    } finally {
      setBusy(null);
    }
  };

  const refresh = async () => {
    if (!conn) return;
    try {
      const bal = await readBalance(conn.api);
      setLovelace(bal.lovelace);
      setAssets(bal.assets);
    } catch (err) {
      toastApiError(err);
    }
  };

  if (!conn) {
    if (wallets.length === 0) {
      return (
        <div className="rounded-brand border border-border-soft bg-bg1 p-5 space-y-3">
          <p className="text-sm font-medium">{t("no_cip30_wallet_title")}</p>
          <p className="text-sm text-text-dim">{t("web_no_create_notice")}</p>
          <a
            href={t("install_lace_url")}
            target="_blank"
            rel="noopener noreferrer"
            className="block w-full text-center p-3 rounded-brand border border-border-amber bg-amber-brand/10 text-amber-brand text-sm font-medium"
          >
            {t("install_lace_cta")}
          </a>
          <p className="text-xs text-text-hint">{t("install_lace_hint")}</p>
          <button
            type="button"
            onClick={recheck}
            className="w-full p-2.5 rounded-brand border border-border-soft bg-bg1 hover:bg-bg2 text-sm"
          >
            {t("recheck_wallets")}
          </button>
        </div>
      );
    }
    return (
      <div className="rounded-brand border border-border-soft bg-bg1 p-5 space-y-2">
        <p className="text-sm text-text-dim mb-1">{t("choose_wallet")}</p>
        {wallets.map((w) => (
          <button
            key={w.key}
            type="button"
            disabled={busy !== null}
            onClick={() => connect(w.key, w.name)}
            className="w-full flex items-center gap-3 p-3 rounded-brand border border-border-soft bg-bg1 hover:bg-bg2 transition disabled:opacity-50"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {w.icon ? <img src={w.icon} alt="" width={24} height={24} /> : <span>🔌</span>}
            <span className="font-medium capitalize">{w.name || w.key}</span>
            <span className="ml-auto text-text-hint text-sm">
              {busy === w.key ? t("connecting") : "→"}
            </span>
          </button>
        ))}
      </div>
    );
  }

  const networkLabel = conn.networkId === 1 ? "mainnet" : "testnet";
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between text-sm">
        <span className="flex items-center gap-2">
          <span className="inline-block w-2 h-2 rounded-full bg-success" />
          {t("connected_to")} <span className="font-medium capitalize">{conn.name || conn.key}</span>
          <span className="mono text-xs text-text-hint">({networkLabel})</span>
        </span>
        <button type="button" onClick={() => setConn(null)} className="text-text-hint hover:text-text">
          {t("disconnect")}
        </button>
      </div>

      <BalanceView
        lovelace={lovelace}
        assets={assets}
        address={conn.changeAddress}
        showReceive
      />

      <div className="flex gap-2">
        <button
          type="button"
          onClick={refresh}
          className="flex-1 p-3 rounded-brand border border-border-soft bg-bg1 hover:bg-bg2 text-sm"
        >
          {t("refresh")}
        </button>
        <button
          type="button"
          onClick={() => setShowSend((s) => !s)}
          className="flex-1 p-3 rounded-brand border border-border-amber bg-bg1 hover:bg-bg2 text-sm text-amber-brand"
        >
          {t("send_experimental")}
        </button>
      </div>

      {showSend && (
        <SendForm api={conn.api} networkId={conn.networkId} onDone={refresh} />
      )}
    </div>
  );
}
