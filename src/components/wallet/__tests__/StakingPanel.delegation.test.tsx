// @vitest-environment happy-dom
/**
 * The delegation feedback, wired into the screen.
 *
 * `delegationFeedback.test.ts` pins the decision ("pending", "unseen",
 * "settled"). These tests pin the wiring around it: that a signed delegation
 * is handed up to the parent, that the parent's record turns into the waiting
 * line, that the line is re-checked against the chain on a timer which stops
 * when the screen goes away, and that a trip to another tab and back does not
 * drop it — the trip that used to bring back a stale "Not delegated" and invite
 * a second, paid delegation.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, fireEvent, screen, waitFor, act } from "@testing-library/react";
import i18next, { type i18n as I18n } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import type { ReactNode } from "react";
import en from "../../../../locales/en/wallet.json";
import type { WalletPort } from "@/lib/cardano";
import {
  DELEGATION_UNSEEN_MS,
  DELEGATION_WATCH_LIMIT_MS,
  type SentDelegation,
} from "../delegationFeedback";

const ACCOUNT = "stake_test1uqtestaccount";
const POOL = "pool1testpoolxyz9"; // short enough that the screen prints it whole
const NETWORK = 0 as const;
// Testnet enterprise address: header 0x60 + 28-byte key hash. Only decoded.
const CHANGE_HEX = "60" + "11".repeat(28);

const m = vi.hoisted(() => ({
  getStakeAccountState: vi.fn(),
  searchPools: vi.fn(),
  buildDelegation: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/lib/cardano/staking", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    getStakeAccountState: m.getStakeAccountState,
    searchPools: m.searchPools,
    buildDelegation: m.buildDelegation,
    rewardAddressFromHex: () => ({ getBech32: () => ACCOUNT }),
  };
});
vi.mock("@/lib/cardano", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    fetchProtocolParams: async () => ({}),
    fetchTipSlot: async () => 1000,
  };
});
vi.mock("@/lib/toast", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, toastSuccess: m.toastSuccess, toastError: vi.fn(), toastApiError: vi.fn() };
});
// The other tabs are not under test; a stub keeps their network reads out.
vi.mock("../HistoryPanel", () => ({ HistoryPanel: () => <p>history-stub</p> }));
vi.mock("../ReceivePanel", () => ({ ReceivePanel: () => <p>receive-stub</p> }));
vi.mock("../SendPanel", () => ({ SendPanel: () => <p>send-stub</p> }));
vi.mock("../GovernancePanel", () => ({ GovernancePanel: () => <p>governance-stub</p> }));
vi.mock("../ConnectPanel", () => ({ ConnectPanel: () => <p>connect-stub</p> }));

import { StakingPanel } from "../StakingPanel";
import { WalletTabs } from "../WalletTabs";

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
  m.getStakeAccountState.mockResolvedValue({
    registered: true,
    delegatedPoolId: null,
    rewardsAvailable: BigInt(0),
  });
  m.searchPools.mockReset();
  m.searchPools.mockResolvedValue([
    {
      poolId: POOL,
      ticker: "TEST",
      name: "Test pool",
      saturationPct: 1,
      marginPct: 1,
      fixedCostLovelace: BigInt(340_000_000),
      pledgeLovelace: BigInt(0),
    },
  ]);
  m.buildDelegation.mockReset();
  m.buildDelegation.mockReturnValue({
    fee: "200000",
    transaction: { protocolParams: { stakeKeyDeposit: "2000000" } },
  });
  m.toastSuccess.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function makePort() {
  return {
    kind: "local",
    getInputs: vi.fn(async () => [{}]),
    getRewardAddressHex: vi.fn(async () => "e0" + "22".repeat(28)),
    signAndSubmit: vi.fn(async () => "abcdef0123456789abcdef"),
  } as unknown as WalletPort;
}

const wrap = (ui: ReactNode) => <I18nextProvider i18n={i18n}>{ui}</I18nextProvider>;

const pendingText = () => i18n.t("stake_delegate_pending", { pool: POOL });
const unseenText = () => i18n.t("stake_delegate_unseen", { pool: POOL });

function renderPanel(props: {
  sentDelegation: SentDelegation | null;
  onDelegationSent?: (s: SentDelegation) => void;
  onDelegationSettled?: () => void;
  port?: WalletPort;
}) {
  return render(
    wrap(
      <StakingPanel
        port={props.port ?? makePort()}
        network={NETWORK}
        changeAddress={CHANGE_HEX}
        uncertainHash={null}
        onUncertain={() => {}}
        sentDelegation={props.sentDelegation}
        onDelegationSent={props.onDelegationSent ?? (() => {})}
        onDelegationSettled={props.onDelegationSettled ?? (() => {})}
      />,
    ),
  );
}

/** Search → Delegate → retype the pool id's tail → Confirm. */
async function delegateThroughUi() {
  // Wait for the account read: until then the reward address is not known.
  await waitFor(() => expect(screen.getByText(en.not_delegated)).toBeTruthy());
  fireEvent.change(screen.getByPlaceholderText(en.search_pools_placeholder), {
    target: { value: "TEST" },
  });
  fireEvent.click(screen.getByRole("button", { name: en.search_pools_button }));
  fireEvent.click(await screen.findByRole("button", { name: en.delegate_button }));
  const retype = await screen.findByPlaceholderText(en.confirm_gate_placeholder);
  fireEvent.change(retype, { target: { value: POOL.slice(-4) } });
  const confirm = screen.getByRole("button", { name: en.confirm_delegate });
  await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(confirm);
}

