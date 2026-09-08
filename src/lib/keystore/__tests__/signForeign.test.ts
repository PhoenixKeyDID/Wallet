/**
 * Signing a transaction the wallet did not build.
 *
 * The load-bearing assertion in this file is the first one: the body hash this
 * module computes from raw CBOR must equal the hash typhon computed while
 * building the same transaction. Everything else here is a refusal test; that
 * one is the correctness test, and it is the only way to know the binary search
 * in `bodyBytes` found the right byte range.
 *
 * Why it matters that the range is exact rather than close: a witness signs a
 * hash. A hash of the wrong bytes is a perfectly valid signature over a
 * transaction that does not exist. Nothing throws, the dApp gets a witness set
 * back, and the node rejects the transaction with an error about witnesses that
 * sends everyone looking in the wrong place.
 */
import { describe, it, expect } from "vitest";
import { Buffer } from "buffer";
import BigNumber from "bignumber.js";
import { Decoder, Encoder } from "@stricahq/cbors";
import { utils as tyUtils, types as tyTypes } from "@stricahq/typhonjs";
import { accountFromEntropy, type Account } from "../derive";
import { LocalSignError } from "../signer";
import { requiredKeysFor, signForeignTx } from "../signForeign";
import { buildMultiSend, buildSendOutputs } from "../../cardano/send";
import { baseAddress, type PhoenixNetwork } from "../../cardano/address";

const NETWORK: PhoenixNetwork = 0;
const ENTROPY = Uint8Array.from(Buffer.alloc(32, 9));

const PROTOCOL_PARAMS: tyTypes.ProtocolParams = {
  minFeeA: new BigNumber(44),
  minFeeB: new BigNumber(155381),
  stakeKeyDeposit: new BigNumber(2_000_000),
  utxoCostPerByte: new BigNumber(4310),
  collateralPercent: new BigNumber(150),
  priceSteps: new BigNumber(0),
  priceMem: new BigNumber(0),
  maxTxSize: 16384,
  maxValueSize: 5000,
  minFeeRefScriptCostPerByte: new BigNumber(15),
};

const PAYEE = baseAddress("cc".repeat(28), "dd".repeat(28), NETWORK);
const shelley = (b: string) => tyUtils.getAddressFromString(b) as tyTypes.ShelleyAddress;
const TXID = "77".repeat(32);

let account: Account;

async function fixture(outputs = 1) {
  account ??= await accountFromEntropy(ENTROPY, 0, NETWORK);
  const from = account.external[0]!.address;
  const inputs: tyTypes.Input[] = [
    {
      txId: TXID,
      index: 0,
      amount: new BigNumber(String(10_000_000 + outputs * 5_000_000)),
      tokens: [],
      address: shelley(from),
    } as unknown as tyTypes.Input,
  ];
  const rows = Array.from({ length: outputs }, () => ({ address: PAYEE, ada: "2", tokens: [] }));
  const built = buildMultiSend({
    outputs: buildSendOutputs(rows, NETWORK),
    inputs,
    changeAddress: shelley(account.internal[0]!.address),
    protocolParams: PROTOCOL_PARAMS,
    ttl: 50_000_000,
  });
  const addressByRef = new Map([[`${TXID}#0`, from]]);
  return { account, built, addressByRef };
}

describe("requiredKeysFor — the body hash", () => {
  it("finds the same body hash typhon computed while building", async () => {
    const { account: acct, built, addressByRef } = await fixture();
    const { bodyHashHex } = requiredKeysFor(built.unsignedCbor, acct, addressByRef);
    // `built.hash` is the transaction id: blake2b-256 of the body as serialised.
    // Equality here is what proves the byte range was found exactly.
    expect(bodyHashHex).toBe(built.hash);
  });

  it("still finds it when the body is a different length", async () => {
    // A one-byte CBOR length prefix becomes two bytes past a threshold, so a
    // search that happened to work on one size can fail on another.
    for (const n of [1, 2, 5, 12]) {
      const { account: acct, built, addressByRef } = await fixture(n);
      expect(requiredKeysFor(built.unsignedCbor, acct, addressByRef).bodyHashHex).toBe(built.hash);
    }
  });

  it("names the payment key of every input the wallet recognises", async () => {
    const { account: acct, built, addressByRef } = await fixture();
    const { keyHashes } = requiredKeysFor(built.unsignedCbor, acct, addressByRef);
    expect(keyHashes).toHaveLength(1);
    expect(acct.keyByHash.has(keyHashes[0]!)).toBe(true);
  });

  it("names no key for an input the wallet does not recognise", async () => {
    const { account: acct, built } = await fixture();
    expect(requiredKeysFor(built.unsignedCbor, acct, new Map()).keyHashes).toEqual([]);
  });
});

