# Phoenix Wallet

A pure-JavaScript Cardano wallet module for the browser. Use it **like a
traditional wallet** — no account, no DID, and your seed or private keys never
leave your device — or pair it with a **Phoenix DID** for the extra Phoenix
features, both at the same time.

It is built to drop into a host app (the PhoenixKey Standard wallet / Frontend),
and it can also be added alongside an existing Standard wallet.

## What this repo is — and which repo to work in

This is a **library package** (`@phoenixkey/wallet`), not an app and not a spec
repo. It ships the Cardano core and the wallet UI, with its own tests and CI, and
is consumed by more than one host — `PhoenixKey-Wakeme-Tech.md` §281 names
**SuperApp / SDK / Frontend** as separate consumers that have to be coordinated
together. That is why the host-contract layer below exists instead of the module
simply importing the frontend's modules.

| Where the work goes | Repo |
|---|---|
| This module: Cardano core, wallet UI, its own spec in `docs/` | **`PhoenixKeyDID/Wallet`** (here) |
| Mounting it in the web app: routes, design tokens, i18n registration, session wiring | `PhoenixKeyDID/PhoenixKey-Frontend` |
| Backend endpoints it reads (`/wallet/{did}/all`) | `PhoenixKeyDID/PhoenixKey-Database` |
| Canonical protocol specs (`PhoenixKey-*.md`) | `PhoenixKeyDID/PhoenixKey-Specs` |

`docs/Phoenix Wallet-Feat.md` is this module's own spec and security model and
lives here on purpose, next to the code it describes. The platform-wide specs it
refers to (Wallet API v2, Rebirthme, DappConnector) are canonical in
`PhoenixKey-Specs` — when the two disagree, that repo wins.

> **Beta — not audited.** Viewing balances moves no funds. Building and sending
> transactions is experimental and has not been through an on-chain security
> review. Do not use it to move funds you cannot afford to lose, and do not
> import a high-value wallet here yet.

**Full specification & security model:** [`docs/Phoenix Wallet-Feat.md`](<docs/Phoenix Wallet-Feat.md>).

## Design: where your keys live

Four modes. **Three of them never hold a key**; the fourth does, on purpose, and
says so everywhere it can.

| Mode | View | Sign / spend | Key held in the page? |
|---|---|---|---|
| **Connect (CIP-30)** — Lace / Eternl | ✅ from the extension | ✅ the extension signs | ❌ never |
| **Watch-only (`acct_xvk`)** | ✅ derived client-side from the account public key | ❌ view only | ❌ never |
| **Phoenix custody (your own DID)** | ✅ reads the script address + balances, signed in | ❌ view only (v1) | ❌ never |
| **Air-gap QR co-sign** | ✅ | 🟡 scaffolded; enabled when the offline signer ships | ❌ never |
| **Local self-custody** 🔑 | ✅ | ✅ this page signs | ⚠️ **yes, while unlocked** |

In the first four, a page here will never ask for your recovery phrase — anyone
who does is trying to scam you. **Local self-custody is the one exception**, and
it exists so that someone with no extension installed and no DID still has a
wallet. Choosing it means accepting that the signing key is in the page: the seed
is encrypted at rest (Argon2id + AES-256-GCM) and held in memory only while
unlocked, but any script that runs in the page can reach an unlocked key. Use it
for **small, hot balances** — for anything worth protecting, connect a
hardware-backed extension instead.