const sentNow = (over: Partial<SentDelegation> = {}): SentDelegation => ({
  poolId: POOL,
  account: ACCOUNT,
  network: NETWORK,
  sentAt: Date.now(),
  ...over,
});

describe("StakingPanel: a signed delegation is handed to the parent", () => {
  it("calls onDelegationSent with the pool, the reward account, the network and the time", async () => {
    const onDelegationSent = vi.fn();
    const port = makePort();
    const before = Date.now();
    renderPanel({ sentDelegation: null, onDelegationSent, port });
    await delegateThroughUi();
    await waitFor(() => expect(onDelegationSent).toHaveBeenCalledTimes(1));
    const sent = onDelegationSent.mock.calls[0]![0] as SentDelegation;
    expect(sent).toMatchObject({ poolId: POOL, account: ACCOUNT, network: NETWORK });
    expect(sent.sentAt).toBeGreaterThanOrEqual(before);
    expect(sent.sentAt).toBeLessThanOrEqual(Date.now());
    expect(port.signAndSubmit).toHaveBeenCalledTimes(1);
  });
});

describe("StakingPanel: the waiting line comes from the parent's record", () => {
  it("shows the pending line while the chain does not show the pool", async () => {
    renderPanel({ sentDelegation: sentNow() });
    expect(await screen.findByText(pendingText())).toBeTruthy();
    expect(screen.queryByText(unseenText())).toBeNull();
  });

  it("the current-delegation cell says 'waiting', not the stale 'Not delegated'", async () => {
    renderPanel({ sentDelegation: sentNow() });
    expect(await screen.findByText(en.delegation_waiting)).toBeTruthy();
    expect(screen.queryByText(en.not_delegated)).toBeNull();
  });

  it("shows nothing for a delegation sent from another account", async () => {
    renderPanel({ sentDelegation: sentNow({ account: "stake_test1uqsomeoneelse" }) });
    await waitFor(() => expect(screen.getByText(en.not_delegated)).toBeTruthy());
    expect(screen.queryByText(pendingText())).toBeNull();
    expect(screen.queryByText(unseenText())).toBeNull();
  });

  it("says 'not seen' instead of 'waiting' once the limit has passed", async () => {
    renderPanel({ sentDelegation: sentNow({ sentAt: Date.now() - DELEGATION_UNSEEN_MS - 60_000 }) });
    expect(await screen.findByText(unseenText())).toBeTruthy();
    expect(screen.queryByText(pendingText())).toBeNull();
    // Past the limit the chain's answer is the best guess there is.
    expect(screen.getByText(en.not_delegated)).toBeTruthy();
    expect(screen.queryByText(en.delegation_waiting)).toBeNull();
  });

  it("tells the parent to let go once the chain shows the pool", async () => {
    m.getStakeAccountState.mockResolvedValue({
      registered: true,
      delegatedPoolId: POOL,
      rewardsAvailable: BigInt(0),
    });
    const onDelegationSettled = vi.fn();
    renderPanel({ sentDelegation: sentNow(), onDelegationSettled });
    await waitFor(() => expect(onDelegationSettled).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(pendingText())).toBeNull();
  });

  it("does not let go while the chain still shows no delegation", async () => {
    const onDelegationSettled = vi.fn();
    renderPanel({ sentDelegation: sentNow(), onDelegationSettled });
    await screen.findByText(pendingText());
    expect(onDelegationSettled).not.toHaveBeenCalled();
  });
});

