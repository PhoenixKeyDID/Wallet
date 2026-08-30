/**
 * i18n for the popup.
 *
 * The locale JSON is imported, not fetched: the manifest's CSP forbids remote
 * code, and a wallet that has to reach the network before it can render an
 * error message is a wallet that says nothing when the network is the problem.
 *
 * Language follows the browser. Falls back to English rather than showing raw
 * keys, because a user who sees `vault_bad_password` learns nothing.
 */
import i18next from "i18next";
import { initReactI18next } from "react-i18next";

import en from "../../locales/en/wallet.json";
import vi from "../../locales/vi/wallet.json";
import ja from "../../locales/ja/wallet.json";
import zh from "../../locales/zh/wallet.json";

const SUPPORTED = ["en", "vi", "ja", "zh"] as const;

function pickLanguage(): string {
  const want = (navigator.language || "en").toLowerCase();
  return SUPPORTED.find((l) => want.startsWith(l)) ?? "en";
}

void i18next.use(initReactI18next).init({
  lng: pickLanguage(),
  fallbackLng: "en",
  defaultNS: "wallet",
  ns: ["wallet"],
  resources: {
    en: { wallet: en },
    vi: { wallet: vi },
    ja: { wallet: ja },
    zh: { wallet: zh },
  },
  interpolation: { escapeValue: false },
});

export const i18n = i18next;
