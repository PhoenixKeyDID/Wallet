/**
 * Refuse a CBOR value that has a map with a duplicate key — read off the RAW
 * bytes, before any decoder gets to pick a winner.
 *
 * ## Why this exists
 *
 * `@stricahq/cbors` decodes a map into a `Map`, and when the same key appears
 * twice it keeps the LATER value and drops the earlier one silently. That turns
 * a transaction body shaped `{… 4:[cert], 4:[] }` into one a reader describes as
 * having no certificate: `body.get(4)` is `[]`, the cert is gone, and the
 * approval screen and the signer both read through that same decoder. The ledger
 * (Conway) rejects duplicate map keys, so the attack only works until it reaches
 * a node — but a wallet that leans on the node to catch what its own screen
 * showed wrong has already signed the thing. The same move hides mint (key 9),
 * network id (15), outputs (1), collateral (13): put the dangerous value first
 * and a harmless duplicate second, and the screen reads the harmless one.
 *
 * ## What counts as "the same key"
 *
 * The identity this walker compares two keys by MUST equal the identity the
 * decoder keys its `Map` on — otherwise it cannot catch what the decoder
 * collapses, which is its entire purpose. CBOR admits many encodings of one
 * value, and the decoder folds several of them together: comparing raw encoded
 * bytes would miss every pair where two different byte strings decode to the
 * same key. So the identity is NORMALIZED, and normalized to match THIS decoder
 * (`@stricahq/cbors`), measured, not what a canonical encoder would emit:
 *
 *   - Integer keys (major 0 and 1): every width of the same integer decodes to
 *     the same key (`0x04`, `0x1804`, `0x190004`, `0x1a00000004`,
 *     `0x1b…04` all → `4`; `0x20` and `0x3800` both → -1). Identity is the
 *     major plus the MINIMAL big-endian argument bytes, computed from the bytes
 *     (never through a JS number, so an 8-byte argument keeps full precision).
 *   - Text-string keys (major 3): a definite string and an indefinite/chunked
 *     string of the same content decode to the same key (`0x6161` and
 *     `0x7f6161ff` both → "a"). Identity is the concatenated payload bytes.
 *   - Float keys (major 7, 2/4/8-byte): encodings of the same value decode to
 *     the same number, and an integer-valued float decodes to the same number
 *     as the integer of that value (`0xf94400` → 4, which collides with `0x04`).
 *     Identity folds an integer-valued float onto the integer identity.
 *   - Byte-string keys (major 2), tags (major 6), arrays/maps as keys (4/5) and
 *     simple values (major 7 false/true/null): the decoder keeps these distinct
 *     unless the encodings are byte-identical (it compares them by object
 *     identity, not value). Raw encoded bytes are the right identity for these,
 *     and are at least as strict as the decoder — a byte-identical pair is
 *     refused, which the decoder keeps as two entries, so nothing is missed.
 *
 * Normalizing can only make the walker refuse MORE than the decoder collapses
 * (for huge integers the decoder hands back distinct objects while this folds
 * equal values together), never less — and a well-formed Cardano transaction
 * never carries two keys that normalize alike, so nothing legitimate trips it.
 *
 * ## Scope
 *
 * It walks the whole value recursively, so a duplicate anywhere — the body, a
 * map-form output, an auxiliary-data map, a witness map — is caught, not only
 * the top level. A well-formed Cardano transaction never has a duplicate map
 * key, so nothing legitimate trips it.
 */

/** Thrown when a map carries the same key twice. The callers translate it. */
export class DuplicateMapKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DuplicateMapKeyError";
  }
}

/** The number of bytes a CBOR item head occupies for a given additional-info. */
function headLen(ai: number): number {
  return ai < 24 ? 1 : ai === 24 ? 2 : ai === 25 ? 3 : ai === 26 ? 5 : ai === 27 ? 9 : 1;
}

/** The argument value in a definite-length item head, read as a Number. Only
 * used for string/chunk LENGTHS here, never for an integer key's identity. */
function argValue(bytes: Uint8Array, start: number): number {
  const ai = (bytes[start] as number) & 0x1f;
  if (ai < 24) return ai;
  if (ai === 24) return bytes[start + 1] as number;
  if (ai === 25) return ((bytes[start + 1] as number) << 8) | (bytes[start + 2] as number);
  if (ai === 26) {
    return (
      (bytes[start + 1] as number) * 0x1000000 +
      ((bytes[start + 2] as number) << 16) +
      ((bytes[start + 3] as number) << 8) +
      (bytes[start + 4] as number)
    );
  }
  if (ai === 27) {
    let v = 0;
    for (let i = 0; i < 8; i += 1) v = v * 256 + (bytes[start + 1 + i] as number);
    return v;
  }
  return 0;
}

/** The encoded bytes `bytes[start..end)` as hex — the raw identity, for the key
 * types the decoder does not collapse. */
