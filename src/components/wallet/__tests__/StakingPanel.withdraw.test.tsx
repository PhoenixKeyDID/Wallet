// @vitest-environment happy-dom
/**
 * The withdraw door on the Staking tab.
 *
 * Since the Conway hard fork the node refuses a reward withdrawal from a
 * key-based account that has no vote delegation (no DRep, not even Abstain).
 * Before this screen read that, the button built and offered a transaction the
 * chain could only reject; and with zero rewards the button was not drawn at
 * all, so a new user could not find the feature. These tests pin the three
 * states and the one-step Abstain that unlocks the door.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, fireEvent, screen, waitFor, act } from "@testing-library/react";
import i18next, { type i18n as I18n } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { type ReactNode, useState } from "react";
import en from "../../../../locales/en/wallet.json";
import type { PhoenixNetwork, WalletPort } from "@/lib/cardano";
import {
  DELEGATION_UNSEEN_MS,
  VOTE_DELEGATION_WATCH_LIMIT_MS,
  clockTime,
  type SentVoteDelegation,
} from "../delegationFeedback";

const ACCOUNT = "stake_test1uqtestaccount";
const NETWORK = 0 as const;
const CHANGE_HEX = "60" + "11".repeat(28);
const REWARDS = BigInt(5_000_000);
const TX_HASH = "abcdef0123456789abcdef";

const m = vi.hoisted(() => ({
  getStakeAccountState: vi.fn(),
  buildWithdrawal: vi.fn(),
  buildVoteDelegation: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  fetchTxSeen: vi.fn(),
}));

vi.mock("@/lib/cardano/staking", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    getStakeAccountState: m.getStakeAccountState,
    buildWithdrawal: m.buildWithdrawal,
    rewardAddressFromHex: () => ({ getBech32: () => ACCOUNT, stakeCredential: {} }),
  };
});
vi.mock("@/lib/cardano/governance", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, buildVoteDelegation: m.buildVoteDelegation };
});
vi.mock("@/lib/cardano", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    fetchProtocolParams: async () => ({}),
    fetchTipSlot: async () => 1000,
    fetchTxSeen: m.fetchTxSeen,
  };
});
vi.mock("@/lib/toast", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, toastSuccess: m.toastSuccess, toastError: m.toastError, toastApiError: vi.fn() };
});

import { StakingPanel } from "../StakingPanel";

const ABSTAIN_TX = { fee: "180000", tag: "abstain-tx" };
const WITHDRAW_TX = { fee: "190000", tag: "withdraw-tx" };

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
  m.buildWithdrawal.mockReset();
  m.buildWithdrawal.mockReturnValue(WITHDRAW_TX);
  m.buildVoteDelegation.mockReset();
  m.buildVoteDelegation.mockReturnValue(ABSTAIN_TX);
  m.toastSuccess.mockReset();
  m.toastError.mockReset();
  m.fetchTxSeen.mockReset();
  m.fetchTxSeen.mockResolvedValue(false);
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
    signAndSubmit: vi.fn(async () => "abcdef0123456789abcdef"),
  } as unknown as WalletPort & { signAndSubmit: ReturnType<typeof vi.fn> };
}

const wrap = (ui: ReactNode) => <I18nextProvider i18n={i18n}>{ui}</I18nextProvider>;

/**
 * Holds the vote-delegation "just sent" state the way `WalletTabs` does, above
 * the panel. The Abstain flow sets it through `onVoteDelegationSent`, and it is
 * what keeps the waiting line up — the state no longer lives inside the panel,
 * so a harness that does not keep it would drop the line the moment it is sent.
 */
function Harness({
  port,
  uncertainHash,
  network = NETWORK,
}: {
  port: WalletPort;
  uncertainHash: string | null;
  network?: PhoenixNetwork;
}) {
  const [sv, setSv] = useState<SentVoteDelegation | null>(null);
  return (
    <StakingPanel
      port={port}
      network={network}
      changeAddress={CHANGE_HEX}
      uncertainHash={uncertainHash}
      onUncertain={() => {}}
      sentDelegation={null}
      onDelegationSent={() => {}}
      onDelegationSettled={() => {}}
      sentVoteDelegation={sv}
      onVoteDelegationSent={setSv}
      onVoteDelegationLanded={(h) => setSv((cur) => (cur?.txHash === h ? null : cur))}
    />
  );
}

function renderPanel(port = makePort(), uncertainHash: string | null = null) {
  render(wrap(<Harness port={port} uncertainHash={uncertainHash} />));
  return port;
}

/** A line whose text starts with the part of `key` before its `{{time}}`. */
const startsLike = (key: keyof typeof en) => {
  const head = (en[key] as string).split("{{time}}")[0]!;
  return (content: string) => content.startsWith(head);
};

