/**
 * `getStakeAccountState` and the vote-delegation field.
 *
 * The withdraw button decides from `delegatedDRep` whether the chain will
 * accept a withdrawal. A missing field must not read as "no DRep" (that sends
 * a user who already chose one into a second, paid transaction), and a null
 * must not read as "has one" (that offers a withdrawal the node rejects).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const koios = vi.hoisted(() => vi.fn());
vi.mock("../provider", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, koios };
});

import { getStakeAccountState } from "../staking";

const ADDR = "stake_test1uqtestaccount";
const row = (over: Record<string, unknown>) => ({
  stake_address: ADDR,
  status: "registered",
  delegated_pool: "pool1abc",
  rewards_available: "5000000",
  ...over,
});

beforeEach(() => koios.mockReset());

describe("getStakeAccountState: delegatedDRep", () => {
  it("carries a DRep id through", async () => {
    koios.mockResolvedValue([row({ delegated_drep: "drep1xyz" })]);
    const s = await getStakeAccountState(0, ADDR);
    expect(s.delegatedDRep).toBe("drep1xyz");
    expect(s.rewardsAvailable).toBe(BigInt(5_000_000));
  });

  it("carries the Abstain label through", async () => {
    koios.mockResolvedValue([row({ delegated_drep: "drep_always_abstain" })]);
    expect((await getStakeAccountState(0, ADDR)).delegatedDRep).toBe("drep_always_abstain");
  });

  it("null stays null: the account has no vote delegation", async () => {
    koios.mockResolvedValue([row({ delegated_drep: null })]);
    expect((await getStakeAccountState(0, ADDR)).delegatedDRep).toBeNull();
  });

  it("throws when the indexer leaves the field out, instead of guessing", async () => {
    koios.mockResolvedValue([row({})]);
    await expect(getStakeAccountState(0, ADDR)).rejects.toThrow(/delegated_drep/);
  });

  it("an unseen account is not registered and has no DRep", async () => {
    koios.mockResolvedValue([]);
    expect(await getStakeAccountState(0, ADDR)).toEqual({
      registered: false,
      delegatedPoolId: null,
      rewardsAvailable: BigInt(0),
      delegatedDRep: null,
    });
  });
});
