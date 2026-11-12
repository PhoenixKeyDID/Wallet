import { useTranslation } from "react-i18next";

/**
 * What a website asks this wallet to sign with `signData`, as the approval
 * window shows it.
 *
 * The prop is the shape of `DataSignPlan` (`src/lib/keystore/signData.ts`),
 * written out here rather than imported so this screen block does not pull the
 * keystore into anything that renders it.
 *
 * Three things are shown because each one changes what the signature means:
 * - **which key** — a stake-key signature proves control of a delegation, which
 *   is what a pool or a token distribution asks for; a payment-key signature
 *   proves control of an address;
 * - **the address**, in full, because it goes into the signed header;
 * - **the bytes**: as text only when the text is exactly what is signed
 *   (`printableText` refuses control, format, separator, private-use,
 *   unassigned and default-ignorable characters, right-to-left letters, and
 *   blank space that pushes text out of sight), and always as hex — with the
 *   byte and line count printed beside them, so the size of what is signed
 *   can be checked whatever the box shows. The text box is never cut to a
 *   height: the part of a message that matters can sit at its end.
 */
export type DataSignShown = {
  kind: "stake" | "payment";
  addressBech32: string;
  payloadHex: string;
  payloadText: string | null;
};

/** Bytes and lines of the payload; lines are the 0x0a bytes plus one. */
export function payloadSize(payloadHex: string): { bytes: number; lines: number } {
  let lines = 1;
  for (let i = 0; i + 2 <= payloadHex.length; i += 2) if (payloadHex.slice(i, i + 2) === "0a") lines += 1;
  return { bytes: payloadHex.length / 2, lines };
}

export function DataSignView({ plan }: { plan: DataSignShown }) {
  const { t } = useTranslation("wallet");
  const size = payloadSize(plan.payloadHex);
  return (
    <div className="approve-summary">
      <p className="approve-heading">{t("cip30_sign_data_intro")}</p>
      <p className="approve-note">
        {plan.kind === "stake" ? t("cip30_sign_data_key_stake") : t("cip30_sign_data_key_payment")}
      </p>
      <p className="approve-note">{t("cip30_sign_data_address")}</p>
      <p className="mono approve-sign-data">{plan.addressBech32}</p>
      {plan.payloadText !== null ? (
        <>
          <p className="approve-note">{t("cip30_sign_data_message")}</p>
          <pre className="mono approve-sign-data" data-testid="sign-data-text">
            {plan.payloadText}
          </pre>
        </>
      ) : (
        <p className="approve-note">{t("cip30_sign_data_message_hex")}</p>
      )}
      <p className="approve-note" data-testid="sign-data-size">
        {t("cip30_sign_data_size", { bytes: size.bytes, lines: size.lines })}
      </p>
      <p className="approve-note">{t("cip30_sign_data_hex")}</p>
      <p className="mono approve-sign-data approve-sign-data-scroll" data-testid="sign-data-hex">
        {plan.payloadHex}
      </p>
      <p className="approve-note">{t("cip30_sign_data_warning")}</p>
    </div>
  );
}
