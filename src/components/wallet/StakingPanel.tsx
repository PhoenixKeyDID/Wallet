"use client";

import "../../lib/node-globals";
import { useEffect, useRef, useState } from "react";
import { Buffer } from "buffer";
import { useTranslation } from "react-i18next";
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
} from "@/lib/cardano";
import {
  searchPools,
  getStakeAccountState,
  buildDelegation,
  buildWithdrawal,
  rewardAddressFromHex,
  type PoolSummary,
  type StakeAccountState,
} from "@/lib/cardano/staking";
import { DREP_ALWAYS_ABSTAIN, buildVoteDelegation } from "@/lib/cardano/governance";
import {
  DELEGATION_WATCH_LIMIT_MS,
  VOTE_DELEGATION_TTL_SLOTS,
  clockTime,
  delegationWatch,
  lookUpVoteTx,
  voteDelegationConfirmed,
  voteDelegationExpiresAt,
  voteDelegationWatch,
  type SentDelegation,
  type SentVoteDelegation,
} from "@/components/wallet/delegationFeedback";

/**
 * Held by the parent, above the tab switch: this panel unmounts whenever
 * another tab is opened, and the waiting line must still be there on return.
 */
export type DelegationSentProps = {
  sentDelegation: SentDelegation | null;
  onDelegationSent: (sent: SentDelegation) => void;
  onDelegationSettled: () => void;
  /**
   * A vote (DRep) delegation just sent — from here, or from the Governance tab.
   * Held by the parent, above the tab switch, so this panel offering "Choose
   * Abstain" cannot forget that one is already in flight (which would charge a
   * second fee) or overwrite a DRep choice the Governance tab just made.
   */
  sentVoteDelegation: SentVoteDelegation | null;
  onVoteDelegationSent: (sent: SentVoteDelegation) => void;
  /**
   * The sent vote-delegation transaction was found in a block: the parent
   * drops the record (for that hash only), which clears the waiting line here
   * and on the Governance tab.
   */
  onVoteDelegationLanded: (txHash: string) => void;
  /**
   * A vote delegation that ran past its watch limit without the chain showing
   * it (the parent drops it then). Said once, so the reader knows the choice
   * did not happen and may be made again. Optional: absent means none.
   */
  expiredVoteDelegation?: SentVoteDelegation | null;
};

/** How often the account is re-read while a delegation waits to be recorded. */
const PENDING_POLL_MS = 20_000;

type PoolReview = { pool: PoolSummary; needsRegistration: boolean; built: BuiltTx };
type WithdrawReview = { amount: bigint; built: BuiltTx };
type AbstainReview = { built: BuiltTx };

/**
 * Search pools, delegate, and withdraw rewards via the connected CIP-30
 * wallet. Two-step everywhere a certificate/withdrawal gets signed: Review
 * (unsigned tx assembled, plain-language summary) → Confirm (sign + submit).
 *
 * Single-pool only — see the MULTI-POOL note in the build report for why
 * Lace-style multi-pool delegation needs multiple stake keys, which a single
 * connected CIP-30 account cannot express for keys it doesn't hold.
 *
 * Beta: same unaudited caveat as `SendForm`. Uses the stake key the
 * connected wallet reports via `getRewardAddresses()[0]` — never an invented key.
 */
