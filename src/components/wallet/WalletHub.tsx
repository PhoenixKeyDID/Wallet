"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Cip30Panel } from "./Cip30Panel";
import { WatchOnlyPanel } from "./WatchOnlyPanel";
import { PhoenixCustodyPanel } from "./PhoenixCustodyPanel";
import { LocalWalletPanel } from "./LocalWalletPanel";

type Mode = "connect" | "watch" | "phoenix" | "local";

const MODES: { id: Mode; labelKey: string; hintKey: string; icon: string }[] = [
  { id: "connect", labelKey: "mode_connect", hintKey: "mode_connect_hint", icon: "🔌" },
  { id: "watch", labelKey: "mode_watch", hintKey: "mode_watch_hint", icon: "👁️" },
  { id: "phoenix", labelKey: "mode_phoenix", hintKey: "mode_phoenix_hint", icon: "🔥" },
  { id: "local", labelKey: "mode_local", hintKey: "mode_local_hint", icon: "🔑" },
];

type Props = {
  /**
   * DID of the signed-in user, from the host session. Only the Phoenix custody
   * mode needs it — Connect and Watch-only never talk to the Phoenix backend.
   * Omit it and that mode simply says "sign in first".
   */
  did?: string | null;
};

export function WalletHub({ did }: Props) {
  const { t } = useTranslation("wallet");
  const [mode, setMode] = useState<Mode>("connect");

  return (
    <div className="space-y-5">
      {/* Mode selector */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
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

      {/* The standing assurance — and the one mode where it stops being true.
          Leaving "this page never asks for your phrase" on screen while the
          page is asking for exactly that would teach the habit the notice
          exists to prevent, so the notice changes with the mode. */}
      <p className="text-xs text-text-hint flex items-center gap-2">
        <span aria-hidden>{mode === "local" ? "🔑" : "🔒"}</span>
        {mode === "local" ? t("local_seed_notice") : t("no_seed_notice")}
      </p>

      {mode === "connect" && <Cip30Panel />}
      {mode === "watch" && <WatchOnlyPanel />}
      {mode === "phoenix" && <PhoenixCustodyPanel did={did} />}
      {mode === "local" && <LocalWalletPanel />}
    </div>
  );
}
