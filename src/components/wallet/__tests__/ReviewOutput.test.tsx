// @vitest-environment happy-dom
/**
 * The Send review screen, rendered — not the helpers it calls.
 *
 * `assetName.test.ts` already proves `assetLabel` puts the policy id in the
 * label. What it cannot prove is that the screen calls it: swapping the call
 * back to the bare name left every helper test green. These tests read the text
 * a person reads before signing, so that swap goes red here.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import i18next from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { Buffer } from "buffer";
import en from "../../../../locales/en/wallet.json";
import { ReviewOutput } from "../ReviewOutput";
import { buildSendOutputs } from "@/lib/cardano/send";
import { baseAddress, type PhoenixNetwork } from "@/lib/cardano/address";
import { policyIdShort } from "@/lib/cardano/provider";

const NETWORK: PhoenixNetwork = 0;
const PAYEE = baseAddress("cc".repeat(28), "dd".repeat(28), NETWORK);
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

function shown(tokens: { policyId: string; assetNameHex: string; amount: string }[]) {
  const [output] = buildSendOutputs([{ address: PAYEE, ada: "2", tokens }], NETWORK);
  const { container } = render(
    <I18nextProvider i18n={i18n}>
      <ReviewOutput output={output} index={0} />
    </I18nextProvider>,
  );
  return container.textContent ?? "";
}

describe("ReviewOutput — what the Send review screen shows", () => {
  it("names a token together with its policy id", () => {
    const text = shown([{ policyId: REAL, assetNameHex: LAMP, amount: "5" }]);
    expect(text).toContain(`LAMP · ${policyIdShort(REAL)}`);
  });

  // The case the label exists for: two tokens with the same name. With the
  // bare name both rows read "LAMP" and nothing on screen says which is which.
  it("tells apart two tokens that share a name", () => {
    const text = shown([
      { policyId: REAL, assetNameHex: LAMP, amount: "5" },
      { policyId: LOOKALIKE, assetNameHex: LAMP, amount: "5" },
    ]);
    expect(text).toContain(policyIdShort(REAL));
    expect(text).toContain(policyIdShort(LOOKALIKE));
  });

  // In full, with the four characters the person must retype set apart in
  // brackets — every character of the address is on screen, none elided.
  it("prints the recipient address in full, tail marked for retyping", () => {
    expect(shown([])).toContain(`${PAYEE.slice(0, -4)}[${PAYEE.slice(-4)}]`);
  });
});
