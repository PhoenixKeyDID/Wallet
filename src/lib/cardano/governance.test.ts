import { describe, it, expect } from "vitest";
import { Buffer } from "buffer";
import BigNumber from "bignumber.js";
import { bech32 } from "bech32";
import { address as tyAddress, types as tyTypes } from "@stricahq/typhonjs";
import {
  parseDRepId,
  parseGovActionId,
  dRepFromTarget,
  voteDelegationCert,
  drepRegCert,
  drepDeRegCert,
  dRepVoter,
  voteProcedure,
  buildVoteDelegation,
  buildVote,
  buildDRepRegistration,
  buildDRepDeRegistration,
  rewardAddressFrom,
} from "./governance";

// ── Handcrafted fixtures (no network) ──────────────────────────────────────────

const DREP_HASH = "ab".repeat(28); // 28-byte key hash hex
const STAKE_HASH = "cd".repeat(28);
const PAY_HASH = "ef".repeat(28);
const NET = tyTypes.NetworkId.TESTNET;

/** CIP-129 drep id: header byte + 28-byte hash, bech32 `drep…`. */
function cip129Drep(hashHex: string, isScript: boolean): string {
  const header = isScript ? 0x23 : 0x22;
  const bytes = Buffer.concat([Buffer.from([header]), Buffer.from(hashHex, "hex")]);
  return bech32.encode("drep", bech32.toWords(bytes), 200);
}

const rewardAddr = new tyAddress.RewardAddress(NET, {
  hash: Buffer.from(STAKE_HASH, "hex"),
  type: tyTypes.HashType.ADDRESS,
});
const baseAddr = new tyAddress.BaseAddress(
  NET,
  { hash: Buffer.from(PAY_HASH, "hex"), type: tyTypes.HashType.ADDRESS },
  { hash: Buffer.from(STAKE_HASH, "hex"), type: tyTypes.HashType.ADDRESS },
);

const protocolParams: tyTypes.ProtocolParams = {
  minFeeA: new BigNumber(44),
  minFeeB: new BigNumber(155381),
  stakeKeyDeposit: new BigNumber(2000000),
  utxoCostPerByte: new BigNumber(4310),
  collateralPercent: new BigNumber(150),
  priceSteps: new BigNumber(0.0000721),
  priceMem: new BigNumber(0.0577),
  maxTxSize: 16384,
  maxValueSize: 5000,
  minFeeRefScriptCostPerByte: new BigNumber(15),
};

function oneBigInput(lovelace: string): tyTypes.Input {
  return {
    txId: "00".repeat(32),
    index: 0,
    amount: new BigNumber(lovelace),
    tokens: [],
    address: baseAddr,
  };
}

const ctx = {
  inputs: [oneBigInput("1000000000")], // 1000 ADA
  protocolParams,
  changeAddress: baseAddr,
  ttl: 100000,
};

// ── parseDRepId ────────────────────────────────────────────────────────────────

describe("parseDRepId", () => {
  it("parses a bare 56-hex key hash as a key credential", () => {
    const c = parseDRepId(DREP_HASH);
    expect(c.hash.toString("hex")).toBe(DREP_HASH);
    expect(c.isScript).toBe(false);
  });

  it("parses a CIP-129 key drep id (header 0x22)", () => {
    const c = parseDRepId(cip129Drep(DREP_HASH, false));
    expect(c.hash.toString("hex")).toBe(DREP_HASH);
    expect(c.isScript).toBe(false);
  });

  it("parses a CIP-129 script drep id (header 0x23)", () => {
    const c = parseDRepId(cip129Drep(DREP_HASH, true));
    expect(c.hash.toString("hex")).toBe(DREP_HASH);
    expect(c.isScript).toBe(true);
  });
});

// ── parseGovActionId ─────────────────────────────────────────────────────────

describe("parseGovActionId", () => {
  it("parses txHash#index", () => {
    const txHash = "11".repeat(32);
    const id = parseGovActionId(`${txHash}#3`);
    expect(id.txId.toString("hex")).toBe(txHash);
    expect(id.index).toBe(3);
  });

  it("parses index 0", () => {
    expect(parseGovActionId(`${"22".repeat(32)}#0`).index).toBe(0);
  });

  it("rejects a bad tx hash", () => {
    expect(() => parseGovActionId("deadbeef#0")).toThrow();
  });

  it("rejects a non-integer / negative index", () => {
    expect(() => parseGovActionId(`${"33".repeat(32)}#x`)).toThrow();
    expect(() => parseGovActionId(`${"33".repeat(32)}#-1`)).toThrow();
  });
});

// ── dRepFromTarget / voteDelegationCert ───────────────────────────────────────

