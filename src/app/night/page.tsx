"use client";

import { useTranslation } from "react-i18next";
import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Footer";
import { NightRedeem } from "@/components/night/NightRedeem";

export default function NightPage() {
  const { t } = useTranslation("night");
  return (
    <>
      <Nav />
      <main className="flex-1 mx-auto max-w-2xl w-full px-4 py-8 space-y-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <span aria-hidden>🌙</span> {t("page_title")}
          </h1>
          <p className="text-sm text-text-dim">{t("page_subtitle")}</p>
        </header>
        <NightRedeem />
      </main>
      <Footer />
    </>
  );
}
