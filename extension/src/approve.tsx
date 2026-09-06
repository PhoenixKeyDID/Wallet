/**
 * The wallet window a website's request opens.
 *
 * This is the only page in the extension that both holds keys and answers a
 * website, so the whole security model of CIP-30 injection sits in this file
 * and in `rpc/protocol.ts`. Three properties it must keep:
 *
 * 1. **The origin on screen came from the browser.** It arrives in the URL this
 *    window was opened with, which the background wrote from `sender.origin`.
 *    A page cannot put a string here.
 * 2. **A password is never typed into a web page.** This window is
 *    `chrome-extension://`, which is why the unlock form can exist at all. The
 *    same form on `phoenixkey.me` would be indistinguishable from a phishing
 *    copy of it.
 * 3. **Nothing is signed that cannot be described.** `summariseTx` refuses
 *    rather than guesses, and this screen shows the refusal instead of falling
 *    back to hex. Hex on an approval dialog is not information; it is the
 *    appearance of information.
 *
 * It is a real window (`chrome.windows.create`), never the toolbar popup. The
 * popup is destroyed the moment it loses focus, and `LocalWalletPanel` locks on
 * `visibilitychange` — an approval flow there would lock the wallet at the exact
 * moment the user glanced at the site they were being asked about.
 */
import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider, useTranslation } from "react-i18next";
import { i18n } from "./i18n";
import {
  accountFromEntropy,
  allAddresses,
  externalAddressesHex,
  localPort,
  openVault,
  primaryAddress,
  type Account,
} from "../../src/lib/keystore";
import { vaultStore, type StoredWallet } from "../../src/lib/keystore/storage";
import { DEFAULT_LOCK_TIMEOUT_MS } from "../../src/lib/keystore/session";
import { summariseTx, UndescribableTxError, type TxSummary } from "../../src/lib/cardano/txSummary";
import { signForeignTx } from "../../src/lib/keystore/signForeign";
import { assetLabel, formatAda } from "../../src/lib/cardano/provider";
import {
  displayOrigin,
  refused,
  declined,
  internal,
  invalid,
  WALLET_PORT,
  type ApiError,
} from "./rpc/protocol";
import "./popup.css";

type Incoming = { type: "request"; id: number; origin: string; method: string; params: unknown[] };
type Port = {
  postMessage(m: unknown): void;
  onMessage: { addListener(cb: (m: unknown) => void): void };
  disconnect(): void;
};
const chromeRuntime = (
  globalThis as unknown as { chrome?: { runtime?: { connect(o: { name: string }): Port } } }
).chrome?.runtime;

/** What the window is doing right now. */
type Phase =
  | { at: "unlock" }
  | { at: "idle" }
  /**
   * A site asked to connect and is waiting on a yes or a no.
   *
   * Separate from unlocking on purpose. Unlocking is between a person and their
   * own wallet; granting a website access is between them and that website. When
   * the two are the same act, the only human gesture in the whole flow is typing
   * a wallet password into a window a *web page* caused to appear — which
   * teaches exactly the habit every phishing kit needs, and hands over the
   * address list of anyone curious enough to look at who was asking.
   */
  | { at: "connect"; req: Incoming }
  | { at: "decide"; req: Incoming; summary?: TxSummary; undescribable?: string };

