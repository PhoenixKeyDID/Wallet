"use client";

/**
 * Host-contract: user notifications.
 *
 * Minimal default that logs to the console and, if the host installs a global
 * `window.__phoenixToast` handler, forwards to it. The PhoenixKey host app
 * provides a richer `@/lib/toast` (react-hot-toast + i18n) — point the alias at
 * the host implementation when integrating.
 */
import { ApiError } from "./api";

type ToastKind = "error" | "success" | "info";

/**
 * Last-resort visible banner when the host has NOT installed `__phoenixToast`.
 * This module ships open-source; an integrator who forgets to wire the real
 * toast must NOT get silence after a money action — a wrong-but-visible banner
 * beats a successful-looking no-op. No-ops under SSR / node tests (no `document`).
 */
function fallbackBanner(kind: ToastKind, message: string): void {
  if (typeof document === "undefined" || !document.body) return;
  const el = document.createElement("div");
  el.setAttribute("role", kind === "error" ? "alert" : "status");
  el.textContent = message;
  el.style.cssText = [
    "position:fixed",
    "z-index:2147483647",
    "left:50%",
    "bottom:24px",
    "transform:translateX(-50%)",
    "max-width:90vw",
    "padding:10px 16px",
    "border-radius:10px",
    "font:14px/1.4 system-ui,sans-serif",
    "color:#fff",
    "box-shadow:0 4px 16px rgba(0,0,0,.25)",
    "background:" + (kind === "error" ? "#b4232a" : kind === "success" ? "#1c7d5a" : "#334155"),
  ].join(";");
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 6000);
}

function emit(kind: ToastKind, message: string): void {
  const w = globalThis as { __phoenixToast?: (kind: ToastKind, message: string) => void };
  if (typeof w.__phoenixToast === "function") {
    w.__phoenixToast(kind, message);
    return;
  }
  const log = kind === "error" ? console.error : console.info;
  log(`[toast:${kind}] ${message}`);
  fallbackBanner(kind, message);
}

export function toastApiError(err: unknown, fallbackKey = "errors.generic"): void {
  if (err instanceof ApiError) {
    emit("error", err.userMessageKey || err.message || fallbackKey);
    return;
  }
  // Validation helpers throw a plain Error carrying a human/i18n message —
  // surface it rather than a generic fallback. (The host app's real toast maps
  // i18n keys; this default just shows the message.)
  if (err instanceof Error && err.message) {
    emit("error", err.message);
    return;
  }
  // CIP-30 extensions reject with a plain object `{ code, info }` (NOT an Error).
  // TxSignError.UserDeclined = 2 / DataSignError.UserDeclined = 3 is what a Lace
  // or Eternl popup returns when the user hits Cancel — surface it as a calm
  // "nothing was sent", not a scary generic failure, since it is the single
  // highest-frequency branch of the whole signing flow.
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

/**
 * Show an already-translated error string. Use when the caller has i18n context
 * and knows exactly what went wrong — `toastApiError` is for raw thrown values.
 */
export function toastError(message: string): void {
  emit("error", message);
}

export function toastSuccess(key: string, _values?: Record<string, unknown>): void {
  emit("success", key);
}

export function toastInfo(key: string, _values?: Record<string, unknown>): void {
  emit("info", key);
}