function rawHex(bytes: Uint8Array, start: number, end: number): string {
  let hex = "";
  for (let i = start; i < end; i += 1) hex += (bytes[i] as number).toString(16).padStart(2, "0");
  return hex;
}

/**
 * The minimal big-endian hex of a major-0/1 head's argument — the same string
 * for every width that encodes the same integer. Works on the bytes, so an
 * 8-byte argument never loses precision through a JS number. `null` for an
 * indefinite/reserved head (not a well-formed integer), which falls back to the
 * raw bytes so the decoder, not this, decides the value is unreadable.
 */
function minimalArgHex(bytes: Uint8Array, start: number): string | null {
  const ai = (bytes[start] as number) & 0x1f;
  if (ai < 24) return ai === 0 ? "00" : ai.toString(16).padStart(2, "0");
  if (ai > 27) return null; // 28..30 reserved, 31 indefinite — not an integer
  const argStart = start + 1;
  const argEnd = argStart + (ai === 24 ? 1 : ai === 25 ? 2 : ai === 26 ? 4 : 8);
  let i = argStart;
  while (i < argEnd && bytes[i] === 0) i += 1;
  let hex = "";
  for (; i < argEnd; i += 1) hex += (bytes[i] as number).toString(16).padStart(2, "0");
  return hex === "" ? "00" : hex;
}

/** The minimal big-endian hex of a non-negative BigInt, even-length and with no
 * leading zero byte — the same form `minimalArgHex` produces. */
function minHexFromBig(b: bigint): string {
  if (b === BigInt(0)) return "00";
  let h = b.toString(16);
  if (h.length % 2 === 1) h = `0${h}`;
  return h;
}

/** The integer identity for a value the decoder stored as a plain number: the
 * same string an integer key of that value gets, so an integer-valued float
 * folds onto its integer. Negatives use major 1's argument (`-value - 1`). */
function intIdentityFromValue(v: number): string {
  const vb = BigInt(v);
  if (vb >= BigInt(0)) return `0:${minHexFromBig(vb)}`;
  return `1:${minHexFromBig(-vb - BigInt(1))}`;
}

/** The IEEE value of a major-7 float head (half, single, or double). */
function floatValue(bytes: Uint8Array, start: number, ai: number): number {
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset + start + 1,
    ai === 25 ? 2 : ai === 26 ? 4 : 8,
  );
  if (ai === 26) return view.getFloat32(0, false);
  if (ai === 27) return view.getFloat64(0, false);
  // Half precision — the DataView has no reader for it.
  const h = view.getUint16(0, false);
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >> 10) & 0x1f;
  const mant = h & 0x3ff;
  if (exp === 0) return sign * Math.pow(2, -14) * (mant / 1024);
  if (exp === 0x1f) return mant ? NaN : sign * Infinity;
  return sign * Math.pow(2, exp - 15) * (1 + mant / 1024);
}

/** The payload bytes (hex) of a definite-length string head at `start`. */
function definiteStrPayloadHex(bytes: Uint8Array, start: number): string {
  const ai = (bytes[start] as number) & 0x1f;
  const begin = start + headLen(ai);
  const end = begin + argValue(bytes, start);
  return rawHex(bytes, begin, end);
}

/** The logical content (hex) of a text-string key: the decoder builds the same
 * string from a definite head and from an indefinite run of chunks, so the
 * identity is the concatenated chunk payloads. */
function textContentHex(bytes: Uint8Array, start: number): string {
  const ai = (bytes[start] as number) & 0x1f;
  if (ai !== 31) return definiteStrPayloadHex(bytes, start);
  let p = start + 1;
  let hex = "";
  for (;;) {
    if (bytes[p] === 0xff) return hex;
    hex += definiteStrPayloadHex(bytes, p);
    const cai = (bytes[p] as number) & 0x1f;
    p = p + headLen(cai) + argValue(bytes, p);
  }
}

/**
 * The identity two map keys are compared by — normalized to match what
 * `@stricahq/cbors` collapses (see the file header). `start`..`end` is the key's
 * already-walked span, so the bytes are known well-formed.
 */
function keyIdentity(bytes: Uint8Array, start: number, end: number): string {
  const initial = bytes[start] as number;
  const major = initial >> 5;
  const ai = initial & 0x1f;
  if (major === 0 || major === 1) {
    const arg = minimalArgHex(bytes, start);
    return arg === null ? rawHex(bytes, start, end) : `${major}:${arg}`;
  }
  if (major === 3) {
    return `3:${textContentHex(bytes, start)}`;
  }
  if (major === 7 && (ai === 25 || ai === 26 || ai === 27)) {
    const v = floatValue(bytes, start, ai);
    return Number.isFinite(v) && Number.isInteger(v) ? intIdentityFromValue(v) : `7f:${v}`;
  }
  // Byte strings, tags, arrays/maps as keys, and simple values: the decoder
  // keeps these distinct unless byte-identical, so raw bytes are the identity.
  return rawHex(bytes, start, end);
}

