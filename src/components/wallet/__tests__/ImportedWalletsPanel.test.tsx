// @vitest-environment happy-dom
/**
 * The attach screen: each failure gets the sentence that matches it.
 *
 * The cases that matter are the ones a generic message would get wrong — a bad
 * proof (1387 on HTTP 403) must not read as "signed out", a declined signature
 * must not read as a fault, a failed list read must not show "no wallets
 * attached", and a wallet that never answers must not leave the screen stuck.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, fireEvent, screen, waitFor, act } from "@testing-library/react";
import { Buffer } from "buffer";
import { bech32 } from "bech32";
import i18next, { type i18n as I18n } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import en from "../../../../locales/en/wallet.json";
import { ApiError } from "@/lib/api";
import { CONNECT_TIMEOUT_MS, WalletConnectError } from "@/lib/cardano";
import { IMPORT_PROOF_LIFETIME_SEC } from "@/lib/wallet";

const BASE_HEX = "00" + "11".repeat(28) + "22".repeat(28);
const SCRIPT_HEX = "10" + "11".repeat(28) + "22".repeat(28);
/** Same payment key as BASE_HEX, another stake key. */
const VARIANT_HEX = "00" + "11".repeat(28) + "33".repeat(28);
const OTHER_KEY_HEX = "00" + "44".repeat(28) + "22".repeat(28);

const toBech = (hex: string) => bech32.encode("addr_test", bech32.toWords(Buffer.from(hex, "hex")), 1023);
const BASE = toBech(BASE_HEX);
const VARIANT = toBech(VARIANT_HEX);
const OTHER_KEY = toBech(OTHER_KEY_HEX);
const short = (a: string) => (a.length > 30 ? `${a.slice(0, 16)}…${a.slice(-10)}` : a);

const m = vi.hoisted(() => ({
  api: {
    getChangeAddress: vi.fn(),
    signData: vi.fn(),
  },
  wallets: vi.fn(),
  enable: vi.fn(),
  attach: vi.fn(),
  detach: vi.fn(),
  list: vi.fn(),
}));