The self-custody code lives in `src/lib/keystore/` and is reachable only from
`LocalWalletPanel`; no other mode imports it, so the three key-free modes stay
key-free. `bun run check:keystore-boundary` fails CI if that ever stops being
true: this sentence is what makes the other modes safe to describe as key-free,
so it is checked rather than remembered. Full threat model:
[`docs/Phoenix Wallet-Feat.md`](<docs/Phoenix Wallet-Feat.md>) §2.1 / §2.1a.

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
src/lib/keystore/  local self-custody: mnemonic · derive · vault · signer · storage · session
extension/          the browser extension — popup that mounts the same UI
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
bun run test          # 299 tests — golden vectors vs the Rust reference derivation, tx builders, safety guards
bun run typecheck
bun run check:locales # 4 languages × 2 namespaces must stay in step
bun run check:urls    # no ungated outbound URL ships at the repo root and under src/, extension/, scripts/, docs/
bun run check:node-globals # the Node-globals shim is imported before @stricahq
bun run check:keystore-boundary # only LocalWalletPanel may import the keystore
bun run check:bundle  # the browser build runs with no Node globals (see below)
bun run check:package # the built extension is loadable and claims no reach it does not use
bun run check:readme  # the two claims above that go stale on their own
```

The last one exists because the test count in this file has read 98, 104, 130,
218, 241 and 249 at various times — each correct when written, each wrong a week
later. A figure nobody can trust is worse than no figure, because a reader who
catches one stale number stops believing the rest of the page, including the
parts about what this wallet does *not* protect you from. So the number and the
list of gates are both checked mechanically rather than remembered.

The address golden vectors are copied verbatim from the Rust core
(`phoenix_address.rs`): if the browser derivation ever drifts from the canonical
CLI derivation, `address.test.ts` fails.

## The browser extension

```bash
bun install
bun run build:extension     # → dist-extension/
```

Then in Chrome: **chrome://extensions** → Developer mode → **Load unpacked** →
pick `dist-extension/`.

The popup mounts the same `LocalWalletPanel` the web page uses, so there is one
implementation of key handling rather than two that can drift apart. What the
extension adds is a container the web page cannot give you:

- **Its own origin.** An XSS anywhere on a website is an XSS in a wallet running
  on that website. The extension page is not scriptable from any web page.
- **`script-src 'self'`.** Nothing is fetched at runtime — not the locale files,
  not a font, not a CDN script. Everything that can run shipped in the package.
- **`host_permissions` limited to the three Koios hosts.** That list is checkable
  against the build: the only `fetch` in `dist-extension/popup.js` targets Koios.

The build is deliberately **not minified**. An open-source wallet whose published
bundle cannot be read is open source in name only — you should be able to rebuild
from a tag and diff it against what you installed. That costs bundle size, and
that trade is made on purpose.

Keys live only while the popup is open. Closing it destroys the JavaScript
context and the keys with it, so nothing sits unlocked in a background worker.

### `check:bundle` — why a separate check exists

Two things can be wrong with this wallet while every test is green, and both of
them are about the difference between Node and a browser.

Icarus derivation reaches PBKDF2, which transitively pulls `readable-stream@2`.
That package reads a bare `process` while it is still evaluating, and it imports
`events`, which the bundler replaces with a stub that throws on first touch. So:

- a build could derive a **different address** in Chrome than in `vitest` — funds
  sent to an address their owner cannot reach; or
- loading the wallet could **throw before it paints**, which is what happened. The
  built extension popup rendered blank with `ReferenceError: process is not
  defined`, while 218 unit tests, the type check and an earlier version of this
  very check all passed. The earlier version ran the browser bundle under plain
  Node, where `process` exists — so it proved the maths and missed the crash.

`bun run check:bundle` now deletes `process`, `global` and `setImmediate` before
importing the bundle, then asserts the golden-vector address and a vault
round-trip. `src/lib/node-globals.ts` is what puts `process` back in a browser,
and `bun run check:node-globals` enforces that every module reaching `@stricahq`
imports it *first* — ES modules evaluate imports in source order, so a shim
imported second is a shim that never ran.

Verified in a real browser on 2026-08-29 against the built bundle: create →
confirm phrase → encrypt → address, lock → wrong password rejected → unlock →
same address, and restore-from-phrase reproducing the same address with a fresh
salt and ciphertext.

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
- 🟡 Local self-custody wallet (no DID required) — create, restore, unlock and
  auto-lock are implemented and covered by golden vectors against
  `cardano-serialization-lib`, so a phrase made here restores in Lace, Yoroi or
  Eternl. The popup was exercised in a real browser on 2026-08-29 (see the
  extension section above). Unaudited. Local signing is wired into Send,
  Staking and Governance: those panels take a `WalletPort`, which either an
  extension (`cip30Port`) or an unlocked local account (`localPort`) can
  satisfy, so a wallet created here spends from here. **The local path's only
  review is this page's own confirm screen** — there is no popup outside the
  document the way an extension has one, so anything with script access to this
  origin can mis-draw what you are approving. Amounts worth attacking belong in
  hardware or an extension.
- 🔴 CIP-30 injection — the extension does not yet present itself to dApps as a
  wallet. It signs from its own popup only.

## License

**Apache License 2.0** — see [`LICENSE`](LICENSE).

You may read it, run it, fork it, modify it, and ship your own build, commercially
or not. The one thing Apache-2.0 asks in return is attribution and a note of what
you changed. This is the same licence Lace ships under, and the same one this
module's own Cardano dependencies (`@stricahq/*`) use, so the whole stack is
under one rule.

The choice is deliberate rather than incidental: a wallet asks people to trust it
with money, and "trust me" is not a security property. A licence that lets anyone
read the code, rebuild it, and check that the build matches is the only version of
that trust which can be verified instead of believed.
