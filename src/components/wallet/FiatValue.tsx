"use client";

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  fetchAdaPrice,
  forgetPrice,
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
 * The currency this reader last chose, or `off` if they have not chosen.
 *
 * **Off until asked for.** The price service is this module's only outbound host
 * that is not a chain indexer, and it is a third party. Defaulting it on would
 * mean that opening the wallet for the first time sends a request to that host
 * from the reader's address — at the same moment, from the same address, as the
 * indexer requests carrying their addresses — for a convenience nobody asked
 * for. In the extension it matters more, not less: the host permission is
 * granted at install time, so there is no second prompt to notice.
 *
 * (An earlier draft justified this by analogy with the network selector
 * "defaulting to the testnet". That analogy was wrong and is recorded here so
 * nobody restores it: that picker never chooses between mainnet and a testnet —
 * it only runs once the extension has already reported network id 0, to
 * separate preprod from preview, which CIP-30 genuinely cannot distinguish. It
 * disambiguates two equally safe options; it is not a safe default against an
 * unsafe one. The argument above stands on its own and does not need it.)
 *
 * Once chosen, the choice is remembered, and it is remembered per browser — the
 * request itself carries nothing but `cardano` and a currency code.
 *
 * The language is still used, but to pick the *sensible* currency rather than
 * to decide whether to ask at all: a Vietnamese reader converting đồng in their
 * head from a dollar figure, at a rate they have to guess, is being handed
 * arithmetic instead of an answer.
 */
function preferredCurrency(language: string): FiatCurrency {
  const lang = language.slice(0, 2);
  if (lang === "vi") return "vnd";
  if (lang === "ja") return "jpy";
  return "usd";
}

function initialChoice(): Choice {
  // Reading `window.localStorage` *throws* — it does not return null — when the
  // browser is set to block site data, and Firefox's "block cookies" does
  // exactly that. Unguarded, and called during render as it is, that exception
  // takes down the whole subtree: the balance screen goes blank because the
  // reader declined a cookie.
  try {
    if (typeof window === "undefined") return OFF;
    const saved = window.localStorage.getItem(STORE_KEY);
    if ((FIAT_CURRENCIES as readonly string[]).includes(saved ?? "")) return saved as FiatCurrency;
  } catch {
    /* no stored choice is readable; fall through to off */
  }
  return OFF;
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
  const [choice, setChoice] = useState<Choice>(initialChoice);
  const [price, setPrice] = useState<AdaPrice | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (choice === OFF) {
      setPrice(null);
      setFailed(false);
      // Drop the cached rate too. Off has to mean the module is holding nothing
      // from the price service, not merely that one component stopped drawing
      // it — otherwise switching back inside the cache window shows a figure
      // that was fetched before the reader turned it on again.
      forgetPrice();
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
    // `lovelace` is a dependency because the figure shown is the rate applied to
    // it: a balance refreshed hours later against a rate read this morning is a
    // stale conversion, and this component's own contract is that it never shows
    // one. The sixty-second cache in `price.ts` keeps that from meaning a
    // request per refresh.
  }, [choice, lovelace]);

  const choose = (next: Choice) => {
    setChoice(next);
    try {
      if (typeof window !== "undefined") window.localStorage.setItem(STORE_KEY, next);
    } catch {
      // Storage blocked: the choice holds for this visit and is asked again
      // next time. Not being able to remember it is not a reason to fail it.
    }
  };

  // The currency this reader most likely wants sits at the top of the list, so
  // turning the line on is one choice rather than a hunt through four codes.
  const preferred = preferredCurrency(i18n.language);
  const ordered = [preferred, ...FIAT_CURRENCIES.filter((c) => c !== preferred)];

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
        {/* Off is first because it is the state the wallet starts in. */}
        <option value={OFF}>{t("fiat_off")}</option>
        {ordered.map((c) => (
          <option key={c} value={c}>
            {c.toUpperCase()}
          </option>
        ))}
      </select>
    </div>
  );
}
