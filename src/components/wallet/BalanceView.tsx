"use client";

import { useTranslation } from "react-i18next";
import { QRCodeCanvas } from "qrcode.react";
import { CopyBtn } from "@/components/CopyBtn";
import { formatAda, assetLabel } from "@/lib/cardano";

export type DisplayAsset = { unit: string; policyId: string; assetNameHex: string; quantity: bigint };

/** Presentational balance card: ADA + native tokens, optional receive address + QR. */
export function BalanceView({
  lovelace,
  assets,
  address,
  showReceive = false,
}: {
  lovelace: bigint;
  assets: DisplayAsset[];
  address?: string | null;
  showReceive?: boolean;
}) {
  const { t } = useTranslation("wallet");
  return (
    <div className="rounded-brand border border-border-soft bg-bg1 p-5 space-y-4">
      <div>
        <p className="mono text-xs uppercase tracking-wider text-text-hint">{t("balance_label")}</p>
        <p className="text-3xl font-semibold mt-1">
          {formatAda(lovelace)} <span className="text-text-dim text-lg">ADA</span>
        </p>
      </div>

      {assets.length > 0 && (
        <div className="space-y-1">
          <p className="mono text-xs uppercase tracking-wider text-text-hint">{t("tokens_label")}</p>
          <ul className="divide-y divide-border-soft">
            {assets.map((a) => (
              <li key={a.unit} className="flex items-center justify-between py-1.5 text-sm">
                {/* The name is attacker-chosen: minting a token called "ADA",
                    or one whose name matches a token the user already holds,
                    costs nothing. Only the policy id distinguishes them, so it
                    is shown next to every name rather than hidden in a
                    tooltip — a tooltip does not exist on a phone. */}
                <span className="max-w-[60%] min-w-0">
                  <span className="mono block truncate" title={a.unit}>
                    {assetLabel(a.assetNameHex)}
                  </span>
                  <span className="mono block text-[10px] text-text-hint truncate">
                    {a.policyId.slice(0, 8)}…{a.policyId.slice(-4)}
                  </span>
                </span>
                <span className="mono text-text-dim">{a.quantity.toString()}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {showReceive && address && (
        <div className="pt-2 border-t border-border-soft">
          <div className="flex items-center justify-between mb-2">
            <p className="mono text-xs uppercase tracking-wider text-text-hint">
              {t("receive_label")}
            </p>
            <CopyBtn value={address} />
          </div>
          <div className="flex items-start gap-3">
            <div className="bg-white p-2 rounded-brand-sm shrink-0">
              <QRCodeCanvas value={address} size={112} />
            </div>
            <p className="mono text-xs text-text-dim break-all">{address}</p>
          </div>
        </div>
      )}
    </div>
  );
}
