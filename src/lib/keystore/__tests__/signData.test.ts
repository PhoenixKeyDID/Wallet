/**
 * CIP-30 `signData`, judged by the verifier that will actually read it.
 *
 * The LAMP drip-pot service enrols a delegator by checking a CIP-8 signature
 * made with the STAKE key over its `drip-enroll/1` message (LAMP
 * `Distribution/drip-pot/SERVICE.md` §3.2.2). The copy of its verifier in
 * `vendor/lamp-drip-pot/` is byte-for-byte LAMP's except for the Ed25519
 * import, so a green case here is the wallet passing the service's own check —
 * not the wallet agreeing with itself. A second verifier, written here against
 * CIP-8 directly with a different CBOR library, checks the same signatures.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { Buffer } from "buffer";
import { createPrivateKey, sign as nodeSign } from "node:crypto";
import { Decoder, Encoder } from "@stricahq/cbors";
import { bech32 } from "bech32";
import { accountFromEntropy, type Account } from "../index";
import { planDataSign, signDataCip8, printableText, DATA_SIGN_CODE } from "../signData";
import { blake2b224, toHex } from "../../cardano/hash";
import { baseAddress } from "../../cardano/address";
import { verifyCip8 } from "./vendor/lamp-drip-pot/cip8";
import { verifyEd25519 } from "./vendor/lamp-drip-pot/ed25519";

const ENTROPY = Uint8Array.from(Buffer.alloc(32, 9));
const rawHex = (bech: string) => Buffer.from(bech32.fromWords(bech32.decode(bech, 1023).words)).toString("hex");

/** A `drip-enroll/1` message in the exact shape of SERVICE.md §3.1.1. */
function enrollMessage(subject: string, vault: string): string {
  return [
    "drip-enroll/1",
    "campaign: gst-preprod-1",
    "network: Preprod",
    `pot: ${"a1".repeat(28)}`,
    `subject: ${subject}`,
    `vault: ${vault}`,
    "grant: 1000 LAMP",
    `nonce: ${"5c".repeat(32)}`,
    "expires: 2026-11-13T00:00:00Z",
    "notice: GST drip. Ký thông điệp này không chuyển tài sản. Chỉ ký khi dòng vault là ví của bạn.",
  ].join("\n");
}

/** CIP-8 checked from the standard, independent of LAMP's parser. */
function independentVerify(signatureHex: string, keyHex: string, addressHex: string, payload: Buffer) {
  const key = Decoder.decode(Buffer.from(keyHex, "hex")).value as Map<number, unknown>;
  expect(key.get(1)).toBe(1); // kty OKP
  expect(key.get(3)).toBe(-8); // alg EdDSA
  expect(key.get(-1)).toBe(6); // crv Ed25519
  const x = key.get(-2) as Buffer;
  expect(x.length).toBe(32);

  const sign1 = Decoder.decode(Buffer.from(signatureHex, "hex")).value as unknown[];
  expect(sign1).toHaveLength(4);
  const [prot, unprot, body, sig] = sign1 as [Buffer, Map<string, unknown>, Buffer, Buffer];
  const headers = Decoder.decode(prot).value as Map<number | string, unknown>;
  expect(headers.get(1)).toBe(-8);
  expect((headers.get("address") as Buffer).toString("hex")).toBe(addressHex);
  expect(unprot.get("hashed")).toBe(false);
  expect(Buffer.compare(body, payload)).toBe(0);
  const toSign = Encoder.encode(["Signature1", prot, Buffer.alloc(0), body]);
  expect(verifyEd25519(sig, toSign, x)).toBe(true);
  return x;
}

let acct: Account;
beforeAll(async () => {
  acct = await accountFromEntropy(ENTROPY, 0, 0);
});

describe("the independent Ed25519 verifier is itself RFC 8032", () => {
  // RFC 8032 §7.1, TEST 1 and TEST 2.
  const vectors = [
    {
      sk: "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
      pk: "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
      msg: "",
      sig: "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
    },
    {
      sk: "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb",
      pk: "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
      msg: "72",
      sig: "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00",
    },
  ];
  it.each(vectors)("accepts the RFC signature for pk $pk and rejects it with one bit flipped", (v) => {
    const sig = Buffer.from(v.sig, "hex");
    const msg = Buffer.from(v.msg, "hex");
    expect(verifyEd25519(sig, msg, Buffer.from(v.pk, "hex"))).toBe(true);
    const flipped = Buffer.from(sig);
    flipped[0] ^= 1;
    expect(verifyEd25519(flipped, msg, Buffer.from(v.pk, "hex"))).toBe(false);
    // And the secret key really is the RFC's: signing it again gives the same bytes.
    const prv = createPrivateKey({
      key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(v.sk, "hex")]),
      format: "der",
      type: "pkcs8",
    });
    expect(nodeSign(null, msg, prv).toString("hex")).toBe(v.sig);
  });
});