/**
 * Walk one CBOR item at `pos`, returning the offset just past it. Throws
 * `DuplicateMapKeyError` on the first map with a repeated key, and a plain
 * `Error` on bytes that are not CBOR this walker can follow (a shape the
 * decoders would reject anyway — the callers already refuse what they cannot
 * read).
 */
function walk(bytes: Uint8Array, pos: number): number {
  if (pos >= bytes.length) throw new Error("CBOR ends early");
  const initial = bytes[pos] as number;
  const major = initial >> 5;
  const ai = initial & 0x1f;
  let p = pos + 1;

  // The argument in the item head: a length, a count, or the integer itself.
  // `null` marks an indefinite-length item (ai 31), handled per major type.
  let argument: number | null;
  if (ai < 24) {
    argument = ai;
  } else if (ai === 24) {
    if (p + 1 > bytes.length) throw new Error("CBOR ends early");
    argument = bytes[p] as number;
    p += 1;
  } else if (ai === 25) {
    if (p + 2 > bytes.length) throw new Error("CBOR ends early");
    argument = ((bytes[p] as number) << 8) | (bytes[p + 1] as number);
    p += 2;
  } else if (ai === 26) {
    if (p + 4 > bytes.length) throw new Error("CBOR ends early");
    argument =
      (bytes[p] as number) * 0x1000000 +
      ((bytes[p + 1] as number) << 16) +
      ((bytes[p + 2] as number) << 8) +
      (bytes[p + 3] as number);
    p += 4;
  } else if (ai === 27) {
    if (p + 8 > bytes.length) throw new Error("CBOR ends early");
    // An 8-byte argument. Only major types 0/1 (a bignum-ish integer) and 7
    // (a double) use it here; for 2/3/4/5 it would be a length larger than any
    // real transaction, so reading it as a Number is safe — the item would run
    // past the buffer and the length checks below would throw.
    let v = 0;
    for (let i = 0; i < 8; i += 1) v = v * 256 + (bytes[p + i] as number);
    argument = v;
    p += 8;
  } else if (ai === 31) {
    argument = null; // indefinite length
  } else {
    throw new Error(`CBOR reserved additional-info ${ai}`);
  }

  switch (major) {
    case 0: // unsigned integer
    case 1: // negative integer
      return p;
    case 7: // simple / float / break — the argument bytes are already consumed
      return p;
    case 2: // byte string
    case 3: // text string
      if (argument === null) {
        // Indefinite: a run of definite-length strings of the same major, then
        // a break (0xff).
        for (;;) {
          if (p >= bytes.length) throw new Error("CBOR ends early");
          if (bytes[p] === 0xff) return p + 1;
          const chunkMajor = (bytes[p] as number) >> 5;
          if (chunkMajor !== major) throw new Error("CBOR bad indefinite string chunk");
          p = walk(bytes, p);
        }
      }
      if (p + argument > bytes.length) throw new Error("CBOR ends early");
      return p + argument;
    case 4: // array
      if (argument === null) {
        for (;;) {
          if (p >= bytes.length) throw new Error("CBOR ends early");
          if (bytes[p] === 0xff) return p + 1;
          p = walk(bytes, p);
        }
      }
      for (let i = 0; i < argument; i += 1) p = walk(bytes, p);
      return p;
    case 5: {
      // map — the whole point. Each key's NORMALIZED identity must be unique;
      // the normalization is what lets this catch a duplicate the decoder would
      // collapse behind two different encodings (see the file header).
      const seen = new Set<string>();
      const note = (keyStart: number, keyEnd: number): void => {
        const id = keyIdentity(bytes, keyStart, keyEnd);
        if (seen.has(id)) {
          throw new DuplicateMapKeyError(`a map repeats the key ${id}`);
        }
        seen.add(id);
      };
      if (argument === null) {
        for (;;) {
          if (p >= bytes.length) throw new Error("CBOR ends early");
          if (bytes[p] === 0xff) return p + 1;
          const keyStart = p;
          p = walk(bytes, p);
          note(keyStart, p);
          p = walk(bytes, p);
        }
      }
      for (let i = 0; i < argument; i += 1) {
        const keyStart = p;
        p = walk(bytes, p);
        note(keyStart, p);
        p = walk(bytes, p);
      }
      return p;
    }
    case 6: // tag — one item follows
      return walk(bytes, p);
    default:
      throw new Error(`CBOR major type ${major}`);
  }
}

/**
 * Throw if any map inside this CBOR value has a duplicate key. Returns normally
 * when there is none. Only the duplicate-key case is a `DuplicateMapKeyError`;
 * bytes that cannot be walked raise a plain `Error`, which the callers treat the
 * same as any other unreadable transaction.
 */
export function assertNoDuplicateMapKeys(bytes: Uint8Array): void {
  walk(bytes, 0);
}
