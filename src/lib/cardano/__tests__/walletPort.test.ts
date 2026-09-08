/**
 * The CIP-30 half of `WalletPort`, and the asset sum both halves share.
 *
 * What is worth pinning here is not that the adapter forwards calls — it is the
 * three places where forwarding would be wrong:
 *
 *   1. **Network narrowing.** CIP-30 answers `0` for every testnet. The port
 *      takes a `PhoenixNetwork` (preprod 0, mainnet 1, preview 2) and must
 *      narrow, or a preview wallet fails its own network check.
 *   2. **CIP-95 is optional.** A wallet without it must produce `null`, never a
 *      throw — governance stays visible and fails with a readable message
 *      instead of the tab vanishing.
 *   3. **An empty answer is an answer.** No unused address must fall back to a
 *      used one rather than showing a person nothing while they wait to be paid.
 */
import { describe, it, expect, vi } from "vitest";
import BigNumber from "bignumber.js";
import type { types as tyTypes } from "@stricahq/typhonjs";
import { cip30Port, sumAssets } from "../walletPort";
import { NetworkMismatchError, type Cip30Api } from "../cip30";
import type { BuiltTx } from "../tx";

/** A `Cip30Api` with only the methods a test needs; the rest throw if called. */
function fakeApi(over: Partial<Cip30Api>): Cip30Api {
  const nope = (name: string) => () => {
    throw new Error(`unexpected call: ${name}`);
  };
  return {
    getNetworkId: nope("getNetworkId"),
    getUtxos: nope("getUtxos"),
    getBalance: nope("getBalance"),
    getUsedAddresses: nope("getUsedAddresses"),
    getUnusedAddresses: nope("getUnusedAddresses"),
    getChangeAddress: nope("getChangeAddress"),
    getRewardAddresses: nope("getRewardAddresses"),
    signTx: nope("signTx"),
    signData: nope("signData"),
    submitTx: nope("submitTx"),
    ...over,
  } as unknown as Cip30Api;
}

/** Minimal stand-in for a decoded input carrying native tokens. */
function inputWith(tokens: { policyId: string; assetName: string; amount: string }[]): tyTypes.Input {
  return {
    tokens: tokens.map((t) => ({
      policyId: t.policyId,
      assetName: t.assetName,
      amount: new BigNumber(t.amount),
    })),
  } as unknown as tyTypes.Input;
}

const POLICY_A = "a".repeat(56);
const POLICY_B = "b".repeat(56);

