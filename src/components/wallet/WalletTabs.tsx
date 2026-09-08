"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { PhoenixNetwork, WalletPort } from "@/lib/cardano";
import { SendPanel } from "./SendPanel";
import { ReceivePanel } from "./ReceivePanel";
import { StakingPanel } from "./StakingPanel";
import { GovernancePanel } from "./GovernancePanel";
import { ConnectPanel } from "./ConnectPanel";
import { HistoryPanel } from "./HistoryPanel";

type Tab = "send" | "receive" | "history" | "staking" | "governance" | "connect";

const TABS: { id: Tab; labelKey: string; icon: string }[] = [
  { id: "send", labelKey: "tab_send", icon: "📤" },
  { id: "receive", labelKey: "tab_receive", icon: "📥" },
  { id: "history", labelKey: "tab_history", icon: "🧾" },
  { id: "staking", labelKey: "tab_staking", icon: "🥩" },
  { id: "governance", labelKey: "tab_governance", icon: "🗳️" },
  { id: "connect", labelKey: "tab_connect", icon: "🔗" },
];

/**
 * Where the network came from, and therefore whether it is knowable.
 *
 * `networkId` is CIP-30's answer, and CIP-30 answers `0` for EVERY testnet — it
 * genuinely cannot tell preprod from preview, so the picker below exists to ask
 * the person. `network` is the local-keystore answer: an account is bound to
 * one network when it is derived, so there is nothing to ask and showing the
 * picker would invite someone to select a network their keys are not on.
 *
 * Modelling this as a union rather than an optional flag is the point: it is
 * impossible to mount the tabs without saying which situation you are in.
 */
type NetworkSource =
  | { networkId: number; network?: never }
  | { network: PhoenixNetwork; networkId?: never };

/**
 * Feature tabs shown once a wallet is usable (Send / Receive / Staking /
 * Governance / Connect).
 *
 * Every panel below reads and signs through one `WalletPort`, so the same five
 * tabs serve a connected extension and a wallet whose keys this app is holding
 * itself. Nothing here knows which — that is the whole reason the port exists.
 * `WalletTabs` owns only the single source of truth for the resolved
 * `PhoenixNetwork`, so no panel re-implements the disambiguation above.
 */
export function WalletTabs({
  port,
  changeAddress,
  ...source
}: {
  port: WalletPort;
  changeAddress: string;
} & NetworkSource) {
  const { t } = useTranslation("wallet");
  // Default to Receive: after connecting, most people want to view or get an
  // address — not land on the money-sending form first.
  const [tab, setTab] = useState<Tab>("receive");
  // Persist the testnet pick so a remount doesn't silently snap back to Preprod
  // while the extension is on Preview (wrong-network confusion). The hook runs
  // unconditionally even when the network is already known — React requires it,
  // and an unread value is cheaper than a second component.
  const [testnetVariant, setTestnetVariant] = useState<PhoenixNetwork>(() => {
    if (typeof window === "undefined") return 0;
    const saved = window.localStorage.getItem("phoenix.testnetVariant");
    return saved === "2" ? 2 : 0;
  });
  /**
   * Connect is an extension-only screen, so a local wallet does not get the tab.
   *
   * It exists to bridge to the CIP-30 extension you already connected — its
   * text says exactly that — and it shows `changeAddress` under the heading
   * "the account a dApp would see". For a local wallet that address is on the
   * **internal** chain, which BIP-44 keeps unpublished precisely so it is not
   * handed to anyone; labelling it as the user's account and inviting them to
   * copy it links the whole change chain from outside. Two wrong things at
   * once, and neither is fixed by rewording, because the screen's job does not
   * exist in this mode.
   */
  const tabs = port.kind === "local" ? TABS.filter((tb) => tb.id !== "connect") : TABS;
  // A tab that has just disappeared must not stay selected.
  const activeTab = tabs.some((tb) => tb.id === tab) ? tab : "receive";

  // `!== undefined` rather than `"network" in source`: both branches of the
  // union now *declare* `network` (one as `never`) so that passing both keys is
  // a type error, and `in` cannot discriminate on a key both branches declare.
  const known = source.network !== undefined;
  const network: PhoenixNetwork = known
    ? source.network
    : source.networkId === 1
      ? 1
      : testnetVariant;

  const panelProps = { port, network, changeAddress };

  return (
    <div className="space-y-4">
      {/* Network picker — only when the network is genuinely ambiguous */}
      {!known && network !== 1 && (
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
        {tabs.map((tb) => {
          const active = tb.id === activeTab;
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

      {activeTab === "send" && <SendPanel {...panelProps} />}
      {activeTab === "receive" && <ReceivePanel {...panelProps} />}
      {activeTab === "history" && <HistoryPanel {...panelProps} />}
      {activeTab === "staking" && <StakingPanel {...panelProps} />}
      {activeTab === "governance" && <GovernancePanel {...panelProps} />}
      {activeTab === "connect" && <ConnectPanel network={network} changeAddress={changeAddress} />}
    </div>
  );
}
