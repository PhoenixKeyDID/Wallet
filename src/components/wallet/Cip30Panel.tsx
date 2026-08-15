"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Buffer } from "buffer";
import { useTranslation } from "react-i18next";
import { utils as tyUtils } from "@stricahq/typhonjs";
import { toastApiError, toastError } from "@/lib/toast";
import {
  listWallets,
  enableWallet,
  readBalance,
  WalletConnectError,
  isConnectRefused,
  type Cip30Api,
  type Cip30Wallet,
} from "@/lib/cardano";
import { BalanceView } from "./BalanceView";
import { WalletTabs } from "./WalletTabs";

/**
 * Where "install a wallet" points. Hard-coded on purpose: this used to come
 * from the translation files, which makes a destination the user is about to
 * trust depend on a data file that translators — and anyone who can land a
 * string change — edit. A link is code, not copy.
 */
const LACE_URL = "https://www.lace.io";

type Connected = {
  key: string;
  name: string;
  api: Cip30Api;
  networkId: number;
  changeAddress: string;
};

export function Cip30Panel() {
  const { t } = useTranslation("wallet");
  const [wallets, setWallets] = useState<Cip30Wallet[]>([]);
  const [conn, setConn] = useState<Connected | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [lovelace, setLovelace] = useState<bigint>(BigInt("0"));
  /**
   * A failed balance read used to leave the initial `0n` on screen, which reads
   * exactly like an empty wallet. "Zero" and "we could not ask" are different
   * facts and must not share a rendering — a toast that fades after six seconds
   * is not enough to tell them apart.
   */
  const [balanceFailed, setBalanceFailed] = useState(false);
  const [assets, setAssets] = useState<
    { unit: string; policyId: string; assetNameHex: string; quantity: bigint }[]
  >([]);

  useEffect(() => {
    // Read the browser-injected `window.cardano` once after mount — an external
    // system unavailable during SSR, static after the extension injects it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setWallets(listWallets());
  }, []);

  const recheck = () => setWallets(listWallets());

  /**
   * True once the wallet has kept us waiting longer than usual. It does NOT
   * cancel anything — it only turns the mute spinner into a hint about where to
   * look, because the single most common cause is an approval popup that opened
   * behind the browser window.
   */
  const [slow, setSlow] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const connect = async (key: string, name: string) => {
    const ac = new AbortController();
    abortRef.current = ac;
    setBusy(key);
    setSlow(false);
    // Wipe the previous wallet's figures before showing the next one. Without
    // this, connecting wallet B after wallet A leaves A's balance on screen
    // under B's name if B's balance read fails.
    setLovelace(BigInt("0"));
    setAssets([]);
    setBalanceFailed(false);
    try {
      const api = await enableWallet(key, {
        signal: ac.signal,
        onSlow: () => setSlow(true),
      });
      const [networkId, changeAddress] = await Promise.all([
        api.getNetworkId(),
        api.getChangeAddress(),
      ]);
      setConn({ key, name, api, networkId, changeAddress });
      try {
        const bal = await readBalance(api);
        setLovelace(bal.lovelace);
        setAssets(bal.assets);
        setBalanceFailed(false);
      } catch {
        // Connecting succeeded; only the balance read failed. Keep the session
        // and say so, instead of tearing down a working connection.
        setBalanceFailed(true);
      }
    } catch (err) {
      // Cancelling is a decision, not a failure: the user just pressed the
      // button we gave them, so shouting an error at them would be noise.
      if (isConnectRefused(err)) return toastError(t("connect_refused"));
      if (err instanceof WalletConnectError) {
        if (err.reason === "cancelled") return;
        if (err.reason === "timeout") return toastError(t("connect_timeout"));
        if (err.reason === "bad_api") return toastError(t("connect_bad_api"));
      }
      toastApiError(err);
    } finally {
      abortRef.current = null;
      setBusy(null);
      setSlow(false);
    }
  };

  const cancelConnect = () => abortRef.current?.abort();

  /**
   * CIP-30 hands back addresses as raw CBOR hex, and `BalanceView` turns what it
   * is given into a QR code for other people to pay. Hex has no checksum and no
   * network tag: a payer scanning it gets a string their wallet cannot use, and
   * a truncated one cannot even be detected. Show bech32 or show nothing —
   * never a fallback to the hex, because the fallback is exactly the broken
   * case.
   */
  const receiveAddress = useMemo(() => {
    if (!conn?.changeAddress) return null;
    try {
      return tyUtils.getAddressFromHex(Buffer.from(conn.changeAddress, "hex")).getBech32();
    } catch {
      return null;
    }
  }, [conn?.changeAddress]);

  const refresh = async () => {
    if (!conn) return;
    try {
      const bal = await readBalance(conn.api);
      setLovelace(bal.lovelace);
      setAssets(bal.assets);
      setBalanceFailed(false);
    } catch (err) {
      setBalanceFailed(true);
      toastApiError(err);
    }
  };

  if (!conn) {
    if (wallets.length === 0) {
      return (
        <div className="rounded-brand border border-border-soft bg-bg1 p-5 space-y-3">
          <p className="text-sm font-medium">{t("no_cip30_wallet_title")}</p>
          <p className="text-sm text-text-dim">{t("web_no_create_notice")}</p>
          <a
            href={LACE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="block w-full text-center p-3 rounded-brand border border-border-amber bg-amber-brand/10 text-amber-brand text-sm font-medium"
          >
            {t("install_lace_cta")}
          </a>
          <p className="text-xs text-text-hint">{t("install_lace_hint")}</p>
          <button
            type="button"
            onClick={recheck}
            className="w-full p-2.5 rounded-brand border border-border-soft bg-bg1 hover:bg-bg2 text-sm"
          >
            {t("recheck_wallets")}
          </button>
        </div>
      );
    }
    return (
      <div className="rounded-brand border border-border-soft bg-bg1 p-5 space-y-2">
        <p className="text-sm text-text-dim mb-1">{t("choose_wallet")}</p>
        {wallets.map((w) => (
          <button
            key={w.key}
            type="button"
            disabled={busy !== null}
            onClick={() => connect(w.key, w.name)}
            className="w-full flex items-center gap-3 p-3 rounded-brand border border-border-soft bg-bg1 hover:bg-bg2 transition disabled:opacity-50"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {w.icon ? <img src={w.icon} alt="" width={24} height={24} /> : <span>🔌</span>}
            <span className="font-medium capitalize">{w.name || w.key}</span>
            <span className="ml-auto text-text-hint text-sm">
              {busy === w.key ? t("connecting") : "→"}
            </span>
          </button>
        ))}

        {/* A wallet that never answers used to leave a spinner turning with no
            explanation and no way out. Cancel is always available while
            connecting — it does not depend on the hint or on any timer. */}
        {busy !== null && (
          <div className="space-y-2 pt-1">
            {slow && <p className="text-xs text-amber-brand">{t("connect_slow_hint")}</p>}
            <button
              type="button"
              onClick={cancelConnect}
              className="w-full p-2 rounded-brand border border-border-soft bg-bg1 hover:bg-bg2 text-sm text-text-dim"
            >
              {t("cancel")}
            </button>
          </div>
        )}
      </div>
    );
  }

  const networkLabel = conn.networkId === 1 ? "mainnet" : "testnet";
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between text-sm">
        <span className="flex items-center gap-2">
          <span className="inline-block w-2 h-2 rounded-full bg-success" />
          {t("connected_to")} <span className="font-medium capitalize">{conn.name || conn.key}</span>
          <span className="mono text-xs text-text-hint">({networkLabel})</span>
        </span>
        <button
          type="button"
          onClick={() => {
            setConn(null);
            setLovelace(BigInt("0"));
            setAssets([]);
            setBalanceFailed(false);
          }}
          className="text-text-hint hover:text-text"
        >
          {t("disconnect")}
        </button>
      </div>

      {balanceFailed && (
        <p className="text-xs text-amber-brand">{t("balance_load_failed")}</p>
      )}

      <BalanceView
        lovelace={lovelace}
        assets={assets}
        address={receiveAddress}
        showReceive={receiveAddress !== null}
      />

      <button
        type="button"
        onClick={refresh}
        className="w-full p-2.5 rounded-brand border border-border-soft bg-bg1 hover:bg-bg2 text-sm"
      >
        {t("refresh")}
      </button>

      <WalletTabs
        api={conn.api}
        networkId={conn.networkId}
        changeAddress={conn.changeAddress}
      />
    </div>
  );
}
