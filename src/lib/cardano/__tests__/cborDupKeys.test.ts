import { describe, it, expect } from "vitest";
import { assertNoDuplicateMapKeys, DuplicateMapKeyError } from "../cborDupKeys";

// These exercise the raw-bytes walker directly, independent of any encoder, so
// a CBOR shape a real transaction can legitimately carry is proven NOT to throw.
// The danger the walker guards against is a duplicate map key; the danger it
// must NOT introduce is refusing a well-formed value it merely cannot follow.
// Each `hex` below is hand-built so the exact encoding — not what an encoder
// happens to emit — is what gets walked.
const walk = (hex: string): void => assertNoDuplicateMapKeys(Buffer.from(hex, "hex"));

describe("cborDupKeys — well-formed CBOR is never mistaken for a duplicate", () => {
  // Every case here is valid CBOR with NO repeated map key, so none may throw.
  const accepted: [string, string][] = [
    ["unsigned int", "01"],
    ["negative int", "20"],
    ["1-byte-arg uint", "1818"],
    ["2-byte-arg uint", "190100"],
    ["4-byte-arg uint", "1a000f4240"],
    ["8-byte-arg uint", "1b0000000100000000"],
    ["definite array", "83010203"],
    ["indefinite array", "9f010203ff"],
    ["nested indefinite array", "9f9f0102ff03ff"],
    ["definite map distinct keys", "a3010203040506"],
    ["indefinite map distinct keys", "bf01020304ff"],
    ["definite byte string", "43010203"],
    ["definite text string", "6361626f"],
    ["chunked (indefinite) byte string", "5f42010243030405ff"],
    ["chunked (indefinite) text string", "7f616161626163ff"],
    ["tag 0 over text", "c06474657874"],
    ["bignum tag 2 over byte string", "c243010000"],
    ["tag 258 (Conway set) over array", "d9010283010203"],
    ["nested tag over map", "d81aa1010200"],
    ["float16", "f93c00"],
    ["float32", "fa3fc00000"],
    ["float64", "fb400921fb54442d18"],
    ["simple false/true/null/undefined in array", "84f4f5f6f7"],
    // A transaction-shaped value: 4-element array whose body map wraps its
    // input list in the Conway set tag 258 and carries distinct integer keys.
    [
      "tx-shaped body with set-tagged inputs",
      "84" + // array(4)
        "a3" + // body map(3)
        "00" + "d90102" + "81" + "82" + "5820" + "aa".repeat(32) + "00" + // 0: set [ [txid,0] ]
        "01" + "81" + "82" + "5839" + "00" + "cc".repeat(56) + "1a001e8480" + // 1: outputs
        "02" + "1a00030d40" + // 2: fee
        "a0" + // witnesses map(0)
        "f5" + // is_valid true
        "f6", // auxiliary null
    ],
  ];

  for (const [name, hex] of accepted) {
    it(`accepts ${name}`, () => {
      expect(() => walk(hex)).not.toThrow();
    });
  }

  it("refuses an integer key repeated in a definite map", () => {
    // a2 (map 2 pairs) 04 80 (key 4 -> []) 04 81 00 (key 4 -> [0]) — key 4 twice.
    expect(() => walk("a2" + "04" + "80" + "04" + "81" + "00")).toThrow(DuplicateMapKeyError);
  });

  it("refuses an integer key repeated in an INDEFINITE map", () => {
    // bf 04 80 04 81 00 ff — key 4 twice, indefinite map.
    expect(() => walk("bf" + "04" + "80" + "04" + "81" + "00" + "ff")).toThrow(DuplicateMapKeyError);
  });

  it("refuses a repeated key in a map NESTED inside an array", () => {
    // 81 (array 1) a2 04 80 04 80 — inner map repeats key 4.
    expect(() => walk("81" + "a2" + "04" + "80" + "04" + "80")).toThrow(DuplicateMapKeyError);
  });

  it("refuses a repeated TEXT key", () => {
    // a2 6161 00 6161 01 — text key "a" twice.
    expect(() => walk("a2" + "6161" + "00" + "6161" + "01")).toThrow(DuplicateMapKeyError);
  });

  it("refuses a repeated key inside a set-tagged, tx-shaped body", () => {
    const hex =
      "84" +
      "a2" + // body map declared with 2 pairs, but key 4 appears in both
      "04" + "80" + // 4: []  (empty cert list, harmless-looking)
      "04" + "81" + "82" + "00" + "82" + "00" + "581c" + "bb".repeat(28) + // 4: [cert] again
      "a0" +
      "f5" +
      "f6";
    expect(() => walk(hex)).toThrow(DuplicateMapKeyError);
  });
});

