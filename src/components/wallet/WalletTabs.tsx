"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { Cip30Api, PhoenixNetwork } from "@/lib/cardano";
import { SendPanel } from "./SendPanel";
import { ReceivePanel } from "./ReceivePanel";
import { StakingPanel } from "./StakingPanel";
import { GovernancePanel } from "./GovernancePanel";
import { ConnectPanel } from "./ConnectPanel";

type Tab = "send" | "receive" | "staking" | "governance" | "connect";

const TABS: { id: Tab; labelKey: string; icon: string }[] = [
  { id: "send", labelKey: "tab_send", icon: "📤" },
  { id: "receive", labelKey: "tab_receive", icon: "📥" },
  { id: "staking", labelKey: "tab_staking", icon: "🥩" },
  { id: "governance", labelKey: "tab_governance", icon: "🗳️" },
  { id: "connect", labelKey: "tab_connect", icon: "🔗" },
];

/**
 * Feature tabs shown once a wallet is connected (Send / Receive / Staking /
 * Governance / Connect). Owns the single source of truth for the resolved
 * `PhoenixNetwork` and passes it — plus the connected `api` and hex
 * `changeAddress` — down to every panel, so no panel re-implements the
 * preprod-vs-preview disambiguation.
 *
 * CIP-30 `getNetworkId()` returns 0 for EVERY testnet, so it cannot tell
 * preprod from preview. Mainnet (1) is unambiguous; on testnet we let the user
 * pick, defaulting to preprod.
 */
export function WalletTabs({
  api,
  networkId,
  changeAddress,
}: {
  api: Cip30Api;
  networkId: number;
  changeAddress: string;
}) {
  const { t } = useTranslation("wallet");
  // Default to Receive: after connecting, most people want to view or get an
  // address — not land on the money-sending form first.
  const [tab, setTab] = useState<Tab>("receive");
  const isMainnet = networkId === 1;
  // Persist the testnet pick so a remount doesn't silently snap back to Preprod
  // while the extension is on Preview (wrong-network confusion).
  const [testnetVariant, setTestnetVariant] = useState<PhoenixNetwork>(() => {
    if (typeof window === "undefined") return 0;
    const saved = window.localStorage.getItem("phoenix.testnetVariant");
    return saved === "2" ? 2 : 0;
  });
  const network: PhoenixNetwork = isMainnet ? 1 : testnetVariant;

  const panelProps = { api, network, changeAddress };

  return (
    <div className="space-y-4">
      {/* Network picker — only ambiguous on testnet */}
      {!isMainnet && (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-text-hint">{t("network_label")}</span>
          <select
            value={testnetVariant}
            onChange={(e) => {
              const v = Number(e.target.value) as PhoenixNetwork;
              setTestnetVariant(v);
              if (typeof window !== "undefined") window.localStorage.setItem("phoenix.testnetVariant", String(v));
            }}
            className="rounded-brand border border-border-soft bg-bg1 px-2 py-1"
          >
            <option value={0}>{t("network_preprod")}</option>
            <option value={2}>{t("network_preview")}</option>
          </select>
          <span className="text-text-hint">— {t("network_match_hint")}</span>
        </div>
      )}

      {/* Tab bar */}
      <div className="flex gap-1 overflow-x-auto rounded-brand border border-border-soft bg-bg1 p-1">
        {TABS.map((tb) => {
          const active = tb.id === tab;
          return (
            <button
              key={tb.id}
              type="button"
              onClick={() => setTab(tb.id)}
              className={
                "flex-1 min-w-[4.5rem] rounded-brand px-2 py-2 text-xs font-medium transition " +
                (active ? "bg-bg2 text-text" : "text-text-hint hover:bg-bg2")
              }
            >
              <span className="block text-base leading-none mb-1" aria-hidden>
                {tb.icon}
              </span>
              {t(tb.labelKey)}
            </button>
          );
        })}
      </div>

      {tab === "send" && <SendPanel {...panelProps} />}
      {tab === "receive" && <ReceivePanel {...panelProps} />}
      {tab === "staking" && <StakingPanel {...panelProps} />}
      {tab === "governance" && <GovernancePanel {...panelProps} />}
      {tab === "connect" && <ConnectPanel {...panelProps} />}
    </div>
  );
}
