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
 * character and in order, what is signed. Each thing that breaks that is
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
 * 4. **Characters Unicode says to draw as nothing**
 *    (`\p{Default_Ignorable_Code_Point}`): the combining grapheme joiner
 *    U+034F, the Hangul fillers U+115F / U+1160 / U+3164 / U+FFA0, the
 *    Mongolian free variation selectors U+180B–180D, the Khmer inherent vowels
 *    U+17B4 / U+17B5, and the variation selectors U+FE00–FE0F and
 *    U+E0100–E01EF. Most are not `\p{Cf}`, so rule 2 does not see them. One
 *    pair is let through: U+FE0E / U+FE0F straight after an emoji
 *    (`\p{Extended_Pictographic}`) only picks text or colour presentation —
 *    "❤️" is a heart followed by U+FE0F, and refusing it would send ordinary
 *    messages to hex.
 * 5. **Blank space that pushes text out of sight**: three or more blank lines
 *    in a row, a run of more than 16 blank characters anywhere — at the
 *    start, at the end or in the middle of a line — or two or more line breaks
 *    in the blank run at the start or the end. In the middle of a line the run
 *    does not need a line break to hide what follows: the text box wraps
 *    anywhere (`overflow-wrap: anywhere` in `popup.css`), so 8 000 no-break
 *    spaces become some 3 000 px of empty lines and the end of the sentence
 *    sits below the fold. Indentation and a table's aligned columns stay well
 *    under 16. "Blank" is `INKLESS`: any
 *    `\p{White_Space}` — NBSP and the ideographic space too, not only space
 *    and tab — plus the Braille blank U+2800 and the Hangul fillers, so a
 *    line of U+2800 counts as an empty line. A combining mark with no inked
 *    letter under it (at the start, after a line break or after a blank) is
 *    blank too, so one accent every 16 spaces does not cut the run short
 *    (`inkShape`). And a line of 64 code points or more is refused when some
 *    64 of them in a row are more than 75 % blank, whatever inked character
 *    breaks the runs — 16 spaces and a dot, repeated, is 94 % (`mostlyBlank`;
 *    prose is under 20 %, aligned table columns about 60 %, and indentation
 *    sits in front of short lines, which this does not measure). A message
 *    that ends after a page of newlines reads as finished while the part that
 *    matters sits below — the screen also prints the byte count and the number
 *    of lines the message itself has (its line breaks plus one, not the lines
 *    the box wraps it into), so even what is shown as text has a size that can
 *    be checked.
 * 6. **Stacked combining marks**: more than 3 `\p{M}` in a row. A run of
 *    marks is drawn on top of one base letter and spills over the lines above
 *    and below it — over the size line, over other words. Written languages
 *    stay under it: Vietnamese in decomposed form is at most two marks on a
 *    vowel ("ệ" = e + U+0323 + U+0302), Thai a vowel and a tone mark,
 *    Devanagari a nukta and a virama.
 * 7. **Grapheme clusters longer than 16 code points**
 *    (`Intl.Segmenter`, granularity "grapheme"). One cluster is drawn as one
 *    unbreakable glyph group, and no CSS wraps inside it, so a cluster of 150
 *    virama-joined Devanagari consonants or 300 conjoining Hangul jamo runs
 *    out of the box sideways. A conjunct of three or four consonants, an old
 *    Hangul syllable or a Tibetan stack is well under 16; rule 6 already caps
 *    the marks, so what this adds is the clusters built from letters. Where
 *    `Intl.Segmenter` does not exist, the clusters cannot be measured and the
 *    payload is shown as hex alone.
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
  if (DRAWN_AS_NOTHING.test(text.replace(EMOJI_PRESENTATION, "$1"))) return null;
  if (STACKED_MARKS.test(text)) return null;
  // Not measurable means not shown as text.
  if (typeof Intl === "undefined" || typeof Intl.Segmenter !== "function") return null;
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
    if ([...segment].length > MAX_CLUSTER_CODE_POINTS) return null;
  }
  // The blank-space rules read the text as ink and no ink: a mark with no
  // inked letter under it is no ink (see `inkShape`).
  const shape = inkShape(text);
  if (BLANK_LINES.test(shape)) return null;
  if (LONG_INKLESS_RUN.test(shape)) return null;
  const edges = [LEADING_BLANK.exec(shape)?.[0] ?? "", TRAILING_BLANK.exec(shape)?.[0] ?? ""];
  if (edges.some((w) => w.length > MAX_EDGE_WHITESPACE || w.split("\n").length > 2)) return null;
  if (mostlyBlank(shape)) return null;
  return text;
}

/** One combining mark. */
const MARK = /^\p{M}$/u;
/** One inkless character (`INKLESS`, defined below). */
const INKLESS_ONE = (c: string): boolean => INKLESS_ONE_RE.test(c);

