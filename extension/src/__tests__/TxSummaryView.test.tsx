// @vitest-environment happy-dom
/**
 * The approval window's description of a website's transaction, rendered.
 *
 * Every name printed here was chosen by the website that built the
 * transaction. The helper tests prove `assetLabel` carries the policy id; these
 * prove the window actually prints it — reverting the call to the bare name
 * left every helper test green before this file existed.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import i18next from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { Buffer } from "buffer";
import en from "../../../locales/en/wallet.json";
import { TxSummaryView } from "../TxSummaryView";
import type { TxSummary } from "../../../src/lib/cardano/txSummary";
import { baseAddress } from "../../../src/lib/cardano/address";
import { policyIdShort } from "../../../src/lib/cardano/provider";

const PAYEE = baseAddress("cc".repeat(28), "dd".repeat(28), 0);
const REAL = "8169b76cdaba83cf7c9ae32ebd2bb3a58aa215c7dc0b62c8f5e268dd";
const LOOKALIKE = "0".repeat(52) + "dead";
const LAMP = Buffer.from("LAMP", "utf8").toString("hex");

const i18n = i18next.createInstance();
await i18n.use(initReactI18next).init({
  lng: "en",
  defaultNS: "wallet",
  ns: ["wallet"],
  resources: { en: { wallet: en } },
  interpolation: { escapeValue: false },
});

afterEach(cleanup);

const token = (policyId: string, amount: bigint) => ({
  unit: policyId + LAMP,
  policyId,
  assetNameHex: LAMP,
  amount,
});

function shown(overrides: Partial<TxSummary> = {}) {
  const summary: TxSummary = {
    net: [],
    toOthers: [],
    fee: BigInt(170_000),
    ownInputs: 1,
    totalInputs: 1,
    certificates: 0,
    withdrawals: 0,
    mints: 0,
    withdrawalLovelace: BigInt(0),
    ...overrides,
  };
  const { container } = render(
    <I18nextProvider i18n={i18n}>
      <TxSummaryView summary={summary} />
    </I18nextProvider>,
  );
  return container.textContent ?? "";
}

describe("TxSummaryView — what the approval window shows", () => {
  it("names a token leaving the wallet together with its policy id", () => {
    const text = shown({ net: [token(REAL, BigInt(5))] });
    expect(text).toContain(`5 LAMP · ${policyIdShort(REAL)}`);
  });

  // A website can send in a worthless look-alike while taking the real one.
  // With bare names the two lines read "5 LAMP" and "5 LAMP (coming in)", and
  // the transaction looks like a swap of equals.
  it("tells apart the real token leaving and a look-alike coming in", () => {
    const text = shown({ net: [token(REAL, BigInt(5)), token(LOOKALIKE, BigInt(-5))] });
    expect(text).toContain(policyIdShort(REAL));
    expect(text).toContain(policyIdShort(LOOKALIKE));
  });

  it("prints every recipient that is not this wallet in full", () => {
    const text = shown({ toOthers: [{ address: PAYEE, lovelace: BigInt(2_000_000), mine: false }] });
    expect(text).toContain(PAYEE);
  });

  it("says when it recognised only some of the inputs", () => {
    const text = shown({ ownInputs: 1, totalInputs: 3 });
    expect(text).toContain("1 of 3");
  });
});
