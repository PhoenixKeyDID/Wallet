// @vitest-environment happy-dom
/**
 * The approval window's description of a website's transaction, rendered.
 *
 * Every name printed here was chosen by the website that built the
 * transaction. The helper tests prove `assetLabel` carries the policy id; these
 * prove the window actually prints it — reverting the call to the bare name
 * left every helper test green before this file existed.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import i18next from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { Buffer } from "buffer";
import en from "../../../locales/en/wallet.json";
import { TxSummaryView } from "../TxSummaryView";
import type { TxSummary } from "../../../src/lib/cardano/txSummary";
import { baseAddress } from "../../../src/lib/cardano/address";
import { policyIdShort } from "../../../src/lib/cardano/provider";

const PAYEE = baseAddress("cc".repeat(28), "dd".repeat(28), 0);
const REAL = "8169b76cdaba83cf7c9ae32ebd2bb3a58aa215c7dc0b62c8f5e268dd";
const LOOKALIKE = "0".repeat(52) + "dead";
const LAMP = Buffer.from("LAMP", "utf8").toString("hex");

const i18n = i18next.createInstance();
await i18n.use(initReactI18next).init({
  lng: "en",
  defaultNS: "wallet",
  ns: ["wallet"],
  resources: { en: { wallet: en } },
  interpolation: { escapeValue: false },
});

afterEach(cleanup);

const token = (policyId: string, amount: bigint) => ({
  unit: policyId + LAMP,
  policyId,
  assetNameHex: LAMP,
  amount,
});

function shown(overrides: Partial<TxSummary> = {}) {
  const summary: TxSummary = {
    net: [],
    toOthers: [],
    toSelfWithDatum: [],
    fee: BigInt(170_000),
    ownInputs: 1,
    totalInputs: 1,
    foreignInputs: 0,
    burns: [],
    foreignMintList: [],
    collateral: null,
    withdrawals: 0,
    foreignWithdrawals: 0,
    ownRewardKeyHashes: [],
    withdrawalLovelace: BigInt(0),
    foreignInputList: [],
    foreignWithdrawalList: [],
    redeemers: [],
    scriptDataCommitted: false,
    ...overrides,
  };
  const { container } = render(
    <I18nextProvider i18n={i18n}>
      <TxSummaryView summary={summary} />
    </I18nextProvider>,
  );
  return container.textContent ?? "";
}

/** The red blocks the same render produced, as elements — for counting them. */
function shown2(overrides: Partial<TxSummary> = {}): HTMLElement[] {
  const summary: TxSummary = {
    net: [],
    toOthers: [],
    toSelfWithDatum: [],
    fee: BigInt(170_000),
    ownInputs: 1,
    totalInputs: 1,
    foreignInputs: 0,
    burns: [],
    foreignMintList: [],
    collateral: null,
    withdrawals: 0,
    foreignWithdrawals: 0,
    ownRewardKeyHashes: [],
    withdrawalLovelace: BigInt(0),
    foreignInputList: [],
    foreignWithdrawalList: [],
    redeemers: [],
    scriptDataCommitted: false,
    ...overrides,
  };
  const { container } = render(
    <I18nextProvider i18n={i18n}>
      <TxSummaryView summary={summary} />
    </I18nextProvider>,
  );
  return Array.from(container.querySelectorAll("p.approve-error"));
}

const SCRIPT_REWARD = "f0" + "5c".repeat(28);
const KEY_REWARD = "e0" + "01".repeat(28);
const foreignWd = (rewardAccountHex: string, redeemer: boolean, lovelace = BigInt(0)) => ({
  rewardAccountHex,
  stakeAddress: `stake_test1-${rewardAccountHex.slice(0, 6)}`,
  credential: rewardAccountHex.startsWith("f") ? ("script" as const) : ("key" as const),
  credentialHashHex: rewardAccountHex.slice(2),
  lovelace,
  redeemer,
});

