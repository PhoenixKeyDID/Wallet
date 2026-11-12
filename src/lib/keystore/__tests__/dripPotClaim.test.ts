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
import { signForeignTx } from "../signForeign";
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

let account: Account;
let walletHex: string;
let ownAddrs: string[];
let held: Map<string, { lovelace: bigint; assets: Map<string, bigint> }>;
let addrByRef: Map<string, string>;

const addrHex = (bech32: string) => (tyUtils.getAddressFromString(bech32) as tyTypes.ShelleyAddress).getHex();
const claim = (extra?: Partial<ClaimOpts>) =>
  dripClaimTxHex({ walletAddressHex: walletHex, feeInput: FEE_IN, collateralInput: COLL_IN, network: NETWORK, ...extra });
const summary = (hex: string) => summariseTx(hex, ownAddrs, held, NETWORK);
const sign = (hex: string) => signForeignTx(hex, account, addrByRef, true);

beforeAll(async () => {
  account = await accountFromEntropy(Uint8Array.from(Buffer.alloc(32, 9)), 0, NETWORK);
  walletHex = addrHex(account.external[0]!.address);
  ownAddrs = [...account.external, ...account.internal].map((a) => addrHex(a.address));
  held = new Map([
    [`${FEE_IN.txId}#${FEE_IN.index}`, { lovelace: BigInt(5_000_000), assets: new Map() }],
    [`${COLL_IN.txId}#${COLL_IN.index}`, { lovelace: COLL_IN.lovelace, assets: new Map() }],
  ]);
  addrByRef = new Map([
    [`${FEE_IN.txId}#${FEE_IN.index}`, account.external[0]!.address],
    [`${COLL_IN.txId}#${COLL_IN.index}`, account.external[1]!.address],
  ]);
});

/** Ed25519 verify through OpenSSL — a different implementation from the signer. */
function verifies(pub: Buffer, msg: Buffer, sig: Buffer): boolean {
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pub]);
  return edVerify(null, msg, createPublicKey({ key: spki, format: "der", type: "spki" }), sig);
}

describe("drip-pot claim: what the screen shows", () => {
  // The claim pays the LAMP to this wallet's own address under an inline tag
  // datum. The wallet's UTxO reads skip outputs carrying a datum, so that
  // output is not counted as coming back: it is listed as a recipient with the
  // datum flag, and its 1.3 ADA counts as leaving (5 ADA fee input − 3.2 ADA
  // plain change = 1.8 ADA).
  it("shows the auth-token burn, the collateral at risk, and the LAMP output under its datum", () => {
    const s = summary(claim());
    expect(s.burns).toEqual([
      expect.objectContaining({ policyId: AUTH_POLICY, assetNameHex: AUTH_NAME, amount: BigInt(1) }),
    ]);
    expect(s.collateral).toEqual({ riskLovelace: BigInt(1_500_000), inputs: 1 });
    expect(s.net).toEqual([{ unit: "", policyId: "", assetNameHex: "", amount: BigInt(1_800_000) }]);
    expect(s.toOthers).toEqual([
      {
        address: account.external[0]!.address,
        lovelace: BigInt(1_300_000),
        assets: [
          { unit: LAMP_POLICY + LAMP_NAME, policyId: LAMP_POLICY, assetNameHex: LAMP_NAME, amount: BigInt(1_000_000_000) },
        ],
        mine: false,
        datum: true,
      },
    ]);
    expect(s.ownInputs).toBe(1);
    expect(s.totalInputs).toBe(2);
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
    expect(() => signForeignTx(claim(), account, addrByRef, false)).not.toThrow();
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

  it("a collateral return to someone else: the screen refuses (the signer leaves it to the screen)", () => {
    const other = Buffer.concat([Buffer.from([0x60]), Buffer.alloc(28, 0xab)]);
    const hex = claim({ extra: (b) => b.set(16, new Map<number, unknown>([[0, other], [1, BigInt(3_500_000)]])) });
    expect(() => summary(hex)).toThrow(/collateral return to an address that is not this wallet/);
  });
});
