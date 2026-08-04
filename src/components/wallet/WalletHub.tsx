"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Cip30Panel } from "./Cip30Panel";
import { WatchOnlyPanel } from "./WatchOnlyPanel";
import { PhoenixCustodyPanel } from "./PhoenixCustodyPanel";

type Mode = "connect" | "watch" | "phoenix";

const MODES: { id: Mode; labelKey: string; hintKey: string; icon: string }[] = [
  { id: "connect", labelKey: "mode_connect", hintKey: "mode_connect_hint", icon: "🔌" },
  { id: "watch", labelKey: "mode_watch", hintKey: "mode_watch_hint", icon: "👁️" },
  { id: "phoenix", labelKey: "mode_phoenix", hintKey: "mode_phoenix_hint", icon: "🔥" },
];

export function WalletHub() {
  const { t } = useTranslation("wallet");
  const [mode, setMode] = useState<Mode>("connect");

  return (
    <div className="space-y-5">
      {/* Mode selector */}
      <div className="grid grid-cols-3 gap-2">
        {MODES.map((m) => {
          const active = m.id === mode;
          return (
            <button
              key={m.id}
              type="button"
              onClick={() => setMode(m.id)}
              className={
                "rounded-brand border p-3 text-left transition " +
                (active
                  ? "border-border-amber bg-bg2"
                  : "border-border-soft bg-bg1 hover:bg-bg2")
              }
            >
              <span className="text-lg">{m.icon}</span>
              <span className="block font-semibold text-sm mt-1">{t(m.labelKey)}</span>
              <span className="block text-xs text-text-hint mt-0.5">{t(m.hintKey)}</span>
            </button>
          );
        })}
      </div>

      {/* No-seed-online assurance */}
      <p className="text-xs text-text-hint flex items-center gap-2">
        <span aria-hidden>🔒</span>
        {t("no_seed_notice")}
      </p>

      {mode === "connect" && <Cip30Panel />}
      {mode === "watch" && <WatchOnlyPanel />}
      {mode === "phoenix" && <PhoenixCustodyPanel />}
    </div>
  );
}
