/**
 * Clear signing: every action a website adds that is not this wallet's is
 * named on the summary, and blocks the signature until confirmed one by one.
 *
 * The case these rebuild: an ordinary transaction from this wallet (its own
 * coin pays the fee) with one more line slipped in — a 0-lovelace withdrawal
 * from a SCRIPT reward account, carrying a `reward` redeemer. A contract that
 * counts "a withdrawal for my credential happened, signed by these keys" as a
 * vote takes this wallet's signature as one of its approvals. Before this
 * change the summary only counted it, the screen said one general sentence,
 * and the signer signed.
 */
import { describe, it, expect } from "vitest";
import { Buffer } from "buffer";
import { Encoder } from "@stricahq/cbors";
import { utils as tyUtils, types as tyTypes } from "@stricahq/typhonjs";
import { accountFromEntropy, type Account } from "../derive";
import { signForeignTx, type WalletView } from "../signForeign";
import { summariseTx, unconfirmedForeignActions, UndescribableTxError } from "../../cardano/txSummary";
import { baseAddress, type PhoenixNetwork } from "../../cardano/address";

const NETWORK: PhoenixNetwork = 0;
const ENTROPY = Uint8Array.from(Buffer.alloc(32, 11));
const PAYEE = baseAddress("ab".repeat(28), "cd".repeat(28), NETWORK);

const OWN_TXID = "77".repeat(32);
const SCRIPT_TXID = "aa".repeat(32);
/** Script reward account on a testnet: header 0xF0, then the script hash. */
const SCRIPT_REWARD = "f0" + "5c".repeat(28);
/** Someone else's key reward account on a testnet. */
const OTHER_KEY_REWARD = "e0" + "01".repeat(28);

let account: Account;
const acct = async () => (account ??= await accountFromEntropy(ENTROPY, 0, NETWORK));

const addrHex = (bech32: string) => (tyUtils.getAddressFromString(bech32) as tyTypes.ShelleyAddress).getHex();

/** The wallet holding one coin at its first address. */
const viewOf = (a: Account): WalletView => ({
  ownAddressesHex: a.external.map((d) => addrHex(d.address)),
  held: new Map([[`${OWN_TXID}#1`, { address: a.external[0]!.address, lovelace: BigInt(20_000_000), assets: new Map() }]]),
  heldWithScript: new Map(),
});

type Redeemers = Map<unknown, unknown> | unknown[] | undefined;

/** A Conway redeemer map entry: `[tag, index] → [data, ex_units]`. */
const conway = (...ptrs: [number, number][]): Map<unknown, unknown> =>
  new Map(ptrs.map(([tag, index]) => [[tag, index], [0, [1000, 100000]]]));

function tx(opts: { withdrawals?: [string, number][]; redeemers?: Redeemers; extra?: [number, unknown][] } = {}): string {
  const body = new Map<number, unknown>([
    [
      0,
      [
        [Buffer.from(OWN_TXID, "hex"), 1],
        [Buffer.from(SCRIPT_TXID, "hex"), 0],
      ],
    ],
    [1, [[Buffer.from(addrHex(PAYEE), "hex"), 2_000_000]]],
    [2, 300_000],
  ]);
  if (opts.withdrawals) body.set(5, new Map(opts.withdrawals.map(([hex, n]) => [Buffer.from(hex, "hex"), n])));
  for (const [k, v] of opts.extra ?? []) body.set(k, v);
  const ws = new Map<number, unknown>();
  if (opts.redeemers !== undefined) ws.set(5, opts.redeemers);
  return Encoder.encode([body, ws, true, null]).toString("hex");
}

/** The real case: a script input (spend redeemer) + a foreign script withdrawal (reward redeemer). */
const injected = () =>
  tx({
    withdrawals: [[SCRIPT_REWARD, 0]],
    // Inputs in ledger order: 77…#1 (index 0), aa…#0 (index 1).
    redeemers: conway([0, 1], [3, 0]),
  });

