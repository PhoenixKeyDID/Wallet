/**
 * PhoenixKey backend wallet API (read paths) — per `PhoenixKey-Wallet-API-v2-Feat.md`.
 *
 * The browser reads the Phoenix custody address (script enterprise, derived on
 * the backend from `did + anchor_nft_policy`) and public balances here. Custody
 * derivation needs a Rust/UPLC apply-params step, so it is NOT done in the
 * browser — we read the ready address the backend already computes.
 */
import { apiFetch } from "./api";

export type WalletKind = "phoenix" | "standard";

export type WalletEntry = {
  kind: WalletKind;
  addresses: {
    fixed?: string | null;
    active?: string | null;
    stake?: string | null;
    /** phoenix custody: the single script address. */
    custody?: string | null;
    [k: string]: string | null | undefined;
  };
  balances: {
    lovelace: number | string;
    lamp?: number | string;
    carp?: number | string;
    [k: string]: number | string | undefined;
  };
};

export type AllWalletsResponse = {
  wallets: WalletEntry[];
  magic?: { source: string; available: number | string; accrued: number | string };
};

/**
 * GET /wallet/{did}/all — combined phoenix + standard wallets.
 *
 * AUTHENTICATED. PhoenixKey-Database#116 put a Bearer-session guard on this
 * endpoint and enforces `caller_did == path_did`, so it only ever resolves the
 * CALLER'S OWN wallet — any other DID answers 401. Serving it publicly made it a
 * mass DID→address→balance linking oracle (Wallet#2).
 *
 * The host's `@/lib/api` attaches the session token; this module never holds it.
 * NOTE: `PhoenixKey-Wallet-API-v2-Feat.md` §2.3 still calls these reads
 * "public" — that text predates #116 and is being corrected.
 */
export async function getAllWallets(userDid: string): Promise<AllWalletsResponse> {
  return apiFetch<AllWalletsResponse>(
    `/wallet/${encodeURIComponent(userDid)}/all`,
    { method: "GET" },
  );
}