describe("sumAssets", () => {
  it("sums one unit spread across several inputs", () => {
    const got = sumAssets([
      inputWith([{ policyId: POLICY_A, assetName: "4142", amount: "10" }]),
      inputWith([{ policyId: POLICY_A, assetName: "4142", amount: "5" }]),
    ]);
    expect(got).toHaveLength(1);
    expect(got[0]!.unit).toBe(POLICY_A + "4142");
    expect(got[0]!.quantity).toBe(BigInt(15));
  });

  it("keeps two assets of the same policy apart", () => {
    const got = sumAssets([
      inputWith([
        { policyId: POLICY_A, assetName: "4142", amount: "1" },
        { policyId: POLICY_A, assetName: "4143", amount: "2" },
      ]),
    ]);
    expect(got.map((a) => a.quantity)).toEqual([BigInt(1), BigInt(2)]);
    expect(new Set(got.map((a) => a.unit)).size).toBe(2);
  });

  it("keeps two policies with the same asset name apart", () => {
    const got = sumAssets([
      inputWith([
        { policyId: POLICY_A, assetName: "4142", amount: "1" },
        { policyId: POLICY_B, assetName: "4142", amount: "1" },
      ]),
    ]);
    expect(got).toHaveLength(2);
  });

  it("treats a nameless asset as a real unit rather than dropping it", () => {
    const got = sumAssets([inputWith([{ policyId: POLICY_A, assetName: "", amount: "7" }])]);
    expect(got).toEqual([
      { unit: POLICY_A, policyId: POLICY_A, assetNameHex: "", quantity: BigInt(7) },
    ]);
  });

  it("returns nothing for pure-ADA inputs", () => {
    expect(sumAssets([inputWith([])])).toEqual([]);
  });

  // These four say the same thing: an amount that is not a whole non-negative
  // number is not a token amount, and rounding one is worse than refusing it.
  // `toFixed(0)` — the obvious way to write this — turns 1.5 into 2 (a unit the
  // wallet does not hold) and 0.4 into 0 (hiding one it does), and lets a
  // negative through unchanged. Measured, all three.
  it("refuses a fractional amount instead of rounding it up", () => {
    expect(() =>
      sumAssets([inputWith([{ policyId: POLICY_A, assetName: "", amount: "1.5" }])]),
    ).toThrow(/malformed token amount/);
  });

  it("refuses a fractional amount instead of rounding it away", () => {
    expect(() =>
      sumAssets([inputWith([{ policyId: POLICY_A, assetName: "", amount: "0.4" }])]),
    ).toThrow(/malformed token amount/);
  });

  it("refuses a negative amount", () => {
    expect(() =>
      sumAssets([inputWith([{ policyId: POLICY_A, assetName: "", amount: "-5" }])]),
    ).toThrow(/malformed token amount/);
  });

  it("refuses NaN with a message that names the cause", () => {
    expect(() =>
      sumAssets([inputWith([{ policyId: POLICY_A, assetName: "", amount: "NaN" }])]),
    ).toThrow(/malformed token amount/);
  });

  // `{policyId: "aa", assetName: "bb"}` and `{policyId: "aabb", assetName: ""}`
  // both spell the unit "aabb". Without a length check their quantities would
  // be added together and reported under whichever policy id was seen first.
  it("refuses a policy id that is not 28 bytes, which would make units ambiguous", () => {
    expect(() => sumAssets([inputWith([{ policyId: "aa", assetName: "bb", amount: "1" }])])).toThrow(
      /malformed policy id/,
    );
  });
});

describe("cip30Port — reads", () => {
  it("skips the CBOR decoder entirely when there are no UTxOs", async () => {
    const getUtxos = vi.fn().mockResolvedValue([]);
    expect(await cip30Port(fakeApi({ getUtxos })).getInputs()).toEqual([]);
    // `undefined` is what some wallets return for an empty set; it must not
    // reach the decoder either.
    const undef = vi.fn().mockResolvedValue(undefined);
    expect(await cip30Port(fakeApi({ getUtxos: undef })).getInputs()).toEqual([]);
  });

  /**
   * `getUsedAddresses ∪ getUnusedAddresses` is what a wallet admits to, not
   * what it watches — always a subset, and a wallet listing four addresses is
   * behaving normally. Declaring the set incomplete is what stops the receive
   * screen subtracting from it and calling perfectly ordinary addresses
   * unwatched; a warning that cries wolf on the ordinary case is a warning
   * nobody reads on the real one.
   */
  it("declares its owned set incomplete, because a wallet lists rather than enumerates", () => {
    expect(cip30Port(fakeApi({})).ownedIsComplete).toBe(false);
  });

  it("refuses to invent a reward address when the wallet has none", async () => {
    const port = cip30Port(fakeApi({ getRewardAddresses: vi.fn().mockResolvedValue([]) }));
    await expect(port.getRewardAddressHex()).rejects.toThrow("stake_account_error");
  });

  it("prefers an unused receive address", async () => {
    const port = cip30Port(
      fakeApi({
        getUnusedAddresses: vi.fn().mockResolvedValue(["aa", "bb"]),
        getUsedAddresses: vi.fn().mockResolvedValue(["cc"]),
      }),
    );
    expect(await port.getReceiveAddressHex()).toBe("aa");
  });

  it("falls back to a used address rather than showing nothing", async () => {
    const port = cip30Port(
      fakeApi({
        getUnusedAddresses: vi.fn().mockResolvedValue([]),
        getUsedAddresses: vi.fn().mockResolvedValue(["cc"]),
      }),
    );
    expect(await port.getReceiveAddressHex()).toBe("cc");
  });

  it("reports null when the wallet exposes no address at all", async () => {
    const port = cip30Port(
      fakeApi({
        getUnusedAddresses: vi.fn().mockResolvedValue([]),
        getUsedAddresses: vi.fn().mockResolvedValue([]),
      }),
    );
    expect(await port.getReceiveAddressHex()).toBeNull();
  });

  it("unions used and unused for the ownership check", async () => {
    const port = cip30Port(
      fakeApi({
        getUsedAddresses: vi.fn().mockResolvedValue(["aa"]),
        getUnusedAddresses: vi.fn().mockResolvedValue(["bb"]),
      }),
    );
    expect((await port.getOwnedAddressesHex()).sort()).toEqual(["aa", "bb"]);
  });

  // An empty owned-set makes the receive screen say "undecidable". A crash
  // there would be read as "no answer" too, but via an error toast that blames
  // the user's key instead of the wallet's silence — so nullish lists must sum
  // to an empty array, not to a throw.
  it("survives a wallet answering undefined to both address lists", async () => {
    const port = cip30Port(
      fakeApi({
        getUsedAddresses: vi.fn().mockResolvedValue(undefined),
        getUnusedAddresses: vi.fn().mockResolvedValue(undefined),
      }),
    );
    expect(await port.getOwnedAddressesHex()).toEqual([]);
  });
});

