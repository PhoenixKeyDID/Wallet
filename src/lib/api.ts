/**
 * Host-contract: HTTP client.
 *
 * This is a minimal, dependency-free default so the module works standalone.
 * The PhoenixKey host app (Standard wallet / Frontend) provides its own
 * `@/lib/api` with session auth, retries and error mapping — when integrating,
 * point the `@/lib/api` alias at the host implementation instead of this file.
 *
 * The read paths in `./wallet.ts` are AUTHENTICATED: `/wallet/{did}/all` needs a
 * Bearer session and the backend enforces `caller_did == path_did`
 * (PhoenixKey-Database#116). This stub attaches no Authorization header and does
 * not unwrap the backend's `{code, message, result}` envelope — the host client
 * does both. Standalone, those calls will fail; only the host wiring makes them
 * work, which is the point of the alias.
 */

export type ApiFetchOptions = RequestInit & {
  /** Override the API base URL for this call. */
  baseUrl?: string;
  /** Skip attaching the Authorization header — public endpoints only. */
  noAuth?: boolean;
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** i18n key a UI can show; falls back to `errors.generic`. */
  readonly userMessageKey: string;

  constructor(init: { status: number; code: string; message: string; userMessageKey?: string }) {
    super(init.message);
    this.name = "ApiError";
    this.status = init.status;
    this.code = init.code;
    this.userMessageKey = init.userMessageKey ?? `errors.${init.code}`;
  }
}

/** Resolve the API base URL from env, with a safe empty-string default. */
function resolveBaseUrl(): string {
  const g = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return (
    g.process?.env?.NEXT_PUBLIC_API_BASE_URL ??
    g.process?.env?.PHOENIX_API_BASE_URL ??
    ""
  );
}

export async function apiFetch<T = unknown>(
  input: string,
  opts: ApiFetchOptions = {},
): Promise<T> {
  const { baseUrl, noAuth: _noAuth, headers, ...rest } = opts;
  const base = (baseUrl ?? resolveBaseUrl()).replace(/\/+$/, "");
  const path = input.startsWith("/") ? input : `/${input}`;
  const url = /^https?:\/\//.test(input) ? input : `${base}${path}`;

  let res: Response;
  try {
    res = await fetch(url, {
      ...rest,
      headers: { Accept: "application/json", ...(headers as Record<string, string>) },
    });
  } catch (err) {
    throw new ApiError({
      status: 0,
      code: "network_error",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  if (!res.ok) {
    throw new ApiError({
      status: res.status,
      code: `http_${res.status}`,
      message: `Request failed: ${res.status} ${res.statusText}`,
    });
  }

  return (await res.json()) as T;
}