describe("the summary names every foreign action", () => {
  it("lists the foreign script withdrawal with its redeemer purpose, and the script input by name", async () => {
    const a = await acct();
    const v = viewOf(a);
    const s = summariseTx(injected(), v.ownAddressesHex, v.held, 0);
    expect(s.foreignWithdrawalList).toHaveLength(1);
    const w = s.foreignWithdrawalList[0]!;
    expect(w.rewardAccountHex).toBe(SCRIPT_REWARD);
    expect(w.credential).toBe("script");
    expect(w.credentialHashHex).toBe("5c".repeat(28));
    expect(w.stakeAddress).toMatch(/^stake_test1/);
    expect(w.lovelace).toBe(BigInt(0));
    expect(w.redeemer).toBe(true);
    expect(s.redeemers).toEqual([
      { purpose: "spend", index: 1 },
      { purpose: "reward", index: 0 },
    ]);
    expect(s.foreignInputList).toEqual([{ txId: SCRIPT_TXID, index: 0, redeemer: true }]);
    expect(unconfirmedForeignActions(s, new Set())).toEqual([SCRIPT_REWARD]);
    expect(unconfirmedForeignActions(s, new Set([SCRIPT_REWARD]))).toEqual([]);
  });

  it("reads the Alonzo array form of redeemers the same way", async () => {
    const a = await acct();
    const v = viewOf(a);
    const cbor = tx({
      withdrawals: [[SCRIPT_REWARD, 0]],
      redeemers: [
        [0, 1, 0, [1000, 100000]],
        [3, 0, 0, [1000, 100000]],
      ],
    });
    const s = summariseTx(cbor, v.ownAddressesHex, v.held, 0);
    expect(s.foreignWithdrawalList[0]!.redeemer).toBe(true);
    expect(s.foreignInputList[0]!.redeemer).toBe(true);
  });

  it("without redeemers the items are still listed, marked as having none", async () => {
    const a = await acct();
    const v = viewOf(a);
    const s = summariseTx(tx({ withdrawals: [[SCRIPT_REWARD, 0]] }), v.ownAddressesHex, v.held, 0);
    expect(s.foreignWithdrawalList.map((w) => [w.rewardAccountHex, w.redeemer])).toEqual([[SCRIPT_REWARD, false]]);
    expect(s.foreignInputList).toEqual([{ txId: SCRIPT_TXID, index: 0, redeemer: false }]);
    expect(s.redeemers).toEqual([]);
  });

  // A `reward` index counts withdrawals in LEDGER order, where a script
  // credential sorts before a key credential. Raw byte order would put the key
  // account (0xE0) first and pin the redeemer on the wrong line.
  it("points a reward redeemer at the withdrawal the ledger would run it for", async () => {
    const a = await acct();
    const v = viewOf(a);
    const cbor = tx({
      withdrawals: [
        [OTHER_KEY_REWARD, 1_000_000],
        [SCRIPT_REWARD, 0],
      ],
      redeemers: conway([3, 0]),
    });
    const s = summariseTx(cbor, v.ownAddressesHex, v.held, 0);
    const byAcct = new Map(s.foreignWithdrawalList.map((w) => [w.rewardAccountHex, w]));
    expect(byAcct.get(SCRIPT_REWARD)!.redeemer).toBe(true);
    expect(byAcct.get(OTHER_KEY_REWARD)!.redeemer).toBe(false);
    expect(byAcct.get(OTHER_KEY_REWARD)!.credential).toBe("key");
    expect(byAcct.get(OTHER_KEY_REWARD)!.lovelace).toBe(BigInt(1_000_000));
  });

  it.each([
    ["a reward redeemer pointing past the last withdrawal", conway([3, 1])],
    ["a spend redeemer pointing past the last input", conway([0, 2])],
    ["a cert redeemer (the body has no certificate)", conway([2, 0])],
    ["a vote redeemer", conway([4, 0])],
    ["a redeemer tag the ledger does not have", conway([6, 0])],
    ["the same pointer twice (array form)", [[3, 0, 0, [1, 1]], [3, 0, 0, [1, 1]]]],
    ["a redeemer entry of the wrong length", [[3, 0, 0]]],
    ["redeemers that are neither array nor map", 7],
  ])("refuses %s", async (_label, redeemers) => {
    const a = await acct();
    const v = viewOf(a);
    const cbor = tx({ withdrawals: [[SCRIPT_REWARD, 0]], redeemers: redeemers as Redeemers });
    expect(() => summariseTx(cbor, v.ownAddressesHex, v.held, 0)).toThrow(UndescribableTxError);
    // And the signer refuses it under the screen's verdict, confirmed or not.
    expect(() => signForeignTx(cbor, a, v, true, new Set([SCRIPT_REWARD]))).toThrow(/^sign_foreign_undescribable: /);
  });

  it("refuses a witness set that is not a map", async () => {
    const a = await acct();
    const v = viewOf(a);
    const body = new Map<number, unknown>([
      [0, [[Buffer.from(OWN_TXID, "hex"), 1]]],
      [1, [[Buffer.from(addrHex(PAYEE), "hex"), 2_000_000]]],
      [2, 300_000],
    ]);
    const cbor = Encoder.encode([body, [1, 2], true, null]).toString("hex");
    expect(() => summariseTx(cbor, v.ownAddressesHex, v.held, 0)).toThrow(/witnesses/);
  });

  it("refuses a withdrawal whose reward-account header is neither a key nor a script account", async () => {
    const a = await acct();
    const v = viewOf(a);
    const cbor = tx({ withdrawals: [["00" + "5c".repeat(28), 0]] });
    expect(() => summariseTx(cbor, v.ownAddressesHex, v.held, 0)).toThrow(/withdraws from an account/);
  });

  it("refuses a foreign withdrawal whose amount is not a number (it used to be skipped unread)", async () => {
    const a = await acct();
    const v = viewOf(a);
    const body = new Map<number, unknown>([
      [0, [[Buffer.from(OWN_TXID, "hex"), 1]]],
      [1, [[Buffer.from(addrHex(PAYEE), "hex"), 2_000_000]]],
      [2, 300_000],
      [5, new Map([[Buffer.from(SCRIPT_REWARD, "hex"), "0"]])],
    ]);
    const cbor = Encoder.encode([body, new Map(), true, null]).toString("hex");
    expect(() => summariseTx(cbor, v.ownAddressesHex, v.held, 0)).toThrow(/withdrawal amount/);
  });
});