describe("cip30Port — CIP-95 dRep key", () => {
  const PUB_KEY_HEX = "00".repeat(32);
  /**
   * blake2b-224 of those 32 zero bytes, obtained by running it.
   *
   * The value is pinned, not shape-matched. An earlier version of this test
   * asserted `/^[0-9a-f]{56}$/` and called itself pinned; blake2b-256
   * truncated to 56 hex and sha-256 truncated to 56 hex both satisfy that, so
   * it would have stayed green through a change of hash function — and a
   * changed hash function here means a governance action submitted under a dRep
   * id belonging to nobody.
   */
  const PUB_KEY_HASH = "f9dca21a6c826ec8acb4cf395cbc24351937bfe6560b2683ab8b415f";

  const withDirect = (fn: unknown) =>
    fakeApi({ getPubDRepKey: fn } as unknown as Partial<Cip30Api>);
  const withNamespace = (fn: unknown) => {
    const api = fakeApi({});
    (api as unknown as { cip95: unknown }).cip95 = { getPubDRepKey: fn };
    return api;
  };

  it("hashes the key with blake2b-224, pinned to a known value", async () => {
    const port = cip30Port(withDirect(vi.fn().mockResolvedValue(PUB_KEY_HEX)));
    expect(await port.getDrepKeyHashHex()).toBe(PUB_KEY_HASH);
  });

  it("reads the key from a `cip95` namespace and gets the same answer", async () => {
    const port = cip30Port(withNamespace(vi.fn().mockResolvedValue(PUB_KEY_HEX)));
    expect(await port.getDrepKeyHashHex()).toBe(PUB_KEY_HASH);
  });

  // The failure this catches: taking the holder from one branch (`cip95 ?? api`)
  // and the function from the other. A wallet exposing both spellings then
  // calls the top-level function with the namespace as `this`, which throws
  // inside any api that reads private state — and the throw is swallowed, so
  // the governance tab tells a capable wallet it is not supported.
  it("calls the function on the object it came from, when the wallet exposes both", async () => {
    const api = fakeApi({});
    const inner = { getPubDRepKey: vi.fn().mockResolvedValue("11".repeat(32)) };
    Object.assign(api, {
      marker: true,
      getPubDRepKey(this: { marker?: boolean }) {
        if (!this?.marker) throw new TypeError("called with the wrong `this`");
        return Promise.resolve(PUB_KEY_HEX);
      },
      cip95: inner,
    });
    expect(await cip30Port(api).getDrepKeyHashHex()).toBe(PUB_KEY_HASH);
  });

  it("answers null — never throws — when the extension is absent", async () => {
    expect(await cip30Port(fakeApi({})).getDrepKeyHashHex()).toBeNull();
  });

  it("answers null when the wallet implements it and refuses", async () => {
    const port = cip30Port(withDirect(vi.fn().mockRejectedValue(new Error("user declined"))));
    expect(await port.getDrepKeyHashHex()).toBeNull();
  });

  // Each of these is even-length hex, so it parses without complaint and hashes
  // to a well-formed 56-hex string that is not this wallet's dRep id. Measured:
  // raw → f9dca21a…, CBOR-wrapped → 88d98393…, extended → 3d913cd6…. Only the
  // first is correct, and nothing downstream can tell them apart.
  it("refuses a CBOR-wrapped key rather than hashing the wrapper", async () => {
    const port = cip30Port(withDirect(vi.fn().mockResolvedValue("5820" + PUB_KEY_HEX)));
    expect(await port.getDrepKeyHashHex()).toBeNull();
  });

  it("refuses a 64-byte extended key rather than hashing the chain code with it", async () => {
    const port = cip30Port(withDirect(vi.fn().mockResolvedValue("00".repeat(64))));
    expect(await port.getDrepKeyHashHex()).toBeNull();
  });

  it("refuses a key that is short by one byte", async () => {
    const port = cip30Port(withDirect(vi.fn().mockResolvedValue("00".repeat(31))));
    expect(await port.getDrepKeyHashHex()).toBeNull();
  });

  it("answers null on hex that cannot be parsed at all", async () => {
    const port = cip30Port(withDirect(vi.fn().mockResolvedValue("nothex")));
    expect(await port.getDrepKeyHashHex()).toBeNull();
  });
});