function Approve() {
  const { t } = useTranslation("wallet");
  const store = useMemo(() => vaultStore(), []);

  /**
   * The origin, read from this window's own URL.
   *
   * Written by the background from `sender.origin`. Rendered as a host and
   * never truncated: `pay.bank.example…` and `pay.bank.example.evil.tld` differ
   * only past the point a truncation would cut, which is exactly where someone
   * building a look-alike puts the difference.
   */
  const origin = useMemo(() => {
    const raw = new URLSearchParams(window.location.search).get("origin") ?? "";
    return raw;
  }, []);
  const host = useMemo(() => displayOrigin(origin), [origin]);

  const [wallets, setWallets] = useState<StoredWallet[]>([]);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [port, setPort] = useState<Port | null>(null);
  const [phase, setPhase] = useState<Phase>({ at: "unlock" });
  /**
   * Whether a request is already on screen. A ref rather than `phase`, because
   * the port listener is installed once and would otherwise close over whatever
   * `phase` was at the moment it was installed — which is exactly the stale
   * value an attacker needs.
   */
  const decidingRef = useRef(false);

  useEffect(() => {
    void store.list().then((ws) => {
      setWallets(ws);
      setPickedId((cur) => cur ?? ws[0]?.id ?? null);
    });
  }, [store]);

  /**
   * Answer one request, using the unlocked account.
   *
   * Reads go straight through the same `WalletPort` the wallet's own tabs use,
   * so a website and the wallet's own screens cannot disagree about what this
   * account holds. Signing does not: it goes through the decide screen below.
   */
  const serve = useCallback(
    async (acct: Account, req: Incoming): Promise<{ ok: true; value: unknown } | { ok: false; error: ApiError }> => {
      const wp = localPort(acct);
      try {
        switch (req.method) {
          case "enable":
            // `enable` is answered by the connect screen, not from here. Two
            // code paths that can both say yes to the same question is one path
            // too many: whichever is reached first decides, and the one with a
            // button on it should be the only one there is.
            return { ok: false, error: refused(t("cip30_declined")) };
          case "getNetworkId":
            // Preview and preprod are both `0` to CIP-30. That is the standard's
            // limitation, not ours, and answering anything else would be a
            // number no dApp knows how to read.
            return { ok: true, value: acct.network === 1 ? 1 : 0 };
          case "getUsedAddresses":
          case "getUnusedAddresses":
            // Both answer with the receiving chain. Telling the two apart needs
            // a chain query per address, which this wallet does not make here —
            // so it answers the same honest superset to both rather than
            // guessing. What it never answers with is the internal chain: see
            // `externalAddressesHex`.
            return { ok: true, value: externalAddressesHex(acct) };
          case "getChangeAddress": {
            const hex = await wp.getReceiveAddressHex();
            return hex ? { ok: true, value: hex } : { ok: false, error: internal("no address") };
          }
          case "getRewardAddresses":
            return { ok: true, value: [await wp.getRewardAddressHex()] };
          case "getExtensions":
            return { ok: true, value: [] };
          case "getCollateral":
            // Answering `[]` would read as "this wallet has no collateral",
            // which a dApp treats as a fact and builds around. It is not a
            // fact — this wallet does not choose collateral at all yet.
            return { ok: false, error: refused(t("cip30_no_collateral")) };
          default:
            return { ok: false, error: refused(t("cip30_unsupported")) };
        }
      } catch (e) {
        return { ok: false, error: internal(e instanceof Error ? e.message : String(e)) };
      }
    },
    [t],
  );

  /**
   * Lock this window back up after five idle minutes.
   *
   * A window this small is easy to leave behind a browser, and until it closes
   * it holds an unlocked account — with a site already granted, a signature is
   * then one click away from anyone at the keyboard. Locking on
   * `visibilitychange` is wrong here for the reason the popup does it: this
   * window is *meant* to sit behind the page it belongs to. Idle time is the
   * measure that fits, and it is the same five minutes the web panel uses.
   */
  useEffect(() => {
    if (!account) return;
    let timer: ReturnType<typeof setTimeout>;
    const relock = () => {
      account.wipe();
      setAccount(null);
      decidingRef.current = false;
      setPhase({ at: "unlock" });
    };
    const restart = () => {
      clearTimeout(timer);
      timer = setTimeout(relock, DEFAULT_LOCK_TIMEOUT_MS);
    };
    restart();
    for (const ev of ["mousedown", "keydown"]) window.addEventListener(ev, restart);
    return () => {
      clearTimeout(timer);
      for (const ev of ["mousedown", "keydown"]) window.removeEventListener(ev, restart);
    };
  }, [account]);

  // Connect to the background once unlocked, and answer what it forwards.
  useEffect(() => {
    if (!account || !chromeRuntime || port) return;
    const p = chromeRuntime.connect({ name: WALLET_PORT });
    p.onMessage.addListener((raw) => {
      const req = raw as Incoming;
      if (req?.type !== "request") return;
      // A request naming a different origin than this window was opened for is
      // not something to reconcile — this window can only honestly describe one
      // site, so it answers for one site.
      if (req.origin !== origin) {
        p.postMessage({ type: "result", id: req.id, result: { ok: false, error: refused("origin mismatch") } });
        return;
      }
      if (req.method === "signTx" || req.method === "signData" || req.method === "submitTx") {
        // One screen describes one transaction. A second request arriving while
        // the first is on screen used to overwrite it, and the summary a person
        // had just finished reading was replaced under their cursor — a page
        // that sends a harmless transaction, waits for the screen to settle,
        // then sends the real one gets a signature for something nobody read.
        // Refusing the second one costs a dApp a retry and costs an attacker
        // the whole approach.
        if (decidingRef.current) {
          p.postMessage({
            type: "result",
            id: req.id,
            result: { ok: false, error: refused("another request is already on screen") },
          });
          return;
        }
        decidingRef.current = true;
        setPhase({ at: "decide", req });
        return;
      }
      if (req.method === "enable") {
        // The grant is created by the background only once this window answers
        // `ok`, so holding the answer here is what makes the button mean
        // something. Same one-at-a-time rule as signing.
        if (decidingRef.current) {
          p.postMessage({
            type: "result",
            id: req.id,
            result: { ok: false, error: refused("another request is already on screen") },
          });
          return;
        }
        decidingRef.current = true;
        setPhase({ at: "connect", req });
        return;
      }
      void serve(account, req).then((result) =>
        p.postMessage({ type: "result", id: req.id, result }),
      );
    });
    p.postMessage({ type: "hello", origin });
    setPort(p);
    setPhase({ at: "idle" });
  }, [account, origin, port, serve]);

  // Describe a signing request as soon as it arrives, or say it cannot be.
  useEffect(() => {
    if (phase.at !== "decide" || phase.summary || phase.undescribable) return;
    const { req } = phase;
    if (req.method !== "signTx" || !account) return;
    const cbor = req.params[0];
    if (typeof cbor !== "string") {
      setPhase({ ...phase, undescribable: t("cip30_not_a_tx") });
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const wp = localPort(account);
        const inputs = await wp.getInputs();
        const held = new Map(
          inputs.map((i) => [
            `${i.txId}#${i.index}`,
            {
              lovelace: BigInt(i.amount.toFixed(0)),
              assets: new Map(
                (i.tokens ?? []).map((tk) => [
                  tk.policyId + (tk.assetName ?? ""),
                  BigInt(tk.amount.toFixed(0)),
                ]),
              ),
            },
          ]),
        );
        const summary = summariseTx(cbor, await wp.getOwnedAddressesHex(), held);
        if (!cancelled) setPhase((cur) => (cur.at === "decide" ? { ...cur, summary } : cur));
      } catch (e) {
        const why =
          e instanceof UndescribableTxError ? e.message : t("cip30_cannot_read_tx");
        if (!cancelled) setPhase((cur) => (cur.at === "decide" ? { ...cur, undescribable: why } : cur));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [phase, account, t]);

  const unlock = async () => {
    if (!pickedId) return;
    setBusy(true);
    setErr(null);
    try {
      const w = await store.get(pickedId);
      if (!w) throw new Error(t("local_wallet_missing"));
      const entropy = await openVault(w.vault, pw);
      const acct = await accountFromEntropy(entropy, 0, w.network as 0 | 1 | 2);
      entropy.fill(0);
      setAccount(acct);
      setPw("");
    } catch (e) {
      const key = (e as { key?: string })?.key;
      setErr(key ? t(key, { defaultValue: key }) : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const answer = (result: { ok: true; value: unknown } | { ok: false; error: ApiError }) => {
    if ((phase.at !== "decide" && phase.at !== "connect") || !port) return;
    port.postMessage({ type: "result", id: phase.req.id, result });
    decidingRef.current = false;
    setPhase({ at: "idle" });
  };

  /**
   * Sign, but only what was actually described on this screen.
   *
   * The CBOR is re-read from the request rather than from anything the summary
   * produced, and the summary is required to exist — the button is disabled
   * without one. That ordering is the guarantee: a transaction that could not
   * be described cannot reach here, so there is no path where a signature is
   * produced over bytes the user was not shown a description of.
   */
  const sign = async () => {
    if (phase.at !== "decide" || !account || !phase.summary) return;
    const cbor = phase.req.params[0];
    const partial = phase.req.params[1] === true;
    if (typeof cbor !== "string") {
      answer({ ok: false, error: invalid(t("cip30_not_a_tx")) });
      return;
    }
    setBusy(true);
    try {
      const wp = localPort(account);
      const inputs = await wp.getInputs();
      const addressByRef = new Map(
        inputs.map((i) => [`${i.txId}#${i.index}`, i.address.getBech32()]),
      );
      const witnessSetHex = signForeignTx(cbor, account, addressByRef, partial);
      answer({ ok: true, value: witnessSetHex });
    } catch (e) {
      const key = (e as { key?: string })?.key;
      answer({
        ok: false,
        error: internal(key ? t(key, { defaultValue: key }) : e instanceof Error ? e.message : String(e)),
      });
    } finally {
      setBusy(false);
    }
  };

  // ── render ────────────────────────────────────────────────────────────────

  const OriginLine = () => (
    <div className="approve-origin">
      <span className="approve-origin-label">{t("cip30_request_from")}</span>
      <strong className="mono">{host}</strong>
    </div>
  );

  if (!origin) {
    return <p className="approve-error">{t("cip30_no_origin")}</p>;
  }

  if (!account) {
    return (
      <div className="approve">
        <OriginLine />
        <p>{t("cip30_unlock_intro")}</p>
        {wallets.length === 0 && <p className="approve-error">{t("cip30_no_wallet")}</p>}
        {wallets.length > 1 && (
          <select value={pickedId ?? ""} onChange={(e) => setPickedId(e.target.value)}>
            {wallets.map((w) => (
              <option key={w.id} value={w.id}>
                {w.label}
              </option>
            ))}
          </select>
        )}
        <input
          type="password"
          autoFocus
          placeholder={t("local_password")}
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void unlock();
          }}
        />
        {err && <p className="approve-error">{err}</p>}
        <button disabled={busy || !pw || !pickedId} onClick={() => void unlock()}>
          {busy ? t("local_unlocking") : t("local_unlock_cta")}
        </button>
        <p className="approve-note">{t("cip30_window_note")}</p>
      </div>
    );
  }

  if (phase.at === "connect") {
    return (
      <div className="approve">
        <OriginLine />
        <p className="mono approve-account">{primaryAddress(account)}</p>
        <div className="approve-summary">
          <p className="approve-heading">{t("cip30_connect_asks")}</p>
          <ul>
            <li>{t("cip30_connect_reads")}</li>
            <li>{t("cip30_connect_no_spend")}</li>
          </ul>
        </div>
        <div className="approve-actions">
          <button onClick={() => answer({ ok: false, error: declined(t("cip30_declined")) })}>
            {t("cip30_reject")}
          </button>
          <button
            disabled={busy}
            onClick={() => answer({ ok: true, value: true })}
            className="approve-primary"
          >
            {t("cip30_connect_allow")}
          </button>
        </div>
      </div>
    );
  }

  if (phase.at === "decide") {
    const { summary, undescribable, req } = phase;
    return (
      <div className="approve">
        <OriginLine />
        <p className="mono approve-account">{primaryAddress(account)}</p>

        {req.method !== "signTx" && <p className="approve-error">{t("cip30_unsupported")}</p>}

        {undescribable && (
          <div className="approve-refuse">
            <p>⛔ {t("cip30_undescribable")}</p>
            <p className="approve-note">{undescribable}</p>
          </div>
        )}

        {summary && (
          <div className="approve-summary">
            <p className="approve-heading">{t("cip30_leaves_wallet")}</p>
            <ul>
              {summary.net.length === 0 && <li>{t("cip30_nothing_leaves")}</li>}
              {summary.net.map((n) => (
                <li key={n.unit || "ada"}>
                  {n.unit === ""
                    ? `${formatAda(n.amount < BigInt(0) ? -n.amount : n.amount)} ADA`
                    : `${(n.amount < BigInt(0) ? -n.amount : n.amount).toString()} ${assetLabel(n.assetNameHex)}`}
                  {n.amount < BigInt(0) && ` ${t("cip30_incoming")}`}
                </li>
              ))}
            </ul>
            <p className="approve-note">
              {t("cip30_fee")}: {formatAda(summary.fee)} ADA
            </p>
            {summary.withdrawalLovelace > BigInt(0) && (
              <p className="approve-note">
                {t("cip30_withdrawal")}: {formatAda(summary.withdrawalLovelace)} ADA
              </p>
            )}
            {summary.ownInputs < summary.totalInputs && (
              <p className="approve-error">
                {t("cip30_unknown_inputs", {
                  known: summary.ownInputs,
                  total: summary.totalInputs,
                })}
              </p>
            )}
            {summary.toOthers.length > 0 && (
              <>
                <p className="approve-heading">{t("cip30_paying")}</p>
                <ul>
                  {summary.toOthers.map((r, i) => (
                    <li key={i} className="approve-payout">
                      {/* Amount first: an address with no number beside it is a
                          line people skim past, and the number is the decision. */}
                      <b>{formatAda(r.lovelace)} ADA</b>
                      <span className="mono approve-addr">{r.address}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {(summary.certificates > 0 || summary.withdrawals > 0 || summary.mints > 0) && (
              <p className="approve-error">{t("cip30_extra_actions")}</p>
            )}
          </div>
        )}

        <div className="approve-actions">
          <button onClick={() => answer({ ok: false, error: declined(t("cip30_declined")) })}>
            {t("cip30_reject")}
          </button>
          <button
            disabled={busy || !summary || !!undescribable}
            onClick={() => void sign()}
            className="approve-primary"
          >
            {t("cip30_approve")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="approve">
      <OriginLine />
      <p className="mono approve-account">{primaryAddress(account)}</p>
      <p>{t("cip30_connected")}</p>
      <p className="approve-note">{t("cip30_close_to_disconnect")}</p>
      <p className="approve-note mono">{allAddresses(account).length} addresses</p>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nextProvider i18n={i18n}>
      <Approve />
    </I18nextProvider>
  </StrictMode>,
);
