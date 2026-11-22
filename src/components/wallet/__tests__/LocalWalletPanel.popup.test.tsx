// @vitest-environment happy-dom
/**
 * The extension popup's frame (`layout="popup"`).
 *
 * The frame is new; what it frames is not. So these cases pin the two things a
 * redesign can lose without any type error: the warnings still reach the
 * screen (collapsed is allowed, gone is not), and the controls that end a
 * session still end it — Lock in the top bar drops the keys and the password,
 * and switching to another saved wallet locks the open one first.
 *
 * The keystore is replaced as in `LocalWalletPanel.switch.test.tsx`; the
 * overrides stay untyped so this file does not widen check:keystore-boundary.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import i18next from "i18next";
import type { ReactElement } from "react";
import { I18nextProvider, initReactI18next } from "react-i18next";
import en from "../../../../locales/en/wallet.json";

const ctx = vi.hoisted(() => ({
  wallets: [] as Record<string, unknown>[],
  /** The balance read fails instead of answering. */
  balanceFails: false,
  /** What the balance read answers. */
  lovelace: BigInt(12_345_678),
  /** How many times a vault was opened (an Argon2id run in the real one). */
  opens: 0,
  ADDRESS: "addr_test1qpopupframeaddress0000000000000000000000000000000000000000000",
}));

vi.mock("@/lib/keystore/storage", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    isExtensionContext: () => true,
    vaultStore: () => ({
      list: async () => ctx.wallets,
      get: async (id: string) => ctx.wallets.find((w) => w.id === id),
      put: async () => {},
      remove: async () => {},
    }),
  };
});
vi.mock("@/lib/keystore", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    openVault: async () => {
      ctx.opens += 1;
      return new Uint8Array(16);
    },
    accountFromEntropy: async (_e: Uint8Array, index: number, network: number) => ({
      index,
      network,
      external: [{ address: ctx.ADDRESS }],
      internal: [],
      wipe: () => {},
    }),
    primaryAddress: () => ctx.ADDRESS,
    allAddresses: () => [ctx.ADDRESS],
    localPort: () => ({ kind: "local" }),
    // Never resolves: the feature panels stay unmounted, so these cases are
    // about the frame and not about Send or Staking.
    changeAddressHexFor: () => new Promise<string>(() => {}),
  };
});
vi.mock("@/lib/cardano", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    fetchAddressBalance: async () => {
      if (ctx.balanceFails) throw new Error("indexer unreachable");
      return { lovelace: ctx.lovelace, assets: [] };
    },
  };
});

import { LocalWalletPanel } from "../LocalWalletPanel";
import { BalanceView } from "../BalanceView";
import { NOTICES_STALE_EVENT, UNREAD_FIGURE } from "../moneyNotice";

afterEach(() => {
  cleanup();
  ctx.wallets = [];
  ctx.balanceFails = false;
  ctx.lovelace = BigInt(12_345_678);
  ctx.opens = 0;
});

const wallet = (id: string, label: string) => ({
  id,
  label,
  vault: {},
  firstAddress: ctx.ADDRESS,
  network: 0,
  createdAt: "2026-11-22T00:00:00.000Z",
  accountIndex: 0,
});

// Every render gets its own i18n instance: a component rendered without one
// reads whatever instance an earlier test happened to leave behind, so the
// same test passes in the file and fails run on its own (`-t`).
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

function renderPopup() {
  return renderWithI18n(<LocalWalletPanel layout="popup" />);
}

async function unlockFirst() {
  const view = await renderPopup();
  const pw = (await screen.findByLabelText(en.local_password)) as HTMLInputElement;
  fireEvent.change(pw, { target: { value: "correct horse battery staple" } });
  fireEvent.click(screen.getByRole("button", { name: en.local_unlock_cta }));
  await screen.findByRole("button", { name: en.local_lock_cta });
  return view;
}

