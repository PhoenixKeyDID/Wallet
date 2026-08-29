/**
 * The vault — a password-encrypted container for BIP-39 entropy.
 *
 * ## What is stored, and why that is still self-custody
 *
 * "Self-custody" is about *who can use the key*, not about where the bytes
 * sit. The vault never leaves the user's device: no Phoenix server sees it, no
 * sync, no cloud backup, no telemetry. What is stored is the raw 16–32 byte
 * BIP-39 entropy, encrypted — not the derived keys — because entropy is the
 * only thing that can regenerate both the words (for a fresh paper backup) and
 * every key, and storing more would mean storing the same secret twice.
 *
 * ## The format is the security argument
 *
 * The header is plaintext, versioned, and self-describing: every KDF and
 * cipher parameter needed to decrypt is written next to the ciphertext. That
 * is deliberate. A user must be able to export this blob and decrypt it with a
 * script they wrote themselves — `scripts/decrypt-vault.mjs` in this repo is
 * exactly that: about a hundred lines, `node:crypto` for AES-GCM plus one
 * Argon2 import, readable in one sitting. A backup you can
 * only open with the software that wrote it is a backup you have to trust; one
 * whose format is published is a backup you can verify. That script shares no
 * code with this file on purpose — a bug here would otherwise reproduce there,
 * and the two would agree with each other while both being wrong.
 *
 * The header is also bound into the ciphertext as AES-GCM additional
 * authenticated data. So an attacker who can rewrite stored bytes cannot walk
 * the KDF cost down to something brute-forceable and have it still decrypt —
 * tampering with the parameters breaks authentication instead of weakening it.
 *
 * ## Choices, with the reason attached
 *
 * - **Argon2id** over PBKDF2. PBKDF2 is only serial-CPU-hard, so a GPU or an
 *   ASIC farm evaluates it in parallel for pennies. Argon2id is memory-hard:
 *   the attacker has to pay for RAM per guess. It is also the KDF this
 *   platform already ships (`@noble/hashes`), so it is not a new dependency.
 * - **AES-256-GCM via WebCrypto**, not a JS implementation. The browser's own
 *   primitive is the one that gets constant-time treatment and hardware AES
 *   instructions; a hand-rolled JS cipher in a wallet is a liability.
 * - **A random 32-byte salt per vault**, so two people with the same password
 *   do not share a key, and a precomputed table buys an attacker nothing.
 *
 * ## Measured against Lace
 *
 * Lace's current scheme ("SBV1", `lace/packages/lib/core/src/secret-box/`)
 * was read at 2026-08-29 and lands on the same numbers: Argon2id at
 * `m=19456, t=2, p=1`, a 12-byte nonce, a fixed header bound as associated
 * data, and the derived key wiped in a `finally`. Two deliberate differences:
 *
 * - **AES-256-GCM via WebCrypto** where Lace uses ChaCha20-Poly1305 in JS.
 *   Both are sound AEADs. In a browser the platform primitive is the one that
 *   gets hardware AES and the engine's own constant-time treatment, so the
 *   cipher that is *not* our code is the safer of the two.
 * - **32-byte salt**, matching Lace's, rather than the 16-byte minimum —
 *   a free win against multi-target guessing.
 *
 * One place this file is ahead, and it is worth stating because it is a real
 * limit Lace documents against itself: their key material passes through hex
 * **strings** during account derivation, which JavaScript cannot zero (their
 * own `TODO` in `in-memory-wallet-integration.ts` says so). Nothing here turns
 * a private key into a string — keys stay in `Buffer`s that `wipe()` can
 * overwrite. That narrows the window; it does not close it, and `derive.ts`
 * says as much rather than claiming more.
 */
import { argon2id } from "@noble/hashes/argon2";

/** Vault format version. Bump only for a breaking layout change. */
export const VAULT_VERSION = 1;

/**
 * Argon2id cost, following the OWASP baseline (19 MiB, 2 passes, 1 lane).
 *
 * These are written into every vault rather than assumed, so raising them
 * later does not orphan existing wallets: an old vault decrypts with its own
 * recorded parameters and can be re-sealed at the new cost on next unlock.
 */
export const DEFAULT_KDF = { alg: "argon2id", t: 2, m: 19456, p: 1 } as const;

const SALT_BYTES = 32;
const IV_BYTES = 12; // 96 bits, the size AES-GCM is specified for
const KEY_BYTES = 32; // AES-256

export type VaultKdf = { alg: "argon2id"; t: number; m: number; p: number; salt: string };
export type VaultCipher = { alg: "AES-256-GCM"; iv: string };

export type Vault = {
  v: number;
  kdf: VaultKdf;
  cipher: VaultCipher;
  /** base64 of ciphertext ‖ GCM tag. */
  ct: string;
  /** Metadata the user chose; never secret, never used as a key input. */
  label?: string;
};

export class VaultError extends Error {
  constructor(readonly key: string) {
    super(key);
    this.name = "VaultError";
  }
}

// ─── encoding helpers ─────────────────────────────────────────────────────────

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i);
  return out;
}

function randomBytes(n: number): Uint8Array {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c || typeof c.getRandomValues !== "function") {
    throw new VaultError("vault_no_secure_random");
  }
  return c.getRandomValues(new Uint8Array(n));
}

function subtle(): SubtleCrypto {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c?.subtle) throw new VaultError("vault_no_webcrypto");
  return c.subtle;
}