/** Render with live confirmation state, as the approval window wires it. */
function withBoxes(summaryOverrides: Partial<TxSummary>, wired = true) {
  const summary = {
    net: [],
    toOthers: [],
    toSelfWithDatum: [],
    fee: BigInt(170_000),
    ownInputs: 1,
    totalInputs: 2,
    foreignInputs: 1,
    burns: [],
    foreignMintList: [],
    collateral: null,
    withdrawals: 0,
    foreignWithdrawals: 0,
    ownRewardKeyHashes: [],
    withdrawalLovelace: BigInt(0),
    foreignInputList: [],
    foreignWithdrawalList: [],
    redeemers: [],
    scriptDataCommitted: false,
    ...summaryOverrides,
  } satisfies TxSummary;
  const confirmed = new Set<string>();
  const calls: [string, boolean][] = [];
  const ui = (set: ReadonlySet<string>) => (
    <I18nextProvider i18n={i18n}>
      <TxSummaryView
        summary={summary}
        confirmed={set}
        onConfirm={
          wired
            ? (k, on) => {
                calls.push([k, on]);
                if (on) confirmed.add(k);
                else confirmed.delete(k);
              }
            : undefined
        }
      />
    </I18nextProvider>
  );
  const r = render(ui(new Set(confirmed)));
  return { ...r, calls, rerenderNow: () => r.rerender(ui(new Set(confirmed))) };
}

describe("TxSummaryView — what the approval window shows", () => {
  it("names a token leaving the wallet together with its policy id", () => {
    const text = shown({ net: [token(REAL, BigInt(5))] });
    expect(text).toContain(`5 LAMP · ${policyIdShort(REAL)}`);
  });

  // A website can send in a worthless look-alike while taking the real one.
  // With bare names the two lines read "5 LAMP" and "5 LAMP (coming in)", and
  // the transaction looks like a swap of equals.
  it("tells apart the real token leaving and a look-alike coming in", () => {
    const text = shown({ net: [token(REAL, BigInt(5)), token(LOOKALIKE, BigInt(-5))] });
    expect(text).toContain(policyIdShort(REAL));
    expect(text).toContain(policyIdShort(LOOKALIKE));
  });

  it("prints every recipient that is not this wallet in full", () => {
    const text = shown({ toOthers: [{ address: PAYEE, lovelace: BigInt(2_000_000), assets: [], mine: false, datum: false }] });
    expect(text).toContain(PAYEE);
  });

  // The tokens each recipient gets, and whether a datum rides on that output,
  // are printed on that recipient's line: a script address receiving LAMP
  // under a datum is where a contract keeps someone's money.
  it("prints each recipient's tokens and its datum flag on its own line", () => {
    const text = shown({
      toOthers: [{ address: PAYEE, lovelace: BigInt(2_000_000), assets: [token(REAL, BigInt(9))], mine: false, datum: true }],
    });
    expect(text).toContain(en.cip30_paying);
    expect(text).toContain(`9 LAMP · ${policyIdShort(REAL)}`);
    expect(text).toContain(en.cip30_output_datum);

    const plain = shown({ toOthers: [{ address: PAYEE, lovelace: BigInt(2_000_000), assets: [], mine: false, datum: false }] });
    expect(plain).not.toContain(en.cip30_output_datum);
    expect(plain).not.toContain("LAMP");
  });

  // A drip-pot claim pays LAMP to this wallet's own address under a datum. It
  // is change — the wallet sees and spends it — but the datum on it must still
  // be on the screen, with the amount, the token and the address.
  it("lists change that carries a datum, with the datum note, and nothing for plain change", () => {
    const text = shown({
      toSelfWithDatum: [
        { address: PAYEE, lovelace: BigInt(1_300_000), assets: [token(REAL, BigInt(7))], mine: true, datum: true },
      ],
    });
    expect(text).toContain(en.cip30_to_self_with_datum);
    expect(text).toContain(PAYEE);
    expect(text).toContain(en.cip30_output_datum);
    expect(text).toContain(`7 LAMP · ${policyIdShort(REAL)}`);
    expect(text).not.toContain(en.cip30_paying);

    const plain = shown();
    expect(plain).not.toContain(en.cip30_to_self_with_datum);
    expect(plain).not.toContain(en.cip30_output_datum);
  });

  // An input that is not this wallet's can be unlocked by this wallet's
  // signature (a Plutus or a native script), and its value is not in the
  // amount on screen.
  it("warns once, with the count, when the transaction spends inputs that are not this wallet's", () => {
    const text = shown({ ownInputs: 1, totalInputs: 3, foreignInputs: 2 });
    expect(text).toContain(en.cip30_foreign_inputs.replace("{{n}}", "2"));
    expect(text).toContain(en.cip30_foreign_inputs_note);
    // One red block, not two: `ownInputs < totalInputs` and `foreignInputs > 0`
    // are the same fact, and the old screen printed it twice on every contract
    // swap or claim (issue #59). The contract explanation is the grey note
    // under the red line, not a second red line.
    const errors = shown2({ ownInputs: 1, totalInputs: 3, foreignInputs: 2 });
    expect(errors).toHaveLength(1);
    const notes = document.querySelectorAll("p.approve-note");
    expect(Array.from(notes).some((n) => n.textContent === en.cip30_foreign_inputs_note)).toBe(true);
    const plain = shown({ ownInputs: 1, totalInputs: 1 });
    expect(plain).not.toContain("not this wallet's");
    expect(plain).not.toContain(en.cip30_foreign_inputs_note);
  });

  // "Your staking rewards" is a claim about whose money it is. It holds only
  // for this wallet's own reward account.
  it("says 'your staking rewards' only for this wallet's own reward account", () => {
    const own = shown({ withdrawals: 1, foreignWithdrawals: 0, withdrawalLovelace: BigInt(5_000_000) });
    expect(own).toContain(en.cip30_extra_actions);
    expect(own).not.toContain(en.cip30_foreign_withdrawal);

    const foreign = shown({ withdrawals: 1, foreignWithdrawals: 1 });
    expect(foreign).not.toContain(en.cip30_extra_actions);
    expect(foreign).toContain(en.cip30_foreign_withdrawal);

    const both = shown({ withdrawals: 2, foreignWithdrawals: 1, withdrawalLovelace: BigInt(5_000_000) });
    expect(both).toContain(en.cip30_extra_actions);
    expect(both).toContain(en.cip30_foreign_withdrawal);

    const none = shown();
    expect(none).not.toContain(en.cip30_extra_actions);
    expect(none).not.toContain(en.cip30_foreign_withdrawal);
  });
});

