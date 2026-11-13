// @vitest-environment happy-dom
/**
 * The shared "vote delegation just sent" gate, across the tab switch.
 *
 * Two MEDIUM holes, one cause: the Staking tab's "a vote delegation is in
 * flight" fact used to live inside the Staking panel, which `WalletTabs`
 * unmounts whenever another tab is open. So:
 *   - FIX1: Abstain sent on Staking → leave to History and back → the fact is
 *     gone, "Choose Abstain" is offered again, and a second Abstain is signed
 *     (a second fee, or a node rejection).
 *   - FIX2: a real DRep chosen on the Governance tab is invisible to Staking;
 *     while Koios lags it still reads `delegated_drep: null`, offers Abstain,
 *     and signing it REPLACES the DRep the user just chose.
 *
 * The fix lifts the fact to `WalletTabs` (same shape as `sentDelegation`), set
 * both when Staking signs Abstain and when Governance signs any DRep choice.
 * These tests drive the real `WalletTabs`, `StakingPanel` and `GovernancePanel`
 * together and pin that the offer is suppressed and survives a tab switch.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import i18next, { type i18n as I18n } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import type { ReactNode } from "react";
import en from "../../../../locales/en/wallet.json";
import type { WalletPort } from "@/lib/cardano";

const ACCOUNT = "stake_test1uqtestaccount";
const DREP = "drep1testdrepidentifier0000abcd";
const NETWORK = 0 as const;
const CHANGE_HEX = "60" + "11".repeat(28);
const REWARDS = BigInt(5_000_000);

const m = vi.hoisted(() => ({
  getStakeAccountState: vi.fn(),
  searchPools: vi.fn(),
  listDReps: vi.fn(),
  buildVoteDelegation: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/cardano/staking", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    getStakeAccountState: m.getStakeAccountState,
    searchPools: m.searchPools,
    rewardAddressFromHex: () => ({ getBech32: () => ACCOUNT, stakeCredential: {} }),
  };
});
vi.mock("@/lib/cardano/governance", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    listDReps: m.listDReps,
    listGovActions: async () => [],
    getVoteDelegationState: async () => ({ delegatedDRep: null }),
    rewardAddressFrom: () => ({ getBech32: () => ACCOUNT }),
    buildVoteDelegation: m.buildVoteDelegation,
    parseDRepId: (x: string) => x,
  };
});
vi.mock("@/lib/cardano", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, fetchProtocolParams: async () => ({}), fetchTipSlot: async () => 1000 };
});
vi.mock("@/lib/toast", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, toastSuccess: m.toastSuccess, toastError: m.toastError, toastApiError: vi.fn() };
});
// Siblings not under test — stubbed so their network reads stay out.
vi.mock("../HistoryPanel", () => ({ HistoryPanel: () => <p>history-stub</p> }));
vi.mock("../ReceivePanel", () => ({ ReceivePanel: () => <p>receive-stub</p> }));
vi.mock("../SendPanel", () => ({ SendPanel: () => <p>send-stub</p> }));
vi.mock("../ConnectPanel", () => ({ ConnectPanel: () => <p>connect-stub</p> }));

import { WalletTabs } from "../WalletTabs";

const VOTE_TX = { fee: "180000", tag: "vote-tx" };

let i18n: I18n;
beforeEach(async () => {
  i18n = i18next.createInstance();
  await i18n.use(initReactI18next).init({
    lng: "en",
    defaultNS: "wallet",
    ns: ["wallet"],
    resources: { en: { wallet: en } },
    interpolation: { escapeValue: false },
  });
  m.getStakeAccountState.mockReset();
  m.searchPools.mockReset();
  m.searchPools.mockResolvedValue([]);
  m.listDReps.mockReset();
  m.listDReps.mockResolvedValue([{ drepId: DREP, votingPower: "1000000" }]);
  m.buildVoteDelegation.mockReset();
  m.buildVoteDelegation.mockReturnValue(VOTE_TX);
  m.toastSuccess.mockReset();
  m.toastError.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const account = (rewards: bigint, delegatedDRep: string | null) => ({
  registered: true,
  delegatedPoolId: "pool1testpoolxyz9",
  rewardsAvailable: rewards,
  delegatedDRep,
});

function makePort() {
  return {
    kind: "local",
    getInputs: vi.fn(async () => [{}]),
    getRewardAddressHex: vi.fn(async () => "e0" + "22".repeat(28)),
    getDrepKeyHashHex: vi.fn(async () => "33".repeat(28)),
    signAndSubmit: vi.fn(async () => "abcdef0123456789abcdef"),
  } as unknown as WalletPort & { signAndSubmit: ReturnType<typeof vi.fn> };
}

const wrap = (ui: ReactNode) => <I18nextProvider i18n={i18n}>{ui}</I18nextProvider>;

const abstainButton = () =>
  screen.queryByRole("button", { name: en.withdraw_abstain_button }) as HTMLButtonElement | null;
const stakingTab = () => screen.getByRole("button", { name: new RegExp(en.tab_staking) });
const historyTab = () => screen.getByRole("button", { name: new RegExp(en.tab_history) });
const governanceTab = () => screen.getByRole("button", { name: new RegExp(en.tab_governance) });

describe("FIX1: an Abstain sent on the Staking tab survives a tab switch", () => {
  it("keeps the waiting line and does not re-offer Abstain after History and back", async () => {
    m.getStakeAccountState.mockResolvedValue(account(REWARDS, null));
    const port = makePort();
    render(wrap(<WalletTabs port={port} changeAddress={CHANGE_HEX} network={NETWORK} />));

    fireEvent.click(stakingTab());
    // Rewards present, no DRep yet → the rule and the one-step Abstain offer.
    fireEvent.click(await screen.findByRole("button", { name: en.withdraw_abstain_button }));
    await screen.findByText(en.withdraw_abstain_review_title);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: en.withdraw_abstain_confirm }));

    expect(await screen.findByText(en.vote_delegation_pending)).toBeTruthy();
    expect(abstainButton()).toBeNull();
    expect(screen.queryByText(en.withdraw_needs_drep)).toBeNull();
    expect(port.signAndSubmit).toHaveBeenCalledTimes(1);

    // Leave to History (unmounts StakingPanel) and come back.
    fireEvent.click(historyTab());
    expect(await screen.findByText("history-stub")).toBeTruthy();
    fireEvent.click(stakingTab());

    // The waiting line is back, the Abstain offer is NOT — the exact moment the
    // old local state had been dropped and a second Abstain could be signed.
    expect(await screen.findByText(en.vote_delegation_pending)).toBeTruthy();
    expect(abstainButton()).toBeNull();
    expect(screen.queryByText(en.withdraw_needs_drep)).toBeNull();
  });
});

describe("FIX2: a DRep chosen on the Governance tab stops Staking offering Abstain", () => {
  it("suppresses the Abstain offer on Staking while Koios still reports no DRep", async () => {
    // Koios lags: the account still reads delegated_drep null on the Staking tab.
    m.getStakeAccountState.mockResolvedValue(account(REWARDS, null));
    const port = makePort();
    render(wrap(<WalletTabs port={port} changeAddress={CHANGE_HEX} network={NETWORK} />));

    // Delegate to a real DRep on the Governance tab.
    fireEvent.click(governanceTab());
    await waitFor(() => expect(port.getDrepKeyHashHex).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: en.gov_search }));
    const row = (await screen.findByText(DREP)).parentElement!;
    fireEvent.click(within(row).getByRole("button", { name: en.gov_delegate }));
    fireEvent.click(await screen.findByLabelText(en.gov_verify_checkbox));
    const confirm = screen.getByRole("button", { name: en.gov_confirm }) as HTMLButtonElement;
    await waitFor(() => expect(confirm.disabled).toBe(false));
    fireEvent.click(confirm);
    await waitFor(() => expect(m.toastSuccess).toHaveBeenCalledWith("gov_delegation_submitted", expect.anything()));

    // Now the Staking tab. It must NOT offer Abstain (that would overwrite the
    // DRep just chosen) and must NOT claim the account has no DRep.
    fireEvent.click(stakingTab());
    expect(await screen.findByText(en.vote_delegation_pending)).toBeTruthy();
    expect(abstainButton()).toBeNull();
    expect(screen.queryByText(en.withdraw_needs_drep)).toBeNull();
    // The Abstain path was never signed from here.
    expect(m.buildVoteDelegation).toHaveBeenCalledTimes(1);
    expect(m.buildVoteDelegation.mock.calls[0]![0]).toMatchObject({ target: { kind: "drep", drepId: DREP } });
  });
});

describe("FIX5: the Governance tab reads the same in-flight record", () => {
  it("an Abstain sent on Staking shows as waiting on Governance, not as a bare 'None'", async () => {
    m.getStakeAccountState.mockResolvedValue(account(REWARDS, null));
    const port = makePort();
    render(wrap(<WalletTabs port={port} changeAddress={CHANGE_HEX} network={NETWORK} />));

    fireEvent.click(stakingTab());
    fireEvent.click(await screen.findByRole("button", { name: en.withdraw_abstain_button }));
    await screen.findByText(en.withdraw_abstain_review_title);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: en.withdraw_abstain_confirm }));
    await screen.findByText(en.vote_delegation_pending);

    // Koios still reports no DRep. Without the shared record the Governance
    // tab showed "None" alone — the screen that invites a second, paid one.
    fireEvent.click(governanceTab());
    expect(await screen.findByText(en.gov_delegate_pending)).toBeTruthy();
    expect(port.signAndSubmit).toHaveBeenCalledTimes(1);
  });

  it("a choice made on Governance is still marked after History and back", async () => {
    m.getStakeAccountState.mockResolvedValue(account(REWARDS, null));
    const port = makePort();
    render(wrap(<WalletTabs port={port} changeAddress={CHANGE_HEX} network={NETWORK} />));

    fireEvent.click(governanceTab());
    await waitFor(() => expect(port.getDrepKeyHashHex).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: en.gov_search }));
    const row = (await screen.findByText(DREP)).parentElement!;
    fireEvent.click(within(row).getByRole("button", { name: en.gov_delegate }));
    fireEvent.click(await screen.findByLabelText(en.gov_verify_checkbox));
    const confirm = screen.getByRole("button", { name: en.gov_confirm }) as HTMLButtonElement;
    await waitFor(() => expect(confirm.disabled).toBe(false));
    fireEvent.click(confirm);
    expect(await screen.findByText(en.gov_delegate_pending)).toBeTruthy();

    fireEvent.click(historyTab());
    expect(await screen.findByText("history-stub")).toBeTruthy();
    fireEvent.click(governanceTab());
    expect(await screen.findByText(en.gov_delegate_pending)).toBeTruthy();
  });
});
