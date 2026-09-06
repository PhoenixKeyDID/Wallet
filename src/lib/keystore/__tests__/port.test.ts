/**
 * The local-key half of `WalletPort`.
 *
 * Two invariants here are the ones that cost money if they slip:
 *
 *   1. **Change never lands on an external address.** BIP-44 puts change on the
 *      internal chain so that spending does not publish an address the owner is
 *      still handing out to payers. Nothing about a wrong choice throws — the
 *      transaction succeeds, the funds arrive, and the privacy loss is silent
 *      and permanent, which is exactly why it needs a test rather than a review.
 *   2. **Preprod and preview stay distinguishable.** CIP-30 calls every testnet
 *      `0`, so the port deals in `PhoenixNetwork` (preprod 0, mainnet 1, preview
 *      2) and the local signer compares against the network the account was
 *      derived for. A port that narrowed to the CIP-30 id before handing down
 *      would let a preview account sign a preprod transaction.
 *
 * The provider is mocked throughout: these are questions about which address
 * gets chosen, not about whether Koios is up.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Buffer } from "buffer";
import BigNumber from "bignumber.js";
import { utils as tyUtils, types as tyTypes } from "@stricahq/typhonjs";

vi.mock("../../cardano/provider", () => ({
  fetchUtxos: vi.fn(),
  submitTx: vi.fn(),
}));

import { fetchUtxos, submitTx } from "../../cardano/provider";
import { accountFromEntropy, allAddresses, type Account } from "../derive";
import {
  localPort,
  changeAddressFor,
  changeAddressHexFor,
  externalAddressesHex,
} from "../port";
import { buildMultiSend, buildSendOutputs } from "../../cardano/send";
import { baseAddress, type PhoenixNetwork } from "../../cardano/address";
import { SubmitUncertainError } from "../../cardano/tx";
import { cip30Port } from "../../cardano/walletPort";
import type { Cip30Api } from "../../cardano/cip30";
import { toHex } from "../../cardano/hash";

const mockFetchUtxos = vi.mocked(fetchUtxos);
const mockSubmitTx = vi.mocked(submitTx);

/** A fixed entropy so every run derives the same wallet. */
const ENTROPY = Uint8Array.from(Buffer.alloc(32, 7));

const shelley = (bech32: string) => tyUtils.getAddressFromString(bech32) as tyTypes.ShelleyAddress;
const bech32Of = (hex: string) => tyUtils.getAddressFromHex(Buffer.from(hex, "hex")).getBech32();

/** An input sitting on `address`, enough for the "is it occupied" question. */
function utxoAt(address: string, lovelace = "10000000"): tyTypes.Input {
  return {
    txId: "11".repeat(32),
    index: 0,
    amount: new BigNumber(lovelace),
    tokens: [],
    address: shelley(address),
  } as unknown as tyTypes.Input;
}

let preprod: Account;
let preview: Account;

beforeEach(async () => {
  vi.resetAllMocks();
  preprod ??= await accountFromEntropy(ENTROPY, 0, 0);
  preview ??= await accountFromEntropy(ENTROPY, 0, 2);
});

describe("changeAddressFor", () => {
  it("picks the first internal address holding nothing", () => {
    // Index 0 is occupied, so change must move on to index 1 rather than
    // piling a second output onto an address already visible on chain.
    const chosen = changeAddressFor(preprod, [utxoAt(preprod.internal[0]!.address)]);
    expect(chosen).toBe(preprod.internal[1]!.address);
  });

  it("skips every occupied internal address, not just the first", () => {
    const occupied = preprod.internal.slice(0, 3).map((a) => utxoAt(a.address));
    expect(changeAddressFor(preprod, occupied)).toBe(preprod.internal[3]!.address);
  });

  it("uses index 0 when the wallet holds nothing at all", () => {
    expect(changeAddressFor(preprod, [])).toBe(preprod.internal[0]!.address);
  });

  it("falls back to index 0 rather than failing when every internal address is in use", () => {
    const all = preprod.internal.map((a) => utxoAt(a.address));
    // Reuse is a privacy cost. Refusing to build the transaction would be a
    // wallet that stops working once it is busy enough, which is worse.
    expect(changeAddressFor(preprod, all)).toBe(preprod.internal[0]!.address);
  });

  it("never returns an external address", () => {
    const external = new Set(preprod.external.map((a) => a.address));
    const cases: tyTypes.Input[][] = [
      [],
      preprod.internal.map((a) => utxoAt(a.address)),
      preprod.internal.slice(0, 5).map((a) => utxoAt(a.address)),
      allAddresses(preprod).map((a) => utxoAt(a)),
    ];
    for (const inputs of cases) expect(external.has(changeAddressFor(preprod, inputs))).toBe(false);
  });

  it("ignores UTxOs sitting on external addresses when choosing", () => {
    // Money arriving at a receive address must not push change further down the
    // internal chain — the two chains are independent.
    const onExternal = preprod.external.slice(0, 5).map((a) => utxoAt(a.address));
    expect(changeAddressFor(preprod, onExternal)).toBe(preprod.internal[0]!.address);
  });
});