vi.mock("@/lib/cardano", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    listWallets: () => m.wallets(),
    enableWallet: (...a: unknown[]) => m.enable(...a),
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
  m.wallets.mockReset().mockReturnValue([{ key: "lace", name: "Lace", icon: "" }]);
  m.enable.mockReset().mockResolvedValue(m.api);
  m.api.getChangeAddress.mockReset().mockResolvedValue(BASE_HEX);
  m.api.signData.mockReset().mockResolvedValue({ signature: "84a0", key: "a401" });
  m.attach.mockReset().mockResolvedValue(undefined);
  m.detach.mockReset().mockResolvedValue(undefined);
  m.list.mockReset().mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const tr = (key: string, values?: Record<string, string>) => i18n.t(key, values) as string;
const row = (address: string) => ({ address, kind: "imported", attached_at: "t" });

function mount() {
  render(
    <I18nextProvider i18n={i18n}>
      <ImportedWalletsPanel did="did:phoenix:preprod:7f3a" />
    </I18nextProvider>,
  );
}

const attachButton = () => screen.getByRole("button", { name: tr("imported_attach_with", { name: "Lace" }) });

async function clickAttach() {
  fireEvent.click(attachButton());
}

function apiError(status: number, rawCode?: number) {
  return new ApiError({ status, code: "x", rawCode, message: "m" });
}

describe("ImportedWalletsPanel — attach", () => {
  it("says what attaching tells the server before any button", () => {
    mount();
    expect(screen.getByText(tr("imported_privacy_note"))).toBeTruthy();
  });

  it("attaches, then shows the new list", async () => {
    m.list.mockResolvedValue([row(BASE)]);
    mount();
    await clickAttach();
    await waitFor(() => expect(m.attach).toHaveBeenCalledTimes(1));
    const proof = m.attach.mock.calls[0]![0];
    expect(proof.address).toBe(BASE);
    expect(m.api.signData).toHaveBeenCalledWith(BASE_HEX, expect.stringMatching(/^[0-9a-f]+$/));
    expect(await screen.findByText(BASE)).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe(tr("imported_attached", { address: short(BASE) }));
  });

  it("shows the full address it will attach while the wallet is asked to sign", async () => {
    m.api.signData.mockReturnValue(new Promise(() => {}));
    mount();
    await clickAttach();
    expect(await screen.findByText(tr("imported_address_to_attach", { address: BASE }))).toBeTruthy();
  });

  it("a bad proof on 403 says the proof was refused, naming the address, not that the session ended", async () => {
    m.attach.mockRejectedValue(apiError(403, 1387));
    mount();
    await clickAttach();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(tr("imported_err_proof_invalid", { address: short(BASE) }));
    expect(alert.textContent).not.toBe(tr("imported_err_unauthorized"));
  });

  it("an address on another DID gets its own sentence", async () => {
    m.attach.mockRejectedValue(apiError(409, 1388));
    mount();
    await clickAttach();
    expect((await screen.findByRole("alert")).textContent).toBe(tr("imported_err_already_attached"));
  });

  it("a wallet on the other network is told to switch network", async () => {
    m.attach.mockRejectedValue(apiError(400, 1390));
    mount();
    await clickAttach();
    expect((await screen.findByRole("alert")).textContent).toBe(tr("imported_err_network"));
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

  it("a wallet refusing because the address is not a key address (code 2) gets the script sentence", async () => {
    m.api.signData.mockRejectedValue({ code: 2, info: "not pk" });
    mount();
    await clickAttach();
    expect((await screen.findByRole("alert")).textContent).toBe(tr("imported_err_script"));
    expect(m.attach).not.toHaveBeenCalled();
  });

  it("a script address is refused before the wallet is asked to sign", async () => {
    m.api.getChangeAddress.mockResolvedValue(SCRIPT_HEX);
    mount();
    await clickAttach();
    expect((await screen.findByRole("alert")).textContent).toBe(tr("imported_err_script"));
    expect(m.api.signData).not.toHaveBeenCalled();
  });

  it("a wallet that refuses to give its address is an error, not a silent reset", async () => {
    m.api.getChangeAddress.mockRejectedValue(new Error("account changed"));
    mount();
    await clickAttach();
    expect((await screen.findByRole("alert")).textContent).toBe(tr("imported_err_connect", { name: "Lace" }));
    expect(m.api.signData).not.toHaveBeenCalled();
  });

  it("a wallet that never connects gets the connect-timeout sentence", async () => {
    m.enable.mockRejectedValue(new WalletConnectError("timeout", "t"));
    mount();
    await clickAttach();
    expect((await screen.findByRole("alert")).textContent).toBe(tr("connect_timeout"));
  });

  it("Cancel during signing stops the wait, says nothing, and sends nothing", async () => {
    m.api.signData.mockReturnValue(new Promise(() => {}));
    mount();
    await clickAttach();
    fireEvent.click(await screen.findByRole("button", { name: tr("cancel") }));
    await waitFor(() => expect(attachButton()).toBeTruthy());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: tr("cancel") })).toBeNull();
    expect(m.attach).not.toHaveBeenCalled();
  });

  it("Cancel while the wallet withholds its address frees the screen and never asks it to sign", async () => {
    m.api.getChangeAddress.mockReturnValue(new Promise(() => {}));
    mount();
    await clickAttach();
    await waitFor(() => expect(m.api.getChangeAddress).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByRole("button", { name: tr("cancel") }));
    await waitFor(() => expect(attachButton()).toBeTruthy());
    expect(screen.queryByRole("button", { name: tr("cancel") })).toBeNull();
    expect((screen.getByRole("button", { name: tr("imported_show_list") }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(m.api.signData).not.toHaveBeenCalled();
    expect(m.attach).not.toHaveBeenCalled();
  });

  it("an address that arrives after Cancel is not signed for, and a late refusal is not left unhandled", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (r: unknown) => unhandled.push(r);
    process.on("unhandledRejection", onUnhandled);
    try {
      let give!: (v: string) => void;
      m.api.getChangeAddress.mockReturnValue(new Promise<string>((r) => (give = r)));
      // Were the wallet asked anyway, the user would decline the popup that appeared.
      m.api.signData.mockRejectedValue({ code: 3, info: "user declined" });
      mount();
      await clickAttach();
      await waitFor(() => expect(m.api.getChangeAddress).toHaveBeenCalledTimes(1));
      fireEvent.click(await screen.findByRole("button", { name: tr("cancel") }));
      await waitFor(() => expect(attachButton()).toBeTruthy());
      await act(async () => {
        give(BASE_HEX);
        await new Promise((r) => setTimeout(r, 20));
      });
      expect(m.api.signData).not.toHaveBeenCalled();
      expect(unhandled).toEqual([]);
      expect(screen.queryByRole("alert")).toBeNull();
      expect(m.attach).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("a wallet that never gives its address times out with the connect-timeout sentence", async () => {
    vi.useFakeTimers();
    m.api.getChangeAddress.mockReturnValue(new Promise(() => {}));
    mount();
    await clickAttach();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS - 1);
    });
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByRole("alert").textContent).toBe(tr("connect_timeout"));
    expect(attachButton()).toBeTruthy();
    expect(m.api.signData).not.toHaveBeenCalled();
  });

  it("a wallet that never signs is given up on once the proof would have expired", async () => {
    vi.useFakeTimers();
    m.api.signData.mockReturnValue(new Promise(() => {}));
    mount();
    await clickAttach();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText(tr("imported_address_to_attach", { address: BASE }))).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(IMPORT_PROOF_LIFETIME_SEC * 1000 - 1);
    });
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByRole("alert").textContent).toBe(tr("imported_err_sign_timeout"));
    expect(m.attach).not.toHaveBeenCalled();
  });

  it("a variant of a key already on this DID says which address holds it", async () => {
    m.list.mockResolvedValue([row(OTHER_KEY), row(VARIANT)]);
    mount();
    await clickAttach();
    expect((await screen.findByRole("status")).textContent).toBe(
      tr("imported_attached_same_key", { existing: short(VARIANT) }),
    );
  });

  it("an accepted attach that is missing from the list is flagged", async () => {
    m.list.mockResolvedValue([row(OTHER_KEY)]);
    mount();
    await clickAttach();
    expect((await screen.findByRole("alert")).textContent).toBe(
      tr("imported_attached_missing", { address: short(BASE) }),
    );
  });

  it("an attach whose list re-read fails still says it attached", async () => {
    m.list.mockRejectedValue(apiError(500));
    mount();
    await clickAttach();
    expect((await screen.findByRole("status")).textContent).toBe(
      tr("imported_attached_list_failed", { address: short(BASE) }),
    );
    expect(screen.queryByText(tr("imported_none"))).toBeNull();
  });
});

