// @vitest-environment happy-dom
/**
 * Which message follows a signed governance transaction.
 *
 * A vote delegation locks no deposit and creates no governance action. Calling
 * it "Governance action submitted" sent people to look for a proposal that does
 * not exist, so a delegation has its own message. These tests drive each path
 * through the screen — Abstain, No confidence, a named dRep, and a vote on an
 * open action — and read which key the toast was given.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import i18next, { type i18n as I18n } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import en from "../../../../locales/en/wallet.json";
import type { WalletPort } from "@/lib/cardano";

const ACCOUNT = "stake_test1uqtestaccount";
const DREP = "drep1testdrepidentifier0000abcd";
const ACTION_ID = "gov_action1testactionid0000wxyz";
const CHANGE_HEX = "60" + "11".repeat(28);

const m = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  listDReps: vi.fn(),
  listGovActions: vi.fn(),
}));

vi.mock("@/lib/cardano/governance", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  const built = { fee: "180000", transaction: {} };
  return {
    ...real,
    listDReps: m.listDReps,
    listGovActions: m.listGovActions,
    getVoteDelegationState: async () => ({ delegatedDRep: null }),
    rewardAddressFrom: () => ({ getBech32: () => ACCOUNT }),
    buildVoteDelegation: () => built,
    buildVote: () => built,
    parseDRepId: (x: string) => x,
    parseGovActionId: (x: string) => x,
  };
});
vi.mock("@/lib/cardano", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, fetchProtocolParams: async () => ({}), fetchTipSlot: async () => 1000 };
});
vi.mock("@/lib/toast", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, toastSuccess: m.toastSuccess, toastError: vi.fn(), toastApiError: vi.fn() };
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
  m.toastSuccess.mockReset();
  m.listDReps.mockReset();
  m.listDReps.mockResolvedValue([{ drepId: DREP, votingPower: "1000000" }]);
  m.listGovActions.mockReset();
  m.listGovActions.mockResolvedValue([
    { id: ACTION_ID, isOpen: true, title: "Test action", type: "InfoAction" },
  ]);
});
afterEach(cleanup);

function makePort() {
  return {
    kind: "local",
    getInputs: vi.fn(async () => [{}]),
    getRewardAddressHex: vi.fn(async () => "e0" + "22".repeat(28)),
    getDrepKeyHashHex: vi.fn(async () => "33".repeat(28)),
    signAndSubmit: vi.fn(async () => "abcdef0123456789abcdef"),
  } as unknown as WalletPort;
}

function renderPanel() {
  const port = makePort();
  render(
    <I18nextProvider i18n={i18n}>
      <GovernancePanel
        port={port}
        network={0}
        changeAddress={CHANGE_HEX}
        uncertainHash={null}
        onUncertain={() => {}}
      />
    </I18nextProvider>,
  );
  return port;
}

// Generous on purpose: these waits cover several mocked chain reads, and a
// loaded CI runner can take longer than the 1 s default to settle them.
const SETTLE = { timeout: 5000 };

/** Tick the testnet checkbox in the review and confirm. */
async function confirmReview() {
  const box = await screen.findByLabelText(en.gov_verify_checkbox);
  fireEvent.click(box);
  const confirm = screen.getByRole("button", { name: en.gov_confirm });
  await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false), SETTLE);
  fireEvent.click(confirm);
  await waitFor(() => expect(m.toastSuccess).toHaveBeenCalledTimes(1), SETTLE);
  return m.toastSuccess.mock.calls[0]![0] as string;
}

/** The reward address is read on mount; a delegation built before it lands errors. */
async function rewardAddressRead(port: WalletPort) {
  await waitFor(() => expect(port.getDrepKeyHashHex).toHaveBeenCalled(), SETTLE);
}

describe("GovernancePanel: the message after a vote delegation", () => {
  it("Abstain says a delegation was submitted, not a governance action", async () => {
    await rewardAddressRead(renderPanel());
    fireEvent.click(screen.getByRole("button", { name: en.gov_abstain }));
    expect(await confirmReview()).toBe("gov_delegation_submitted");
  });

  it("No confidence says the same", async () => {
    await rewardAddressRead(renderPanel());
    fireEvent.click(screen.getByRole("button", { name: en.gov_no_confidence }));
    expect(await confirmReview()).toBe("gov_delegation_submitted");
  });

  it("delegating to a named dRep says the same", async () => {
    await rewardAddressRead(renderPanel());
    fireEvent.click(screen.getByRole("button", { name: en.gov_search }));
    // The section tab is also called "Delegate": take the button in the dRep's row.
    const row = (await screen.findByText(DREP)).parentElement!;
    fireEvent.click(within(row).getByRole("button", { name: en.gov_delegate }));
    expect(await confirmReview()).toBe("gov_delegation_submitted");
  });
});

describe("GovernancePanel: the message after a vote on an action", () => {
  it("a vote keeps 'governance action submitted'", async () => {
    const port = renderPanel();
    await rewardAddressRead(port);
    fireEvent.click(screen.getByRole("button", { name: en.gov_tab_actions }));
    const yes = await screen.findByRole("button", { name: en.gov_vote_yes });
    await waitFor(() => expect((yes as HTMLButtonElement).disabled).toBe(false), SETTLE);
    fireEvent.click(yes);
    expect(await confirmReview()).toBe("gov_submitted");
    expect(port.signAndSubmit).toHaveBeenCalledTimes(1);
  });
});