export function StakingPanel({
  port,
  network,
  changeAddress,
  uncertainHash,
  onUncertain,
  sentDelegation,
  onDelegationSent,
  onDelegationSettled,
  sentVoteDelegation,
  onVoteDelegationSent,
  onVoteDelegationLanded,
  expiredVoteDelegation = null,
}: {
  port: WalletPort;
  network: PhoenixNetwork;
  changeAddress: string;
} & UncertainLock &
  DelegationSentProps) {
  const { t } = useTranslation("wallet");

  const [rewardAddressHex, setRewardAddressHex] = useState<string | null>(null);
  const [rewardAddressBech32, setRewardAddressBech32] = useState<string | null>(null);
  const [accountState, setAccountState] = useState<StakeAccountState | null>(null);
  const [loadingAccount, setLoadingAccount] = useState(true);
  // Distinguish "couldn't read stake status" from a genuine "not delegated / 0
  // rewards" — an indexer hiccup must not masquerade as lost stake.
  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const netLabel = network === 1 ? t("net_mainnet") : network === 2 ? t("net_preview") : t("net_preprod");

  const [query, setQuery] = useState("");
  const [pools, setPools] = useState<PoolSummary[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);

  const [poolReview, setPoolReview] = useState<PoolReview | null>(null);
  const [withdrawReview, setWithdrawReview] = useState<WithdrawReview | null>(null);
  const [abstainReview, setAbstainReview] = useState<AbstainReview | null>(null);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  // A sent delegation is kept until the chain shows it, so the screen says
  // "waiting" instead of the stale "Not delegated". `now` moves with the poll,
  // which is what lets "waiting" turn into "not seen" when it has gone on too long.
  const [now, setNow] = useState(() => Date.now());
  const watch = delegationWatch(
    sentDelegation,
    rewardAddressBech32,
    network,
    accountState?.delegatedPoolId,
    now,
  );

  // Read the wallet's own reward address + its on-chain state once on mount.
  // `getRewardAddresses()` is the only source of a stake key here — a wallet
  // this page did not derive can only sign for the key it reports.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingAccount(true);
      // The account read belongs to the network it was read on. Kept across a
      // switch of the network picker, the old network's answer would enable
      // Delegate and decide `needsRegistration` for the new one — a
      // registration the node rejects, or a 2 ADA deposit that is not real.
      // Until the new network answers there is no answer; and a late answer
      // from the old network is dropped by `cancelled` below.
      setAccountState(null);
      setLoadError(false);
      try {
        const hex = await port.getRewardAddressHex();
        const bech32Addr = rewardAddressFromHex(hex).getBech32();
        if (cancelled) return;
        setRewardAddressHex(hex);
        setRewardAddressBech32(bech32Addr);
        const state = await getStakeAccountState(network, bech32Addr);
        if (!cancelled) setAccountState(state);
      } catch (err) {
        if (!cancelled) {
          setLoadError(true);
          toastApiError(err);
        }
      } finally {
        if (!cancelled) setLoadingAccount(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [port, network, reloadKey]);

  // The network on screen now. `refreshAccountState` runs after a signature,
  // from a closure made before it — the network picker can have moved while
  // the signer was open, and the old network's answer must not land on the
  // new network's screen (it would enable Withdraw with rewards that are not
  // there). Compared after the read, and the stale answer is dropped.
  const networkRef = useRef(network);
  networkRef.current = network;

  const refreshAccountState = async () => {
    if (!rewardAddressBech32) return;
    const readOn = network;
    try {
      const state = await getStakeAccountState(readOn, rewardAddressBech32);
      if (networkRef.current !== readOn) return; // switched while reading: not this screen's answer
      setAccountState(state);
      setLoadError(false);
    } catch (err) {
      if (networkRef.current !== readOn) return;
      setLoadError(true);
      toastApiError(err);
    }
  };

  // A review built on one network must not stay signable on another, and a
  // pool list searched on one is not the other's. Cleared on a switch of the
  // network picker, with the confirm tick that went with the review.
  useEffect(() => {
    setAbstainReview(null);
    setWithdrawReview(null);
    setPoolReview(null);
    setChecked(false);
    setPools([]);
    setSearched(false);
  }, [network]);

  // The chain shows it: nothing left to wait for.
  useEffect(() => {
    if (watch.kind === "settled") onDelegationSettled();
    // The callback is the parent's setter wrapper; re-running on its identity
    // would add nothing the kind does not already say.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watch.kind]);

  // Re-read the account while the delegation can still land: through "pending"
  // and on through "unseen", so a late block clears the warning by itself, and
  // stop once its validity window has surely closed. A failed read leaves the
  // line up, which is true: it is still waiting. A read that works after a
  // failed one clears the error box.
  const waiting =
    (watch.kind === "pending" || watch.kind === "unseen") &&
    sentDelegation !== null &&
    now - sentDelegation.sentAt < DELEGATION_WATCH_LIMIT_MS;
  useEffect(() => {
    if (!waiting || !rewardAddressBech32) return;
    let cancelled = false;
    const timer = setInterval(() => {
      setNow(Date.now());
      getStakeAccountState(network, rewardAddressBech32)
        .then((state) => {
          if (cancelled) return;
          setAccountState(state);
          setLoadError(false);
        })
        .catch(() => {});
    }, PENDING_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [waiting, network, rewardAddressBech32]);

  // A vote delegation (Abstain here, or any choice on the Governance tab) is
  // in flight and the chain has not shown it yet. Held by the parent, so it
  // survives this panel unmounting on a tab switch. While it holds, the Abstain
  // offer is suppressed and the account is re-read on a timer, until the chain
  // shows a vote delegation or the transaction's validity window has closed
  // (`VOTE_DELEGATION_WATCH_LIMIT_MS`, derived from the TTL the build uses).
  // Past `DELEGATION_UNSEEN_MS` the waiting line turns into "not seen": it most
  // likely did not get in, but can still land until the window closes, so the
  // offer stays suppressed and the re-read goes on. An account whose read failed
  // (`accountState` null) counts as "chain shows none" — the line must outlive
  // a failed read, or the next press sends a second one.
  const voteWatch = voteDelegationWatch(sentVoteDelegation, rewardAddressBech32, network, now);
  const voteInFlight = voteWatch.kind !== "none" && accountState?.delegatedDRep == null;
  // Read through a ref so a new parent callback does not restart the timer.
  const voteTxRef = useRef({ sent: sentVoteDelegation, onLanded: onVoteDelegationLanded });
  voteTxRef.current = { sent: sentVoteDelegation, onLanded: onVoteDelegationLanded };
  // The hash whose look-up has answered here; the "not seen" line waits for it
  // (see the Governance tab's twin).
  const [lookedUp, setLookedUp] = useState<string | null>(null);
  // The same tick also looks the sent transaction up by hash: found in a block
  // means landed, whatever the account's DRep reads, and the parent drops the
  // record — the only test that works for a re-delegation to the same DRep.
  //
  // Found by hash is not enough on its own: the account read can come from a
  // Koios instance that has not caught up, and clearing the record then brings
  // back "no DRep" with Abstain armed. So a hit re-reads the account, and only
  // a read that shows the choice that was sent lets the record go
  // (`voteDelegationConfirmed`) — a DRep read from a lagging instance can be
  // the one held before a Governance-tab change; otherwise the record stays
  // and the timer keeps going (`lookUpVoteTx`).
  useEffect(() => {
    if (!voteInFlight || !rewardAddressBech32) return;
    let cancelled = false;
    let releaseTx: () => void = () => {};
    const confirmOnChain = (sent: SentVoteDelegation) =>
      getStakeAccountState(sent.network, sent.account).then((state) => {
        if (cancelled || networkRef.current !== sent.network) return false;
        setAccountState(state);
        setLoadError(false);
        return voteDelegationConfirmed(sent, state.delegatedDRep);
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
    // Once now, not one interval from now (see the Governance tab's twin).
    lookUpNow();
    const timer = setInterval(() => {
      setNow(Date.now());
      getStakeAccountState(network, rewardAddressBech32)
        .then((state) => {
          if (cancelled) return;
          setAccountState(state);
          setLoadError(false);
        })
        .catch(() => {});
      lookUpNow();
    }, PENDING_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
      releaseTx();
    };
  }, [voteInFlight, network, rewardAddressBech32]);

  const runSearch = async () => {
    setSearching(true);
    setSearched(true);
    try {
      setPools(await searchPools(network, query));
    } catch (err) {
      toastApiError(err);
      setPools([]);
    } finally {
      setSearching(false);
    }
  };

  const prepareInputs = async () => {
    const [inputs, params, tip] = await Promise.all([
      port.getInputs(),
      fetchProtocolParams(network),
      fetchTipSlot(network),
    ]);
    if (inputs.length === 0) throw new Error(t("no_utxos"));
    const changeAddr = tyUtils.getAddressFromHex(
      Buffer.from(changeAddress, "hex"),
    ) as tyTypes.ShelleyAddress;
    return { inputs, changeAddr, params, tip };
  };

  const reviewDelegate = async (pool: PoolSummary) => {
    // Returning silently here made the button look broken: the user pressed
    // "delegate", nothing moved, and nothing said why. The reward address is
    // still being read from the wallet — say so.
    if (!rewardAddressHex) return toastError(t("reward_addr_not_ready"));
    // Whether the stake key is registered is read from the chain. Until that
    // read lands — still loading, or failed — there is no answer, and guessing
    // "not registered" attaches a registration certificate the node rejects for
    // a key that already is one, behind a review showing a 2 ADA deposit that
    // would never be taken. The button is disabled in that state; this is the
    // refusal behind it.
    if (accountState === null) {
      return toastError(t(loadError ? "stake_read_failed" : "reward_addr_not_ready"));
    }
    setBusy(true);
    try {
      const { inputs, changeAddr, params, tip } = await prepareInputs();
      const needsRegistration = !accountState.registered;
      const built = buildDelegation({
        rewardAddress: rewardAddressHex,
        poolId: pool.poolId,
        needsRegistration,
        inputs,
        changeAddress: changeAddr,
        protocolParams: params,
        tip,
      });
      setPoolReview({ pool, needsRegistration, built });
      setChecked(false);
    } catch (err) {
      toastApiError(err);
    } finally {
      setBusy(false);
    }
  };

  const confirmDelegate = async () => {
    if (!poolReview) return;
    // See `SendPanel.signSubmit`: the disabled button is the hint, this is the
    // refusal. Both spend paths on this screen carry it, because a lock that
    // covers one of two ways out covers neither.
    if (uncertainHash !== null) return toastError(t("uncertain_blocked"));
    setBusy(true);
    try {
      const hash = await port.signAndSubmit(poolReview.built, network);
      toastSuccess("delegate_submitted", { hash: hash.slice(0, 12) });
      if (rewardAddressBech32) {
        const sentAt = Date.now();
        setNow(sentAt);
        onDelegationSent({ poolId: poolReview.pool.poolId, account: rewardAddressBech32, network, sentAt });
      }
      setPoolReview(null);
      setChecked(false);
      setPools([]);
      setQuery("");
      setSearched(false);
      await refreshAccountState();
    } catch (err) {
      // Same reasoning as SendForm: a failed submit may already carry the
      // extension's witness, so drop the built tx rather than retry-signing it.
      setPoolReview(null);
      setChecked(false);
      const outcome = reportSignError(err, t);
      if (outcome.kind === "uncertain") onUncertain(outcome.txHash);
    } finally {
      setBusy(false);
    }
  };

  const reviewWithdraw = async () => {
    if (!rewardAddressHex) return toastError(t("reward_addr_not_ready"));
    if (!accountState || accountState.rewardsAvailable <= BigInt("0")) return;
    // The node rejects a withdrawal from an account with no vote delegation.
    // Building it anyway would show a fee for a transaction that cannot land.
    if (accountState.delegatedDRep === null) return toastError(t("withdraw_needs_drep"));
    setBusy(true);
    try {
      const { inputs, changeAddr, params, tip } = await prepareInputs();
      const built = buildWithdrawal({
        rewardAddress: rewardAddressHex,
        amount: accountState.rewardsAvailable,
        inputs,
        changeAddress: changeAddr,
        protocolParams: params,
        tip,
      });
      setWithdrawReview({ amount: accountState.rewardsAvailable, built });
      setChecked(false);
    } catch (err) {
      toastApiError(err);
    } finally {
      setBusy(false);
    }
  };

  const confirmWithdraw = async () => {
    if (!withdrawReview) return;
    if (uncertainHash !== null) return toastError(t("uncertain_blocked"));
    setBusy(true);
    try {
      const hash = await port.signAndSubmit(withdrawReview.built, network);
      toastSuccess("withdraw_submitted", { hash: hash.slice(0, 12) });
      setWithdrawReview(null);
      setChecked(false);
      await refreshAccountState();
    } catch (err) {
      setWithdrawReview(null);
      setChecked(false);
      const outcome = reportSignError(err, t);
      if (outcome.kind === "uncertain") onUncertain(outcome.txHash);
    } finally {
      setBusy(false);
    }
  };

  const reviewAbstain = async () => {
    if (!rewardAddressHex) return toastError(t("reward_addr_not_ready"));
    setBusy(true);
    try {
      const { inputs, changeAddr, params, tip } = await prepareInputs();
      const built = buildVoteDelegation({
        rewardAddress: rewardAddressFromHex(rewardAddressHex),
        target: { kind: "abstain" },
        inputs,
        changeAddress: changeAddr,
        protocolParams: params,
        // The waiting line after submit is timed off this same constant.
        ttl: tip + VOTE_DELEGATION_TTL_SLOTS,
      });
      setAbstainReview({ built });
      setChecked(false);
    } catch (err) {
      toastApiError(err);
    } finally {
      setBusy(false);
    }
  };

  const confirmAbstain = async () => {
    if (!abstainReview) return;
    // A third way to sign on this screen, so it carries the same refusal.
    if (uncertainHash !== null) return toastError(t("uncertain_blocked"));
    setBusy(true);
    try {
      // Lower-case, the form the indexer answers in: a CIP-30 wallet may
      // return the hash in capitals, and the look-up compares it as text.
      const hash = (await port.signAndSubmit(abstainReview.built, network)).toLowerCase();
      toastSuccess("withdraw_abstain_submitted", { hash: hash.slice(0, 12) });
      const sentAt = Date.now();
      setNow(sentAt);
      if (rewardAddressBech32) {
        onVoteDelegationSent({
          account: rewardAddressBech32,
          network,
          sentAt,
          txHash: hash,
          drepBefore: accountState ? accountState.delegatedDRep : undefined,
          target: DREP_ALWAYS_ABSTAIN,
        });
      } else {
        // Sent, but with no account to file it under, nothing on screen will
        // hold the Abstain offer back. Said, so the next press is not taken
        // for a first one.
        toastError(t("vote_delegation_untracked", { hash: hash.slice(0, 12) }));
      }
      setAbstainReview(null);
      setChecked(false);
    } catch (err) {
      setAbstainReview(null);
      setChecked(false);
      const outcome = reportSignError(err, t);
      if (outcome.kind === "uncertain") onUncertain(outcome.txHash);
    } finally {
      setBusy(false);
    }
  };

  const inputCls =
    "w-full rounded-brand-sm border border-border-soft bg-bg0 px-3 py-2 text-sm focus:border-border-amber outline-none";
  const shortPoolId = (id: string) => (id.length > 20 ? `${id.slice(0, 10)}…${id.slice(-6)}` : id);

  // ── Delegation review / confirm ────────────────────────────────────────────
  if (poolReview) {
    const { pool, needsRegistration, built } = poolReview;
    return (
      <div className="rounded-brand border border-border-soft bg-bg1 p-5 space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold">{t("delegate_review_title")}</p>
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
          <div className="flex justify-between gap-3">
            <span className="text-text-hint shrink-0">{t("delegate_to_pool")}</span>
            <span className="text-right">
              {pool.ticker ? `[${pool.ticker}] ` : ""}
              {pool.name || shortPoolId(pool.poolId)}
            </span>
          </div>
          {/* Ticker/name come from an external indexer (spoofable). Show the full
              pool id — the cryptographic destination — so it can be verified. */}
          <div className="flex justify-between gap-3 border-t border-border-soft pt-2">
            <span className="text-text-hint shrink-0">{t("pool_id_label")}</span>
            <ChallengedValue value={pool.poolId} className="text-right mono text-xs break-all" />
          </div>
          {needsRegistration && (
            <div className="flex justify-between border-t border-border-soft pt-2">
              <span className="text-text-hint">{t("key_deposit_label")}</span>
              <span className="font-semibold">
                {formatAda(BigInt(built.transaction.protocolParams.stakeKeyDeposit.toString()))} ADA
              </span>
            </div>
          )}
          <div className="flex justify-between border-t border-border-soft pt-2">
            <span className="text-text-hint">{t("est_fee")}</span>
            <span>{formatAda(BigInt(built.fee))} ADA</span>
          </div>
        </div>
        {needsRegistration && (
          <p className="text-xs text-text-hint">{t("registration_needed_note")}</p>
        )}

        {/* Ticker/name are spoofable indexer data; the pool id is the real
            destination. Retype its tail so a swapped pool id can't slip by. */}
        <ConfirmGate
          network={network}
          alwaysChallenge
          challenge={tailChallenge(pool.poolId)}
          challengeHint={t("confirm_gate_hint_pool", { len: CHALLENGE_LEN })}
          checkboxLabel={t("delegate_verify_checkbox")}
          confirmed={checked}
          onChange={setChecked}
        />

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => {
              setPoolReview(null);
              setChecked(false);
            }}
            className="flex-1 p-3 rounded-brand border border-border-soft bg-bg1 hover:bg-bg2 text-sm"
          >
            {t("cancel")}
          </button>
          <button
            type="button"
            disabled={busy || !checked}
            onClick={confirmDelegate}
            className="flex-1 p-3 rounded-brand border border-border-amber bg-amber-brand/10 hover:bg-amber-brand/20 text-sm text-amber-brand disabled:opacity-50"
          >
            {busy ? t("submitting") : t("confirm_delegate")}
          </button>
        </div>
        <SignHint port={port} />
      </div>
    );
  }

  // ── Abstain review / confirm (unlocks withdraw) ────────────────────────────
  // Abstain is a chain-level constant, not an address: nothing to mistype or
  // poison, so a checkbox — the same rule the Governance tab follows.
  if (abstainReview) {
    return (
      <div className="rounded-brand border border-border-soft bg-bg1 p-5 space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold">{t("withdraw_abstain_review_title")}</p>
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
          <div className="flex justify-between">
            <span className="text-text-hint">{t("withdraw_abstain_row_label")}</span>
            <span className="font-semibold">{t("gov_abstain")}</span>
          </div>
          <div className="flex justify-between border-t border-border-soft pt-2">
            <span className="text-text-hint">{t("est_fee")}</span>
            <span>{formatAda(BigInt(abstainReview.built.fee))} ADA</span>
          </div>
        </div>

        <label className="flex items-start gap-2 text-xs text-text-dim cursor-pointer">
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
            className="mt-0.5"
          />
          <span>{t("withdraw_abstain_checkbox")}</span>
        </label>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => {
              setAbstainReview(null);
              setChecked(false);
            }}
            className="flex-1 p-3 rounded-brand border border-border-soft bg-bg1 hover:bg-bg2 text-sm"
          >
            {t("cancel")}
          </button>
          <button
            type="button"
            disabled={busy || !checked}
            onClick={confirmAbstain}
            className="flex-1 p-3 rounded-brand border border-border-amber bg-amber-brand/10 hover:bg-amber-brand/20 text-sm text-amber-brand disabled:opacity-50"
          >
            {busy ? t("submitting") : t("withdraw_abstain_confirm")}
          </button>
        </div>
        <SignHint port={port} />
      </div>
    );
  }

  // ── Withdraw review / confirm ──────────────────────────────────────────────
  if (withdrawReview) {
    return (
      <div className="rounded-brand border border-border-soft bg-bg1 p-5 space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold">{t("withdraw_review_title")}</p>
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
          <div className="flex justify-between">
            <span className="text-text-hint">{t("withdraw_amount_label")}</span>
            <span className="font-semibold">{formatAda(withdrawReview.amount)} ADA</span>
          </div>
          <div className="flex justify-between border-t border-border-soft pt-2">
            <span className="text-text-hint">{t("est_fee")}</span>
            <span>{formatAda(BigInt(withdrawReview.built.fee))} ADA</span>
          </div>
        </div>

        <label className="flex items-start gap-2 text-xs text-text-dim cursor-pointer">
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
            className="mt-0.5"
          />
          <span>{t("withdraw_verify_checkbox")}</span>
        </label>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => {
              setWithdrawReview(null);
              setChecked(false);
            }}
            className="flex-1 p-3 rounded-brand border border-border-soft bg-bg1 hover:bg-bg2 text-sm"
          >
            {t("cancel")}
          </button>
          <button
            type="button"
            disabled={busy || !checked}
            onClick={confirmWithdraw}
            className="flex-1 p-3 rounded-brand border border-border-amber bg-amber-brand/10 hover:bg-amber-brand/20 text-sm text-amber-brand disabled:opacity-50"
          >
            {busy ? t("submitting") : t("confirm_withdraw")}
          </button>
        </div>
        <SignHint port={port} />
      </div>
    );
  }

  // ── Main view: current delegation + search ─────────────────────────────────
  return (
    <div className="space-y-4">
      <div className="rounded-brand border border-border-soft bg-bg1 p-5 space-y-3">
        <p className="text-sm text-text-dim">{t("staking_intro")}</p>
        {loadingAccount ? (
          <p className="text-sm text-text-hint">{t("loading")}</p>
        ) : loadError ? (
          <div className="rounded-brand-sm border border-border-amber bg-amber-brand/10 p-3 text-sm space-y-2">
            <p className="text-amber-brand">{t("stake_read_failed")}</p>
            <button
              type="button"
              onClick={() => setReloadKey((k) => k + 1)}
              className="text-xs px-3 py-1.5 rounded-brand-sm border border-border-soft bg-bg1 hover:bg-bg2"
            >
              {t("retry")}
            </button>
          </div>
        ) : (
          <div className="rounded-brand-sm bg-bg0 p-3 text-sm space-y-2">
            <div className="flex justify-between">
              <span className="text-text-hint">{t("current_delegation_label")}</span>
              <span className="font-medium">
                {/* While pending the chain's answer is known to be stale; once
                    "unseen", it is the best guess there is, so show it again. */}
                {watch.kind === "pending"
                  ? t("delegation_waiting")
                  : accountState?.delegatedPoolId
                    ? shortPoolId(accountState.delegatedPoolId)
                    : t("not_delegated")}
              </span>
            </div>
            <div className="flex justify-between border-t border-border-soft pt-2">
              <span className="text-text-hint">{t("rewards_available_label")}</span>
              <span className="font-semibold text-teal-brand">
                {formatAda(accountState?.rewardsAvailable ?? BigInt("0"))} ADA
              </span>
            </div>
          </div>
        )}
        {/* Outside the error branch: a failed re-read must not hide that a
            delegation is out there, or the next press sends a second one. */}
        {watch.kind === "pending" && (
          <p className="text-xs text-amber-brand">
            {t("stake_delegate_pending", { pool: shortPoolId(watch.poolId) })}
          </p>
        )}
        {watch.kind === "unseen" && (
          <p className="text-xs text-amber-brand">
            {t("stake_delegate_unseen", { pool: shortPoolId(watch.poolId) })}
          </p>
        )}
        {/* Same reason, for a vote delegation (Abstain here, or any choice on
            the Governance tab): the line names no choice, because it follows
            all of them alike. */}
        {/* The line that promises Withdraw only where there is something to
            withdraw; with no rewards (or none read) it just says it waits. */}
        {voteInFlight && voteWatch.kind === "pending" && (
          <p className="text-xs text-amber-brand">
            {t(
              accountState !== null && accountState.rewardsAvailable > BigInt("0")
                ? "vote_delegation_pending"
                : "vote_delegation_pending_plain",
            )}
          </p>
        )}
        {voteInFlight &&
          voteWatch.kind === "unseen" &&
          sentVoteDelegation !== null &&
          lookedUp === sentVoteDelegation.txHash && (
          <p className="text-xs text-amber-brand">
            {t("vote_delegation_unseen", { time: clockTime(voteDelegationExpiresAt(sentVoteDelegation)) })}
          </p>
        )}
        {/* Ran out without the chain showing it, and the chain still shows no
            vote delegation: say so once, the Abstain offer below is real again. */}
        {!voteInFlight &&
          expiredVoteDelegation !== null &&
          expiredVoteDelegation.account === rewardAddressBech32 &&
          expiredVoteDelegation.network === network &&
          accountState !== null &&
          accountState.delegatedDRep === null && (
            <p className="text-xs text-amber-brand">
              {t("vote_delegation_expired", { time: clockTime(expiredVoteDelegation.sentAt) })}
            </p>
          )}
        {/* The withdraw door is always on screen once the account is read.
            A button that only appears when there is something to take left a
            user with nothing yet looking for a feature that seemed missing. */}
        {!loadingAccount && !loadError && accountState && (
          <WithdrawDoor
            state={accountState}
            voteInFlight={voteInFlight}
            locked={busy || uncertainHash !== null}
            busy={busy}
            onWithdraw={reviewWithdraw}
            onAbstain={reviewAbstain}
            t={t}
          />
        )}
      </div>

      <div className="rounded-brand border border-border-soft bg-bg1 p-5 space-y-3">
        <div className="flex gap-2">
          <input
            className={inputCls}
            placeholder={t("search_pools_placeholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // The button is disabled while a search is in flight; Enter must
              // obey the same rule, or holding it fires overlapping searches
              // whose replies can land out of order and show the wrong list.
              if (e.key === "Enter" && query.trim() && !searching) runSearch();
            }}
          />
          <button
            type="button"
            disabled={searching || !query.trim()}
            onClick={runSearch}
            className="px-4 rounded-brand border border-border-soft bg-bg1 hover:bg-bg2 text-sm disabled:opacity-50"
          >
            {searching ? t("searching_pools") : t("search_pools_button")}
          </button>
        </div>

        {searched && !searching && pools.length === 0 && (
          <p className="text-sm text-text-hint">{t("no_pools_found")}</p>
        )}

        <div className="space-y-2">
          {pools.map((pool) => {
            const isCurrent = pool.poolId === accountState?.delegatedPoolId;
            return (
              <div
                key={pool.poolId}
                className="rounded-brand-sm border border-border-soft bg-bg0 p-3 text-sm space-y-1"
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium">
                    {pool.ticker ? `[${pool.ticker}] ` : ""}
                    {pool.name || shortPoolId(pool.poolId)}
                  </span>
                  {isCurrent ? (
                    <span className="text-xs text-teal-brand">{t("currently_delegated_badge")}</span>
                  ) : (
                    <button
                      type="button"
                      // Also disabled until the account has been read — while
                      // it is still loading and after a failed read alike: with
                      // `accountState` null nothing says whether the stake key
                      // is registered, and guessing "not registered" attaches a
                      // STAKE_KEY_REGISTRATION cert the node rejects for a key
                      // that already is, killing the whole tx behind a review
                      // that shows a phantom 2 ADA deposit. `reviewDelegate`
                      // refuses the same state.
                      disabled={busy || uncertainHash !== null || accountState === null}
                      onClick={() => reviewDelegate(pool)}
                      className="px-3 py-1.5 rounded-brand-sm border border-border-amber bg-amber-brand/10 hover:bg-amber-brand/20 text-xs text-amber-brand disabled:opacity-50"
                    >
                      {t("delegate_button")}
                    </button>
                  )}
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-text-hint">
                  <span>
                    {t("saturation_label")}: {pool.saturationPct.toFixed(1)}%
                  </span>
                  <span>
                    {t("margin_label")}: {pool.marginPct.toFixed(1)}%
                  </span>
                  <span>
                    {t("fixed_cost_label")}: {formatAda(pool.fixedCostLovelace)} ADA
                  </span>
                  <span>
                    {t("pledge_label")}: {formatAda(pool.pledgeLovelace)} ADA
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * The withdraw button and the reason when it cannot be used. Three states,
 * each with its own sentence, so "nothing to take yet", "the chain will refuse
 * this account" and "waiting for the fix to land" never look the same:
 *
 * - no rewards        → button shown, disabled, with the reason;
 * - no vote delegation → the rule explained, and Abstain offered — or, once a
 *                        vote delegation is in flight, nothing here: the
 *                        waiting line above (outside the read-error branch)
 *                        says it, and the offer must not be made again;
 * - otherwise          → the button.
 */
function WithdrawDoor({
  state,
  voteInFlight,
  locked,
  busy,
  onWithdraw,
  onAbstain,
  t,
}: {
  state: StakeAccountState;
  voteInFlight: boolean;
  locked: boolean;
  busy: boolean;
  onWithdraw: () => void;
  onAbstain: () => void;
  t: ReturnType<typeof useTranslation>["t"];
}) {
  const hasRewards = state.rewardsAvailable > BigInt("0");
  const needsDRep = hasRewards && state.delegatedDRep === null;
  const withdrawCls =
    "w-full p-3 rounded-brand border border-border-teal bg-teal-brand/10 hover:bg-teal-brand/20 text-sm text-teal-brand disabled:opacity-50";

  // A vote delegation is already in flight (this tab's Abstain, or any choice
  // on the Governance tab). The waiting line above says so — showing "this
  // account has not made one yet" and offering Abstain again would invite a
  // second, paid tx that replaces the choice made.
  if (needsDRep && voteInFlight) return null;

  if (needsDRep) {
    return (
      <div className="rounded-brand-sm border border-border-amber bg-amber-brand/10 p-3 text-sm space-y-2">
        <p className="text-amber-brand">{t("withdraw_needs_drep")}</p>
        <button
          type="button"
          disabled={locked}
          onClick={onAbstain}
          className="w-full p-3 rounded-brand border border-border-amber bg-amber-brand/10 hover:bg-amber-brand/20 text-sm text-amber-brand disabled:opacity-50"
        >
          {busy ? t("building") : t("withdraw_abstain_button")}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <button type="button" disabled={locked || !hasRewards} onClick={onWithdraw} className={withdrawCls}>
        {busy ? t("building") : t("withdraw_rewards")}
      </button>
      {!hasRewards && <p className="text-xs text-text-hint">{t("withdraw_no_rewards")}</p>}
    </div>
  );
}
