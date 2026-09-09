"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toastApiError } from "@/lib/toast";
import {
  parseAcctXvk,
  parseWatchAddress,
  deriveWatchWallet,
  fetchAddressBalance,
  chainReadHost,
  type WatchWallet,
  type PhoenixNetwork,
} from "@/lib/cardano";
import { BalanceView, type DisplayAsset } from "./BalanceView";
import { CopyBtn } from "@/components/CopyBtn";

/**
 * Two ways to watch, and the safer one is the default.
 *
 * A single address links nothing and amplifies nothing. An `acct_xvk` exposes
 * every address of the account — past, future, and unused — and, per §2.2, turns
 * the leak of any ONE child private key into the loss of the whole account.
 * `docs/Phoenix Wallet-Feat.md` §7 says the address path should therefore be
 * offered ahead of the key path; this is that ordering.
 */
type WatchMode = "address" | "xvk";

export function WatchOnlyPanel() {
  const { t } = useTranslation("wallet");
  const [mode, setMode] = useState<WatchMode>("address");
  const [addr, setAddr] = useState("");
  const [watched, setWatched] = useState<string | null>(null);
  const [xvk, setXvk] = useState("");
  // Default to mainnet: a real user pasting their real key on preprod would see a
  // misleading 0-ADA balance and think their funds vanished.
  const [network, setNetwork] = useState<PhoenixNetwork>(1);
  const [wallet, setWallet] = useState<WatchWallet | null>(null);
  const [lovelace, setLovelace] = useState<bigint>(BigInt("0"));
  const [assets, setAssets] = useState<DisplayAsset[]>([]);
  const [balanceOk, setBalanceOk] = useState(false);
  const [busy, setBusy] = useState(false);

  const loadAddress = async () => {
    setBusy(true);
    setBalanceOk(false);
    setWallet(null);
    let one: string;
    try {
      one = parseWatchAddress(addr, network);
      setWatched(one);
    } catch (err) {
      setWatched(null);
      toastApiError(err instanceof Error ? new Error(t(err.message)) : err);
      setBusy(false);
      return;
    }
    try {
      const bal = await fetchAddressBalance(network, [one]);
      setLovelace(bal.lovelace);
      setAssets(bal.assets);
      setBalanceOk(true);
    } catch (err) {
      toastApiError(err);
    } finally {
      setBusy(false);
    }
  };

  const load = async () => {
    setBusy(true);
    setBalanceOk(false);
    setWatched(null);
    // Derivation is local and must not be blocked by a network failure, so the
    // balance fetch is caught separately — a bad xvk still surfaces its error,
    // an unreachable indexer shows the addresses with balance marked unavailable.
    let derived: WatchWallet;
    try {
      derived = deriveWatchWallet(parseAcctXvk(xvk), network, 5);
      setWallet(derived);
    } catch (err) {
      setWallet(null);
      toastApiError(err);
      setBusy(false);
      return;
    }
    try {
      const bal = await fetchAddressBalance(
        network,
        derived.addresses.map((a) => a.address),
      );
      setLovelace(bal.lovelace);
      setAssets(bal.assets);
      setBalanceOk(true);
    } catch (err) {
      toastApiError(err);
    } finally {
      setBusy(false);
    }
  };

  const inputCls =
    "w-full rounded-brand-sm border border-border-soft bg-bg0 px-3 py-2 text-sm mono focus:border-border-amber outline-none";

  return (
    <div className="space-y-4">
      <div className="rounded-brand border border-border-soft bg-bg1 p-5 space-y-3">
        {/* Safer option first, and selected by default — see WatchMode above. */}
        <div className="grid grid-cols-2 gap-2">
          {(["address", "xvk"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={
                "rounded-brand-sm border p-2 text-left text-xs transition " +
                (mode === m
                  ? "border-border-amber bg-bg2"
                  : "border-border-soft bg-bg1 hover:bg-bg2")
              }
            >
              <span className="block font-semibold">
                {m === "address" ? t("watch_by_address") : t("watch_by_xvk")}
              </span>
              <span className="block text-text-hint mt-0.5">
                {m === "address" ? t("watch_by_address_hint") : t("watch_by_xvk_hint")}
              </span>
            </button>
          ))}
        </div>

        <p className="text-sm text-text-dim">
          {mode === "address" ? t("watch_addr_intro") : t("watch_intro")}
        </p>
        <p className="text-xs text-amber-brand">⚠ {t("never_paste_seed")}</p>
        {/* A standalone watch-only view has no connected wallet to check the key
            against, so warn explicitly: addresses derived from someone else's
            key receive into THEIR wallet, not yours. */}
        {mode === "xvk" && (
          <>
            {/* Only the key path can link a whole account, so the amplification
                warning belongs to it and not to the single-address path. */}
            <p className="text-xs text-amber-brand">⚠ {t("watch_paste_own_only")}</p>
            <p className="text-xs text-amber-brand">⚠ {t("watch_xvk_links_account")}</p>
            <label className="block">
              <span className="text-xs text-text-hint">{t("acct_xvk_label")}</span>
              <textarea
                className={inputCls + " h-20 resize-none break-all"}
                placeholder="acct_xvk1... / hex (128)"
                value={xvk}
                onChange={(e) => setXvk(e.target.value)}
              />
            </label>
            <details className="text-xs text-text-hint">
              <summary className="cursor-pointer hover:text-text-dim">{t("acct_xvk_help")}</summary>
              <p className="mt-1 text-text-dim">{t("acct_xvk_help_body")}</p>
            </details>
          </>
        )}

        {mode === "address" && (
          <label className="block">
            <span className="text-xs text-text-hint">{t("watch_addr_label")}</span>
            <textarea
              className={inputCls + " h-16 resize-none break-all"}
              placeholder="addr1... / addr_test1..."
              value={addr}
              onChange={(e) => setAddr(e.target.value)}
            />
          </label>
        )}
        <div className="flex gap-2 items-center">
          <select
            value={network}
            onChange={(e) => setNetwork(Number(e.target.value) as PhoenixNetwork)}
            className="rounded-brand-sm border border-border-soft bg-bg0 px-2 py-2 text-sm"
          >
            <option value={1}>{t("network_mainnet")}</option>
            <option value={0}>preprod</option>
            <option value={2}>preview</option>
          </select>
          <button
            type="button"
            disabled={busy || (mode === "xvk" ? !xvk.trim() : !addr.trim())}
            onClick={mode === "xvk" ? load : loadAddress}
            className="flex-1 p-2.5 rounded-brand border border-border-soft bg-bg1 hover:bg-bg2 text-sm disabled:opacity-50"
          >
            {busy ? t("loading") : t("view_balance")}
          </button>
        </div>
        {/* Names the host this build actually reads from — see chainReadHost. */}
        <p className="text-xs text-text-hint">{t("indexer_privacy_note", { host: chainReadHost(network) })}</p>
      </div>

      {watched && (
        <>
          {balanceOk ? (
            <BalanceView lovelace={lovelace} assets={assets} />
          ) : (
            <div className="rounded-brand border border-border-soft bg-bg1 p-5 text-sm text-text-hint">
              {t("balance_unavailable")}
            </div>
          )}
          <div className="rounded-brand border border-border-soft bg-bg1 p-5 space-y-2">
            <p className="mono text-xs uppercase tracking-wider text-text-hint">
              {t("watch_addr_label")}
            </p>
            <div className="flex items-center gap-2 text-xs">
              <span className="mono text-text-dim break-all flex-1">{watched}</span>
              <CopyBtn value={watched} />
            </div>
            <p className="text-[11px] text-text-hint pt-1">{t("watch_addr_scope_note")}</p>
          </div>
        </>
      )}

      {wallet && (
        <>
          {balanceOk ? (
            <BalanceView lovelace={lovelace} assets={assets} />
          ) : (
            <div className="rounded-brand border border-border-soft bg-bg1 p-5 text-sm text-text-hint">
              {t("balance_unavailable")}
            </div>
          )}
          <div className="rounded-brand border border-border-soft bg-bg1 p-5 space-y-2">
            <p className="mono text-xs uppercase tracking-wider text-text-hint">
              {t("derived_addresses")}
            </p>
            {wallet.addresses.map((a) => (
              <div key={a.index} className="flex items-center gap-2 text-xs">
                <span className="text-text-hint w-6">#{a.index}</span>
                <span className="mono text-text-dim truncate flex-1">{a.address}</span>
                <CopyBtn value={a.address} />
              </div>
            ))}
            <div className="flex items-center gap-2 text-xs pt-2 border-t border-border-soft mt-2">
              <span className="text-text-hint w-14">stake</span>
              <span className="mono text-text-dim truncate flex-1">{wallet.stakeAddress}</span>
              <CopyBtn value={wallet.stakeAddress} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
