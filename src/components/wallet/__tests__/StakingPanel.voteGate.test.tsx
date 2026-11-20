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
import { render, cleanup, fireEvent, screen, waitFor, within, act } from "@testing-library/react";
import i18next, { type i18n as I18n } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import type { ReactNode } from "react";
import en from "../../../../locales/en/wallet.json";
import type { WalletPort } from "@/lib/cardano";
import { DELEGATION_UNSEEN_MS, VOTE_DELEGATION_WATCH_LIMIT_MS, clockTime } from "../delegationFeedback";
import { accountKeyFrom } from "../uncertainStore";
import { voteDelegationKey } from "../voteDelegationStore";

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
  fetchTxSeen: vi.fn(),
  getVoteDelegationState: vi.fn(),
  buildWithdrawal: vi.fn(),
}));

vi.mock("@/lib/cardano/staking", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    getStakeAccountState: m.getStakeAccountState,
    searchPools: m.searchPools,
    buildWithdrawal: m.buildWithdrawal,
    rewardAddressFromHex: () => ({ getBech32: () => ACCOUNT, stakeCredential: {} }),
  };
});
vi.mock("@/lib/cardano/governance", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    listDReps: m.listDReps,
    listGovActions: async () => [],
    getVoteDelegationState: m.getVoteDelegationState,
    rewardAddressFrom: () => ({ getBech32: () => ACCOUNT }),
    buildVoteDelegation: m.buildVoteDelegation,
    parseDRepId: (x: string) => x,
  };
});
vi.mock("@/lib/cardano", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, fetchProtocolParams: async () => ({}), fetchTipSlot: async () => 1000, fetchTxSeen: m.fetchTxSeen };
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
  m.buildWithdrawal.mockReset();
  m.buildWithdrawal.mockReturnValue({ fee: "190000", tag: "withdraw-tx" });
  m.toastSuccess.mockReset();
  m.toastError.mockReset();
  m.fetchTxSeen.mockReset();
  m.fetchTxSeen.mockResolvedValue(false);
  m.getVoteDelegationState.mockReset();
  m.getVoteDelegationState.mockResolvedValue({ found: true, status: "registered", delegatedDRep: null });
  // The in-flight record is kept on disk now; one test's record must not
  // leak into the next.
  window.localStorage.clear();
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

/** A line whose text starts with the part of `key` before its `{{time}}`. */
const startsLike = (key: keyof typeof en) => {
  const head = (en[key] as string).split("{{time}}")[0]!;
  return (content: string) => content.startsWith(head);
};

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

/**
 * "Landed" read from the transaction itself, not from a DRep change.
 *
 * Re-delegating to the DRep already held (X → X), or sending while the DRep
 * before was never read, leaves no DRep change to see. Judged by that alone,
 * the line turned into "most likely did not get in" after ten minutes for a
 * transaction that had landed — and stayed up to two hours, inviting a second,
 * paid delegation. The hash the submit returned is looked up on the same 20 s
 * re-read; found in a block ⇒ the record is dropped and both tabs stop waiting.
 */
describe("FIX-R2: a sent vote delegation found by its hash clears the line", () => {
  const TX_HASH = "abcdef0123456789abcdef"; // what `makePort().signAndSubmit` returns

  /** Governance tab: search → delegate to DREP → tick → confirm. */
  async function delegateOnGovernance(port: ReturnType<typeof makePort>) {
    fireEvent.click(governanceTab());
    await waitFor(() => expect(port.getDrepKeyHashHex).toHaveBeenCalled());
    await waitFor(() => expect(m.getVoteDelegationState).toHaveBeenCalled());
    // Let the first DRep read settle, so `drepBefore` is what it read.
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: en.gov_search }));
    const row = (await screen.findByText(DREP)).parentElement!;
    fireEvent.click(within(row).getByRole("button", { name: en.gov_delegate }));
    fireEvent.click(await screen.findByLabelText(en.gov_verify_checkbox));
    const confirm = screen.getByRole("button", { name: en.gov_confirm }) as HTMLButtonElement;
    await waitFor(() => expect(confirm.disabled).toBe(false));
    fireEvent.click(confirm);
    expect(await screen.findByText(en.gov_delegate_pending)).toBeTruthy();
  }

  /** Past the ten-minute "unseen" mark, in two steps: the first tick, then the rest. */
  async function passTenMinutes() {
    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });
    await act(async () => {
      vi.advanceTimersByTime(DELEGATION_UNSEEN_MS);
    });
  }

  it("(a) X → X: the DRep before is the target, the tx is in a block ⇒ no 'unseen' line", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    m.getStakeAccountState.mockResolvedValue(account(REWARDS, DREP));
    m.getVoteDelegationState.mockResolvedValue({ found: true, status: "registered", delegatedDRep: DREP });
    const port = makePort();
    render(wrap(<WalletTabs port={port} changeAddress={CHANGE_HEX} network={NETWORK} />));
    await delegateOnGovernance(port);

    m.fetchTxSeen.mockResolvedValue(true);
    await passTenMinutes();
    expect(m.fetchTxSeen).toHaveBeenCalledWith(NETWORK, TX_HASH);
    await waitFor(() => expect(screen.queryByText(startsLike("vote_delegation_unseen"))).toBeNull());
    expect(screen.queryByText(en.gov_delegate_pending)).toBeNull();

    // The record is gone from the parent: the Staking tab shows no line either.
    fireEvent.click(stakingTab());
    await screen.findByText(en.withdraw_rewards);
    expect(screen.queryByText(en.vote_delegation_pending)).toBeNull();
    expect(screen.queryByText(startsLike("vote_delegation_unseen"))).toBeNull();
  });

  it("(b) the tx is in a block but the DRep read fails ⇒ still waiting; once it reads a DRep ⇒ cleared", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    m.getStakeAccountState.mockResolvedValue(account(REWARDS, null));
    m.getVoteDelegationState.mockRejectedValue(new Error("koios down"));
    const port = makePort();
    render(wrap(<WalletTabs port={port} changeAddress={CHANGE_HEX} network={NETWORK} />));
    await delegateOnGovernance(port);
    expect(screen.queryByText(en.gov_current_delegation, { exact: false })).toBeNull();

    // Found by hash, but the account read is "not known": the record stays.
    m.fetchTxSeen.mockResolvedValue(true);
    await passTenMinutes();
    expect(await screen.findByText(startsLike("vote_delegation_unseen"))).toBeTruthy();

    // The read answers with the DRep: the hash hit is confirmed, the line goes.
    m.getVoteDelegationState.mockResolvedValue({ found: true, status: "registered", delegatedDRep: DREP });
    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });
    await waitFor(() => expect(screen.queryByText(startsLike("vote_delegation_unseen"))).toBeNull());
    expect(screen.queryByText(en.gov_delegate_pending)).toBeNull();
  });

  it("(c) control: the tx is not found after ten minutes ⇒ the 'unseen' line is up", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    m.getStakeAccountState.mockResolvedValue(account(REWARDS, DREP));
    m.getVoteDelegationState.mockResolvedValue({ found: true, status: "registered", delegatedDRep: DREP });
    const port = makePort();
    render(wrap(<WalletTabs port={port} changeAddress={CHANGE_HEX} network={NETWORK} />));
    await delegateOnGovernance(port);

    m.fetchTxSeen.mockResolvedValue(false);
    await passTenMinutes();
    expect(m.fetchTxSeen).toHaveBeenCalledWith(NETWORK, TX_HASH);
    expect(await screen.findByText(startsLike("vote_delegation_unseen"))).toBeTruthy();
  });

  it("a failed look-up is 'not known', not 'landed': the line stays", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    m.getStakeAccountState.mockResolvedValue(account(REWARDS, DREP));
    m.getVoteDelegationState.mockResolvedValue({ found: true, status: "registered", delegatedDRep: DREP });
    const port = makePort();
    render(wrap(<WalletTabs port={port} changeAddress={CHANGE_HEX} network={NETWORK} />));
    await delegateOnGovernance(port);

    m.fetchTxSeen.mockRejectedValue(new Error("koios down"));
    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });
    expect(m.fetchTxSeen).toHaveBeenCalled();
    expect(await screen.findByText(en.gov_delegate_pending)).toBeTruthy();
  });
});

