#!/usr/bin/env node
/**
 * Decrypt a Phoenix wallet vault export, outside the wallet.
 *
 *     node scripts/decrypt-vault.mjs my-wallet.vault.json
 *
 * ## Why this file exists
 *
 * A backup you can only open with the program that wrote it is not a backup —
 * it is a dependency. If this project disappears tomorrow, or ships a build you
 * do not trust, you must still be able to get your own key out. So the vault
 * format is published, and this is a complete, standalone reader for it: about
 * a hundred lines, doing nothing clever, that you can read end to end before
 * you run it.
 *
 * It is deliberately *not* imported from `src/`. Sharing code with the wallet
 * would mean a bug in the wallet's crypto reproduces here and the two agree
 * with each other while both being wrong. This is written against the format
 * spec, not against the implementation.
 *
 * ## What it needs
 *
 * `node:crypto` for AES-256-GCM (built in), and `@noble/hashes/argon2` for the
 * key derivation. Node has no built-in Argon2, so that one import is
 * unavoidable without shipping a second Argon2 implementation here — which
 * would be worse, not better. `@noble/hashes` is an audited, dependency-free
 * package already used by this wallet; if you would rather not trust it, any
 * other Argon2id implementation with the same parameters produces the same key.
 *
 * ## The format
 *
 * {
 *   "v": 1,
 *   "kdf":    { "alg": "argon2id", "t": 2, "m": 19456, "p": 1, "salt": "<base64, 16 bytes>" },
 *   "cipher": { "alg": "AES-256-GCM", "iv": "<base64, 12 bytes>" },
 *   "ct":     "<base64: ciphertext ‖ 16-byte GCM tag>",
 *   "label":  "optional, not secret, not used as a key input"
 * }
 *
 * key        = Argon2id(password, salt, t, m, p, dkLen=32)
 * additional = UTF-8 of the canonical header JSON (see `headerAad` below —
 *              field order matters, it is authenticated data)
 * plaintext  = AES-256-GCM-decrypt(key, iv, ct, additional)
 *            = the raw BIP-39 entropy, 16 / 20 / 24 / 28 / 32 bytes
 *
 * That entropy is the wallet. Feed it to any BIP-39 implementation to get the
 * words back, or to Cardano's Icarus master-key function
 * (PBKDF2-HMAC-SHA512("", entropy, 4096, 96) + Ed25519 clamping) to get keys.
 */
import { readFileSync } from "node:fs";
import { createDecipheriv } from "node:crypto";
import { createInterface } from "node:readline";
import { argon2id } from "@noble/hashes/argon2";

const TAG_BYTES = 16;

function die(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

/**
 * The authenticated header, byte for byte.
 *
 * Field order is written out explicitly instead of stringifying the parsed
 * object, because JSON key order is not canonical — re-serialising a parsed
 * object can reorder keys and produce different bytes, which would fail
 * authentication on a vault that is perfectly fine.
 */
function headerAad(vault) {
  const { v, kdf, cipher } = vault;
  return Buffer.from(
    JSON.stringify({
      v,
      kdf: { alg: kdf.alg, t: kdf.t, m: kdf.m, p: kdf.p, salt: kdf.salt },
      cipher: { alg: cipher.alg, iv: cipher.iv },
    }),
    "utf8",
  );
}

function askPassword() {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    // Echo off, so the password does not end up in a screenshot or a scrollback.
    const onData = (char) => {
      if (["\n", "\r", ""].includes(String(char))) process.stdin.removeListener("data", onData);
      else process.stderr.write("[2K[200Dpassword: ");
    };
    process.stdin.on("data", onData);
    rl.question("password: ", (answer) => {
      rl.close();
      process.stderr.write("\n");
      resolve(answer);
    });
  });
}

const path = process.argv[2];
if (!path) die("usage: node scripts/decrypt-vault.mjs <vault.json>");

let vault;
try {
  vault = JSON.parse(readFileSync(path, "utf8"));
} catch (e) {
  die(`cannot read ${path}: ${e.message}`);
}

if (vault.v !== 1) die(`unsupported vault version ${vault.v} (this reader understands 1)`);
if (vault.kdf?.alg !== "argon2id") die(`unsupported KDF ${vault.kdf?.alg}`);
if (vault.cipher?.alg !== "AES-256-GCM") die(`unsupported cipher ${vault.cipher?.alg}`);

const password = process.env.VAULT_PASSWORD ?? (await askPassword());
if (!password) die("no password given");

const key = argon2id(Buffer.from(password.normalize("NFKC"), "utf8"), Buffer.from(vault.kdf.salt, "base64"), {
  t: vault.kdf.t,
  m: vault.kdf.m,
  p: vault.kdf.p,
  dkLen: 32,
});

const blob = Buffer.from(vault.ct, "base64");
if (blob.length <= TAG_BYTES) die("ciphertext is too short to contain a GCM tag");
const body = blob.subarray(0, blob.length - TAG_BYTES);
const tag = blob.subarray(blob.length - TAG_BYTES);

let entropy;
try {
  const d = createDecipheriv("aes-256-gcm", Buffer.from(key), Buffer.from(vault.cipher.iv, "base64"));
  d.setAAD(headerAad(vault));
  d.setAuthTag(tag);
  entropy = Buffer.concat([d.update(body), d.final()]);
} catch {
  die("wrong password, or the vault has been altered (these are indistinguishable by design)");
}

console.log(`entropy (${entropy.length} bytes): ${entropy.toString("hex")}`);
console.error(
  "\nThis is your wallet. Anyone holding it can spend your funds.\n" +
    "Convert it back to words with any BIP-39 tool, e.g.:\n" +
    "  node -e \"import('@scure/bip39').then(async b=>{const w=(await import('@scure/bip39/wordlists/english')).wordlist;" +
    "console.log(b.entropyToMnemonic(Buffer.from(process.argv[1],'hex'),w))})\" " +
    entropy.toString("hex") +
    "\n",
);
