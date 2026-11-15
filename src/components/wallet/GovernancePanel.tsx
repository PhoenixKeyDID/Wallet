"use client";

/**
 * Governance (CIP-1694 / Conway) panel for the Phoenix wallet.
 *
 * Four flows, each two-step (Review → Confirm), never blind-signing:
 *   • Delegate voting power — pick a dRep, or the special Abstain / No-Confidence.
 *   • Governance Actions   — list open actions and cast Yes / No / Abstain.
 *   • Become a dRep        — register / de-register.
 *   • Submit an action     — advanced (Info or Treasury-withdrawal).
 *
 * KEY-CONTROL: delegation needs only the stake key (from the reward address) and
 * works over plain CIP-30. Voting AS a dRep and dRep registration need the
 * account's dRep key, which plain CIP-30 does NOT expose — we read it via CIP-95
 * `getPubDRepKey()` and derive the key-hash (blake2b-224). Wallets without CIP-95
 * see those two sections disabled with an explanation; we never fake the key.
 */
import "../../lib/node-globals";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Buffer } from "buffer";
import { useTranslation } from "react-i18next";
import BigNumber from "bignumber.js";
import { utils as tyUtils, types as tyTypes } from "@stricahq/typhonjs";
import { toastApiError, toastError, toastSuccess } from "@/lib/toast";
import {
  ConfirmGate,
  ChallengedValue,
  tailChallenge,
  CHALLENGE_LEN,
} from "@/components/wallet/ConfirmGate";
import { reportSignError } from "@/components/wallet/signError";
import type { UncertainLock } from "@/components/wallet/UncertainSubmitNotice";
import { SignHint } from "@/components/wallet/SignHint";
import {
  type WalletPort,
  type PhoenixNetwork,
  type BuiltTx,
  fetchProtocolParams,
  fetchTipSlot,
  fetchTxSeen,
  formatAda,
  fetchGovDeposit,
  blake2b224,
  fromHex,
  toHex,
} from "@/lib/cardano";
import {
  type DRepSummary,
  type GovActionSummary,
  type DelegationTarget,
  type GovBuildCtx,
  listDReps,
  listGovActions,
  getVoteDelegationState,
  DREP_ALWAYS_ABSTAIN,
  DREP_ALWAYS_NO_CONFIDENCE,
  voteTargetId,
  rewardAddressFrom,
  parseGovActionId,
  parseDRepId,
  buildVoteDelegation,
  buildVote,
  buildDRepRegistration,
  buildDRepDeRegistration,
  buildProposal,
  makeAnchor,
  infoAction,
  treasuryWithdrawalAction,
} from "@/lib/cardano/governance";
import {
  VOTE_DELEGATION_TTL_SLOTS,
  clockTime,
  lookUpVoteTx,
  voteDelegationExpiresAt,
  voteDelegationConfirmed,
  voteDelegationLanded,
  voteDelegationWatch,
  type SentVoteDelegation,
} from "@/components/wallet/delegationFeedback";

/** How often the current DRep is re-read while a sent vote delegation waits. */
const VOTE_PENDING_POLL_MS = 20_000;

type Section = "delegate" | "actions" | "become" | "submit";
/**
 * `challenged` marks the row holding the action's destination. That row is
 * printed in FULL — not shortened — because it is the one the user is about to
 * retype, and asking someone to confirm the tail of a value we truncated for
 * them is asking them to confirm our own ellipsis.
 */
type SummaryRow = { label: string; value: string; mono?: boolean; challenged?: boolean };
/**
 * `onDone` runs only after the transaction actually reached the network. A
 * section uses it to clear the form it just spent — leaving a filled form on
 * screen after a successful submit invites a second press, and a second
 * governance action costs a second deposit that no one asked for. It is given
 * the hash the submit returned.
 */
type Pending = {
  built: BuiltTx;
  title: string;
  rows: SummaryRow[];
  warn?: string;
  onDone?: (txHash: string) => void;
  /**
   * Toast shown once the tx reaches the network. Defaults to "governance action
   * submitted", which is wrong for a vote delegation: a delegation locks no
   * deposit and creates no action, and calling it one sends the user to look
   * for a proposal that does not exist.
   */
  submittedKey?: string;
  /**
   * The cryptographic destination of this action, in full — the dRep id, the
   * pool id, the governance action id, the withdrawal address. `ConfirmGate`
   * challenges its tail.
   *
   * This is carried explicitly instead of being recovered from the review rows,
   * because recovering it used to mean sniffing the rows for anything matching
   * `^(drep|pool|addr|stake|ca)1…$`, and that quietly failed in two ways at
   * once: rows shortened for display (`abc…xyz`) never matched, and a
   * governance action id has neither of those prefixes. When the sniff missed,
   * the gate did not complain — it fell back to a checkbox. A security control
   * that turns itself off without saying so is worse than not having it, since
   * the screen still reads as if the check happened. An action with genuinely
   * no destination to mistype (Abstain, No-Confidence, an Info action) leaves
   * this undefined and gets the checkbox on purpose.
   */
  target?: string;
  /** What to call `target` in the retype prompt, already translated. */
  targetLabel?: string;
};