/**
 * The in-flight record outlives the session lock and a reload. The local
 * wallet locks when the page is hidden, which unmounts `WalletTabs`; held only
 * in its state, the record was gone on unlock and Abstain was armed again.
 */
describe("FIX-R3: the in-flight vote delegation survives a lock and a reload", () => {
  const HASH64 = "ab".repeat(32);
  const storageKey = () => voteDelegationKey(NETWORK, accountKeyFrom(CHANGE_HEX));

  it("send Abstain, lock (unmount), unlock (remount) ⇒ no Abstain button, the waiting line is back", async () => {
    m.getStakeAccountState.mockResolvedValue(account(REWARDS, null));
    const port = makePort();
    port.signAndSubmit.mockResolvedValue(HASH64);
    const first = render(wrap(<WalletTabs port={port} changeAddress={CHANGE_HEX} network={NETWORK} />));
    fireEvent.click(stakingTab());
    fireEvent.click(await screen.findByRole("button", { name: en.withdraw_abstain_button }));
    await screen.findByText(en.withdraw_abstain_review_title);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: en.withdraw_abstain_confirm }));
    await screen.findByText(en.vote_delegation_pending);

    first.unmount(); // the session locks
    expect(screen.queryByText(en.vote_delegation_pending)).toBeNull();

    render(wrap(<WalletTabs port={port} changeAddress={CHANGE_HEX} network={NETWORK} />)); // unlocked
    fireEvent.click(stakingTab());
    expect(await screen.findByText(en.vote_delegation_pending)).toBeTruthy();
    expect(abstainButton()).toBeNull();
    expect(screen.queryByText(en.withdraw_needs_drep)).toBeNull();
    expect(port.signAndSubmit).toHaveBeenCalledTimes(1);
  });

  it("a stored record past its watch limit is dropped and said once; Abstain is offered again", async () => {
    m.getStakeAccountState.mockResolvedValue(account(REWARDS, null));
    const sentAt = Date.now() - VOTE_DELEGATION_WATCH_LIMIT_MS - 1000;
    window.localStorage.setItem(
      storageKey(),
      JSON.stringify({ account: ACCOUNT, network: NETWORK, sentAt, txHash: HASH64, drepBefore: null }),
    );
    render(wrap(<WalletTabs port={makePort()} changeAddress={CHANGE_HEX} network={NETWORK} />));
    fireEvent.click(stakingTab());
    expect(
      await screen.findByText(en.vote_delegation_expired.replace("{{time}}", clockTime(sentAt, Date.now()))),
    ).toBeTruthy();
    expect(abstainButton()).toBeTruthy();
    expect(window.localStorage.getItem(storageKey())).toBeNull();
  });

  it("a malformed stored value is dropped, not shown: Abstain is offered, nothing waits", async () => {
    m.getStakeAccountState.mockResolvedValue(account(REWARDS, null));
    window.localStorage.setItem(storageKey(), JSON.stringify({ account: ACCOUNT, network: NETWORK }));
    render(wrap(<WalletTabs port={makePort()} changeAddress={CHANGE_HEX} network={NETWORK} />));
    fireEvent.click(stakingTab());
    expect(await screen.findByRole("button", { name: en.withdraw_abstain_button })).toBeTruthy();
    expect(screen.queryByText(en.vote_delegation_pending)).toBeNull();
    expect(window.localStorage.getItem(storageKey())).toBeNull();
  });
});

