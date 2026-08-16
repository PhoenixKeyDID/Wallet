/**
 * End-to-end journeys through the whole CIP-30 wallet stack.
 *
 * What makes these E2E rather than unit tests: NOTHING of ours is mocked. The
 * only stand-in is the browser extension itself — a fake `window.cardano` entry
 * that speaks real CIP-30 over real CBOR. Everything between the page and that
 * boundary is the shipping code: `listWallets` → `enableWallet` → `getUtxos` →
 * `decodeUtxosToInputs` → the builders → `signAndSubmitCip30`.
 *
 * The unit tests each prove one function in isolation. What they cannot prove is
 * that the pieces still fit: that the CBOR one module emits is the CBOR the next
 * one can read, that a witness set from the extension merges back into the very
 * transaction we built, and that the network guard actually sits on every
 * signing path rather than on the one path its own test calls. That seam is
 * where a wallet loses money, so it gets its own file.
 *
 * The journeys mirror the ones a person actually performs: connect, look at the
 * balance, send, delegate to a pool, delegate a vote to a dRep, and submit a
 * governance action.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Buffer } from "buffer";
import BigNumber from "bignumber.js";
import { Encoder } from "@stricahq/cbors";
import { bech32 } from "bech32";
import { utils as tyUtils, types as tyTypes } from "@stricahq/typhonjs";

import { baseAddress, rewardAddress, cip30NetworkId, type PhoenixNetwork } from "../address";
import {
  listWallets,
  enableWallet,
  readBalance,
  assetQuantity,
  NetworkMismatchError,
  WalletConnectError,
  type Cip30Api,
} from "../cip30";
import { decodeUtxosToInputs, signAndSubmitCip30, SubmitUncertainError } from "../tx";
import { buildSendOutputs, buildMultiSend, type RecipientRow } from "../send";
import { buildDelegation } from "../staking";
import {
  buildVoteDelegation,
  buildProposal,
  infoAction,
  makeAnchor,
  rewardAddressFrom,
} from "../governance";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const NETWORK: PhoenixNetwork = 0; // preprod
const NETWORK_ID = cip30NetworkId(NETWORK); // 0 for every testnet

const OWNER_PKH = "aa".repeat(28);
const OWNER_SKH = "bb".repeat(28);
const PAYEE_PKH = "cc".repeat(28);
const PAYEE_SKH = "dd".repeat(28);

const OWNER_ADDR = baseAddress(OWNER_PKH, OWNER_SKH, NETWORK);
const PAYEE_ADDR = baseAddress(PAYEE_PKH, PAYEE_SKH, NETWORK);
const OWNER_REWARD_ADDR = rewardAddress(OWNER_SKH, NETWORK);

const POOL_ID = bech32.encode("pool", bech32.toWords(Buffer.alloc(28, 0xab)), 200);
const DREP_ID = bech32.encode("drep", bech32.toWords(Buffer.alloc(28, 0xcd)), 200);

const POLICY_ID = "ee".repeat(28);
const ASSET_NAME_HEX = Buffer.from("PHOENIX", "utf8").toString("hex");

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

const TIP_SLOT = 50_000_000;

/**
 * Governance anchors point at IPFS in practice, and deliberately so here: the
 * repo's outbound-URL guard gates every `https://` that ships under `src/`, and
 * a test fixture has no business pulling a file into CODEOWNERS review.
 */
const ANCHOR_URL = "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";

function addrBytes(bech32Addr: string): Buffer {
  return Buffer.from(
    (tyUtils.getAddressFromString(bech32Addr) as { getHex(): string }).getHex(),
    "hex",
  );
}

function hex(buf: Buffer): string {
  return buf.toString("hex");
}

/**
 * A CIP-30 `TransactionUnspentOutput`: `[[txId, index], output]`.
 *
 * `form` picks between the two output encodings a real wallet may hand back —
 * pre-Babbage wallets still emit the legacy array, current ones emit the map.
 * Both are produced here on purpose: `decodeUtxosToInputs` claims to read both,
 * and a claim about a decoder is worth exactly what its fixtures cover.
 */
