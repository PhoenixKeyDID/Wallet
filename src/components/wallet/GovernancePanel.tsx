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
import { useCallback, useEffect, useMemo, useState } from "react";
import { Buffer } from "buffer";
import { useTranslation } from "react-i18next";
import BigNumber from "bignumber.js";
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
  koios,
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

type Section = "delegate" | "actions" | "become" | "submit";
type SummaryRow = { label: string; value: string; mono?: boolean };
type Pending = { built: BuiltTx; title: string; rows: SummaryRow[]; warn?: string };

export function GovernancePanel({
  api,
  network,
  changeAddress,
}: {
  api: Cip30Api;
  network: PhoenixNetwork;
  changeAddress: string;
}) {
  const { t } = useTranslation("wallet");
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
        const rewards = await api.getRewardAddresses();
        if (alive && rewards[0]) setRewardBech32(rewardAddressFrom(rewards[0]).getBech32());
      } catch {
        /* reward address unavailable — delegation still selectable, build will error clearly */
      }
      // CIP-95 probe (optional extension). Never throws into the UI.
      try {
        const anyApi = api as unknown as {
          getPubDRepKey?: () => Promise<string>;
          cip95?: { getPubDRepKey?: () => Promise<string> };
        };
        const holder = anyApi.cip95 ?? anyApi;
        const fn = anyApi.getPubDRepKey ?? anyApi.cip95?.getPubDRepKey;
        if (fn) {
          const pubHex = await fn.call(holder);
          if (alive) setDrepKeyHash(toHex(blake2b224(fromHex(pubHex))));
        } else if (alive) {
          setDrepKeyHash("");
        }
      } catch {
        if (alive) setDrepKeyHash("");
      }
    })();
    return () => {
      alive = false;
    };
  }, [api]);

  /** Load fresh inputs / params / ttl for a build. */
  const loadCtx = useCallback(async (): Promise<GovBuildCtx> => {
    const [utxosHex, protocolParams, tip] = await Promise.all([
      api.getUtxos(),
      fetchProtocolParams(network),
      fetchTipSlot(network),
    ]);
    if (!utxosHex || utxosHex.length === 0) throw new Error(t("no_utxos"));
    return {
      inputs: decodeUtxosToInputs(utxosHex),
      protocolParams,
      changeAddress: changeAddr,
      ttl: tip + 7200,
    };
  }, [api, network, changeAddr, t]);

  const resetReview = () => {
    setPending(null);
    setChecked(false);
  };

  const review = async (fn: () => Promise<Pending>) => {
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
    setBusy(true);
    try {
      const hash = await signAndSubmitCip30(api, pending.built);
      toastSuccess("gov_submitted", { hash: hash.slice(0, 12) });
      resetReview();
    } catch (err) {
      resetReview(); // drop the built tx: it already carries a witness; a retry must rebuild
      toastApiError(err);
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
              <span className={`text-right break-all ${r.mono ? "mono" : ""}`}>{r.value}</span>
            </div>
          ))}
        </div>
        {pending.warn && (
          <p className="text-xs text-amber-brand border border-border-amber rounded-brand-sm p-2">
            {pending.warn}
          </p>
        )}
        <label className="flex items-start gap-2 text-xs text-text-dim cursor-pointer">
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
            className="mt-0.5"
          />
          <span>{t("gov_verify_checkbox")}</span>
        </label>
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
        <p className="text-[11px] text-text-hint text-center">{t("extension_popup_hint")}</p>
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
}: SectionProps & { network: PhoenixNetwork; rewardBech32: string }) {
  const { t } = useTranslation("wallet");
  const [query, setQuery] = useState("");
  const [dreps, setDreps] = useState<DRepSummary[]>([]);
  const [searching, setSearching] = useState(false);
  const [current, setCurrent] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    if (!rewardBech32) return;
    let alive = true;
    getVoteDelegationState(network, rewardBech32)
      .then((s) => alive && setCurrent(s.delegatedDRep ?? null))
      .catch(() => alive && setCurrent(undefined));
    return () => {
      alive = false;
    };
  }, [network, rewardBech32]);

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
        rows: [
          { label: t("gov_delegate_to"), value: label, mono: target.kind === "drep" },
          feeRow(built),
        ],
      };
    });

  return (
    <div className={card}>
      <p className="text-xs text-text-hint">{t("gov_delegate_help")}</p>
      {current !== undefined && (
        <p className="text-xs text-text-dim">
          {t("gov_current_delegation")}:{" "}
          <span className="mono">{current ? short(current) : t("gov_none")}</span>
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
        rows: [
          { label: t("gov_action"), value: a.title ?? a.type, mono: false },
          // Show the FULL action id, not a truncation: the title/type come from
          // an external indexer (spoofable), but the id is what actually gets
          // signed. The user must be able to verify exactly what they vote on.
          { label: t("gov_action_id"), value: a.id, mono: true },
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
    const rows = await koios<Array<{ drep_deposit: string | number }>>(network, "/epoch_params");
    const dep = rows[0]?.drep_deposit;
    if (dep == null) throw new Error(t("gov_deposit_unknown"));
    return new BigNumber(dep);
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
    const rows = await koios<Array<{ gov_action_deposit: string | number }>>(
      network,
      "/epoch_params",
    );
    const dep = rows[0]?.gov_action_deposit;
    if (dep == null) throw new Error(t("gov_deposit_unknown"));
    return new BigNumber(dep);
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
          { label: t("gov_withdraw_target"), value: wTarget.trim() || rewardBech32, mono: true },
        );
      }
      rows.push(feeRow(built));
      return { built, title: t("gov_review_submit"), rows, warn: t("gov_deposit_refundable") };
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
