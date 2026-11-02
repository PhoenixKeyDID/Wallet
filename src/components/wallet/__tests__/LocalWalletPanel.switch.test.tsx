// @vitest-environment happy-dom
/**
 * "Switch account" opens on the next account, not the one already open.
 *
 * The form used to open pre-filled with the current index, so the obvious
 * press — type the password, confirm — re-derived the account already on
 * screen and looked like the switch had done nothing. The rule itself
 * (`nextAccountIndex`) has its own test; this one pins that the form uses it.
 *
 * The keystore is replaced: what is under test is which number the form
 * starts at, not Argon2id or BIP-32. The overrides stay untyped, because a
 * typed keystore import in this file would widen check:keystore-boundary.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import i18next from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import en from "../../../../locales/en/wallet.json";

// Hoisted: the mock factories below run before ordinary top-level constants.
const { OPEN_INDEX, ADDRESS } = vi.hoisted(() => ({
  OPEN_INDEX: 3,
  ADDRESS: "addr_test1qtestaddressforswitchform",
}));

vi.mock("@/lib/keystore/storage", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  const wallet = {
    id: "w1",
    label: "Test wallet",
    vault: {},
    firstAddress: ADDRESS,
    network: 0,
    createdAt: "2026-11-02T00:00:00.000Z",
    accountIndex: OPEN_INDEX,
  };
  return {
    ...real,
    isExtensionContext: () => false,
    vaultStore: () => ({
      list: async () => [wallet],
      get: async () => wallet,
      put: async () => {},
      remove: async () => {},
    }),
  };
});
vi.mock("@/lib/keystore", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    openVault: async () => new Uint8Array(16),
    accountFromEntropy: async (_e: Uint8Array, index: number, network: number) => ({
      index,
      network,
      external: [{ address: ADDRESS }],
      internal: [],
      wipe: () => {},
    }),
    primaryAddress: () => ADDRESS,
    allAddresses: () => [ADDRESS],
    localPort: () => ({ kind: "local" }),
    // Never resolves: the feature tabs stay unmounted, which keeps this test
    // about the account row and nothing below it.
    changeAddressHexFor: () => new Promise<string>(() => {}),
  };
});
vi.mock("@/lib/cardano", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, fetchAddressBalance: async () => ({ lovelace: BigInt(0), assets: [] }) };
});

import { LocalWalletPanel } from "../LocalWalletPanel";

afterEach(cleanup);

async function openWallet() {
  const i = i18next.createInstance();
  await i.use(initReactI18next).init({
    lng: "en",
    defaultNS: "wallet",
    ns: ["wallet"],
    resources: { en: { wallet: en } },
    interpolation: { escapeValue: false },
  });
  const view = render(
    <I18nextProvider i18n={i}>
      <LocalWalletPanel />
    </I18nextProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: en.local_unlock_cta }));
  const pw = await waitFor(() => {
    const el = view.container.querySelector('input[type="password"]');
    expect(el).not.toBeNull();
    return el as HTMLInputElement;
  });
  fireEvent.change(pw, { target: { value: "correct horse battery staple" } });
  fireEvent.click(screen.getByRole("button", { name: en.local_unlock_cta }));
  await screen.findByRole("button", { name: en.local_account_switch });
  return view;
}

describe("switch account form", () => {
  it("is on the account the wallet was left on", async () => {
    const view = await openWallet();
    expect(view.container.textContent).toContain(`m/1852'/1815'/${OPEN_INDEX}'`);
  });

  it("opens on the next account, not the one already open", async () => {
    const view = await openWallet();
    fireEvent.click(screen.getByRole("button", { name: en.local_account_switch }));
    const index = await waitFor(() => {
      const el = view.container.querySelector('input[type="number"]');
      expect(el).not.toBeNull();
      return el as HTMLInputElement;
    });
    expect(index.value).toBe(String(OPEN_INDEX + 1));
  });
});