describe("changeAddressHexFor", () => {
  it("returns hex that decodes back to the chosen internal address", async () => {
    mockFetchUtxos.mockResolvedValue([utxoAt(preprod.internal[0]!.address)]);
    const hex = await changeAddressHexFor(preprod);
    expect(bech32Of(hex)).toBe(preprod.internal[1]!.address);
  });

  it("still answers when the indexer is unreachable", async () => {
    // A dead provider must not stop the wallet opening: it means the tabs
    // mount with index 0 as change, which is correct, only less private.
    mockFetchUtxos.mockRejectedValue(new Error("koios down"));
    const hex = await changeAddressHexFor(preprod);
    expect(bech32Of(hex)).toBe(preprod.internal[0]!.address);
  });
});

describe("localPort — reads", () => {
  it("asks the indexer about every address the account owns", async () => {
    mockFetchUtxos.mockResolvedValue([]);
    await localPort(preprod).getInputs();
    expect(mockFetchUtxos).toHaveBeenCalledWith(0, allAddresses(preprod));
  });

  it("hands out an external address, never an internal one", async () => {
    mockFetchUtxos.mockResolvedValue([]);
    const hex = await localPort(preprod).getReceiveAddressHex();
    const internal = new Set(preprod.internal.map((a) => a.address));
    expect(internal.has(bech32Of(hex!))).toBe(false);
    expect(bech32Of(hex!)).toBe(preprod.external[0]!.address);
  });

  it("moves past an external address that already holds money", async () => {
    mockFetchUtxos.mockResolvedValue([utxoAt(preprod.external[0]!.address)]);
    const hex = await localPort(preprod).getReceiveAddressHex();
    expect(bech32Of(hex!)).toBe(preprod.external[1]!.address);
  });

  it("shows an address that works rather than none when the indexer is down", async () => {
    mockFetchUtxos.mockRejectedValue(new Error("koios down"));
    const hex = await localPort(preprod).getReceiveAddressHex();
    expect(bech32Of(hex!)).toBe(preprod.external[0]!.address);
  });

  it("owns every address it derived, external and internal", async () => {
    const owned = await localPort(preprod).getOwnedAddressesHex();
    expect(owned.map(bech32Of).sort()).toEqual(allAddresses(preprod).sort());
    // A non-empty set is what makes the receive screen's ownership check
    // decidable — an empty one would render every verdict as "unknown".
    expect(owned.length).toBeGreaterThan(0);
  });

  /**
   * What a site gets to see is not what the wallet knows. The change chain is
   * what ties a wallet's transactions to each other, so handing it to a dApp
   * that asked "where do I pay you" publishes the whole graph for the price of
   * one grant.
   */
  it("hands a dApp the receiving chain and never the change chain", () => {
    const shown = externalAddressesHex(preprod).map(bech32Of);
    expect(shown.sort()).toEqual(preprod.external.map((a) => a.address).sort());
    for (const internal of preprod.internal) {
      expect(shown).not.toContain(internal.address);
    }
  });

  /**
   * The receive screen subtracts the addresses it is showing from the ones the
   * wallet owns, and a difference is only a difference when the second set is
   * whole. A local account derived every address it has, so it may be
   * subtracted from; the CIP-30 side answers with what a wallet chose to list
   * and must not be. Without this flag both look like sets and the warning
   * fires on ordinary addresses of ordinary wallets.
   */
  it("declares its owned set complete, which is what makes the receive warning a measurement", () => {
    expect(localPort(preprod).ownedIsComplete).toBe(true);
  });

  it("knows its own reward address without asking anyone", async () => {
    const hex = await localPort(preprod).getRewardAddressHex();
    expect(bech32Of(hex)).toBe(preprod.rewardAddress);
  });

  /**
   * One seed must be one dRep, however the wallet is opened.
   *
   * Asserting `hash === account.drepKeyHashHex` would compare the field to
   * itself and stay green even if chain 3 were derived from the wrong role. So
   * this takes the account's own dRep public key, pushes it through the CIP-30
   * adapter exactly as a wallet answering `getPubDRepKey` would, and requires
   * the two paths to agree. If they ever diverge, the same recovery phrase
   * votes as two different dReps depending on whether it was opened here or in
   * Lace — and only one of those has any voting power.
   */
  it("derives the dRep id the CIP-30 path would compute for the same key", async () => {
    const hash = await localPort(preprod).getDrepKeyHashHex();
    expect(hash).toMatch(/^[0-9a-f]{56}$/);

    const prv = preprod.keyByHash.get(preprod.drepKeyHashHex);
    expect(prv).toBeDefined();
    const pubKeyHex = toHex(prv!.toPublicKey().toBytes());
    expect(pubKeyHex).toHaveLength(64); // 32 bytes, the only shape CIP-95 accepts

    const viaCip30 = await cip30Port({
      getPubDRepKey: async () => pubKeyHex,
    } as unknown as Cip30Api).getDrepKeyHashHex();

    expect(viaCip30).toBe(hash);
  });
});

