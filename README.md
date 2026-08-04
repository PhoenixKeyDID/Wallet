# Phoenix Wallet

A pure-JavaScript Cardano wallet module for the browser. Use it **like a
traditional wallet** — no account, no DID, and your seed or private keys never
leave your device — or pair it with a **Phoenix DID** for the extra Phoenix
features, both at the same time.

It is built to drop into a host app (the PhoenixKey Standard wallet / Frontend),
and it can also be added alongside an existing Standard wallet.

> **Beta — not audited.** Viewing balances moves no funds. Building and sending
> transactions is experimental and has not been through an on-chain security
> review. Do not use it to move funds you cannot afford to lose, and do not
> import a high-value wallet here yet.

**Full specification & security model:** [`docs/Phoenix Wallet-Feat.md`](<docs/Phoenix Wallet-Feat.md>).

## Design: no hot wallet, ever

This module **never holds a spendable seed in the browser.** There is no
"create wallet / paste your 24 words" flow. It only ever sees public data or
hands the signing off to something that already holds the key. A page in this
module will never ask you for a recovery phrase — anyone who does is trying to
scam you.

| Mode | View | Sign / spend |
|---|---|---|
| **Connect (CIP-30)** — Lace / Eternl | ✅ from the extension | ✅ the extension signs |
| **Watch-only (`acct_xvk`)** | ✅ derived client-side from the account public key | ❌ view only |
| **Phoenix custody (your own DID)** | ✅ reads the script address + balances, signed in | ❌ view only (v1) |
| **Air-gap QR co-sign** | ✅ | 🟡 scaffolded; enabled when the offline signer ships |

- **Traditional use** — connect a standard Cardano extension (or watch an
  account key). No DID needed; no data goes to the Phoenix backend. (Reading
  balances and building transactions does query a public Cardano indexer,
  Koios — it sees the addresses you look up and your IP. Nothing is sent to a
  Phoenix server, and your keys never leave your wallet.)
- **Phoenix use** — with a DID you can view your Phoenix custody wallet and your
  standard wallet in parallel, and add this wallet into the Standard wallet.

Watch-only derivation uses BIP32-Ed25519 **soft** (`CKDpub`) derivation, so it
reproduces the exact addresses the real signer will spend from **without ever
deriving a private key**.

## `/night` — redeem Midnight NIGHT

Connect a Cardano wallet, then hand off to the official Midnight redemption
portal (`redeem.midnight.gd`). The address that receives NIGHT was fixed when
you claimed — it does **not** need to sign, so you never re-enter a recovery
phrase or restore a cold wallet. You only need any wallet with a little ADA to
pay the fee. Phoenix never touches your funds.

## Layout

```
src/lib/cardano/   self-contained core: hash · address · xpub · cip30 · provider · tx · qr
src/lib/night.ts   NIGHT redemption handoff (URL builder + info)
src/lib/wallet.ts  read-path calls to the PhoenixKey backend wallet API
src/components/     wallet/* and night/* UI (React)
src/app/            example /wallet and /night pages
locales/            en · vi · ja · zh   (namespaces: wallet, night)
```

The `src/lib/cardano` core has no host dependencies — it relies only on
`@stricahq/*` and `@noble/hashes`.

## Host contract

The UI imports a few aliases the host app provides. This repo ships **minimal
default implementations** so it type-checks and its core tests run standalone;
when integrating, point these at the host's own modules:

| Alias | Ships here as | Host provides |
|---|---|---|
| `@/lib/api` | plain `fetch` client | session-authed API client |
| `@/lib/toast` | console logger | react-hot-toast + i18n |
| `@/components/CopyBtn` `Nav` `Footer` | placeholders | the host's styled components |

The components use the host's Tailwind design tokens (`bg-bg1`, `text-text-dim`,
`teal-brand`, …); provide those in the host stylesheet.

**Pass the signed-in DID.** `GET /wallet/{did}/all` requires a Bearer session and
the backend enforces `caller_did == path_did`, so the Phoenix custody view only
ever resolves the caller's own wallet. The host supplies the DID it already
holds; the module never stores a token or a session of its own:

```tsx
<WalletHub did={getSessionMeta()?.userDid} />
```

Omit it and that mode says "sign in first". Connect and Watch-only need no
session at all — they never touch the Phoenix backend.

## Develop

```bash
bun install
bun test        # 106 tests — golden vectors vs the Rust reference derivation, tx builders, safety guards
bun run typecheck
```

The address golden vectors are copied verbatim from the Rust core
(`phoenix_address.rs`): if the browser derivation ever drifts from the canonical
CLI derivation, `address.test.ts` fails.

## Status & roadmap

- ✅ Watch-only, CIP-30 connect, Phoenix custody view, `/night` handoff.
- 🟡 Send flow — works against CIP-30 but is unaudited; needs a preprod on-chain
  pass with disposable funds before it is enabled for mainnet sends. (Send +
  delegation verified on preprod; see the security notes.) Confirming a send or
  delegation requires retyping the destination's last 4 characters, not just a
  checkbox — an anti-poisoning gate (`ConfirmGate`).
- 🟡 Staking & governance signing — built and signable over CIP-30, same
  unaudited, preprod-first caveat as Send. dRep registration/voting additionally
  needs its fee re-confirmed on preprod before mainnet use.
- 🟡 Air-gap QR co-sign — the web side is scaffolded; it turns on when the
  offline mobile signer is available.

## License

Source-available. The final open-source license is to be announced.