describe("voteDelegationCert", () => {
  const stakeCred = rewardAddr.stakeCredential;

  it("builds a VOTE_DELEGATION cert to a key dRep with the right DRep shape", () => {
    const cert = voteDelegationCert(stakeCred, { kind: "drep", drepId: DREP_HASH });
    expect(cert.type).toBe(tyTypes.CertificateType.VOTE_DELEGATION);
    expect(cert.cert.stakeCredential).toBe(stakeCred);
    expect(cert.cert.dRep.type).toBe(tyTypes.DRepType.ADDRESS);
    expect(cert.cert.dRep.key?.toString("hex")).toBe(DREP_HASH);
  });

  it("builds a SCRIPT dRep target from a CIP-129 script id", () => {
    const drep = dRepFromTarget({ kind: "drep", drepId: cip129Drep(DREP_HASH, true) });
    expect(drep.type).toBe(tyTypes.DRepType.SCRIPT);
    expect(drep.key?.toString("hex")).toBe(DREP_HASH);
  });

  it("Abstain → DRepType.ABSTAIN with no key", () => {
    const cert = voteDelegationCert(stakeCred, { kind: "abstain" });
    expect(cert.cert.dRep.type).toBe(tyTypes.DRepType.ABSTAIN);
    expect(cert.cert.dRep.key).toBeUndefined();
  });

  it("No-Confidence → DRepType.NO_CONFIDENCE with no key", () => {
    const cert = voteDelegationCert(stakeCred, { kind: "noConfidence" });
    expect(cert.cert.dRep.type).toBe(tyTypes.DRepType.NO_CONFIDENCE);
    expect(cert.cert.dRep.key).toBeUndefined();
  });
});

// ── vote procedures ──────────────────────────────────────────────────────────

describe("voteProcedure / dRepVoter", () => {
  it("produces a voting procedure with DREP_KEY voter and the right vote enum", () => {
    const cred = parseDRepId(DREP_HASH);
    const govActionId = parseGovActionId(`${"44".repeat(32)}#1`);
    const proc = voteProcedure(dRepVoter(cred), govActionId, tyTypes.VoteType.YES);
    expect(proc.voter.type).toBe(tyTypes.VoterType.DREP_KEY);
    expect(proc.voter.key.hash.toString("hex")).toBe(DREP_HASH);
    expect(proc.votes).toHaveLength(1);
    expect(proc.votes[0].vote).toBe(tyTypes.VoteType.YES);
    expect(proc.votes[0].govActionId.index).toBe(1);
    expect(proc.votes[0].anchor).toBeNull();
  });

  it("maps NO and ABSTAIN vote enums", () => {
    const cred = parseDRepId(DREP_HASH);
    const gid = parseGovActionId(`${"55".repeat(32)}#0`);
    expect(voteProcedure(dRepVoter(cred), gid, tyTypes.VoteType.NO).votes[0].vote).toBe(
      tyTypes.VoteType.NO,
    );
    expect(voteProcedure(dRepVoter(cred), gid, tyTypes.VoteType.ABSTAIN).votes[0].vote).toBe(
      tyTypes.VoteType.ABSTAIN,
    );
  });

  it("script voter → DREP_SCRIPT", () => {
    const cred = parseDRepId(cip129Drep(DREP_HASH, true));
    expect(dRepVoter(cred).type).toBe(tyTypes.VoterType.DREP_SCRIPT);
  });
});

// ── DREP_REG / DREP_DE_REG certs ──────────────────────────────────────────────

describe("drep reg/dereg certs", () => {
  it("DREP_REG cert carries credential, deposit and null anchor by default", () => {
    const cert = drepRegCert({ hash: Buffer.from(DREP_HASH, "hex"), isScript: false }, new BigNumber(500000000));
    expect(cert.type).toBe(tyTypes.CertificateType.DREP_REG);
    expect(cert.cert.dRepCredential.hash.toString("hex")).toBe(DREP_HASH);
    expect(cert.cert.dRepCredential.type).toBe(tyTypes.HashType.ADDRESS);
    expect(cert.cert.deposit.toString()).toBe("500000000");
    expect(cert.cert.anchor).toBeNull();
  });

  it("DREP_DE_REG cert carries credential and deposit", () => {
    const cert = drepDeRegCert({ hash: Buffer.from(DREP_HASH, "hex"), isScript: false }, new BigNumber(500000000));
    expect(cert.type).toBe(tyTypes.CertificateType.DREP_DE_REG);
    expect(cert.cert.deposit.toString()).toBe("500000000");
  });
});

// ── Full tx builds: assert on-chain balance (consumed == produced) ─────────────