/**
 * Round 4. The record ends only when the chain shows the choice that was SENT:
 * `/tx_status` and `/account_info` can be answered by Koios instances that lag
 * each other, so a transaction already seen can still meet an account read
 * that shows the DRep held before — non-null, and not the new one.
 */
describe("FIX-R4: a found hash ends the record only when the account shows the sent target", () => {
  const OLD_DREP = "drep1olddrepidentifier000wxyz";
  const storageKey = () => voteDelegationKey(NETWORK, accountKeyFrom(CHANGE_HEX));

  it("X → Y: seen by hash while the account still reads X ⇒ still waiting; reads Y ⇒ cleared", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    m.getStakeAccountState.mockResolvedValue(account(REWARDS, OLD_DREP));
    m.getVoteDelegationState.mockResolvedValue({ found: true, status: "registered", delegatedDRep: OLD_DREP });
    const port = makePort();
    port.signAndSubmit.mockResolvedValue("CD".repeat(32)); // a CIP-30 wallet answering in capitals
    render(wrap(<WalletTabs port={port} changeAddress={CHANGE_HEX} network={NETWORK} />));

    fireEvent.click(governanceTab());
    await waitFor(() => expect(port.getDrepKeyHashHex).toHaveBeenCalled());
    await waitFor(() => expect(m.getVoteDelegationState).toHaveBeenCalled());
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: en.gov_search }));
    const row = (await screen.findByText(DREP)).parentElement!;
    fireEvent.click(within(row).getByRole("button", { name: en.gov_delegate }));
    fireEvent.click(await screen.findByLabelText(en.gov_verify_checkbox));
    const confirm = screen.getByRole("button", { name: en.gov_confirm }) as HTMLButtonElement;
    await waitFor(() => expect(confirm.disabled).toBe(false));
    fireEvent.click(confirm);
    expect(await screen.findByText(en.gov_delegate_pending)).toBeTruthy();
    // Kept lower-case, with the target it must be confirmed by.
    const stored = JSON.parse(window.localStorage.getItem(storageKey())!);
    expect(stored).toMatchObject({ txHash: "cd".repeat(32), drepBefore: OLD_DREP, target: DREP });

    m.fetchTxSeen.mockResolvedValue(true);
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        vi.advanceTimersByTime(20_000);
      });
    }
    expect(m.fetchTxSeen).toHaveBeenCalledWith(NETWORK, "cd".repeat(32));
    // The account still reads X: not the choice sent. The record stays.
    expect(screen.getByText(en.gov_delegate_pending)).toBeTruthy();
    expect(window.localStorage.getItem(storageKey())).not.toBeNull();

    m.getVoteDelegationState.mockResolvedValue({ found: true, status: "registered", delegatedDRep: DREP });
    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });
    await waitFor(() => expect(screen.queryByText(en.gov_delegate_pending)).toBeNull());
  });

  /** A record already ten minutes old, on disk, as a reopened tab finds it. */
  function storeOldRecord(drep: string) {
    const sentAt = Date.now() - DELEGATION_UNSEEN_MS - 60_000;
    window.localStorage.setItem(
      storageKey(),
      JSON.stringify({
        account: ACCOUNT,
        network: NETWORK,
        sentAt,
        txHash: "ef".repeat(32),
        drepBefore: drep,
        target: drep,
      }),
    );
  }

  it("a tab opened past ten minutes looks the hash up at once: landed ⇒ no 'not seen' line, record gone", async () => {
    // Only the interval is faked and never advanced: whatever happens, happens
    // before the first 20 s tick.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    m.getStakeAccountState.mockResolvedValue(account(REWARDS, DREP));
    m.getVoteDelegationState.mockResolvedValue({ found: true, status: "registered", delegatedDRep: DREP });
    m.fetchTxSeen.mockResolvedValue(true);
    storeOldRecord(DREP); // X → X: only the hash can tell
    render(wrap(<WalletTabs port={makePort()} changeAddress={CHANGE_HEX} network={NETWORK} />));
    fireEvent.click(governanceTab());
    expect(screen.queryByText(startsLike("vote_delegation_unseen"))).toBeNull();
    await waitFor(() => expect(m.fetchTxSeen).toHaveBeenCalledWith(NETWORK, "ef".repeat(32)));
    // Let the look-up and its account re-read answer (promises only, no tick).
    for (let i = 0; i < 5; i++) await act(async () => {});
    expect(window.localStorage.getItem(storageKey())).toBeNull();
    expect(screen.queryByText(startsLike("vote_delegation_unseen"))).toBeNull();
    expect(screen.queryByText(en.gov_delegate_pending)).toBeNull();
  });

  it("control: not in a block ⇒ the 'not seen' line comes up once the look-up has answered", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    m.getStakeAccountState.mockResolvedValue(account(REWARDS, DREP));
    m.getVoteDelegationState.mockResolvedValue({ found: true, status: "registered", delegatedDRep: DREP });
    m.fetchTxSeen.mockResolvedValue(false);
    storeOldRecord(DREP);
    render(wrap(<WalletTabs port={makePort()} changeAddress={CHANGE_HEX} network={NETWORK} />));
    fireEvent.click(governanceTab());
    expect(await screen.findByText(startsLike("vote_delegation_unseen"))).toBeTruthy();
    expect(m.fetchTxSeen).toHaveBeenCalledTimes(1);
  });

  it("Staking tab: the same first look-up, before any tick", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    m.getStakeAccountState.mockResolvedValue(account(REWARDS, null));
    m.fetchTxSeen.mockResolvedValue(false);
    storeOldRecord("drep_always_abstain");
    render(wrap(<WalletTabs port={makePort()} changeAddress={CHANGE_HEX} network={NETWORK} />));
    fireEvent.click(stakingTab());
    expect(await screen.findByText(startsLike("vote_delegation_unseen"))).toBeTruthy();
    expect(m.fetchTxSeen).toHaveBeenCalledWith(NETWORK, "ef".repeat(32));
  });
});