const withdrawButton = () => screen.queryByRole("button", { name: en.withdraw_rewards }) as HTMLButtonElement | null;
const abstainButton = () =>
  screen.queryByRole("button", { name: en.withdraw_abstain_button }) as HTMLButtonElement | null;

describe("StakingPanel withdraw door: no rewards yet", () => {
  it("draws the button disabled, with the reason, instead of hiding it", async () => {
    m.getStakeAccountState.mockResolvedValue(account(BigInt(0), null));
    renderPanel();
    expect(await screen.findByText(en.withdraw_no_rewards)).toBeTruthy();
    expect(withdrawButton()!.disabled).toBe(true);
    // Zero rewards is not the DRep case: no Abstain offer, no rule text.
    expect(abstainButton()).toBeNull();
    expect(screen.queryByText(en.withdraw_needs_drep)).toBeNull();
  });
});

describe("StakingPanel withdraw door: rewards, vote delegation present", () => {
  it("enables withdraw and builds the full balance", async () => {
    m.getStakeAccountState.mockResolvedValue(account(REWARDS, "drep_always_abstain"));
    renderPanel();
    await waitFor(() => expect(withdrawButton()?.disabled).toBe(false));
    expect(screen.queryByText(en.withdraw_needs_drep)).toBeNull();
    fireEvent.click(withdrawButton()!);
    await screen.findByText(en.withdraw_review_title);
    expect(m.buildWithdrawal).toHaveBeenCalledTimes(1);
    expect(m.buildWithdrawal.mock.calls[0]![0]).toMatchObject({ amount: REWARDS });
  });
});

describe("StakingPanel withdraw door: rewards, no vote delegation", () => {
  it("explains the rule and offers Abstain; no withdraw button to build a doomed tx", async () => {
    m.getStakeAccountState.mockResolvedValue(account(REWARDS, null));
    renderPanel();
    expect(await screen.findByText(en.withdraw_needs_drep)).toBeTruthy();
    expect(abstainButton()).toBeTruthy();
    expect(withdrawButton()).toBeNull();
    expect(m.buildWithdrawal).not.toHaveBeenCalled();
  });

  it("Abstain → review → confirm signs a vote delegation to Abstain, then waits", async () => {
    m.getStakeAccountState.mockResolvedValue(account(REWARDS, null));
    const port = renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: en.withdraw_abstain_button }));
    await screen.findByText(en.withdraw_abstain_review_title);
    expect(m.buildVoteDelegation).toHaveBeenCalledTimes(1);
    expect(m.buildVoteDelegation.mock.calls[0]![0]).toMatchObject({ target: { kind: "abstain" }, ttl: 1000 + 7200 });

    const confirm = screen.getByRole("button", { name: en.withdraw_abstain_confirm }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true); // the checkbox comes first
    fireEvent.click(screen.getByRole("checkbox"));
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);

    expect(await screen.findByText(en.vote_delegation_pending)).toBeTruthy();
    expect(port.signAndSubmit).toHaveBeenCalledTimes(1);
    expect(port.signAndSubmit.mock.calls[0]![0]).toBe(ABSTAIN_TX);
    expect(m.toastSuccess).toHaveBeenCalledWith("withdraw_abstain_submitted", expect.anything());
    // Still locked: the chain has not recorded it yet.
    expect(withdrawButton()).toBeNull();
    expect(abstainButton()).toBeNull();
  });

  it("found by hash while the account still reads no DRep: keeps waiting, no second Abstain; clears once the DRep shows", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    m.getStakeAccountState.mockResolvedValue(account(REWARDS, null));
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: en.withdraw_abstain_button }));
    await screen.findByText(en.withdraw_abstain_review_title);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: en.withdraw_abstain_confirm }));
    await screen.findByText(en.vote_delegation_pending);
    // /tx_status has it in a block, but /account_info (another Koios instance)
    // still reads no DRep. Clearing on the hash alone brought Abstain back.
    m.fetchTxSeen.mockResolvedValue(true);
    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });
    expect(m.fetchTxSeen).toHaveBeenCalledWith(NETWORK, TX_HASH);
    const readsAfterFirstTick = m.getStakeAccountState.mock.calls.length;
    expect(readsAfterFirstTick).toBeGreaterThanOrEqual(3); // mount, tick, re-read on the hit
    expect(screen.getByText(en.vote_delegation_pending)).toBeTruthy();
    expect(abstainButton()).toBeNull();
    expect(screen.queryByText(en.withdraw_needs_drep)).toBeNull();
    // Still polling: the next tick asks again.
    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });
    expect(m.getStakeAccountState.mock.calls.length).toBeGreaterThan(readsAfterFirstTick);
    expect(screen.getByText(en.vote_delegation_pending)).toBeTruthy();
    expect(abstainButton()).toBeNull();

    // The account read catches up: the record goes, withdraw opens.
    m.getStakeAccountState.mockResolvedValue(account(REWARDS, "drep_always_abstain"));
    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });
    await waitFor(() => expect(screen.queryByText(en.vote_delegation_pending)).toBeNull());
    expect(withdrawButton()?.disabled).toBe(false);
  });

  it("re-reads the account while waiting, and opens withdraw once the chain shows the DRep", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    m.getStakeAccountState.mockResolvedValue(account(REWARDS, null));
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: en.withdraw_abstain_button }));
    await screen.findByText(en.withdraw_abstain_review_title);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: en.withdraw_abstain_confirm }));
    await screen.findByText(en.vote_delegation_pending);
    expect(m.getStakeAccountState).toHaveBeenCalledTimes(1);

    m.getStakeAccountState.mockResolvedValue(account(REWARDS, "drep_always_abstain"));
    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });
    expect(m.getStakeAccountState).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(withdrawButton()?.disabled).toBe(false));
    expect(screen.queryByText(en.vote_delegation_pending)).toBeNull();
  });

  it("a lock that arrives while the Abstain review is open still stops the signature", async () => {
    m.getStakeAccountState.mockResolvedValue(account(REWARDS, null));
    const port = makePort();
    const view = render(wrap(<Harness port={port} uncertainHash={null} />));
    fireEvent.click(await screen.findByRole("button", { name: en.withdraw_abstain_button }));
    await screen.findByText(en.withdraw_abstain_review_title);
    fireEvent.click(screen.getByRole("checkbox"));
    // Another tab's send turned uncertain while this review sat open.
    view.rerender(wrap(<Harness port={port} uncertainHash={"deadbeef".repeat(8)} />));
    fireEvent.click(screen.getByRole("button", { name: en.withdraw_abstain_confirm }));
    await waitFor(() => expect(m.toastError).toHaveBeenCalledWith(en.uncertain_blocked));
    expect(port.signAndSubmit).not.toHaveBeenCalled();
  });

  it("the Abstain button obeys the uncertain-submit lock, like every other way to sign here", async () => {
    m.getStakeAccountState.mockResolvedValue(account(REWARDS, null));
    renderPanel(makePort(), "deadbeef".repeat(8));
    await screen.findByText(en.withdraw_needs_drep);
    expect(abstainButton()!.disabled).toBe(true);
  });
});

