# Phoenix Wallet — Specification

Status: **beta, unaudited** · Scope: this module (`PhoenixKeyDID/Wallet`) · Audience: integrators, reviewers, and users who want to understand exactly what this wallet does and does not do with their keys.

This document is the source of truth for the module's behaviour and security model. If code and this spec disagree, that is a bug in one of them — file it.

---

## 1. What this is

A pure-JavaScript Cardano wallet module for the browser. It lets a user **view balances** and **build/sign/submit transactions** (send, delegate, withdraw rewards, vote, register as a dRep) — and hand off to the Midnight NIGHT redemption portal — **without the web page ever holding a spendable seed**.

It is designed to drop into a host application (the PhoenixKey Standard wallet / Frontend). It can be used **like a traditional wallet** (connect a standard Cardano extension, or watch an account public key) or alongside a **Phoenix DID** for the Phoenix-specific custody view — both at once.

### Non-goals (v1)

- It does **not** create wallets, generate seeds, or import a recovery phrase. There is no "paste your 24 words" flow, by design (§3).
- It does **not** spend from a Phoenix DID custody address (that is a script address; v1 shows its balance only — see §5.6).
- It does **not** build or sign the NIGHT redemption transaction; `/night` hands off to the official Midnight portal (§5.7).

---

## 2. Security model (read this first)

Security is the top priority and is enforced **structurally**, not by promises.

### 2.1 Core invariant — no hot wallet, ever

The page never holds a spendable seed or private key. There is no code path that accepts a mnemonic or derives a signing key. This is verifiable: a search of `src/` for `bip39`, `mnemonicTo*`, or `fromMnemonic` returns nothing. Every spend is either:

1. **delegated to a CIP-30 browser extension** (Lace / Eternl / Typhon) — the extension holds the keys, shows the transaction, and the user approves it there; or
2. (phase 2) **co-signed offline** over an air-gap QR channel — the seed stays on a separate offline device.

Consequence: even a bug in this module cannot exfiltrate a key. The worst a malformed transaction can do is be rejected by the extension review or bounce at the node — it cannot silently move funds, because this module is never the final signing authority.

### 2.2 Invariant M2-WATCH — watch-only cannot sign

Watch-only mode consumes an **account extended _public_ key** (`acct_xvk`, 64 bytes = 32 pubkey ‖ 32 chaincode) and performs only BIP32-Ed25519 **soft** (`CKDpub`) derivation. No private key is derivable from a public key; this mode can reproduce the exact addresses the real signer will spend from, and read their balances, but can never sign. `parseAcctXvk` rejects anything that is not exactly 64 bytes (a 32-byte plain key or a 96-byte private key is refused).

### 2.3 Security priority order

Security > Privacy > Experience > Cost. Where these conflict, the earlier one wins, and the conflict is called out to the user rather than hidden. A cheaper or smoother option that moves authority off the ledger is rejected.

### 2.4 Persistent, non-dismissable warning

Every page that can move funds renders a persistent, non-dismissable beta/unaudited banner. It cannot be hidden by state or local storage. Its copy covers **every** signing feature (send, staking, governance), not just send.

---

## 3. Architecture — three modes, none types a seed online

| Mode | View | Sign / spend | v1 |
|---|---|---|---|
| **Connect (CIP-30)** — Lace / Eternl / Typhon | ✅ from the extension | ✅ the extension signs | ✅ full |
| **Watch-only (`acct_xvk`)** | ✅ derived client-side from the account public key | ❌ view only | ✅ |
| **Phoenix custody (by DID)** | ✅ reads the script address + public balances | ❌ view only | ✅ view |
| **Air-gap QR co-sign** | ✅ (reuses the watch-only key) | 🟡 offline device signs → QR witness | 🟡 web scaffolded; enabled when the offline signer ships |

The Phoenix custody address is a **script** (enterprise) address spent by the `did_payment` validator, which requires a controller-key witness. A CIP-30 extension cannot sign for it, so v1 exposes the custody balance for viewing; spending goes through the air-gap / mobile signer path in a later phase.

### 3.1 Standards used

- **CIP-1852** — HD derivation. Chains: `0` external payment, `2` stake, `3` dRep (CIP-105/CIP-129).
- **CIP-19** — address assembly (base, enterprise, reward).
- **CIP-30** — dApp/extension connector (read + `signTx`/`signData`/`submitTx`).
- **CIP-95** — `getPubDRepKey`, used for governance flows that need the dRep key.
- **CIP-108 / CIP-1694 (Conway)** — governance anchors and voting/proposal procedures.

### 3.2 Library choice

The Cardano layer is pure TypeScript with **no WebAssembly**: `@stricahq/typhonjs` (Apache-2.0, open source) for transaction building/serialization and address assembly, `@stricahq/bip32ed25519` for CKDpub soft-derivation, `@stricahq/cbors` for CBOR, `@noble/hashes` for blake2b, and `bech32`. WASM was avoided so the module runs in any host without special bundler configuration. `@stricahq/typhonjs` only **builds and serializes** transactions; it never sees a private key — signing is always delegated (§2.1).