/**
 * Round 4: the same wallet in a second browser tab. A vote delegation sent
 * there is written to `localStorage`; this tab hears it through the `storage`
 * event, as it already does for the unresolved-submit lock.
 */
describe("FIX-R4: a vote delegation sent in another browser tab", () => {
  const storageKey = () => voteDelegationKey(NETWORK, accountKeyFrom(CHANGE_HEX));
  const fire = (key: string | null, newValue: string | null) =>
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key, newValue }));
    });

  it("a record written there hides the Abstain offer here; its removal there brings the offer back", async () => {
    m.getStakeAccountState.mockResolvedValue(account(REWARDS, null));
    render(wrap(<WalletTabs port={makePort()} changeAddress={CHANGE_HEX} network={NETWORK} />));
    fireEvent.click(stakingTab());
    expect(await screen.findByRole("button", { name: en.withdraw_abstain_button })).toBeTruthy();

    // Another account's key, or another network's: not ours.
    const record = JSON.stringify({
      account: ACCOUNT,
      network: NETWORK,
      sentAt: Date.now(),
      txHash: "ab".repeat(32),
      drepBefore: null,
      target: "drep_always_abstain",
    });
    await fire(voteDelegationKey(2, accountKeyFrom(CHANGE_HEX)), record);
    expect(abstainButton()).toBeTruthy();

    window.localStorage.setItem(storageKey(), record);
    await fire(storageKey(), record);
    expect(await screen.findByText(en.vote_delegation_pending)).toBeTruthy();
    expect(abstainButton()).toBeNull();

    // A wholesale clear is housekeeping, not word that it landed: the copy
    // held here stays.
    window.localStorage.clear();
    await fire(null, null);
    expect(screen.getByText(en.vote_delegation_pending)).toBeTruthy();
    expect(abstainButton()).toBeNull();

    // The record removed there (landed, or ran out): gone here too.
    await fire(storageKey(), null);
    expect(await screen.findByRole("button", { name: en.withdraw_abstain_button })).toBeTruthy();
    expect(screen.queryByText(en.vote_delegation_pending)).toBeNull();
  });
});

describe("A reward withdrawal just sent survives a tab switch", () => {
  // The Staking panel unmounts while another tab is open. A "just withdrew"
  // flag kept inside it would be gone on return, and the old balance the
  // indexer still reports would put the withdraw button back.
  it("keeps the waiting line, and no withdraw button, after History and back", async () => {
    m.getStakeAccountState.mockResolvedValue(account(REWARDS, "drep_always_abstain"));
    const port = makePort();
    render(wrap(<WalletTabs port={port} changeAddress={CHANGE_HEX} network={NETWORK} />));

    fireEvent.click(stakingTab());
    fireEvent.click(await screen.findByRole("button", { name: en.withdraw_rewards }));
    await screen.findByLabelText(en.withdraw_verify_checkbox);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: en.confirm_withdraw }));
    expect(await screen.findByText(en.withdraw_sent_waiting)).toBeTruthy();
    expect(port.signAndSubmit).toHaveBeenCalledTimes(1);

    fireEvent.click(historyTab());
    await screen.findByText("history-stub");
    fireEvent.click(stakingTab());

    // The fresh mount reads the account again: still the old balance.
    expect(await screen.findByText(en.withdraw_sent_waiting)).toBeTruthy();
    await waitFor(() => expect(m.getStakeAccountState.mock.calls.length).toBeGreaterThanOrEqual(3));
    expect(screen.queryByRole("button", { name: en.withdraw_rewards })).toBeNull();
  });
});

describe("A released withdrawal record is let go, not just looked past", () => {
  // Rewards keep arriving: a later epoch can report a balance at least as
  // large as the one withdrawn. A record still held above the tabs would read
  // that as "the old balance, not landed yet" and hide the button again.
  it("after the balance dropped, a later read with new rewards shows the button", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    m.getStakeAccountState.mockResolvedValue(account(REWARDS, "drep_always_abstain"));
    const port = makePort();
    render(wrap(<WalletTabs port={port} changeAddress={CHANGE_HEX} network={NETWORK} />));

    fireEvent.click(stakingTab());
    fireEvent.click(await screen.findByRole("button", { name: en.withdraw_rewards }));
    await screen.findByLabelText(en.withdraw_verify_checkbox);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: en.confirm_withdraw }));
    await screen.findByText(en.withdraw_sent_waiting);

    // It lands: the re-read shows the balance gone.
    m.getStakeAccountState.mockResolvedValue(account(BigInt(0), "drep_always_abstain"));
    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });
    expect(await screen.findByText(en.withdraw_no_rewards)).toBeTruthy();

    // Next epoch's rewards: another amount than the one withdrawn. (Exactly
    // the amount withdrawn reads as a lagging indexer instance and is held —
    // the test below.)
    m.getStakeAccountState.mockResolvedValue(account(REWARDS + BigInt(1_234_567), "drep_always_abstain"));
    fireEvent.click(historyTab());
    await screen.findByText("history-stub");
    fireEvent.click(stakingTab());
    await waitFor(() =>
      expect((screen.queryByRole("button", { name: en.withdraw_rewards }) as HTMLButtonElement | null)?.disabled).toBe(false),
    );
    expect(screen.queryByText(en.withdraw_sent_waiting)).toBeNull();
  });

  it("after the balance dropped, a lagging read of exactly the amount withdrawn holds the door again", async () => {
    // Review of #57: the record used to be dropped once a read showed the
    // balance gone, so a later read from an indexer instance that had not
    // caught up — the old balance, to the lovelace — lit the door again and
    // offered the same withdrawal a second time.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    m.getStakeAccountState.mockResolvedValue(account(REWARDS, "drep_always_abstain"));
    const port = makePort();
    render(wrap(<WalletTabs port={port} changeAddress={CHANGE_HEX} network={NETWORK} />));

    fireEvent.click(stakingTab());
    fireEvent.click(await screen.findByRole("button", { name: en.withdraw_rewards }));
    await screen.findByLabelText(en.withdraw_verify_checkbox);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: en.confirm_withdraw }));
    await screen.findByText(en.withdraw_sent_waiting);

    m.getStakeAccountState.mockResolvedValue(account(BigInt(0), "drep_always_abstain"));
    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });
    expect(await screen.findByText(en.withdraw_no_rewards)).toBeTruthy();

    // A lagging instance answers the next read with the balance withdrawn.
    m.getStakeAccountState.mockResolvedValue(account(REWARDS, "drep_always_abstain"));
    fireEvent.click(historyTab());
    await screen.findByText("history-stub");
    fireEvent.click(stakingTab());
    expect(await screen.findByText(en.withdraw_sent_waiting)).toBeTruthy();
    await act(async () => {});
    expect(screen.queryByRole("button", { name: en.withdraw_rewards })).toBeNull();
    expect(port.signAndSubmit).toHaveBeenCalledTimes(1);
  });
});