/**
 * The exact bytes bound as AES-GCM additional data.
 *
 * Field order is fixed here rather than left to `JSON.stringify` of a whole
 * object, because key order is what makes a JSON encoding non-canonical, and a
 * non-canonical AAD is one that fails to verify on a different engine.
 */
export function headerAad(v: number, kdf: VaultKdf, cipher: VaultCipher): Uint8Array {
  const canonical = JSON.stringify({
    v,
    kdf: { alg: kdf.alg, t: kdf.t, m: kdf.m, p: kdf.p, salt: kdf.salt },
    cipher: { alg: cipher.alg, iv: cipher.iv },
  });
  return new TextEncoder().encode(canonical);
}

// ─── key derivation ───────────────────────────────────────────────────────────

function deriveKey(password: string, kdf: VaultKdf): Uint8Array {
  if (kdf.alg !== "argon2id") throw new VaultError("vault_unsupported_kdf");
  if (!Number.isInteger(kdf.t) || kdf.t < 1) throw new VaultError("vault_bad_kdf_params");
  if (!Number.isInteger(kdf.m) || kdf.m < 8) throw new VaultError("vault_bad_kdf_params");
  if (!Number.isInteger(kdf.p) || kdf.p < 1) throw new VaultError("vault_bad_kdf_params");

  return argon2id(new TextEncoder().encode(password.normalize("NFKC")), fromBase64(kdf.salt), {
    t: kdf.t,
    m: kdf.m,
    p: kdf.p,
    dkLen: KEY_BYTES,
  });
}

async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  return subtle().importKey("raw", raw as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}

// ─── seal / open ──────────────────────────────────────────────────────────────

/** Minimum password length. Short is not "weak but the user's choice" here —
 *  the vault sits on disk, so an offline guesser gets unlimited attempts. */
export const MIN_PASSWORD_LENGTH = 10;

export function assertPasswordAcceptable(password: string): void {
  if (password.normalize("NFKC").length < MIN_PASSWORD_LENGTH) {
    throw new VaultError("vault_password_too_short");
  }
}

/** Encrypt entropy under a password. */
export async function sealVault(
  entropy: Uint8Array,
  password: string,
  opts: { label?: string; kdf?: { t: number; m: number; p: number } } = {},
): Promise<Vault> {
  assertPasswordAcceptable(password);

  const cost = opts.kdf ?? DEFAULT_KDF;
  const kdf: VaultKdf = {
    alg: "argon2id",
    t: cost.t,
    m: cost.m,
    p: cost.p,
    salt: toBase64(randomBytes(SALT_BYTES)),
  };
  const cipher: VaultCipher = { alg: "AES-256-GCM", iv: toBase64(randomBytes(IV_BYTES)) };

  const keyBytes = deriveKey(password, kdf);
  try {
    const key = await importAesKey(keyBytes);
    const ct = await subtle().encrypt(
      {
        name: "AES-GCM",
        iv: fromBase64(cipher.iv) as BufferSource,
        additionalData: headerAad(VAULT_VERSION, kdf, cipher) as BufferSource,
      },
      key,
      entropy as BufferSource,
    );
    return {
      v: VAULT_VERSION,
      kdf,
      cipher,
      ct: toBase64(new Uint8Array(ct)),
      ...(opts.label ? { label: opts.label } : {}),
    };
  } finally {
    keyBytes.fill(0);
  }
}

/**
 * Decrypt a vault back to entropy.
 *
 * A wrong password and a tampered vault both surface as `vault_bad_password`.
 * That is intentional: GCM cannot tell them apart without leaking which part
 * of the guess was right, and a message that distinguishes them would hand an
 * attacker an oracle.
 */
export async function openVault(vault: Vault, password: string): Promise<Uint8Array> {
  if (vault.v !== VAULT_VERSION) throw new VaultError("vault_unsupported_version");
  if (vault.cipher?.alg !== "AES-256-GCM") throw new VaultError("vault_unsupported_cipher");

  const keyBytes = deriveKey(password, vault.kdf);
  try {
    const key = await importAesKey(keyBytes);
    const pt = await subtle().decrypt(
      {
        name: "AES-GCM",
        iv: fromBase64(vault.cipher.iv) as BufferSource,
        additionalData: headerAad(vault.v, vault.kdf, vault.cipher) as BufferSource,
      },
      key,
      fromBase64(vault.ct) as BufferSource,
    );
    return new Uint8Array(pt);
  } catch {
    throw new VaultError("vault_bad_password");
  } finally {
    keyBytes.fill(0);
  }
}

/** Re-encrypt under a new password, keeping the same entropy. */
export async function changeVaultPassword(
  vault: Vault,
  oldPassword: string,
  newPassword: string,
): Promise<Vault> {
  const entropy = await openVault(vault, oldPassword);
  try {
    return await sealVault(entropy, newPassword, { label: vault.label });
  } finally {
    entropy.fill(0);
  }
}

/** Serialise for export/backup — the same JSON `decrypt-vault.mjs` reads. */
export function vaultToJson(vault: Vault): string {
  return JSON.stringify(vault, null, 2);
}

/** Parse an exported vault, rejecting anything structurally wrong up front. */
export function vaultFromJson(text: string): Vault {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new VaultError("vault_not_json");
  }
  const v = parsed as Partial<Vault>;
  if (
    typeof v?.v !== "number" ||
    typeof v.ct !== "string" ||
    typeof v.kdf?.salt !== "string" ||
    typeof v.cipher?.iv !== "string"
  ) {
    throw new VaultError("vault_malformed");
  }
  return v as Vault;
}