describe("signData with the stake key passes LAMP's drip-enroll verifier", () => {
  it("signs a reward address with the stake key, and both verifiers accept it", () => {
    const rewardHex = rawHex(acct.rewardAddress);
    const vault = acct.external[0]!.address;
    const payload = Buffer.from(enrollMessage(acct.rewardAddress, vault), "utf8");

    const planned = planDataSign(acct, rewardHex, payload.toString("hex"));
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.kind).toBe("stake");
    expect(planned.plan.addressBech32).toBe(acct.rewardAddress);
    expect(planned.plan.payloadText).toContain("drip-enroll/1");

    const { signature, key } = signDataCip8(acct, planned.plan);
    const pubHex = verifyCip8(signature, key, {
      rewardAddressHex: rewardHex,
      stakeKeyHash: acct.stakeKeyHashHex,
      payload: new Uint8Array(payload),
    });
    expect(toHex(blake2b224(Buffer.from(pubHex, "hex")))).toBe(acct.stakeKeyHashHex);
    independentVerify(signature, key, rewardHex, payload);
  });

  it("accepts the reward address in bech32 too, with the same header bytes", () => {
    const planned = planDataSign(acct, acct.rewardAddress, "00");
    expect(planned.ok && planned.plan.addressHex).toBe(rawHex(acct.rewardAddress));
  });

  it("LAMP rejects the same signature for a different message, so the green above is not a rubber stamp", () => {
    const rewardHex = rawHex(acct.rewardAddress);
    const payload = Buffer.from(enrollMessage(acct.rewardAddress, acct.external[0]!.address), "utf8");
    const planned = planDataSign(acct, rewardHex, payload.toString("hex"));
    if (!planned.ok) throw new Error("plan refused");
    const { signature, key } = signDataCip8(acct, planned.plan);
    const other = Buffer.from(enrollMessage(acct.rewardAddress, acct.external[1]!.address), "utf8");
    expect(() =>
      verifyCip8(signature, key, { rewardAddressHex: rewardHex, stakeKeyHash: acct.stakeKeyHashHex, payload: new Uint8Array(other) }),
    ).toThrow(/payload/);
    // A payment-key signature over the right message is refused at step 3.
    const pay = planDataSign(acct, rawHex(acct.external[0]!.address), payload.toString("hex"));
    if (!pay.ok) throw new Error("plan refused");
    const p = signDataCip8(acct, pay.plan);
    expect(() =>
      verifyCip8(p.signature, p.key, { rewardAddressHex: rewardHex, stakeKeyHash: acct.stakeKeyHashHex, payload: new Uint8Array(payload) }),
    ).toThrow(/stake key/);
  });
});

describe("signData with a base address uses that address's payment key", () => {
  it("signs with the payment key whose hash is in the address", () => {
    const d = acct.external[2]!;
    const hex = rawHex(d.address);
    const planned = planDataSign(acct, hex, "68656c6c6f");
    if (!planned.ok) throw new Error("plan refused");
    expect(planned.plan.kind).toBe("payment");
    expect(planned.plan.keyHashHex).toBe(d.keyHashHex);
    const { signature, key } = signDataCip8(acct, planned.plan);
    const x = independentVerify(signature, key, hex, Buffer.from("hello"));
    expect(toHex(blake2b224(x))).toBe(d.keyHashHex);
  });
});

