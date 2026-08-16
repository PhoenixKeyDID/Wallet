"use client";

import { useMemo, useRef, useState } from "react";
import { Buffer } from "buffer";
import { useTranslation } from "react-i18next";
import { QRCodeSVG } from "qrcode.react";
import { utils as tyUtils } from "@stricahq/typhonjs";
import { toastApiError } from "@/lib/toast";
import { parseAcctXvk, type Cip30Api, type PhoenixNetwork } from "@/lib/cardano";
import {
  deriveReceiveAddress,
  deriveReceiveRange,
  type DerivedReceiveAddress,
  type ReceiveAddressKind,
} from "@/lib/cardano/receive";
import { CopyBtn } from "@/components/CopyBtn";

// `@/lib/cardano` re-exports `xpub.ts` (parseAcctXvk) but not typhon's
// `tyUtils` — that lives only in the typhonjs package itself, imported
// directly here to decode the CIP-30 hex address into bech32 for display.

const inputCls =
  "w-full rounded-brand-sm border border-border-soft bg-bg0 px-3 py-2 text-sm mono focus:border-border-amber outline-none";

function AddressCard({
  address,
  path,
  labelKey,
}: {
  address: string;
  path?: string;
  labelKey: string;
}) {
  const { t } = useTranslation("wallet");
  return (
    <div className="rounded-brand border border-border-soft bg-bg1 p-5 space-y-3">
      <p className="mono text-xs uppercase tracking-wider text-text-hint">{t(labelKey)}</p>
      <div className="flex justify-center bg-white p-3 rounded-brand-sm w-fit mx-auto">
        <QRCodeSVG value={address} size={176} />
      </div>
      <div className="flex items-center gap-2 text-xs">
        <span className="mono text-text-dim break-all flex-1">{address}</span>
        <CopyBtn value={address} />
      </div>
      {path && <p className="text-xs text-text-hint mono">{path}</p>}
    </div>
  );
}

/**
 * Verdict of the "is this account key really yours?" check. `unknown` is a
 * deliberate state, not the absence of one: an undecidable check must be shown
 * as undecided, never as silence the user reads as a pass.
 */
type Ownership = "checking" | "match" | "mismatch" | "unknown" | null;

