// @vitest-environment happy-dom
/**
 * The signData screen, rendered. Each line printed here changes what the
 * signature means — which key, whether the message is shown as text, how big
 * it is — so each is checked on the rendered screen, not only in the helper
 * that decides it.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import i18next from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { Buffer } from "buffer";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import en from "../../../locales/en/wallet.json";
import { DataSignView, payloadSize, type DataSignShown } from "../DataSignView";

const i18n = i18next.createInstance();
await i18n.use(initReactI18next).init({
  lng: "en",
  defaultNS: "wallet",
  ns: ["wallet"],
  resources: { en: { wallet: en } },
  interpolation: { escapeValue: false },
});

afterEach(cleanup);

const hexOf = (text: string) => Buffer.from(text, "utf8").toString("hex");
const plan = (over: Partial<DataSignShown> = {}): DataSignShown => ({
  kind: "stake",
  addressBech32: "stake_test1uqexample",
  payloadHex: hexOf("hello"),
  payloadText: "hello",
  ...over,
});
const screen = (p: DataSignShown) =>
  render(
    <I18nextProvider i18n={i18n}>
      <DataSignView plan={p} />
    </I18nextProvider>,
  );

describe("which key signs", () => {
  it("a stake-key request says STAKING, and not PAYMENT", () => {
    const text = screen(plan({ kind: "stake" })).container.textContent ?? "";
    expect(text).toContain(en.cip30_sign_data_key_stake);
    expect(text).not.toContain(en.cip30_sign_data_key_payment);
  });
  it("a payment-key request says PAYMENT, and not STAKING", () => {
    const text = screen(plan({ kind: "payment" })).container.textContent ?? "";
    expect(text).toContain(en.cip30_sign_data_key_payment);
    expect(text).not.toContain(en.cip30_sign_data_key_stake);
  });
});

describe("text or hex", () => {
  it("a message with no text says it is shown as hex, and has no text box", () => {
    const v = screen(plan({ payloadHex: "ff00", payloadText: null }));
    expect(v.container.textContent).toContain(en.cip30_sign_data_message_hex);
    expect(v.queryByTestId("sign-data-text")).toBeNull();
    expect(v.getByTestId("sign-data-hex").textContent).toBe("ff00");
  });
  it("a text message is labelled as a message, not as hex, and its text box holds the whole text", () => {
    const long = "line\n".repeat(80) + "the end that matters";
    const v = screen(plan({ payloadHex: hexOf(long), payloadText: long }));
    expect(v.container.textContent).toContain(en.cip30_sign_data_message);
    expect(v.container.textContent).not.toContain(en.cip30_sign_data_message_hex);
    const box = v.getByTestId("sign-data-text");
    expect(box.textContent).toBe(long);
    // The text box is never given the class that limits its height.
    expect(box.className).not.toContain("approve-sign-data-scroll");
  });
  it("the stylesheet gives the shared block no height limit; only the scroll modifier has one", () => {
    const css = readFileSync(resolve(process.cwd(), "extension/src/popup.css"), "utf8");
    const rule = (sel: string) => {
      const m = new RegExp(`(^|\\n)\\${sel}\\s*\\{([^}]*)\\}`).exec(css);
      expect(m, `${sel} rule`).not.toBeNull();
      return m![2]!;
    };
    expect(rule(".approve-sign-data")).not.toMatch(/max-height|overflow(-x|-y)?\s*:|text-overflow|line-clamp/);
    // A run of no-break spaces (U+00A0, U+202F, U+2007) gives the line no break
    // point, and word-break alone does not break inside it: the letters after it
    // were laid out at x≈2529 in a 400 px box. overflow-wrap: anywhere breaks it.
    expect(rule(".approve-sign-data")).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule(".approve-sign-data-scroll")).toMatch(/max-height/);
  });
});

describe("the size of what is signed is always printed", () => {
  it("counts bytes, and lines as the 0x0a bytes plus one", () => {
    expect(payloadSize("")).toEqual({ bytes: 0, lines: 1 });
    expect(payloadSize(hexOf("a\nb\n"))).toEqual({ bytes: 4, lines: 3 });
    // 0a must sit on a byte boundary: "a0a0" is two bytes, no newline.
    expect(payloadSize("a0a0")).toEqual({ bytes: 2, lines: 1 });
  });
  it("beside a text message", () => {
    const msg = "one\ntwo\nthree";
    const v = screen(plan({ payloadHex: hexOf(msg), payloadText: msg }));
    expect(v.getByTestId("sign-data-size").textContent).toBe(
      en.cip30_sign_data_size.replace("{{bytes}}", "13").replace("{{lines}}", "3"),
    );
  });
  it("beside a hex-only message", () => {
    const v = screen(plan({ payloadHex: "0a0a0aff", payloadText: null }));
    expect(v.getByTestId("sign-data-size").textContent).toBe(
      en.cip30_sign_data_size.replace("{{bytes}}", "4").replace("{{lines}}", "4"),
    );
  });
});
