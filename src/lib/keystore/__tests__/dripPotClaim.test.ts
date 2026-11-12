/**
 * A LAMP drip-pot claim, end to end through both gates a dApp `signTx` meets:
 * the screen (`summariseTx`) and the key holder (`signForeignTx`).
 *
 * The claim is the transaction a delegator signs to take LAMP out of the pot:
 * a script input, collateral from the wallet, the burn of one auth token, and
 * `partialSign = true` because the script input is nobody's key to sign. Each
 * refusal case below puts back exactly one thing on top of that same claim, so
 * a case going green cannot be the claim itself being refused.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { Buffer } from "buffer";
import { createPublicKey, verify as edVerify } from "node:crypto";
import { Decoder, Encoder } from "@stricahq/cbors";
import { utils as tyUtils, types as tyTypes } from "@stricahq/typhonjs";
import { accountFromEntropy, type Account } from "../derive";
import { signForeignTx, type WalletView } from "../signForeign";
import { summariseTx, UndescribableTxError } from "../../cardano/txSummary";
import { blake2b224, blake2b256 } from "../../cardano/hash";
import {
  dripClaimTxHex,
  AUTH_POLICY,
  AUTH_NAME,
  LAMP_POLICY,
  LAMP_NAME,
  type ClaimOpts,
} from "./fixtures/dripPotClaim";

const NETWORK = 0 as const;
const FEE_IN = { txId: "61".repeat(32), index: 1 };
const COLL_IN = { txId: "62".repeat(32), index: 0, lovelace: BigInt(5_000_000) };
/** A large coin of this wallet: 10 000 ADA. */
const BIG_COLL = { txId: "64".repeat(32), index: 0, lovelace: BigInt(10_000_000_000) };
/** A 3 ADA coin of this wallet carrying 500 tokens. */
const TOKEN_COLL = { txId: "65".repeat(32), index: 0, lovelace: BigInt(3_000_000) };
const COLL_TOKEN_POLICY = "e7".repeat(28);
const COLL_TOKEN_UNIT = COLL_TOKEN_POLICY + "41";

let account: Account;
let walletHex: string;
let ownAddrs: string[];
let held: Map<string, { lovelace: bigint; assets: Map<string, bigint> }>;
let view: WalletView;

const addrHex = (bech32: string) => (tyUtils.getAddressFromString(bech32) as tyTypes.ShelleyAddress).getHex();
const claim = (extra?: Partial<ClaimOpts>) =>
  dripClaimTxHex({ walletAddressHex: walletHex, feeInput: FEE_IN, collateralInput: COLL_IN, network: NETWORK, ...extra });
const summary = (hex: string) => summariseTx(hex, ownAddrs, held, NETWORK);
const sign = (hex: string) => signForeignTx(hex, account, view, true);

beforeAll(async () => {
  account = await accountFromEntropy(Uint8Array.from(Buffer.alloc(32, 9)), 0, NETWORK);
  walletHex = addrHex(account.external[0]!.address);
  ownAddrs = [...account.external, ...account.internal].map((a) => addrHex(a.address));
  held = new Map([
    [`${FEE_IN.txId}#${FEE_IN.index}`, { lovelace: BigInt(5_000_000), assets: new Map() }],
    [`${COLL_IN.txId}#${COLL_IN.index}`, { lovelace: COLL_IN.lovelace, assets: new Map() }],
    [`${BIG_COLL.txId}#${BIG_COLL.index}`, { lovelace: BIG_COLL.lovelace, assets: new Map() }],
    [`${TOKEN_COLL.txId}#${TOKEN_COLL.index}`, { lovelace: TOKEN_COLL.lovelace, assets: new Map([[COLL_TOKEN_UNIT, BigInt(500)]]) }],
  ]);
  view = {
    ownAddressesHex: ownAddrs,
    held: new Map([
      [`${FEE_IN.txId}#${FEE_IN.index}`, { address: account.external[0]!.address, ...held.get(`${FEE_IN.txId}#${FEE_IN.index}`)! }],
      [`${COLL_IN.txId}#${COLL_IN.index}`, { address: account.external[1]!.address, ...held.get(`${COLL_IN.txId}#${COLL_IN.index}`)! }],
      [`${BIG_COLL.txId}#${BIG_COLL.index}`, { address: account.external[1]!.address, ...held.get(`${BIG_COLL.txId}#${BIG_COLL.index}`)! }],
      [`${TOKEN_COLL.txId}#${TOKEN_COLL.index}`, { address: account.external[1]!.address, ...held.get(`${TOKEN_COLL.txId}#${TOKEN_COLL.index}`)! }],
    ]),
  };
});

