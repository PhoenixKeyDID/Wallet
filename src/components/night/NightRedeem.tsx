"use client";

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toastApiError } from "@/lib/toast";
import { CopyBtn } from "@/components/CopyBtn";
import { listWallets, enableWallet, readBalance, formatAda, type Cip30Wallet } from "@/lib/cardano";
import { buildRedeemUrl, MIDNIGHT_INFO } from "@/lib/night";

/**
 * Connect a Cardano wallet (Lace preferred) via CIP-30, show the connected
 * address + ADA, then hand off to the official Midnight redemption portal. All
 * signing of the redemption transaction happens on the official portal.
 */
export function NightRedeem() {
  const { t } = useTranslation("night");
  const [wallets, setWallets] = useState<Cip30Wallet[]>([]);
  const [address, setAddress] = useState<string | null>(null);
  const [walletName, setWalletName] = useState<string | null>(null);
  const [lovelace, setLovelace] = useState<bigint>(BigInt("0"));
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    const all = listWallets();
    // Surface Lace first (IOG-built, native Midnight integration).
    all.sort((a, b) => (a.key === "lace" ? -1 : b.key === "lace" ? 1 : 0));
    // Read the browser-injected `window.cardano` once after mount — external
    // system unavailable during SSR, static after the extension injects it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setWallets(all);
  }, []);

  const recheck = () => {
    const all = listWallets();
    all.sort((a, b) => (a.key === "lace" ? -1 : b.key === "lace" ? 1 : 0));
    setWallets(all);
  };

  const connect = async (key: string, name: string) => {
    setBusy(key);
    try {
      const api = await enableWallet(key);
      const [used, change, bal] = await Promise.all([
        api.getUsedAddresses(),
        api.getChangeAddress(),
        readBalance(api),
      ]);
      setAddress(used[0] ?? change ?? null);
      setWalletName(name || key);
      setLovelace(bal.lovelace);
    } catch (err) {
      toastApiError(err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-5">
      <div className="rounded-brand border border-border-soft bg-bg1 p-5 space-y-2">
        <p className="text-sm text-text-dim">{t("intro")}</p>
        <ul className="text-sm text-text-dim list-disc pl-5 space-y-1">
          <li>{t("point_official")}</li>
          <li>{t("point_destination")}</li>
          <li>{t("point_fee")}</li>
          <li>{t("point_thaw")}</li>
        </ul>
      </div>

      {!address ? (
        wallets.length === 0 ? (
          <div className="rounded-brand border border-border-soft bg-bg1 p-5 space-y-3">
            <p className="text-sm text-text-dim">{t("no_wallet")}</p>
            <a
              href="https://www.lace.io"
              target="_blank"
              rel="noopener noreferrer"
              className="block w-full text-center p-3 rounded-brand border border-border-teal bg-teal-brand/10 text-teal-brand text-sm font-medium"
            >
              {t("install_lace_cta")}
            </a>
            <button
              type="button"
              onClick={recheck}
              className="w-full p-2.5 rounded-brand border border-border-soft bg-bg1 hover:bg-bg2 text-sm"
            >
              {t("recheck_wallets")}
            </button>
          </div>
        ) : (
          <div className="rounded-brand border border-border-soft bg-bg1 p-5 space-y-2">
            <p className="text-sm text-text-dim mb-1">{t("connect_prompt")}</p>
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
                {w.key === "lace" && (
                  <span className="text-xs text-teal-brand">{t("recommended")}</span>
                )}
                <span className="ml-auto text-text-hint text-sm">
                  {busy === w.key ? t("connecting") : "→"}
                </span>
              </button>
            ))}
          </div>
        )
      ) : (
        <div className="rounded-brand border border-border-soft bg-bg1 p-5 space-y-3">
          <div className="flex items-center gap-2 text-sm">
            <span className="inline-block w-2 h-2 rounded-full bg-success" />
            {t("connected_to")}{" "}
            <span className="font-medium capitalize">{walletName}</span>
            <span className="mono text-xs text-text-hint">{formatAda(lovelace)} ADA</span>
          </div>
          <div className="flex items-center justify-between">
            <p className="mono text-xs uppercase tracking-wider text-text-hint">
              {t("your_address")}
            </p>
            <CopyBtn value={address} />
          </div>
          <p className="mono text-xs text-text-dim break-all">{address}</p>

          <a
            href={buildRedeemUrl()}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-shine btn-shine-teal block w-full text-center p-3 rounded-brand border border-border-teal bg-teal-brand/10 text-teal-brand font-medium"
          >
            {t("open_portal")}
          </a>
          <p className="text-xs text-text-hint text-center">{t("portal_url_preview")}</p>
          <p className="text-xs text-text-hint text-center">{t("handoff_note")}</p>
        </div>
      )}

      <p className="text-xs text-text-hint text-center">
        <a href={MIDNIGHT_INFO} target="_blank" rel="noopener noreferrer" className="underline">
          {t("learn_more")}
        </a>
      </p>
    </div>
  );
}
