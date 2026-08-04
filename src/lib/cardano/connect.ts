/**
 * Connect — bridge the Phoenix web wallet to third-party dApps (Minswap, SundaeSwap…).
 *
 * The hard constraint: Phoenix `/wallet` is a *web page*, not a browser
 * extension, and it holds NO spendable seed (see `web-wallet-no-hot-wallet`).
 * Two facts flow from that:
 *   1. A page CANNOT inject `window.cardano` into another site's page — only an
 *      extension can. So "connect to Minswap" is not the extension experience.
 *   2. To serve a dApp a wallet must be able to SIGN. Phoenix never signs with a
 *      local seed; it *delegates* signing to the already-connected CIP-30
 *      extension (later: air-gap QR / mobile enclave).
 *
 * This module provides the safe, testable core of that bridge:
 *   - `buildCip30Provider(api)` wraps a connected `Cip30Api` in a CIP-30-shaped
 *     provider object. Read methods delegate straight through; sign/submit
 *     delegate to the same connected wallet (which owns the keys). This is the
 *     object a CIP-45 peer session or a (future, opt-in) embedded dApp frame
 *     would expose — never an auto-injection into an arbitrary site.
 *   - `KNOWN_DAPPS` — a curated, hand-reviewed launcher registry. Curation is a
 *     security control: we do not offer to connect to arbitrary URLs.
 *
 * NO iframe injection, NO DOM side-effects here — pure, unit-testable functions.
 * Spec surface: `PhoenixKey-Specs/PhoenixKey-DappConnector-Feat.md`.
 */
import type { Cip30Api } from "./cip30";

// ─── CIP-30 provider bridge ───────────────────────────────────────────────────

/**
 * The CIP-30 "full API" surface a dApp receives from `enable()`. Structurally
 * identical to {@link Cip30Api} — by design: a faithful bridge exposes exactly
 * what the connected wallet exposes, no more, no less.
 */
export type Cip30Provider = {
  getNetworkId(): Promise<number>;
  getUtxos(amount?: string, paginate?: unknown): Promise<string[] | null>;
  getBalance(): Promise<string>;
  getUsedAddresses(paginate?: unknown): Promise<string[]>;
  getUnusedAddresses(): Promise<string[]>;
  getChangeAddress(): Promise<string>;
  getRewardAddresses(): Promise<string[]>;
  signTx(tx: string, partialSign?: boolean): Promise<string>;
  signData(addr: string, payload: string): Promise<{ signature: string; key: string }>;
  submitTx(tx: string): Promise<string>;
};

/** The read-only (view) subset — safe to expose without any signing capability. */
export const CIP30_READ_METHODS = [
  "getNetworkId",
  "getUtxos",
  "getBalance",
  "getUsedAddresses",
  "getUnusedAddresses",
  "getChangeAddress",
  "getRewardAddresses",
] as const;

/** The write (signing) subset — every one delegates to the connected wallet. */
export const CIP30_SIGN_METHODS = ["signTx", "signData", "submitTx"] as const;

/** Every method a compliant CIP-30 provider must expose. */
export const CIP30_PROVIDER_METHODS = [
  ...CIP30_READ_METHODS,
  ...CIP30_SIGN_METHODS,
] as const;

/**
 * Optional guards. A dApp bridge must NEVER blind-sign: `beforeSign` /
 * `beforeSubmit` let the UI interpose a plain-language review + explicit user
 * approval before the connected wallet is asked to sign or before a tx is
 * pushed. Returning a rejected promise (or throwing) aborts the operation.
 * Defaults are pass-through so the bridge is usable without a UI in tests.
 */
export type ProviderGuards = {
  beforeSign?: (kind: "tx" | "data", payload: string) => Promise<void> | void;
  beforeSubmit?: (txCborHex: string) => Promise<void> | void;
};

/**
 * Wrap a connected wallet's `Cip30Api` in a CIP-30 provider that a dApp session
 * can consume. Reads delegate through unchanged; signing/submitting delegate to
 * the same connected wallet (the only thing that holds keys). Optionally routes
 * every sign/submit through `guards` so the UI can force a review step.
 *
 * This never touches the DOM and never injects anything — it only produces the
 * object a transport layer (CIP-45 peer, opt-in embedded frame) would hand to a
 * dApp. Choosing that transport is a separate, deliberate decision.
 */
