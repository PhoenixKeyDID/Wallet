/**
 * Tokens a website's transaction creates: named one by one, by unit (policy id
 * + asset name), and the signature waits until the person confirmed each unit.
 *
 * Before this, any positive mint was refused outright, on the screen and in
 * the signer. A minting policy that asks for this wallet's key counts the
 * signature as its yes, and this wallet cannot read what the policy checks, so
 * the decision goes to the person — one asset at a time, never one box for a
 * whole policy. The screen (`summariseTx`) and the signer (`signForeignTx`)
 * read the mint through the same function, which these cases hold both ways.
 */
import { describe, it, expect } from "vitest";
import { Buffer } from "buffer";
import { Encoder } from "@stricahq/cbors";
import { utils as tyUtils, types as tyTypes } from "@stricahq/typhonjs";
import { accountFromEntropy, type Account } from "../derive";
import { signForeignTx, type WalletView } from "../signForeign";
import { mintConfirmKey, summariseTx, unconfirmedForeignActions, UndescribableTxError } from "../../cardano/txSummary";
import { baseAddress, type PhoenixNetwork } from "../../cardano/address";

const NETWORK: PhoenixNetwork = 0;
const ENTROPY = Uint8Array.from(Buffer.alloc(32, 12));
const PAYEE = baseAddress("ab".repeat(28), "cd".repeat(28), NETWORK);
const OWN_TXID = "77".repeat(32);

const POLICY_A = "a1".repeat(28);
const POLICY_B = "b2".repeat(28);
const GOLD = Buffer.from("GOLD", "utf8").toString("hex");
const SILVER = Buffer.from("SILVER", "utf8").toString("hex");
const A_GOLD = POLICY_A + GOLD;
const A_SILVER = POLICY_A + SILVER;
const B_GOLD = POLICY_B + GOLD;

let account: Account;
const acct = async () => (account ??= await accountFromEntropy(ENTROPY, 0, NETWORK));
const addrHex = (bech32: string) => (tyUtils.getAddressFromString(bech32) as tyTypes.ShelleyAddress).getHex();

const viewOf = (a: Account): WalletView => ({
  ownAddressesHex: a.external.map((d) => addrHex(d.address)),
  held: new Map([[`${OWN_TXID}#1`, { address: a.external[0]!.address, lovelace: BigInt(20_000_000), assets: new Map() }]]),
  heldWithScript: new Map(),
});

type MintSpec = [policyId: string, assets: [assetNameHex: string, qty: number][]][];

const mintMap = (spec: MintSpec) =>
  new Map(spec.map(([p, assets]) => [Buffer.from(p, "hex"), new Map(assets.map(([n, q]) => [Buffer.from(n, "hex"), q]))]));

/** An ordinary spend of this wallet's coin, with field 9 (and optionally 5) added. */
function tx(opts: { mint?: MintSpec; withdrawals?: [string, number][]; redeemers?: [number, number][] } = {}): string {
  const body = new Map<number, unknown>([
    [0, [[Buffer.from(OWN_TXID, "hex"), 1]]],
    [1, [[Buffer.from(addrHex(PAYEE), "hex"), 2_000_000]]],
    [2, 300_000],
  ]);
  if (opts.withdrawals) body.set(5, new Map(opts.withdrawals.map(([hex, n]) => [Buffer.from(hex, "hex"), n])));
  if (opts.mint) body.set(9, mintMap(opts.mint));
  const ws = new Map<number, unknown>();
  if (opts.redeemers) ws.set(5, new Map(opts.redeemers.map(([tag, index]) => [[tag, index], [0, [1000, 100000]]])));
  return Encoder.encode([body, ws, true, null]).toString("hex");
}

const summary = async (cbor: string) => {
  const v = viewOf(await acct());
  return summariseTx(cbor, v.ownAddressesHex, v.held, 0);
};

