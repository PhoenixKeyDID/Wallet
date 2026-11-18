/**
 * PhoenixKey backend wallet API (read paths) — per `PhoenixKey-Wallet-API-v2-Feat.md`.
 *
 * The browser reads the Phoenix custody address (a script base address, derived on
 * the backend from `did + anchor_nft_policy`) and public balances here. The
 * backend serves it from its per-user wallet address field, so that field can
 * also hold a plain key address (DID registered before its anchor existed), an
 * enterprise address of an older `did_payment` build not yet resynced, or a
 * script address the user declared before anchoring. The last two are scripts
 * too, so a script shape does not prove custody; nothing here checks which
 * (Feat §3). Custody
 * derivation needs a Rust/UPLC apply-params step, so it is NOT done in the
 * browser — we read the ready address the backend already computes.
 */
import { bech32 } from "bech32";
import { apiFetch, ApiError } from "./api";

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
   * **nanogic** (10⁹ nanogic = 1 MAGIC), as strings for the same overflow reason.
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

// ---------------------------------------------------------------------------
// Imported external wallets — attach a Lace / Eternl / … address to the DID
// with a CIP-8 ownership proof (PhoenixKey-Database#738).
//
// The wallet extension signs; this module never sees its key. What the server
// checks, and therefore what this code must produce byte for byte:
//   - payload = ATTACH_PREFIX ++ frame(did) ++ frame(address) ++ frame(nonce)
//     ++ frame(expiresAt), each frame a 4-byte big-endian length then UTF-8;
//   - `address` is the bech32 string exactly as sent in the body;
//   - `nonce` is hex, at least 16 bytes, single use per DID;
//   - `expiresAt` is Unix seconds in decimal digits, in the future and at most
//     10 minutes after the server receives it;
//   - the address pays to a key hash, and the COSE_Key hashes to it.
// ---------------------------------------------------------------------------

/** Domain prefix of the attach message; a signature here is useless elsewhere. */
export const IMPORT_ATTACH_PREFIX = "PHOENIXKEY_WALLET_IMPORT_ATTACH:";

/**
 * How long the signed message stays valid. The server refuses more than ten
 * minutes; five leaves room for a slow approval popup and a few minutes of clock
 * drift between this device and the server, on either side.
 */
export const IMPORT_PROOF_LIFETIME_SEC = 5 * 60;

/** Bytes of nonce randomness. The server's floor is 16. */
export const IMPORT_NONCE_BYTES = 16;

/** Backend error codes this flow answers with its own message. */
export const IMPORT_ERROR = {
  proofInvalid: 1387,
  alreadyAttached: 1388,
  proofExpired: 1389,
  nonceReused: 3006,
} as const;

export type ImportedWallet = {
  address: string;
  kind: "imported";
  /** ISO-8601 timestamp from the server. */
  attached_at: string;
};

const utf8 = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error("not a hex string");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * The exact bytes the server rebuilds and compares against the COSE payload.
 * Any drift here — field order, a separator, the expiry as a float — and every
 * proof is refused with 1387, so this function is pinned by a fixed vector.
 */
export function importAttachMessage(
  userDid: string,
  address: string,
  nonce: string,
  expiresAt: number,
): Uint8Array {
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) {
    throw new Error("expiresAt must be a positive whole number of seconds");
  }
  const fields = [userDid, address, nonce, String(expiresAt)].map((f) => utf8.encode(f));
  const prefix = utf8.encode(IMPORT_ATTACH_PREFIX);
  const out = new Uint8Array(prefix.length + fields.reduce((n, f) => n + 4 + f.length, 0));
  out.set(prefix, 0);
  let at = prefix.length;
  for (const f of fields) {
    new DataView(out.buffer).setUint32(at, f.length, false);
    out.set(f, at + 4);
    at += 4 + f.length;
  }
  return out;
}

export type ImportAddressCheck =
  | { ok: true; bech32: string; network: 0 | 1 }
  | { ok: false; reason: "not_an_address" | "script_payment" | "unsupported_type" };

/**
 * Read a CIP-30 address (hex of the raw address bytes) and decide whether the
 * server could accept a proof for it, before asking the user to sign anything.
 *
 * The server only attaches an address whose payment part is a key hash: the
 * proof is a signature by that key. Header types 0, 2, 4 and 6 have a key
 * payment part; 1, 3, 5 and 7 a script; Byron (8) and reward (14, 15) addresses
 * are not payment addresses the server takes at all.
 */
export function checkImportAddress(addressHex: string): ImportAddressCheck {
  let bytes: Uint8Array;
  try {
    bytes = fromHex(addressHex);
  } catch {
    return { ok: false, reason: "not_an_address" };
  }
  if (bytes.length < 29) return { ok: false, reason: "not_an_address" };
  const type = bytes[0] >> 4;
  const net = bytes[0] & 0x0f;
  if (type === 1 || type === 3 || type === 5 || type === 7) {
    return { ok: false, reason: "script_payment" };
  }
  if (type !== 0 && type !== 2 && type !== 4 && type !== 6) {
    return { ok: false, reason: "unsupported_type" };
  }
  if (net !== 0 && net !== 1) return { ok: false, reason: "unsupported_type" };
  const prefix = net === 1 ? "addr" : "addr_test";
  return { ok: true, bech32: bech32.encode(prefix, bech32.toWords(bytes), 1023), network: net };
}

