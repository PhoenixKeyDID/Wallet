import { describe, it, expect, afterEach, vi } from "vitest";
import { searchPools, getStakeAccountState } from "./staking";
import { listDReps } from "./governance";

/**
 * Indexer failures must reach the caller (Wallet#8).
 *
 * These read paths used to catch and return a plausible-looking default — `[]`
 * or `registered: false`. That turns "the indexer is down" into a statement of
 * fact about the chain. The worst case is `getStakeAccountState`: a swallowed
 * error says "not registered", `StakingPanel` derives `needsRegistration`, and
 * the next transaction carries a STAKE_KEY_REGISTRATION certificate for a key
 * that is already registered — the node rejects the whole transaction.
 *
 * Every UI call site already wraps these in try/catch and raises `loadError`;
 * the lib layer was defeating that. So the contract asserted here is simply:
 * a failing fetch must reject, never resolve to a default.
 */

const PREPROD = 0 as const;
const STAKE_ADDR = "stake_test1uqxlvnjcm6t2xd2xj9h0aqdqxvrf3ptl3jgfw0jf2vp7v3qlhu6wt";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A fetch that always fails the way a struggling indexer does. */
function stubFetchStatus(status: number) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("upstream error", { status })),
  );
}

function stubFetchNetworkError() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }),
  );
}

describe("indexer failures propagate instead of becoming data", () => {
  it("getStakeAccountState rejects on HTTP 500 rather than reporting not-registered", async () => {
    stubFetchStatus(500);
    await expect(getStakeAccountState(PREPROD, STAKE_ADDR)).rejects.toThrow();
  });

  it("getStakeAccountState rejects on a network error", async () => {
    stubFetchNetworkError();
    await expect(getStakeAccountState(PREPROD, STAKE_ADDR)).rejects.toThrow();
  });

  it("getStakeAccountState still reports not-registered for an empty result set", async () => {
    // A successful query returning no row is a real answer: the chain has never
    // seen this stake address. That default must survive the change above.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json([])),
    );
    await expect(getStakeAccountState(PREPROD, STAKE_ADDR)).resolves.toEqual({
      registered: false,
      delegatedPoolId: null,
      rewardsAvailable: BigInt("0"),
    });
  });

  it("getStakeAccountState reports a registered key faithfully", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json([
          {
            stake_address: STAKE_ADDR,
            status: "registered",
            delegated_pool: "pool1abc",
            rewards_available: "12345",
          },
        ]),
      ),
    );
    await expect(getStakeAccountState(PREPROD, STAKE_ADDR)).resolves.toEqual({
      registered: true,
      delegatedPoolId: "pool1abc",
      rewardsAvailable: BigInt("12345"),
    });
  });

  it("searchPools rejects on HTTP 503 rather than reporting no such pool", async () => {
    stubFetchStatus(503);
    await expect(searchPools(PREPROD, "PHNX")).rejects.toThrow();
  });

  it("searchPools still returns [] for an empty query without touching the network", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(searchPools(PREPROD, "   ")).resolves.toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("listDReps rejects when /drep_info fails, rather than showing dReps with no voting power", async () => {
    // /drep_list succeeds, /drep_info fails — the case the old catch hid.
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        if (call === 1) {
          return Response.json([{ drep_id: "drep1abc", hex: "00", has_script: false, registered: true }]);
        }
        return new Response("upstream error", { status: 503 });
      }),
    );
    await expect(listDReps(PREPROD, "drep1")).rejects.toThrow();
  });
});
