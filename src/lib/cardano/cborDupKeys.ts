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
 * So this walks the bytes directly and throws the moment one map carries the
 * same key twice, by the key's encoded bytes — the only identity the ledger and
 * a canonical encoder agree on. It is deliberately independent of the decoder:
 * it never asks what a value decodes to, only how the bytes are shaped.
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
      // map — the whole point. Each key's encoded bytes must be unique.
      const seen = new Set<string>();
      const note = (keyStart: number, keyEnd: number): void => {
        let hex = "";
        for (let i = keyStart; i < keyEnd; i += 1) {
          hex += (bytes[i] as number).toString(16).padStart(2, "0");
        }
        if (seen.has(hex)) {
          throw new DuplicateMapKeyError(`a map repeats the key 0x${hex}`);
        }
        seen.add(hex);
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