export function GovernancePanel({
  port,
  network,
  changeAddress,
  uncertainHash,
  onUncertain,
  sentVoteDelegation,
  expiredVoteDelegation = null,
  onVoteDelegationSent,
  onVoteDelegationLanded,
}: {
  port: WalletPort;
  network: PhoenixNetwork;
  changeAddress: string;
  /**
   * A vote delegation in flight, from this tab or from the Staking tab's
   * Abstain, held by the parent above the tab switch. This panel unmounts
   * whenever another tab is opened, so a flag of its own would be gone on
   * return — and an Abstain sent on Staking would never be seen here at all,
   * leaving a bare "None" that invites a second, paid delegation. Absent
   * (`undefined`) when the panel runs standalone: it then keeps its own.
   */
  sentVoteDelegation?: SentVoteDelegation | null;
  /**
   * A vote delegation the parent dropped because it ran past its watch limit
   * without the chain showing it. Said once, while the chain still shows no
   * vote delegation. Optional: absent means none.
   */
  expiredVoteDelegation?: SentVoteDelegation | null;
  /**
   * Called when a vote delegation (any DRep, or Abstain / No-Confidence) is
   * signed here, so the Staking tab knows one is in flight and does not then
   * offer "Choose Abstain" and overwrite it. Optional: the panel also works
   * standalone, where no sibling tab needs to be told.
   */
  onVoteDelegationSent?: (sent: SentVoteDelegation) => void;
  /**
   * The sent vote-delegation transaction was found in a block, so the parent
   * drops its record (for that hash only) and both tabs stop waiting.
   * Optional for the same reason as above.
   */
  onVoteDelegationLanded?: (txHash: string) => void;
} & UncertainLock) {
  const { t } = useTranslation("wallet");
  // Standalone fallback only; under `WalletTabs` the parent's record is used.
  const [ownSentVote, setOwnSentVote] = useState<SentVoteDelegation | null>(null);
  const sentVote = sentVoteDelegation !== undefined ? sentVoteDelegation : ownSentVote;
  const recordVoteSent = useCallback(
    (sent: SentVoteDelegation) => {
      setOwnSentVote(sent);
      onVoteDelegationSent?.(sent);
    },
    [onVoteDelegationSent],
  );
  const recordVoteLanded = useCallback(
    (txHash: string) => {
      setOwnSentVote((cur) => (cur !== null && cur.txHash === txHash ? null : cur));
      onVoteDelegationLanded?.(txHash);
    },
    [onVoteDelegationLanded],
  );
  const [section, setSection] = useState<Section>("delegate");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [checked, setChecked] = useState(false);

  // dRep key-hash (CIP-95). null = not yet probed, "" = unavailable.
  const [drepKeyHash, setDrepKeyHash] = useState<string | null>(null);
  const [rewardBech32, setRewardBech32] = useState<string>("");

  const changeAddr = useMemo(
    () => tyUtils.getAddressFromHex(Buffer.from(changeAddress, "hex")) as tyTypes.ShelleyAddress,
    [changeAddress],
  );

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const rewardHex = await port.getRewardAddressHex();
        if (alive) setRewardBech32(rewardAddressFrom(rewardHex).getBech32());
      } catch {
        /* reward address unavailable — delegation still selectable, build will error clearly */
      }
      // The dRep key: a CIP-95 probe on the extension path, a derived chain-3
      // key on the local one. `getDrepKeyHashHex` answers null rather than
      // throwing, so a wallet without governance support still renders.
      const drepHash = await port.getDrepKeyHashHex();
      if (alive) setDrepKeyHash(drepHash ?? "");
    })();
    return () => {
      alive = false;
    };
  }, [port]);

  /** Load fresh inputs / params / ttl for a build. */
  const loadCtx = useCallback(async (): Promise<GovBuildCtx> => {
    const [inputs, protocolParams, tip] = await Promise.all([
      port.getInputs(),
      fetchProtocolParams(network),
      fetchTipSlot(network),
    ]);
    if (inputs.length === 0) throw new Error(t("no_utxos"));
    return {
      inputs,
      protocolParams,
      changeAddress: changeAddr,
      // Shared with the vote-delegation waiting line, which is timed off it.
      ttl: tip + VOTE_DELEGATION_TTL_SLOTS,
    };
  }, [port, network, changeAddr, t]);

  const resetReview = () => {
    setPending(null);
    setChecked(false);
  };

  const review = async (fn: () => Promise<Pending>) => {
    // Every build on this screen comes through here, across four tabs and a
    // dozen buttons, so this is the one place that can hold them all back while
    // a submit is unresolved. Disabling each button individually would mean
    // finding all of them, and the one that gets missed is the one that matters.
    // Said out loud rather than refused in silence: a button that does nothing
    // reads as broken, and a person who thinks the wallet is broken retries.
    if (uncertainHash !== null) {
      toastError(t("uncertain_blocked"));
      return;
    }
    setBusy(true);
    resetReview();
    try {
      setPending(await fn());
    } catch (err) {
      toastApiError(err);
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!pending) return;
    // Also guarded at `review()`, which is the door in. This is the door out,
    // and a review assembled before the lock came on would otherwise still be
    // signable from a screen that is already open.
    if (uncertainHash !== null) return toastError(t("uncertain_blocked"));
    setBusy(true);
    try {
      const hash = await port.signAndSubmit(pending.built, network);
      toastSuccess(pending.submittedKey ?? "gov_submitted", { hash: hash.slice(0, 12) });
      pending.onDone?.(hash);
      resetReview();
    } catch (err) {
      resetReview(); // drop the built tx: it already carries a witness; a retry must rebuild
      const outcome = reportSignError(err, t);
      if (outcome.kind === "uncertain") onUncertain(outcome.txHash);
    } finally {
      setBusy(false);
    }
  };

  const feeRow = (built: BuiltTx): SummaryRow => ({
    label: t("est_fee"),
    value: `${formatAda(BigInt(built.fee))} ADA`,
    mono: true,
  });

  // ── Review panel (shared) ────────────────────────────────────────────────────
  if (pending) {
    const netLabel = network === 1 ? t("net_mainnet") : network === 2 ? t("net_preview") : t("net_preprod");
    const govTarget = pending.target?.trim() ?? "";
    return (
      <div className="rounded-brand border border-border-soft bg-bg1 p-5 space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold">{pending.title}</p>
          <span
            className={
              "text-[11px] mono px-2 py-0.5 rounded-brand-sm border " +
              (network === 1
                ? "border-border-amber text-amber-brand bg-amber-brand/10"
                : "border-border-soft text-text-hint bg-bg0")
            }
          >
            {netLabel}
          </span>
        </div>
        <div className="rounded-brand-sm bg-bg0 p-3 text-sm space-y-2">
          {pending.rows.map((r, i) => (
            <div key={i} className="flex justify-between gap-3">
              <span className="text-text-hint shrink-0">{r.label}</span>
              {r.challenged && govTarget ? (
                <ChallengedValue value={govTarget} className="text-right break-all mono text-xs" />
              ) : (
                <span className={`text-right break-all ${r.mono ? "mono" : ""}`}>{r.value}</span>
              )}
            </div>
          ))}
        </div>
        {pending.warn && (
          <p className="text-xs text-amber-brand border border-border-amber rounded-brand-sm p-2">
            {pending.warn}
          </p>
        )}
        <ConfirmGate
          network={network}
          challenge={tailChallenge(govTarget)}
          challengeHint={pending.targetLabel ?? t("confirm_gate_hint_drep", { len: CHALLENGE_LEN })}
          checkboxLabel={t("gov_verify_checkbox")}
          confirmed={checked}
          onChange={setChecked}
        />
        <div className="flex gap-2">
          <button
            type="button"
            onClick={resetReview}
            className="flex-1 p-3 rounded-brand border border-border-soft bg-bg1 hover:bg-bg2 text-sm"
          >
            {t("cancel")}
          </button>
          <button
            type="button"
            disabled={busy || !checked}
            onClick={confirm}
            className="flex-1 p-3 rounded-brand border border-border-amber bg-amber-brand/10 hover:bg-amber-brand/20 text-sm text-amber-brand disabled:opacity-50"
          >
            {busy ? t("submitting") : t("gov_confirm")}
          </button>
        </div>
        <SignHint port={port} />
      </div>
    );
  }

  const tabs: { id: Section; label: string }[] = [
    { id: "delegate", label: t("gov_tab_delegate") },
    { id: "actions", label: t("gov_tab_actions") },
    { id: "become", label: t("gov_tab_become") },
    { id: "submit", label: t("gov_tab_submit") },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {tabs.map((tb) => (
          <button
            key={tb.id}
            type="button"
            onClick={() => setSection(tb.id)}
            className={`px-3 py-1.5 rounded-brand text-xs border ${
              section === tb.id
                ? "border-border-teal text-teal-brand bg-bg2"
                : "border-border-soft text-text-dim bg-bg1 hover:bg-bg2"
            }`}
          >
            {tb.label}
          </button>
        ))}
      </div>

      {section === "delegate" && (
        <DelegateSection
          network={network}
          rewardBech32={rewardBech32}
          busy={busy}
          onReview={review}
          loadCtx={loadCtx}
          feeRow={feeRow}
          sentVoteDelegation={sentVote}
          expiredVoteDelegation={expiredVoteDelegation}
          onVoteDelegationSent={recordVoteSent}
          onVoteDelegationLanded={recordVoteLanded}
        />
      )}
      {section === "actions" && (
        <ActionsSection
          network={network}
          drepKeyHash={drepKeyHash}
          busy={busy}
          onReview={review}
          loadCtx={loadCtx}
          feeRow={feeRow}
        />
      )}
      {section === "become" && (
        <BecomeSection
          network={network}
          drepKeyHash={drepKeyHash}
          busy={busy}
          onReview={review}
          loadCtx={loadCtx}
          feeRow={feeRow}
        />
      )}
      {section === "submit" && (
        <SubmitSection
          network={network}
          rewardBech32={rewardBech32}
          busy={busy}
          onReview={review}
          loadCtx={loadCtx}
          feeRow={feeRow}
        />
      )}
    </div>
  );
}

