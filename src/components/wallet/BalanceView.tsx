"use client";

import { useTranslation } from "react-i18next";
import { QRCodeCanvas } from "qrcode.react";
import { CopyBtn } from "@/components/CopyBtn";
import { formatAda, assetNameOnly, policyIdShort, type PhoenixNetwork } from "@/lib/cardano";
import { FiatValue } from "./FiatValue";
import { UNREAD_FIGURE } from "./moneyNotice";

export type DisplayAsset = { unit: string; policyId: string; assetNameHex: string; quantity: bigint };

/**
 * Presentational balance card: ADA + native tokens, optional receive address + QR.
 *
 * `network` is required rather than optional, and that is the point of it being
 * here at all: the fiat line under the ADA figure converts a balance at the
 * mainnet ADA rate, and every screen in this module was handing it testnet
 * balances too. A preprod wallet holding 10 000 test ADA — which the faucet
 * gives away — read as tens of millions of đồng. That is not a rounding problem
 * or a stale rate; it is a number with no referent, printed in the reader's own
 * currency, on the screen they opened to find out what they have. Making the
 * prop optional would let the next call site omit it and land back on mainnet by
 * default, which is the direction that lies.
 */
export function BalanceView({
  lovelace,
  assets,
  network,
  address,
  showReceive = false,
  settled = true,
}: {
  lovelace: bigint;
  assets: DisplayAsset[];
  network: PhoenixNetwork;
  address?: string | null;
  showReceive?: boolean;
  /**
   * `false` while the balance has not been read — still loading, or the read
   * failed. `lovelace` is then the starting zero, not a reading, so the figure
   * is a dash and no fiat line is drawn: "0 ADA" in large type on a wallet
   * whose balance nobody has read is a number the page made up. Defaults to
   * `true` for the screens that only mount this card after a read landed.
   */
  settled?: boolean;
}) {
  const { t } = useTranslation("wallet");
  return (
    <div className="rounded-brand border border-border-soft bg-bg1 p-5 space-y-4">
      <div>
        <p className="mono text-xs uppercase tracking-wider text-text-hint">{t("balance_label")}</p>
        <p className="text-3xl font-semibold mt-1" data-settled={settled ? "true" : "false"}>
          {settled ? formatAda(lovelace) : UNREAD_FIGURE} <span className="text-text-dim text-lg">ADA</span>
        </p>
        {/* Under the ADA figure, never instead of it: the line above is what
            the wallet holds, the one below is what someone was paying for it
            at a moment. Only tokens with a known price would ever get one, and
            none do — a native token's "value" is whatever its minter says. */}
        {settled && <FiatValue lovelace={lovelace} network={network} />}
      </div>

      {assets.length > 0 && (
        <div className="space-y-1">
          <p className="mono text-xs uppercase tracking-wider text-text-hint">{t("tokens_label")}</p>
          <AssetList assets={assets} />
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

/**
 * Native tokens, one row each, with the policy id under every name.
 *
 * Its own component so the extension popup's home screen can list the same
 * rows under its own balance figure without a second copy of the markup — the
 * policy-id line below is a safety property, and a copy is where it would be
 * dropped "to save space".
 */
export function AssetList({ assets }: { assets: DisplayAsset[] }) {
  return (
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
              {assetNameOnly(a.assetNameHex)}
            </span>
            <span className="mono block text-[10px] text-text-hint truncate">
              {policyIdShort(a.policyId)}
            </span>
          </span>
          <span className="mono text-text-dim">{a.quantity.toString()}</span>
        </li>
      ))}
    </ul>
  );
}
