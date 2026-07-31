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
 * the recipient address / pool id / dRep id. Retyping the tail forces the eyes
 * onto the exact cryptographic destination and defeats an address-poisoning
 * swap that a checkbox would wave through.
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

/** Last `n` visible characters of a value — the string the user must retype. */
export function tailChallenge(value: string, n = 4): string {
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
      <p className="text-xs text-amber-brand">
        {t("confirm_gate_prompt", { hint: challengeHint })}{" "}
        <span className="mono font-semibold tracking-widest">{challenge}</span>
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