describe("a foreign withdrawal blocks the signature until that entry is confirmed", () => {
  it("by default: refused, nothing signed", async () => {
    const a = await acct();
    expect(() => signForeignTx(injected(), a, viewOf(a), true)).toThrow(/^sign_foreign_withdrawal_unconfirmed: f05c/);
  });

  it("a confirmation for another account does not count", async () => {
    const a = await acct();
    expect(() => signForeignTx(injected(), a, viewOf(a), true, new Set([OTHER_KEY_REWARD]))).toThrow(
      /^sign_foreign_withdrawal_unconfirmed: /,
    );
  });

  it("two foreign withdrawals, one confirmed: still refused, naming the other", async () => {
    const a = await acct();
    const cbor = tx({
      withdrawals: [
        [OTHER_KEY_REWARD, 1_000_000],
        [SCRIPT_REWARD, 0],
      ],
      redeemers: conway([3, 0]),
    });
    expect(() => signForeignTx(cbor, a, viewOf(a), true, new Set([SCRIPT_REWARD]))).toThrow(
      new RegExp(`^sign_foreign_withdrawal_unconfirmed: ${OTHER_KEY_REWARD}$`),
    );
  });

  it("every entry confirmed: signed, by this wallet's payment key only", async () => {
    const a = await acct();
    const ws = signForeignTx(injected(), a, viewOf(a), true, new Set([SCRIPT_REWARD]));
    expect(typeof ws).toBe("string");
    expect(ws.length).toBeGreaterThan(0);
  });

  it("a transaction with no foreign withdrawal needs no confirmation", async () => {
    const a = await acct();
    expect(() => signForeignTx(tx(), a, viewOf(a), true)).not.toThrow();
  });
});

describe("certificates, votes and proposals are refused by name, on the screen and in the signer", () => {
  it.each([
    ["a certificate", 4, [[0, [0, Buffer.from("22".repeat(28), "hex")]]], "sign_foreign_certificate"],
    ["a governance vote (field 19)", 19, new Map(), "sign_foreign_vote"],
    ["a governance proposal (field 20)", 20, [], "sign_foreign_proposal"],
  ])("%s", async (_label, field, value, key) => {
    const a = await acct();
    const v = viewOf(a);
    const cbor = tx({ extra: [[field as number, value]] });
    let screen: unknown;
    try {
      summariseTx(cbor, v.ownAddressesHex, v.held, 0);
    } catch (e) {
      screen = e;
    }
    expect(screen).toBeInstanceOf(UndescribableTxError);
    expect((screen as UndescribableTxError).key).toBe(key);
    expect(() => signForeignTx(cbor, a, v, true, new Set())).toThrow(new RegExp(`^${key}`));
  });
});
