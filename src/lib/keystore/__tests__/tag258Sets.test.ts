/**
 * Conway set encodings on the CIP-30 signing path (issue #60).
 *
 * The Conway CDDL lets every set-typed body field arrive as a plain array or as
 * the same array under CBOR tag 258 (`set<a> = #6.258([* a]) / [* a]`), and
 * CSL 17 / Lucid emit the tagged form by default (`a3 00 d90102 …`). The screen
 * (`summariseTx`) and the signer (`requiredKeysFor` / `signForeignTx`) must read
 * both the same way, and must still refuse every other shape — another tag,
 * tag 258 around something that is not an array, the same element twice.
 *
 * The same transaction is built in both encodings and every answer is compared;
 * only the body hash may differ, because the bytes differ and the signature is
 * over the bytes as sent, never a re-encoding.
 */
import { describe, it, expect } from "vitest";
import { Buffer } from "buffer";
import { CborTag, Decoder, Encoder } from "@stricahq/cbors";
import { utils as tyUtils, types as tyTypes } from "@stricahq/typhonjs";
import { accountFromEntropy, type Account } from "../derive";
import { requiredKeysFor, signForeignTx, type WalletView } from "../signForeign";
import { summariseTx } from "../../cardano/txSummary";
import { readCborSet, CborSetError } from "../../cardano/cborSet";
import { blake2b256, toHex } from "../../cardano/hash";
import { baseAddress, type PhoenixNetwork } from "../../cardano/address";

const NETWORK: PhoenixNetwork = 0;
const ENTROPY = Uint8Array.from(Buffer.alloc(32, 5));
const PAYEE = baseAddress("ab".repeat(28), "cd".repeat(28), NETWORK);
const OWN_SPEND = "aa".repeat(32);
const OWN_COLLATERAL = "bb".repeat(32);
const THEIR_REF = "cc".repeat(32);
const THEIR_INPUT = "dd".repeat(32);
/** A key hash this wallet does not hold: another wallet must also sign. */
const STRANGER_KEY = "ef".repeat(28);

let account: Account;
const acct = async () => (account ??= await accountFromEntropy(ENTROPY, 0, NETWORK));
const addrHex = (bech32: string) => (tyUtils.getAddressFromString(bech32) as tyTypes.ShelleyAddress).getHex();
const paymentHashOf = (bech32: string) =>
  Buffer.from(
    (tyUtils.getAddressFromString(bech32) as unknown as { paymentCredential: { hash: Buffer } }).paymentCredential.hash,
  ).toString("hex");

const tag = (items: unknown[], t = 258) => new CborTag(items, t);
const ref = (txid: string, ix: number) => [Buffer.from(txid, "hex"), ix];
const tx = (body: Map<number, unknown>) => Encoder.encode([body, new Map(), true, null]).toString("hex");

function viewOf(a: Account): WalletView {
  const mine = a.external[0]!.address;
  return {
    ownAddressesHex: a.external.map((d) => addrHex(d.address)),
    heldWithScript: new Map(),
    held: new Map([
      [`${OWN_SPEND}#0`, { address: mine, lovelace: BigInt(10_000_000), assets: new Map() }],
      [`${OWN_COLLATERAL}#1`, { address: mine, lovelace: BigInt(3_000_000), assets: new Map() }],
    ]),
  };
}

type Sets = { 0: unknown[]; 4: unknown[]; 13: unknown[]; 14: unknown[]; 18: unknown[] };

/**
 * One benign transaction: spends a coin of this wallet, pays someone, puts up
 * 3 ADA of its own collateral, names its own payment key in field 14, reads a
 * stranger's reference input, and carries an empty certificate set. `wrap`
 * decides how each set-typed field is encoded.
 */
function body(a: Account, wrap: (field: keyof Sets, items: unknown[]) => unknown, over: Partial<Sets> = {}) {
  const mine = a.external[0]!.address;
  const sets: Sets = {
    0: [ref(OWN_SPEND, 0)],
    4: [],
    13: [ref(OWN_COLLATERAL, 1)],
    14: [Buffer.from(paymentHashOf(mine), "hex")],
    18: [ref(THEIR_REF, 0)],
    ...over,
  };
  return new Map<number, unknown>([
    [0, wrap(0, sets[0])],
    [
      1,
      [
        [Buffer.from(addrHex(PAYEE), "hex"), 2_000_000],
        [Buffer.from(addrHex(mine), "hex"), 7_800_000],
      ],
    ],
    [2, 200_000],
    [4, wrap(4, sets[4])],
    [13, wrap(13, sets[13])],
    [14, wrap(14, sets[14])],
    [18, wrap(18, sets[18])],
  ]);
}

const plain = (_f: keyof Sets, items: unknown[]) => items;
const tagged = (_f: keyof Sets, items: unknown[]) => tag(items);
/** Tag only `field`, with tag number `t`; every other field plain. */
const only = (field: keyof Sets, t = 258) => (f: keyof Sets, items: unknown[]) => (f === field ? tag(items, t) : items);