describe("localPort — signing keeps preprod and preview apart", () => {
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

  function txFor(account: Account, network: PhoenixNetwork) {
    const payee = baseAddress("cc".repeat(28), "dd".repeat(28), network);
    return buildMultiSend({
      outputs: buildSendOutputs([{ address: payee, ada: "3", tokens: [] }], network),
      inputs: [utxoAt(account.external[0]!.address)],
      changeAddress: shelley(account.internal[0]!.address),
      protocolParams: PROTOCOL_PARAMS,
      ttl: 50_000_000,
    });
  }

  it("signs and submits when the account is on the network it was asked for", async () => {
    mockSubmitTx.mockResolvedValue("ab".repeat(32));
    const hash = await localPort(preprod).signAndSubmit(txFor(preprod, 0), 0);
    expect(hash).toBe("ab".repeat(32));
    expect(mockSubmitTx).toHaveBeenCalledOnce();
    expect(mockSubmitTx.mock.calls[0]![0]).toBe(0);
  });

  it("refuses a preprod transaction from a preview account", async () => {
    // This is the case CIP-30 cannot express at all: both are network id 0 to
    // an extension. Because the port passes the `PhoenixNetwork` down intact,
    // the local signer can still tell them apart — and must.
    const port = localPort(preview);
    await expect(port.signAndSubmit(txFor(preview, 2), 0)).rejects.toThrow("sign_network_mismatch");
    expect(mockSubmitTx).not.toHaveBeenCalled();
  });

  it("refuses a preview transaction from a preprod account", async () => {
    const port = localPort(preprod);
    await expect(port.signAndSubmit(txFor(preprod, 0), 2)).rejects.toThrow("sign_network_mismatch");
    expect(mockSubmitTx).not.toHaveBeenCalled();
  });

  it("refuses a mainnet transaction from a testnet account", async () => {
    await expect(localPort(preprod).signAndSubmit(txFor(preprod, 0), 1)).rejects.toThrow(
      "sign_network_mismatch",
    );
  });

  it("hands back the tx hash when the submit's outcome is unknown", async () => {
    mockSubmitTx.mockRejectedValue(new Error("connection reset"));
    const err = await localPort(preprod)
      .signAndSubmit(txFor(preprod, 0), 0)
      .catch((e) => e);
    // Without the hash, the only way to resolve the doubt is to resend — which
    // is how people pay twice. The port must not flatten this into a failure.
    expect(err).toBeInstanceOf(SubmitUncertainError);
    expect((err as SubmitUncertainError).txHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
