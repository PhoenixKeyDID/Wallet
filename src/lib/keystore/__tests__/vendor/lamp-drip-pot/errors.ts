// VENDORED for tests only. Source: https://github.com/MagicLampEco/LAMP/blob/03d5c79373e402de229380d5907da00dc87abe68/Distribution/drip-pot/service/src/core/errors.ts
// Copied verbatim at LAMP 03d5c79 (2026-11-12) except where a line says CHANGED. When LAMP changes this file, re-copy it.
// errors.ts — every failure the service can report carries a stable code (SERVICE.md §2.4, §3.5,
// §6.1). Nothing is swallowed: a caller either gets a value or a DripError; an empty list and a
// failed call are two different outcomes.

/** Startup errors (§2.4): exit code 1, no HTTP port opened. */
export type StartCode =
  | "DRIPSVC-START-NETWORK"
  | "DRIPSVC-START-MAINNET-BLOCKED"
  | "DRIPSVC-START-CONFIG"
  | "DRIPSVC-START-DEPLOYMENT"
  | "DRIPSVC-START-CLOCK"
  | "DRIPSVC-START-POLICY"
  | "DRIPSVC-START-POLICY-REVOKED"
  | "DRIPSVC-START-RETURN-TARGET"
  | "DRIPSVC-START-BUDGET"
  | "DRIPSVC-START-SIGNER"
  | "DRIPSVC-START-KEEPER"
  | "DRIPSVC-START-REFSCRIPT"
  | "DRIPSVC-START-SNAPSHOT"
  | "DRIPSVC-START-STATE"
  | "DRIPSVC-START-RECONCILE";

/** Request errors (§3.5, §6.1) — each maps to exactly one HTTP status. */
export const HTTP_STATUS = {
  "DRIPSVC-BAD-REQUEST": 400,
  "DRIPSVC-SUBJECT": 400,
  "DRIPSVC-VAULT-REJECTED": 400,
  "DRIPSVC-ADDR": 400,
  "DRIPSVC-NONCE-INVALID": 401,
  "DRIPSVC-SIG-INVALID": 401,
  /** snapshot-stake-did: the rp-auth envelope is bad, or no recovered key belongs to the DID. */
  "DRIPSVC-DID-SIG-INVALID": 401,
  "DRIPSVC-NOT-ELIGIBLE": 403,
  "DRIPSVC-DID-INACTIVE": 403,
  /** snapshot-stake-did: the DID anchor is Active but not a root natural person (A-PERSON). */
  "DRIPSVC-DID-NOT-PERSON": 403,
  "DRIPSVC-CAMPAIGN-UNKNOWN": 404,
  "DRIPSVC-NOT-FOUND": 404,
  /** GET enrollments/<subject>: the route exists, this subject has no enrollment in the campaign. */
  "DRIPSVC-ENROLLMENT-NONE": 404,
  "DRIPSVC-ACCOUNT-NOT-FOUND": 404,
  "DRIPSVC-METHOD": 405,
  "DRIPSVC-ALREADY-ENROLLED": 409,
  "DRIPSVC-VAULT-TAKEN": 409,
  /** snapshot-stake-did: this DID is already bound to another stake in this campaign. */
  "DRIPSVC-DID-TAKEN": 409,
  "DRIPSVC-REGISTRATION-CLOSED": 409,
  "DRIPSVC-CAMPAIGN-FULL": 409,
  "DRIPSVC-NOTHING-DUE": 409,
  "DRIPSVC-PROOF-TX-PENDING": 202,
  "DRIPSVC-PROOF-TX-INVALID": 422,
  "DRIPSVC-STAKE-SCRIPT-UNSUPPORTED": 422,
  "DRIPSVC-NO-ADA": 422,
  "DRIPSVC-RATE-LIMIT": 429,
  "DRIPSVC-CHAIN-UNAVAILABLE": 503,
  "DRIPSVC-IDENTITY-UNAVAILABLE": 503,
  "DRIPSVC-INTERNAL": 500,
} as const;
export type RequestCode = keyof typeof HTTP_STATUS;

/** Operator-command errors (seeder / ceremony / keeper) — not HTTP, not startup. */
export type OpCode =
  | "DRIPSVC-SEED-COMPLAINT-WINDOW"
  | "DRIPSVC-SEED-LATE"
  | "DRIPSVC-SEED-MODE"
  | "DRIPSVC-SEED-BUDGET"
  | "DRIPSVC-SEED-RESERVE"
  | "DRIPSVC-SEED-SIZE"
  | "DRIPSVC-SEED-TIME"
  | "DRIPSVC-SEED-CEREMONY-LOCK"
  | "DRIPSVC-CEREMONY-WITNESS"
  | "DRIPSVC-CEREMONY-WINDOW"
  | "DRIPSVC-CEREMONY-SUBMIT"
  | "DRIPSVC-KEEPER-UNDERFUNDED"
  /** Keeper: the ledger refused a Claim whose account input is still unspent (not a race, §6.3). */
  | "DRIPSVC-KEEPER-SUBMIT"
  | "DRIPSVC-RETURN"
  | "DRIPSVC-CLI";

export type DripCode = StartCode | RequestCode | OpCode;

export class DripError extends Error {
  readonly code: DripCode;
  constructor(code: DripCode, message: string, options?: { cause?: unknown }) {
    super(`${code}: ${message}`, options);
    this.name = "DripError";
    this.code = code;
  }
  /** Message without the code prefix — what a user sees next to `code`. */
  get userMessage(): string {
    return this.message.slice(this.code.length + 2);
  }
}

export function fail(code: DripCode, message: string, cause?: unknown): never {
  throw new DripError(code, message, cause === undefined ? undefined : { cause });
}

export function isDripError(e: unknown, code?: DripCode): e is DripError {
  return e instanceof DripError && (code === undefined || e.code === code);
}

/** Chain read failed: never guess, never accept (§3.5 DRIPSVC-CHAIN-UNAVAILABLE). */
export function chainUnavailable(what: string, cause: unknown): never {
  const why = cause instanceof Error ? cause.message : String(cause);
  throw new DripError("DRIPSVC-CHAIN-UNAVAILABLE", `${what}: ${why}`, { cause });
}