/**
 * Issue #58. The account read answers in one request; the look-up by hash
 * takes two in a row. A read that already shows the sent choice turned the
 * waiting off and cancelled the look-up before it finished, so the record
 * stayed on disk for its whole two-hour watch and the waiting line flashed up
 * each time a tab opened. And an Abstain review left open while another
 * browser tab sent a choice could still be signed over it.
 */
describe("#58: the in-flight vote delegation, ended by a read, guarded against another tab", () => {
  const storageKey = () => voteDelegationKey(NETWORK, accountKeyFrom(CHANGE_HEX));
  const fire = (key: string | null, newValue: string | null) =>
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key, newValue }));
    });
  const OLD_DREP = "drep1olddrepidentifier000wxyz";
  const stored = (over: Record<string, unknown>) =>
    JSON.stringify({
      account: ACCOUNT,
      network: NETWORK,
      sentAt: Date.now(),
      txHash: "cd".repeat(32),
      drepBefore: null,
      target: "drep_always_abstain",
      ...over,
    });

  it("Staking: an account read that shows the sent choice drops the stored record, with no hash hit", async () => {
    m.getStakeAccountState.mockResolvedValue(account(REWARDS, "drep_always_abstain"));
    // Sent a second ago: only a read started after the send speaks for it.
    window.localStorage.setItem(storageKey(), stored({ sentAt: Date.now() - 1_000 }));
    render(wrap(<WalletTabs port={makePort()} changeAddress={CHANGE_HEX} network={NETWORK} />));
    fireEvent.click(stakingTab());
    // `fetchTxSeen` answers "not in a block" (beforeEach): only the read can end it.
    await waitFor(() => expect(window.localStorage.getItem(storageKey())).toBeNull());
  });

  it("Staking: a read still showing the DRep held before keeps the record", async () => {
    m.getStakeAccountState.mockResolvedValue(account(REWARDS, OLD_DREP));
    window.localStorage.setItem(storageKey(), stored({ drepBefore: OLD_DREP, target: DREP }));
    render(wrap(<WalletTabs port={makePort()} changeAddress={CHANGE_HEX} network={NETWORK} />));
    fireEvent.click(stakingTab());
    // The read has landed: rewards and a DRep on it arm the withdraw button.
    await screen.findByRole("button", { name: en.withdraw_rewards });
    await act(async () => {});
    expect(window.localStorage.getItem(storageKey())).not.toBeNull();
  });

  it("Governance: a DRep read that shows the sent choice drops the stored record, with no hash hit", async () => {
    m.getStakeAccountState.mockResolvedValue(account(REWARDS, OLD_DREP));
    m.getVoteDelegationState.mockResolvedValue({ found: true, status: "registered", delegatedDRep: DREP });
    window.localStorage.setItem(
      storageKey(),
      stored({ sentAt: Date.now() - 1_000, drepBefore: OLD_DREP, target: DREP }),
    );
    render(wrap(<WalletTabs port={makePort()} changeAddress={CHANGE_HEX} network={NETWORK} />));
    fireEvent.click(governanceTab());
    await waitFor(() => expect(window.localStorage.getItem(storageKey())).toBeNull());
  });

  it("an open Abstain review is refused, not signed, once a choice sent in another tab arrives", async () => {
    m.getStakeAccountState.mockResolvedValue(account(REWARDS, null));
    const port = makePort();
    render(wrap(<WalletTabs port={port} changeAddress={CHANGE_HEX} network={NETWORK} />));
    fireEvent.click(stakingTab());
    fireEvent.click(await screen.findByRole("button", { name: en.withdraw_abstain_button }));
    await screen.findByText(en.withdraw_abstain_review_title);

    // Tab B delegates to a real DRep while this review is open.
    const record = stored({ target: DREP });
    window.localStorage.setItem(storageKey(), record);
    await fire(storageKey(), record);

    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: en.withdraw_abstain_confirm }));
    await waitFor(() => expect(m.toastError).toHaveBeenCalledWith(en.vote_delegation_inflight_blocked));
    expect(port.signAndSubmit).not.toHaveBeenCalled();
    expect(screen.queryByText(en.withdraw_abstain_review_title)).toBeNull();
  });
});

