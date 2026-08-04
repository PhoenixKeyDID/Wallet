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
/** Trim trailing slashes without a backtracking regex. */
function stripTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === "/") end--;
  return s.slice(0, end);
}

function resolveBaseUrl(): string {
  const g = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return (
    g.process?.env?.NEXT_PUBLIC_API_BASE_URL ??
    g.process?.env?.PHOENIX_API_BASE_URL ??
    ""
  );
}

/**
 * Stable codes for the statuses callers branch on. 401 gets its own because
 * after PhoenixKey-Database#116 it means both "not signed in" and "that DID is
 * not yours" — either way the user needs a real message, not a generic fault.
 */
function statusCode(status: number): string {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "not_found";
  return `http_${status}`;
}

/**
 * The backend wraps every payload in `DataResponse { code, message, result }`
 * and signals success with `code === 1000` — a non-1000 code arrives with HTTP
 * 200, so ignoring the envelope turns a backend error into a "successful" read
 * of a body that is not the shape the caller declared.
 *
 * This stub used to `return res.json()` raw, which only appeared to work
 * because integration swaps in the host client that does unwrap. Standalone it
 * handed `{code, message, result}` to code expecting `result` — the difference
 * between test and production the host-contract layer was hiding (Wallet#4).
 */
function unwrapEnvelope<T>(body: unknown, status: number): T {
  if (body && typeof body === "object" && "code" in body) {
    const env = body as { code: unknown; message?: string; result?: unknown };
    if (typeof env.code === "number" && env.code !== 1000) {
      throw new ApiError({
        status,
        code: `code_${env.code}`,
        message: env.message ?? `Backend returned code ${env.code}`,
      });
    }
    return (env.result ?? undefined) as T;
  }
  // Not enveloped — a plain body, or an endpoint that predates the convention.
  return body as T;
}

export async function apiFetch<T = unknown>(
  input: string,
  opts: ApiFetchOptions = {},
): Promise<T> {
  const { baseUrl, noAuth: _noAuth, headers, ...rest } = opts;
  const base = stripTrailingSlashes(baseUrl ?? resolveBaseUrl());
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
      code: statusCode(res.status),
      message: `Request failed: ${res.status} ${res.statusText}`,
    });
  }

  if (res.status === 204) return undefined as T;

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ApiError({
      status: res.status,
      code: "invalid_json",
      message: "Response was not valid JSON",
    });
  }

  return unwrapEnvelope<T>(body, res.status);
}
