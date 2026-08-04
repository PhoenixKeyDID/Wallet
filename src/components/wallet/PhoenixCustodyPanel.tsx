"use client";

import { useState } from "react";
import { Buffer } from "buffer";
import { useTranslation } from "react-i18next";
import { toastApiError } from "@/lib/toast";
import { anchorAssetNameHex } from "@/lib/cardano";
import { ApiError } from "@/lib/api";
import { getAllWallets, type WalletEntry } from "@/lib/wallet";
import { BalanceView } from "./BalanceView";
import { CopyBtn } from "@/components/CopyBtn";

/**
 * Phoenix custody wallet = a script enterprise address bound to a DID
 * (`did + anchor_nft_policy`), invariant across key rotation/recovery.
 * View-only in v1: the address + balances come from the backend; spending needs
 * the controller key (mobile / air-gap), which is phase 2.
 *
 * The DID is a PROP, not a text field. The backend serves only the caller's own
 * wallet (`caller_did == path_did`, PhoenixKey-Database#116), so a box inviting
 * you to type any DID could only ever produce a 401. The host passes the DID its
 * session already holds; signed out, there is nothing to resolve.
 */
type Props = {
  /** DID of the signed-in user, supplied by the host session. */
  did?: string | null;
};

export function PhoenixCustodyPanel({ did }: Props) {
  const { t } = useTranslation("wallet");
  const sessionDid = did?.trim() ?? "";
  const [phoenix, setPhoenix] = useState<WalletEntry | null>(null);
  const [anchorName, setAnchorName] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const [busy, setBusy] = useState(false);

  const resolve = async () => {
    if (!sessionDid) return;
    setBusy(true);
    setPhoenix(null);
    setDenied(false);
    try {
      setAnchorName(anchorAssetNameHex(sessionDid));
      const all = await getAllWallets(sessionDid);
      const p = all.wallets.find((w) => w.kind === "phoenix") ?? null;
      setPhoenix(p);
    } catch (err) {
      // 401 here means the session expired or belongs to a different DID. Say so
      // in the panel — a toast alone is easy to miss and reads as a generic fault.
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        setDenied(true);
      }
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

  return (
    <div className="space-y-4">
      <div className="rounded-brand border border-border-soft bg-bg1 p-5 space-y-3">
        <p className="text-sm text-text-dim">{t("phoenix_intro")}</p>

        {sessionDid ? (
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-text-hint">{t("phoenix_session_did")}</span>
              <CopyBtn value={sessionDid} />
            </div>
            <p className="mono text-xs text-text-dim break-all">{sessionDid}</p>
          </div>
        ) : (
          <p className="text-xs text-amber-brand">{t("phoenix_needs_session")}</p>
        )}

        <details className="text-xs text-text-hint">
          <summary className="cursor-pointer hover:text-text-dim">{t("did_help")}</summary>
          <p className="mt-1 text-text-dim">{t("did_help_body")}</p>
        </details>
        <button
          type="button"
          disabled={busy || !sessionDid}
          onClick={resolve}
          className="w-full p-2.5 rounded-brand border border-border-soft bg-bg1 hover:bg-bg2 text-sm disabled:opacity-50"
        >
          {busy ? t("loading") : t("resolve_custody")}
        </button>
      </div>

      {denied && (
        <p className="text-xs text-amber-brand px-1">⚠ {t("phoenix_unauthorized")}</p>
      )}

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
