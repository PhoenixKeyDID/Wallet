"use client";

import { useTranslation } from "react-i18next";
import { CopyBtn } from "@/components/CopyBtn";

/**
 * The one outcome in this wallet where doing nothing is safer than retrying.
 *
 * A transaction was signed and handed to the network, and then the reply did not
 * arrive. Nobody knows whether it landed. Sending again is how the same amount
 * leaves twice — and "send again" is exactly what every other error on this
 * screen invites, because every other error means nothing moved.
 *
 * So this is not a banner. Three properties, each of them the reason it is a
 * component rather than a `toast` call:
 *
 * 1. **It does not go away by itself.** The hash is the only way to find out
 *    what happened, and a hash that disappears after six seconds cannot be
 *    looked up. It leaves when the person says it may leave.
 * 2. **It carries the hash in full, and copyable.** Truncated to twelve
 *    characters — as the success banner shows it — it is not searchable.
 * 3. **Dismissing it is a sentence, not an ✕.** The button says the reader has
 *    checked. That is the step being asked for; a close box would let the
 *    screen return to armed without anyone having done it.
 *
 * No link to an explorer, deliberately, for the same reason `HistoryPanel` ships
 * none: one click would hand a third party this wallet's transaction alongside
 * the reader's address. Copy the hash and paste it somewhere chosen.
 */
export function UncertainSubmitNotice({
  txHash,
  onAcknowledge,
}: {
  txHash: string;
  onAcknowledge: () => void;
}) {
  const { t } = useTranslation("wallet");
  return (
    <div
      role="alert"
      className="rounded-brand border border-amber-brand bg-amber-brand/10 p-4 space-y-3"
    >
      <p className="text-sm text-amber-brand font-semibold">{t("uncertain_title")}</p>
      <p className="text-xs text-text-dim">{t("uncertain_body")}</p>
      <div className="flex items-center gap-2">
        <code className="mono text-xs text-text-dim break-all flex-1">{txHash}</code>
        <CopyBtn value={txHash} />
      </div>
      <button
        type="button"
        onClick={onAcknowledge}
        className="rounded-brand-sm border border-border-soft px-3 py-1.5 text-xs text-text-hint hover:text-text-dim"
      >
        {t("uncertain_checked_cta")}
      </button>
    </div>
  );
}
