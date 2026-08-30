"use client";

/**
 * The locally-held wallet: create or restore a recovery phrase here, keep it
 * encrypted, unlock it with a password.
 *
 * This is the one screen in the module that contradicts the sentence printed
 * everywhere else — "this page will never ask for your recovery phrase". So it
 * has to earn that contradiction, and the design follows from three things:
 *
 * 1. **Say what is different, before anything is created.** The risk here is
 *    not the same as connecting Lace, and burying that would be the dishonest
 *    move. The warning is above the buttons, not in a footer.
 * 2. **Make the backup real before the wallet is usable.** The phrase is shown
 *    once, and the user has to type three of the words back before the wallet
 *    is saved. A "I have written it down" checkbox measures nothing.
 * 3. **A wrong word must be a correctable mistake, not a dead end.** Restore
 *    tells the user *which* word is not a BIP-39 word, and suggests the real
 *    ones, because someone recovering a wallet is usually already frightened.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toastApiError } from "@/lib/toast";
import { CopyBtn } from "@/components/CopyBtn";
import {
  createMnemonic,
  mnemonicToEntropyBytes,
  entropyToMnemonicPhrase,
  normalizeMnemonic,
  suggestWords,
  isWordInList,
  accountFromEntropy,
  primaryAddress,
  allAddresses,
  sealVault,
  openVault,
  vaultToJson,
  MIN_PASSWORD_LENGTH,
  type Account,
} from "@/lib/keystore";
import {
  vaultStore,
  newWalletId,
  isExtensionContext,
  type StoredWallet,
} from "@/lib/keystore/storage";
import {
  WalletSession,
  DEFAULT_LOCK_TIMEOUT_MS,
  LOCK_TIMEOUT_OPTIONS_MS,
  NEVER_LOCK_MS,
} from "@/lib/keystore/session";
import { fetchAddressBalance, type PhoenixNetwork } from "@/lib/cardano";
import { BalanceView, type DisplayAsset } from "./BalanceView";

type Step = "list" | "words" | "confirm" | "password" | "restore" | "unlock" | "open";

/** Which words we ask back. Three is enough to catch "I didn't write it down". */
const CONFIRM_COUNT = 3;

const inputCls =
  "w-full rounded-brand-sm border border-border-soft bg-bg0 px-3 py-2 text-sm focus:border-border-amber outline-none";
const btnCls =
  "rounded-brand-sm border border-border-soft px-3 py-2 text-sm hover:border-border-amber disabled:opacity-50";
const primaryCls =
  "rounded-brand-sm bg-amber-brand px-4 py-2 text-sm font-medium text-bg0 disabled:opacity-50";

