"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  listWallets,
  enableWallet,
  isConnectRefused,
  WalletConnectError,
  type Cip30Wallet,
} from "@/lib/cardano";
import {
  attachImportedWallet,
  checkImportAddress,
  classifyImportError,
  detachImportedWallet,
  IMPORT_PROOF_LIFETIME_SEC,
  listImportedWallets,
  samePaymentKeyAs,
  signImportProof,
  type ImportedWallet,
} from "@/lib/wallet";

/**
 * Attach an external wallet (Lace, Eternl, …) to the signed-in DID.
 *
 * The external wallet signs a CIP-8 message naming this DID, its own address, a
 * fresh nonce and a five-minute expiry; the server checks that signature and
 * records the address under the DID. Its key never leaves the extension, and the
 * signature moves no funds — but attaching DOES tell the Phoenix server that
 * this address belongs to this DID. That is the one thing the user is agreeing
 * to here, so the screen says it before the button, not after.
 *
 * Every failure gets its own sentence, read from the backend's integer code: a
 * wrong proof (1387) answered with "you are signed out" sends the user to log in
 * again for nothing, and an address already on another DID (1388) is not fixed
 * by signing again.
 *
 * A wallet is free to never answer, at connect or at sign. Both waits can be
 * cancelled, show a hint when slow, and the sign wait stops on its own when the
 * proof it would produce has expired anyway.
 */
type Props = {
  /** DID of the signed-in user, supplied by the host session. */
  did: string;
};

type Notice = { kind: "error" | "success"; key: string; values?: Record<string, string> };
type Phase = "connect" | "sign" | "send";

/** CIP-30 `DataSignError` codes a wallet throws from `signData`. */
const DATA_SIGN_ADDRESS_NOT_PK = 2;
const DATA_SIGN_USER_DECLINED = 3;

/** When a silent sign popup turns into a "look for the wallet window" hint. */
const SIGN_SLOW_AFTER_MS = 20_000;

function dataSignCode(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === "number" ? code : null;
}

function short(a: string): string {
  return a.length > 30 ? `${a.slice(0, 16)}…${a.slice(-10)}` : a;
}

class SignWaitStopped extends Error {
  constructor(readonly reason: "cancelled" | "timeout") {
    super(`sign wait ${reason}`);
  }
}

/** Settle with `p`, or stop waiting on abort / after `ms`. The wallet's call itself cannot be recalled. */
function untilStopped<T>(p: Promise<T>, signal: AbortSignal, ms: number, onSlow: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(new SignWaitStopped("cancelled"));
    const slow = setTimeout(onSlow, SIGN_SLOW_AFTER_MS);
    const limit = setTimeout(() => finish(() => reject(new SignWaitStopped("timeout"))), ms);
    const onAbort = () => finish(() => reject(new SignWaitStopped("cancelled")));
    function finish(settle: () => void) {
      clearTimeout(slow);
      clearTimeout(limit);
      signal.removeEventListener("abort", onAbort);
      settle();
    }
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => finish(() => resolve(v)),
      (e) => finish(() => reject(e)),
    );
  });
}