export function ReceivePanel({
  api,
  network,
}: {
  api: Cip30Api;
  network: PhoenixNetwork;
  changeAddress: string;
}) {
  const { t } = useTranslation("wallet");

  // ── Primary: the connected wallet's own receive address ─────────────────
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [loadingWallet, setLoadingWallet] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);

  const loadWalletAddress = async () => {
    setLoadingWallet(true);
    try {
      const unused = await api.getUnusedAddresses();
      const hex = unused && unused.length > 0 ? unused[0] : (await api.getUsedAddresses())[0];
      if (!hex) {
        setWalletAddress(null);
      } else {
        const addr = tyUtils.getAddressFromHex(Buffer.from(hex, "hex"));
        setWalletAddress(addr.getBech32());
      }
    } catch (err) {
      toastApiError(err);
      setWalletAddress(null);
    } finally {
      setLoadingWallet(false);
      setLoadedOnce(true);
    }
  };

  // ── Advanced: derive by acct_xvk + kind + index ──────────────────────────
  const [advOpen, setAdvOpen] = useState(false);
  const [xvkInput, setXvkInput] = useState("");
  const [kind, setKind] = useState<ReceiveAddressKind>("base");
  const [indexInput, setIndexInput] = useState("0");
  const [derived, setDerived] = useState<DerivedReceiveAddress | null>(null);
  const [range, setRange] = useState<DerivedReceiveAddress[] | null>(null);
  const [advError, setAdvError] = useState<string | null>(null);
  // Ownership check: does the pasted account key actually belong to the wallet
  // you're connected to? A "no" is the social-engineering trap (pasting an
  // attacker's key and receiving your funds to THEIR address).
  const [ownership, setOwnership] = useState<Ownership>(null);
  /**
   * Which derivation the on-screen verdict belongs to.
   *
   * The check is async and the address is rendered immediately, so two runs in
   * a row (paste key A, then key B) could have A's slow answer land after B's
   * and label B's address with A's verdict. Every run takes a ticket; a stale
   * ticket's answer is dropped.
   */
  const checkRun = useRef(0);

  const parsedIndex = useMemo(() => {
    const n = Number(indexInput);
    return Number.isInteger(n) && n >= 0 ? n : null;
  }, [indexInput]);

  // Derive base addresses 0..23 from the pasted key and see if ANY coincides
  // with an address the connected wallet actually owns. If none does, the key
  // is almost certainly not this wallet's — warn loudly.
  const checkOwnership = async (acctXvk: Parameters<typeof deriveReceiveAddress>[0]["acctXvk"]) => {
    const run = ++checkRun.current;
    const settle = (v: Ownership) => {
      if (checkRun.current === run) setOwnership(v);
    };
    settle("checking");
    try {
      const [used, unused] = await Promise.all([api.getUsedAddresses(), api.getUnusedAddresses()]);
      const owned = new Set(
        [...(used ?? []), ...(unused ?? [])].map((hex) =>
          tyUtils.getAddressFromHex(Buffer.from(hex, "hex")).getBech32(),
        ),
      );
      if (owned.size === 0) {
        // Fresh wallet, or one that exposes no addresses: we cannot decide.
        // Say so. Silence here reads as approval of an address that may belong
        // to whoever sent the user the key — this is the whole trap the check
        // exists to catch, so it must not fail quietly.
        settle("unknown");
        return;
      }
      const mine = deriveReceiveRange({ acctXvk, kind: "base", start: 0, count: 24, network }).some((d) =>
        owned.has(d.address),
      );
      settle(mine ? "match" : "mismatch");
    } catch {
      settle("unknown");
    }
  };

  const derive = () => {
    setAdvError(null);
    setRange(null);
    setOwnership(null);
    if (parsedIndex === null) {
      setAdvError(t("invalid_index"));
      setDerived(null);
      return;
    }
    try {
      const acctXvk = parseAcctXvk(xvkInput);
      setDerived(deriveReceiveAddress({ acctXvk, kind, index: parsedIndex, network }));
      void checkOwnership(acctXvk);
    } catch (err) {
      setDerived(null);
      setAdvError(err instanceof Error ? err.message : String(err));
    }
  };

  const deriveNext5 = () => {
    setAdvError(null);
    setOwnership(null);
    if (parsedIndex === null) {
      setAdvError(t("invalid_index"));
      setRange(null);
      return;
    }
    try {
      const acctXvk = parseAcctXvk(xvkInput);
      setRange(deriveReceiveRange({ acctXvk, kind, start: parsedIndex, count: 5, network }));
      void checkOwnership(acctXvk);
    } catch (err) {
      setRange(null);
      setAdvError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-brand border border-border-soft bg-bg1 p-5 space-y-3">
        <p className="text-sm text-text-dim">{t("receive_intro")}</p>
        {!loadedOnce ? (
          <button
            type="button"
            disabled={loadingWallet}
            onClick={loadWalletAddress}
            className="w-full p-2.5 rounded-brand border border-border-soft bg-bg1 hover:bg-bg2 text-sm disabled:opacity-50"
          >
            {loadingWallet ? t("loading") : t("show_my_address")}
          </button>
        ) : (
          <button
            type="button"
            disabled={loadingWallet}
            onClick={loadWalletAddress}
            className="text-xs text-text-hint hover:text-text-dim disabled:opacity-50"
          >
            {loadingWallet ? t("loading") : t("refresh_address")}
          </button>
        )}
      </div>

      {loadedOnce &&
        (walletAddress ? (
          <AddressCard address={walletAddress} labelKey="your_receive_address" />
        ) : (
          <div className="rounded-brand border border-border-soft bg-bg1 p-5 text-sm text-text-hint">
            {t("no_address_available")}
          </div>
        ))}

      <div className="rounded-brand border border-border-soft bg-bg1 p-5 space-y-3">
        <button
          type="button"
          onClick={() => setAdvOpen((v) => !v)}
          className="text-xs text-text-hint hover:text-text-dim uppercase tracking-wider"
        >
          {advOpen ? "▾ " : "▸ "}
          {t("derive_by_index")}
        </button>

        {advOpen && (
          <div className="space-y-3">
            <p className="text-xs text-text-hint">{t("derive_by_index_help")}</p>
            <p className="text-xs text-amber-brand">⚠ {t("never_paste_seed")}</p>
            <p className="text-xs text-amber-brand">⚠ {t("paste_own_xvk_only")}</p>

            <label className="block">
              <span className="text-xs text-text-hint">{t("acct_xvk_label")}</span>
              <textarea
                className={inputCls + " h-16 resize-none break-all"}
                placeholder="acct_xvk1... / hex (128)"
                value={xvkInput}
                onChange={(e) => setXvkInput(e.target.value)}
              />
            </label>

            <div className="flex gap-2 items-center flex-wrap">
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value as ReceiveAddressKind)}
                className="rounded-brand-sm border border-border-soft bg-bg0 px-2 py-2 text-sm"
              >
                <option value="base">{t("kind_base")}</option>
                <option value="enterprise">{t("kind_enterprise")}</option>
              </select>
              <label className="flex items-center gap-2">
                <span className="text-xs text-text-hint">{t("index_label")}</span>
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={indexInput}
                  onChange={(e) => setIndexInput(e.target.value)}
                  className="w-24 rounded-brand-sm border border-border-soft bg-bg0 px-2 py-2 text-sm mono"
                />
              </label>
            </div>

            <p className="text-xs text-text-hint">
              {kind === "base" ? t("kind_base_help") : t("kind_enterprise_help")}
            </p>

            <div className="flex gap-2">
              <button
                type="button"
                disabled={!xvkInput.trim()}
                onClick={derive}
                className="flex-1 p-2.5 rounded-brand border border-border-soft bg-bg1 hover:bg-bg2 text-sm disabled:opacity-50"
              >
                {t("generate_address")}
              </button>
              <button
                type="button"
                disabled={!xvkInput.trim()}
                onClick={deriveNext5}
                className="flex-1 p-2.5 rounded-brand border border-border-soft bg-bg1 hover:bg-bg2 text-sm disabled:opacity-50"
              >
                {t("show_next_5")}
              </button>
            </div>

            {advError && <p className="text-xs text-amber-brand">{advError}</p>}
          </div>
        )}
      </div>

      {ownership === "checking" && (
        <p className="text-xs text-text-hint">{t("xvk_checking")}</p>
      )}
      {ownership === "unknown" && (
        <div className="rounded-brand border border-border-soft bg-bg1 p-4 text-sm text-text-dim space-y-1">
          <p className="font-semibold">{t("xvk_unknown_title")}</p>
          <p className="text-xs">{t("xvk_unknown_body")}</p>
        </div>
      )}
      {ownership === "mismatch" && (
        <div className="rounded-brand border border-border-amber bg-amber-brand/10 p-4 text-sm text-amber-brand space-y-1">
          <p className="font-semibold">⚠ {t("xvk_mismatch_title")}</p>
          <p className="text-xs">{t("xvk_mismatch_body")}</p>
        </div>
      )}
      {ownership === "match" && (
        <p className="text-xs text-teal-brand">✓ {t("xvk_match_note")}</p>
      )}

      {derived && <AddressCard address={derived.address} path={derived.path} labelKey="derived_address" />}

      {range && range.length > 0 && (
        <div className="rounded-brand border border-border-soft bg-bg1 p-5 space-y-2">
          <p className="mono text-xs uppercase tracking-wider text-text-hint">{t("derived_addresses")}</p>
          {range.map((r) => (
            <div key={r.index} className="flex items-center gap-2 text-xs">
              <span className="text-text-hint w-8">#{r.index}</span>
              <span className="mono text-text-dim truncate flex-1">{r.address}</span>
              <CopyBtn value={r.address} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
