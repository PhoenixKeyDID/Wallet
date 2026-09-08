"use client";

import "../../lib/node-globals";
import { useMemo } from "react";
import { Buffer } from "buffer";
import { useTranslation } from "react-i18next";
import { utils as tyUtils } from "@stricahq/typhonjs";
import { type PhoenixNetwork } from "@/lib/cardano";
import {
  KNOWN_DAPPS,
  EMBEDDED_DAPP_BROWSER_ENABLED,
  type KnownDapp,
} from "@/lib/cardano/connect";

/**
 * Connect — a curated launcher for dApps (Minswap, SundaeSwap…).
 *
 * Honest by design: this screen never puts a signer in a dApp's hands. It tells
 * you which account you would be sharing and opens the vetted site so you
 * connect there, in that site's own flow, with whatever wallet you choose. No
 * auto-injection into arbitrary sites; the embedded dApp browser is off.
 *
 * The restraint is deliberate rather than incidental. It used to be incidental —
 * this panel said a web page "holds no spendable seed", which was true before
 * the local keystore existed and is not true now. A wallet that can sign is a
 * wallet whose Connect screen has something to lose, so the rule is stated as a
 * rule: nothing here reaches a signing key, in either mode.
 */
export function ConnectPanel({
  network,
  changeAddress,
}: {
  network: PhoenixNetwork;
  changeAddress: string;
}) {
  const { t } = useTranslation("wallet");

  // NOTE: no provider is constructed here, and this panel deliberately does not
  // receive the `WalletPort` the sibling tabs use. A dApp transport (CIP-45 peer
  // / embedded frame) is wired later and MUST go through `buildDappProvider`,
  // which refuses to hand a dApp a signer without Phoenix's review interposed.
  // Not taking the port is what makes that reviewable: a guardless provider
  // cannot be added here without the diff also adding the prop that feeds it.

  // The account this wallet would expose to a dApp = the connected wallet's
  // change address, shown as a friendly bech32 string.
  const exposedAddress = useMemo(() => {
    if (!changeAddress) return "";
    try {
      return tyUtils.getAddressFromHex(Buffer.from(changeAddress, "hex")).getBech32();
    } catch {
      return changeAddress;
    }
  }, [changeAddress]);

  const networkLabel = network === 1 ? "mainnet" : "testnet";
  const shortAddr = (a: string) => (a.length > 24 ? `${a.slice(0, 14)}…${a.slice(-8)}` : a);
  // Show the exact destination host so the user can eyeball where "Open" goes —
  // the curated URL is the trust boundary; surfacing it lets a poisoned entry
  // (e.g. a homoglyph domain slipped in via a PR) be caught by a human.
  const hostOf = (u: string) => {
    try {
      return new URL(u).host;
    } catch {
      return u;
    }
  };

  const openDapp = (d: KnownDapp) => {
    window.open(d.url, "_blank", "noopener,noreferrer");
  };

  return (
    <div className="space-y-4">
      {/* How connecting works — set expectations before anyone clicks. */}
      <div className="rounded-brand border border-border-soft bg-bg1 p-5 space-y-2">
        <p className="text-sm font-medium">{t("connect_title")}</p>
        <p className="text-sm text-text-dim">{t("connect_intro")}</p>
        <p className="text-xs text-text-hint">{t("connect_how_extension")}</p>
      </div>

      {/* The account a dApp would see. */}
      <div className="rounded-brand border border-border-teal bg-bg1 p-4 space-y-1">
        <p className="text-xs text-text-hint">{t("connect_exposed_account")}</p>
        {exposedAddress ? (
          <p className="mono text-sm break-all text-teal-brand">{shortAddr(exposedAddress)}</p>
        ) : (
          <p className="text-sm text-text-dim">{t("connect_no_account")}</p>
        )}
        {/* This is a reference, not a hand-off: opening a dApp starts a fresh
            connect there, where the user may pick a different account/wallet. */}
        <p className="text-xs text-text-hint">{t("connect_exposed_account_note")}</p>
        <p className="text-xs text-text-hint">
          {t("connect_network_note", { network: networkLabel })}
        </p>
      </div>

      {/* Curated dApp launcher. */}
      <div className="space-y-2">
        <p className="text-sm text-text-dim">{t("connect_choose_dapp")}</p>
        {KNOWN_DAPPS.map((d) => (
          <div
            key={d.id}
            className="w-full flex items-center gap-3 p-3 rounded-brand border border-border-soft bg-bg1"
          >
            <span className="text-2xl" aria-hidden>
              {d.emoji}
            </span>
            <span className="min-w-0">
              <span className="block font-medium">{d.name}</span>
              <span className="block text-[11px] mono text-teal-brand truncate">{hostOf(d.url)}</span>
              <span className="block text-xs text-text-hint truncate">
                {t(d.descKey, d.description)}
              </span>
            </span>
            <button
              type="button"
              onClick={() => openDapp(d)}
              className="ml-auto shrink-0 px-3 py-2 rounded-brand border border-border-amber bg-amber-brand/10 hover:bg-amber-brand/20 text-sm text-amber-brand"
            >
              {t("connect_open_dapp")}
            </button>
          </div>
        ))}
        <p className="text-xs text-text-hint">{t("connect_open_note")}</p>
      </div>

      {/* Experimental embedded browser — visibly present, disabled by default. */}
      <div className="rounded-brand border border-border-soft bg-bg2 p-4 space-y-1 opacity-70">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{t("connect_embedded_title")}</span>
          <span className="ml-auto text-xs px-2 py-0.5 rounded-brand border border-border-soft text-text-hint">
            {t("connect_embedded_soon")}
          </span>
        </div>
        <p className="text-xs text-text-hint">{t("connect_embedded_note")}</p>
        <button
          type="button"
          disabled={!EMBEDDED_DAPP_BROWSER_ENABLED}
          aria-disabled={!EMBEDDED_DAPP_BROWSER_ENABLED}
          className="w-full mt-1 p-2.5 rounded-brand border border-border-soft bg-bg1 text-sm text-text-hint cursor-not-allowed disabled:opacity-60"
        >
          {t("connect_embedded_open")}
        </button>
      </div>
    </div>
  );
}