/**
 * A read only speaks for a record sent before the read began. The record is
 * shared with other browser tabs, and a tab whose account already shows a DRep
 * stops re-reading — so the read it holds can be from when it opened. Here:
 * this tab reads X; another tab moves X → Y (landed), then sends X again. The
 * record {drepBefore: Y, target: X} arrives here, and the old read of X must
 * not end it while X is not on chain.
 */
describe("#62: an account read older than the record does not end it", () => {
  const storageKey = () => voteDelegationKey(NETWORK, accountKeyFrom(CHANGE_HEX));
  const fire = (key: string | null, newValue: string | null) =>
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key, newValue }));
    });
  const OLD_DREP = "drep1olddrepidentifier000wxyz";
  const drepState = (delegatedDRep: string | null) => ({ found: true, status: "registered", delegatedDRep });

  /**
   * Writes a record "sent" one minute after `t0` by another tab, then moves
   * the clock one more second, so a read started from here on is strictly
   * after the send and the read held from `t0` strictly before it.
   */
  function arriveFromOtherTab(t0: number, over: Record<string, unknown>) {
    vi.setSystemTime(t0 + 60_000);
    const record = JSON.stringify({
      account: ACCOUNT,
      network: NETWORK,
      sentAt: Date.now(),
      txHash: "cd".repeat(32),
      ...over,
    });
    vi.setSystemTime(t0 + 61_000);
    window.localStorage.setItem(storageKey(), record);
    return fire(storageKey(), record);
  }

  it("Staking: the read of X from when the tab opened keeps a record for X sent after it; the warning stays", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    m.getStakeAccountState.mockResolvedValue(account(REWARDS, DREP));
    m.getVoteDelegationState.mockResolvedValue(drepState(OLD_DREP));
    render(wrap(<WalletTabs port={makePort()} changeAddress={CHANGE_HEX} network={NETWORK} />));
    fireEvent.click(stakingTab());
    await screen.findByRole("button", { name: en.withdraw_rewards });
    const readsAtOpen = m.getStakeAccountState.mock.calls.length;

    // The other tab: X → Y has landed, and X is sent again (not on chain yet).
    m.getStakeAccountState.mockResolvedValue(account(REWARDS, OLD_DREP));
    await arriveFromOtherTab(t0, { drepBefore: OLD_DREP, target: DREP });
    expect(window.localStorage.getItem(storageKey())).not.toBeNull();

    // One fresh read, which shows Y: still not landed.
    await waitFor(() => expect(m.getStakeAccountState.mock.calls.length).toBe(readsAtOpen + 1));
    await act(async () => {});
    expect(window.localStorage.getItem(storageKey())).not.toBeNull();

    // The Governance tab still says a choice is in flight, and warns before a second one.
    fireEvent.click(governanceTab());
    expect(await screen.findByText(en.gov_delegate_pending)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: en.gov_search }));
    const row = (await screen.findByText(DREP)).parentElement!;
    fireEvent.click(within(row).getByRole("button", { name: en.gov_delegate }));
    expect(await screen.findByText(startsLike("gov_delegate_inflight_warn"))).toBeTruthy();
  });

  it("Staking: an older-format record (no target) is not ended by the old read either", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    m.getStakeAccountState.mockResolvedValue(account(REWARDS, DREP));
    render(wrap(<WalletTabs port={makePort()} changeAddress={CHANGE_HEX} network={NETWORK} />));
    fireEvent.click(stakingTab());
    await screen.findByRole("button", { name: en.withdraw_rewards });
    const readsAtOpen = m.getStakeAccountState.mock.calls.length;

    m.getStakeAccountState.mockResolvedValue(account(REWARDS, OLD_DREP));
    await arriveFromOtherTab(t0, { drepBefore: OLD_DREP });
    expect(window.localStorage.getItem(storageKey())).not.toBeNull();
    await waitFor(() => expect(m.getStakeAccountState.mock.calls.length).toBe(readsAtOpen + 1));
    await act(async () => {});
    expect(window.localStorage.getItem(storageKey())).not.toBeNull();
  });

  it("Governance: the DRep read of X from when the tab opened keeps a record for X sent after it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    m.getStakeAccountState.mockResolvedValue(account(REWARDS, DREP));
    m.getVoteDelegationState.mockResolvedValue(drepState(DREP));
    render(wrap(<WalletTabs port={makePort()} changeAddress={CHANGE_HEX} network={NETWORK} />));
    fireEvent.click(governanceTab());
    await waitFor(() => expect(m.getVoteDelegationState).toHaveBeenCalled());
    await act(async () => {});
    const readsAtOpen = m.getVoteDelegationState.mock.calls.length;

    m.getVoteDelegationState.mockResolvedValue(drepState(OLD_DREP));
    await arriveFromOtherTab(t0, { drepBefore: OLD_DREP, target: DREP });
    expect(window.localStorage.getItem(storageKey())).not.toBeNull();
    expect(screen.getByText(en.gov_delegate_pending)).toBeTruthy();

    await waitFor(() => expect(m.getVoteDelegationState.mock.calls.length).toBeGreaterThan(readsAtOpen));
    await act(async () => {});
    expect(window.localStorage.getItem(storageKey())).not.toBeNull();
    expect(screen.getByText(en.gov_delegate_pending)).toBeTruthy();
  });

  it("Staking: a record newer than the read that has really landed still ends, after one fresh read", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    m.getStakeAccountState.mockResolvedValue(account(REWARDS, DREP));
    render(wrap(<WalletTabs port={makePort()} changeAddress={CHANGE_HEX} network={NETWORK} />));
    fireEvent.click(stakingTab());
    await screen.findByRole("button", { name: en.withdraw_rewards });
    const readsAtOpen = m.getStakeAccountState.mock.calls.length;

    // The chain shows X: the record for X has landed. Only a fresh read may say so.
    await arriveFromOtherTab(t0, { drepBefore: OLD_DREP, target: DREP });
    await waitFor(() => expect(window.localStorage.getItem(storageKey())).toBeNull());
    expect(m.getStakeAccountState.mock.calls.length).toBe(readsAtOpen + 1);
    // `fetchTxSeen` answers "not in a block" (beforeEach): the read ended it.
    expect(m.fetchTxSeen).not.toHaveBeenCalled();
  });

  it("Governance: a record newer than the read that has really landed still ends, after one fresh read", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    m.getStakeAccountState.mockResolvedValue(account(REWARDS, DREP));
    m.getVoteDelegationState.mockResolvedValue(drepState(DREP));
    render(wrap(<WalletTabs port={makePort()} changeAddress={CHANGE_HEX} network={NETWORK} />));
    fireEvent.click(governanceTab());
    await waitFor(() => expect(m.getVoteDelegationState).toHaveBeenCalled());
    await act(async () => {});
    const readsAtOpen = m.getVoteDelegationState.mock.calls.length;

    await arriveFromOtherTab(t0, { drepBefore: OLD_DREP, target: DREP });
    await waitFor(() => expect(window.localStorage.getItem(storageKey())).toBeNull());
    expect(m.getVoteDelegationState.mock.calls.length).toBeGreaterThan(readsAtOpen);
    await waitFor(() => expect(screen.queryByText(en.gov_delegate_pending)).toBeNull());
  });

  it("Governance: a choice that arrived during the review but can no longer land does not block signing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    m.getStakeAccountState.mockResolvedValue(account(REWARDS, null));
    const port = makePort();
    render(wrap(<WalletTabs port={port} changeAddress={CHANGE_HEX} network={NETWORK} />));
    fireEvent.click(governanceTab());
    await waitFor(() => expect(m.getVoteDelegationState).toHaveBeenCalled());
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: en.gov_search }));
    const row = (await screen.findByText(DREP)).parentElement!;
    fireEvent.click(within(row).getByRole("button", { name: en.gov_delegate }));
    fireEvent.click(await screen.findByLabelText(en.gov_verify_checkbox));

    // An Abstain from another tab arrives while the review is open, and then
    // its validity window closes (a sleeping laptop: the drop timer has not
    // fired yet, so the record is still held).
    await arriveFromOtherTab(t0, { drepBefore: null, target: "drep_always_abstain" });
    vi.setSystemTime(t0 + 60_000 + VOTE_DELEGATION_WATCH_LIMIT_MS + 1_000);

    const confirm = screen.getByRole("button", { name: en.gov_confirm }) as HTMLButtonElement;
    await waitFor(() => expect(confirm.disabled).toBe(false));
    fireEvent.click(confirm);
    await waitFor(() => expect(port.signAndSubmit).toHaveBeenCalledTimes(1));
    expect(m.toastError).not.toHaveBeenCalledWith(en.gov_delegate_inflight_arrived);
  });

  it("#66 Staking: a failed fresh read is said and tried again until it answers; the record then ends", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const t0 = Date.now();
    m.getStakeAccountState.mockResolvedValue(account(REWARDS, DREP));
    render(wrap(<WalletTabs port={makePort()} changeAddress={CHANGE_HEX} network={NETWORK} />));
    fireEvent.click(stakingTab());
    await screen.findByRole("button", { name: en.withdraw_rewards });
    const readsAtOpen = m.getStakeAccountState.mock.calls.length;

    // The record for X has landed, but the one fresh read fails.
    m.getStakeAccountState.mockRejectedValue(new Error("koios down"));
    await arriveFromOtherTab(t0, { drepBefore: OLD_DREP, target: DREP });
    expect(await screen.findByText(en.stake_reread_failed)).toBeTruthy();
    expect(m.getStakeAccountState.mock.calls.length).toBe(readsAtOpen + 1);
    expect(window.localStorage.getItem(storageKey())).not.toBeNull();

    // The indexer is back: the next tick reads again, and that read ends it.
    m.getStakeAccountState.mockResolvedValue(account(REWARDS, DREP));
    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });
    await waitFor(() => expect(window.localStorage.getItem(storageKey())).toBeNull());
    expect(m.getStakeAccountState.mock.calls.length).toBe(readsAtOpen + 2);
    expect(screen.queryByText(en.stake_reread_failed)).toBeNull();
    expect(m.fetchTxSeen).not.toHaveBeenCalled();
  });

  it("#66 Staking: a send-back record is not ended by a fresh read showing its target", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    m.getStakeAccountState.mockResolvedValue(account(REWARDS, DREP));
    render(wrap(<WalletTabs port={makePort()} changeAddress={CHANGE_HEX} network={NETWORK} />));
    fireEvent.click(stakingTab());
    await screen.findByRole("button", { name: en.withdraw_rewards });
    const readsAtOpen = m.getStakeAccountState.mock.calls.length;

    // X → Y landed, X sent back; the read comes from an instance still at X.
    await arriveFromOtherTab(t0, { drepBefore: OLD_DREP, target: DREP, resend: true });
    await act(async () => {});
    expect(window.localStorage.getItem(storageKey())).not.toBeNull();
    // No fresh read either: none of them could end it.
    expect(m.getStakeAccountState.mock.calls.length).toBe(readsAtOpen);
  });

  it("Staking: the 're-read failed' line goes with the waiting it was about", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    m.getStakeAccountState.mockResolvedValue(account(REWARDS, null));
    render(wrap(<WalletTabs port={makePort()} changeAddress={CHANGE_HEX} network={NETWORK} />));
    fireEvent.click(stakingTab());
    expect(await screen.findByRole("button", { name: en.withdraw_abstain_button })).toBeTruthy();

    const record = JSON.stringify({
      account: ACCOUNT,
      network: NETWORK,
      sentAt: Date.now(),
      txHash: "ab".repeat(32),
      drepBefore: null,
      target: "drep_always_abstain",
    });
    window.localStorage.setItem(storageKey(), record);
    await fire(storageKey(), record);
    expect(await screen.findByText(en.vote_delegation_pending)).toBeTruthy();

    m.getStakeAccountState.mockRejectedValue(new Error("koios down"));
    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });
    expect(await screen.findByText(en.stake_reread_failed)).toBeTruthy();

    // Removed there (landed): nothing is waiting here, so nothing to be stale about.
    window.localStorage.removeItem(storageKey());
    await fire(storageKey(), null);
    expect(await screen.findByRole("button", { name: en.withdraw_abstain_button })).toBeTruthy();
    expect(screen.queryByText(en.stake_reread_failed)).toBeNull();
  });
});

