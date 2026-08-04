"use client";

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PhoenixNetwork } from "@/lib/cardano";

/**
 * ConfirmGate — the last human check before a signature request.
 *
 * A bare checkbox is a reflex: faced with an irreversible send the user ticks
 * it without reading. This gate instead makes the user **retype a short
 * challenge drawn from the transaction itself** — the last few characters of
 * the recipient address / pool id / dRep id — which forces the eyes onto the
 * destination before the signature request goes out.
 *
 * What this is and is NOT (Wallet#7). It defeats the reflex tick and catches a
 * mis-paste. It does NOT defeat a targeted address-poisoning attack: four
 * bech32 characters are 20 bits, so grinding a vanity address that shares a
 * tail is seconds of work, and if the poisoned address is already in the form
 * then the challenge is drawn from the poisoned address and matches. Defeating
 * a targeted swap needs an address book plus a "you have never sent here
 * before" warning — a different mechanism, on the roadmap.
 *
 * The caller must NOT print the challenge next to the input: that turns the
 * gate into screen-to-screen copying with the address never read. Highlight the
 * challenged characters inside the full destination instead, as `SendPanel`
 * does, so the eye has to travel across the real address.
 *
 * Network behaviour:
 *  - `alwaysChallenge` (Send): the retype is required on every network, so the
 *    real flow is exercised on preprod exactly as it runs on mainnet.
 *  - otherwise: mainnet requires the retype; on testnet the lighter checkbox is
 *    kept, since testnet funds have no value.
 * If no challenge string is available (e.g. an Abstain vote with no target id)
 * the gate falls back to the checkbox — there is nothing to mis-address.
 */

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * How many trailing characters the user retypes. Exported so the caller can
 * highlight exactly these characters in the destination it renders — if the two
 * drifted, the gate would ask for one thing and mark another.
 *
 * Four bech32 characters is 20 bits. That is enough to catch a mis-paste, not
 * enough to stop a grind — see the header note.
 */
export const CHALLENGE_LEN = 4;

/** Last `n` visible characters of a value — the string the user must retype. */
export function tailChallenge(value: string, n = CHALLENGE_LEN): string {
  const v = (value ?? "").trim();
  return v.length <= n ? v : v.slice(-n);
}

export function ConfirmGate({
  network,
  challenge,
  challengeHint,
  checkboxLabel,
  confirmed,
  onChange,
  alwaysChallenge = false,
}: {
  network: PhoenixNetwork;
  /** Exact string the user must retype (e.g. the last 4 chars of the address). */
  challenge: string;
  /** Names WHAT to type, e.g. "the last 4 characters of recipient #1's address". */
  challengeHint: string;
  /** Testnet copy for the lighter checkbox. */
  checkboxLabel: string;
  confirmed: boolean;
  onChange: (v: boolean) => void;
  alwaysChallenge?: boolean;
}) {
  const { t } = useTranslation("wallet");
  const isMainnet = network === 1;
  const useChallenge = (isMainnet || alwaysChallenge) && challenge.trim().length > 0;
  const [entry, setEntry] = useState("");

  // The gate sits at a fixed position in the review, so React keeps this
  // instance mounted when the review switches to a NEW transaction. Without
  // this reset a previously-matched confirmation (and the typed tail) would
  // carry over to a different destination — the button would stay enabled for
  // an address the user never re-checked. Re-arm whenever the challenge changes.
  useEffect(() => {
    setEntry("");
    onChange(false);
    // onChange is a stable setState updater from the parent; only the challenge
    // identity should re-arm the gate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [challenge]);

  if (!useChallenge) {
    return (
      <label className="flex items-start gap-2 text-xs text-text-dim cursor-pointer">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-0.5"
        />
        <span>{checkboxLabel}</span>
      </label>
    );
  }

  const match = normalize(entry) === normalize(challenge);
  const handle = (v: string) => {
    setEntry(v);
    onChange(normalize(v) === normalize(challenge));
  };

  return (
    <div className="space-y-1.5">
      {/* The challenge string is deliberately NOT printed here. Showing the
          answer beside the input lets the user copy screen-to-screen without
          ever looking at the destination — the gate would then only prove they
          can transcribe. The characters are highlighted in the address above
          instead, so the eye has to travel across the real address. */}
      <p className="text-xs text-amber-brand">
        {t("confirm_gate_prompt", { hint: challengeHint })}
      </p>
      <div className="flex items-center gap-2">
        <input
          value={entry}
          onChange={(e) => handle(e.target.value)}
          placeholder={t("confirm_gate_placeholder")}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-label={challengeHint}
          className={
            "flex-1 p-2 rounded-brand-sm bg-bg0 border text-sm mono tracking-widest " +
            (entry.length === 0
              ? "border-border-soft"
              : match
                ? "border-teal-brand text-teal-brand"
                : "border-border-amber text-amber-brand")
          }
        />
        <span className="mono text-sm w-5 text-center text-teal-brand" aria-hidden>
          {match ? "✓" : ""}
        </span>
      </div>
      {entry.length > 0 && !match && (
        <p className="text-[11px] text-text-hint">{t("confirm_gate_mismatch")}</p>
      )}
    </div>
  );
}