describe("cip30Port — network narrowing before signing", () => {
  const built = { unsignedCbor: "00", hash: "ff", fee: "0" } as unknown as BuiltTx;

  it("accepts preview against a wallet reporting testnet", async () => {
    // Preview is PhoenixNetwork 2, and CIP-30 calls every testnet 0. Without
    // narrowing, this comparison would be 2 ≠ 0 and a preview wallet could
    // never sign. Reaching `signTx` proves the network check passed.
    const signTx = vi.fn().mockRejectedValue(new Error("reached signTx"));
    const port = cip30Port(fakeApi({ getNetworkId: vi.fn().mockResolvedValue(0), signTx }));
    await expect(port.signAndSubmit(built, 2)).rejects.toThrow("reached signTx");
    expect(signTx).toHaveBeenCalledOnce();
  });

  it("accepts preprod against a wallet reporting testnet", async () => {
    const signTx = vi.fn().mockRejectedValue(new Error("reached signTx"));
    const port = cip30Port(fakeApi({ getNetworkId: vi.fn().mockResolvedValue(0), signTx }));
    await expect(port.signAndSubmit(built, 0)).rejects.toThrow("reached signTx");
  });

  it("still refuses to sign a mainnet transaction on a testnet wallet", async () => {
    const signTx = vi.fn();
    const port = cip30Port(fakeApi({ getNetworkId: vi.fn().mockResolvedValue(0), signTx }));
    await expect(port.signAndSubmit(built, 1)).rejects.toBeInstanceOf(NetworkMismatchError);
    expect(signTx).not.toHaveBeenCalled();
  });

  it("still refuses to sign a testnet transaction on a mainnet wallet", async () => {
    const signTx = vi.fn();
    const port = cip30Port(fakeApi({ getNetworkId: vi.fn().mockResolvedValue(1), signTx }));
    await expect(port.signAndSubmit(built, 0)).rejects.toBeInstanceOf(NetworkMismatchError);
    expect(signTx).not.toHaveBeenCalled();
  });
});
