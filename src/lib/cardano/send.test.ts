import { describe, it, expect } from "vitest";
import BigNumber from "bignumber.js";
import { utils as tyUtils, types as tyTypes } from "@stricahq/typhonjs";
import { baseAddress } from "./address";
import {
  buildSendOutputs,
  buildMultiSend,
  normalizeSendOutputs,
  parseAdaToLovelace,
  parseTokenAmount,
  type RecipientRow,
} from "./send";

type ShelleyAddress = tyTypes.ShelleyAddress;

// Fixed dummy key hashes (28 bytes) — same pattern as __tests__/address.test.ts.
const PKH_A = "00".repeat(28);
const SKH_A = "11".repeat(28);
const PKH_B = "22".repeat(28);
const SKH_B = "33".repeat(28);

const RECIPIENT_1 = baseAddress(PKH_A, SKH_A, 0); // preprod
const RECIPIENT_2 = baseAddress(PKH_B, SKH_B, 0); // preprod
const MAINNET_ADDR = baseAddress(PKH_A, SKH_A, 1); // mainnet
const CHANGE_ADDR = baseAddress(PKH_B, SKH_B, 0) as unknown as string; // reuse as owner "self" addr for inputs

const POLICY = "a".repeat(56);
const ASSET_NAME_HEX = Buffer.from("PhoenixToken", "utf8").toString("hex");

const PROTOCOL_PARAMS: tyTypes.ProtocolParams = {
  minFeeA: new BigNumber(44),
  minFeeB: new BigNumber(155381),
  stakeKeyDeposit: new BigNumber(2000000),
  utxoCostPerByte: new BigNumber(4310),
  collateralPercent: new BigNumber(150),
  priceSteps: new BigNumber(0),
  priceMem: new BigNumber(0),
  maxTxSize: 16384,
  maxValueSize: 5000,
  minFeeRefScriptCostPerByte: new BigNumber(15),
};

function makeInputs(): tyTypes.Input[] {
  const ownerAddress = tyUtils.getAddressFromString(CHANGE_ADDR) as ShelleyAddress;
  return [
    {
      txId: "1".repeat(64),
      index: 0,
      amount: new BigNumber("8000000"),
      tokens: [],
      address: ownerAddress,
    },
    {
      txId: "2".repeat(64),
      index: 1,
      amount: new BigNumber("2000000"),
      tokens: [{ policyId: POLICY, assetName: ASSET_NAME_HEX, amount: new BigNumber(50) }],
      address: ownerAddress,
    },
  ];
}

describe("parseAdaToLovelace", () => {
  it("parses whole and fractional ADA into lovelace", () => {
    expect(parseAdaToLovelace("1.5")).toBe(BigInt("1500000"));
    expect(parseAdaToLovelace("2")).toBe(BigInt("2000000"));
    expect(parseAdaToLovelace("0.000001")).toBe(BigInt("1"));
  });
  it("treats an empty string as zero (token-only row)", () => {
    expect(parseAdaToLovelace("")).toBe(BigInt("0"));
    expect(parseAdaToLovelace("   ")).toBe(BigInt("0"));
  });
  it("rejects malformed amounts", () => {
    expect(() => parseAdaToLovelace("abc")).toThrow();
    expect(() => parseAdaToLovelace("-1")).toThrow();
    expect(() => parseAdaToLovelace("1.1234567")).toThrow();
    expect(() => parseAdaToLovelace("1.2.3")).toThrow();
  });
});

describe("parseTokenAmount", () => {
  it("parses a positive integer quantity", () => {
    expect(parseTokenAmount("10")).toBe(BigInt("10"));
    expect(parseTokenAmount(" 42 ")).toBe(BigInt("42"));
  });
  it("rejects zero, negative, decimal, or non-numeric amounts", () => {
    expect(() => parseTokenAmount("0")).toThrow();
    expect(() => parseTokenAmount("-5")).toThrow();
    expect(() => parseTokenAmount("1.5")).toThrow();
    expect(() => parseTokenAmount("abc")).toThrow();
    expect(() => parseTokenAmount("")).toThrow();
  });
});

describe("buildSendOutputs", () => {
  it("parses valid rows into SendOutput[] with correct lovelace/tokens", () => {
    const rows: RecipientRow[] = [
      { address: RECIPIENT_1, ada: "2", tokens: [] },
      {
        address: RECIPIENT_2,
        ada: "1",
        tokens: [{ policyId: POLICY, assetNameHex: ASSET_NAME_HEX, amount: "10" }],
      },
    ];
    const outputs = buildSendOutputs(rows, 0);
    expect(outputs).toHaveLength(2);
    expect(outputs[0].lovelace).toBe(BigInt("2000000"));
    expect(outputs[0].tokens).toHaveLength(0);
    expect(outputs[1].lovelace).toBe(BigInt("1000000"));
    expect(outputs[1].tokens).toEqual([{ policyId: POLICY, assetNameHex: ASSET_NAME_HEX, amount: BigInt("10") }]);
  });

  it("rejects a recipient whose address is for the wrong network", () => {
    const rows: RecipientRow[] = [{ address: MAINNET_ADDR, ada: "1", tokens: [] }];
    expect(() => buildSendOutputs(rows, 0)).toThrow("addr_wrong_network");
  });

  it("rejects an empty recipient list", () => {
    expect(() => buildSendOutputs([], 0)).toThrow("no_recipients");
  });

  it("rejects a row with no address", () => {
    expect(() => buildSendOutputs([{ address: "  ", ada: "1", tokens: [] }], 0)).toThrow("send_to_required");
  });

  it("rejects an unparsable address", () => {
    expect(() => buildSendOutputs([{ address: "not-a-bech32-addr", ada: "1", tokens: [] }], 0)).toThrow(
      "invalid_address",
    );
  });

  it("rejects a row with neither ADA nor tokens", () => {
    expect(() => buildSendOutputs([{ address: RECIPIENT_1, ada: "", tokens: [] }], 0)).toThrow("invalid_amount");
  });

  it("rejects a malformed policy id", () => {
    const rows: RecipientRow[] = [
      { address: RECIPIENT_1, ada: "1", tokens: [{ policyId: "not-hex", assetNameHex: "", amount: "1" }] },
    ];
    expect(() => buildSendOutputs(rows, 0)).toThrow("invalid_asset");
  });
});