/** The panel with a vote delegation already in flight, as the parent hands it down. */
function renderWithSentVote(sent: SentVoteDelegation) {
  render(
    wrap(
      <StakingPanel
        port={makePort()}
        network={NETWORK}
        changeAddress={CHANGE_HEX}
        uncertainHash={null}
        onUncertain={() => {}}
        sentDelegation={null}
        onDelegationSent={() => {}}
        onDelegationSettled={() => {}}
        sentVoteDelegation={sent}
        onVoteDelegationSent={() => {}}
        onVoteDelegationLanded={() => {}}
      />,
    ),
  );
}

describe("StakingPanel: a vote delegation in flight, over time and through a failed read", () => {
  it("keeps the waiting line when the account read fails", async () => {
    m.getStakeAccountState.mockRejectedValue(new Error("koios down"));
    renderWithSentVote({ account: ACCOUNT, network: NETWORK, sentAt: Date.now(), txHash: TX_HASH, drepBefore: null });
    expect(await screen.findByText(en.stake_read_failed)).toBeTruthy();
    // Outside the error branch: a failed read must not hide that one is in flight.
    // Rewards are not known, so the line does not promise Withdraw.
    expect(screen.getByText(en.vote_delegation_pending_plain)).toBeTruthy();
    expect(screen.queryByText(en.vote_delegation_pending)).toBeNull();
  });

  it("says 'not seen' after ten minutes, and still does not offer Abstain again", async () => {
    m.getStakeAccountState.mockResolvedValue(account(REWARDS, null));
    renderWithSentVote({
      account: ACCOUNT,
      network: NETWORK,
      txHash: TX_HASH,
      sentAt: Date.now() - DELEGATION_UNSEEN_MS - 60_000,
      drepBefore: null,
    });
    expect(await screen.findByText(startsLike("vote_delegation_unseen"))).toBeTruthy();
    expect(screen.queryByText(en.vote_delegation_pending)).toBeNull();
    expect(abstainButton()).toBeNull();
    expect(screen.queryByText(en.withdraw_needs_drep)).toBeNull();
  });

  it("turns 'waiting' into 'not seen' on an open panel once ten minutes pass", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    m.getStakeAccountState.mockResolvedValue(account(REWARDS, null));
    renderWithSentVote({ account: ACCOUNT, network: NETWORK, sentAt: Date.now(), txHash: TX_HASH, drepBefore: null });
    await screen.findByText(en.vote_delegation_pending);
    await act(async () => {
      vi.advanceTimersByTime(DELEGATION_UNSEEN_MS + 20_000);
    });
    expect(await screen.findByText(startsLike("vote_delegation_unseen"))).toBeTruthy();
    expect(screen.queryByText(en.vote_delegation_pending)).toBeNull();
  });

  it("offers Abstain again once the transaction's validity window has closed", async () => {
    m.getStakeAccountState.mockResolvedValue(account(REWARDS, null));
    renderWithSentVote({
      account: ACCOUNT,
      network: NETWORK,
      txHash: TX_HASH,
      sentAt: Date.now() - VOTE_DELEGATION_WATCH_LIMIT_MS,
      drepBefore: null,
    });
    expect(await screen.findByText(en.withdraw_needs_drep)).toBeTruthy();
    expect(abstainButton()).toBeTruthy();
    expect(screen.queryByText(startsLike("vote_delegation_unseen"))).toBeNull();
  });
});