export function LocalWalletPanel() {
  const { t } = useTranslation("wallet");
  // Default to preprod, not mainnet. This mode is unaudited and holds the key
  // in the page; the safe default is the network where a mistake costs nothing,
  // and switching to mainnet should be a thing the user did on purpose.
  const [network, setNetwork] = useState<PhoenixNetwork>(0);
  const store = useMemo(() => vaultStore(), []);
  const session = useMemo(() => new WalletSession(DEFAULT_LOCK_TIMEOUT_MS), []);

  const [step, setStep] = useState<Step>("list");
  const [wallets, setWallets] = useState<StoredWallet[]>([]);
  const [busy, setBusy] = useState(false);

  // create / restore
  const [phrase, setPhrase] = useState("");
  const [restoreText, setRestoreText] = useState("");
  const [confirmIdx, setConfirmIdx] = useState<number[]>([]);
  const [confirmVals, setConfirmVals] = useState<string[]>([]);
  const [label, setLabel] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");

  // unlock / open
  const [activeId, setActiveId] = useState<string | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [lovelace, setLovelace] = useState<bigint>(BigInt("0"));
  const [assets, setAssets] = useState<DisplayAsset[]>([]);
  const [balanceOk, setBalanceOk] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);
  // Set when the wallet locks while a recovery phrase is on screen. It hides
  // the words without destroying them: see the `locked` subscriber below.
  const [concealed, setConcealed] = useState(false);
  const [lockMs, setLockMs] = useState<number>(DEFAULT_LOCK_TIMEOUT_MS);

  const refresh = useCallback(async () => {
    setWallets(await store.list());
  }, [store]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Lock on the way out. A tab you have navigated away from — or closed — is
  // exactly the walk-away case the inactivity timeout exists for, and it is the
  // case where nobody is watching the screen.
  //
  // This used to call `session.touch()` here, which *resets* the countdown
  // rather than ending it. The effect was the opposite of the intent: a wallet
  // left open in a background tab never locked at all, because every switch away
  // pushed the deadline out again. Measured with fake timers: 100 minutes with
  // no user action and a tab switch every five, still unlocked.
  useEffect(() => {
    const off = session.subscribe((s) => {
      if (s.status === "locked") {
        setAccount(null);
        setRevealed(null);
        setStep((cur) => (cur === "open" ? "list" : cur));
        // The password is what opens the vault. Keeping it in state through a
        // lock means "locked" and "unlocked" differ by a boolean while the
        // secret that bridges them is still sitting there. It costs one retype.
        setPw("");
        setPw2("");
        // A recovery phrase mid-creation is a different case: destroying it
        // would throw away a wallet the user is in the middle of writing down,
        // and a wallet that punishes you for opening your password manager
        // teaches you to screenshot the words instead. So hide, do not destroy
        // — the walk-away threat is someone reading the screen, and hiding
        // answers exactly that. What survives is stated in `session.ts`.
        setConcealed(true);
      }
    });
    const onHide = () => {
      if (document.visibilityState === "hidden") session.lock();
    };
    const onPageHide = () => session.lock();
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onPageHide);
      off();
      session.lock();
    };
  }, [session]);

  const err = (e: unknown) => {
    const key = (e as { key?: string })?.key;
    // Errors from the keystore are i18n keys, not sentences — translate them,
    // and fall back to the raw key rather than an empty toast if one is new.
    toastApiError(key ? new Error(t(key, { defaultValue: key })) : e);
  };

  // ── create ────────────────────────────────────────────────────────────────

  const startCreate = () => {
    try {
      const m = createMnemonic(24);
      setPhrase(m);
      setStep("words");
    } catch (e) {
      err(e);
    }
  };

  const startConfirm = () => {
    const words = phrase.split(" ");
    const picks = new Set<number>();
    // Random positions, so writing down only the first few does not pass.
    while (picks.size < CONFIRM_COUNT) {
      picks.add(crypto.getRandomValues(new Uint32Array(1))[0]! % words.length);
    }
    const idx = [...picks].sort((a, b) => a - b);
    setConfirmIdx(idx);
    setConfirmVals(idx.map(() => ""));
    setStep("confirm");
  };

  const confirmOk =
    confirmIdx.length > 0 &&
    confirmIdx.every((wordIdx, i) => phrase.split(" ")[wordIdx] === confirmVals[i]?.trim().toLowerCase());

  // ── save (create or restore) ──────────────────────────────────────────────

  const save = async () => {
    if (pw !== pw2) {
      err({ key: "local_password_mismatch" });
      return;
    }
    setBusy(true);
    try {
      const source = step === "password" && restoreText ? restoreText : phrase;
      const entropy = mnemonicToEntropyBytes(source);
      const acct = await accountFromEntropy(entropy, 0, network);
      const vault = await sealVault(entropy, pw, { label: label.trim() || undefined });
      entropy.fill(0);

      const w: StoredWallet = {
        id: newWalletId(),
        label: label.trim() || t("local_default_label"),
        vault,
        firstAddress: primaryAddress(acct),
        network,
        createdAt: new Date().toISOString(),
      };
      await store.put(w);
      await refresh();

      // Straight into the open wallet — the user just proved they hold it.
      session.unlock(w.id, acct);
      setActiveId(w.id);
      setAccount(acct);
      setStep("open");
      void loadBalance(acct);
      resetDraft();
    } catch (e) {
      err(e);
    } finally {
      setBusy(false);
    }
  };

  const resetDraft = () => {
    setConcealed(false);
    setPhrase("");
    setRestoreText("");
    setConfirmIdx([]);
    setConfirmVals([]);
    setPw("");
    setPw2("");
    setLabel("");
  };

  // ── unlock ────────────────────────────────────────────────────────────────

  const unlock = async () => {
    if (!activeId) return;
    setBusy(true);
    try {
      const w = await store.get(activeId);
      if (!w) throw new Error("local_wallet_missing");
      const entropy = await openVault(w.vault, pw);
      const acct = await accountFromEntropy(entropy, 0, w.network as PhoenixNetwork);
      entropy.fill(0);
      session.unlock(w.id, acct);
      setAccount(acct);
      setPw("");
      setStep("open");
      void loadBalance(acct);
    } catch (e) {
      err(e);
    } finally {
      setBusy(false);
    }
  };

  const loadBalance = async (acct: Account) => {
    setBalanceOk(false);
    try {
      const bal = await fetchAddressBalance(acct.network, allAddresses(acct));
      setLovelace(bal.lovelace);
      setAssets(bal.assets);
      setBalanceOk(true);
    } catch (e) {
      // A dead indexer must not look like an empty wallet.
      toastApiError(e);
    }
  };

  // ── reveal / export ───────────────────────────────────────────────────────

  const revealPhrase = async () => {
    if (!activeId) return;
    try {
      const w = await store.get(activeId);
      if (!w) return;
      const entropy = await openVault(w.vault, pw);
      setRevealed(entropyToMnemonicPhrase(entropy));
      entropy.fill(0);
      setPw("");
    } catch (e) {
      err(e);
    }
  };

  const exportVault = async () => {
    if (!activeId) return;
    const w = await store.get(activeId);
    if (!w) return;
    const blob = new Blob([vaultToJson(w.vault)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${w.label.replace(/\s+/g, "-")}.vault.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // ── render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4" onPointerDown={() => session.touch()}>
      {/* The risk statement sits above every entry point, not below it. */}
      <div className="rounded-brand border border-amber-brand/40 bg-bg1 p-5 space-y-2">
        <h3 className="text-sm font-medium text-amber-brand">⚠ {t("local_risk_title")}</h3>
        <p className="text-xs text-text-dim">{t("local_risk_body")}</p>
        {!isExtensionContext() && <p className="text-xs text-text-dim">{t("local_risk_web")}</p>}
      </div>

      {step === "list" && (
        <div className="rounded-brand border border-border-soft bg-bg1 p-5 space-y-4">
          <p className="text-sm text-text-dim">{t("local_intro")}</p>

          <label className="flex items-center gap-2 text-xs">
            <span className="text-text-hint">{t("network_label")}</span>
            <select
              className="rounded-brand border border-border-soft bg-bg1 px-2 py-1"
              value={network}
              onChange={(e) => setNetwork(Number(e.target.value) as PhoenixNetwork)}
            >
              <option value={0}>{t("network_preprod")}</option>
              <option value={2}>{t("network_preview")}</option>
              <option value={1}>{t("network_mainnet")}</option>
            </select>
            {network === 1 && <span className="text-amber-brand">⚠ {t("local_mainnet_warning")}</span>}
          </label>

          {wallets.length === 0 ? (
            <p className="text-xs text-text-hint">{t("local_no_wallets")}</p>
          ) : (
            <ul className="space-y-2">
              {wallets.map((w) => (
                <li
                  key={w.id}
                  className="flex items-center justify-between gap-3 rounded-brand-sm border border-border-soft px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="text-sm">{w.label}</div>
                    <div className="mono truncate text-xs text-text-hint">{w.firstAddress}</div>
                  </div>
                  <button
                    className={btnCls}
                    onClick={() => {
                      setActiveId(w.id);
                      setPw("");
                      setStep("unlock");
                    }}
                  >
                    {t("local_unlock_cta")}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-wrap gap-2">
            <button className={primaryCls} onClick={startCreate}>
              {t("local_create_cta")}
            </button>
            <button
              className={btnCls}
              onClick={() => {
                resetDraft();
                setStep("restore");
              }}
            >
              {t("local_restore_cta")}
            </button>
          </div>
        </div>
      )}

      {step === "words" && (
        <div className="rounded-brand border border-border-soft bg-bg1 p-5 space-y-4">
          <h3 className="text-sm font-medium">{t("local_words_title")}</h3>
          <p className="text-xs text-amber-brand">⚠ {t("local_words_warning")}</p>
          {concealed ? (
            <div className="rounded-brand border border-border-soft bg-bg2 p-4 text-center space-y-2">
              <p className="text-sm">{t("local_concealed_body")}</p>
              <button className={btnCls} onClick={() => setConcealed(false)}>
                {t("local_concealed_show")}
              </button>
            </div>
          ) : (
            <ol className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
              {phrase.split(" ").map((w, i) => (
                <li key={i} className="mono text-sm">
                  <span className="text-text-hint">{i + 1}.</span> {w}
                </li>
              ))}
            </ol>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {!concealed && <CopyBtn value={phrase} />}
            <button className={primaryCls} onClick={startConfirm}>
              {t("local_words_next")}
            </button>
            <button
              className={btnCls}
              onClick={() => {
                resetDraft();
                setStep("list");
              }}
            >
              {t("local_cancel")}
            </button>
          </div>
        </div>
      )}

      {step === "confirm" && (
        <div className="rounded-brand border border-border-soft bg-bg1 p-5 space-y-4">
          <h3 className="text-sm font-medium">{t("local_confirm_title")}</h3>
          <p className="text-xs text-text-dim">{t("local_confirm_intro")}</p>
          <div className="space-y-2">
            {confirmIdx.map((wordIdx, i) => (
              <label key={wordIdx} className="block">
                <span className="text-xs text-text-hint">
                  {t("local_confirm_word", { n: wordIdx + 1 })}
                </span>
                <input
                  className={`${inputCls} mono`}
                  value={confirmVals[i] ?? ""}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => {
                    const next = [...confirmVals];
                    next[i] = e.target.value;
                    setConfirmVals(next);
                  }}
                />
              </label>
            ))}
          </div>
          <div className="flex gap-2">
            <button className={primaryCls} disabled={!confirmOk} onClick={() => setStep("password")}>
              {t("local_words_next")}
            </button>
            <button className={btnCls} onClick={() => setStep("words")}>
              {t("local_confirm_back")}
            </button>
          </div>
        </div>
      )}

      {step === "restore" && (
        <RestoreForm
          value={restoreText}
          concealed={concealed}
          onReveal={() => setConcealed(false)}
          onChange={setRestoreText}
          onCancel={() => {
            resetDraft();
            setStep("list");
          }}
          onNext={() => setStep("password")}
        />
      )}

      {step === "password" && (
        <div className="rounded-brand border border-border-soft bg-bg1 p-5 space-y-4">
          <h3 className="text-sm font-medium">{t("local_password_title")}</h3>
          <p className="text-xs text-text-dim">
            {t("local_password_intro", { n: MIN_PASSWORD_LENGTH })}
          </p>
          <label className="block">
            <span className="text-xs text-text-hint">{t("local_wallet_label")}</span>
            <input className={inputCls} value={label} onChange={(e) => setLabel(e.target.value)} />
          </label>
          <label className="block">
            <span className="text-xs text-text-hint">{t("local_password")}</span>
            <input
              className={inputCls}
              type="password"
              value={pw}
              autoComplete="new-password"
              onChange={(e) => setPw(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="text-xs text-text-hint">{t("local_password_again")}</span>
            <input
              className={inputCls}
              type="password"
              value={pw2}
              autoComplete="new-password"
              onChange={(e) => setPw2(e.target.value)}
            />
          </label>
          {pw.length > 0 && pw.length < MIN_PASSWORD_LENGTH && (
            <p className="text-xs text-amber-brand">
              {t("vault_password_too_short", { defaultValue: "vault_password_too_short" })}
            </p>
          )}
          <div className="flex gap-2">
            <button
              className={primaryCls}
              disabled={busy || pw.length < MIN_PASSWORD_LENGTH || pw !== pw2}
              onClick={() => void save()}
            >
              {busy ? t("local_saving") : t("local_save_cta")}
            </button>
            <button className={btnCls} onClick={() => setStep(restoreText ? "restore" : "confirm")}>
              {t("local_confirm_back")}
            </button>
          </div>
          <p className="text-xs text-text-hint">{t("local_kdf_note")}</p>
        </div>
      )}

      {step === "unlock" && (
        <div className="rounded-brand border border-border-soft bg-bg1 p-5 space-y-4">
          <h3 className="text-sm font-medium">{t("local_unlock_title")}</h3>
          <input
            className={inputCls}
            type="password"
            value={pw}
            autoComplete="current-password"
            onChange={(e) => setPw(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void unlock();
            }}
          />
          <div className="flex gap-2">
            <button className={primaryCls} disabled={busy || !pw} onClick={() => void unlock()}>
              {busy ? t("local_unlocking") : t("local_unlock_cta")}
            </button>
            <button className={btnCls} onClick={() => setStep("list")}>
              {t("local_cancel")}
            </button>
          </div>
        </div>
      )}

      {step === "open" && account && (
        <div className="space-y-4">
          <div className="rounded-brand border border-border-soft bg-bg1 p-5 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-medium">{t("local_address")}</h3>
              <button className={btnCls} onClick={() => session.lock()}>
                {t("local_lock_cta")}
              </button>
            </div>
            <div className="flex items-center gap-2">
              <code className="mono break-all text-xs">{primaryAddress(account)}</code>
              <CopyBtn value={primaryAddress(account)} />
            </div>
            <BalanceView lovelace={lovelace} assets={assets} address={primaryAddress(account)} />
            {!balanceOk && <p className="text-xs text-text-hint">{t("local_balance_unavailable")}</p>}
          </div>

          <div className="rounded-brand border border-border-soft bg-bg1 p-5 space-y-3">
            <label className="flex items-center gap-2 text-xs">
              <span className="text-text-hint">{t("local_autolock_label")}</span>
              <select
                className="rounded-brand border border-border-soft bg-bg1 px-2 py-1"
                value={lockMs}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setLockMs(v);
                  session.setTimeout(v);
                }}
              >
                {LOCK_TIMEOUT_OPTIONS_MS.map((ms) => (
                  <option key={ms} value={ms}>
                    {t("local_autolock_minutes", { n: ms / 60_000 })}
                  </option>
                ))}
                <option value={NEVER_LOCK_MS}>{t("local_autolock_never")}</option>
              </select>
            </label>

            <div className="flex flex-wrap gap-2">
              <button className={btnCls} onClick={() => void exportVault()}>
                {t("local_export_vault")}
              </button>
            </div>
            <p className="text-xs text-text-hint">{t("local_export_note")}</p>

            <div className="space-y-2 border-t border-border-soft pt-3">
              <p className="text-xs text-amber-brand">⚠ {t("local_reveal_warning")}</p>
              {revealed ? (
                <div className="space-y-2">
                  <code className="mono block break-words text-xs">{revealed}</code>
                  <button className={btnCls} onClick={() => setRevealed(null)}>
                    {t("local_hide_phrase")}
                  </button>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    className={`${inputCls} max-w-xs`}
                    type="password"
                    placeholder={t("local_password")}
                    value={pw}
                    onChange={(e) => setPw(e.target.value)}
                  />
                  <button className={btnCls} disabled={!pw} onClick={() => void revealPhrase()}>
                    {t("local_show_phrase")}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Restore form.
 *
 * The per-word feedback is the point. A phrase that fails as a whole tells
 * someone their money is gone; a phrase that says "word 7 is not a BIP-39
 * word, did you mean…" tells them they made a typo. Same data, opposite
 * experience, and the second one is the true description far more often.
 */
function RestoreForm({
  value,
  concealed,
  onReveal,
  onChange,
  onCancel,
  onNext,
}: {
  value: string;
  concealed: boolean;
  onReveal: () => void;
  onChange: (v: string) => void;
  onCancel: () => void;
  onNext: () => void;
}) {
  const { t } = useTranslation("wallet");
  const ref = useRef<HTMLTextAreaElement>(null);

  const words = normalizeMnemonic(value).split(" ").filter(Boolean);
  const bad = words.map((w, i) => ({ w, i })).filter(({ w }) => !isWordInList(w));
  const countOk = [12, 15, 18, 21, 24].includes(words.length);

  let checksumOk = false;
  if (countOk && bad.length === 0) {
    try {
      mnemonicToEntropyBytes(value);
      checksumOk = true;
    } catch {
      checksumOk = false;
    }
  }

  return (
    <div className="rounded-brand border border-border-soft bg-bg1 p-5 space-y-3">
      <h3 className="text-sm font-medium">{t("local_restore_title")}</h3>
      <p className="text-xs text-text-dim">{t("local_restore_intro")}</p>
      {concealed && value.length > 0 ? (
        // Only when there is something to hide. Covering an empty box is friction
        // that teaches nothing.
        <div className="rounded-brand border border-border-soft bg-bg2 p-4 text-center space-y-2 h-28 flex flex-col justify-center">
          <p className="text-sm">{t("local_concealed_body")}</p>
          <button className={btnCls} onClick={onReveal}>
            {t("local_concealed_show")}
          </button>
        </div>
      ) : (
        <textarea
          ref={ref}
          className={`${inputCls} mono h-28`}
          value={value}
          autoComplete="off"
          spellCheck={false}
          placeholder={t("local_restore_placeholder")}
          onChange={(e) => onChange(e.target.value)}
        />
      )}

      <p className="text-xs text-text-hint">{t("local_restore_count", { n: words.length })}</p>

      {bad.length > 0 && (
        <ul className="space-y-1">
          {bad.slice(0, 4).map(({ w, i }) => (
            <li key={i} className="text-xs text-amber-brand">
              {t("local_restore_bad_word", { n: i + 1, word: w })}
              {suggestWords(w).length > 0 && (
                <span className="text-text-hint"> — {suggestWords(w).join(", ")}</span>
              )}
            </li>
          ))}
        </ul>
      )}

      {countOk && bad.length === 0 && !checksumOk && (
        <p className="text-xs text-amber-brand">{t("mnemonic_bad_checksum")}</p>
      )}

      <div className="flex gap-2">
        <button className={primaryCls} disabled={!checksumOk} onClick={onNext}>
          {t("local_words_next")}
        </button>
        <button className={btnCls} onClick={onCancel}>
          {t("local_cancel")}
        </button>
      </div>
    </div>
  );
}