describe("the summary names every created token, one entry per unit", () => {
  it("one token: listed with unit, policy, name and quantity, and it awaits confirmation", async () => {
    const s = await summary(tx({ mint: [[POLICY_A, [[GOLD, 5]]]] }));
    expect(s.foreignMintList).toEqual([
      { unit: A_GOLD, policyId: POLICY_A, assetNameHex: GOLD, quantity: BigInt(5), script: false },
    ]);
    expect(s.burns).toEqual([]);
    expect(unconfirmedForeignActions(s, new Set())).toEqual([mintConfirmKey(A_GOLD)]);
    expect(unconfirmedForeignActions(s, new Set([mintConfirmKey(A_GOLD)]))).toEqual([]);
  });

  it("two tokens under two policies: two entries, each its own confirmation key", async () => {
    const s = await summary(tx({ mint: [[POLICY_A, [[GOLD, 1]]], [POLICY_B, [[GOLD, 2]]]] }));
    expect(s.foreignMintList.map((m) => [m.unit, m.quantity])).toEqual([
      [A_GOLD, BigInt(1)],
      [B_GOLD, BigInt(2)],
    ]);
    expect(unconfirmedForeignActions(s, new Set([mintConfirmKey(A_GOLD)]))).toEqual([mintConfirmKey(B_GOLD)]);
  });

  it("two tokens under one policy: confirming one unit (or the policy) does not confirm the other", async () => {
    const s = await summary(tx({ mint: [[POLICY_A, [[GOLD, 1], [SILVER, 3]]]] }));
    expect(s.foreignMintList.map((m) => m.unit)).toEqual([A_GOLD, A_SILVER]);
    expect(unconfirmedForeignActions(s, new Set([mintConfirmKey(A_GOLD)]))).toEqual([mintConfirmKey(A_SILVER)]);
    expect(unconfirmedForeignActions(s, new Set([POLICY_A, mintConfirmKey(POLICY_A)]))).toHaveLength(2);
  });

  it("mint and burn in one transaction: the burn is a burn (no box), the mint is listed", async () => {
    const s = await summary(tx({ mint: [[POLICY_A, [[GOLD, -4], [SILVER, 2]]]] }));
    expect(s.burns.map((b) => [b.unit, b.amount])).toEqual([[A_GOLD, BigInt(4)]]);
    expect(s.foreignMintList.map((m) => [m.unit, m.quantity])).toEqual([[A_SILVER, BigInt(2)]]);
    expect(unconfirmedForeignActions(s, new Set())).toEqual([mintConfirmKey(A_SILVER)]);
  });

  it("a quantity of zero is refused, under the signer's own key", async () => {
    let err: unknown;
    try {
      await summary(tx({ mint: [[POLICY_A, [[GOLD, 0]]]] }));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(UndescribableTxError);
    expect((err as UndescribableTxError).message).toMatch(/mints zero/);
    expect((err as UndescribableTxError).key).toBe("sign_foreign_mint");
  });

  it("the script flag follows the mint redeemer to its policy in ledger order, not body order", async () => {
    // Body order B then A; the ledger sorts policies, so index 0 is A.
    const s = await summary(tx({ mint: [[POLICY_B, [[GOLD, 1]]], [POLICY_A, [[GOLD, 1], [SILVER, 1]]]], redeemers: [[1, 0]] }));
    const flags = new Map(s.foreignMintList.map((m) => [m.unit, m.script]));
    expect(flags.get(A_GOLD)).toBe(true);
    expect(flags.get(A_SILVER)).toBe(true);
    expect(flags.get(B_GOLD)).toBe(false);
  });

  it("a mint redeemer pointing past the last policy is refused", async () => {
    await expect(summary(tx({ mint: [[POLICY_A, [[GOLD, 1]]]], redeemers: [[1, 1]] }))).rejects.toThrow(
      /points at a mint it does not have/,
    );
  });
});

describe("a created token blocks the signature until that unit is confirmed", () => {
  it("by default: refused, naming the unit, nothing signed", async () => {
    const a = await acct();
    expect(() => signForeignTx(tx({ mint: [[POLICY_A, [[GOLD, 1]]]] }), a, viewOf(a), true)).toThrow(
      new RegExp(`^sign_foreign_mint_unconfirmed: ${A_GOLD}$`),
    );
  });

  it("a confirmation by policy id, or by the bare unit, does not count", async () => {
    const a = await acct();
    const cbor = tx({ mint: [[POLICY_A, [[GOLD, 1]]]] });
    for (const wrong of [POLICY_A, A_GOLD, mintConfirmKey(POLICY_A)]) {
      expect(() => signForeignTx(cbor, a, viewOf(a), true, new Set([wrong]))).toThrow(/^sign_foreign_mint_unconfirmed: /);
    }
  });

  it("two units under one policy, one confirmed: still refused, naming the other", async () => {
    const a = await acct();
    const cbor = tx({ mint: [[POLICY_A, [[GOLD, 1], [SILVER, 1]]]] });
    expect(() => signForeignTx(cbor, a, viewOf(a), true, new Set([mintConfirmKey(A_GOLD)]))).toThrow(
      new RegExp(`^sign_foreign_mint_unconfirmed: ${A_SILVER}$`),
    );
  });

  it("every unit confirmed: signed", async () => {
    const a = await acct();
    const cbor = tx({ mint: [[POLICY_A, [[GOLD, 1], [SILVER, 1]]], [POLICY_B, [[GOLD, 9]]]] });
    const ws = signForeignTx(cbor, a, viewOf(a), true, new Set([A_GOLD, A_SILVER, B_GOLD].map(mintConfirmKey)));
    expect(typeof ws).toBe("string");
    expect(ws.length).toBeGreaterThan(0);
  });

  it("a burn alone needs no confirmation", async () => {
    const a = await acct();
    expect(() => signForeignTx(tx({ mint: [[POLICY_A, [[GOLD, -1]]]] }), a, viewOf(a), true)).not.toThrow();
  });

  it("a quantity of zero is refused by the signer under sign_foreign_mint, confirmed or not", async () => {
    const a = await acct();
    const cbor = tx({ mint: [[POLICY_A, [[GOLD, 0]]]] });
    expect(() => signForeignTx(cbor, a, viewOf(a), true, new Set([mintConfirmKey(A_GOLD)]))).toThrow(/^sign_foreign_mint: /);
  });

  it("ticking a withdrawal whose account hex equals a token's unit does not confirm the token", async () => {
    // A 29-byte reward account and a unit with a one-byte name are both 58 hex
    // characters. Policy f05c…5c (28 bytes) + name 5c spells the script reward
    // account f0 + 5c×28 exactly.
    const SCRIPT_REWARD = "f0" + "5c".repeat(28);
    const policy = SCRIPT_REWARD.slice(0, 56);
    const name = SCRIPT_REWARD.slice(56);
    expect(policy + name).toBe(SCRIPT_REWARD);
    const a = await acct();
    const cbor = tx({ withdrawals: [[SCRIPT_REWARD, 0]], mint: [[policy, [[name, 1]]]] });
    expect(() => signForeignTx(cbor, a, viewOf(a), true, new Set([SCRIPT_REWARD]))).toThrow(
      new RegExp(`^sign_foreign_mint_unconfirmed: ${SCRIPT_REWARD}$`),
    );
    expect(() => signForeignTx(cbor, a, viewOf(a), true, new Set([SCRIPT_REWARD, mintConfirmKey(SCRIPT_REWARD)]))).not.toThrow();
  });
});