describe("StakingPanel: the waiting line names Withdraw only when there is something to withdraw", () => {
  it("no rewards: the plain line, not the one about the Withdraw button", async () => {
    m.getStakeAccountState.mockResolvedValue(account(BigInt(0), null));
    renderWithSentVote({ account: ACCOUNT, network: NETWORK, sentAt: Date.now(), txHash: TX_HASH, drepBefore: null });
    expect(await screen.findByText(en.vote_delegation_pending_plain)).toBeTruthy();
    expect(screen.queryByText(en.vote_delegation_pending)).toBeNull();
  });

  it("the 'not seen' line names the clock time the transaction stops being able to land", async () => {
    m.getStakeAccountState.mockResolvedValue(account(REWARDS, null));
    const sentAt = Date.now() - DELEGATION_UNSEEN_MS - 60_000;
    renderWithSentVote({ account: ACCOUNT, network: NETWORK, txHash: TX_HASH, sentAt, drepBefore: null });
    const expiry = clockTime(sentAt + VOTE_DELEGATION_WATCH_LIMIT_MS);
    expect(await screen.findByText(en.vote_delegation_unseen.replace("{{time}}", expiry))).toBeTruthy();
  });
});

describe("StakingPanel: a network switch while a signature is open", () => {
  it("drops the old network's account read that lands after the switch", async () => {
    // Preprod has rewards and a DRep; Preview's read fails.
    m.getStakeAccountState.mockImplementation(async (net: number) => {
      if (net === 0) return account(REWARDS, "drep1preprodchoice");
      throw new Error("preview down");
    });
    let finishSign: (hash: string) => void = () => {};
    const port = makePort();
    port.signAndSubmit.mockImplementation(() => new Promise<string>((r) => (finishSign = r)));
    const view = render(wrap(<Harness port={port} uncertainHash={null} network={0} />));
    fireEvent.click(await screen.findByRole("button", { name: en.withdraw_rewards }));
    await screen.findByLabelText(en.withdraw_verify_checkbox);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: en.confirm_withdraw }));
    await waitFor(() => expect(port.signAndSubmit).toHaveBeenCalledTimes(1));

    // The picker moves to Preview while the signer is still open.
    view.rerender(wrap(<Harness port={port} uncertainHash={null} network={2} />));
    expect(await screen.findByText(en.stake_read_failed)).toBeTruthy();

    // The signature completes; its follow-up read goes to Preprod and answers.
    await act(async () => {
      finishSign(TX_HASH);
    });
    await waitFor(() => expect(m.getStakeAccountState).toHaveBeenCalledWith(0, ACCOUNT));
    await act(async () => {});
    // Preview's screen keeps its own (failed) answer: no Preprod rewards, no
    // Withdraw button armed with them.
    expect(screen.getByText(en.stake_read_failed)).toBeTruthy();
    expect(withdrawButton()).toBeNull();
  });

  it("closes an open Abstain review", async () => {
    m.getStakeAccountState.mockResolvedValue(account(REWARDS, null));
    const port = makePort();
    const view = render(wrap(<Harness port={port} uncertainHash={null} network={0} />));
    fireEvent.click(await screen.findByRole("button", { name: en.withdraw_abstain_button }));
    expect(await screen.findByText(en.withdraw_abstain_review_title)).toBeTruthy();
    view.rerender(wrap(<Harness port={port} uncertainHash={null} network={2} />));
    await waitFor(() => expect(screen.queryByText(en.withdraw_abstain_review_title)).toBeNull());
    expect(port.signAndSubmit).not.toHaveBeenCalled();
  });
});