describe("popup: before any wallet exists", () => {
  it("is a welcome screen with the two ways in", async () => {
    await renderPopup();
    expect(await screen.findByText(en.popup_welcome_title)).toBeTruthy();
    expect(screen.getByRole("button", { name: en.local_create_cta })).toBeTruthy();
    expect(screen.getByRole("button", { name: en.local_restore_cta })).toBeTruthy();
  });

  it("keeps the whole risk statement on screen, folded under a one-line summary", async () => {
    const view = await renderPopup();
    await screen.findByText(en.popup_welcome_title);
    const text = view.container.textContent ?? "";
    expect(text).toContain(en.popup_risk_summary);
    expect(text).toContain(en.local_risk_ext);
    expect(text).toContain(en.popup_footer);
    // The web page's sentences are false inside the extension.
    expect(text).not.toContain(en.local_risk_body);
  });

  it("has no Lock button and no tab bar while nothing is unlocked", async () => {
    const view = await renderPopup();
    await screen.findByText(en.popup_welcome_title);
    expect(screen.queryByRole("button", { name: en.local_lock_cta })).toBeNull();
    expect(view.container.querySelector("nav")).toBeNull();
  });
});

describe("popup: an open wallet", () => {
  it("shows the balance large, the four actions and the bottom tabs — and not the page's tab row", async () => {
    ctx.wallets = [wallet("w1", "Daily")];
    const view = await unlockFirst();
    await screen.findByText("12.345678", { exact: false });
    for (const name of [en.tab_send, en.tab_receive, en.tab_staking, en.tab_history]) {
      expect(screen.getAllByRole("button", { name }).length).toBeGreaterThan(0);
    }
    const nav = view.container.querySelector("nav");
    expect(nav?.textContent).toContain(en.popup_nav_home);
    expect(nav?.textContent).toContain(en.popup_nav_settings);
    // The page layout's tab row carries an emoji per tab; the popup draws its own.
    expect(view.container.textContent).not.toContain("📤");
    // Still preparing (the change address never resolves here): the actions
    // that would open a money form are not pressable yet.
    expect((screen.getByRole("button", { name: en.tab_send }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("Lock in the top bar drops back to the unlock screen with an empty password", async () => {
    ctx.wallets = [wallet("w1", "Daily")];
    await unlockFirst();
    fireEvent.click(screen.getByRole("button", { name: en.local_lock_cta }));
    const pw = (await screen.findByLabelText(en.local_password)) as HTMLInputElement;
    expect(pw.value).toBe("");
    expect(screen.queryByRole("button", { name: en.local_lock_cta })).toBeNull();
  });

  it("Settings holds the account switch, auto-lock and the password-gated phrase reveal", async () => {
    ctx.wallets = [wallet("w1", "Daily")];
    const view = await unlockFirst();
    fireEvent.click(screen.getAllByRole("button", { name: en.popup_nav_settings })[0]!);
    expect(await screen.findByRole("button", { name: en.local_account_switch })).toBeTruthy();
    expect(view.container.textContent).toContain(en.local_autolock_label);
    expect(view.container.textContent).toContain(en.local_reveal_warning);
    const reveal = screen.getByRole("button", { name: en.local_show_phrase }) as HTMLButtonElement;
    expect(reveal.disabled).toBe(true);
    // The full warning lives here too, not only behind "Learn more".
    expect(view.container.textContent).toContain(en.local_risk_ext);
  });

  it("switching to another saved wallet locks the open one before asking for a password", async () => {
    ctx.wallets = [wallet("w1", "Daily"), wallet("w2", "Savings")];
    await unlockFirst();
    fireEvent.click(screen.getAllByRole("button", { name: en.popup_nav_settings })[0]!);
    fireEvent.click(await screen.findByRole("button", { name: en.popup_wallet_switch }));
    await waitFor(() => expect(screen.queryByRole("button", { name: en.local_lock_cta })).toBeNull());
    const select = (await screen.findByLabelText(en.popup_choose_wallet)) as HTMLSelectElement;
    expect(select.value).toBe("w2");
    expect((screen.getByLabelText(en.local_password) as HTMLInputElement).value).toBe("");
  });
});

// A zero standing alone as a number. Not `/\b0\b/`: text content runs a
// label into the figure ("Balance0 ADA"), and a letter before the 0 is no word
// boundary — so that pattern would miss a made-up "0 ADA" as easily as a real one.
const ZERO_FIGURE = /(?<![\d.,])0(?![\d.,])/;

describe("popup: what it does not make up", () => {
  it("shows a dash, not 0 ADA, while the balance has not been read", async () => {
    // "0 ADA" in large type over "Balance not read" is a number the page made
    // up for data it never got.
    ctx.wallets = [wallet("w1", "Daily")];
    ctx.balanceFails = true;
    const view = await unlockFirst();
    await screen.findByText(en.local_balance_unavailable, { exact: false });
    const figure = view.container.querySelector(".pw-balance-figure")!;
    expect(figure.getAttribute("data-settled")).toBe("false");
    expect(figure.textContent).toContain(UNREAD_FIGURE);
    expect(figure.textContent).not.toMatch(ZERO_FIGURE);
  });

  it("the page's balance card does the same", async () => {
    const unread = await renderWithI18n(<BalanceView lovelace={BigInt(0)} assets={[]} network={0} settled={false} />);
    // The figure itself: the test-network note under it has a dash of its own.
    const unreadFigure = unread.container.querySelector("[data-settled]")!;
    expect(unreadFigure.getAttribute("data-settled")).toBe("false");
    expect(unreadFigure.textContent).toContain(UNREAD_FIGURE);
    expect(unreadFigure.textContent).not.toMatch(ZERO_FIGURE);
    cleanup();
    // Unchanged for a balance that was read: zero read is zero.
    const read = await renderWithI18n(<BalanceView lovelace={BigInt(0)} assets={[]} network={0} />);
    const readFigure = read.container.querySelector("[data-settled]")!;
    expect(readFigure.getAttribute("data-settled")).toBe("true");
    expect(readFigure.textContent).toMatch(ZERO_FIGURE);
    expect(readFigure.textContent).not.toContain(UNREAD_FIGURE);
  });

  it("marks the open wallet in Saved wallets as open, with no button to open it again", async () => {
    ctx.wallets = [wallet("w1", "Daily"), wallet("w2", "Savings")];
    await unlockFirst();
    fireEvent.click(screen.getAllByRole("button", { name: en.popup_nav_settings })[0]!);
    const current = await screen.findByText(en.popup_wallet_current);
    expect(current.tagName).not.toBe("BUTTON");
    expect(current.closest("button")).toBeNull();
    expect(current.getAttribute("aria-current")).toBe("true");
    // One switch button: for the wallet that is not open.
    expect(screen.getAllByRole("button", { name: en.popup_wallet_switch })).toHaveLength(1);
  });

  it("tells the host its notices are stale on a right password and on a lock", async () => {
    // The extension clears its banners on this; without it a failed-password
    // banner stayed over the open wallet and a balance error over the next
    // unlock screen.
    let fired = 0;
    const count = () => (fired += 1);
    window.addEventListener(NOTICES_STALE_EVENT, count);
    try {
      ctx.wallets = [wallet("w1", "Daily")];
      await unlockFirst();
      expect(fired).toBe(1);
      fireEvent.click(screen.getByRole("button", { name: en.local_lock_cta }));
      await screen.findByLabelText(en.local_password);
      expect(fired).toBe(2);
    } finally {
      window.removeEventListener(NOTICES_STALE_EVENT, count);
    }
  });
});

describe("popup: choosing a password", () => {
  // The public BIP-39 test vector; nothing in this file derives a real key from it.
  const VECTOR =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  const FIRST = "TestPopup-2026!";

  async function reachPasswordStep() {
    await renderPopup();
    fireEvent.click(await screen.findByRole("button", { name: en.local_restore_cta }));
    fireEvent.change(await screen.findByPlaceholderText(en.local_restore_placeholder), {
      target: { value: VECTOR },
    });
    fireEvent.click(screen.getByRole("button", { name: en.local_words_next }));
    // Another field on the page is also labelled with the password key; read the
    // two fields from the card that chooses the password.
    const card = within((await screen.findByRole("heading", { name: en.local_password_title })).parentElement!);
    fireEvent.change(card.getByLabelText(en.local_password), { target: { value: FIRST } });
    return card.getByLabelText(en.local_password_again);
  }

  it("says why Save is disabled once the second password has gone a different way", async () => {
    const again = await reachPasswordStep();
    const save = () => screen.getByRole("button", { name: en.local_save_cta }) as HTMLButtonElement;

    // Half typed: still a prefix of the first, so no complaint yet.
    fireEvent.change(again, { target: { value: FIRST.slice(0, 6) } });
    expect(screen.queryByText(en.local_password_mismatch)).toBeNull();
    expect(save().disabled).toBe(true);

    // Diverged: the button stays disabled and the reason is on screen.
    fireEvent.change(again, { target: { value: "TestPopup-2027!" } });
    expect(screen.getByText(en.local_password_mismatch)).toBeTruthy();
    expect(save().disabled).toBe(true);

    // Longer than the first is also a mismatch, not a half-typed copy.
    fireEvent.change(again, { target: { value: `${FIRST}x` } });
    expect(screen.getByText(en.local_password_mismatch)).toBeTruthy();

    // Equal: the reason goes away and Save is enabled.
    fireEvent.change(again, { target: { value: FIRST } });
    expect(screen.queryByText(en.local_password_mismatch)).toBeNull();
    expect(save().disabled).toBe(false);
  });
});

// The header badge is the one network signal on every screen, so before a
// wallet is open it names the wallet the unlock screen is about — not the
// picker for a new wallet's network, which defaults to Preprod.
describe("popup: the network badge before a wallet is open", () => {
  const badge = () => document.querySelector(".pw-head .pw-net")?.textContent ?? "";

  it("names a saved Mainnet wallet's network on the unlock screen", async () => {
    ctx.wallets = [{ ...wallet("m1", "Main"), network: 1 }];
    await renderPopup();
    await screen.findByLabelText(en.local_password);
    expect(badge()).toContain(en.network_mainnet);
    expect(badge()).not.toContain(en.popup_net_preprod);
  });

  it("follows the wallet picked to unlock", async () => {
    ctx.wallets = [wallet("t1", "Test"), { ...wallet("m1", "Main"), network: 1 }];
    await renderPopup();
    await screen.findByLabelText(en.local_password);
    expect(badge()).toContain(en.popup_net_preprod);
    fireEvent.change(screen.getByLabelText(en.popup_choose_wallet), { target: { value: "m1" } });
    await waitFor(() => expect(badge()).toContain(en.network_mainnet));
  });
});

describe("popup: Enter on an empty password", () => {
  it("opens no vault", async () => {
    ctx.wallets = [wallet("w1", "Daily")];
    await renderPopup();
    const pw = await screen.findByLabelText(en.local_password);
    fireEvent.keyDown(pw, { key: "Enter" });
    await new Promise((r) => setTimeout(r, 20));
    expect(ctx.opens).toBe(0);
    expect(screen.queryByRole("button", { name: en.local_lock_cta })).toBeNull();
  });
});

describe("popup: an empty account other than Account 0", () => {
  it("'Back to Account 0' on Home opens Settings with the switch form set to 0", async () => {
    ctx.wallets = [{ ...wallet("w1", "Daily"), accountIndex: 1 }];
    ctx.lovelace = BigInt(0);
    await unlockFirst();
    const back = await screen.findByRole("button", { name: en.local_account_back_zero });
    expect(screen.queryByText(en.local_account_switch_help)).toBeNull();
    fireEvent.click(back);
    expect(await screen.findByText(en.local_account_switch_help)).toBeTruthy();
    expect((screen.getByRole("spinbutton") as HTMLInputElement).value).toBe("0");
  });
});
