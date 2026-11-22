// @vitest-environment happy-dom
/**
 * A connected browser wallet's balance card, between connecting and the first
 * balance read coming back.
 *
 * `connect` shows the wallet as soon as it answers, then reads the balance —
 * seconds, on a slow wallet. Until that read lands the figures are the zero it
 * reset them to, and "0 ADA" in large type is what an empty wallet shows. So
 * the card shows a dash and no fiat line until the read is in.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import i18next from "i18next";
import type { ReactElement } from "react";
import { I18nextProvider, initReactI18next } from "react-i18next";
import en from "../../../../locales/en/wallet.json";

const ctx = vi.hoisted(() => ({
  /** When set, the balance read waits for this. */
  balanceGate: null as Promise<void> | null,
  lovelace: BigInt(12_345_678),
}));

vi.mock("@/lib/cardano", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  const api = {
    getNetworkId: async () => 0,
    getChangeAddress: async () => "00",
  };
  return {
    ...real,
    listWallets: () => [{ key: "slowwallet", name: "Slow", icon: "", apiVersion: "1" }],
    enableWallet: async () => api,
    readBalance: async () => {
      if (ctx.balanceGate) await ctx.balanceGate;
      return { lovelace: ctx.lovelace, assets: [] };
    },
    cip30Port: () => ({ kind: "cip30" }),
  };
});
// The feature tabs below the card are not what this file is about.
vi.mock("../WalletTabs", () => ({ WalletTabs: () => null }));

import { Cip30Panel } from "../Cip30Panel";
import { UNREAD_FIGURE } from "../moneyNotice";

afterEach(() => {
  cleanup();
  ctx.balanceGate = null;
});

async function renderWithI18n(node: ReactElement) {
  const i = i18next.createInstance();
  await i.use(initReactI18next).init({
    lng: "en",
    defaultNS: "wallet",
    ns: ["wallet"],
    resources: { en: { wallet: en } },
    interpolation: { escapeValue: false },
  });
  return render(<I18nextProvider i18n={i}>{node}</I18nextProvider>);
}

// A zero standing alone as a number (see LocalWalletPanel.popup.test.tsx).
const ZERO_FIGURE = /(?<![\d.,])0(?![\d.,])/;

describe("Cip30Panel: the balance card before the first read", () => {
  it("shows a dash, not 0 ADA, while the balance read has not come back", async () => {
    let release!: () => void;
    ctx.balanceGate = new Promise<void>((r) => (release = r));
    const view = await renderWithI18n(<Cip30Panel />);
    fireEvent.click(await screen.findByText("Slow"));
    await screen.findByText(en.disconnect);
    const text = () => view.container.textContent ?? "";
    // The figure follows the card's label: "Balance— ADA", not "Balance0 ADA".
    // (The test-network note further down carries a dash of its own, so the
    // dash is looked for right after the label, not anywhere on the card.)
    expect(text()).toContain(`${en.balance_label}${UNREAD_FIGURE}`);
    expect(text()).not.toMatch(new RegExp(`${en.balance_label}${ZERO_FIGURE.source}\\s*ADA`));
    release();
    await screen.findByText(/12\.345678/);
    expect(text()).not.toContain(`${en.balance_label}${UNREAD_FIGURE}`);
  });
});