/**
 * #66. X → Y has landed and X is sent back inside an indexer's lag: a read
 * started after that send can come from an instance that has not applied
 * X → Y and still shows X — the same answer as X having landed. The wallet
 * remembers the choice a landed record moved the account away from, marks a
 * record that sends it back, and only the hash look-up ends that record.
 */
describe("#66: a choice sent back inside the lag is ended only by its hash", () => {
  const storageKey = () => voteDelegationKey(NETWORK, accountKeyFrom(CHANGE_HEX));
  const OLD_DREP = "drep1olddrepidentifier000wxyz";
  const drepState = (delegatedDRep: string | null) => ({ found: true, status: "registered", delegatedDRep });

  async function delegateToDrep(port: ReturnType<typeof makePort>) {
    await waitFor(() => expect(port.getDrepKeyHashHex).toHaveBeenCalled());
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: en.gov_search }));
    const row = (await screen.findByText(DREP)).parentElement!;
    fireEvent.click(within(row).getByRole("button", { name: en.gov_delegate }));
    fireEvent.click(await screen.findByLabelText(en.gov_verify_checkbox));
    const confirm = screen.getByRole("button", { name: en.gov_confirm }) as HTMLButtonElement;
    await waitFor(() => expect(confirm.disabled).toBe(false));
    fireEvent.click(confirm);
    expect(await screen.findByText(en.gov_delegate_pending)).toBeTruthy();
  }

  const tick = () =>
    act(async () => {
      vi.advanceTimersByTime(20_000);
    });

  it("Governance: X → Y landed, X sent again; a lagging read of X keeps the record; the hash ends it", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    m.getStakeAccountState.mockResolvedValue(account(REWARDS, OLD_DREP));
    m.getVoteDelegationState.mockResolvedValue(drepState(OLD_DREP));
    // X → Y, sent by this wallet a second ago: the read shows Y, so it landed.
    window.localStorage.setItem(
      storageKey(),
      JSON.stringify({
        account: ACCOUNT,
        network: NETWORK,
        sentAt: Date.now() - 1_000,
        txHash: "ab".repeat(32),
        drepBefore: DREP,
        target: OLD_DREP,
      }),
    );
    const port = makePort();
    port.signAndSubmit.mockResolvedValue("cd".repeat(32));
    render(wrap(<WalletTabs port={port} changeAddress={CHANGE_HEX} network={NETWORK} />));
    fireEvent.click(governanceTab());
    await waitFor(() => expect(window.localStorage.getItem(storageKey())).toBeNull());

    // X again, while the account reads Y.
    await delegateToDrep(port);
    expect(JSON.parse(window.localStorage.getItem(storageKey())!)).toMatchObject({
      txHash: "cd".repeat(32),
      drepBefore: OLD_DREP,
      target: DREP,
      resend: true,
    });

    // An instance that has not applied X → Y answers X; the hash is not in a block.
    m.getVoteDelegationState.mockResolvedValue(drepState(DREP));
    const readsBefore = m.getVoteDelegationState.mock.calls.length;
    await tick();
    await tick();
    expect(m.getVoteDelegationState.mock.calls.length).toBeGreaterThan(readsBefore);
    expect(window.localStorage.getItem(storageKey())).not.toBeNull();
    expect(screen.getByText(en.gov_delegate_pending)).toBeTruthy();

    // The transaction is found in a block and the read shows X: it ends.
    m.fetchTxSeen.mockResolvedValue(true);
    await tick();
    await waitFor(() => expect(window.localStorage.getItem(storageKey())).toBeNull());
  });

  it("control: the same send with no move remembered is ended by the read showing X", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    m.getStakeAccountState.mockResolvedValue(account(REWARDS, OLD_DREP));
    m.getVoteDelegationState.mockResolvedValue(drepState(OLD_DREP));
    const port = makePort();
    port.signAndSubmit.mockResolvedValue("cd".repeat(32));
    render(wrap(<WalletTabs port={port} changeAddress={CHANGE_HEX} network={NETWORK} />));
    fireEvent.click(governanceTab());
    await waitFor(() => expect(m.getVoteDelegationState).toHaveBeenCalled());

    await delegateToDrep(port);
    const stored = JSON.parse(window.localStorage.getItem(storageKey())!);
    expect(stored).toMatchObject({ drepBefore: OLD_DREP, target: DREP });
    expect("resend" in stored).toBe(false);

    m.getVoteDelegationState.mockResolvedValue(drepState(DREP));
    await tick();
    // `fetchTxSeen` answers "not in a block" (beforeEach): the read ended it.
    await waitFor(() => expect(window.localStorage.getItem(storageKey())).toBeNull());
  });
});