Address assembly is cross-checked against the Rust reference (`phoenix_address.rs` / `cardano.rs`) by golden vectors in `__tests__/address.test.ts`: if the browser derivation ever drifts from the canonical CLI derivation, the test fails.

---

## 4. Derivation

```
payment_pub_i = CKDpub(acct_xvk, 0) → CKDpub(·, i)   -- chain 0 (external), index i
stake_pub     = CKDpub(acct_xvk, 2) → CKDpub(·, 0)   -- chain 2 (stake)
drep_pub      = CKDpub(acct_xvk, 3) → CKDpub(·, 0)   -- chain 3 (dRep, CIP-105)
addr_i        = base_addr(pkh(payment_pub_i), pkh(stake_pub))
```

- `pkh` = blake2b-224 of the public key (28 bytes), CIP-19 credential.
- Path label: `m/1852'/1815'/0'/0/i`.
- Only **soft** indices are valid from a public key: an index ≥ 2³¹ (`0x80000000`) is a hardened index and is rejected up front with a clear message (`keyHashAt`), rather than surfacing an opaque library error.
- Network ids (rust_core convention): `0` preprod, `1` mainnet, `2` preview. Preprod and preview share the testnet address header; only mainnet carries the mainnet header.

---

## 5. Features

Each fund-moving feature is **two-step**: build an unsigned transaction → show every recipient / amount / fee / network in plain language → the user confirms → the extension signs and the module submits. Never build blind.

### 5.1 Send (multi-recipient, multi-asset)

- One or more assets (ADA + native tokens) to one or more recipients in a single transaction.
- Each recipient address is parsed and re-encoded from its bytes; the **full** bech32 address is shown in the review (never truncated), so the confirm checkbox is meaningful against address-poisoning.
- Recipients on the wrong network are rejected **before** build (`addr_wrong_network`) rather than failing at submit.
- Token-bearing outputs are bumped to the protocol minimum-UTxO automatically, and the review shows the **effective** amounts that actually leave the wallet — a token-only row is never displayed as "0 ADA".
- Token amounts are entered in **raw on-chain units** (no decimal scaling); the UI states this explicitly next to the field.

### 5.2 Receive

- Derives base or enterprise (receive-only) addresses at any index from the connected wallet's account key.
- **Ownership check:** when an `acct_xvk` is pasted, the module derives addresses 0..23 and compares them to the connected wallet's own used/unused addresses. A key that is not the connected wallet's raises a mismatch warning — this catches a social-engineering attempt to make you receive into someone else's wallet. (A standalone watch-only view has no wallet to check against, so it warns explicitly to only paste your own key.)

### 5.3 Staking

- Search pools, delegate, and withdraw rewards over CIP-30.
- The stake-key registration deposit and reward amounts come from the chain, not from user input; the review shows the pool id in full.

### 5.4 Governance (Conway / CIP-1694)

- Delegate voting power to a dRep (or the Abstain / No-Confidence pseudo-dReps) — needs only the stake credential, fully buildable over plain CIP-30.
- Vote, register/de-register as a dRep, and submit governance actions — these need the account's **dRep key** (CIP-1852 role 3), which plain CIP-30 does not expose; a CIP-95 wallet provides it via `getPubDRepKey`, otherwise it comes from the watch/xpub path. The module never fabricates a key the wallet cannot sign.
- Anyone can submit a governance action; the anchor is a URL + 32-byte hash (CIP-108) that the submitter provides — no host or gatekeeper is required. The URL is validated (http(s)/ipfs scheme, ≤ 128 bytes) before build.
- dRep register/de-register/vote use a hand-balanced fee path (the library does not reserve the dRep deposit). A one-witness fee floor is added so the dRep-key witness is always paid for; the exact figure must be confirmed on preprod before mainnet use (§7).

### 5.5 Connect (dApp launcher)

- A **curated** launcher of hand-reviewed dApps at their canonical URLs. Curation is the security boundary: the module does not connect to arbitrary user-supplied sites. The exact destination host is shown on each entry so a look-alike URL can be caught by eye.
- Phoenix is a web page, not an extension, so it cannot inject `window.cardano` into another site. "Connect" opens the vetted dApp (`noopener,noreferrer`); the user connects their extension there.
- The CIP-30 provider bridge (`buildCip30Provider`) delegates reads and signing to the connected wallet. A real dApp transport must be built via `buildDappProvider(api, guards)`, which **refuses** to hand a dApp a signer without a plain-language review interposed — a guardless provider cannot be wired by accident.
- The embedded dApp browser (loading a dApp in an iframe with an injected provider) is **off** (`EMBEDDED_DAPP_BROWSER_ENABLED = false`); it has real CSP/clickjacking implications and is not shipped in v1.

### 5.6 Phoenix custody view

- Given a DID, shows the custody script address and its public balance. View-only in v1 (§3). The address is read from the backend; the UI notes it should be verified before sending anything large to it.

