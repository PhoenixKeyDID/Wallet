// @vitest-environment happy-dom
/**
 * The attach screen: each failure gets the sentence that matches it.
 *
 * The cases that matter are the ones a generic message would get wrong — a bad
 * proof (1387 on HTTP 403) must not read as "signed out", a declined signature
 * must not read as a fault, and a failed list read must not show "no wallets
 * attached".
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import i18next, { type i18n as I18n } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import en from "../../../../locales/en/wallet.json";
import { ApiError } from "@/lib/api";

const BASE_HEX = "00" + "11".repeat(28) + "22".repeat(28);
const SCRIPT_HEX = "10" + "11".repeat(28) + "22".repeat(28);

const m = vi.hoisted(() => ({
  api: {
    getChangeAddress: vi.fn(),
    signData: vi.fn(),
  },
  attach: vi.fn(),
  detach: vi.fn(),
  list: vi.fn(),
}));

vi.mock("@/lib/cardano", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    listWallets: () => [{ key: "lace", name: "Lace", icon: "" }],
    enableWallet: async () => m.api,
  };
});
vi.mock("@/lib/wallet", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    attachImportedWallet: m.attach,
    detachImportedWallet: m.detach,
    listImportedWallets: m.list,
  };
});

import { ImportedWalletsPanel } from "../ImportedWalletsPanel";

let i18n: I18n;
beforeEach(async () => {
  i18n = i18next.createInstance();
  await i18n.use(initReactI18next).init({
    lng: "en",
    defaultNS: "wallet",
    ns: ["wallet"],
    resources: { en: { wallet: en } },
    interpolation: { escapeValue: false },
  });
  m.api.getChangeAddress.mockReset().mockResolvedValue(BASE_HEX);
  m.api.signData.mockReset().mockResolvedValue({ signature: "84a0", key: "a401" });
  m.attach.mockReset().mockResolvedValue(undefined);
  m.detach.mockReset().mockResolvedValue(undefined);
  m.list.mockReset().mockResolvedValue([]);
});
afterEach(cleanup);

const tr = (key: string, values?: Record<string, string>) => i18n.t(key, values) as string;

function mount() {
  render(
    <I18nextProvider i18n={i18n}>
      <ImportedWalletsPanel did="did:phoenix:preprod:7f3a" />
    </I18nextProvider>,
  );
}

async function clickAttach() {
  fireEvent.click(screen.getByRole("button", { name: tr("imported_attach_with", { name: "Lace" }) }));
}

function apiError(status: number, rawCode?: number) {
  return new ApiError({ status, code: "x", rawCode, message: "m" });
}

describe("ImportedWalletsPanel", () => {
  it("says what attaching tells the server before any button", () => {
    mount();
    expect(screen.getByText(tr("imported_privacy_note"))).toBeTruthy();
  });

  it("attaches, then shows the new list", async () => {
    m.list.mockResolvedValue([{ address: "addr_test1zz", kind: "imported", attached_at: "t" }]);
    mount();
    await clickAttach();
    await waitFor(() => expect(m.attach).toHaveBeenCalledTimes(1));
    const proof = m.attach.mock.calls[0]![0];
    expect(proof.address).toMatch(/^addr_test1/);
    expect(m.api.signData).toHaveBeenCalledWith(BASE_HEX, expect.stringMatching(/^[0-9a-f]+$/));
    expect(await screen.findByText("addr_test1zz")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("addr_test1");
  });

  it("a bad proof on 403 says the proof was refused, not that the session ended", async () => {
    m.attach.mockRejectedValue(apiError(403, 1387));
    mount();
    await clickAttach();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(tr("imported_err_proof_invalid"));
    expect(alert.textContent).not.toBe(tr("imported_err_unauthorized"));
  });

  it("an address on another DID gets its own sentence", async () => {
    m.attach.mockRejectedValue(apiError(409, 1388));
    mount();
    await clickAttach();
    expect((await screen.findByRole("alert")).textContent).toBe(tr("imported_err_already_attached"));
  });

  it("a 403 without a known code reads as signed out", async () => {
    m.attach.mockRejectedValue(apiError(403));
    mount();
    await clickAttach();
    expect((await screen.findByRole("alert")).textContent).toBe(tr("imported_err_unauthorized"));
  });

  it("a declined signature is said as such and sends nothing", async () => {
    m.api.signData.mockRejectedValue({ code: 3, info: "declined" });
    mount();
    await clickAttach();
    expect((await screen.findByRole("alert")).textContent).toBe(tr("imported_err_declined"));
    expect(m.attach).not.toHaveBeenCalled();
  });

  it("a script address is refused before the wallet is asked to sign", async () => {
    m.api.getChangeAddress.mockResolvedValue(SCRIPT_HEX);
    mount();
    await clickAttach();
    expect((await screen.findByRole("alert")).textContent).toBe(tr("imported_err_script"));
    expect(m.api.signData).not.toHaveBeenCalled();
  });

  it("a failed list read is a notice, not 'no wallets attached'", async () => {
    m.list.mockRejectedValue(apiError(500));
    mount();
    fireEvent.click(screen.getByRole("button", { name: tr("imported_show_list") }));
    expect((await screen.findByRole("alert")).textContent).toBe(tr("imported_err_generic"));
    expect(screen.queryByText(tr("imported_none"))).toBeNull();
  });

  it("an empty list says so", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: tr("imported_show_list") }));
    expect(await screen.findByText(tr("imported_none"))).toBeTruthy();
  });

  it("detach needs a second click, and cancelling sends nothing", async () => {
    m.list.mockResolvedValue([{ address: "addr_test1zz", kind: "imported", attached_at: "t" }]);
    mount();
    fireEvent.click(screen.getByRole("button", { name: tr("imported_show_list") }));
    fireEvent.click(await screen.findByRole("button", { name: tr("imported_detach") }));
    fireEvent.click(screen.getByRole("button", { name: tr("imported_detach_cancel") }));
    expect(m.detach).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: tr("imported_detach") }));
    m.list.mockResolvedValue([]);
    fireEvent.click(screen.getByRole("button", { name: tr("imported_detach_confirm") }));
    await waitFor(() => expect(m.detach).toHaveBeenCalledWith("addr_test1zz"));
    expect(await screen.findByText(tr("imported_none"))).toBeTruthy();
  });
});
