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

function emit(kind: ToastKind, message: string): void {
  const w = globalThis as { __phoenixToast?: (kind: ToastKind, message: string) => void };
  if (typeof w.__phoenixToast === "function") {
    w.__phoenixToast(kind, message);
    return;
  }
  const log = kind === "error" ? console.error : console.info;
  log(`[toast:${kind}] ${message}`);
}

export function toastApiError(err: unknown, fallbackKey = "errors.generic"): void {
  if (err instanceof ApiError) {
    emit("error", err.userMessageKey || err.message || fallbackKey);
    return;
  }
  console.error("[toastApiError] unknown error", err);
  emit("error", fallbackKey);
}

export function toastSuccess(key: string, _values?: Record<string, unknown>): void {
  emit("success", key);
}

export function toastInfo(key: string, _values?: Record<string, unknown>): void {
  emit("info", key);
}