/** Ed25519 verify through OpenSSL — a different implementation from the signer. */
function verifies(pub: Buffer, msg: Buffer, sig: Buffer): boolean {
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pub]);
  return edVerify(null, msg, createPublicKey({ key: spki, format: "der", type: "spki" }), sig);
}

describe("drip-pot claim: what the screen shows", () => {
  // The claim pays the LAMP to this wallet's own key address under an inline
  // tag datum. The ledger ignores a datum on a key-locked input, and the
  // wallet's UTxO reads keep such outputs (`walletOwnsOutput`), so the LAMP is
  // coming in and its 1.3 ADA is change: the ADA cost is 5 ADA fee input −
  // 3.2 ADA plain change − 1.3 ADA = 0.5 ADA. The output is still listed, with
  // its datum flag, so the screen says a datum rides on it.
  it("shows the auth-token burn, the collateral at risk, and the LAMP coming in under its datum", () => {
    const s = summary(claim());
    expect(s.burns).toEqual([
      expect.objectContaining({ policyId: AUTH_POLICY, assetNameHex: AUTH_NAME, amount: BigInt(1) }),
    ]);
    expect(s.collateral).toEqual({ riskLovelace: BigInt(1_500_000), inputs: 1 });
    expect(s.net).toEqual([
      { unit: "", policyId: "", assetNameHex: "", amount: BigInt(500_000) },
      { unit: LAMP_POLICY + LAMP_NAME, policyId: LAMP_POLICY, assetNameHex: LAMP_NAME, amount: -BigInt(1_000_000_000) },
    ]);
    expect(s.toOthers).toEqual([]);
    expect(s.toSelfWithDatum).toEqual([
      {
        address: account.external[0]!.address,
        lovelace: BigInt(1_300_000),
        assets: [
          { unit: LAMP_POLICY + LAMP_NAME, policyId: LAMP_POLICY, assetNameHex: LAMP_NAME, amount: BigInt(1_000_000_000) },
        ],
        mine: true,
        datum: true,
      },
    ]);
    expect(s.ownInputs).toBe(1);
    expect(s.totalInputs).toBe(2);
    // The pot's script input is not this wallet's and a script runs: counted,
    // so the screen warns — and the claim still signs (below).
    expect(s.foreignInputsUnderScript).toBe(1);
    expect(s.fee).toBe(BigInt(450_000));
  });
});

describe("drip-pot claim: what the key holder signs", () => {
  it("returns a witness set with exactly the fee and collateral payment keys, each verifying over the body hash", () => {
    const hex = claim();
    const ws = Decoder.decode(Buffer.from(sign(hex), "hex")).value as Map<number, [Buffer, Buffer][]>;
    expect([...ws.keys()]).toEqual([0]);
    const vkeys = ws.get(0)!;
    // Body hash recomputed here from the bytes as given, not from signForeign's own slicing.
    const bodyHash = blake2b256(sliceBody(Buffer.from(hex, "hex")));
    const hashes = Array.from(vkeys).map(([pub]) => Buffer.from(blake2b224(pub)).toString("hex")).sort();
    expect(hashes).toEqual([account.external[0]!.keyHashHex, account.external[1]!.keyHashHex].sort());
    for (const [pub, sig] of vkeys) expect(verifies(pub, Buffer.from(bodyHash), sig)).toBe(true);
    expect(hashes).not.toContain(account.stakeKeyHashHex);
  });

  it("without partialSign still signs, because every key it needs is the wallet's", () => {
    expect(() => signForeignTx(claim(), account, view, false)).not.toThrow();
  });
});

/**
 * The body's bytes as given. The fixture is encoded by one canonical encoder,
 * so re-encoding the decoded body must reproduce bytes 1.. of the transaction
 * exactly — checked, so a fixture change that broke that would fail here
 * rather than quietly hash something else.
 */