describe("buildMultiSend", () => {
  it("produces one output per recipient (plus change) with correct lovelace/tokens, and a computed fee", () => {
    const rows: RecipientRow[] = [
      { address: RECIPIENT_1, ada: "2", tokens: [] },
      {
        // 2 ADA is above the min-UTxO for a single-token output, so it passes
        // through unchanged (the min-UTxO bump for dust is covered separately).
        address: RECIPIENT_2,
        ada: "2",
        tokens: [{ policyId: POLICY, assetNameHex: ASSET_NAME_HEX, amount: "10" }],
      },
    ];
    const outputs = buildSendOutputs(rows, 0);
    const changeAddress = tyUtils.getAddressFromString(CHANGE_ADDR) as ShelleyAddress;

    const built = buildMultiSend({
      outputs,
      inputs: makeInputs(),
      changeAddress,
      protocolParams: PROTOCOL_PARAMS,
      ttl: 100000000,
    });

    expect(built.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(BigInt(built.fee)).toBeGreaterThan(BigInt("0"));

    const txOutputs = built.transaction.getOutputs();
    // 2 requested recipients + 1 change output (inputs carry more ADA/tokens
    // than requested, so a non-zero change output is guaranteed).
    expect(txOutputs.length).toBe(3);

    const out1 = txOutputs.find((o) => o.address.getBech32() === RECIPIENT_1);
    expect(out1).toBeDefined();
    expect(out1?.amount.toString()).toBe("2000000");
    expect(out1?.tokens).toHaveLength(0);

    const out2 = txOutputs.find((o) => o.address.getBech32() === RECIPIENT_2);
    expect(out2).toBeDefined();
    expect(out2?.amount.toString()).toBe("2000000");
    expect(out2?.tokens).toHaveLength(1);
    expect(out2?.tokens[0].policyId).toBe(POLICY);
    expect(out2?.tokens[0].assetName).toBe(ASSET_NAME_HEX);
    expect(out2?.tokens[0].amount.toString()).toBe("10");
  });

  it("auto-attaches the minimum UTxO ADA to a token-only (0-lovelace) output", () => {
    const outputs = [
      {
        address: tyUtils.getAddressFromString(RECIPIENT_1) as ShelleyAddress,
        lovelace: BigInt("0"),
        tokens: [{ policyId: POLICY, assetNameHex: ASSET_NAME_HEX, amount: BigInt("5") }],
      },
    ];
    const changeAddress = tyUtils.getAddressFromString(CHANGE_ADDR) as ShelleyAddress;
    const built = buildMultiSend({
      outputs,
      inputs: makeInputs(),
      changeAddress,
      protocolParams: PROTOCOL_PARAMS,
      ttl: 100000000,
    });
    const out1 = built.transaction.getOutputs().find((o) => o.address.getBech32() === RECIPIENT_1);
    expect(out1).toBeDefined();
    expect(out1?.amount.gt(0)).toBe(true);
  });

  it("bumps a token-bearing output with dust ADA up to the min-UTxO (not only the 0-ADA case)", () => {
    const recip = tyUtils.getAddressFromString(RECIPIENT_2) as ShelleyAddress;
    const dust = BigInt("300000"); // 0.3 ADA — below the min-UTxO for a token output
    const raw = [
      { address: recip, lovelace: dust, tokens: [{ policyId: POLICY, assetNameHex: ASSET_NAME_HEX, amount: BigInt("7") }] },
    ];
    const normalized = normalizeSendOutputs(raw, PROTOCOL_PARAMS);
    // Dust is raised to the protocol minimum, so it never submits OutputTooSmall.
    expect(normalized[0].lovelace > dust).toBe(true);

    // The built tx carries exactly the normalized amount — review == what is sent.
    const built = buildMultiSend({
      outputs: raw,
      inputs: makeInputs(),
      changeAddress: tyUtils.getAddressFromString(CHANGE_ADDR) as ShelleyAddress,
      protocolParams: PROTOCOL_PARAMS,
      ttl: 100000000,
    });
    const out = built.transaction.getOutputs().find((o) => o.address.getBech32() === RECIPIENT_2);
    expect(out?.amount.toString()).toBe(normalized[0].lovelace.toString());
  });

  it("leaves a token output already above the min-UTxO unchanged", () => {
    const recip = tyUtils.getAddressFromString(RECIPIENT_2) as ShelleyAddress;
    const big = BigInt("5000000"); // 5 ADA — comfortably above min
    const normalized = normalizeSendOutputs(
      [{ address: recip, lovelace: big, tokens: [{ policyId: POLICY, assetNameHex: ASSET_NAME_HEX, amount: BigInt("1") }] }],
      PROTOCOL_PARAMS,
    );
    expect(normalized[0].lovelace).toBe(big);
  });

  it("throws on an empty outputs array", () => {
    const changeAddress = tyUtils.getAddressFromString(CHANGE_ADDR) as ShelleyAddress;
    expect(() =>
      buildMultiSend({
        outputs: [],
        inputs: makeInputs(),
        changeAddress,
        protocolParams: PROTOCOL_PARAMS,
        ttl: 100000000,
      }),
    ).toThrow("no_recipients");
  });
});
