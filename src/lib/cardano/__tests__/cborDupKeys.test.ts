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