export function buildCip30Provider(api: Cip30Api, guards: ProviderGuards = {}): Cip30Provider {
  return {
    // ── read-only: straight delegation ──
    getNetworkId: () => api.getNetworkId(),
    getUtxos: (amount?: string, paginate?: unknown) => api.getUtxos(amount, paginate),
    getBalance: () => api.getBalance(),
    getUsedAddresses: (paginate?: unknown) => api.getUsedAddresses(paginate),
    getUnusedAddresses: () => api.getUnusedAddresses(),
    getChangeAddress: () => api.getChangeAddress(),
    getRewardAddresses: () => api.getRewardAddresses(),

    // ── signing: delegated to the connected wallet, gated by an optional review ──
    async signTx(tx: string, partialSign?: boolean): Promise<string> {
      if (guards.beforeSign) await guards.beforeSign("tx", tx);
      return api.signTx(tx, partialSign);
    },
    async signData(addr: string, payload: string): Promise<{ signature: string; key: string }> {
      if (guards.beforeSign) await guards.beforeSign("data", payload);
      return api.signData(addr, payload);
    },
    async submitTx(tx: string): Promise<string> {
      if (guards.beforeSubmit) await guards.beforeSubmit(tx);
      return api.submitTx(tx);
    },
  };
}

/**
 * Build a provider for a REAL dApp transport (CIP-45 peer / embedded frame).
 * Unlike {@link buildCip30Provider}, this REQUIRES both guards: a dApp session
 * must never reach the connected wallet's `signTx`/`submitTx` without Phoenix's
 * own plain-language review interposed first. Wiring a transport therefore has
 * to go through here — a guardless provider cannot be handed to a dApp by
 * accident. `buildCip30Provider` stays the low-level primitive (used in tests
 * and internally); production wiring uses this.
 */
export function buildDappProvider(
  api: Cip30Api,
  guards: Required<ProviderGuards>,
): Cip30Provider {
  if (typeof guards?.beforeSign !== "function" || typeof guards?.beforeSubmit !== "function") {
    throw new Error("buildDappProvider requires both beforeSign and beforeSubmit guards");
  }
  return buildCip30Provider(api, guards);
}

// ─── Curated dApp launcher registry ───────────────────────────────────────────

export type DappCategory = "dex" | "lending" | "identity" | "other";

/**
 * How a user connects Phoenix to this dApp given the no-hot-wallet model:
 *   - "extension": open the dApp; connect there using the browser EXTENSION
 *     wallet Phoenix is already bridged to. The realistic, safe path today.
 *   - "cip45": the dApp supports CIP-45 peer connect (QR / deep link) — a wallet
 *     page CAN pair without an extension. Enabled per-dApp only once verified.
 */
export type DappConnectMode = "extension" | "cip45";

export type KnownDapp = {
  /** stable slug, also the i18n sub-key. */
  id: string;
  name: string;
  /** canonical https origin of the dApp. */
  url: string;
  /** emoji stand-in for a logo (no remote images — CSP + privacy). */
  emoji: string;
  category: DappCategory;
  /** i18n key (wallet namespace) for the plain-language blurb. */
  descKey: string;
  /** English fallback blurb (used if a locale lacks the key). */
  description: string;
  connectMode: DappConnectMode;
};

/**
 * Hand-reviewed dApps. Curation IS the security boundary: Phoenix offers to
 * launch only vetted, well-known dApps at their canonical URLs — it does not
 * connect to arbitrary user-supplied sites.
 */
export const KNOWN_DAPPS: readonly KnownDapp[] = [
  {
    id: "minswap",
    name: "Minswap",
    url: "https://minswap.org/",
    emoji: "🐬",
    category: "dex",
    descKey: "dapp_minswap_desc",
    description: "Swap tokens and provide liquidity on Cardano's largest DEX.",
    connectMode: "extension",
  },
  {
    id: "sundaeswap",
    name: "SundaeSwap",
    url: "https://app.sundae.fi/",
    emoji: "🍨",
    category: "dex",
    descKey: "dapp_sundaeswap_desc",
    description: "Swap and provide liquidity on the SundaeSwap DEX.",
    connectMode: "extension",
  },
] as const;

/** Look up a curated dApp by its slug. */
export function getKnownDapp(id: string): KnownDapp | undefined {
  return KNOWN_DAPPS.find((d) => d.id === id);
}

/**
 * The embedded dApp browser (loading a dApp in an iframe and injecting a
 * Phoenix-backed CIP-30 provider into THAT frame) is deliberately OFF. It has
 * real CSP / same-origin / clickjacking implications and is not shipped in v1.
 * The UI shows it as a clearly-labelled, disabled "coming soon" affordance.
 */
export const EMBEDDED_DAPP_BROWSER_ENABLED = false as const;