function utxoHex(opts: {
  txId: string;
  index: number;
  lovelace: string;
  form: "legacy" | "babbage";
  tokens?: Array<{ policyId: string; assetNameHex: string; quantity: number }>;
  /** Babbage-only: an inline datum (key 2) marks a UTxO we must refuse to spend. */
  inlineDatum?: boolean;
}): string {
  const value: unknown =
    opts.tokens && opts.tokens.length > 0
      ? [
          BigInt(opts.lovelace),
          new Map(
            opts.tokens.map((t) => [
              Buffer.from(t.policyId, "hex"),
              new Map([[Buffer.from(t.assetNameHex, "hex"), BigInt(t.quantity)]]),
            ]),
          ),
        ]
      : BigInt(opts.lovelace);

  const output =
    opts.form === "legacy"
      ? [addrBytes(OWNER_ADDR), value]
      : new Map<number, unknown>([
          [0, addrBytes(OWNER_ADDR)],
          [1, value],
          ...(opts.inlineDatum
            ? ([[2, Buffer.from("d87980", "hex")]] as Array<[number, unknown]>)
            : []),
        ]);

  return hex(Encoder.encode([[Buffer.from(opts.txId, "hex"), opts.index], output]));
}

/** The CBOR a wallet returns from `signTx(partialSign)` — a witness set, key 0. */
function witnessSetHex(n = 1): string {
  const witnesses = Array.from({ length: n }, (_, i) => [
    Buffer.alloc(32, 0x10 + i),
    Buffer.alloc(64, 0x20 + i),
  ]);
  return hex(Encoder.encode(new Map<number, unknown>([[0, witnesses]])));
}

// ─── The fake extension ───────────────────────────────────────────────────────

type SubmitBehaviour = "ok" | "refused" | "silent_failure";

type FakeExtension = {
  /** Mutable so a test can switch networks mid-journey, exactly as a user can. */
  networkId: number;
  utxos: string[];
  balanceCborHex: string;
  submitBehaviour: SubmitBehaviour;
  /** Every CBOR handed to `signTx`, in order. */
  signed: string[];
  /** Every CBOR handed to `submitTx`, in order. */
  submitted: string[];
  install(): void;
};

function makeExtension(opts: { holdEnable?: boolean } = {}): FakeExtension {
  const state: FakeExtension = {
    networkId: NETWORK_ID,
    utxos: [
      utxoHex({ txId: "11".repeat(32), index: 0, lovelace: "10000000", form: "babbage" }),
      utxoHex({
        txId: "22".repeat(32),
        index: 1,
        lovelace: "5000000",
        form: "legacy",
        tokens: [{ policyId: POLICY_ID, assetNameHex: ASSET_NAME_HEX, quantity: 500 }],
      }),
      // A reference-script/inline-datum UTxO the wallet must never casually spend.
      utxoHex({
        txId: "33".repeat(32),
        index: 0,
        lovelace: "3000000",
        form: "babbage",
        inlineDatum: true,
      }),
    ],
    balanceCborHex: hex(
      Encoder.encode([
        BigInt("15000000"),
        new Map([
          [
            Buffer.from(POLICY_ID, "hex"),
            new Map([[Buffer.from(ASSET_NAME_HEX, "hex"), BigInt(500)]]),
          ],
        ]),
      ]),
    ),
    submitBehaviour: "ok",
    signed: [],
    submitted: [],
    install() {},
  };

  const api: Cip30Api = {
    getNetworkId: async () => state.networkId,
    getUtxos: async () => state.utxos,
    getBalance: async () => state.balanceCborHex,
    getUsedAddresses: async () => [hex(addrBytes(OWNER_ADDR))],
    getUnusedAddresses: async () => [],
    getChangeAddress: async () => hex(addrBytes(OWNER_ADDR)),
    getRewardAddresses: async () => [hex(addrBytes(OWNER_REWARD_ADDR))],
    async signTx(tx: string) {
      state.signed.push(tx);
      return witnessSetHex();
    },
    signData: async () => ({ signature: "00", key: "00" }),
    async submitTx(tx: string) {
      state.submitted.push(tx);
      if (state.submitBehaviour === "refused") {
        // A CIP-30 wallet rejects with a bare {code, info}, never an Error.
        throw { code: 1, info: "user declined to send" };
      }
      if (state.submitBehaviour === "silent_failure") {
        throw new Error("network unreachable");
      }
      return "ff".repeat(32);
    },
  };

  state.install = () => {
    const injected = {
      apiVersion: "0.1.0",
      name: "Phoenix Test Wallet",
      icon: "data:image/svg+xml,<svg/>",
      isEnabled: async () => true,
      enable: async () => {
        // Never settles — the connect hang this wallet had to be taught to survive.
        if (opts.holdEnable) await new Promise<never>(() => {});
        return api;
      },
    };
    (globalThis as unknown as { window: unknown }).window = { cardano: { phoenixtest: injected } };
  };

  return state;
}