const SET_FIELDS: (keyof Sets)[] = [0, 4, 13, 14, 18];

describe("readCborSet — the one place a set is unwrapped", () => {
  it("reads a plain array and tag 258 around one as the same elements", () => {
    expect(readCborSet([1, 2])).toEqual([1, 2]);
    expect(readCborSet(tag([1, 2]))).toEqual([1, 2]);
    // The decoder's own output, not a hand-made CborTag.
    expect(readCborSet(Decoder.decode(Buffer.from("d9010282" + "0102", "hex")).value)).toEqual([1, 2]);
  });

  it("refuses another tag, tag 258 around a non-array, and anything that is not a set — never an empty list", () => {
    for (const v of [tag([1], 259), new CborTag(new Map([[1, 2]]), 258), new CborTag(7, 258), new Map(), 3, undefined, Buffer.alloc(2)]) {
      expect(() => readCborSet(v)).toThrow(CborSetError);
    }
  });

  it("refuses the same element twice only when asked, in either encoding", () => {
    const k = Buffer.alloc(28, 1);
    expect(readCborSet([k, Buffer.from(k)])).toHaveLength(2);
    expect(() => readCborSet([k, Buffer.from(k)], { unique: true })).toThrow(expect.objectContaining({ fault: "duplicate" }));
    expect(() => readCborSet(tag([k, Buffer.from(k)]), { unique: true })).toThrow(expect.objectContaining({ fault: "duplicate" }));
  });
});

describe("one transaction, two set encodings, one answer", () => {
  it("the tagged body really is the Conway encoding (field 0 = d9 0102 …)", async () => {
    const a = await acct();
    expect(tx(body(a, tagged))).toContain("00d90102");
    expect(tx(body(a, plain))).not.toContain("d90102");
  });

  it("summariseTx describes both the same way", async () => {
    const a = await acct();
    const v = viewOf(a);
    const s = (b: Map<number, unknown>) => summariseTx(tx(b), v.ownAddressesHex, v.held, 0, v.heldWithScript);
    const p = s(body(a, plain));
    expect(p.ownInputs).toBe(1);
    expect(p.collateral).not.toBeNull();
    expect(s(body(a, tagged))).toEqual(p);
    // Each field on its own, too: a mixed body is what a builder emits when it
    // tags some sets and not others.
    for (const f of SET_FIELDS) expect(s(body(a, only(f)))).toEqual(p);
  });

  it("requiredKeysFor names the same keys; only the body hash differs, and it is the hash of the bytes sent", async () => {
    const a = await acct();
    const v = viewOf(a);
    const bp = body(a, plain);
    const bt = body(a, tagged);
    const p = requiredKeysFor(tx(bp), a, v);
    const t = requiredKeysFor(tx(bt), a, v);
    expect(p.keyHashes).toEqual([paymentHashOf(a.external[0]!.address)]);
    expect(t.keyHashes).toEqual(p.keyHashes);
    expect(t.foreignRewardAccounts).toEqual(p.foreignRewardAccounts);
    expect(p.bodyHashHex).toBe(toHex(blake2b256(Encoder.encode(bp))));
    expect(t.bodyHashHex).toBe(toHex(blake2b256(Encoder.encode(bt))));
    expect(t.bodyHashHex).not.toBe(p.bodyHashHex);
    for (const f of SET_FIELDS) expect(requiredKeysFor(tx(body(a, only(f))), a, v).keyHashes).toEqual(p.keyHashes);
  });

  it("signForeignTx signs the tagged transaction, over the tagged bytes", async () => {
    const a = await acct();
    const v = viewOf(a);
    const bt = body(a, tagged);
    const hex = signForeignTx(tx(bt), a, v, false);
    const wits = (Decoder.decode(Buffer.from(hex, "hex")).value as Map<number, unknown>).get(0) as [Buffer, Buffer][];
    expect(wits).toHaveLength(1);
    const prv = a.keyByHash.get(paymentHashOf(a.external[0]!.address))!;
    expect(prv.toPublicKey().verify(Buffer.from(wits[0]![1]), Buffer.from(blake2b256(Encoder.encode(bt))))).toBe(true);
  });
});