describe("TxSummaryView — foreign actions are named one by one and lock signing", () => {
  it("prints each foreign input by txid#index, saying whether a script runs for it", () => {
    const text = shown({
      foreignInputs: 2,
      totalInputs: 3,
      foreignInputList: [
        { txId: "aa".repeat(32), index: 0, redeemer: true },
        { txId: "bb".repeat(32), index: 3, redeemer: false },
      ],
    });
    expect(text).toContain(en.cip30_foreign_inputs_heading);
    expect(text).toContain(`${"aa".repeat(32)}#0`);
    expect(text).toContain(`${"bb".repeat(32)}#3`);
    expect(text).toContain(en.cip30_input_redeemer);
    expect(text).toContain(en.cip30_input_no_redeemer);
  });

  it("prints each foreign withdrawal: stake address, amount, credential kind and the reward redeemer", () => {
    const text = shown({
      withdrawals: 2,
      foreignWithdrawals: 2,
      foreignWithdrawalList: [foreignWd(SCRIPT_REWARD, true), foreignWd(KEY_REWARD, false, BigInt(1_000_000))],
    });
    expect(text).toContain(en.cip30_foreign_actions_heading);
    expect(text).toContain("stake_test1-f05c5c");
    expect(text).toContain("stake_test1-e00101");
    expect(text).toContain(en.cip30_withdrawal_script);
    expect(text).toContain(en.cip30_withdrawal_key);
    expect(text).toContain("1 ADA");
    // The redeemer line appears once: only the script withdrawal carries one.
    expect(text.split(en.cip30_withdrawal_redeemer).length - 1).toBe(1);
    expect(text).toContain(en.cip30_sign_locked);
  });

  it("each box records its own account; the lock note stays until every box is ticked", () => {
    const { getByTestId, queryByTestId, calls, rerenderNow } = withBoxes({
      withdrawals: 2,
      foreignWithdrawals: 2,
      foreignWithdrawalList: [foreignWd(SCRIPT_REWARD, true), foreignWd(KEY_REWARD, false)],
    });
    expect(getByTestId("sign-locked")).toBeTruthy();
    fireEvent.click(getByTestId(`confirm-${SCRIPT_REWARD}`));
    expect(calls).toEqual([[SCRIPT_REWARD, true]]);
    rerenderNow();
    // One of two confirmed: still locked.
    expect(queryByTestId("sign-locked")).not.toBeNull();
    fireEvent.click(getByTestId(`confirm-${KEY_REWARD}`));
    rerenderNow();
    expect(queryByTestId("sign-locked")).toBeNull();
    // Unticking one locks again.
    fireEvent.click(getByTestId(`confirm-${KEY_REWARD}`));
    expect(calls.at(-1)).toEqual([KEY_REWARD, false]);
    rerenderNow();
    expect(queryByTestId("sign-locked")).not.toBeNull();
  });

  it("with no handler wired the boxes cannot be ticked, so nothing unlocks", () => {
    const { getByTestId } = withBoxes({ foreignWithdrawals: 1, withdrawals: 1, foreignWithdrawalList: [foreignWd(SCRIPT_REWARD, true)] }, false);
    expect((getByTestId(`confirm-${SCRIPT_REWARD}`) as HTMLInputElement).disabled).toBe(true);
    expect(getByTestId("sign-locked")).toBeTruthy();
  });

  it("a body that commits to script data: a missing redeemer is not called 'locked by a key'", () => {
    const text = shown({
      scriptDataCommitted: true,
      foreignInputs: 1,
      totalInputs: 2,
      foreignInputList: [{ txId: "bb".repeat(32), index: 3, redeemer: false }],
      withdrawals: 2,
      foreignWithdrawals: 2,
      foreignWithdrawalList: [foreignWd(SCRIPT_REWARD, false), foreignWd(KEY_REWARD, false)],
    });
    expect(text).toContain(en.cip30_input_redeemer_unknown);
    expect(text).not.toContain(en.cip30_input_no_redeemer);
    // Only the script account can run a script; a key account says nothing.
    expect(text.split(en.cip30_withdrawal_redeemer_unknown).length - 1).toBe(1);
  });

  it("no script data in the body: 'no redeemer' stands, and no 'may attach' warning", () => {
    const text = shown({
      foreignInputs: 1,
      totalInputs: 2,
      foreignInputList: [{ txId: "bb".repeat(32), index: 3, redeemer: false }],
      withdrawals: 1,
      foreignWithdrawals: 1,
      foreignWithdrawalList: [foreignWd(SCRIPT_REWARD, false)],
    });
    expect(text).toContain(en.cip30_input_no_redeemer);
    expect(text).not.toContain(en.cip30_input_redeemer_unknown);
    expect(text).not.toContain(en.cip30_withdrawal_redeemer_unknown);
  });

  it("a screen that signs nothing (submitTx) lists the withdrawals without boxes or a lock note", () => {
    const summary: TxSummary = {
      net: [],
      toOthers: [],
      toSelfWithDatum: [],
      fee: BigInt(170_000),
      ownInputs: 1,
      totalInputs: 1,
      foreignInputs: 0,
      burns: [],
      foreignMintList: [],
      collateral: null,
      withdrawals: 1,
      foreignWithdrawals: 1,
      ownRewardKeyHashes: [],
      withdrawalLovelace: BigInt(0),
      foreignInputList: [],
      foreignWithdrawalList: [foreignWd(SCRIPT_REWARD, true)],
      redeemers: [],
      scriptDataCommitted: false,
    };
    const { container, queryByTestId } = render(
      <I18nextProvider i18n={i18n}>
        <TxSummaryView summary={summary} locks={false} />
      </I18nextProvider>,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("stake_test1-f05c5c");
    expect(text).toContain(en.cip30_withdrawal_redeemer);
    expect(queryByTestId(`confirm-${SCRIPT_REWARD}`)).toBeNull();
    expect(queryByTestId("sign-locked")).toBeNull();
    expect(text).not.toContain(en.cip30_withdrawal_confirm);
  });

  it("no foreign withdrawal: no list, no lock note", () => {
    const text = shown({ withdrawals: 1, withdrawalLovelace: BigInt(5_000_000) });
    expect(text).not.toContain(en.cip30_foreign_actions_heading);
    expect(text).not.toContain(en.cip30_sign_locked);
  });
});

describe("TxSummaryView — created tokens are named one by one, by unit, and lock signing", () => {
  const POLICY_A = "a1".repeat(28);
  const POLICY_B = "b2".repeat(28);
  const GOLD = Buffer.from("GOLD", "utf8").toString("hex");
  const SILVER = Buffer.from("SILVER", "utf8").toString("hex");
  const mint = (policyId: string, assetNameHex: string, quantity: bigint, script = false) => ({
    unit: policyId + assetNameHex,
    policyId,
    assetNameHex,
    quantity,
    script,
  });
  const UNIT_A_GOLD = POLICY_A + GOLD;
  const UNIT_A_SILVER = POLICY_A + SILVER;

  it("prints each created token with its amount, name, short policy id and the script line", () => {
    const text = shown({ foreignMintList: [mint(POLICY_A, GOLD, BigInt(7), true), mint(POLICY_B, SILVER, BigInt(1))] });
    expect(text).toContain(en.cip30_mints_heading);
    expect(text).toContain(en.cip30_mints_note);
    expect(text).toContain(`7 GOLD · ${policyIdShort(POLICY_A)}`);
    expect(text).toContain(`1 SILVER · ${policyIdShort(POLICY_B)}`);
    // The script line appears once: only policy A has a mint redeemer.
    expect(text.split(en.cip30_mint_script).length - 1).toBe(1);
    expect(text).toContain(en.cip30_sign_locked);
  });

  it("two tokens under one policy get two boxes; ticking one leaves Sign locked", () => {
    const { getByTestId, queryByTestId, calls, rerenderNow } = withBoxes({
      foreignMintList: [mint(POLICY_A, GOLD, BigInt(1)), mint(POLICY_A, SILVER, BigInt(2))],
    });
    expect(getByTestId("sign-locked")).toBeTruthy();
    fireEvent.click(getByTestId(`confirm-mint-${UNIT_A_GOLD}`));
    expect(calls).toEqual([[`mint:${UNIT_A_GOLD}`, true]]);
    rerenderNow();
    // Same policy, other unit: not confirmed by the first tick.
    expect((getByTestId(`confirm-mint-${UNIT_A_SILVER}`) as HTMLInputElement).checked).toBe(false);
    expect(queryByTestId("sign-locked")).not.toBeNull();
    fireEvent.click(getByTestId(`confirm-mint-${UNIT_A_SILVER}`));
    rerenderNow();
    expect(queryByTestId("sign-locked")).toBeNull();
    fireEvent.click(getByTestId(`confirm-mint-${UNIT_A_GOLD}`));
    expect(calls.at(-1)).toEqual([`mint:${UNIT_A_GOLD}`, false]);
    rerenderNow();
    expect(queryByTestId("sign-locked")).not.toBeNull();
  });

  it("a withdrawal and a token in one transaction: Sign unlocks only when both are ticked", () => {
    const { getByTestId, queryByTestId, rerenderNow } = withBoxes({
      withdrawals: 1,
      foreignWithdrawals: 1,
      foreignWithdrawalList: [foreignWd(SCRIPT_REWARD, true)],
      foreignMintList: [mint(POLICY_A, GOLD, BigInt(1))],
    });
    fireEvent.click(getByTestId(`confirm-${SCRIPT_REWARD}`));
    rerenderNow();
    expect(queryByTestId("sign-locked")).not.toBeNull();
    fireEvent.click(getByTestId(`confirm-mint-${UNIT_A_GOLD}`));
    rerenderNow();
    expect(queryByTestId("sign-locked")).toBeNull();
  });

  it("with no handler wired the token box cannot be ticked, so nothing unlocks", () => {
    const { getByTestId } = withBoxes({ foreignMintList: [mint(POLICY_A, GOLD, BigInt(1))] }, false);
    expect((getByTestId(`confirm-mint-${UNIT_A_GOLD}`) as HTMLInputElement).disabled).toBe(true);
    expect(getByTestId("sign-locked")).toBeTruthy();
  });

  it("no created token: no list, no box", () => {
    const text = shown({ burns: [token(REAL, BigInt(1))] });
    expect(text).not.toContain(en.cip30_mints_heading);
    expect(text).not.toContain(en.cip30_mint_confirm);
    expect(text).not.toContain(en.cip30_sign_locked);
  });
});
