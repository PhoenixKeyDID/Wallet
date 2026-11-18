"use client";

import { useEffect, useState } from "react";
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
  listImportedWallets,
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
 */
type Props = {
  /** DID of the signed-in user, supplied by the host session. */
  did: string;
};

type Notice = { kind: "error" | "success"; key: string; values?: Record<string, string> };

/** CIP-30 `DataSignError` codes a wallet throws from `signData`. */
const DATA_SIGN_ADDRESS_NOT_PK = 2;
const DATA_SIGN_USER_DECLINED = 3;

function dataSignCode(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === "number" ? code : null;
}

function short(a: string): string {
  return a.length > 30 ? `${a.slice(0, 16)}…${a.slice(-10)}` : a;
}

export function ImportedWalletsPanel({ did }: Props) {
  const { t } = useTranslation("wallet");
  const [installed, setInstalled] = useState<Cip30Wallet[]>([]);
  /** `null` = not read yet; a read failure is a notice, never an empty list. */
  const [attached, setAttached] = useState<ImportedWallet[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDetach, setConfirmDetach] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(() => {
    // `window.cardano` is injected by extensions after load and absent in SSR.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setInstalled(listWallets());
  }, []);

  const failureNotice = (err: unknown): Notice => {
    switch (classifyImportError(err)) {
      case "proof_invalid":
        return { kind: "error", key: "imported_err_proof_invalid" };
      case "already_attached":
        return { kind: "error", key: "imported_err_already_attached" };
      case "proof_expired":
        return { kind: "error", key: "imported_err_proof_expired" };
      case "nonce_reused":
        return { kind: "error", key: "imported_err_retry" };
      case "unauthorized":
        return { kind: "error", key: "imported_err_unauthorized" };
      case "not_found":
        return { kind: "error", key: "imported_err_not_found" };
      default:
        return { kind: "error", key: "imported_err_generic" };
    }
  };

  const reload = async () => {
    setBusy("list");
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
    setBusy(w.key);
    setNotice(null);
    setConfirmDetach(null);
    try {
      let api;
      try {
        api = await enableWallet(w.key);
      } catch (err) {
        if (err instanceof WalletConnectError && err.reason === "cancelled") return;
        if (isConnectRefused(err)) {
          setNotice({ kind: "error", key: "connect_refused" });
          return;
        }
        setNotice({ kind: "error", key: "imported_err_connect", values: { name: w.name } });
        return;
      }
      const addressHex = await api.getChangeAddress();
      const checked = checkImportAddress(addressHex);
      if (!checked.ok) {
        setNotice({
          kind: "error",
          key: checked.reason === "script_payment" ? "imported_err_script" : "imported_err_address",
        });
        return;
      }
      let proof;
      try {
        proof = await signImportProof(api, did, addressHex);
      } catch (err) {
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
      try {
        await attachImportedWallet(proof);
      } catch (err) {
        setNotice(failureNotice(err));
        return;
      }
      setNotice({ kind: "success", key: "imported_attached", values: { address: short(proof.address) } });
      // The attach succeeded whatever the list read does next; a failed re-read
      // shows its own notice and must not overwrite this one silently.
      try {
        setAttached(await listImportedWallets());
      } catch {
        setAttached(null);
        setNotice({ kind: "success", key: "imported_attached_list_failed", values: { address: short(proof.address) } });
      }
    } finally {
      setBusy(null);
    }
  };

  const detach = async (address: string) => {
    setBusy(address);
    setNotice(null);
    try {
      await detachImportedWallet(address);
      setConfirmDetach(null);
      setNotice({ kind: "success", key: "imported_detached", values: { address: short(address) } });
      try {
        setAttached(await listImportedWallets());
      } catch {
        setAttached(null);
      }
    } catch (err) {
      setNotice(failureNotice(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-brand border border-border-soft bg-bg1 p-5 space-y-3">
      <p className="mono text-xs uppercase tracking-wider text-text-hint">{t("imported_title")}</p>
      <p className="text-sm text-text-dim">{t("imported_intro")}</p>
      <p className="text-xs text-amber-brand">{t("imported_privacy_note")}</p>

      {installed.length === 0 ? (
        <p className="text-xs text-text-hint">{t("imported_no_extension")}</p>
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
              {busy === w.key ? t("imported_signing") : t("imported_attach_with", { name: w.name })}
            </button>
          ))}
        </div>
      )}

      {notice && (
        <p
          role={notice.kind === "error" ? "alert" : "status"}
          className={`text-xs ${notice.kind === "error" ? "text-amber-brand" : "text-text-dim"}`}
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