function sliceBody(tx: Buffer): Buffer {
  const outer = Decoder.decode(tx).value as unknown[];
  const again = Encoder.encode(outer[0]);
  const given = tx.subarray(1, 1 + again.length);
  if (tx[0] !== 0x84 || !given.equals(again)) throw new Error("fixture body is not canonical");
  return given;
}

describe("drip-pot claim with one thing added: both layers refuse", () => {
  const ATTACKER_DREP = "dd".repeat(28);
  const cases: { name: string; opts: Partial<ClaimOpts>; signer: RegExp; screen: RegExp }[] = [
    {
      name: "a vote-delegation certificate (sec1102-c)",
      opts: {
        extra: (b) =>
          b.set(4, [
            [9, [0, Buffer.from("00".repeat(28), "hex")], [0, Buffer.from(ATTACKER_DREP, "hex")]],
          ]),
      },
      signer: /sign_foreign_certificate/,
      screen: /carries a certificate/,
    },
    {
      name: "a stake deregistration certificate",
      opts: { extra: (b) => b.set(4, [[1, [0, Buffer.from("00".repeat(28), "hex")]]]) },
      signer: /sign_foreign_certificate/,
      screen: /carries a certificate/,
    },
    {
      name: "a positive mint next to the burn",
      opts: {
        extra: (b) =>
          b.set(
            9,
            new Map([
              [Buffer.from(AUTH_POLICY, "hex"), new Map([[Buffer.from(AUTH_NAME, "hex"), -1]])],
              [Buffer.from("e1".repeat(28), "hex"), new Map([[Buffer.from("41", "hex"), 1]])],
            ]),
          ),
      },
      signer: /sign_foreign_mint/,
      screen: /creates tokens/,
    },
    {
      name: "network_id naming mainnet on a testnet wallet",
      opts: { extra: (b) => b.set(15, 1) },
      signer: /sign_foreign_wrong_network/,
      screen: /another network/,
    },
    {
      name: "collateral the wallet does not hold",
      opts: { extra: (b) => b.set(13, [[Buffer.from("63".repeat(32), "hex"), 0]]) },
      signer: /sign_foreign_collateral_not_own/,
      screen: /collateral this wallet cannot account for/,
    },
    {
      name: "is_valid = false (the script is declared to fail: collateral is spent)",
      opts: { isValid: false },
      signer: /sign_foreign_declared_invalid/,
      screen: /declares that its own script fails/,
    },
    // The rest are refused by the signer only because it runs the screen's own
    // `summariseTx` (`sign_foreign_undescribable`). Before that, each of these
    // got a witness from `signForeignTx` called directly.
    {
      name: "field 22: a treasury donation",
      opts: { extra: (b) => b.set(22, BigInt(50_000_000)) },
      signer: /sign_foreign_undescribable: .*field 22/,
      screen: /field 22/,
    },
    {
      name: "field 21: the current treasury value",
      opts: { extra: (b) => b.set(21, BigInt(1)) },
      signer: /sign_foreign_undescribable: .*field 21/,
      screen: /field 21/,
    },
    {
      name: "field 20: a governance proposal",
      opts: { extra: (b) => b.set(20, []) },
      signer: /sign_foreign_undescribable: .*field 20/,
      screen: /field 20/,
    },
    {
      name: "a collateral return to someone else (all the collateral is lost if the script fails)",
      opts: {
        extra: (b) =>
          b.set(
            16,
            new Map<number, unknown>([[0, Buffer.concat([Buffer.from([0x60]), Buffer.alloc(28, 0xab)])], [1, BigInt(3_500_000)]]),
          ),
      },
      signer: /sign_foreign_undescribable: .*collateral return to an address that is not this wallet/,
      screen: /collateral return to an address that is not this wallet/,
    },
    {
      name: "a declared collateral total that disagrees with collateral minus return",
      opts: { extra: (b) => b.set(17, BigInt(1_000_000)) },
      signer: /sign_foreign_undescribable: .*collateral total/,
      screen: /collateral total/,
    },
    {
      name: "the wallet's fee input named twice (array form)",
      opts: {
        extra: (b) => b.set(0, [...(b.get(0) as unknown[]), [Buffer.from(FEE_IN.txId, "hex"), FEE_IN.index]]),
      },
      signer: /sign_foreign_undescribable: .*same input twice/,
      screen: /same input twice/,
    },
  ];

  it.each(cases)("$name", ({ opts, signer, screen }) => {
    const hex = claim(opts);
    expect(() => sign(hex)).toThrow(signer);
    let err: unknown;
    try {
      summary(hex);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(UndescribableTxError);
    expect((err as Error).message).toMatch(screen);
  });
});

/**
 * The collateral cap on the signing path. The page that builds a transaction
 * also decides whether its script fails, so whatever the collateral can lose
 * is money the page can take. Both layers refuse more than 5 ADA at risk —
 * collateral minus return — and tokens the return does not give back, under
 * one i18n key each, so the screen and the signer name the same reason.
 */
describe("drip-pot claim: the collateral at risk is capped at 5 ADA on both layers", () => {
  const ref = (c: { txId: string; index: number }) => [Buffer.from(c.txId, "hex"), c.index];
  /** Put `coin` up as collateral, returning `ret` lovelace (and `retAssets`) to the wallet; `undefined` drops the return. */
  const collateral = (coin: { txId: string; index: number }, ret: bigint | undefined, total?: bigint, retAssets?: Map<Buffer, Map<Buffer, bigint>>) =>
    claim({
      extra: (b) => {
        b.set(13, [ref(coin)]);
        if (ret === undefined) b.delete(16);
        else b.set(16, new Map<number, unknown>([[0, Buffer.from(walletHex, "hex")], [1, retAssets ? [ret, retAssets] : ret]]));
        if (total === undefined) b.delete(17);
        else b.set(17, total);
      },
    });
  const refusedBoth = (hex: string, key: string) => {
    expect(() => sign(hex)).toThrow(new RegExp(`^${key}: `));
    let err: unknown;
    try {
      summary(hex);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(UndescribableTxError);
    expect((err as UndescribableTxError).key).toBe(key);
  };

  it("refuses a 10 000 ADA coin as collateral with no return (the page fails its script and the ledger takes it all)", () => {
    refusedBoth(collateral(BIG_COLL, undefined), "sign_foreign_collateral_over_cap");
  });

  it("signs the same 10 000 ADA coin when the return gives back all but 1.5 ADA", () => {
    const hex = collateral(BIG_COLL, BIG_COLL.lovelace - BigInt(1_500_000), BigInt(1_500_000));
    expect(summary(hex).collateral).toEqual({ riskLovelace: BigInt(1_500_000), inputs: 1 });
    expect(() => sign(hex)).not.toThrow();
  });

  it("signs a risk of exactly 5 ADA", () => {
    const hex = collateral(BIG_COLL, BIG_COLL.lovelace - BigInt(5_000_000), BigInt(5_000_000));
    expect(summary(hex).collateral).toEqual({ riskLovelace: BigInt(5_000_000), inputs: 1 });
    expect(() => sign(hex)).not.toThrow();
  });

  it("refuses a risk of 5 ADA and one lovelace", () => {
    refusedBoth(
      collateral(BIG_COLL, BIG_COLL.lovelace - BigInt(5_000_001), BigInt(5_000_001)),
      "sign_foreign_collateral_over_cap",
    );
  });

  it("refuses the over-cap risk with no declared total too (field 17 absent)", () => {
    refusedBoth(collateral(BIG_COLL, BIG_COLL.lovelace - BigInt(5_000_001)), "sign_foreign_collateral_over_cap");
  });

  it("refuses tokens put up as collateral that the return does not give back, even with 1 ADA at risk", () => {
    refusedBoth(collateral(TOKEN_COLL, BigInt(2_000_000), BigInt(1_000_000)), "sign_foreign_collateral_tokens");
  });

  it("signs the token coin as collateral when the return gives every token back", () => {
    const tokens = new Map([[Buffer.from(COLL_TOKEN_POLICY, "hex"), new Map([[Buffer.from("41", "hex"), BigInt(500)]])]]);
    const hex = collateral(TOKEN_COLL, BigInt(2_000_000), BigInt(1_000_000), tokens);
    expect(summary(hex).collateral).toEqual({ riskLovelace: BigInt(1_000_000), inputs: 1 });
    expect(() => sign(hex)).not.toThrow();
  });
});
