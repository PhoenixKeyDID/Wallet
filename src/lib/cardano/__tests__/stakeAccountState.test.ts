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

  it("throws on a non-string, non-null delegated_drep instead of treating it as a DRep", async () => {
    // A number or object the type did not promise must not pass as "has a DRep":
    // that would offer a withdrawal the node rejects.
    koios.mockResolvedValue([row({ delegated_drep: 42 })]);
    await expect(getStakeAccountState(0, ADDR)).rejects.toThrow(/delegated_drep/);
    koios.mockResolvedValue([row({ delegated_drep: { id: "drep1xyz" } })]);
    await expect(getStakeAccountState(0, ADDR)).rejects.toThrow(/delegated_drep/);
  });
});

describe("getStakeAccountState: rewards_available", () => {
  it("throws when the field is missing, instead of padding it to 0", async () => {
    // A padded 0 shows "no rewards to withdraw yet" as if the chain said so,
    // hiding a balance the user could claim.
    koios.mockResolvedValue([row({ rewards_available: undefined, delegated_drep: null })]);
    await expect(getStakeAccountState(0, ADDR)).rejects.toThrow(/rewards_available/);
  });

  it("throws when the field is null, instead of padding it to 0", async () => {
    koios.mockResolvedValue([row({ rewards_available: null, delegated_drep: null })]);
    await expect(getStakeAccountState(0, ADDR)).rejects.toThrow(/rewards_available/);
  });

  it("carries a present balance through, including the honest zero", async () => {
    koios.mockResolvedValue([row({ rewards_available: "0", delegated_drep: null })]);
    expect((await getStakeAccountState(0, ADDR)).rewardsAvailable).toBe(BigInt(0));
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
