/**
 * BIP-39 recovery phrases.
 *
 * This is the one file in the wallet that creates a secret out of nothing, so
 * it is deliberately thin: generate entropy, turn entropy into words, turn
 * words back into entropy. Everything else — keys, addresses, signatures —
 * is a pure function of the entropy and lives in `derive.ts`.
 *
 * Cardano does NOT use the BIP-39 *seed* (the PBKDF2-with-passphrase output).
 * It feeds the raw **entropy** into the Icarus master-key function (CIP-3).
 * That is why this module hands back entropy rather than a seed, and why a
 * BIP-39 passphrase ("25th word") is not offered: Icarus has no slot for it,
 * and pretending otherwise would produce a phrase that silently restores a
 * different wallet in Lace, Eternl or Yoroi.
 */
import { generateMnemonic, mnemonicToEntropy, entropyToMnemonic, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";

/** Word counts we will produce or accept, with the entropy each one carries. */
const STRENGTH_BY_WORDS: Record<number, number> = {
  12: 128,
  15: 160,
  18: 192,
  21: 224,
  24: 256,
};

export type WordCount = 12 | 15 | 18 | 21 | 24;

/** Thrown for anything wrong with a phrase the user typed. `key` is an i18n key. */
export class MnemonicError extends Error {
  constructor(readonly key: string) {
    super(key);
    this.name = "MnemonicError";
  }
}

/**
 * Create a brand-new recovery phrase.
 *
 * Defaults to 24 words (256 bits). A 12-word phrase is not broken — 128 bits
 * is beyond brute force — but it is the floor, and this wallet has no reason
 * to ship the floor as its default when the cost of the ceiling is twelve
 * more words on a piece of paper.
 *
 * Randomness comes from `crypto.getRandomValues` by way of `@noble/hashes`.
 * There is no fallback to `Math.random`: if the platform cannot produce
 * cryptographic randomness, generating a wallet here would be actively
 * dangerous, so it throws instead.
 */
export function createMnemonic(words: WordCount = 24): string {
  const strength = STRENGTH_BY_WORDS[words];
  if (!strength) throw new MnemonicError("mnemonic_bad_word_count");
  assertSecureRandom();
  return generateMnemonic(wordlist, strength);
}

/**
 * Fail loudly when there is no CSPRNG rather than quietly producing a wallet
 * whose key an attacker can guess. A wallet generated from weak randomness
 * looks exactly like a good one until the money is gone.
 */
function assertSecureRandom(): void {
  const c = (globalThis as { crypto?: { getRandomValues?: unknown } }).crypto;
  if (!c || typeof c.getRandomValues !== "function") {
    throw new MnemonicError("mnemonic_no_secure_random");
  }
}

/** Collapse the whitespace and case differences that copy-paste introduces. */
export function normalizeMnemonic(input: string): string {
  return input.normalize("NFKD").trim().toLowerCase().split(/\s+/u).join(" ");
}

/**
 * Validate a phrase and return its entropy.
 *
 * The distinct error keys matter for the UI: "that is not a real word" and
 * "the words are real but the checksum fails" send the user to two different
 * places — a typo in one word, versus words in the wrong order. Collapsing
 * both into "invalid phrase" is what makes recovery feel hopeless.
 */
export function mnemonicToEntropyBytes(input: string): Uint8Array {
  const phrase = normalizeMnemonic(input);
  const words = phrase.split(" ").filter(Boolean);

  if (words.length === 0) throw new MnemonicError("mnemonic_empty");
  if (!STRENGTH_BY_WORDS[words.length]) throw new MnemonicError("mnemonic_bad_word_count");

  const unknown = words.filter((w) => !wordlist.includes(w));
  if (unknown.length > 0) throw new MnemonicError("mnemonic_unknown_word");

  if (!validateMnemonic(phrase, wordlist)) throw new MnemonicError("mnemonic_bad_checksum");

  return mnemonicToEntropy(phrase, wordlist);
}

/** Render entropy back into words — used to show a stored wallet's backup. */
export function entropyToMnemonicPhrase(entropy: Uint8Array): string {
  return entropyToMnemonic(entropy, wordlist);
}

/** True when the word is in the BIP-39 English list — for per-field UI hints. */
export function isWordInList(word: string): boolean {
  return wordlist.includes(word.normalize("NFKD").trim().toLowerCase());
}

/**
 * Words starting with `prefix`, for an autocomplete during restore.
 *
 * Restore is where people mistype, and a suggestion list turns a dead end into
 * a correction. It leaks nothing: the list is a public constant compiled into
 * the bundle, identical for every wallet in the world.
 */
export function suggestWords(prefix: string, limit = 5): string[] {
  const p = prefix.normalize("NFKD").trim().toLowerCase();
  if (p.length === 0) return [];
  const out: string[] = [];
  for (const w of wordlist) {
    if (w.startsWith(p)) {
      out.push(w);
      if (out.length >= limit) break;
    }
  }
  return out;
}