export function ImportedWalletsPanel({ did }: Props) {
  const { t } = useTranslation("wallet");
  const [installed, setInstalled] = useState<Cip30Wallet[]>([]);
  /** `null` = not read yet; a read failure is a notice, never an empty list. */
  const [attached, setAttached] = useState<ImportedWallet[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase | null>(null);
  const [slow, setSlow] = useState(false);
  /** The address the wallet is about to sign for, shown before it asks. */
  const [pending, setPending] = useState<string | null>(null);
  const [confirmDetach, setConfirmDetach] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    // `window.cardano` is injected by extensions after load and absent in SSR.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setInstalled(listWallets());
  }, []);

  const failureNotice = (err: unknown, address?: string): Notice => {
    switch (classifyImportError(err)) {
      case "proof_invalid":
        return { kind: "error", key: "imported_err_proof_invalid", values: { address: short(address ?? "") } };
      case "already_attached":
        return { kind: "error", key: "imported_err_already_attached" };
      case "proof_expired":
        return { kind: "error", key: "imported_err_proof_expired" };
      case "network_mismatch":
        return { kind: "error", key: "imported_err_network" };
      case "nonce_reused":
        return { kind: "error", key: "imported_err_retry" };
      case "not_attached":
        return { kind: "error", key: "imported_err_not_attached" };
      case "unauthorized":
        return { kind: "error", key: "imported_err_unauthorized" };
      case "unavailable":
        return { kind: "error", key: "imported_err_unavailable" };
      default:
        return { kind: "error", key: "imported_err_generic" };
    }
  };

  const reload = async () => {
    setBusy("list");
    setNotice(null);
    try {
      setAttached(await listImportedWallets());
    } catch (err) {
      setAttached(null);
      setNotice(failureNotice(err));
    } finally {
      setBusy(null);
    }
  };

  const attach = async (w: Cip30Wallet) => {
    const ac = new AbortController();
    abortRef.current = ac;
    setBusy(w.key);
    setPhase("connect");
    setSlow(false);
    setPending(null);
    setNotice(null);
    setConfirmDetach(null);
    try {
      let api;
      try {
        api = await enableWallet(w.key, { signal: ac.signal, onSlow: () => setSlow(true) });
      } catch (err) {
        if (isConnectRefused(err)) {
          setNotice({ kind: "error", key: "connect_refused" });
          return;
        }
        if (err instanceof WalletConnectError) {
          if (err.reason === "cancelled") return;
          if (err.reason === "timeout") return setNotice({ kind: "error", key: "connect_timeout" });
          if (err.reason === "bad_api") return setNotice({ kind: "error", key: "connect_bad_api" });
        }
        setNotice({ kind: "error", key: "imported_err_connect", values: { name: w.name } });
        return;
      }
      let addressHex: string;
      try {
        addressHex = await api.getChangeAddress();
      } catch {
        // E.g. the account was switched mid-flow: the wallet refuses, and the
        // user must see that rather than a button that silently reset.
        setNotice({ kind: "error", key: "imported_err_connect", values: { name: w.name } });
        return;
      }
      const checked = checkImportAddress(addressHex);
      if (!checked.ok) {
        setNotice({
          kind: "error",
          key: checked.reason === "script_payment" ? "imported_err_script" : "imported_err_address",
        });
        return;
      }
      setPending(checked.bech32);
      setPhase("sign");
      setSlow(false);
      let proof;
      try {
        proof = await untilStopped(
          signImportProof(api, did, addressHex),
          ac.signal,
          IMPORT_PROOF_LIFETIME_SEC * 1000,
          () => setSlow(true),
        );
      } catch (err) {
        if (err instanceof SignWaitStopped) {
          if (err.reason === "timeout") setNotice({ kind: "error", key: "imported_err_sign_timeout" });
          return;
        }
        const code = dataSignCode(err);
        if (code === DATA_SIGN_USER_DECLINED) {
          setNotice({ kind: "error", key: "imported_err_declined" });
        } else if (code === DATA_SIGN_ADDRESS_NOT_PK) {
          setNotice({ kind: "error", key: "imported_err_script" });
        } else {
          setNotice({ kind: "error", key: "imported_err_sign", values: { name: w.name } });
        }
        return;
      }
      setPhase("send");
      setSlow(false);
      try {
        await attachImportedWallet(proof);
      } catch (err) {
        setNotice(failureNotice(err, proof.address));
        return;
      }
      const address = short(proof.address);
      // The attach succeeded whatever the list read does next; a failed re-read
      // shows its own notice and must not overwrite this one silently.
      let list: ImportedWallet[];
      try {
        list = await listImportedWallets();
      } catch {
        setAttached(null);
        setNotice({ kind: "success", key: "imported_attached_list_failed", values: { address } });
        return;
      }
      setAttached(list);
      if (list.some((x) => x.address === proof.address)) {
        setNotice({ kind: "success", key: "imported_attached", values: { address } });
        return;
      }
      // The server keeps one row per payment key: a variant of a key already on
      // this DID is accepted without a new row. Say which address holds it.
      const existing = samePaymentKeyAs(proof.address, list.map((x) => x.address));
      setNotice(
        existing
          ? { kind: "success", key: "imported_attached_same_key", values: { existing: short(existing) } }
          : { kind: "error", key: "imported_attached_missing", values: { address } },
      );
    } finally {
      abortRef.current = null;
      setBusy(null);
      setPhase(null);
      setSlow(false);
      setPending(null);
    }
  };

  const cancel = () => abortRef.current?.abort();

  const detach = async (address: string) => {
    setBusy(address);
    setNotice(null);
    try {
      await detachImportedWallet(address);
      setConfirmDetach(null);
      try {
        setAttached(await listImportedWallets());
        setNotice({ kind: "success", key: "imported_detached", values: { address: short(address) } });
      } catch {
        setAttached(null);
        setNotice({ kind: "success", key: "imported_detached_list_failed", values: { address: short(address) } });
      }
    } catch (err) {
      setNotice(failureNotice(err));
      if (classifyImportError(err) === "not_attached") {
        // Already gone (another tab, another device): show the list as it is now.
        setConfirmDetach(null);
        try {
          setAttached(await listImportedWallets());
        } catch {
          setAttached(null);
        }
      }
    } finally {
      setBusy(null);
    }
  };

  const recheck = () => setInstalled(listWallets());

  const busyLabel =
    phase === "send" ? t("imported_sending") : t("imported_signing");

  return (
    <div className="rounded-brand border border-border-soft bg-bg1 p-5 space-y-3">
      <p className="mono text-xs uppercase tracking-wider text-text-hint">{t("imported_title")}</p>
      <p className="text-sm text-text-dim">{t("imported_intro")}</p>
      <p className="text-xs text-text-dim border-l-2 border-amber-brand pl-2">{t("imported_privacy_note")}</p>

      {installed.length === 0 ? (
        <div className="space-y-2">
          <p className="text-xs text-text-hint">{t("imported_no_extension")}</p>
          <button
            type="button"
            onClick={recheck}
            className="w-full p-2.5 rounded-brand border border-border-soft bg-bg1 hover:bg-bg2 text-sm"
          >
            {t("recheck_wallets")}
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {installed.map((w) => (
            <button
              key={w.key}
              type="button"
              disabled={busy !== null}
              onClick={() => attach(w)}
              className="w-full p-2.5 rounded-brand border border-border-soft bg-bg1 hover:bg-bg2 text-sm disabled:opacity-50"
            >
              {busy === w.key ? busyLabel : t("imported_attach_with", { name: w.name })}
            </button>
          ))}
        </div>
      )}

      {pending && (
        <p className="mono text-xs text-text-dim break-all">
          {t("imported_address_to_attach", { address: pending })}
        </p>
      )}
      {slow && phase !== "send" && <p className="text-xs text-text-hint">{t("connect_slow_hint")}</p>}
      {(phase === "connect" || phase === "sign") && (
        <button
          type="button"
          onClick={cancel}
          className="w-full p-2 rounded-brand border border-border-soft text-xs"
        >
          {t("cancel")}
        </button>
      )}

      {notice && (
        <p
          role={notice.kind === "error" ? "alert" : "status"}
          className={`text-sm ${notice.kind === "error" ? "text-amber-brand font-medium" : "text-text-dim"}`}
        >
          {t(notice.key, notice.values)}
        </p>
      )}

      <button
        type="button"
        disabled={busy !== null}
        onClick={reload}
        className="w-full p-2.5 rounded-brand border border-border-soft bg-bg1 hover:bg-bg2 text-sm disabled:opacity-50"
      >
        {busy === "list" ? t("loading") : t("imported_show_list")}
      </button>

      {attached !== null &&
        (attached.length === 0 ? (
          <p className="text-xs text-text-hint">{t("imported_none")}</p>
        ) : (
          <ul className="space-y-2">
            {attached.map((w) => (
              <li key={w.address} className="rounded-brand border border-border-soft p-3 space-y-2">
                <p className="mono text-xs text-text-dim break-all">{w.address}</p>
                {confirmDetach === w.address ? (
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => detach(w.address)}
                      className="flex-1 p-2 rounded-brand border border-border-soft text-xs text-amber-brand disabled:opacity-50"
                    >
                      {busy === w.address ? t("loading") : t("imported_detach_confirm")}
                    </button>
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => setConfirmDetach(null)}
                      className="flex-1 p-2 rounded-brand border border-border-soft text-xs disabled:opacity-50"
                    >
                      {t("imported_detach_cancel")}
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => setConfirmDetach(w.address)}
                    className="p-2 rounded-brand border border-border-soft text-xs disabled:opacity-50"
                  >
                    {t("imported_detach")}
                  </button>
                )}
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}
