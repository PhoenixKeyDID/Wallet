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
  localPort,
  changeAddressHexFor,
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
import { WalletTabs } from "./WalletTabs";

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
  /** Guards the balance read against being overtaken — see `loadBalance`. */
  const balanceRun = useRef(0);
  const [balanceOk, setBalanceOk] = useState(false);
  // True when the last address inside the gap-limit window still holds funds,
  // which proves the window is too small to be the whole wallet. See
  // `loadBalance` — this exists so a balance that is smaller than the truth
  // cannot be shown as if it were the truth.
  const [balanceMayBePartial, setBalanceMayBePartial] = useState(false);
  /**
   * Which BIP-44 account is open (`m/1852'/1815'/n'`).
   *
   * Shown on screen rather than kept implicit: two accounts of one seed have
   * different addresses and different balances, so a person who cannot see
   * which one they are on can hand out an address from the wrong account or
   * read one account's empty balance as the whole wallet being empty.
   */
  const [accountIndex, setAccountIndex] = useState(0);
  /** Account the user asked to move to; `null` when the switch form is closed. */
  const [switchTo, setSwitchTo] = useState<number | null>(null);
  const [switchPw, setSwitchPw] = useState("");
  const [revealed, setRevealed] = useState<string | null>(null);
  // Set when the wallet locks while a recovery phrase is on screen. It hides
  // the words without destroying them: see the `locked` subscriber below.
  const [concealed, setConcealed] = useState(false);
  const [lockMs, setLockMs] = useState<number>(DEFAULT_LOCK_TIMEOUT_MS);
  /**
   * Change address for the feature tabs, hex, resolved once per unlock.
   *
   * `null` while it is being resolved. The tabs stay hidden until it lands
   * rather than mounting with an empty string: two of the panels decode this
   * during render, and an empty string decodes to a throw inside a `useMemo`,
   * which React surfaces as a blank screen rather than as an error anyone can
   * act on.
   */
  const [changeAddrHex, setChangeAddrHex] = useState<string | null>(null);

  /**
   * The unlocked account, wrapped in the shape the feature tabs speak.
   *
   * This is the only place in the app allowed to build it: `check:keystore-
   * boundary` permits exactly this file to import `@/lib/keystore`, which is
   * what keeps "Connect, Watch-only and custody never touch a signing key" a
   * property of the import graph rather than a promise in a document. The tabs
   * receive a finished `WalletPort` and cannot reach back through it.
   *
   * `null` while locked, so the tabs unmount with the keys — a stale port would
   * hold a reference to an account whose private keys were just zeroed.
   */
  const port = useMemo(
    () => (account ? localPort(account) : null),
    [account],
  );

  // Resolve the change address whenever a different account is unlocked, and
  // drop it the moment there is no account — a change address outliving its
  // keys would let the next unlocked wallet build a transaction paying its
  // change to the previous wallet.
  useEffect(() => {
    if (!account) {
      setChangeAddrHex(null);
      return;
    }
    let alive = true;
    setChangeAddrHex(null);
    void changeAddressHexFor(account)
      .then((hex) => {
        if (alive) setChangeAddrHex(hex);
      })
      .catch(() => {
        // `changeAddressHexFor` already swallows indexer failure and falls back
        // to internal index 0; reaching here means the account has no internal
        // addresses at all, which is a broken account, not a broken network.
        if (alive) setChangeAddrHex(null);
      });
    return () => {
      alive = false;
    };
  }, [account]);

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
        // A balance read started before the lock must not paint the previous
        // wallet's money onto the screen after it.
        balanceRun.current += 1;
        setLovelace(BigInt("0"));
        setAssets([]);
        setBalanceOk(false);
        setBalanceMayBePartial(false);
        setRevealed(null);
        setStep((cur) => (cur === "open" ? "list" : cur));
        // The password is what opens the vault. Keeping it in state through a
        // lock means "locked" and "unlocked" differ by a boolean while the
        // secret that bridges them is still sitting there. It costs one retype.
        setPw("");
        // Same secret, second field. The account-switch form has its own copy
        // of the password, so clearing only `pw` would leave a lock that locks
        // one input and not the other.
        setSwitchPw("");
        setSwitchTo(null);
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
      // Taken before the slow part, checked after it — see the unlock below.
      const epoch = session.epoch();
      const source = step === "password" && restoreText ? restoreText : phrase;
      const entropy = mnemonicToEntropyBytes(source);
      let acct;
      let vault;
      try {
        acct = await accountFromEntropy(entropy, 0, network);
        vault = await sealVault(entropy, pw, { label: label.trim() || undefined });
      } finally {
        // Either await can throw — a derivation error, or WebCrypto missing on
        // a page served over plain http. Without `finally` the seed survives
        // the failure, which is the one moment nobody is watching it.
        entropy.fill(0);
      }

      const w: StoredWallet = {
        id: newWalletId(),
        label: label.trim() || t("local_default_label"),
        vault,
        firstAddress: primaryAddress(acct),
        network,
        createdAt: new Date().toISOString(),
        accountIndex: 0,
      };
      await store.put(w);
      await refresh();

      // Straight into the open wallet — the user just proved they hold it.
      //
      // With the epoch, for the same reason `openAccount` has one. Creating a
      // wallet also runs Argon2id plus a derivation, and the lock that lands in
      // the middle of it needs no button: the effect above locks on
      // `visibilitychange` and on `pagehide`. Without the check, switching tabs
      // during those seconds and coming back finds the new wallet *open*, keys
      // in memory, after the very event this panel treats as walking away.
      if (!session.unlock(w.id, acct, epoch)) {
        resetDraft();
        return;
      }
      setActiveId(w.id);
      setAccount(acct);
      // A newly created wallet starts at account 0, whatever account the
      // previous wallet was left on.
      setAccountIndex(0);
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

  /**
   * Open one BIP-44 account of a stored wallet.
   *
   * One seed holds an unlimited number of accounts (`m/1852'/1815'/n'`), and
   * they are separate wallets in every way that matters: separate addresses,
   * separate balances, separate staking. Other wallets charge for this; the
   * derivation was already here, only the way in was missing.
   *
   * Switching accounts asks for the password again, and that is not an
   * oversight to be smoothed away later. The seed is wiped the moment the
   * account is derived — that is the property the whole keystore is built on —
   * so there is nothing left in memory to derive a second account from. Keeping
   * the seed around to make switching seamless would trade the module's central
   * guarantee for the removal of one prompt.
   */
  const openAccount = async (walletId: string, password: string, index: number) => {
    const w = await store.get(walletId);
    if (!w) throw new Error("local_wallet_missing");
    // Taken before the slow part, checked after it. Argon2id plus a full
    // account derivation is hundreds of milliseconds at best, and during that
    // window the user can press Lock, hide the tab, or let the idle timer fire.
    // Installing the result afterwards would put the keys back in memory
    // *after* they deliberately put them away.
    const epoch = session.epoch();
    const entropy = await openVault(w.vault, password);
    let acct;
    try {
      acct = await accountFromEntropy(entropy, index, w.network as PhoenixNetwork);
    } finally {
      // `finally`, not a plain next statement: a derivation that throws would
      // otherwise leave the seed — the one secret that regenerates every key
      // for every account — alive in the heap until the collector happens to
      // run. This is the idiom `changeVaultPassword` already uses.
      entropy.fill(0);
    }
    // `session.unlock` wipes whatever account was open before it stores the new
    // one, so switching cannot leave the previous account's keys in the heap —
    // and with the epoch it wipes *this* one instead if the wallet was locked
    // while we were deriving.
    if (!session.unlock(w.id, acct, epoch)) return;
    setAccount(acct);
    // Invalidate any read still in flight, in the same breath as clearing the
    // figures. Clearing alone leaves `balanceOk` true from the previous account,
    // so during the IndexedDB write below the screen shows "0 ADA" with no
    // "balance unavailable" line — a zero presented as measured, for an account
    // nothing has measured yet.
    balanceRun.current += 1;
    setBalanceOk(false);
    setBalanceMayBePartial(false);
    // Wipe the previous account's figures before showing the next one. A
    // balance read takes seconds, and leaving the old numbers up under the new
    // account's name and address is the same lie as letting a stale read win —
    // it just tells it during the wait instead of after.
    setLovelace(BigInt("0"));
    setAssets([]);
    setAccountIndex(index);
    // Remember where they were, so the next unlock does not land on an empty
    // account 0 and read as "my money is gone".
    if ((w.accountIndex ?? 0) !== index) await store.put({ ...w, accountIndex: index });
    setStep("open");
    void loadBalance(acct);
  };

  /**
   * The buttons carry `disabled={busy}`, but Enter in the password field does
   * not go through a button. Held down, the key repeats about thirty times a
   * second, and each repeat starts an Argon2id at the shipping cost (19 MiB,
   * ~1.4 s) plus a full account derivation. A user who is simply impatient can
   * hang their own tab, or an extension popup, at the moment they open a wallet.
   */
  const unlock = async () => {
    if (!activeId || busy) return;
    setBusy(true);
    try {
      const w = await store.get(activeId);
      if (!w) throw new Error("local_wallet_missing");
      await openAccount(activeId, pw, w.accountIndex ?? 0);
      setPw("");
    } catch (e) {
      err(e);
    } finally {
      setBusy(false);
    }
  };

  /** Re-derive at a different account index. Needs the password; see above. */
  const switchAccount = async () => {
    // Same key-repeat guard as `unlock`.
    if (!activeId || switchTo === null || busy) return;
    setBusy(true);
    try {
      await openAccount(activeId, switchPw, switchTo);
      setSwitchPw("");
      setSwitchTo(null);
    } catch (e) {
      err(e);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Which balance read is the current one.
   *
   * Every read here is slow — dozens of addresses through a public indexer —
   * and there are three ways to start a second one before the first returns:
   * switch account, unlock a different wallet, or press refresh. Whichever
   * *finishes* last wins the screen, and that is not the same as whichever the
   * user asked for last. An empty account 5 answers in a moment while a busy
   * account 0 is still going, so the screen ends up labelled "Account 5",
   * showing account 5's address, over account 0's money — and Send, which reads
   * the real UTxOs, then refuses to spend a balance the screen just promised.
   *
   * Worse is the failure direction: a read that sets `balanceOk = false` and
   * then fails can be overwritten by an older read setting it back to `true`,
   * which removes the "balance unavailable" warning from a screen whose account
   * was never measured. The repo has paid for that shape once already.
   *
   * A counter rather than comparing accounts: the same account can be read
   * twice, and the later read is still the one that should win.
   */
  const loadBalance = async (acct: Account) => {
    const run = (balanceRun.current += 1);
    const current = () => balanceRun.current === run;
    setBalanceOk(false);
    setBalanceMayBePartial(false);
    try {
      const bal = await fetchAddressBalance(acct.network, allAddresses(acct));
      if (!current()) return;
      setLovelace(bal.lovelace);
      setAssets(bal.assets);
      setBalanceOk(true);

      // `GAP_LIMIT` addresses are derived per chain and then the scan stops.
      // BIP-44 asks for something else: keep going until twenty *consecutive*
      // unused addresses. A wallet restored from a long-lived Lace or Eternl
      // account can therefore hold funds past the window, and the number shown
      // here would be smaller than the truth with nothing on screen saying so —
      // which a user reads as "my money is gone".
      //
      // Extending the scan is the real fix and is the top item in the spec's
      // roadmap. What this does is remove the *silence*: if the very last
      // address in the window still holds a balance, the window provably ended
      // too early. One extra request, no false alarms — it can only miss the
      // case of an address that was used and later emptied, never invent one.
      const tails = [acct.external.at(-1)?.address, acct.internal.at(-1)?.address].filter(
        (a): a is string => Boolean(a),
      );
      if (tails.length > 0) {
        const tail = await fetchAddressBalance(acct.network, tails);
        if (current() && (tail.lovelace > BigInt("0") || tail.assets.length > 0)) {
          setBalanceMayBePartial(true);
        }
      }
    } catch (e) {
      if (!current()) return;
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
      try {
        setRevealed(entropyToMnemonicPhrase(entropy));
      } finally {
        entropy.fill(0);
      }
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
            {/* Which account this address belongs to, next to the address
                itself. Account 2's address looks exactly like account 0's, so
                the only thing separating "my receive address" from "someone
                else's account" here is this line. */}
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="rounded-brand-sm border border-border-soft px-2 py-0.5 text-text-hint">
                {t("local_account_n", { n: accountIndex })}
              </span>
              <span className="mono text-text-hint">m/1852&apos;/1815&apos;/{accountIndex}&apos;</span>
              {switchTo === null && (
                <button
                  className="text-text-hint underline hover:text-text-dim"
                  onClick={() => setSwitchTo(accountIndex)}
                >
                  {t("local_account_switch")}
                </button>
              )}
            </div>

            {/*
              An empty account looks exactly like a robbed one, and this is the
              screen where someone would conclude the second. The index is
              remembered, so a person who typed 7 out of curiosity lands there
              again on their next unlock and is met by 0 ADA — with nothing to
              distinguish it from loss but a grey chip sitting beside a
              derivation path. Say it plainly, and offer the one step back.
            */}
            {balanceOk && lovelace === BigInt("0") && assets.length === 0 && accountIndex > 0 && (
              <div className="rounded-brand border border-border-soft bg-bg0 p-3 space-y-2 text-xs">
                <p className="text-text-dim">
                  {t("local_account_empty_note", { n: accountIndex })}
                </p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setSwitchTo(0)}
                  className="rounded-brand-sm border border-border-soft px-3 py-1.5 text-text-hint hover:text-text-dim disabled:opacity-50"
                >
                  {t("local_account_back_zero")}
                </button>
              </div>
            )}
            {switchTo !== null && (
              <div className="rounded-brand border border-border-soft bg-bg0 p-3 space-y-2">
                <p className="text-xs text-text-hint">{t("local_account_switch_help")}</p>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-2 text-xs">
                    <span className="text-text-hint">{t("local_account_label")}</span>
                    <input
                      type="number"
                      min={0}
                      step={1}
                      value={switchTo}
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        // A hardened index must be a whole number below 2^31.
                        // Clamping here rather than failing at derivation keeps
                        // the error where the person can see what they typed.
                        setSwitchTo(Number.isInteger(n) && n >= 0 && n < 2 ** 31 ? n : 0);
                      }}
                      className="w-20 rounded-brand-sm border border-border-soft bg-bg1 px-2 py-1 mono"
                    />
                  </label>
                  <input
                    className={`${inputCls} max-w-xs`}
                    type="password"
                    placeholder={t("local_password")}
                    autoComplete="current-password"
                    value={switchPw}
                    onChange={(e) => setSwitchPw(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void switchAccount();
                    }}
                  />
                  <button
                    className={primaryCls}
                    disabled={busy || !switchPw}
                    onClick={() => void switchAccount()}
                  >
                    {busy ? t("local_unlocking") : t("local_account_switch_cta")}
                  </button>
                  <button
                    className={btnCls}
                    onClick={() => {
                      setSwitchTo(null);
                      setSwitchPw("");
                    }}
                  >
                    {t("local_cancel")}
                  </button>
                </div>
              </div>
            )}
            <div className="flex items-center gap-2">
              <code className="mono break-all text-xs">{primaryAddress(account)}</code>
              <CopyBtn value={primaryAddress(account)} />
            </div>
            <BalanceView lovelace={lovelace} assets={assets} address={primaryAddress(account)} />
            {!balanceOk && <p className="text-xs text-text-hint">{t("local_balance_unavailable")}</p>}
            {balanceOk && balanceMayBePartial && (
              <p className="text-xs text-amber-brand">⚠ {t("local_balance_partial")}</p>
            )}
          </div>

          {/* Send / Receive / Staking / Governance / Connect, driven by the
              local keys instead of an extension. The network is passed, not
              offered: this account was derived for exactly one network, so the
              testnet picker the CIP-30 path needs would be a way to choose
              wrong here. Until the change address resolves, say the wallet is
              getting ready rather than showing a form that cannot build. */}
          {port && changeAddrHex ? (
            <WalletTabs port={port} network={account.network} changeAddress={changeAddrHex} />
          ) : (
            <p className="text-xs text-text-hint">{t("local_tabs_preparing")}</p>
          )}

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
