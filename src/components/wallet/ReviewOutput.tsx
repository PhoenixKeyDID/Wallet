"use client";

import { useTranslation } from "react-i18next";
import { CopyBtn } from "@/components/CopyBtn";
import { ChallengedValue } from "@/components/wallet/ConfirmGate";
import { formatAda, assetLabel } from "@/lib/cardano";
import type { SendOutput } from "@/lib/cardano/send";

/**
 * One recipient on the Send review screen — the last thing a person reads
 * before the key signs.
 *
 * A component of its own so that what it promises can be checked on a rendered
 * screen rather than argued from the source: the full address, and every token
 * named together with its policy id. Both have regressed before in ways no
 * unit test on the helpers could see, because the helpers were right and the
 * screen simply stopped calling them. `ReviewOutput.test.tsx` renders this and
 * reads the text a person would read.
 */
export function ReviewOutput({ output, index }: { output: SendOutput; index: number }) {
  const { t } = useTranslation("wallet");
  const address = output.address.getBech32();
  return (
    <div className="space-y-1 border-b border-border-soft pb-2 last:border-b-0 last:pb-0">
      <div className="space-y-1">
        <span className="text-text-hint text-xs">
          {t("send_to")} #{index + 1}
        </span>
        {/* Full address, wrapped — a truncated address makes the verify
            checkbox meaningless against address-poisoning. EVERY
            recipient has its challenged tail marked, because every one
            must be retyped. Marking it here rather than printing it
            beside the input means the eye must cross the real address
            to find it (Wallet#7). */}
        <div className="flex items-start gap-2">
          <ChallengedValue value={address} className="mono text-xs break-all flex-1" />
          <CopyBtn value={address} />
        </div>
      </div>
      {output.lovelace > BigInt("0") && (
        <div className="flex justify-between">
          <span className="text-text-hint">ADA</span>
          <span className="mono font-semibold">{formatAda(output.lovelace)} ADA</span>
        </div>
      )}
      {output.tokens.map((tk, tIdx) => (
        <div key={tIdx} className="flex justify-between">
          {/* A name alone does not identify what is leaving: the picker
              can hold two rows reading the same word, and the one that got
              chosen is decided by the policy id, not by the name. */}
          <span className="text-text-hint break-all">{assetLabel(tk)}</span>
          <span className="mono font-semibold">{tk.amount.toString()}</span>
        </div>
      ))}
    </div>
  );
}
