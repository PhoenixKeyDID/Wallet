import { useTranslation } from "react-i18next";

/**
 * The screen that shows a new recovery phrase.
 *
 * It is its own component, and it deliberately has no copy button. A phrase on
 * the clipboard is readable by every other app and extension that polls it, and
 * by clipboard history and cross-device sync, and the person who clicked "copy"
 * reads it as "this is how I save it safely" — which is the opposite of the
 * paper copy the warning above asks for. The only ways out of this screen are
 * the paper (the person's own hand) and the next step.
 *
 * Kept apart from `LocalWalletPanel` so a test can render exactly this screen
 * and read every control on it, without unlocking a vault first.
 */
const btnCls =
  "rounded-brand-sm border border-border-soft px-3 py-2 text-sm hover:border-border-amber disabled:opacity-50";
const primaryCls =
  "rounded-brand-sm bg-amber-brand px-4 py-2 text-sm font-medium text-bg0 disabled:opacity-50";

export function SeedPhraseStep({
  phrase,
  concealed,
  onReveal,
  onNext,
  onCancel,
}: {
  phrase: string;
  concealed: boolean;
  onReveal: () => void;
  onNext: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation("wallet");
  return (
    <div className="rounded-brand border border-border-soft bg-bg1 p-5 space-y-4">
      <h3 className="text-sm font-medium">{t("local_words_title")}</h3>
      <p className="text-xs text-amber-brand">{t("local_words_warning")}</p>
      {concealed ? (
        <div className="rounded-brand border border-border-soft bg-bg2 p-4 text-center space-y-2">
          <p className="text-sm">{t("local_concealed_body")}</p>
          <button className={btnCls} onClick={onReveal}>
            {t("local_concealed_show")}
          </button>
        </div>
      ) : (
        <ol className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
          {phrase.split(" ").map((w, i) => (
            <li key={i} className="mono text-sm">
              <span className="text-text-hint">{i + 1}.</span> {w}
            </li>
          ))}
        </ol>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button className={primaryCls} onClick={onNext}>
          {t("local_words_next")}
        </button>
        <button className={btnCls} onClick={onCancel}>
          {t("local_cancel")}
        </button>
      </div>
    </div>
  );
}