let ext: FakeExtension;

beforeEach(() => {
  ext = makeExtension();
  ext.install();
});

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
  vi.useRealTimers();
});

/** The connect step every journey starts from, as the UI performs it. */
async function connect(): Promise<{ api: Cip30Api; networkId: number }> {
  const wallets = listWallets();
  expect(wallets.map((w) => w.key)).toContain("phoenixtest");
  const api = await enableWallet("phoenixtest");
  // The UI captures the network ONCE, at connect. Every later signature is
  // checked against this captured value — that is the whole point of the guard.
  const networkId = await api.getNetworkId();
  return { api, networkId };
}

async function spendableInputs(api: Cip30Api): Promise<tyTypes.Input[]> {
  const utxos = (await api.getUtxos()) ?? [];
  return decodeUtxosToInputs(utxos);
}

async function changeAddress(api: Cip30Api): Promise<tyTypes.ShelleyAddress> {
  const hexAddr = await api.getChangeAddress();
  return tyUtils.getAddressFromHex(Buffer.from(hexAddr, "hex")) as tyTypes.ShelleyAddress;
}

// ─── Journey 1: connect and read the balance ──────────────────────────────────

describe("E2E — connect and read", () => {
  it("finds the injected wallet, enables it, and reads ADA + native tokens", async () => {
    const { api, networkId } = await connect();
    expect(networkId).toBe(NETWORK_ID);

    const balance = await readBalance(api);
    expect(balance.lovelace).toBe(BigInt("15000000"));
    expect(assetQuantity(balance, POLICY_ID, ASSET_NAME_HEX)).toBe(BigInt("500"));
  });

  it("keeps the user's real wallet reachable when another extension injects a hostile entry", async () => {
    const root = (globalThis as unknown as { window: { cardano: Record<string, unknown> } }).window
      .cardano;
    // A second extension registers an object whose every property read throws.
    Object.defineProperty(root, "hostile", {
      enumerable: true,
      get() {
        throw new Error("gotcha");
      },
    });

    // The real wallet must still be listed and still connect. This is the whole
    // failure the user reported as "the connect dialog says no wallet installed".
    expect(listWallets().map((w) => w.key)).toContain("phoenixtest");
    await expect(enableWallet("phoenixtest")).resolves.toBeDefined();
  });

  it("gives up rather than spinning forever when the extension never answers", async () => {
    delete (globalThis as unknown as { window?: unknown }).window;
    makeExtension({ holdEnable: true }).install();

    vi.useFakeTimers();
    const onSlow = vi.fn();
    const attempt = enableWallet("phoenixtest", { timeoutMs: 90_000, slowAfterMs: 8_000, onSlow });
    const assertion = expect(attempt).rejects.toMatchObject({ reason: "timeout" });

    await vi.advanceTimersByTimeAsync(8_000);
    expect(onSlow).toHaveBeenCalledTimes(1); // told, not cancelled

    await vi.advanceTimersByTimeAsync(82_000);
    await assertion;
  });

  it("hands control back the moment the user presses Cancel", async () => {
    delete (globalThis as unknown as { window?: unknown }).window;
    makeExtension({ holdEnable: true }).install();

    const abort = new AbortController();
    const attempt = enableWallet("phoenixtest", { signal: abort.signal });
    abort.abort();
    await expect(attempt).rejects.toMatchObject({ reason: "cancelled" });
  });

  it("refuses an extension whose enable() returns an object missing signTx", async () => {
    (
      globalThis as unknown as { window: { cardano: Record<string, unknown> } }
    ).window.cardano.crippled = {
      apiVersion: "0.1.0",
      name: "Crippled",
      icon: "",
      isEnabled: async () => true,
      enable: async () => ({ getNetworkId: async () => 0 }),
    };
    await expect(enableWallet("crippled")).rejects.toBeInstanceOf(WalletConnectError);
    await expect(enableWallet("crippled")).rejects.toMatchObject({ reason: "bad_api" });
  });
});