/** A fresh single-use nonce, hex. Throws when the platform has no CSPRNG. */
export function newImportNonce(): string {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (!c || typeof c.getRandomValues !== "function") {
    throw new Error("No secure random source on this platform");
  }
  return toHex(c.getRandomValues(new Uint8Array(IMPORT_NONCE_BYTES)));
}

/** The part of a CIP-30 wallet this flow needs: one `signData` call. */
export type DataSigner = {
  signData(addr: string, payload: string): Promise<{ signature: string; key: string }>;
};

export type AttachProof = {
  address: string;
  cose_sign1: string;
  cose_key: string;
  nonce: string;
  expires_at: number;
};

/**
 * Ask the external wallet to sign the attach message for `addressHex`.
 * The wallet shows the user what it signs; nothing is sent to the server here.
 *
 * `addressHex` goes to `signData` as raw address hex, the form CIP-30 defines and
 * every wallet accepts; it also becomes the COSE `address` header the server
 * compares with the bech32 in the body, which is the same bytes.
 */
export async function signImportProof(
  wallet: DataSigner,
  userDid: string,
  addressHex: string,
  now: () => number = () => Math.floor(Date.now() / 1000),
): Promise<AttachProof> {
  const checked = checkImportAddress(addressHex);
  if (!checked.ok) throw new Error(`address cannot be attached: ${checked.reason}`);
  const nonce = newImportNonce();
  const expiresAt = now() + IMPORT_PROOF_LIFETIME_SEC;
  const payload = toHex(importAttachMessage(userDid, checked.bech32, nonce, expiresAt));
  const signed = await wallet.signData(addressHex, payload);
  if (
    !signed ||
    typeof signed.signature !== "string" ||
    typeof signed.key !== "string" ||
    !/^([0-9a-fA-F]{2})+$/.test(signed.signature) ||
    !/^([0-9a-fA-F]{2})+$/.test(signed.key)
  ) {
    // A wallet that answers with something else has not signed; sending its
    // reply on would only turn into a 1387 the user cannot act on.
    throw new Error("wallet returned a signData result that is not hex signature + key");
  }
  return {
    address: checked.bech32,
    cose_sign1: signed.signature,
    cose_key: signed.key,
    nonce,
    expires_at: expiresAt,
  };
}

/** POST /wallet/imported/attach — the session must belong to `userDid`. */
export async function attachImportedWallet(proof: AttachProof): Promise<void> {
  await apiFetch<void>("/wallet/imported/attach", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(proof),
  });
}

/** DELETE /wallet/imported/{address} — only the session DID's own wallets. */
export async function detachImportedWallet(address: string): Promise<void> {
  await apiFetch<void>(`/wallet/imported/${encodeURIComponent(address)}`, { method: "DELETE" });
}

/**
 * GET /wallet/imported — the session DID's attached wallets, oldest first.
 * A body that is not `{wallets: [...]}` throws: an empty list and a broken read
 * must not look the same.
 */
export async function listImportedWallets(): Promise<ImportedWallet[]> {
  const res = await apiFetch<{ wallets?: unknown }>("/wallet/imported", { method: "GET" });
  if (!res || !Array.isArray(res.wallets)) {
    throw new Error("GET /wallet/imported returned no wallets array");
  }
  return res.wallets.map((w) => {
    const e = w as Partial<ImportedWallet>;
    if (typeof e?.address !== "string" || typeof e?.attached_at !== "string") {
      throw new Error("GET /wallet/imported returned an entry without address/attached_at");
    }
    return { address: e.address, kind: "imported", attached_at: e.attached_at };
  });
}

/**
 * Which message an attach / detach failure deserves. Reads the backend's integer
 * code (`rawCode`, set by both this repo's client and the host's), so a 403 that
 * means "this proof is wrong" is not shown as "you are signed out".
 */
export type ImportFailure =
  | "proof_invalid"
  | "already_attached"
  | "proof_expired"
  | "nonce_reused"
  | "unauthorized"
  | "not_found"
  | "other";

export function classifyImportError(err: unknown): ImportFailure {
  if (!(err instanceof ApiError)) return "other";
  switch (err.rawCode) {
    case IMPORT_ERROR.proofInvalid:
      return "proof_invalid";
    case IMPORT_ERROR.alreadyAttached:
      return "already_attached";
    case IMPORT_ERROR.proofExpired:
      return "proof_expired";
    case IMPORT_ERROR.nonceReused:
      return "nonce_reused";
  }
  if (err.status === 401 || err.status === 403) return "unauthorized";
  if (err.status === 404) return "not_found";
  return "other";
}
