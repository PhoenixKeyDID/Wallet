"use client";

import { useTranslation } from "react-i18next";
import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Footer";
import { DevWarningBanner } from "@/components/wallet/DevWarningBanner";
import { WalletHub } from "@/components/wallet/WalletHub";

export default function WalletPage() {
  const { t } = useTranslation("wallet");
  return (
    <>
      <Nav />
      <main className="flex-1 mx-auto max-w-2xl w-full px-4 py-8 space-y-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold">{t("page_title")}</h1>
          <p className="text-sm text-text-dim">{t("page_subtitle")}</p>
        </header>
        <DevWarningBanner />
        {/*
          Example page — no session here, so the Phoenix custody tab shows
          "sign in first". The host renders this with its own DID, e.g.
          `<WalletHub did={getSessionMeta()?.userDid} />`; the backend only
          serves the caller's own wallet (PhoenixKey-Database#116).
        */}
        <WalletHub />
      </main>
      <Footer />
    </>
  );
}
