"use client";

import { useEffect, useState } from "react";
import { Buffer } from "buffer";
import { useTranslation } from "react-i18next";
import { utils as tyUtils, types as tyTypes } from "@stricahq/typhonjs";
import { toastApiError, toastSuccess } from "@/lib/toast";
import {
  type Cip30Api,
  type PhoenixNetwork,
  type BuiltTx,
  decodeUtxosToInputs,
  signAndSubmitCip30,
  fetchProtocolParams,
  fetchTipSlot,
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

type PoolReview = { pool: PoolSummary; needsRegistration: boolean; built: BuiltTx };
type WithdrawReview = { amount: bigint; built: BuiltTx };

/**
 * Search pools, delegate, and withdraw rewards via the connected CIP-30
 * wallet. Two-step everywhere a certificate/withdrawal gets signed: Review
 * (unsigned tx assembled, plain-language summary) → Confirm (sign + submit).
 *
 * Single-pool only — see the MULTI-POOL note in the build report for why
 * Lace-style multi-pool delegation needs multiple stake keys, which a single
 * connected CIP-30 account cannot express for keys it doesn't hold.
 *
 * ⚠️ Beta: same unaudited caveat as `SendForm`. Uses the stake key the
 * connected wallet reports via `getRewardAddresses()[0]` — never an invented key.
 */
export function StakingPanel({
  api,
  network,
  changeAddress,
}: {
  api: Cip30Api;
  network: PhoenixNetwork;
  changeAddress: string;
}) {
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
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);

  // Read the wallet's own reward address + its on-chain state once on mount.
  // `getRewardAddresses()` is the only source of a stake key here — a wallet
  // this page did not derive can only sign for the key it reports.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingAccount(true);
      setLoadError(false);
      try {
        const addrs = await api.getRewardAddresses();
        const hex = addrs?.[0];
        if (!hex) throw new Error(t("stake_account_error"));
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
  }, [api, network, reloadKey]);

  const refreshAccountState = async () => {
    if (!rewardAddressBech32) return;
    try {
      setAccountState(await getStakeAccountState(network, rewardAddressBech32));
      setLoadError(false);
    } catch (err) {
      setLoadError(true);
      toastApiError(err);
    }
  };

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
    const [utxosHex, params, tip] = await Promise.all([
      api.getUtxos(),
      fetchProtocolParams(network),
      fetchTipSlot(network),
    ]);
    if (!utxosHex || utxosHex.length === 0) throw new Error(t("no_utxos"));
    const inputs = decodeUtxosToInputs(utxosHex);
    const changeAddr = tyUtils.getAddressFromHex(
      Buffer.from(changeAddress, "hex"),
    ) as tyTypes.ShelleyAddress;
    return { inputs, changeAddr, params, tip };
  };

  const reviewDelegate = async (pool: PoolSummary) => {
    if (!rewardAddressHex) return;
    setBusy(true);
    try {
      const { inputs, changeAddr, params, tip } = await prepareInputs();
      const needsRegistration = !(accountState?.registered ?? false);
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
    setBusy(true);
    try {
      const hash = await signAndSubmitCip30(api, poolReview.built);
      toastSuccess("delegate_submitted", { hash: hash.slice(0, 12) });
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
      toastApiError(err);
    } finally {
      setBusy(false);
    }
  };

  const reviewWithdraw = async () => {
    if (!rewardAddressHex || !accountState || accountState.rewardsAvailable <= BigInt("0")) return;
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
    setBusy(true);
    try {
      const hash = await signAndSubmitCip30(api, withdrawReview.built);
      toastSuccess("withdraw_submitted", { hash: hash.slice(0, 12) });
      setWithdrawReview(null);
      setChecked(false);
      await refreshAccountState();
    } catch (err) {
      setWithdrawReview(null);
      setChecked(false);
      toastApiError(err);
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
            <span className="text-right mono text-xs break-all">{pool.poolId}</span>
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

        <label className="flex items-start gap-2 text-xs text-text-dim cursor-pointer">
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
            className="mt-0.5"
          />
          <span>{t("delegate_verify_checkbox")}</span>
        </label>

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
        <p className="text-[11px] text-text-hint text-center">{t("extension_popup_hint")}</p>
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
        <p className="text-[11px] text-text-hint text-center">{t("extension_popup_hint")}</p>
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
                {accountState?.delegatedPoolId
                  ? shortPoolId(accountState.delegatedPoolId)
                  : t("not_delegated")}
              </span>
            </div>
            <div className="flex justify-between border-t border-border-soft pt-2">
              <span className="text-text-hint">{t("rewards_available_label")}</span>
              <span className="font-semibold teal-brand">
                {formatAda(accountState?.rewardsAvailable ?? BigInt("0"))} ADA
              </span>
            </div>
          </div>
        )}
        {!loadingAccount && !loadError && accountState && accountState.rewardsAvailable > BigInt("0") && (
          <button
            type="button"
            disabled={busy}
            onClick={reviewWithdraw}
            className="w-full p-3 rounded-brand border border-border-teal bg-teal-brand/10 hover:bg-teal-brand/20 text-sm teal-brand disabled:opacity-50"
          >
            {busy ? t("building") : t("withdraw_rewards")}
          </button>
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
              if (e.key === "Enter" && query.trim()) runSearch();
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
                    <span className="text-xs teal-brand">{t("currently_delegated_badge")}</span>
                  ) : (
                    <button
                      type="button"
                      disabled={busy}
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
