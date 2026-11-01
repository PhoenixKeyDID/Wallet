// @vitest-environment happy-dom
/**
 * What the opening screen says depends on where it runs.
 *
 * The long risk paragraph and the intro were written for a web page: "no
 * extension needed", "everywhere else your key stays inside an extension — here
 * it does". Inside the extension popup every one of those sentences is false,
 * and together they filled half of a 600px window above the fold. These tests
 * read the rendered text in both contexts, and the test-network reminder.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import i18next from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import en from "../../../../locales/en/wallet.json";
import viLocale from "../../../../locales/vi/wallet.json";

const ctx = vi.hoisted(() => ({ ext: false }));
vi.mock("@/lib/keystore/storage", async (orig) => {
  const real = await orig<typeof import("@/lib/keystore/storage")>();
  return {
    ...real,
    isExtensionContext: () => ctx.ext,
    vaultStore: () => ({
      list: async () => [],
      get: async () => undefined,
      put: async () => {},
      remove: async () => {},
    }),
  };
});

import { LocalWalletPanel } from "../LocalWalletPanel";
import { TestnetBadge } from "../TestnetBadge";

async function makeI18n(lng: "en" | "vi") {
  const i = i18next.createInstance();
  await i.use(initReactI18next).init({
    lng,
    defaultNS: "wallet",
    ns: ["wallet"],
    resources: { en: { wallet: en }, vi: { wallet: viLocale } },
    interpolation: { escapeValue: false },
  });
  return i;
}

afterEach(cleanup);

async function openingText(ext: boolean, lng: "en" | "vi" = "en") {
  ctx.ext = ext;
  const i = await makeI18n(lng);
  const { container } = render(
    <I18nextProvider i18n={i}>
      <LocalWalletPanel />
    </I18nextProvider>,
  );
  return container.textContent ?? "";
}

describe("opening screen by context", () => {
  it("in the extension, none of the web-page sentences appear", async () => {
    const text = await openingText(true);
    expect(text).not.toContain("no extension needed");
    expect(text).not.toContain("Everywhere else in this wallet");
    expect(text).not.toContain("You are on a web page");
    expect(text).toContain(en.local_risk_ext);
    expect(text).toContain(en.local_intro_ext);
  });

  it("in the extension, the Vietnamese screen says the right thing too", async () => {
    const text = await openingText(true, "vi");
    expect(text).toContain(viLocale.local_risk_ext);
    expect(text).not.toContain(viLocale.local_risk_body);
  });

  it("on a web page, the full explanation is still there", async () => {
    const text = await openingText(false);
    expect(text).toContain(en.local_risk_body);
    expect(text).toContain(en.local_risk_web);
    expect(text).toContain(en.local_intro);
    expect(text).not.toContain(en.local_risk_ext);
  });

  it("explains the test networks in Vietnamese in the picker", async () => {
    const text = await openingText(true, "vi");
    expect(text).toContain("Mạng thử Preprod — ADA không có giá trị");
    expect(text).toContain("Mạng thử Preview");
  });
});

describe("test-network reminder", () => {
  async function badge(network: 0 | 1 | 2) {
    const i = await makeI18n("vi");
    return render(
      <I18nextProvider i18n={i}>
        <TestnetBadge network={network} />
      </I18nextProvider>,
    ).container.textContent;
  }
  it("shows on Preprod and Preview, in plain words", async () => {
    expect(await badge(0)).toBe("Mạng thử Preprod — ADA ở đây không có giá trị thật");
    expect(await badge(2)).toBe("Mạng thử Preview — ADA ở đây không có giá trị thật");
  });
  it("is absent on mainnet", async () => {
    expect(await badge(1)).toBe("");
  });
});
