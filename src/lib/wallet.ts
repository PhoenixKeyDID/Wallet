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
  /**
   * Backend `StandardAddresses`. A phoenix wallet carries ONLY `fixed` — the
   * spec is explicit ("1 địa chỉ, KHÔNG active/stake") and `getAllWallets()`
   * builds it as `new StandardAddresses(walletAddress, null, null)`. There is
   * no `custody` field; it was never in the contract.
   */
  addresses: {
    fixed?: string | null;
    active?: string | null;
    stake?: string | null;
    [k: string]: string | null | undefined;
  };
  /**
   * On-chain quantities arrive as JSON **strings**: the backend serialises them
   * with `ToStringSerializer` because total supply exceeds
   * `Number.MAX_SAFE_INTEGER`. Parse with `BigInt`; never compare against a
   * number literal — `"0" === 0` is false and that mistake has shipped before.
   */
  balances: {
    lovelace: string;
    lamp?: string;
    carp?: string;
    [k: string]: string | undefined;
  };
};

export type AllWalletsResponse = {
  wallets: WalletEntry[];
  /**
   * MAGIC is a Vault accounting balance, not a wallet balance. Values are
   * **nanoMAGIC** (10⁹ = 1 MAGIC), as strings for the same overflow reason.
   * Vault reads are not wired yet — the backend returns 0 with
   * `source: "vault"`, and the spec says to render "—" rather than a 0 that
   * reads as "you have none".
   */
  magic?: { source: string; available: string; accrued: string };
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
