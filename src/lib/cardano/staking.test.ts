import { describe, it, expect } from "vitest";
import { Buffer } from "buffer";
import BigNumber from "bignumber.js";
import { bech32 } from "bech32";
import { address as tyAddress, types as tyTypes } from "@stricahq/typhonjs";
import {
  buildDelegation,
  buildWithdrawal,
  poolHashFromBech32,
  rewardAddressFromHex,
} from "./staking";

/**
 * Pure logic only — no network calls. Everything a builder needs (inputs,
 * protocol params, addresses) is handcrafted here, same approach as
 * `receive.test.ts` uses for its fixtures.
 */

const NETWORK_ID = tyTypes.NetworkId.TESTNET;

const PAYMENT_KEY_HASH = Buffer.alloc(28, 0xaa);
const STAKE_KEY_HASH = Buffer.alloc(28, 0xbb);

const paymentCredential: tyTypes.HashCredential = {
  hash: PAYMENT_KEY_HASH,
  type: tyTypes.HashType.ADDRESS,
};
const stakeCredential: tyTypes.HashCredential = {
  hash: STAKE_KEY_HASH,
  type: tyTypes.HashType.ADDRESS,
};

const changeAddress = new tyAddress.BaseAddress(NETWORK_ID, paymentCredential, stakeCredential);
const rewardAddressObj = new tyAddress.RewardAddress(NETWORK_ID, stakeCredential);
const rewardAddressHex = rewardAddressObj.getHex();

/** A syntactically valid `pool1...` bech32 id (28-byte hash of 0x11 bytes). */
function fixturePoolId(): string {
  const hash = Buffer.alloc(28, 0x11);
  return bech32.encode("pool", bech32.toWords(hash), 1000);
}

const protocolParams: tyTypes.ProtocolParams = {
  minFeeA: new BigNumber(44),
  minFeeB: new BigNumber(155381),
  stakeKeyDeposit: new BigNumber(2000000),
  utxoCostPerByte: new BigNumber(4310),
  collateralPercent: new BigNumber(150),
  priceSteps: new BigNumber(0.0577),
  priceMem: new BigNumber(0.0577),
  maxTxSize: 16384,
  maxValueSize: 5000,
  minFeeRefScriptCostPerByte: new BigNumber(15),
};

const utxoAddress = new tyAddress.BaseAddress(NETWORK_ID, paymentCredential, stakeCredential);

function fixtureInputs(): tyTypes.Input[] {
  return [
    {
      txId: "aa".repeat(32),
      index: 0,
      amount: new BigNumber(10_000_000),
      tokens: [],
      address: utxoAddress,
    },
  ];
}

describe("rewardAddressFromHex", () => {
  it("round-trips a reward address hex back to the same stake credential", () => {
    const parsed = rewardAddressFromHex(rewardAddressHex);
    expect(parsed.stakeCredential.hash.toString("hex")).toBe(STAKE_KEY_HASH.toString("hex"));
  });

  it("rejects a non-reward address", () => {
    expect(() => rewardAddressFromHex(changeAddress.getHex())).toThrow();
  });
});

describe("poolHashFromBech32", () => {
  it("decodes a pool1... id to its 28-byte hash hex", () => {
    expect(poolHashFromBech32(fixturePoolId())).toBe("11".repeat(28));
  });

  it("rejects a non-pool bech32 string", () => {
    expect(() => poolHashFromBech32(changeAddress.getBech32())).toThrow();
  });
});

describe("buildDelegation", () => {
  it("adds a stake-delegation certificate to the given pool", () => {
    const built = buildDelegation({
      rewardAddress: rewardAddressHex,
      poolId: fixturePoolId(),
      needsRegistration: false,
      inputs: fixtureInputs(),
      changeAddress,
      protocolParams,
      tip: 1_000_000,
    });
    const certs = built.transaction.getCertificates();
    expect(certs).toHaveLength(1);
    const cert = certs[0] as tyTypes.StakeDelegationCertificate;
    expect(cert.type).toBe(tyTypes.CertificateType.STAKE_DELEGATION);
    expect(cert.cert.poolHash).toBe("11".repeat(28));
    expect(cert.cert.stakeCredential.hash.toString("hex")).toBe(STAKE_KEY_HASH.toString("hex"));
    expect(built.hash).toHaveLength(64);
    expect(BigInt(built.fee)).toBeGreaterThan(BigInt("0"));
  });

  it("prepends a stake-key-registration certificate when needsRegistration is true", () => {
    const built = buildDelegation({
      rewardAddress: rewardAddressHex,
      poolId: fixturePoolId(),
      needsRegistration: true,
      inputs: fixtureInputs(),
      changeAddress,
      protocolParams,
      tip: 1_000_000,
    });
    const certs = built.transaction.getCertificates();
    expect(certs).toHaveLength(2);
    const regCert = certs[0] as tyTypes.StakeKeyRegistrationCertificate;
    expect(regCert.type).toBe(tyTypes.CertificateType.STAKE_KEY_REGISTRATION);
    expect(regCert.cert.deposit.toString()).toBe(protocolParams.stakeKeyDeposit.toString());
    const delegCert = certs[1] as tyTypes.StakeDelegationCertificate;
    expect(delegCert.type).toBe(tyTypes.CertificateType.STAKE_DELEGATION);
  });
});

describe("buildWithdrawal", () => {
  it("adds a withdrawal for the requested amount from the wallet's reward account", () => {
    const amount = BigInt("5000000");
    const built = buildWithdrawal({
      rewardAddress: rewardAddressHex,
      amount,
      inputs: fixtureInputs(),
      changeAddress,
      protocolParams,
      tip: 1_000_000,
    });
    const withdrawals = built.transaction.getWithdrawals();
    expect(withdrawals).toHaveLength(1);
    expect(withdrawals[0].amount.toString()).toBe(amount.toString());
    expect(withdrawals[0].rewardAccount.getHex()).toBe(rewardAddressHex);
    expect(built.hash).toHaveLength(64);
  });

  it("rejects a zero or negative amount", () => {
    const base = {
      rewardAddress: rewardAddressHex,
      inputs: fixtureInputs(),
      changeAddress,
      protocolParams,
      tip: 1_000_000,
    };
    expect(() => buildWithdrawal({ ...base, amount: BigInt("0") })).toThrow();
    expect(() => buildWithdrawal({ ...base, amount: BigInt("-1") })).toThrow();
  });
});
