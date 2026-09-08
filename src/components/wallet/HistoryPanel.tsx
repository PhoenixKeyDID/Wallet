"use client";

import "../../lib/node-globals";
import { useCallback, useEffect, useRef, useState } from "react";
import { Buffer } from "buffer";
import { useTranslation } from "react-i18next";
import { utils as tyUtils } from "@stricahq/typhonjs";
import { toastApiError } from "@/lib/toast";
import { CopyBtn } from "@/components/CopyBtn";
import { formatAda, assetLabel, type PhoenixNetwork, type WalletPort } from "@/lib/cardano";
import { rewardAddressFromHex } from "@/lib/cardano/staking";
import {
  fetchHistory,
  rowDisplay,
  confirmationsOf,
  HISTORY_PAGE,
  HISTORY_MAX,
  type HistoryEntry,
  type UnreadableTx,
  type TxKind,
} from "@/lib/cardano/history";

const KIND_LABEL: Record<TxKind, string> = {
  sent: "hist_kind_sent",
  received: "hist_kind_received",
  internal: "hist_kind_internal",
  withdrawal: "hist_kind_withdrawal",
  delegation: "hist_kind_delegation",
  mint: "hist_kind_mint",
};

const KIND_ICON: Record<TxKind, string> = {
  sent: "↗",
  received: "↙",
  internal: "↻",
  withdrawal: "🥩",
  delegation: "🗳",
  mint: "✦",
};

/**
 * One row's ADA line, signed and coloured from the wallet's side.
 *
 * The sign is written out rather than left to `formatAda`, which prints a minus
 * for a negative and nothing for a positive — and "5" next to "-5" reads as an
 * amount whose direction was forgotten, not as an amount that arrived.
 */
function AdaLine({ amount }: { amount: bigint }) {
  const positive = amount > BigInt(0);
  return (
    <span
      className={"mono font-semibold " + (positive ? "text-teal-brand" : "text-text")}
      // The full lovelace figure, because the display above is in ADA and a
      // person checking against a block explorer is checking lovelace.
      title={amount.toString()}
    >
      {positive ? "+" : ""}
      {formatAda(amount)} ADA
    </span>
  );
}

/**
 * Transaction history for the account this wallet is holding or connected to.
 *
 * Two things this screen deliberately does not do:
 *
 * 1. **No link to a block explorer.** A link is one click from handing a third
 *    party the association between these addresses and this browser — the same
 *    association the rest of the module works to avoid, and the reason this tab
 *    exists at all. The transaction id is shown and copyable instead, so anyone
 *    who wants an explorer can paste it into one deliberately.
 * 2. **No amount at all when the numbers cannot be trusted.** See the
 *    `ownedIsComplete` note below: a wallet that lists only some of its own
 *    addresses makes its own change look like a payment to a stranger, and a
 *    plausible wrong number is worse here than an admission of not knowing.
 */
