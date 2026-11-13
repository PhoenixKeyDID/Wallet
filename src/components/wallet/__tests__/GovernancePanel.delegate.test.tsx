// @vitest-environment happy-dom
/**
 * The Governance tab's "Delegate" section around a network switch and a vote
 * delegation already in flight.
 *
 *   - The DRep read belongs to the network it was read on: after a switch of
 *     the picker the old network's DRep must not stay on the new one's screen
 *     while (or because) the new read has not answered.
 *   - With a choice already on its way, a second one is allowed — changing it
 *     is legitimate — but its review says that it replaces the first and pays
 *     a second fee.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import i18next, { type i18n as I18n } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import en from "../../../../locales/en/wallet.json";
import type { PhoenixNetwork, WalletPort } from "@/lib/cardano";
import { clockTime, type SentVoteDelegation } from "../delegationFeedback";

const ACCOUNT = "stake_test1uqtestaccount";
const DREP = "drep1testdrepidentifier0000abcd";
const CHANGE_HEX = "60" + "11".repeat(28);

const m = vi.hoisted(() => ({
  getVoteDelegationState: vi.fn(),
}));

vi.mock("@/lib/cardano/governance", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  const built = { fee: "180000", transaction: {} };
  return {
    ...real,
    listDReps: async () => [],
    listGovActions: async () => [],
    getVoteDelegationState: m.getVoteDelegationState,
    rewardAddressFrom: () => ({ getBech32: () => ACCOUNT }),
    buildVoteDelegation: () => built,
    parseDRepId: (x: string) => x,
  };
});
vi.mock("@/lib/cardano", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    fetchProtocolParams: async () => ({}),
    fetchTipSlot: async () => 1000,
    fetchTxSeen: async () => false,
  };
});
vi.mock("@/lib/toast", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, toastSuccess: vi.fn(), toastError: vi.fn(), toastApiError: vi.fn() };
});

import { GovernancePanel } from "../GovernancePanel";

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
  m.getVoteDelegationState.mockReset();
});
afterEach(cleanup);

function makePort() {
  return {
    kind: "local",
    getInputs: vi.fn(async () => [{}]),
    getRewardAddressHex: vi.fn(async () => "e0" + "22".repeat(28)),
    getDrepKeyHashHex: vi.fn(async () => "33".repeat(28)),
    signAndSubmit: vi.fn(async () => "ab".repeat(32)),
  } as unknown as WalletPort;
}

const SETTLE = { timeout: 5000 };

function panel(port: WalletPort, network: PhoenixNetwork, sent?: SentVoteDelegation | null) {
  return (
    <I18nextProvider i18n={i18n}>
      <GovernancePanel
        port={port}
        network={network}
        changeAddress={CHANGE_HEX}
        uncertainHash={null}
        onUncertain={() => {}}
        sentVoteDelegation={sent}
        onVoteDelegationSent={() => {}}
        onVoteDelegationLanded={() => {}}
      />
    </I18nextProvider>
  );
}

const currentLine = () => screen.queryByText(new RegExp(`^${en.gov_current_delegation}:`));

describe("GovernancePanel: a network switch drops the old network's DRep", () => {
  it("the old DRep is gone while the new network's read has not answered", async () => {
    m.getVoteDelegationState.mockImplementation((net: number) =>
      net === 0 ? Promise.resolve({ found: true, status: "registered", delegatedDRep: DREP }) : new Promise(() => {}),
    );
    const port = makePort();
    const view = render(panel(port, 0, null));
    await waitFor(() => expect(currentLine()).toBeTruthy(), SETTLE);
    expect(screen.getByText(DREP.slice(0, 12), { exact: false })).toBeTruthy();

    view.rerender(panel(port, 2, null));
    await waitFor(() => expect(m.getVoteDelegationState).toHaveBeenCalledWith(2, ACCOUNT), SETTLE);
    expect(currentLine()).toBeNull();
  });
});

describe("GovernancePanel: what the current-delegation line says", () => {
  it("a read without the DRep field (or any failed read) says it could not read, never 'None'", async () => {
    m.getVoteDelegationState.mockRejectedValue(new Error("Indexer response has no delegated_drep field"));
    const port = makePort();
    render(panel(port, 0, null));
    expect(await screen.findByText(en.gov_current_read_failed, undefined, SETTLE)).toBeTruthy();
    expect(currentLine()).toBeNull();
    expect(screen.queryByText(en.gov_none)).toBeNull();
  });

  it("Abstain and No Confidence are named in words, not as the indexer's internal ids", async () => {
    m.getVoteDelegationState.mockResolvedValue({ found: true, status: "registered", delegatedDRep: "drep_always_abstain" });
    const port = makePort();
    const view = render(panel(port, 0, null));
    await waitFor(() => expect(currentLine()).toBeTruthy(), SETTLE);
    expect(currentLine()!.textContent).toBe(`${en.gov_current_delegation}: ${en.gov_abstain}`);
    expect(screen.queryByText(/drep_always/)).toBeNull();
    view.unmount();

    m.getVoteDelegationState.mockResolvedValue({
      found: true,
      status: "registered",
      delegatedDRep: "drep_always_no_confidence",
    });
    render(panel(port, 0, null));
    await waitFor(() => expect(currentLine()).toBeTruthy(), SETTLE);
    expect(currentLine()!.textContent).toBe(`${en.gov_current_delegation}: ${en.gov_no_confidence}`);
  });
});

describe("GovernancePanel: a second choice while one is in flight", () => {
  it("the review warns that it replaces the choice sent at HH:MM and costs another fee", async () => {
    m.getVoteDelegationState.mockResolvedValue({ found: true, status: "registered", delegatedDRep: null });
    const sentAt = Date.now() - 60_000;
    const sent: SentVoteDelegation = {
      account: ACCOUNT,
      network: 0,
      sentAt,
      txHash: "cd".repeat(32),
      drepBefore: null,
    };
    const port = makePort();
    render(panel(port, 0, sent));
    expect(await screen.findByText(en.gov_delegate_pending)).toBeTruthy();
    await waitFor(() => expect(port.getDrepKeyHashHex).toHaveBeenCalled(), SETTLE);

    const abstain = screen.getByRole("button", { name: en.gov_abstain }) as HTMLButtonElement;
    expect(abstain.disabled).toBe(false); // warned, not blocked
    fireEvent.click(abstain);
    const warn = en.gov_delegate_inflight_warn.replace("{{time}}", clockTime(sentAt));
    expect(await screen.findByText(warn, undefined, SETTLE)).toBeTruthy();
  });

  it("no choice in flight: no such warning", async () => {
    m.getVoteDelegationState.mockResolvedValue({ found: true, status: "registered", delegatedDRep: null });
    const port = makePort();
    render(panel(port, 0, null));
    await waitFor(() => expect(port.getDrepKeyHashHex).toHaveBeenCalled(), SETTLE);
    fireEvent.click(screen.getByRole("button", { name: en.gov_abstain }));
    await screen.findByLabelText(en.gov_verify_checkbox, undefined, SETTLE);
    const head = en.gov_delegate_inflight_warn.split("{{time}}")[1]!.trim();
    expect(screen.queryByText(head, { exact: false })).toBeNull();
  });
});