// ─── Journey 2: send ──────────────────────────────────────────────────────────

describe("E2E — send", () => {
  it("builds from the wallet's own UTxOs, signs through the extension, and submits", async () => {
    const { api, networkId } = await connect();
    const inputs = await spendableInputs(api);

    // The inline-datum UTxO is dropped; the two ordinary ones survive, one from
    // each output encoding.
    expect(inputs).toHaveLength(2);
    expect(inputs.map((i) => i.txId)).toEqual(["11".repeat(32), "22".repeat(32)]);

    const rows: RecipientRow[] = [{ address: PAYEE_ADDR, ada: "3", tokens: [] }];
    const outputs = buildSendOutputs(rows, NETWORK);
    const built = buildMultiSend({
      outputs,
      inputs,
      changeAddress: await changeAddress(api),
      protocolParams: PROTOCOL_PARAMS,
      ttl: TIP_SLOT + 7200,
    });

    expect(BigInt(built.fee)).toBeGreaterThan(BigInt(0));

    const txHash = await signAndSubmitCip30(api, built, networkId);
    expect(txHash).toBe("ff".repeat(32));

    // The extension was handed the exact unsigned CBOR we built…
    expect(ext.signed).toEqual([built.unsignedCbor]);
    // …and the submitted body is the signed one, not the unsigned one: the
    // witness merge has to have actually changed the bytes.
    expect(ext.submitted).toHaveLength(1);
    expect(ext.submitted[0]).not.toBe(built.unsignedCbor);
    expect(ext.submitted[0]!.length).toBeGreaterThan(built.unsignedCbor.length);
  });

  it("carries native tokens to the recipient in the same transaction", async () => {
    const { api, networkId } = await connect();
    const inputs = await spendableInputs(api);

    const rows: RecipientRow[] = [
      {
        address: PAYEE_ADDR,
        ada: "", // token-only row: min-UTxO must be filled in for the user
        tokens: [{ policyId: POLICY_ID, assetNameHex: ASSET_NAME_HEX, amount: "100" }],
      },
    ];
    const built = buildMultiSend({
      outputs: buildSendOutputs(rows, NETWORK),
      inputs,
      changeAddress: await changeAddress(api),
      protocolParams: PROTOCOL_PARAMS,
      ttl: TIP_SLOT + 7200,
    });

    await expect(signAndSubmitCip30(api, built, networkId)).resolves.toBe("ff".repeat(32));
  });

  it("refuses a recipient on the wrong network before anything is built", async () => {
    await connect();
    const mainnetAddr = baseAddress(PAYEE_PKH, PAYEE_SKH, 1);
    expect(() =>
      buildSendOutputs([{ address: mainnetAddr, ada: "3", tokens: [] }], NETWORK),
    ).toThrow("addr_wrong_network");
  });

  it("stops the signature when the user switches the extension to mainnet mid-flow", async () => {
    const { api, networkId } = await connect();
    const built = buildMultiSend({
      outputs: buildSendOutputs([{ address: PAYEE_ADDR, ada: "3", tokens: [] }], NETWORK),
      inputs: await spendableInputs(api),
      changeAddress: await changeAddress(api),
      protocolParams: PROTOCOL_PARAMS,
      ttl: TIP_SLOT + 7200,
    });

    // The user reviewed a preprod transaction. Between the review and the tap on
    // Confirm, they flipped the extension to mainnet. Nothing in CIP-30 tells us
    // — we have to look again.
    ext.networkId = 1;

    await expect(signAndSubmitCip30(api, built, networkId)).rejects.toBeInstanceOf(
      NetworkMismatchError,
    );
    expect(ext.signed).toHaveLength(0); // never reached the wallet
    expect(ext.submitted).toHaveLength(0);
  });

  it("says plainly that nothing was sent when the wallet declines the submit", async () => {
    const { api, networkId } = await connect();
    ext.submitBehaviour = "refused";
    const built = buildMultiSend({
      outputs: buildSendOutputs([{ address: PAYEE_ADDR, ada: "3", tokens: [] }], NETWORK),
      inputs: await spendableInputs(api),
      changeAddress: await changeAddress(api),
      protocolParams: PROTOCOL_PARAMS,
      ttl: TIP_SLOT + 7200,
    });

    // TxSendError.Refused — the transaction provably never left, so it stays a
    // plain refusal and must NOT be dressed up as uncertainty.
    const err = await signAndSubmitCip30(api, built, networkId).catch((e) => e);
    expect(err).toMatchObject({ code: 1 });
    expect(err).not.toBeInstanceOf(SubmitUncertainError);
  });

  it("hands back the tx hash when the submit's outcome is unknown", async () => {
    const { api, networkId } = await connect();
    ext.submitBehaviour = "silent_failure";
    const built = buildMultiSend({
      outputs: buildSendOutputs([{ address: PAYEE_ADDR, ada: "3", tokens: [] }], NETWORK),
      inputs: await spendableInputs(api),
      changeAddress: await changeAddress(api),
      protocolParams: PROTOCOL_PARAMS,
      ttl: TIP_SLOT + 7200,
    });

    // The signed transaction may or may not be on the network. The hash is the
    // only way the user can find out before resending and paying twice.
    const err = await signAndSubmitCip30(api, built, networkId).catch((e) => e);
    expect(err).toBeInstanceOf(SubmitUncertainError);
    expect((err as SubmitUncertainError).txHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ─── Journey 3: staking ───────────────────────────────────────────────────────

describe("E2E — staking", () => {
  it("registers the stake key and delegates to a pool in one transaction", async () => {
    const { api, networkId } = await connect();
    const rewardHex = (await api.getRewardAddresses())[0]!;

    const built = buildDelegation({
      rewardAddress: rewardHex,
      poolId: POOL_ID,
      needsRegistration: true, // first-ever delegation
      inputs: await spendableInputs(api),
      changeAddress: await changeAddress(api),
      protocolParams: PROTOCOL_PARAMS,
      tip: TIP_SLOT,
    });

    await expect(signAndSubmitCip30(api, built, networkId)).resolves.toBe("ff".repeat(32));
    expect(ext.signed).toEqual([built.unsignedCbor]);
  });

  it("delegates without a registration certificate once the stake key exists", async () => {
    const { api, networkId } = await connect();
    const rewardHex = (await api.getRewardAddresses())[0]!;
    const common = {
      rewardAddress: rewardHex,
      poolId: POOL_ID,
      inputs: await spendableInputs(api),
      changeAddress: await changeAddress(api),
      protocolParams: PROTOCOL_PARAMS,
      tip: TIP_SLOT,
    };

    const withReg = buildDelegation({ ...common, needsRegistration: true });
    const withoutReg = buildDelegation({ ...common, needsRegistration: false });

    // The 2 ADA deposit is the difference between the two, and it must be
    // visible in the bytes — not just in a flag we passed in.
    expect(withoutReg.unsignedCbor).not.toBe(withReg.unsignedCbor);
    expect(withoutReg.unsignedCbor.length).toBeLessThan(withReg.unsignedCbor.length);

    await expect(signAndSubmitCip30(api, withoutReg, networkId)).resolves.toBe("ff".repeat(32));
  });

  it("stops a delegation signed against a switched network", async () => {
    const { api, networkId } = await connect();
    const built = buildDelegation({
      rewardAddress: (await api.getRewardAddresses())[0]!,
      poolId: POOL_ID,
      needsRegistration: false,
      inputs: await spendableInputs(api),
      changeAddress: await changeAddress(api),
      protocolParams: PROTOCOL_PARAMS,
      tip: TIP_SLOT,
    });
    ext.networkId = 1;
    await expect(signAndSubmitCip30(api, built, networkId)).rejects.toBeInstanceOf(
      NetworkMismatchError,
    );
  });
});

// ─── Journey 4: delegate the vote to a dRep ───────────────────────────────────

describe("E2E — dRep vote delegation", () => {
  it("delegates the wallet's voting power to a dRep", async () => {
    const { api, networkId } = await connect();
    const built = buildVoteDelegation({
      rewardAddress: rewardAddressFrom((await api.getRewardAddresses())[0]!),
      target: { kind: "drep", drepId: DREP_ID },
      inputs: await spendableInputs(api),
      changeAddress: await changeAddress(api),
      protocolParams: PROTOCOL_PARAMS,
      ttl: TIP_SLOT + 7200,
    });

    await expect(signAndSubmitCip30(api, built, networkId)).resolves.toBe("ff".repeat(32));
    expect(ext.signed).toEqual([built.unsignedCbor]);
  });

  it("distinguishes Abstain and No-Confidence from a real dRep on the wire", async () => {
    const { api } = await connect();
    const common = {
      rewardAddress: rewardAddressFrom((await api.getRewardAddresses())[0]!),
      inputs: await spendableInputs(api),
      changeAddress: await changeAddress(api),
      protocolParams: PROTOCOL_PARAMS,
      ttl: TIP_SLOT + 7200,
    };

    const toDrep = buildVoteDelegation({ ...common, target: { kind: "drep", drepId: DREP_ID } });
    const abstain = buildVoteDelegation({ ...common, target: { kind: "abstain" } });
    const noConf = buildVoteDelegation({ ...common, target: { kind: "noConfidence" } });

    // Three different choices must be three different transactions. If any two
    // matched, one of the pseudo-dReps would silently be the other.
    expect(new Set([toDrep.unsignedCbor, abstain.unsignedCbor, noConf.unsignedCbor]).size).toBe(3);
  });

  it("stops a vote delegation signed against a switched network", async () => {
    const { api, networkId } = await connect();
    const built = buildVoteDelegation({
      rewardAddress: rewardAddressFrom((await api.getRewardAddresses())[0]!),
      target: { kind: "abstain" },
      inputs: await spendableInputs(api),
      changeAddress: await changeAddress(api),
      protocolParams: PROTOCOL_PARAMS,
      ttl: TIP_SLOT + 7200,
    });
    ext.networkId = 1;
    await expect(signAndSubmitCip30(api, built, networkId)).rejects.toBeInstanceOf(
      NetworkMismatchError,
    );
  });
});

// ─── Journey 5: push a governance action ──────────────────────────────────────

describe("E2E — governance action", () => {
  /**
   * A proposal locks a deposit far larger than an ordinary send, so this journey
   * needs a wallet that can actually cover it. Everything else is the shipping
   * path unchanged.
   */
  function fundedInputs(): tyTypes.Input[] {
    return decodeUtxosToInputs([
      utxoHex({ txId: "44".repeat(32), index: 0, lovelace: "200000000000", form: "babbage" }),
    ]);
  }

  it("submits an Info action with its deposit and anchor", async () => {
    const { api, networkId } = await connect();
    const built = buildProposal({
      deposit: new BigNumber("100000000000"), // 100k ADA — the preprod govActionDeposit
      rewardAccount: rewardAddressFrom((await api.getRewardAddresses())[0]!),
      govAction: infoAction(),
      anchor: makeAnchor(ANCHOR_URL, "ab".repeat(32)),
      inputs: fundedInputs(),
      changeAddress: await changeAddress(api),
      protocolParams: PROTOCOL_PARAMS,
      ttl: TIP_SLOT + 7200,
    });

    await expect(signAndSubmitCip30(api, built, networkId)).resolves.toBe("ff".repeat(32));
    expect(ext.signed).toEqual([built.unsignedCbor]);
  });

  it("stops a proposal signed against a switched network", async () => {
    const { api, networkId } = await connect();
    const built = buildProposal({
      deposit: new BigNumber("100000000000"),
      rewardAccount: rewardAddressFrom((await api.getRewardAddresses())[0]!),
      govAction: infoAction(),
      anchor: makeAnchor(ANCHOR_URL, "ab".repeat(32)),
      inputs: fundedInputs(),
      changeAddress: await changeAddress(api),
      protocolParams: PROTOCOL_PARAMS,
      ttl: TIP_SLOT + 7200,
    });
    ext.networkId = 1;
    await expect(signAndSubmitCip30(api, built, networkId)).rejects.toBeInstanceOf(
      NetworkMismatchError,
    );
  });
});
