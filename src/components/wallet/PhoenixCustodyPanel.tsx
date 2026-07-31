"use client";

import { useState } from "react";
import { Buffer } from "buffer";
import { useTranslation } from "react-i18next";
import { toastApiError } from "@/lib/toast";
import { anchorAssetNameHex } from "@/lib/cardano";
import { getAllWallets, type WalletEntry } from "@/lib/wallet";
import { BalanceView } from "./BalanceView";
import { CopyBtn } from "@/components/CopyBtn";

/**
 * Phoenix custody wallet = a script enterprise address bound to a DID
 * (`did + anchor_nft_policy`), invariant across key rotation/recovery.
 * View-only in v1: the address + public balances come from the backend; spending
 * needs the controller key (mobile / air-gap), which is phase 2.
 */
export function PhoenixCustodyPanel() {
  const { t } = useTranslation("wallet");
  const [did, setDid] = useState("");
  const [phoenix, setPhoenix] = useState<WalletEntry | null>(null);
  const [anchorName, setAnchorName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const resolve = async () => {
    setBusy(true);
    setPhoenix(null);
    try {
      const trimmed = did.trim();
      setAnchorName(anchorAssetNameHex(trimmed));
      const all = await getAllWallets(trimmed);
      const p = all.wallets.find((w) => w.kind === "phoenix") ?? null;
      setPhoenix(p);
    } catch (err) {
      toastApiError(err);
    } finally {
      setBusy(false);
    }
  };

  const custodyAddress =
    phoenix?.addresses.custody ?? phoenix?.addresses.fixed ?? null;
  const lovelace = phoenix ? BigInt(String(phoenix.balances.lovelace ?? 0)) : BigInt("0");
  const assets = phoenix
    ? (["lamp", "carp"] as const)
        .filter((k) => phoenix.balances[k] != null)
        .map((k) => ({
          unit: k,
          policyId: k,
          assetNameHex: Buffer.from(k.toUpperCase()).toString("hex"),
          quantity: BigInt(String(phoenix.balances[k])),
        }))
    : [];

  const inputCls =
    "w-full rounded-brand-sm border border-border-soft bg-bg0 px-3 py-2 text-sm mono focus:border-border-amber outline-none";

  return (
    <div className="space-y-4">
      <div className="rounded-brand border border-border-soft bg-bg1 p-5 space-y-3">
        <p className="text-sm text-text-dim">{t("phoenix_intro")}</p>
        <label className="block">
          <span className="text-xs text-text-hint">{t("did_label")}</span>
          <input
            className={inputCls}
            placeholder="did:phoenix:person:..."
            value={did}
            onChange={(e) => setDid(e.target.value)}
          />
        </label>
        <details className="text-xs text-text-hint">
          <summary className="cursor-pointer hover:text-text-dim">{t("did_help")}</summary>
          <p className="mt-1 text-text-dim">{t("did_help_body")}</p>
        </details>
        <button
          type="button"
          disabled={busy || !did.trim()}
          onClick={resolve}
          className="w-full p-2.5 rounded-brand border border-border-soft bg-bg1 hover:bg-bg2 text-sm disabled:opacity-50"
        >
          {busy ? t("loading") : t("resolve_custody")}
        </button>
      </div>

      {anchorName && (
        <div className="rounded-brand border border-border-soft bg-bg1 p-4">
          <div className="flex items-center justify-between mb-1">
            <p className="mono text-xs uppercase tracking-wider text-text-hint">
              {t("anchor_name")}
            </p>
            <CopyBtn value={anchorName} />
          </div>
          <p className="mono text-xs text-text-dim break-all">{anchorName}</p>
        </div>
      )}

      {phoenix ? (
        <>
          {custodyAddress && (
            <p className="text-xs text-amber-brand px-1">⚠ {t("custody_verify_note")}</p>
          )}
          <BalanceView
            lovelace={lovelace}
            assets={assets}
            address={custodyAddress}
            showReceive={!!custodyAddress}
          />
        </>
      ) : (
        anchorName && (
          <p className="text-xs text-text-hint px-1">{t("phoenix_no_backend")}</p>
        )
      )}
    </div>
  );
}
