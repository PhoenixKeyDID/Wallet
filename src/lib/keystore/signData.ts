/**
 * CIP-30 `signData`: a CIP-8 `COSE_Sign1` over bytes a website chose, made by
 * the key that owns the address it named.
 *
 * Which key signs is decided by the address, never by the page:
 *
 * - a **reward address** (header type 14) is signed by this account's stake key.
 *   This is what proving control of a delegation looks like — a pool or a
 *   distribution service asks for it to tie a stake credential to a person.
 * - a **base address** (type 0) is signed by the payment key of that address.
 *
 * Every other shape is refused before a key is touched: a script credential has
 * no secret key (`AddressNotPK`), and an address this account did not derive is
 * not one it may speak for (`ProofGeneration`). "Did not derive" is checked on
 * the whole address, not on the key hash inside it: a base address that carries
 * this wallet's payment key next to a stranger's stake key is an address the
 * wallet does not own, and the signature would carry that address in its
 * protected header as if it did.
 *
 * Shape of the answer (CIP-30 §signData, CIP-8):
 *
 *   signature = COSE_Sign1 [ bstr(protected), { "hashed": false }, payload, sig ]
 *   protected = { 1: -8 (EdDSA), "address": <raw address bytes> }
 *   key       = COSE_Key { 1: 1 (OKP), 3: -8, -1: 6 (Ed25519), -2: <public key> }
 *   sig       = Ed25519 over ["Signature1", bstr(protected), h'', payload]
 *
 * The payload is embedded, not hashed: a verifier that rebuilds the message and
 * compares bytes — which is how the LAMP drip-pot enrolment checks it — needs
 * the bytes themselves.
 */
import "../node-globals";
import { Buffer } from "buffer";
import { bech32 } from "bech32";
import { Encoder } from "@stricahq/cbors";
import type { Account } from "./derive";

/** CIP-30 `DataSignError` codes. */
export const DATA_SIGN_CODE = { ProofGeneration: 1, AddressNotPK: 2, UserDeclined: 3 } as const;

export type SigningKeyKind = "stake" | "payment";

/** What the approval screen shows, and what `signDataCip8` signs with. */
export type DataSignPlan = {
  kind: SigningKeyKind;
  /** The address exactly as raw bytes, lowercase hex — what goes into the header. */
  addressHex: string;
  addressBech32: string;
  keyHashHex: string;
  payloadHex: string;
  /** The payload as text, only when it is valid UTF-8 with nothing unprintable in it. */
  payloadText: string | null;
};

export type DataSignRefusal = {
  code: (typeof DATA_SIGN_CODE)[keyof typeof DATA_SIGN_CODE] | -1;
  /** i18n key for the reason. */
  reason: string;
};

const HEX = /^(?:[0-9a-fA-F]{2})*$/;
/** Generous for any message a person can read on a screen; refuses a page that sends megabytes. */
const MAX_PAYLOAD_BYTES = 16 * 1024;

function addressBytes(addr: string): Buffer | null {
  if (HEX.test(addr) && addr.length >= 2) return Buffer.from(addr, "hex");
  try {
    const { words } = bech32.decode(addr, 1023);
    return Buffer.from(bech32.fromWords(words));
  } catch {
    return null;
  }
}

function bech32Of(bytes: Buffer, network: number): string {
  const type = bytes[0]! >> 4;
  const testnet = network !== 1;
  const prefix = type === 14 || type === 15 ? (testnet ? "stake_test" : "stake") : testnet ? "addr_test" : "addr";
  return bech32.encode(prefix, bech32.toWords(bytes), 1023);
}

const hexOfBech32 = (a: string) => addressBytes(a)?.toString("hex") ?? "";

/**
 * UTF-8 text a person can read, or null — in which case the screen shows hex
 * alone. Text is shown only when what is on screen is, character for
 * character and in order, what is signed. Three things break that, and each is
 * refused by Unicode class rather than by a hand-kept list, because a list is
 * only as complete as the day it was written (the last one missed U+00AD,
 * U+180E, U+2028/2029, the tag characters and Adlam):
 *
 * 1. **Control characters** other than newline and tab — a carriage return can
 *    hide a line.
 * 2. **Characters that are not drawn, or not drawn as themselves**:
 *    `\p{Cf}` (format: bidi overrides and isolates, zero-width space and
 *    joiners, soft hyphen U+00AD, Mongolian vowel separator U+180E, the
 *    byte-order mark, tag characters U+E0000–E007F, …), `\p{Zl}` / `\p{Zp}`
 *    (U+2028 / U+2029, line breaks that are not `\n`), `\p{Co}` (private use:
 *    any font may draw anything there) and `\p{Cn}` (unassigned in the
 *    engine's Unicode version — a character newer than the engine is not
 *    shown as text, which fails toward hex).
 * 3. **Right-to-left letters.** A strong R/AL character reorders the
 *    characters around it with no control character at all, so the order on
 *    screen is not the order signed. JavaScript has no Bidi_Class property, so
 *    this is a code-point range: the blocks Unicode's `DerivedBidiClass.txt`
 *    defaults to R or AL (Unicode 16), merged — Hebrew through Arabic
 *    Extended-A (U+0590–08FF), the Hebrew and Arabic presentation forms
 *    (U+FB1D–FDFF, U+FE70–FEFF), the SMP right-to-left area U+10800–10FFF
 *    (Cypriot, Aramaic, Phoenician, Kharoshthi, Avestan, Old Turkic, Hanifi
 *    Rohingya, Garay, Yezidi, Sogdian, Old Uyghur, Elymaic, …) and
 *    U+1E800–1EFFF (Mende Kikakui, Adlam, the Siyaq numbers, Arabic
 *    mathematical letters). The ranges are wider than the letters — a mark or
 *    digit inside them also sends the text to hex — which is the safe
 *    direction. A test walks every code point of every RTL `\p{Script=…}` the
 *    engine knows and checks it is covered.
 */