// The decoder (`@stricahq/cbors`) folds several CBOR encodings of the same key
// together and keeps the LATER value. Comparing raw encoded bytes misses every
// such pair, so a dangerous field hides behind a harmless duplicate the screen
// and signer never see. These pin that the walker's key identity is normalized
// to match what the decoder collapses — measured, not assumed.
describe("cborDupKeys — a non-canonical duplicate the decoder collapses is refused", () => {
  // The proven attack: key 4 (certificates) as 0x04 carrying a cert, then key 4
  // again as the 1-byte-argument encoding 0x1804 carrying []. The decoder reads
  // one key 4 with the empty value; the byte scanner must see the duplicate.
  it("refuses 0x04:[cert] followed by 0x1804:[] (the hidden-certificate shape)", () => {
    const hex =
      "a2" +
      "04" + "81" + "82" + "00" + "82" + "00" + "581c" + "bb".repeat(28) + // 0x04: [cert]
      "1804" + "80"; // 0x1804 (== 4): []
    expect(() => walk(hex)).toThrow(DuplicateMapKeyError);
  });

  it("refuses the bare pair 0x04:_ , 0x1804:_", () => {
    expect(() => walk("a2" + "04" + "80" + "1804" + "80")).toThrow(DuplicateMapKeyError);
  });

  // Each sensitive body key, as the minimal form against its 1-byte-argument
  // non-canonical twin: mint (9), collateral (13 = 0x0d), outputs (1),
  // network id (15 = 0x0f). All decode to one key; all must be refused.
  const sensitivePairs: [string, string, string][] = [
    ["mint 0x09 vs 0x1809", "09", "1809"],
    ["collateral 0x0d vs 0x180d", "0d", "180d"],
    ["outputs 0x01 vs 0x1801", "01", "1801"],
    ["network id 0x0f vs 0x180f", "0f", "180f"],
  ];
  for (const [name, a, b] of sensitivePairs) {
    it(`refuses ${name}`, () => {
      expect(() => walk("a2" + a + "80" + b + "80")).toThrow(DuplicateMapKeyError);
    });
  }

  // Key 4 against every wider non-canonical argument: 2-byte, 4-byte, 8-byte.
  const widthTwins: [string, string][] = [
    ["2-byte 0x190004", "190004"],
    ["4-byte 0x1a00000004", "1a00000004"],
    ["8-byte 0x1b0000000000000004", "1b0000000000000004"],
  ];
  for (const [name, twin] of widthTwins) {
    it(`refuses 0x04 vs ${name}`, () => {
      expect(() => walk("a2" + "04" + "80" + twin + "80")).toThrow(DuplicateMapKeyError);
    });
  }

  // Negative integers collapse the same way: -1 is 0x20 (minimal) and 0x3800
  // (1-byte argument of major type 1). The decoder reads one key -1.
  it("refuses a negative-int key as 0x20 vs 0x3800 (both -1)", () => {
    expect(() => walk("a2" + "20" + "80" + "3800" + "81" + "00")).toThrow(DuplicateMapKeyError);
  });

  // Step-2 finding: the decoder collapses a definite text string and an
  // indefinite/chunked one of the same content (both "a"). Raw bytes would miss
  // it; the normalized identity catches it.
  it("refuses a text key as definite 0x6161 vs indefinite 0x7f6161ff (both \"a\")", () => {
    expect(() => walk("a2" + "6161" + "80" + "7f6161ff" + "8100")).toThrow(DuplicateMapKeyError);
  });

  // Step-2 finding: a float key decodes to a number, and an integer-valued
  // float decodes to the SAME number as that integer — 0xf94400 (half 4.0)
  // collides with 0x04. Also two floats of the same value across widths.
  it("refuses an integer key 0x04 vs a float16 4.0 key 0xf94400", () => {
    expect(() => walk("a2" + "04" + "80" + "f94400" + "8100")).toThrow(DuplicateMapKeyError);
  });

  it("refuses float16 1.0 (0xf93c00) vs float32 1.0 (0xfa3f800000)", () => {
    expect(() => walk("a2" + "f93c00" + "80" + "fa3f800000" + "8100")).toThrow(DuplicateMapKeyError);
  });

  it("refuses a negative integer key 0x20 (-1) vs a float16 -1.0 key 0xf9bc00", () => {
    expect(() => walk("a2" + "20" + "80" + "f9bc00" + "8100")).toThrow(DuplicateMapKeyError);
  });
});

// The other side of the same measurement: identity is normalized to match the
// decoder, NO MORE than it. A single non-canonical key with no sibling is well-
// formed; two genuinely different keys stay different; and a byte string, which
// the decoder keeps distinct by object identity even across encodings, must not
// be folded here either.
describe("cborDupKeys — normalization never refuses what the decoder keeps apart", () => {
  const ok: [string, string][] = [
    ["a single 1-byte-arg key alone", "a1" + "1804" + "80"],
    ["a single 2-byte-arg key alone", "a1" + "190004" + "80"],
    ["a single 8-byte-arg key alone", "a1" + "1b0000000000000004" + "80"],
    ["two genuinely different integer keys 0x04 and 0x05", "a2" + "04" + "80" + "05" + "80"],
    ["a float key with no integer twin", "a1" + "f94400" + "80"],
    ["two different text keys \"a\" and \"b\"", "a2" + "6161" + "80" + "6162" + "80"],
    // The decoder keeps byte-string keys distinct unless byte-identical (it
    // compares them by object identity), so a definite h'01' and an indefinite
    // h'01' are two keys to it and must stay two keys here.
    ["a byte string definite 0x4101 vs indefinite 0x5f4101ff", "a2" + "4101" + "80" + "5f4101ff" + "8100"],
    ["unsigned 0 (0x00) and negative -1 (0x20) are different keys", "a2" + "00" + "80" + "20" + "81" + "00"],
  ];
  for (const [name, hex] of ok) {
    it(`accepts ${name}`, () => {
      expect(() => walk(hex)).not.toThrow();
    });
  }
});