type SectionProps = {
  busy: boolean;
  onReview: (fn: () => Promise<Pending>) => Promise<void>;
  loadCtx: () => Promise<GovBuildCtx>;
  feeRow: (b: BuiltTx) => SummaryRow;
};

const card = "rounded-brand border border-border-soft bg-bg1 p-5 space-y-3";
const inputCls =
  "w-full rounded-brand-sm border border-border-soft bg-bg0 px-3 py-2 text-sm mono focus:border-border-amber outline-none";
const primaryBtn =
  "w-full p-3 rounded-brand border border-border-soft bg-bg1 hover:bg-bg2 text-sm disabled:opacity-50";
const short = (s: string) => (s.length > 24 ? `${s.slice(0, 12)}…${s.slice(-8)}` : s);

// ── Delegate voting power ───────────────────────────────────────────────────────
function DelegateSection({
  network,
  rewardBech32,
  busy,
  onReview,
  loadCtx,
  feeRow,
  sentVoteDelegation,
  expiredVoteDelegation,
  onVoteDelegationSent,
  onVoteDelegationLanded,
}: SectionProps & {
  network: PhoenixNetwork;
  rewardBech32: string;
  sentVoteDelegation: SentVoteDelegation | null;
  expiredVoteDelegation: SentVoteDelegation | null;
  onVoteDelegationSent: (sent: SentVoteDelegation) => void;
  onVoteDelegationLanded: (txHash: string) => void;
}) {
  const { t } = useTranslation("wallet");
  const [query, setQuery] = useState("");
  const [dreps, setDreps] = useState<DRepSummary[]>([]);
  const [searching, setSearching] = useState(false);
  const [current, setCurrent] = useState<string | null | undefined>(undefined);
  // The last DRep read failed (indexer down, or an answer without the DRep
  // field). Said on screen: a blank where "Currently delegated to" was is
  // read as "none", the sentence that invites a second, paid delegation.
  const [currentFailed, setCurrentFailed] = useState(false);
  /**
   * A delegation that was just submitted is not yet visible to the indexer —
   * it needs a block first. Showing the old delegation with no note reads as
   * "it did not work", which is what makes people delegate a second time.
   * The record is the parent's (`WalletTabs`), shared with the Staking tab, so
   * the line is there after a tab switch and after an Abstain sent on Staking.
   * It goes once the transaction itself is found in a block (looked up by
   * hash on the re-read timer; the parent then drops the record), once the
   * chain shows a DRep other than the one before sending, or once the
   * transaction's validity window has closed; past the "unseen" mark it says
   * the transaction most likely did not get in. The hash look-up is what
   * clears a re-delegation to the DRep already held, where the DRep read
   * cannot change.
   */
  const [now, setNow] = useState(() => Date.now());
  const voteWatch = voteDelegationWatch(sentVoteDelegation, rewardBech32 || null, network, now);
  const voteInFlight =
    voteWatch.kind !== "none" && !voteDelegationLanded(sentVoteDelegation, current);

  const reloadCurrent = useCallback(() => {
    if (!rewardBech32) return () => {};
    let alive = true;
    getVoteDelegationState(network, rewardBech32)
      // Not found = an account the chain has never seen: no DRep. A row
      // without the DRep field is not that — it throws, and stays "not read".
      .then((s) => {
        if (!alive) return;
        setCurrent(s.found ? s.delegatedDRep : null);
        setCurrentFailed(false);
      })
      .catch(() => {
        if (!alive) return;
        setCurrent(undefined);
        setCurrentFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [network, rewardBech32]);

  // The DRep read belongs to the network it was read on. Kept across a switch
  // of the network picker, the old network's DRep would sit on the new one's
  // screen (and become `drepBefore` of a choice sent there) until the new
  // read answers — or for good, if it fails. Declared before the re-read so it
  // runs first on a switch.
  useEffect(() => {
    setCurrent(undefined);
    setCurrentFailed(false);
  }, [network]);

  useEffect(() => reloadCurrent(), [reloadCurrent]);

  // While one is in flight: move the clock (pending → unseen → window closed)
  // and re-read the current DRep, so a landed choice clears the line by itself.
  // The same tick looks the sent transaction up by hash (read through a ref,
  // so a new record or callback does not restart the timer).
  const voteTxRef = useRef({ sent: sentVoteDelegation, onLanded: onVoteDelegationLanded });
  voteTxRef.current = { sent: sentVoteDelegation, onLanded: onVoteDelegationLanded };
  // The hash whose look-up has answered on this screen. The "not seen" line
  // waits for it: opened past the ten-minute mark, the tab must not say "not
  // seen" for a transaction it has not yet asked about.
  const [lookedUp, setLookedUp] = useState<string | null>(null);
  //
  // A hash found in a block lets the record go only once a fresh DRep read
  // SUCCEEDS and shows the choice that was sent (`voteDelegationConfirmed`).
  // Any non-null answer is not enough: the account endpoint can lag
  // `/tx_status`, and a lagging read still shows the DRep held before — a
  // different, non-null answer. A failed read is "not known". Otherwise the
  // record stays and the timer goes on (`lookUpVoteTx`).
  useEffect(() => {
    if (!voteInFlight) return;
    let cancelled = false;
    let release: () => void = () => {};
    let releaseTx: () => void = () => {};
    const confirmOnChain = (sent: SentVoteDelegation) =>
      getVoteDelegationState(sent.network, sent.account).then((s) => {
        const onChain = s.found ? s.delegatedDRep : null;
        if (!cancelled) setCurrent(onChain);
        return !cancelled && voteDelegationConfirmed(sent, onChain);
      });
    const lookUpNow = () => {
      releaseTx();
      releaseTx = lookUpVoteTx(
        voteTxRef.current.sent,
        fetchTxSeen,
        confirmOnChain,
        voteTxRef.current.onLanded,
        setLookedUp,
      );
    };
    // Once now, not one interval from now: a record that landed while the tab
    // was closed is found as the tab opens.
    lookUpNow();
    const timer = setInterval(() => {
      setNow(Date.now());
      release();
      release = reloadCurrent();
      lookUpNow();
    }, VOTE_PENDING_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
      release();
      releaseTx();
    };
  }, [voteInFlight, reloadCurrent]);

  const search = async () => {
    setSearching(true);
    try {
      setDreps(await listDReps(network, query));
    } catch (err) {
      toastApiError(err);
    } finally {
      setSearching(false);
    }
  };

  const delegate = (target: DelegationTarget, label: string) =>
    onReview(async () => {
      if (!rewardBech32) throw new Error(t("gov_no_reward_addr"));
      const ctx = await loadCtx();
      const built = buildVoteDelegation({
        rewardAddress: rewardAddressFrom(rewardBech32),
        target,
        ...ctx,
      });
      return {
        built,
        title: t("gov_review_delegate"),
        // Abstain and No-Confidence are chain-level constants, not addresses:
        // there is nothing to mistype and nothing to poison, so they keep the
        // checkbox. Delegating to a named dRep hands voting power to a specific
        // key, and that id is the thing worth retyping.
        target: target.kind === "drep" ? target.drepId : undefined,
        targetLabel: t("confirm_gate_hint_drep", { len: CHALLENGE_LEN }),
        rows: [
          {
            label: t("gov_delegate_to"),
            value: label,
            mono: target.kind === "drep",
            challenged: target.kind === "drep",
          },
          feeRow(built),
        ],
        submittedKey: "gov_delegation_submitted",
        // One is already on its way: sending this replaces it and pays a second
        // fee. Said on the review, not by disabling the buttons — changing the
        // choice is legitimate, it just should not happen by accident.
        warn:
          voteInFlight && sentVoteDelegation !== null
            ? t("gov_delegate_inflight_warn", { time: clockTime(sentVoteDelegation.sentAt) })
            : undefined,
        onDone: (txHash) => {
          // Tell the parent a vote delegation is in flight: this tab shows its
          // waiting line from that record, and the Staking tab stops offering
          // Abstain — which would overwrite the choice just made. `txHash` is
          // how either tab later finds it on chain; `current` is the chain's
          // answer before this one, a secondary "landed" signal when it changes.
          const sentAt = Date.now();
          setNow(sentAt);
          // `target` is what the chain must show before the record may end.
          // The hash is kept lower-case, the form the indexer answers in.
          onVoteDelegationSent({
            account: rewardBech32,
            network,
            sentAt,
            txHash: txHash.toLowerCase(),
            drepBefore: current,
            target: voteTargetId(target),
          });
          reloadCurrent();
        },
      };
    });

  return (
    <div className={card}>
      <p className="text-xs text-text-hint">{t("gov_delegate_help")}</p>
      {current !== undefined && (
        <p className="text-xs text-text-dim">
          {t("gov_current_delegation")}:{" "}
          {current === DREP_ALWAYS_ABSTAIN ? (
            <span>{t("gov_abstain")}</span>
          ) : current === DREP_ALWAYS_NO_CONFIDENCE ? (
            <span>{t("gov_no_confidence")}</span>
          ) : (
            <span className="mono">{current ? short(current) : t("gov_none")}</span>
          )}
        </p>
      )}
      {current === undefined && currentFailed && (
        <p className="text-xs text-amber-brand">{t("gov_current_read_failed")}</p>
      )}
      {voteInFlight && voteWatch.kind === "pending" && (
        <p className="text-xs text-amber-brand">{t("gov_delegate_pending")}</p>
      )}
      {voteInFlight &&
        voteWatch.kind === "unseen" &&
        sentVoteDelegation !== null &&
        lookedUp === sentVoteDelegation.txHash && (
        <p className="text-xs text-amber-brand">
          {t("vote_delegation_unseen", { time: clockTime(voteDelegationExpiresAt(sentVoteDelegation)) })}
        </p>
      )}
      {/* Ran out without the chain showing it, and the chain still reads no
          vote delegation: the choice did not happen, and may be made again. */}
      {!voteInFlight &&
        expiredVoteDelegation !== null &&
        expiredVoteDelegation.account === rewardBech32 &&
        expiredVoteDelegation.network === network &&
        current === null && (
          <p className="text-xs text-amber-brand">
            {t("vote_delegation_expired", { time: clockTime(expiredVoteDelegation.sentAt) })}
          </p>
        )}

      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => delegate({ kind: "abstain" }, t("gov_abstain"))}
          className="flex-1 px-3 py-2 rounded-brand border border-border-soft bg-bg1 hover:bg-bg2 text-xs disabled:opacity-50"
        >
          {t("gov_abstain")}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => delegate({ kind: "noConfidence" }, t("gov_no_confidence"))}
          className="flex-1 px-3 py-2 rounded-brand border border-border-soft bg-bg1 hover:bg-bg2 text-xs disabled:opacity-50"
        >
          {t("gov_no_confidence")}
        </button>
      </div>

      <div className="flex gap-2">
        <input
          className={inputCls}
          placeholder={t("gov_search_drep")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="button" disabled={searching} onClick={search} className={`${primaryBtn} w-auto px-4`}>
          {searching ? t("gov_searching") : t("gov_search")}
        </button>
      </div>

      <div className="space-y-2 max-h-72 overflow-y-auto">
        {dreps.map((d) => (
          <div
            key={d.drepId}
            className="rounded-brand-sm border border-border-soft bg-bg0 p-3 text-xs space-y-1"
          >
            <div className="mono break-all text-text">{d.drepId}</div>
            <div className="flex justify-between text-text-hint">
              <span>
                {t("gov_voting_power")}:{" "}
                {d.votingPower ? `${formatAda(BigInt(d.votingPower))} ADA` : "—"}
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() => delegate({ kind: "drep", drepId: d.drepId }, d.drepId)}
                className="px-3 py-1 rounded-brand border border-border-teal text-teal-brand hover:bg-bg2 disabled:opacity-50"
              >
                {t("gov_delegate")}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Governance actions + vote ────────────────────────────────────────────────────
function ActionsSection({
  network,
  drepKeyHash,
  busy,
  onReview,
  loadCtx,
  feeRow,
}: SectionProps & { network: PhoenixNetwork; drepKeyHash: string | null }) {
  const { t } = useTranslation("wallet");
  const [actions, setActions] = useState<GovActionSummary[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const all = await listGovActions(network);
      setActions(all.filter((a) => a.isOpen));
    } catch (err) {
      toastApiError(err);
    } finally {
      setLoading(false);
    }
  }, [network]);

  useEffect(() => {
    load();
  }, [load]);

  const canVote = !!drepKeyHash;

  const vote = (a: GovActionSummary, v: tyTypes.VoteType, vLabel: string) =>
    onReview(async () => {
      if (!drepKeyHash) throw new Error(t("gov_no_drep_key"));
      const ctx = await loadCtx();
      const built = buildVote({
        voter: parseDRepId(drepKeyHash),
        govActionId: parseGovActionId(a.id),
        vote: v,
        ...ctx,
      });
      return {
        built,
        title: t("gov_review_vote"),
        // The action id is the destination of a vote. It used to escape the
        // gate entirely — it carries no `drep1`/`addr1` prefix, so the old row
        // sniff never recognised it and the screen quietly served a checkbox
        // while still telling the user to verify the id.
        target: a.id,
        targetLabel: t("confirm_gate_hint_action", { len: CHALLENGE_LEN }),
        rows: [
          { label: t("gov_action"), value: a.title ?? a.type, mono: false },
          // Show the FULL action id, not a truncation: the title/type come from
          // an external indexer (spoofable), but the id is what actually gets
          // signed. The user must be able to verify exactly what they vote on.
          { label: t("gov_action_id"), value: a.id, mono: true, challenged: true },
          { label: t("gov_your_vote"), value: vLabel },
          feeRow(built),
        ],
        warn: t("gov_verify_action_id"),
      };
    });

  return (
    <div className={card}>
      <div className="flex items-center justify-between">
        <p className="text-xs text-text-hint">{t("gov_actions_help")}</p>
        <button type="button" disabled={loading} onClick={load} className="text-xs text-teal-brand">
          {loading ? t("gov_searching") : t("gov_refresh")}
        </button>
      </div>
      {!canVote && (
        <p className="text-xs text-amber-brand border border-border-amber rounded-brand-sm p-2">
          {t("gov_vote_needs_drep")}
        </p>
      )}
      {actions.length === 0 && !loading && (
        <p className="text-xs text-text-dim">{t("gov_no_actions")}</p>
      )}
      <div className="space-y-2 max-h-96 overflow-y-auto">
        {actions.map((a) => (
          <div
            key={a.id}
            className="rounded-brand-sm border border-border-soft bg-bg0 p-3 text-xs space-y-2"
          >
            <div className="font-semibold text-text">{a.title ?? a.type}</div>
            <div className="text-text-hint">{a.type}</div>
            {a.abstract && <div className="text-text-dim line-clamp-3">{a.abstract}</div>}
            <div className="mono text-text-hint break-all">{short(a.id)}</div>
            <div className="flex gap-2 pt-1">
              {(
                [
                  [tyTypes.VoteType.YES, t("gov_vote_yes"), "border-border-teal text-teal-brand"],
                  [tyTypes.VoteType.NO, t("gov_vote_no"), "border-border-amber text-amber-brand"],
                  [tyTypes.VoteType.ABSTAIN, t("gov_vote_abstain"), "border-border-soft text-text-dim"],
                ] as const
              ).map(([v, label, cls]) => (
                <button
                  key={label}
                  type="button"
                  disabled={busy || !canVote}
                  onClick={() => vote(a, v, label)}
                  className={`flex-1 px-2 py-1 rounded-brand border ${cls} hover:bg-bg2 disabled:opacity-40`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Become a dRep ────────────────────────────────────────────────────────────────
function BecomeSection({
  network,
  drepKeyHash,
  busy,
  onReview,
  loadCtx,
  feeRow,
}: SectionProps & { network: PhoenixNetwork; drepKeyHash: string | null }) {
  const { t } = useTranslation("wallet");
  const [metaUrl, setMetaUrl] = useState("");
  const [metaHash, setMetaHash] = useState("");

  const depositLovelace = useCallback(async (): Promise<BigNumber> => {
    const dep = await fetchGovDeposit(network, "drep_deposit");
    if (dep == null) throw new Error(t("gov_deposit_unknown"));
    return dep;
  }, [network, t]);

  const register = () =>
    onReview(async () => {
      if (!drepKeyHash) throw new Error(t("gov_no_drep_key"));
      const [ctx, deposit] = await Promise.all([loadCtx(), depositLovelace()]);
      const anchor =
        metaUrl.trim() && metaHash.trim() ? makeAnchor(metaUrl.trim(), metaHash.trim()) : null;
      const built = buildDRepRegistration({
        drepKeyHash: Buffer.from(drepKeyHash, "hex"),
        deposit,
        anchor,
        ...ctx,
      });
      return {
        built,
        title: t("gov_review_register"),
        // No `target`, and that is deliberate rather than an oversight: the dRep
        // key hash here is the user's OWN, probed from their wallet, so there is
        // no destination an attacker could swap and nothing a retype would
        // verify. The deposit is the thing to look at, and the checkbox plus the
        // refundable-deposit warning is the right weight for it.
        rows: [
          { label: t("gov_drep_id"), value: short(drepKeyHash), mono: true },
          { label: t("gov_deposit"), value: `${formatAda(BigInt(deposit.toString()))} ADA`, mono: true },
          { label: t("gov_metadata"), value: anchor ? short(anchor.url) : t("gov_none") },
          feeRow(built),
        ],
        warn: t("gov_deposit_refundable"),
      };
    });

  const deregister = () =>
    onReview(async () => {
      if (!drepKeyHash) throw new Error(t("gov_no_drep_key"));
      const [ctx, deposit] = await Promise.all([loadCtx(), depositLovelace()]);
      const built = buildDRepDeRegistration({
        drepKeyHash: Buffer.from(drepKeyHash, "hex"),
        deposit,
        ...ctx,
      });
      return {
        built,
        title: t("gov_review_deregister"),
        rows: [
          { label: t("gov_drep_id"), value: short(drepKeyHash), mono: true },
          { label: t("gov_refund"), value: `${formatAda(BigInt(deposit.toString()))} ADA`, mono: true },
          feeRow(built),
        ],
      };
    });

  if (!drepKeyHash) {
    return (
      <div className={card}>
        <p className="text-sm font-semibold">{t("gov_tab_become")}</p>
        <p className="text-xs text-amber-brand border border-border-amber rounded-brand-sm p-2">
          {t("gov_register_needs_drep")}
        </p>
      </div>
    );
  }

  return (
    <div className={card}>
      <p className="text-xs text-text-hint">{t("gov_become_help")}</p>
      <div className="text-xs text-text-dim">
        {t("gov_drep_id")}: <span className="mono break-all">{drepKeyHash}</span>
      </div>
      <label className="block">
        <span className="text-xs text-text-hint">{t("gov_metadata_url")}</span>
        <input
          className={inputCls}
          placeholder="https://…/drep.jsonld"
          value={metaUrl}
          onChange={(e) => setMetaUrl(e.target.value)}
        />
      </label>
      <label className="block">
        <span className="text-xs text-text-hint">{t("gov_metadata_hash")}</span>
        <input
          className={inputCls}
          placeholder="blake2b-256 hex"
          value={metaHash}
          onChange={(e) => setMetaHash(e.target.value)}
        />
      </label>
      <div className="flex gap-2">
        <button type="button" disabled={busy} onClick={register} className={primaryBtn}>
          {t("gov_register")}
        </button>
        <button type="button" disabled={busy} onClick={deregister} className={primaryBtn}>
          {t("gov_deregister")}
        </button>
      </div>
    </div>
  );
}

// ── Submit a governance action (advanced) ────────────────────────────────────────
function SubmitSection({
  network,
  rewardBech32,
  busy,
  onReview,
  loadCtx,
  feeRow,
}: SectionProps & { network: PhoenixNetwork; rewardBech32: string }) {
  const { t } = useTranslation("wallet");
  const [kind, setKind] = useState<"info" | "treasury">("info");
  const [metaUrl, setMetaUrl] = useState("");
  const [metaHash, setMetaHash] = useState("");
  const [wAmount, setWAmount] = useState(""); // treasury withdrawal ADA
  const [wTarget, setWTarget] = useState(""); // stake address receiving the withdrawal

  const govDeposit = useCallback(async (): Promise<BigNumber> => {
    const dep = await fetchGovDeposit(network, "gov_action_deposit");
    if (dep == null) throw new Error(t("gov_deposit_unknown"));
    return dep;
  }, [network, t]);

  const submit = () =>
    onReview(async () => {
      if (!rewardBech32) throw new Error(t("gov_no_reward_addr"));
      if (!metaUrl.trim() || !metaHash.trim()) throw new Error(t("gov_metadata_required"));
      const [ctx, deposit] = await Promise.all([loadCtx(), govDeposit()]);
      const rewardAccount = rewardAddressFrom(rewardBech32);
      const anchor = makeAnchor(metaUrl.trim(), metaHash.trim());

      const action =
        kind === "info"
          ? infoAction()
          : treasuryWithdrawalAction([
              {
                rewardAccount: rewardAddressFrom(wTarget.trim() || rewardBech32),
                amount: adaToLovelace(wAmount, t),
              },
            ]);

      const built = buildProposal({ deposit, rewardAccount, govAction: action, anchor, ...ctx });
      const rows: SummaryRow[] = [
        { label: t("gov_action_kind"), value: kind === "info" ? t("gov_info_action") : t("gov_treasury_action") },
        { label: t("gov_deposit"), value: `${formatAda(BigInt(deposit.toString()))} ADA`, mono: true },
        { label: t("gov_metadata"), value: short(anchor.url) },
      ];
      if (kind === "treasury") {
        rows.splice(
          1,
          0,
          { label: t("gov_withdraw_amount"), value: `${wAmount} ADA`, mono: true },
          // The destination of a treasury withdrawal must be visible in the
          // review — never let the recipient be implicit.
          {
            label: t("gov_withdraw_target"),
            value: wTarget.trim() || rewardBech32,
            mono: true,
            challenged: true,
          },
        );
      }
      rows.push(feeRow(built));
      return {
        built,
        title: t("gov_review_submit"),
        rows,
        // An Info action moves nothing and names no recipient. A treasury
        // withdrawal names the account the money lands in, and the prompt used
        // to call that account "the dRep id" — sending the user to look for
        // something that was not on the screen.
        target: kind === "treasury" ? wTarget.trim() || rewardBech32 : undefined,
        targetLabel: t("confirm_gate_hint_withdraw", { len: CHALLENGE_LEN }),
        warn: t("gov_deposit_refundable"),
        // Clear the form once the proposal is on its way. Every governance
        // action locks a fresh deposit, so a form left filled is a standing
        // invitation to pay twice for the same proposal.
        onDone: () => {
          setMetaUrl("");
          setMetaHash("");
          setWAmount("");
          setWTarget("");
        },
      };
    });

  return (
    <div className={card}>
      <p className="text-xs text-amber-brand border border-border-amber rounded-brand-sm p-2">
        {t("gov_submit_advanced")}
      </p>
      <label className="block">
        <span className="text-xs text-text-hint">{t("gov_action_kind")}</span>
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as "info" | "treasury")}
          className="w-full rounded-brand-sm border border-border-soft bg-bg0 px-2 py-2 text-sm"
        >
          <option value="info">{t("gov_info_action")}</option>
          <option value="treasury">{t("gov_treasury_action")}</option>
        </select>
      </label>
      {kind === "treasury" && (
        <>
          <label className="block">
            <span className="text-xs text-text-hint">{t("gov_withdraw_amount")}</span>
            <input className={inputCls} inputMode="decimal" placeholder="1000000" value={wAmount} onChange={(e) => setWAmount(e.target.value)} />
          </label>
          <label className="block">
            <span className="text-xs text-text-hint">{t("gov_withdraw_target")}</span>
            <input className={inputCls} placeholder="stake1… (default: your reward addr)" value={wTarget} onChange={(e) => setWTarget(e.target.value)} />
          </label>
        </>
      )}
      <label className="block">
        <span className="text-xs text-text-hint">{t("gov_metadata_url")}</span>
        <input className={inputCls} placeholder="https://…/action.jsonld" value={metaUrl} onChange={(e) => setMetaUrl(e.target.value)} />
      </label>
      <label className="block">
        <span className="text-xs text-text-hint">{t("gov_metadata_hash")}</span>
        <input className={inputCls} placeholder="blake2b-256 hex" value={metaHash} onChange={(e) => setMetaHash(e.target.value)} />
      </label>
      <button type="button" disabled={busy} onClick={submit} className={primaryBtn}>
        {t("gov_submit_action")}
      </button>
    </div>
  );
}

function adaToLovelace(v: string, t: (k: string) => string): BigNumber {
  if (!/^\d+(\.\d{1,6})?$/.test(v.trim())) throw new Error(t("invalid_amount"));
  const [whole, frac = ""] = v.trim().split(".");
  return new BigNumber(whole).times(1000000).plus(frac.padEnd(6, "0") || "0");
}
