"use client";

import { useState } from "react";

/**
 * Host-contract: copy-to-clipboard button.
 *
 * Minimal default. The PhoenixKey host app provides a styled `@/components/CopyBtn`
 * with i18n labels — point the alias at the host component when integrating.
 */
export function CopyBtn({ value }: { value: string | null | undefined }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable — no-op */
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      disabled={!value}
      className="text-xs text-text-hint hover:text-text-dim disabled:opacity-40"
      aria-label="Copy"
    >
      {copied ? "✓" : "⧉"}
    </button>
  );
}