export function HistoryPanel({
  port,
  network,
}: {
  port: WalletPort;
  network: PhoenixNetwork;
}) {
  const { t, i18n } = useTranslation("wallet");
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [tip, setTip] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  /**
   * Set when a read failed. Kept in state rather than left to a toast, because
   * a toast is gone in seconds and the screen behind it is indistinguishable
   * from a wallet that has never transacted. "You have no history" and "this
   * did not load" are different facts about someone's money.
   */
  const [failed, setFailed] = useState(false);
  const [unreadable, setUnreadable] = useState<UnreadableTx[]>([]);
  const [limit, setLimit] = useState(HISTORY_PAGE);
  const [mayHaveMore, setMayHaveMore] = useState(false);
  /**
   * Which read owns the screen.
   *
   * Same reason the balance read carries one: switching account or wallet, or
   * pressing refresh, starts a second read while the first is still going, and
   * whichever *finishes* last would otherwise win — which is not the same as
   * whichever the user asked for last. Here that would put one account's
   * transactions under another account's name, and the failure path is worse
   * still: this panel deliberately keeps the previous list when a read fails,
   * so a failed read on account B would leave account A's history on screen
   * with a warning that says nothing about whose it is.
   */
  const run = useRef(0);

  const load = useCallback(async () => {
    const mine = (run.current += 1);
    const current = () => run.current === mine;
    setLoading(true);
    try {
      const owned = (await port.getOwnedAddressesHex()).map((hex) =>
        tyUtils.getAddressFromHex(Buffer.from(hex, "hex")).getBech32(),
      );
      // The reward address is what says which withdrawals in a transaction are
      // this wallet's. Without it, a stranger's reward claim riding along with a
      // payment to us would be subtracted from our own total. A port that
      // cannot answer gets an empty list, and rows carrying a withdrawal then
      // show no amount rather than a wrong one — so this failing must not take
      // the whole page down with it.
      //
      // `rewardAddressFromHex` rather than the generic decoder, and that is not
      // a style preference. CIP-30 defines an address as `cbor<address>`, and
      // some wallets answer with the CBOR bytestring wrapper still on. Measured
      // with this repo's own typhonjs: the bare hex decodes to a RewardAddress,
      // while `581d` + the same bytes decodes — without throwing — to a
      // PointerAddress with a completely different bech32 string. Fed in here
      // that produces a non-empty set of "our" reward addresses that matches
      // nothing, so the wallet's own reward withdrawals are filed as strangers'
      // and `unattributed` never fires: a withdrawal of 100 ADA reads as
      // "Received", with "Rewards collected: 0". The strict version checks the
      // decoded type and is already used by the staking and governance panels.
      let stake: string[] = [];
      try {
        stake = [rewardAddressFromHex(await port.getRewardAddressHex()).getBech32()];
      } catch (err) {
        // A wallet with no reward address is an ordinary answer; anything else
        // is this module failing to read something it was given, which the
        // reader should hear about. Both leave `stake` empty, so a row carrying
        // a withdrawal shows no amount either way — the difference is whether
        // it is reported.
        if (!(err instanceof Error) || !/stake_account/.test(err.message)) toastApiError(err);
      }
      const page = await fetchHistory(network, owned, stake, limit);
      if (!current()) return;
      setEntries(page.entries);
      setUnreadable(page.unreadable);
      setTip(page.tipBlockHeight);
      setMayHaveMore(page.mayHaveMore);
      // Cleared here, not at the start of the read. Clearing it up front unmounts
      // the failure box — and the retry button inside it — the instant it is
      // pressed, so the press reads as a miss and the box reappears a moment
      // later as if nothing had happened.
      setFailed(false);
    } catch (err) {
      if (!current()) return;
      toastApiError(err);
      setFailed(true);
      // Leave `entries` as it was. Replacing a loaded list with an empty one on
      // a failed refresh would say "you have no transactions" because the
      // network blipped — the silent shell this repo has paid for before.
    } finally {
      if (current()) setLoading(false);
    }
  }, [port, network, limit]);

  useEffect(() => {
    void load();
  }, [load]);

  // A new wallet or account starts at the first page again. Without this, opening
  // a fresh account inherits a widened window and asks for far more history than
  // it has.
  useEffect(() => {
    setEntries(null);
    setUnreadable([]);
    setLimit(HISTORY_PAGE);
  }, [port]);

  return (
    <div className="space-y-4">
      <div className="rounded-brand border border-border-soft bg-bg1 p-5 space-y-3">
        <p className="text-sm text-text-dim">{t("hist_intro")}</p>
        <button
          type="button"
          disabled={loading}
          onClick={() => void load()}
          className="text-xs text-text-hint hover:text-text-dim disabled:opacity-50"
        >
          {loading ? t("loading") : t("hist_refresh")}
        </button>
      </div>

      {/*
        A CIP-30 extension answers `getUsedAddresses`/`getUnusedAddresses` with
        what it chooses to admit to, which is a subset of what it owns. Every
        address it did not mention is read here as someone else's, so its own
        change is counted as money paid out and the row says "sent 95 ADA" for a
        5 ADA payment. The measurement is unavailable, so the screen says that
        rather than showing a number it cannot stand behind.
      */}
      {!port.ownedIsComplete && (
        <div className="rounded-brand border border-border-amber bg-amber-brand/10 p-4 text-sm text-amber-brand space-y-1">
          <p className="font-semibold">⚠ {t("hist_partial_title")}</p>
          <p className="text-xs">{t("hist_partial_body")}</p>
        </div>
      )}

      {/*
        Where the numbers come from, said once and plainly. The indexer is a
        public, unauthenticated service: it is not asked to prove anything, and
        nothing here re-derives a transaction from the chain itself. That is
        fine for looking back at what you did, and it is not proof that a
        payment arrived — which matters because "the wallet says I received it"
        is exactly what someone hands over goods on.
      */}
      <p className="text-xs text-text-hint">{t("hist_source_note")}</p>

      {failed && (
        <div className="rounded-brand border border-border-amber bg-amber-brand/10 p-4 text-sm text-amber-brand space-y-2">
          <p className="font-semibold">⚠ {t("hist_failed_title")}</p>
          <p className="text-xs">{t("hist_failed_body")}</p>
          <button
            type="button"
            disabled={loading}
            onClick={() => void load()}
            className="rounded-brand-sm border border-border-amber px-3 py-1.5 text-xs disabled:opacity-50"
          >
            {loading ? t("loading") : t("hist_refresh")}
          </button>
        </div>
      )}

      {/*
        Named, not dropped. One transaction this module cannot read no longer
        takes the other twenty-four with it — but a list that is quietly short
        is the thing this whole file argues against, so the ones it could not
        read are stated with their ids.
      */}
      {unreadable.length > 0 && (
        <div className="rounded-brand border border-border-amber bg-amber-brand/10 p-4 text-sm text-amber-brand space-y-2">
          <p className="font-semibold">⚠ {t("hist_unreadable_title")}</p>
          <p className="text-xs">{t("hist_unreadable_body", { count: unreadable.length })}</p>
          <ul className="space-y-1">
            {unreadable.map((u) => (
              <li key={u.txHash} className="flex items-center gap-2 text-xs min-w-0">
                <span className="mono truncate">{u.txHash}</span>
                <CopyBtn value={u.txHash} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {entries !== null && entries.length === 0 && !loading && !failed && (
        <div className="rounded-brand border border-border-soft bg-bg1 p-5 text-sm text-text-hint">
          {t("hist_empty")}
        </div>
      )}

      {entries !== null && entries.length > 0 && (
        <ul className="rounded-brand border border-border-soft bg-bg1 divide-y divide-border-soft">
          {entries.map((e) => {
            const display = rowDisplay(e, port.ownedIsComplete);
            const tokens = display.show ? display.tokens : [];
            const expanded = open === e.txHash;
            const confirmations = confirmationsOf(e, tip);
            return (
              <li key={e.txHash} className="p-4 space-y-2">
                <button
                  type="button"
                  onClick={() => setOpen(expanded ? null : e.txHash)}
                  className="w-full flex items-start justify-between gap-3 text-left"
                >
                  <span className="min-w-0">
                    <span className="block text-sm">
                      <span aria-hidden className="mr-1.5">
                        {KIND_ICON[e.kind]}
                      </span>
                      {t(KIND_LABEL[e.kind])}
                    </span>
                    <span className="block text-xs text-text-hint">
                      {new Date(e.timeMs).toLocaleString(i18n.language)}
                    </span>
                  </span>
                  <span className="text-right shrink-0">
                    {display.show ? (
                      <AdaLine amount={display.ada} />
                    ) : (
                      <span className="text-xs text-text-hint">
                        {display.reason === "withdrawal_owner_unknown"
                          ? t("hist_amount_unknown_withdrawal")
                          : t("hist_amount_unknown")}
                      </span>
                    )}
                    <span className="block text-[10px] text-text-hint">
                      {expanded ? "▾" : "▸"}
                    </span>
                  </span>
                </button>

                {tokens.length > 0 && (
                  <ul className="space-y-1">
                    {tokens.map((tk) => (
                      <li key={tk.unit} className="flex items-center justify-between gap-2 text-xs">
                        {/* Same reason as the balance list: a token name is
                            chosen by whoever minted it, so the policy id is
                            always next to it rather than behind a hover. */}
                        <span className="min-w-0">
                          <span className="mono block truncate" title={tk.unit}>
                            {assetLabel(tk.assetNameHex)}
                          </span>
                          <span className="mono block text-[10px] text-text-hint truncate">
                            {tk.policyId.slice(0, 8)}…{tk.policyId.slice(-4)}
                          </span>
                        </span>
                        <span
                          className={
                            "mono shrink-0 " +
                            (tk.amount > BigInt(0) ? "text-teal-brand" : "text-text-dim")
                          }
                        >
                          {tk.amount > BigInt(0) ? "+" : ""}
                          {tk.amount.toString()}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}

                {expanded && (
                  <dl className="space-y-1.5 text-xs border-t border-border-soft pt-2">
                    {/*
                      The one hidden-amount case with no explanation anywhere
                      else on the screen. The partial-address case has a banner
                      at the top of the tab; this one had four grey words and
                      nothing to read next, in a row about someone's money.
                    */}
                    {!display.show && display.reason === "withdrawal_owner_unknown" && (
                      <p className="text-text-hint leading-relaxed">
                        {t("hist_amount_unknown_withdrawal_why")}
                      </p>
                    )}
                    <div className="flex items-start justify-between gap-2">
                      <dt className="text-text-hint shrink-0">{t("hist_tx_id")}</dt>
                      <dd className="flex items-center gap-2 min-w-0">
                        <span className="mono text-text-dim truncate">{e.txHash}</span>
                        <CopyBtn value={e.txHash} />
                      </dd>
                    </div>
                    {/*
                      The minus sign only when this wallet actually paid it. On a
                      receive the sender funded the transaction, so the fee never
                      came out of this wallet and is not inside the amount above;
                      printing "−0.170000" there tells someone who just received
                      5 ADA that they got 4.83.
                    */}
                    <div className="flex items-center justify-between gap-2">
                      <dt className="text-text-hint">
                        {e.feePaidByUs ? t("hist_fee") : t("hist_fee_paid_by_sender")}
                      </dt>
                      <dd className="mono text-text-dim">
                        {e.feePaidByUs ? "-" : ""}
                        {formatAda(e.fee)} ADA
                      </dd>
                    </div>
                    {e.withdrawnLovelace > BigInt(0) && (
                      <div className="flex items-center justify-between gap-2">
                        <dt className="text-text-hint">{t("hist_rewards")}</dt>
                        <dd className="mono text-teal-brand">
                          +{formatAda(e.withdrawnLovelace)} ADA
                        </dd>
                      </div>
                    )}
                    <div className="flex items-center justify-between gap-2">
                      <dt className="text-text-hint">{t("hist_block")}</dt>
                      <dd className="mono text-text-dim">{e.blockHeight}</dd>
                    </div>
                    {confirmations !== null && (
                      <div className="flex items-center justify-between gap-2">
                        <dt className="text-text-hint">{t("hist_confirmations")}</dt>
                        <dd className="mono text-text-dim">{confirmations}</dd>
                      </div>
                    )}
                    {/*
                      Only on a row that sent something. `counterparties` is
                      every output address that is not ours, which on a *receive*
                      is the sender's own change address — showing it under "To"
                      tells the reader their money went somewhere it did not, and
                      hands them an unrelated address in full, ready to copy.
                    */}
                    {/*
                      …and only when the wallet knows all of its own addresses.
                      `counterparties` is "every output address not in the set we
                      were given", so an extension that withheld one of its own
                      puts the reader's *own* change address in this list, in
                      full, ready to copy. Hiding the amount while publishing an
                      address derived from the same untrusted set would be two
                      different answers to one question.
                    */}
                    {port.ownedIsComplete && e.kind === "sent" && e.counterparties.length > 0 && (
                      <div className="space-y-1">
                        <dt className="text-text-hint">{t("hist_to")}</dt>
                        {/* Never truncated: a shortened address is exactly what
                            an address-swap attack survives, since the first and
                            last characters are the cheap part to match. */}
                        {e.counterparties.map((addr) => (
                          <dd key={addr} className="mono text-text-dim break-all">
                            {addr}
                          </dd>
                        ))}
                      </div>
                    )}
                  </dl>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/*
        Without this the newest 25 are all anyone can ever see, and there is no
        block-explorer link to fall back on — that omission is deliberate and is
        what makes this control necessary rather than a convenience. It also
        closes a cheap attack: about 25 dust payments after a real one push it
        out of the window for good, and the addresses share a single window, so
        spamming one of them buries the whole wallet's history.
      */}
      {entries !== null && entries.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 text-xs text-text-hint">
          <span>{t("hist_shown_recent", { count: entries.length })}</span>
          {mayHaveMore && limit < HISTORY_MAX && (
            <button
              type="button"
              disabled={loading}
              onClick={() => setLimit((n) => Math.min(n * 2, HISTORY_MAX))}
              className="rounded-brand-sm border border-border-soft px-3 py-1.5 hover:text-text-dim disabled:opacity-50"
            >
              {loading ? t("loading") : t("hist_show_more")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
