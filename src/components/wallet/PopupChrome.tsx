/**
 * The extension popup's frame: top bar, bottom navigation, action buttons,
 * step indicator, balance figure.
 *
 * Presentation only. Nothing here holds a key, reads the keystore, signs, or
 * copies anything to the clipboard: every handler arrives as a prop from
 * `LocalWalletPanel`, which stays the one screen that touches the keys
 * (`check:keystore-boundary`). Swapping this file for another look cannot change
 * what the wallet does — that is the point of keeping it apart.
 *
 * Icons are inline SVG: the popup runs under `script-src 'self'` with no remote
 * fonts or images, and an icon font would be one more file to ship and audit.
 */
import { useId, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { formatAda, type PhoenixNetwork } from "@/lib/cardano";
import { FiatValue } from "./FiatValue";
import { UNREAD_FIGURE } from "./moneyNotice";

export type PopupView = "home" | "send" | "receive" | "history" | "staking" | "governance" | "settings";

export type IconName =
  | "home"
  | "send"
  | "receive"
  | "history"
  | "staking"
  | "governance"
  | "settings"
  | "lock"
  | "back";

/** Stroke paths on a 24×24 grid, drawn with `currentColor` so they follow the theme. */
const ICON_PATHS: Record<IconName, string[]> = {
  home: ["M3 11.5 12 4l9 7.5", "M5.5 10v9.5h13V10", "M10 19.5v-5h4v5"],
  send: ["M7 17 17 7", "M9 7h8v8"],
  receive: ["M17 7 7 17", "M15 17H7V9"],
  history: ["M12 7v5l3 2", "M3.5 12a8.5 8.5 0 1 0 2.5-6", "M3.5 4v4h4"],
  staking: ["M12 3 3 7.5l9 4.5 9-4.5L12 3Z", "M3 12l9 4.5 9-4.5", "M3 16.5 12 21l9-4.5"],
  governance: ["M4 9.5 12 4l8 5.5", "M5 20h14", "M6.5 10v7.5", "M10.5 10v7.5", "M13.5 10v7.5", "M17.5 10v7.5"],
  settings: [
    "M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z",
    "M19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.6-2-3.4-2.4.9a7.5 7.5 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.4A7.5 7.5 0 0 0 7 6.4l-2.4-.9-2 3.4 2 1.6a7.6 7.6 0 0 0 0 3l-2 1.6 2 3.4 2.4-.9a7.5 7.5 0 0 0 2.6 1.5l.4 2.4h4l.4-2.4a7.5 7.5 0 0 0 2.6-1.5l2.4.9 2-3.4-2-1.6Z",
  ],
  lock: ["M6 11h12v9.5H6z", "M8.5 11V8a3.5 3.5 0 0 1 7 0v3", "M12 15v2"],
  back: ["M15 5l-7 7 7 7"],
};

export function Icon({ name }: { name: IconName }) {
  return (
    <svg
      className="pw-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
    >
      {ICON_PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/** The phoenix mark: a flame-shaped wing in the brand amber. */
export function PhoenixMark({ large = false }: { large?: boolean }) {
  // One id per mark: the header and the welcome screen draw one each, and a
  // `url(#…)` that two gradients answer to takes whichever comes first.
  const fill = `pw-mark-fill-${useId().replace(/:/g, "")}`;
  return (
    <svg
      className={large ? "pw-mark pw-mark-large" : "pw-mark"}
      viewBox="0 0 32 32"
      aria-hidden
      focusable="false"
    >
      <defs>
        <linearGradient id={fill} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#d9612b" />
          <stop offset="1" stopColor="#f2c14e" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="#1e2128" />
      <path
        d="M16 5c1.6 3.4 5.8 5.6 6.4 10.2.5 4.2-2.4 8-6.4 8.8 2-1.8 2.4-4.4 1-6.4-.6 2-2 3-3.4 3.4.8-2.6-.4-4.6-2.2-5.8-.6 3.2-2.8 4.6-2.6 7.4C6.4 23.6 5 20 6 16.4 7.4 11.2 13 9.6 16 5Z"
        fill={`url(#${fill})`}
      />
    </svg>
  );
}

/**
 * Which network the wallet is on, in a colour per network.
 *
 * The two test networks are amber and violet and say "test" in their tooltip;
 * mainnet is the calm one. A badge that shouts on every screen teaches people
 * to stop reading it, and then the day it says "test" goes unnoticed too.
 */
export function NetworkBadge({ network }: { network: PhoenixNetwork }) {
  const { t } = useTranslation("wallet");
  const name =
    network === 1 ? t("network_mainnet") : network === 2 ? t("popup_net_preview") : t("popup_net_preprod");
  return (
    <span
      className={
        network === 1 ? "pw-net pw-net-mainnet" : network === 2 ? "pw-net pw-net-preview" : "pw-net pw-net-preprod"
      }
      title={network === 1 ? name : network === 2 ? t("network_preview") : t("network_preprod")}
    >
      <span className="pw-net-dot" aria-hidden />
      {name}
    </span>
  );
}

/**
 * Fixed top bar.
 *
 * `onLock` and `onSettings` are absent while nothing is unlocked: a Lock
 * button on a screen with nothing to lock reads as broken.
 */
export function PopupHeader({
  network,
  title,
  subtitle,
  onTitle,
  onLock,
  onSettings,
}: {
  network: PhoenixNetwork;
  title: string;
  subtitle?: string;
  onTitle?: () => void;
  onLock?: () => void;
  onSettings?: () => void;
}) {
  const { t } = useTranslation("wallet");
  const name = (
    <>
      <span className="pw-head-title">{title}</span>
      {subtitle && <span className="pw-head-sub">{subtitle}</span>}
    </>
  );
  return (
    <header className="pw-head">
      <PhoenixMark />
      {onTitle ? (
        <button type="button" className="pw-head-name pw-head-name-button" onClick={onTitle} aria-label={t("popup_wallet_menu")}>
          {name}
        </button>
      ) : (
        <div className="pw-head-name">{name}</div>
      )}
      <NetworkBadge network={network} />
      {onLock && (
        <button type="button" className="pw-icon-btn" onClick={onLock} aria-label={t("local_lock_cta")} title={t("local_lock_cta")}>
          <Icon name="lock" />
        </button>
      )}
      {onSettings && (
        <button
          type="button"
          className="pw-icon-btn"
          onClick={onSettings}
          aria-label={t("popup_nav_settings")}
          title={t("popup_nav_settings")}
        >
          <Icon name="settings" />
        </button>
      )}
    </header>
  );
}

const NAV: { view: PopupView; icon: IconName }[] = [
  { view: "home", icon: "home" },
  { view: "history", icon: "history" },
  { view: "staking", icon: "staking" },
  { view: "governance", icon: "governance" },
  { view: "settings", icon: "settings" },
];

/** Fixed bottom navigation. Send and Receive are screens under Home, so Home stays lit for them. */
export function PopupTabBar({ view, onSelect }: { view: PopupView; onSelect: (v: PopupView) => void }) {
  const { t } = useTranslation("wallet");
  const lit: PopupView = view === "send" || view === "receive" ? "home" : view;
  // Literal keys, one per call, so check:i18n-keys can see every one of them.
  const label: Partial<Record<PopupView, string>> = {
    home: t("popup_nav_home"),
    history: t("popup_nav_activity"),
    staking: t("tab_staking"),
    governance: t("tab_governance"),
    settings: t("popup_nav_settings"),
  };
  return (
    <nav className="pw-tabbar">
      {NAV.map((n) => {
        const active = n.view === lit;
        return (
          <button
            key={n.view}
            type="button"
            className={active ? "pw-tab pw-tab-active" : "pw-tab"}
            aria-current={active ? "page" : undefined}
            onClick={() => onSelect(n.view)}
          >
            <Icon name={n.icon} />
            <span className="pw-tab-label">{label[n.view]}</span>
          </button>
        );
      })}
    </nav>
  );
}

/** A round action button with its label under it (Send · Receive · Staking · History). */
export function ActionButton({
  icon,
  label,
  onClick,
  disabled = false,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button type="button" className="pw-action" onClick={onClick} disabled={disabled}>
      <span className="pw-action-circle">
        <Icon name={icon} />
      </span>
      <span className="pw-action-label">{label}</span>
    </button>
  );
}

/** Title row of a screen opened from Home, with the way back. */
export function ScreenHeader({ title, onBack }: { title: string; onBack: () => void }) {
  const { t } = useTranslation("wallet");
  return (
    <div className="pw-screen-head">
      <button type="button" className="pw-icon-btn" onClick={onBack} aria-label={t("popup_back")} title={t("popup_back")}>
        <Icon name="back" />
      </button>
      <h2 className="pw-screen-title">{title}</h2>
    </div>
  );
}

/** "Step n of m" with one segment per step. */
export function StepProgress({ labels, current }: { labels: string[]; current: number }) {
  const { t } = useTranslation("wallet");
  return (
    <div className="pw-steps">
      <p className="pw-steps-caption">
        {t("popup_step_progress", { n: current + 1, total: labels.length })} · {labels[current]}
      </p>
      {/* Decoration: the caption above already says the step in words. */}
      <ol className="pw-steps-bar" aria-hidden="true">
        {labels.map((_, i) => (
          <li key={i} className={i <= current ? "pw-step pw-step-done" : "pw-step"} />
        ))}
      </ol>
    </div>
  );
}

/**
 * The balance, large. While the read is in flight the figure is dimmed rather
 * than hidden — the line under it says why (`balanceStatus` in the panel).
 */
export function BalanceHero({
  lovelace,
  network,
  settled,
  children,
}: {
  lovelace: bigint;
  network: PhoenixNetwork;
  settled: boolean;
  children?: ReactNode;
}) {
  const { t } = useTranslation("wallet");
  return (
    <div className="pw-balance">
      <p className="pw-balance-label">{t("balance_label")}</p>
      {/* Unread is a dash, not the starting zero: see `settled` in BalanceView. */}
      <p
        className={settled ? "pw-balance-figure" : "pw-balance-figure pw-balance-pending"}
        data-settled={settled ? "true" : "false"}
      >
        {settled ? formatAda(lovelace) : UNREAD_FIGURE} <span className="pw-balance-unit">ADA</span>
      </p>
      {/* FiatValue refuses to price a test network itself (see BalanceView). */}
      {settled && <FiatValue lovelace={lovelace} network={network} />}
      {children}
    </div>
  );
}