export function printableText(bytes: Uint8Array): string | null {
  let text: string;
  try {
    // `ignoreBOM: true` keeps a leading U+FEFF in the string. The default
    // strips it, and the bytes signed would then differ from the text shown.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(text)) return null;
  if (NOT_DRAWN_AS_ITSELF.test(text)) return null;
  if (RIGHT_TO_LEFT.test(text)) return null;
  return text;
}

/** Format, line/paragraph separator, private-use and unassigned code points. */
const NOT_DRAWN_AS_ITSELF = /[\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}]/u;

/** The blocks Unicode defaults to Bidi_Class R or AL, merged (see `printableText`). */
const RIGHT_TO_LEFT = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff\u{10800}-\u{10fff}\u{1e800}-\u{1efff}]/u;

/**
 * Decide, without signing, whether this account may answer `signData(addr, payload)`
 * and with which key. Pure: no key bytes are read, so the result can be shown on
 * screen before anyone approves anything.
 */
export function planDataSign(
  account: Account,
  addr: unknown,
  payloadHex: unknown,
): { ok: true; plan: DataSignPlan } | { ok: false; refusal: DataSignRefusal } {
  const bad = (reason: string): { ok: false; refusal: DataSignRefusal } => ({ ok: false, refusal: { code: -1, reason } });
  if (typeof addr !== "string" || addr.length === 0) return bad("cip30_sign_data_bad_address");
  if (typeof payloadHex !== "string" || !HEX.test(payloadHex)) return bad("cip30_sign_data_bad_payload");
  if (payloadHex.length / 2 > MAX_PAYLOAD_BYTES) return bad("cip30_sign_data_bad_payload");
  const bytes = addressBytes(addr);
  if (!bytes || bytes.length < 29) return bad("cip30_sign_data_bad_address");

  const type = bytes[0]! >> 4;
  const netId = bytes[0]! & 0x0f;
  const wantNet = account.network === 1 ? 1 : 0;
  const notOurs = { ok: false as const, refusal: { code: DATA_SIGN_CODE.ProofGeneration, reason: "cip30_sign_data_not_mine" } };
  const scriptAddr = { ok: false as const, refusal: { code: DATA_SIGN_CODE.AddressNotPK, reason: "cip30_sign_data_script" } };

  // Script credentials first: their answer does not depend on whose they are.
  if (type === 15 || type === 7 || type === 5 || type === 1 || type === 3) return scriptAddr;
  if (netId !== wantNet) return notOurs;

  const hex = bytes.toString("hex");
  let kind: SigningKeyKind;
  let keyHashHex: string;
  if (type === 14) {
    if (bytes.length !== 29 || hex !== hexOfBech32(account.rewardAddress)) return notOurs;
    kind = "stake";
    keyHashHex = account.stakeKeyHashHex;
  } else if (type === 0 || type === 2) {
    if (bytes.length !== 57) return notOurs;
    const owned = [...account.external, ...account.internal].find((d) => hexOfBech32(d.address) === hex);
    if (!owned) return notOurs;
    kind = "payment";
    keyHashHex = owned.keyHashHex;
  } else {
    // Pointer and enterprise addresses are never derived by this wallet, and
    // Byron addresses are not CIP-8 subjects. Not ours to speak for.
    return notOurs;
  }
  if (!account.keyByHash.has(keyHashHex)) return notOurs;

  const payload = Buffer.from(payloadHex, "hex");
  return {
    ok: true,
    plan: {
      kind,
      addressHex: hex,
      addressBech32: bech32Of(bytes, account.network),
      keyHashHex,
      payloadHex: payloadHex.toLowerCase(),
      payloadText: printableText(payload),
    },
  };
}

/** Sign a plan `planDataSign` produced for the same account. */
export function signDataCip8(account: Account, plan: DataSignPlan): { signature: string; key: string } {
  const prv = account.keyByHash.get(plan.keyHashHex);
  if (!prv) throw new Error("signing key is no longer in memory");
  const pub = prv.toPublicKey();
  if (pub.hash().toString("hex") !== plan.keyHashHex) throw new Error("signing key does not match its hash");

  const payload = Buffer.from(plan.payloadHex, "hex");
  const protectedBstr = Encoder.encode(
    new Map<number | string, unknown>([
      [1, -8],
      ["address", Buffer.from(plan.addressHex, "hex")],
    ]),
  );
  const toSign = Encoder.encode(["Signature1", protectedBstr, Buffer.alloc(0), payload]);
  const sig = prv.sign(toSign);
  const signature = Encoder.encode([
    protectedBstr,
    new Map<string, unknown>([["hashed", false]]),
    payload,
    Buffer.from(sig),
  ]).toString("hex");
  const key = Encoder.encode(
    new Map<number, unknown>([
      [1, 1],
      [3, -8],
      [-1, 6],
      [-2, Buffer.from(pub.toBytes())],
    ]),
  ).toString("hex");
  return { signature, key };
}