describe("signData refuses before any key is touched", () => {
  const code = (r: ReturnType<typeof planDataSign>) => (r.ok ? "signed" : r.refusal.code);

  it("a script reward address is AddressNotPK (2)", () => {
    expect(code(planDataSign(acct, "f0" + "11".repeat(28), "00"))).toBe(DATA_SIGN_CODE.AddressNotPK);
  });
  it("a script base address is AddressNotPK (2)", () => {
    expect(code(planDataSign(acct, "10" + "11".repeat(28) + acct.stakeKeyHashHex, "00"))).toBe(DATA_SIGN_CODE.AddressNotPK);
  });
  it("someone else's reward address is ProofGeneration (1)", () => {
    expect(code(planDataSign(acct, "e0" + "22".repeat(28), "00"))).toBe(DATA_SIGN_CODE.ProofGeneration);
  });
  it("this wallet's stake key on the other network is ProofGeneration (1)", () => {
    expect(code(planDataSign(acct, "e1" + acct.stakeKeyHashHex, "00"))).toBe(DATA_SIGN_CODE.ProofGeneration);
  });
  it("this wallet's payment key beside a stranger's stake key is not this wallet's address", () => {
    const mixed = rawHex(baseAddress(acct.external[0]!.keyHashHex, "33".repeat(28), 0));
    expect(code(planDataSign(acct, mixed, "00"))).toBe(DATA_SIGN_CODE.ProofGeneration);
  });
  it("an enterprise address of this wallet's payment key is not one it derived", () => {
    expect(code(planDataSign(acct, "60" + acct.external[0]!.keyHashHex, "00"))).toBe(DATA_SIGN_CODE.ProofGeneration);
  });
  it("a payload that is not hex, or an address that is not one, is InvalidRequest (-1)", () => {
    expect(code(planDataSign(acct, acct.rewardAddress, "zz"))).toBe(-1);
    expect(code(planDataSign(acct, acct.rewardAddress, "abc"))).toBe(-1);
    expect(code(planDataSign(acct, "not-an-address", "00"))).toBe(-1);
    expect(code(planDataSign(acct, 42, "00"))).toBe(-1);
    expect(code(planDataSign(acct, acct.rewardAddress, "00".repeat(16 * 1024 + 1)))).toBe(-1);
  });
});

