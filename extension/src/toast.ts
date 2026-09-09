/**
 * The extension's own `@/lib/toast` — the half of the host contract nobody wrote.
 *
 * `docs/host-contract.json` lists five aliases the host is expected to supply.
 * The web app supplies all five (`PhoenixKey-Frontend/tsconfig.json` maps them
 * into its own modules). The extension supplied **none**: `extension/vite.config.ts`
 * declared one catch-all `@ → src`, so every one of the five resolved back into
 * the module's own stand-ins. Nothing failed — they resolved *successfully*, into
 * a console logger — so no build, no test and no gate said a word.
 *
 * What the user got: panels call toast with a **bare i18n key**
 * (`StakingPanel.tsx` → `toastSuccess("delegate_submitted", { hash })`). The
 * stand-in emits the key verbatim and drops the values, so somebody who had just
 * delegated their stake read the literal string `delegate_submitted` — a message
 * that cannot be told apart from a crash, right after an action that moves money.
 * The obvious next move is to do it again.
 *
 * This file is deliberately thin. It owns no strings: every string comes from
 * `locales/`, which the module already owns and the web app already reads. It is
 * wiring, not a second implementation — the one thing that must not happen here
 * is a second place where wallet copy lives.
 */
import { ApiError } from "@/lib/api";
import { i18n } from "./i18n";

type ToastKind = "error" | "success" | "info";

/**
 * Namespaces a key may live in, and the order they are searched.
 *
 * Matches the web app's list so a key resolves the same way in both hosts. A key
 * that only the web app can resolve is worse than a missing key: it works
 * everywhere the author tests and fails only in the packaged extension.
 */
const NS = ["wallet", "night", "common"];

/** Translate if the key is known; otherwise show what we were handed. */
function say(key: string, values?: Record<string, unknown>): string {
  return i18n.t(key, { ns: NS, defaultValue: key, ...values });
}

/**
 * Paint the message.
 *
 * A popup is 360px of chrome with no room for a toast library, and the approval
 * window is smaller still, so this draws the banner itself. `role="alert"` on
 * errors and `role="status"` elsewhere, because the person most likely to be
 * hurt by a silent failure is the person using a screen reader.
 */
function paint(kind: ToastKind, message: string): void {
  if (typeof document === "undefined" || !document.body) return;
  const el = document.createElement("div");
  el.setAttribute("role", kind === "error" ? "alert" : "status");
  el.className = "phoenix-toast phoenix-toast-" + kind;
  el.textContent = message;
  document.body.appendChild(el);
  // Errors stay twice as long. A success message is a receipt you glance at; an
  // error is something you have to read and act on, and the popup can close
  // under you while you are still reading it.
  setTimeout(() => el.remove(), kind === "error" ? 12_000 : 6_000);
}

function emit(kind: ToastKind, key: string, values?: Record<string, unknown>): void {
  const message = say(key, values);
  paint(kind, message);
  // Kept alongside the banner rather than instead of it. A popup that closes the
  // moment it loses focus takes the banner with it, and the console is the only
  // place left to find out what the wallet said.
  (kind === "error" ? console.error : console.info)(`[toast:${kind}] ${message}`);
}

export function toastApiError(err: unknown, fallbackKey = "errors.generic"): void {
  if (err instanceof ApiError) {
    emit("error", err.userMessageKey || err.message || fallbackKey);
    return;
  }
  // Validation helpers throw a plain `Error` whose message is already a sentence
  // meant for the person reading it. `say()` passes an unknown key through
  // unchanged, so this stays a sentence rather than becoming a key lookup.
  if (err instanceof Error && err.message) {
    emit("error", err.message);
    return;
  }
  // CIP-30 extensions reject with a plain object, not an `Error`.
  // `TxSignError.UserDeclined = 2` / `DataSignError.UserDeclined = 3` is what a
  // wallet returns when the person pressed Cancel — the highest-frequency branch
  // of the whole signing flow, and not a failure.
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code?: unknown }).code;
    const info = (err as { info?: unknown }).info;
    if (code === 2 || code === 3) {
      emit("info", "tx_cancelled_nothing_sent");
      return;
    }
    if (typeof info === "string" && info) {
      emit("error", info);
      return;
    }
  }
  console.error("[toastApiError] unknown error", err);
  emit("error", fallbackKey);
}

/** Show an already-translated sentence. For values the caller resolved itself. */
export function toastError(message: string): void {
  paint("error", message);
  console.error(`[toast:error] ${message}`);
}

export function toastSuccess(key: string, values?: Record<string, unknown>): void {
  emit("success", key, values);
}

export function toastInfo(key: string, values?: Record<string, unknown>): void {
  emit("info", key, values);
}