describe("signForeignTx — what it returns", () => {
  it("returns a witness set, not a transaction", async () => {
    const { account: acct, built, addressByRef } = await fixture();
    const hex = signForeignTx(built.unsignedCbor, acct, addressByRef, false);
    const decoded = Decoder.decode(Buffer.from(hex, "hex")).value;
    // CIP-30 says signTx answers with the witness set alone. Returning the whole
    // transaction makes every dApp that merges the answer produce a malformed one.
    expect(decoded).toBeInstanceOf(Map);
    expect((decoded as Map<number, unknown>).has(0)).toBe(true);
    expect(Array.isArray((decoded as Map<number, unknown>).get(0))).toBe(true);
  });

  it("produces a signature that verifies against the body hash", async () => {
    const { account: acct, built, addressByRef } = await fixture();
    const hex = signForeignTx(built.unsignedCbor, acct, addressByRef, false);
    const set = (Decoder.decode(Buffer.from(hex, "hex")).value as Map<number, unknown>).get(0);
    const [pk, sig] = (set as [Buffer, Buffer][])[0]!;
    expect(pk).toHaveLength(32);
    expect(sig).toHaveLength(64);

    const keyHash = requiredKeysFor(built.unsignedCbor, acct, addressByRef).keyHashes[0]!;
    const prv = acct.keyByHash.get(keyHash)!;
    const bodyHash = Buffer.from(built.hash, "hex");
    expect(prv.toPublicKey().verify(Buffer.from(sig), bodyHash)).toBe(true);
    // And the key in the witness is the one the address commits to, not some
    // other key this wallet happens to hold.
    expect(Buffer.from(prv.toPublicKey().toBytes()).equals(Buffer.from(pk))).toBe(true);
  });

  it("signs once per required key, never once per input", async () => {
    const { account: acct, built, addressByRef } = await fixture(3);
    const hex = signForeignTx(built.unsignedCbor, acct, addressByRef, false);
    const set = (Decoder.decode(Buffer.from(hex, "hex")).value as Map<number, unknown>).get(0);
    // A spare witness makes the transaction bigger than the fee already computed
    // for it, and the node rejects the whole thing.
    expect((set as unknown[]).length).toBe(1);
  });
});

describe("signForeignTx — what it refuses", () => {
  it("refuses when it holds none of the required keys", async () => {
    const { account: acct, built, addressByRef } = await fixture();
    expect(() => signForeignTx(built.unsignedCbor, acct, new Map(), false)).toThrow(LocalSignError);
    // Not merely an error — specifically the "nothing to contribute" one. An
    // empty witness set would be a wallet reporting a signature it did not make.
    expect(() => signForeignTx(built.unsignedCbor, acct, new Map(), false)).toThrow(
      "sign_no_required_witnesses",
    );
    expect(addressByRef.size).toBe(1); // fixture sanity
  });

  it("refuses a partial signature when the dApp said it would not accept one", async () => {
    const { account: acct, built, addressByRef } = await fixture();
    // `required_signers` naming a key nobody holds, with partialSign false.
    const body = Decoder.decode(Buffer.from(built.unsignedCbor, "hex")).value as unknown[];
    const b = body[0] as Map<number, unknown>;
    b.set(14, [Buffer.from("ee".repeat(28), "hex")]);
    const rebuilt = Encoder.encode(body).toString("hex");
    expect(() => signForeignTx(rebuilt, acct, addressByRef, false)).toThrow(
      "sign_key_not_in_wallet",
    );
  });

  it("signs what it can when the dApp asked for a partial signature", async () => {
    const { account: acct, built, addressByRef } = await fixture();
    const body = Decoder.decode(Buffer.from(built.unsignedCbor, "hex")).value as unknown[];
    const b = body[0] as Map<number, unknown>;
    b.set(14, [Buffer.from("ee".repeat(28), "hex")]);
    const rebuilt = Encoder.encode(body).toString("hex");
    const hex = signForeignTx(rebuilt, acct, addressByRef, true);
    const set = (Decoder.decode(Buffer.from(hex, "hex")).value as Map<number, unknown>).get(0);
    expect((set as unknown[]).length).toBe(1);
  });

  it("refuses bytes that are not a transaction", async () => {
    const { account: acct, addressByRef } = await fixture();
    for (const junk of ["", "00", "deadbeef", "a10201"]) {
      expect(() => signForeignTx(junk, acct, addressByRef, false)).toThrow(LocalSignError);
    }
  });

  it("refuses an indefinite-length outer array rather than guessing the body", async () => {
    const { account: acct, built, addressByRef } = await fixture();
    // 0x9f is an indefinite-length array. The body would start in the same
    // place, but "the same place" is a guess and a wrong guess is a wrong hash.
    const bytes = Buffer.from(built.unsignedCbor, "hex");
    bytes[0] = 0x9f;
    expect(() => signForeignTx(bytes.toString("hex"), acct, addressByRef, false)).toThrow(
      "sign_foreign_unexpected_encoding",
    );
  });
});