describe("a tag that is not 258, or 258 around something else, is refused on every set field", () => {
  for (const f of SET_FIELDS) {
    it(`field ${f}: tag 259 is refused by the screen and by the signer`, async () => {
      const a = await acct();
      const v = viewOf(a);
      const hex = tx(body(a, only(f, 259)));
      expect(() => summariseTx(hex, v.ownAddressesHex, v.held, 0, v.heldWithScript)).toThrow();
      expect(() => signForeignTx(hex, a, v, true)).toThrow(/^sign_/);
    });

    it(`field ${f}: tag 258 around a map is refused by the screen and by the signer`, async () => {
      const a = await acct();
      const v = viewOf(a);
      const b = body(a, plain);
      b.set(f, new CborTag(new Map([[0, 1]]), 258));
      const hex = tx(b);
      expect(() => summariseTx(hex, v.ownAddressesHex, v.held, 0, v.heldWithScript)).toThrow();
      expect(() => signForeignTx(hex, a, v, true)).toThrow(/^sign_/);
    });
  }

  it("field 4: a non-empty tagged certificate set is refused as a certificate, like a plain one", async () => {
    const a = await acct();
    const v = viewOf(a);
    const cert = [0, [0, Buffer.from(a.stakeKeyHashHex, "hex")]];
    for (const wrap of [plain, tagged]) {
      const hex = tx(body(a, wrap, { 4: [cert] }));
      expect(() => summariseTx(hex, v.ownAddressesHex, v.held, 0, v.heldWithScript)).toThrow(
        expect.objectContaining({ key: "sign_foreign_certificate" }),
      );
      expect(() => signForeignTx(hex, a, v, true)).toThrow(/^sign_foreign_certificate/);
    }
  });
});

describe("the same element twice in a set is refused, in either encoding", () => {
  const cases: [keyof Sets, (a: Account) => unknown[], RegExp][] = [
    [0, () => [ref(OWN_SPEND, 0), ref(OWN_SPEND, 0)], /same input twice/],
    [13, () => [ref(OWN_COLLATERAL, 1), ref(OWN_COLLATERAL, 1)], /same collateral input twice/],
    [14, (a) => [Buffer.from(paymentHashOf(a.external[0]!.address), "hex"), Buffer.from(paymentHashOf(a.external[0]!.address), "hex")], /same required signer twice/],
    [18, () => [ref(THEIR_REF, 0), ref(THEIR_REF, 0)], /same reference input twice/],
  ];
  for (const [f, items, why] of cases) {
    for (const [name, wrap] of [["plain", plain], ["tag 258", tagged]] as const) {
      it(`field ${f}, ${name}`, async () => {
        const a = await acct();
        const v = viewOf(a);
        const hex = tx(body(a, wrap, { [f]: items(a) }));
        expect(() => summariseTx(hex, v.ownAddressesHex, v.held, 0, v.heldWithScript)).toThrow(why);
        expect(() => signForeignTx(hex, a, v, true)).toThrow(why);
      });
    }
  }
});

describe("required_signers (14) under tag 258 is checked exactly like the plain array", () => {
  it("a key this wallet holds that nothing justifies is refused — the tag does not skip the check", async () => {
    const a = await acct();
    const v = viewOf(a);
    for (const wrap of [plain, tagged]) {
      const hex = tx(body(a, wrap, { 14: [Buffer.from(a.stakeKeyHashHex, "hex")] }));
      expect(() => signForeignTx(hex, a, v, true)).toThrow(/^sign_unjustified_signer/);
    }
  });

  it("a key outside the wallet is another wallet's to sign: refused without partialSign, signed around with it", async () => {
    const a = await acct();
    const v = viewOf(a);
    const signers = [Buffer.from(paymentHashOf(a.external[0]!.address), "hex"), Buffer.from(STRANGER_KEY, "hex")];
    const answers = [plain, tagged].map((wrap) => {
      const hex = tx(body(a, wrap, { 14: signers }));
      expect(() => signForeignTx(hex, a, v, false)).toThrow(new RegExp(`^sign_key_not_in_wallet: ${STRANGER_KEY}`));
      const wits = (Decoder.decode(Buffer.from(signForeignTx(hex, a, v, true), "hex")).value as Map<number, unknown>).get(0) as unknown[];
      return { keys: requiredKeysFor(hex, a, v).keyHashes, witnesses: wits.length };
    });
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[0]!.keys).toContain(STRANGER_KEY);
    expect(answers[0]!.witnesses).toBe(1);
  });

  it("a required signer that is not a 28-byte key hash is refused in either encoding", async () => {
    const a = await acct();
    const v = viewOf(a);
    for (const wrap of [plain, tagged]) {
      const hex = tx(body(a, wrap, { 14: [Buffer.alloc(27, 1)] }));
      expect(() => signForeignTx(hex, a, v, true)).toThrow(/required signers in a shape/);
    }
  });
});

describe("a foreign input set under tag 258 is still counted as foreign", () => {
  it("summary names the stranger's input in both encodings", async () => {
    const a = await acct();
    const v = viewOf(a);
    const inputs = [ref(OWN_SPEND, 0), ref(THEIR_INPUT, 2)];
    const [p, t] = [plain, tagged].map((wrap) =>
      summariseTx(tx(body(a, wrap, { 0: inputs })), v.ownAddressesHex, v.held, 0, v.heldWithScript),
    );
    expect(p!.foreignInputs).toBe(1);
    expect(t).toEqual(p);
  });
});