describe("the screen shows text only when the text is what is signed", () => {
  it("shows readable UTF-8, including Vietnamese and newlines", () => {
    expect(printableText(Buffer.from("Ký\nthông điệp", "utf8"))).toBe("Ký\nthông điệp");
  });
  it("shows hex only for invalid UTF-8, a carriage return, or a bidi override", () => {
    expect(printableText(Buffer.from([0xff, 0xfe]))).toBeNull();
    expect(printableText(Buffer.from("vault: mine\rvault: theirs", "utf8"))).toBeNull();
    expect(printableText(Buffer.from("pay \u202eevil", "utf8"))).toBeNull();
  });

  // Each group alone, inside otherwise ordinary text, so a red case names the
  // group that is missing from the list.
  const hidden = (cp: number) => printableText(Buffer.from(`pay to vault${String.fromCodePoint(cp)}A`, "utf8"));
  it("shows hex only for the Arabic letter mark U+061C", () => {
    expect(hidden(0x061c)).toBeNull();
  });
  it("shows hex only for a zero-width space or joiner, U+200B–U+200D", () => {
    for (const cp of [0x200b, 0x200c, 0x200d]) expect(hidden(cp)).toBeNull();
  });
  it("shows hex only for the word joiner and invisible operators, U+2060–U+2064", () => {
    for (const cp of [0x2060, 0x2061, 0x2062, 0x2063, 0x2064]) expect(hidden(cp)).toBeNull();
  });
  it("shows hex only for a byte-order mark U+FEFF, at the start or inside", () => {
    expect(hidden(0xfeff)).toBeNull();
    expect(printableText(Buffer.from("\ufeffpay", "utf8"))).toBeNull();
  });
  it("shows hex only for text in a right-to-left script", () => {
    expect(printableText(Buffer.from("pay שלום 10", "utf8"))).toBeNull(); // Hebrew
    expect(printableText(Buffer.from("pay مرحبا 10", "utf8"))).toBeNull(); // Arabic
    expect(printableText(Buffer.from("pay \ufb50", "utf8"))).toBeNull(); // Arabic presentation form
    expect(printableText(Buffer.from("pay ܫܠܡܐ", "utf8"))).toBeNull(); // Syriac
  });
  it("still shows the neighbours of those ranges as text", () => {
    // U+200A (hair space) sits just below the zero-width range.
    for (const t of ["Ký thông điệp", "日本語のメッセージ", "Привет", "a\u200ab"]) {
      expect(printableText(Buffer.from(t, "utf8"))).toBe(t);
    }
  });

  // One group per case, each the code points the old hand-kept list missed.
  it("shows hex only for a soft hyphen U+00AD and the Mongolian vowel separator U+180E (format, Cf)", () => {
    expect(hidden(0x00ad)).toBeNull();
    expect(hidden(0x180e)).toBeNull();
  });
  it("shows hex only for the line and paragraph separators U+2028 / U+2029 (Zl, Zp)", () => {
    expect(hidden(0x2028)).toBeNull();
    expect(hidden(0x2029)).toBeNull();
  });
  it("shows hex only for tag characters U+E0000–E007F (Cf)", () => {
    for (const cp of [0xe0001, 0xe0020, 0xe0041, 0xe007f]) expect(hidden(cp)).toBeNull();
  });
  it("shows hex only for private-use code points (Co)", () => {
    for (const cp of [0xe000, 0xf8ff, 0xf0000, 0x10fffd]) expect(hidden(cp)).toBeNull();
  });
  it("shows hex only for code points unassigned in this engine's Unicode (Cn)", () => {
    // U+0378 and U+2FFFF have been unassigned in every Unicode version so far.
    for (const cp of [0x0378, 0x2ffff]) expect(hidden(cp)).toBeNull();
  });
  it("shows hex only for right-to-left letters outside the seven scripts the old list named", () => {
    expect(hidden(0x1e900)).toBeNull(); // Adlam
    expect(hidden(0x10900)).toBeNull(); // Phoenician
    expect(hidden(0x10a10)).toBeNull(); // Kharoshthi
    expect(hidden(0x10d50)).toBeNull(); // Garay (Unicode 16)
    expect(hidden(0x1ec71)).toBeNull(); // Indic Siyaq number — script Common, Bidi AL
  });
  it("covers every code point of every right-to-left script the engine knows", () => {
    const RTL_SCRIPTS = [
      "Hebrew", "Arabic", "Syriac", "Thaana", "Nko", "Samaritan", "Mandaic", "Imperial_Aramaic",
      "Phoenician", "Old_South_Arabian", "Old_North_Arabian", "Avestan", "Inscriptional_Parthian",
      "Inscriptional_Pahlavi", "Psalter_Pahlavi", "Old_Turkic", "Old_Hungarian", "Hanifi_Rohingya",
      "Old_Sogdian", "Sogdian", "Elymaic", "Chorasmian", "Yezidi", "Adlam", "Mende_Kikakui",
      "Kharoshthi", "Lydian", "Meroitic_Cursive", "Meroitic_Hieroglyphs", "Cypriot", "Manichaean",
      "Nabataean", "Palmyrene", "Hatran", "Old_Uyghur", "Garay",
    ];
    const anyRtl = new RegExp(`[${RTL_SCRIPTS.map((n) => `\\p{Script=${n}}`).join("")}]`, "u");
    const shown: string[] = [];
    let seen = 0;
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const ch = String.fromCodePoint(cp);
      if (!anyRtl.test(ch)) continue;
      seen += 1;
      if (printableText(Buffer.from(`a${ch}`, "utf8")) !== null) shown.push(cp.toString(16));
    }
    expect(seen).toBeGreaterThan(3000); // the walk did run over the scripts
    expect(shown).toEqual([]);
  });
  it("still shows plain emoji, and a heart with its variation selector, as text", () => {
    for (const t of ["gm 😀", "🚀 to the moon", "❤️", "❤\ufe0e", "gm ☺️ 10 ADA"]) {
      expect(printableText(Buffer.from(t, "utf8"))).toBe(t);
    }
  });

  // The C1 controls U+0080–U+009F (NEL U+0085 breaks a line in some renderers)
  // and DEL U+007F are Cc, not Cf: only the control range catches them.
  it("shows hex only for DEL and the C1 controls U+007F–U+009F", () => {
    for (const cp of [0x7f, 0x80, 0x85, 0x8d, 0x9b, 0x9f]) expect(hidden(cp)).toBeNull();
    expect(printableText(Buffer.from("a\u00a0b", "utf8"))).toBe("a\u00a0b"); // first code point past the range
  });

  // Default-ignorable code points are drawn as nothing, and most are not Cf.
  it("shows hex only for default-ignorable code points that are not format characters", () => {
    const cases: [number, string][] = [
      [0xfe0f, "variation selector-16 with no emoji before it"],
      [0xe0100, "variation selector-17"],
      [0x034f, "combining grapheme joiner"],
      [0x3164, "Hangul filler"],
      [0x115f, "Hangul choseong filler"],
      [0xffa0, "halfwidth Hangul filler"],
      [0x180b, "Mongolian free variation selector one"],
      [0x17b4, "Khmer vowel inherent AQ"],
    ];
    const shown = cases.filter(([cp]) => hidden(cp) !== null).map(([, name]) => name);
    expect(shown).toEqual([]);
    expect(printableText(Buffer.from("pay\ufe0f 10", "utf8"))).toBeNull();
    expect(printableText(Buffer.from("❤\u034f", "utf8"))).toBeNull(); // only FE0E/FE0F are let through after an emoji
  });

  // A message that ends after a page of blank space reads as finished.
  it("shows hex only for three or more blank lines in a row", () => {
    expect(printableText(Buffer.from("a\n\n\nb", "utf8"))).toBe("a\n\n\nb"); // two blank lines
    expect(printableText(Buffer.from("a\n\n\n\nb", "utf8"))).toBeNull();
    expect(printableText(Buffer.from("a\n \n\t\n  \nb", "utf8"))).toBeNull(); // blank, not empty
    expect(printableText(Buffer.from("a" + "\n".repeat(60) + "send all to addr_test1evil", "utf8"))).toBeNull();
  });
  it("shows hex only for long whitespace at the start or the end", () => {
    expect(printableText(Buffer.from("abc\n", "utf8"))).toBe("abc\n");
    expect(printableText(Buffer.from("abc" + " ".repeat(16), "utf8"))).toBe("abc" + " ".repeat(16));
    expect(printableText(Buffer.from("abc" + " ".repeat(17), "utf8"))).toBeNull();
    expect(printableText(Buffer.from(" ".repeat(17) + "abc", "utf8"))).toBeNull();
    expect(printableText(Buffer.from("abc\n\n", "utf8"))).toBeNull();
    expect(printableText(Buffer.from("\n\nabc", "utf8"))).toBeNull();
  });

  // A "blank" line need not be spaces and tabs: NBSP, the ideographic space,
  // the Braille blank and the Hangul filler all draw nothing, and a line of
  // them pushes the real sentence below the fold just as well.
  const INKLESS_CASES: [string, string][] = [
    ["no-break space", "00A0"],
    ["ideographic space", "3000"],
    ["Braille pattern blank", "2800"],
    ["Hangul filler", "3164"],
  ];
  it.each(INKLESS_CASES)("counts lines of %s (U+%s) as blank in the middle", (_name, cp) => {
    const c = String.fromCodePoint(parseInt(cp, 16));
    const msg = "Login to example.com\n" + `${c}\n`.repeat(40) + "I authorise transfer of all funds";
    expect(printableText(Buffer.from(msg, "utf8"))).toBeNull();
    // Three blank lines of it, the same threshold as plain newlines.
    expect(printableText(Buffer.from(`a\n${c}\n${c}\n${c}\nb`, "utf8"))).toBeNull();
  });
  it.each(INKLESS_CASES)("counts %s (U+%s) as blank at the start and the end", (_name, cp) => {
    const c = String.fromCodePoint(parseInt(cp, 16));
    expect(printableText(Buffer.from("Login to example.com" + `\n${c}`.repeat(40), "utf8"))).toBeNull();
    expect(printableText(Buffer.from(`${c}\n`.repeat(40) + "Login to example.com", "utf8"))).toBeNull();
    expect(printableText(Buffer.from("abc" + c.repeat(17), "utf8"))).toBeNull();
    expect(printableText(Buffer.from(c.repeat(17) + "abc", "utf8"))).toBeNull();
    expect(printableText(Buffer.from(`abc${c}\n${c}\n`, "utf8"))).toBeNull(); // two line breaks at the end
  });
  it("still shows text with a no-break space or an ideographic space inside a sentence", () => {
    const nbsp = "Pay 10\u00a0ADA to Alice";
    expect(printableText(Buffer.from(nbsp, "utf8"))).toBe(nbsp);
    const ideo = "ログイン\u3000確認";
    expect(printableText(Buffer.from(ideo, "utf8"))).toBe(ideo);
    // Under the edge limit, and one blank line of NBSP between two lines: still text.
    const mild = "abc\n\u00a0\nde" + "\u00a0".repeat(16);
    expect(printableText(Buffer.from(mild, "utf8"))).toBe(mild);
  });
});
