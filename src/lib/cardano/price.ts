/**
 * What a balance is worth in ordinary money.
 *
 * This is the module's **second** outbound host, and the first that is not a
 * chain indexer, so the reasoning is written down rather than assumed.
 *
 * A price cannot be derived from the chain — it is what someone elsewhere is
 * paying — so showing one means asking a third party, and that party sees a
 * request from each user. The request carries nothing about the wallet: the
 * literal string `cardano` and a currency code. The price of ADA does not
 * depend on who is asking, so there is nothing to leak in the question itself;
 * what is exposed is an IP and the fact that somebody asked. Smaller than the
 * indexer, which necessarily sees the addresses. Not nothing, which is why the
 * fiat line can be switched off and says where the number came from.
 *
 * **A rate is a reading, not a quote.** It was true at a moment, at one venue,
 * and it is not what anyone will actually pay. So every figure this module
 * produces carries the moment it was read, and the UI shows it — a fiat number
 * with no timestamp invites someone to treat it as their balance.
 *
 * And a price that cannot be read shows **nothing**, never a stale or zero
 * figure. A wallet reporting "$0.00" because a request failed is the silent
 * shell this repo has paid for before: the person reads a wrong fact about
 * their own money with no sign that anything went wrong.
 */
import { PRICE_BASE } from "./provider";
import { assertNoRedirect } from "./blockfrost";

/** Currencies offered. One per shipped locale, plus USD as the common ground. */
export const FIAT_CURRENCIES = ["usd", "vnd", "eur", "jpy"] as const;
export type FiatCurrency = (typeof FIAT_CURRENCIES)[number];

export type AdaPrice = {
  currency: FiatCurrency;
  /** Units of `currency` per 1 ADA. */
  rate: number;
  /** When this reading was taken, milliseconds since the epoch. */
  atMs: number;
};

export class PriceError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "PriceError";
  }
}

/**
 * Bounds that turn a garbage response into a refusal.
 *
 * Not a claim about what ADA is worth — the range is absurdly wide on purpose,
 * and a genuine market move will never reach either end. It exists to catch the
 * shapes an API returns when something is wrong and it does not say so: `0`,
 * `null` coerced to zero, a negative, a NaN, or a figure so large it is plainly
 * a different unit. Each of those, shown as a balance, is a wrong number about
 * the reader's own money.
 *
 * The upper bound is generous because currencies differ by orders of magnitude:
 * 1 ADA is a fraction of a dollar and several thousand đồng.
 */
const RATE_MIN = 1e-9;
const RATE_MAX = 1e9;

/**
 * Turn one row of the price API into a checked reading.
 *
 * Exported for the tests, which pin the refusals against fixtures rather than
 * against a live market that cannot be made to misbehave on demand.
 */
export function readPrice(body: unknown, currency: FiatCurrency, atMs: number): AdaPrice {
  const row = (body as { cardano?: Record<string, unknown> } | null)?.cardano;
  if (!row || typeof row !== "object") {
    throw new PriceError("the price service returned no figure for ADA");
  }
  const raw = row[currency];
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < RATE_MIN || raw > RATE_MAX) {
    throw new PriceError(`the price service returned an implausible rate: ${String(raw)}`);
  }
  return { currency, rate: raw, atMs };
}

/**
 * The most recent reading, kept for a minute.
 *
 * Two reasons, and the second is the one that would otherwise bite. Remounting
 * a panel must not re-ask — the free tier this uses rate-limits, and a wallet
 * that trips that limit shows nothing exactly when the user is looking hardest.
 * And every avoided request is one fewer visit recorded at the other end, which
 * is the whole reason this file argues with itself above.
 */
const TTL_MS = 60_000;
let cached: AdaPrice | null = null;

/**
 * Drop the cached reading.
 *
 * Called when the reader switches the fiat line off, so that "off" means the
 * module is holding nothing from the price service rather than merely that one
 * component stopped drawing it. Also used by the tests.
 */
export function forgetPrice(): void {
  cached = null;
}

export async function fetchAdaPrice(currency: FiatCurrency, nowMs = Date.now()): Promise<AdaPrice> {
  // `0 <= age < TTL`, not `age < TTL`. A clock that moves backwards — a manual
  // change, an NTP correction, a laptop waking in another timezone — makes the
  // age negative, and the naive comparison then holds the same reading until
  // the clock catches up, printing an old rate next to a timestamp that says it
  // is from the future.
  if (cached && cached.currency === currency) {
    const age = nowMs - cached.atMs;
    if (age >= 0 && age < TTL_MS) return cached;
  }

  const res = await fetch(`${PRICE_BASE}/simple/price?ids=cardano&vs_currencies=${currency}`, {
    headers: { accept: "application/json" },
    // The chain calls refuse a redirect because a screen names their host. This
    // one is named in a different place and just as publicly: the README says
    // the indexer and the price service "are the only hosts this wallet
    // contacts". A followed redirect makes that sentence false, and it does so
    // where nobody would look — the price arrives, the number is plausible, and
    // the third party seeing each user's IP is one nobody listed.
    //
    // Cheap to refuse, unlike the backend path: a price that cannot be fetched
    // is an ordinary outcome here, already handled — the fiat line says where
    // the number came from or says there is none, and the wallet is fully
    // usable without it.
    redirect: "manual",
  });
  assertNoRedirect(res, "/simple/price", PRICE_BASE);
  // A rate limit is the expected failure on a free, key-less tier, and it is not
  // a different kind of event from any other refusal: in both cases there is no
  // price, and the screen must say so rather than reuse an old one.
  if (!res.ok) throw new PriceError(`the price service answered HTTP ${res.status}`);
  const price = readPrice(await res.json(), currency, nowMs);
  cached = price;
  return price;
}

/**
 * Lovelace → a fiat string, in the reader's locale.
 *
 * Rounded to the currency's own precision by `Intl`, which knows that the yen
 * and the đồng have no minor unit while the dollar has two. Hard-coding two
 * decimals would print `5.680,07 ₫` for a figure the locale writes as `5.680 ₫`.
 */
export function formatFiat(lovelace: bigint, price: AdaPrice, locale: string): string {
  // Through Number, not BigInt arithmetic: a rate is a float, and the result is
  // a display figure whose last digit nobody acts on. The ADA amount beside it
  // stays exact, which is the number that matters.
  const ada = Number(lovelace) / 1e6;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: price.currency.toUpperCase(),
  }).format(ada * price.rate);
}