describe("ImportedWalletsPanel — list and detach", () => {
  it("no extension offers a re-check that finds one installed later", () => {
    m.wallets.mockReturnValue([]);
    mount();
    expect(screen.getByText(tr("imported_no_extension"))).toBeTruthy();
    m.wallets.mockReturnValue([{ key: "lace", name: "Lace", icon: "" }]);
    fireEvent.click(screen.getByRole("button", { name: tr("recheck_wallets") }));
    expect(attachButton()).toBeTruthy();
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

  it("re-reading the list clears an old notice", async () => {
    m.attach.mockRejectedValue(apiError(409, 1388));
    mount();
    await clickAttach();
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: tr("imported_show_list") }));
    expect(await screen.findByText(tr("imported_none"))).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("detach needs a second click, and cancelling sends nothing", async () => {
    m.list.mockResolvedValue([row("addr_test1zz")]);
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
    expect(screen.getByRole("status").textContent).toBe(tr("imported_detached", { address: "addr_test1zz" }));
  });

  it("detaching an address already gone (1320) says so and shows the list as it is now", async () => {
    m.list.mockResolvedValue([row("addr_test1zz")]);
    m.detach.mockRejectedValue(apiError(400, 1320));
    mount();
    fireEvent.click(screen.getByRole("button", { name: tr("imported_show_list") }));
    fireEvent.click(await screen.findByRole("button", { name: tr("imported_detach") }));
    m.list.mockResolvedValue([]);
    fireEvent.click(screen.getByRole("button", { name: tr("imported_detach_confirm") }));
    expect((await screen.findByRole("alert")).textContent).toBe(tr("imported_err_not_attached"));
    expect(await screen.findByText(tr("imported_none"))).toBeTruthy();
    expect(m.list).toHaveBeenCalledTimes(2);
  });

  it("a detach whose list re-read fails still says it detached", async () => {
    m.list.mockResolvedValue([row("addr_test1zz")]);
    mount();
    fireEvent.click(screen.getByRole("button", { name: tr("imported_show_list") }));
    fireEvent.click(await screen.findByRole("button", { name: tr("imported_detach") }));
    m.list.mockRejectedValue(apiError(500));
    fireEvent.click(screen.getByRole("button", { name: tr("imported_detach_confirm") }));
    expect((await screen.findByRole("status")).textContent).toBe(
      tr("imported_detached_list_failed", { address: "addr_test1zz" }),
    );
    expect(screen.queryByText("addr_test1zz")).toBeNull();
  });
});