function inputAda(inputs: tyTypes.Input[]): BigNumber {
  return inputs.reduce((a, i) => a.plus(i.amount), new BigNumber(0));
}
function outputAda(tx: { getOutputs(): tyTypes.Output[] }): BigNumber {
  return tx.getOutputs().reduce((a, o) => a.plus(o.amount), new BigNumber(0));
}

describe("buildVoteDelegation (prepareTransaction path)", () => {
  it("emits a VOTE_DELEGATION cert and balances (inputs = outputs + fee)", () => {
    const built = buildVoteDelegation({
      rewardAddress: rewardAddr,
      target: { kind: "abstain" },
      ...ctx,
    });
    const certs = built.transaction.getCertificates();
    expect(certs[0].type).toBe(tyTypes.CertificateType.VOTE_DELEGATION);

    const consumed = inputAda(built.transaction.getInputs());
    const produced = outputAda(built.transaction).plus(built.fee);
    expect(consumed.toString()).toBe(produced.toString());
    expect(new BigNumber(built.fee).isGreaterThan(0)).toBe(true);
    expect(built.unsignedCbor.length).toBeGreaterThan(0);
  });
});

describe("buildVote (prepareTransaction path)", () => {
  it("emits a voting procedure and balances", () => {
    const built = buildVote({
      voter: parseDRepId(DREP_HASH),
      govActionId: parseGovActionId(`${"66".repeat(32)}#2`),
      vote: tyTypes.VoteType.YES,
      ...ctx,
    });
    const procs = built.transaction.getVotingProcedures();
    expect(procs).toHaveLength(1);
    expect(procs[0].votes[0].vote).toBe(tyTypes.VoteType.YES);

    const consumed = inputAda(built.transaction.getInputs());
    const produced = outputAda(built.transaction).plus(built.fee);
    expect(consumed.toString()).toBe(produced.toString());
  });
});

describe("buildDRepRegistration (manual-balance path)", () => {
  const deposit = new BigNumber(500000000); // 500 ADA

  it("reserves the deposit: inputs = outputs + fee + deposit", () => {
    const built = buildDRepRegistration({
      drepKeyHash: Buffer.from(DREP_HASH, "hex"),
      deposit,
      ...ctx,
    });
    expect(built.transaction.getCertificates()[0].type).toBe(tyTypes.CertificateType.DREP_REG);

    const consumed = inputAda(built.transaction.getInputs());
    const produced = outputAda(built.transaction).plus(built.fee).plus(deposit);
    expect(consumed.toString()).toBe(produced.toString());
  });

  it("throws when inputs cannot cover deposit + fee", () => {
    expect(() =>
      buildDRepRegistration({
        drepKeyHash: Buffer.from(DREP_HASH, "hex"),
        deposit,
        ...ctx,
        inputs: [oneBigInput("100000000")], // 100 ADA < 500 deposit
      }),
    ).toThrow();
  });

  it("sets a fee that is NOT short of the true minimum (regression: setFee(0) underfunded by 176 → FeeTooSmall)", () => {
    const built = buildDRepRegistration({
      drepKeyHash: Buffer.from(DREP_HASH, "hex"),
      deposit,
      ...ctx,
    });
    // The built tx already carries the real fee; calculateFee() now measures the
    // true minimum for the serialized size. The set fee MUST cover it — with the
    // old setFee(0) placeholder-defeating bug this was exactly 176 lovelace short.
    const trueMin = built.transaction.calculateFee();
    expect(BigInt(built.fee) >= BigInt(trueMin.toString())).toBe(true);
  });
});

describe("buildDRepDeRegistration (manual-balance path)", () => {
  const deposit = new BigNumber(500000000);

  it("credits the refund: inputs + deposit = outputs + fee", () => {
    const built = buildDRepDeRegistration({
      drepKeyHash: Buffer.from(DREP_HASH, "hex"),
      deposit,
      ...ctx,
    });
    expect(built.transaction.getCertificates()[0].type).toBe(tyTypes.CertificateType.DREP_DE_REG);

    const consumed = inputAda(built.transaction.getInputs()).plus(deposit);
    const produced = outputAda(built.transaction).plus(built.fee);
    expect(consumed.toString()).toBe(produced.toString());
  });
});

// ── rewardAddressFrom ─────────────────────────────────────────────────────────

describe("rewardAddressFrom", () => {
  it("round-trips a reward address via its hex form", () => {
    const back = rewardAddressFrom(rewardAddr.getHex());
    expect(back.getBech32()).toBe(rewardAddr.getBech32());
    expect(back.stakeCredential.hash.toString("hex")).toBe(STAKE_HASH);
  });

  it("accepts the bech32 form", () => {
    const back = rewardAddressFrom(rewardAddr.getBech32());
    expect(back.getBech32()).toBe(rewardAddr.getBech32());
  });
});