describe("StakingPanel: the re-read while waiting", () => {
  it("re-reads the account every 20 s, and stops when the panel unmounts", async () => {
    // Only the interval and the clock are faked: testing-library's waitFor
    // runs on real timeouts.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const view = renderPanel({ sentDelegation: sentNow() });
    await screen.findByText(pendingText());
    expect(m.getStakeAccountState).toHaveBeenCalledTimes(1); // the mount read

    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });
    expect(m.getStakeAccountState).toHaveBeenCalledTimes(2);
    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });
    expect(m.getStakeAccountState).toHaveBeenCalledTimes(3);

    view.unmount();
    await act(async () => {
      vi.advanceTimersByTime(120_000);
    });
    expect(m.getStakeAccountState).toHaveBeenCalledTimes(3);
  });

  it("turns 'waiting' into 'not seen' on an open panel once the limit passes", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    renderPanel({ sentDelegation: sentNow() });
    await screen.findByText(pendingText());
    await act(async () => {
      vi.advanceTimersByTime(DELEGATION_UNSEEN_MS + 20_000);
    });
    expect(await screen.findByText(unseenText())).toBeTruthy();
    expect(screen.queryByText(pendingText())).toBeNull();
  });

  it("keeps re-reading through 'not seen', and a late block clears it", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const onDelegationSettled = vi.fn();
    renderPanel({
      sentDelegation: sentNow({ sentAt: Date.now() - DELEGATION_UNSEEN_MS - 60_000 }),
      onDelegationSettled,
    });
    await screen.findByText(unseenText());
    expect(m.getStakeAccountState).toHaveBeenCalledTimes(1);

    m.getStakeAccountState.mockResolvedValue({
      registered: true,
      delegatedPoolId: POOL,
      rewardsAvailable: BigInt(0),
    });
    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });
    expect(m.getStakeAccountState).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(onDelegationSettled).toHaveBeenCalledTimes(1));
  });

  it("stops re-reading once the delegation can no longer land", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    renderPanel({
      sentDelegation: sentNow({ sentAt: Date.now() - DELEGATION_WATCH_LIMIT_MS - 1 }),
    });
    await screen.findByText(unseenText());
    await act(async () => {
      vi.advanceTimersByTime(120_000);
    });
    expect(m.getStakeAccountState).toHaveBeenCalledTimes(1);
  });

  it("a re-read that works after a failed mount read clears the error box", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    m.getStakeAccountState.mockRejectedValueOnce(new Error("koios down"));
    renderPanel({ sentDelegation: sentNow() });
    expect(await screen.findByText(en.stake_read_failed)).toBeTruthy();
    // The waiting line stays up through the error: it is still true.
    expect(screen.getByText(pendingText())).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });
    await waitFor(() => expect(screen.queryByText(en.stake_read_failed)).toBeNull());
    expect(screen.getByText(en.delegation_waiting)).toBeTruthy();
  });

  it("does not poll when nothing is waiting", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    renderPanel({ sentDelegation: null });
    await waitFor(() => expect(screen.getByText(en.not_delegated)).toBeTruthy());
    await act(async () => {
      vi.advanceTimersByTime(120_000);
    });
    expect(m.getStakeAccountState).toHaveBeenCalledTimes(1);
  });
});

describe("WalletTabs: the waiting line survives a trip to another tab", () => {
  it("staking → history → staking still shows the delegation as waiting", async () => {
    render(wrap(<WalletTabs port={makePort()} changeAddress={CHANGE_HEX} network={NETWORK} />));
    fireEvent.click(screen.getByRole("button", { name: new RegExp(en.tab_staking) }));
    await delegateThroughUi();
    expect(await screen.findByText(pendingText())).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: new RegExp(en.tab_history) }));
    expect(await screen.findByText("history-stub")).toBeTruthy();
    expect(screen.queryByText(pendingText())).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: new RegExp(en.tab_staking) }));
    expect(await screen.findByText(pendingText())).toBeTruthy();
    // The account was read again on return and still shows no delegation —
    // exactly the moment the stale "Not delegated" used to stand alone. The
    // cell says "waiting" instead.
    expect(screen.getByText(en.delegation_waiting)).toBeTruthy();
    expect(screen.queryByText(en.not_delegated)).toBeNull();
  });
});