/**
 * The text with every combining mark that sits on no inked letter — at the
 * start, after a line break, or after an inkless character (directly or
 * through other marks) — replaced by a space.
 *
 * Such a mark is drawn as a lone accent over blank space, which a reader does
 * not see as text. Left as ink, one of them every 16 blanks cut every blank run
 * short of the limit: `"Sign in." + (16 spaces + U+0300) × 300 + " Also:
 * transfer all funds."` was shown as text with its end some 1 500 px down.
 * A mark on a letter keeps the letter's ink, so Vietnamese in decomposed form
 * is unchanged.
 */
function inkShape(text: string): string {
  let out = "";
  let onBlank = true;
  for (const c of text) {
    if (MARK.test(c)) {
      out += onBlank ? " " : c;
      continue;
    }
    onBlank = c === "\n" || INKLESS_ONE(c);
    out += c;
  }
  return out;
}

/** Width of the window `mostlyBlank` slides along a line, in code points. */
const DENSITY_WINDOW = 64;
/** Most blanks a window may hold: 48 of 64, i.e. 75 %. */
const MAX_BLANKS_PER_WINDOW = (DENSITY_WINDOW * 3) / 4;

/**
 * Whether some 64 code points in a row on one line are more than 75 % blank.
 *
 * The run rule alone counts blanks *in a row*, so a single inked character
 * every 16 blanks — a dot, say — resets it, and 300 of those wrap into a page
 * of near-empty lines that pushes the end of the message out of sight. Density
 * catches that whatever the inked character is: 16 blanks and a dot is 94 %.
 *
 * Measured per line, and only on lines of at least 64 code points. Whitespace
 * after a line break cannot wrap a short line into more lines, and the place a
 * reader's text is most blank by nature — indentation in front of short lines
 * of code, closing braces nested four deep — is exactly short lines: measured
 * across line breaks, five closing braces at four-space steps are 80 % blank,
 * past any threshold an attack would be held under. Ordinary prose is under
 * 20 % blank, a table with aligned columns about 60 %, so 75 % leaves room on
 * both sides. Many short blank-looking lines are the job of the blank-line
 * rule, and a column of lines each holding one dot is ink a reader can see.
 */
function mostlyBlank(shape: string): boolean {
  for (const line of shape.split("\n")) {
    const cps = [...line];
    if (cps.length < DENSITY_WINDOW) continue;
    let blanks = 0;
    for (let i = 0; i < cps.length; i++) {
      if (INKLESS_ONE(cps[i])) blanks += 1;
      if (i >= DENSITY_WINDOW && INKLESS_ONE(cps[i - DENSITY_WINDOW])) blanks -= 1;
      if (i >= DENSITY_WINDOW - 1 && blanks > MAX_BLANKS_PER_WINDOW) return true;
    }
  }
  return false;
}

/** Default-ignorable code points: Unicode's "draw as nothing" set. */
const DRAWN_AS_NOTHING = /\p{Default_Ignorable_Code_Point}/u;
/** A text or emoji presentation selector straight after an emoji — the one ignorable use let through. */
const EMOJI_PRESENTATION = /(\p{Extended_Pictographic})[\ufe0e\ufe0f]/gu;
/**
 * One character drawn with no ink, other than the newline: every
 * `\p{White_Space}` (space, tab, NBSP U+00A0, ideographic space U+3000, the
 * U+2000–200A spaces, …), the Braille blank U+2800, and the Hangul fillers
 * U+115F / U+1160 / U+3164 / U+FFA0. The fillers are already refused anywhere
 * by `DRAWN_AS_NOTHING`; they are listed so this rule does not lean on that
 * one. The other line breaks inside `\p{White_Space}` (CR, U+0085, U+2028,
 * U+2029) never reach these rules — the control and `\p{Zl}`/`\p{Zp}` rules
 * refuse them first — so the newline is the only line break counted here.
 */
const INKLESS = String.raw`(?:(?!\n)[\p{White_Space}\u2800\u115f\u1160\u3164\uffa0])`;
const INKLESS_ONE_RE = new RegExp(String.raw`^${INKLESS}$`, "u");
/** Three blank lines in a row: four line breaks with only inkless characters between them. */
const BLANK_LINES = new RegExp(String.raw`\n${INKLESS}*\n${INKLESS}*\n${INKLESS}*\n`, "u");
/** The inkless run, newlines included, at the start and at the end of the text. */
const LEADING_BLANK = new RegExp(String.raw`^(?:${INKLESS}|\n)+`, "u");
const TRAILING_BLANK = new RegExp(String.raw`(?:${INKLESS}|\n)+$`, "u");
const MAX_EDGE_WHITESPACE = 16;
/** More than `MAX_EDGE_WHITESPACE` inkless characters in a row, anywhere in the text. */
const LONG_INKLESS_RUN = new RegExp(String.raw`${INKLESS}{${MAX_EDGE_WHITESPACE + 1}}`, "u");
/** Four combining marks in a row: more than any written language stacks on one letter. */
const STACKED_MARKS = /\p{M}{4}/u;
/** The longest grapheme cluster shown as text (see rule 7 above). */
const MAX_CLUSTER_CODE_POINTS = 16;

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