### 5.7 `/night` — Midnight NIGHT redemption

- Connect a Cardano wallet, then hand off to the official Midnight portal (`redeem.midnight.gd`). The address that receives NIGHT was fixed when the claim was made and does not need to sign, so no recovery phrase or cold-wallet restore is ever required — only a wallet with a little ADA for the fee. Phoenix builds and signs nothing here; it never touches the funds.

---

## 6. Threat model & mitigations

| Threat | Mitigation | Where |
|---|---|---|
| Address-poisoning on send | Full (untruncated) recipient address in review + mandatory confirm; address re-encoded from bytes | `send.ts`, `SendPanel.tsx` |
| Receiving into an attacker's wallet (pasted `acct_xvk`) | Ownership check derives 0..23 and compares to the connected wallet; explicit "your own key only" warning | `ReceivePanel.tsx`, `WatchOnlyPanel.tsx` |
| Key exfiltration via watch-only | M2-WATCH: soft-derivation only; 64-byte public key enforced | `xpub.ts` |
| Mainnet/testnet confusion | Network id read from the extension (not user-selected); mainnet badge is amber across send/staking/governance; wrong-network recipients rejected pre-build | all panels, `send.ts` |
| Malicious dApp blind-signing | `buildDappProvider` requires review guards; embedded browser disabled | `connect.ts` |
| Poisoned dApp allow-list via a PR (public repo) | URLs pinned by a golden test + CODEOWNERS review on trust-boundary files; destination host shown in UI | `connect.test.ts`, `.github/CODEOWNERS`, `ConnectPanel.tsx` |
| Air-gap chunk injection/reordering | Integrity binding: the unsigned-tx transfer id is `blake2b256(payload)[:8]`, re-verified on reassembly; a tampered chunk fails the check | `qr.ts` |
| Secret / API key leaking into a public bundle | Chain reads use key-less public Koios; no Blockfrost project key, no `process.env` secret in client code | `provider.ts` |
| Silent failure after a money action | A default toast fallback renders a visible banner if the host forgot to wire notifications; extension "Cancel" (CIP-30 code 2/3) is surfaced as "nothing was sent" | `toast.ts` |

Assumptions this model depends on (documented so they are not forgotten): the CIP-30 extension is the final signing authority and the user reads its popup; `getNetworkId` from the extension is honest; the phase-2 offline signer re-verifies the transaction it displays; the repo's PR review actually gates changes to the allow-list.

---

## 7. Known limitations & roadmap

- 🟡 **Send + staking** verified end-to-end on preprod (send ADA, mint + send a native token, delegate to a stake pool). Governance dRep register/vote fee needs one preprod submit to confirm the witness count before mainnet enable.
- 🟡 **Air-gap QR co-sign** — web side scaffolded; turns on when the offline mobile signer ships. The QR transport contract (including the integrity binding in §6) is shared with the mobile signer.
- ⬜ **Phoenix custody spend** — needs the controller-key path (air-gap / mobile), phase 2.
- ⬜ **Multi-pool / multiple stake keys** — v1 delegates a single stake key; multi-stake-key management is a v2 item.
- ⬜ **Watch-only by single address** — v1 watch-only takes an account key (a full address range); a "paste one address" quick view is a planned convenience.

---

## 8. Host integration contract

The UI imports a few aliases the host provides. This repo ships minimal defaults so it type-checks and its core tests run standalone; when integrating, point these at the host's modules:

| Alias | Ships here as | Host provides |
|---|---|---|
| `@/lib/api` | plain `fetch` client | session-authed API client |
| `@/lib/toast` | console logger + visible fallback banner | react-hot-toast + i18n |
| `@/components/CopyBtn` `Nav` `Footer` | placeholders | the host's styled components |

Components use the host's Tailwind tokens (`bg-bg1`, `text-text-dim`, `teal-brand`, …). Chain reads default to public Koios; when the PhoenixKey backend exposes a UTxO/params proxy, point `provider.ts` at it (never expose an indexer project key to the client).

---

## 9. Testing & verification

- `bun run typecheck` (tsc, no emit) and `bun test` (98 unit tests) must both pass. Tests cover: address golden vectors vs the Rust reference, CKDpub derivation, UTxO decoding, send/stake/governance builders and their on-chain balance equations, the CIP-30 provider guards, the dApp URL pins, and the air-gap integrity binding.
- The send and delegation paths were exercised on **preprod** with disposable funds (send tADA, mint + send a native token, delegate to a stake pool), each confirmed on-chain, before this spec was written. Governance signing carries the preprod caveat in §7.
- Privacy: chain reads go to public Koios (which sees the queried addresses and the client IP). No data is sent to a Phoenix backend and keys never leave the wallet.

---

## 10. Data & privacy

- Keys: never held, never uploaded (§2).
- Chain reads: public Koios indexer (addresses queried + IP visible to Koios). Swappable for a backend proxy.
- No analytics, no remote images (emoji stand-ins keep the CSP tight and avoid third-party requests).
