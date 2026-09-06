"use client";

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  fetchAdaPrice,
  formatFiat,
  FIAT_CURRENCIES,
  type AdaPrice,
  type FiatCurrency,
} from "@/lib/cardano/price";

const STORE_KEY = "phoenix.fiatCurrency";
/** The one value that means "do not contact the price service at all". */
const OFF = "off" as const;
type Choice = FiatCurrency | typeof OFF;

/**
 * Which currency to show, remembered across visits.
 *
 * The default follows the interface language rather than being USD for
 * everyone: a Vietnamese reader converting đồng in their head, from a dollar
 * figure, at a rate they have to guess, is being handed arithmetic instead of
 * an answer. `off` is a real option and it is honoured before any request is
 * made — a switch that stops the display but still asks the third party would
 * be a switch that lies.
 */
function initialChoice(language: string): Choice {
  if (typeof window !== "undefined") {
    const saved = window.localStorage.getItem(STORE_KEY);
    if (saved === OFF) return OFF;
    if ((FIAT_CURRENCIES as readonly string[]).includes(saved ?? "")) return saved as FiatCurrency;
  }
  const lang = language.slice(0, 2);
  if (lang === "vi") return "vnd";
  if (lang === "ja") return "jpy";
  return "usd";
}

/**
 * A balance in ordinary money, under the ADA figure.
 *
 * Three things it will not do, each of which a fiat line commonly does:
 *
 * 1. **It never shows a stale number.** When a reading cannot be taken, the
 *    line says so. A wallet quietly reusing yesterday's rate — or printing
 *    `0.00` because a request failed — states a wrong fact about the reader's
 *    own money with nothing on screen to question.
 * 2. **It never presents itself as the balance.** The ADA figure above is what
 *    the wallet holds; this is what someone was paying for it at a moment,
 *    which is why the moment is printed next to it.
 * 3. **It never asks when switched off.** See `initialChoice`.
 */
export function FiatValue({ lovelace }: { lovelace: bigint }) {
  const { t, i18n } = useTranslation("wallet");
  const [choice, setChoice] = useState<Choice>(() => initialChoice(i18n.language));
  const [price, setPrice] = useState<AdaPrice | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (choice === OFF) {
      setPrice(null);
      setFailed(false);
      return;
    }
    let live = true;
    setFailed(false);
    fetchAdaPrice(choice)
      .then((p) => {
        if (live) setPrice(p);
      })
      .catch(() => {
        // Deliberately not a toast: a price is supplementary, and a popup over
        // a wallet screen for it would train people to dismiss popups that are
        // about their funds. The line below carries the failure instead.
        if (live) {
          setPrice(null);
          setFailed(true);
        }
      });
    return () => {
      live = false;
    };
  }, [choice]);

  const choose = (next: Choice) => {
    setChoice(next);
    if (typeof window !== "undefined") window.localStorage.setItem(STORE_KEY, next);
  };

  return (
    <div className="flex flex-wrap items-baseline gap-2 text-xs">
      {choice !== OFF && price && (
        <>
          <span className="mono text-text-dim">≈ {formatFiat(lovelace, price, i18n.language)}</span>
          <span className="text-text-hint">
            {t("fiat_as_of", { time: new Date(price.atMs).toLocaleTimeString(i18n.language) })}
          </span>
        </>
      )}
      {choice !== OFF && !price && (
        <span className="text-text-hint">{failed ? t("fiat_unavailable") : t("loading")}</span>
      )}
      <select
        value={choice}
        onChange={(e) => choose(e.target.value as Choice)}
        aria-label={t("fiat_currency_label")}
        className="rounded-brand-sm border border-border-soft bg-bg0 px-1.5 py-0.5 text-text-hint"
      >
        {FIAT_CURRENCIES.map((c) => (
          <option key={c} value={c}>
            {c.toUpperCase()}
          </option>
        ))}
        <option value={OFF}>{t("fiat_off")}</option>
      </select>
    </div>
  );
}
