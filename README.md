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
is consumed by more than one host — `PhoenixKey-Wakeme-Tech.md` §5 "API backend" names
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

Five modes. **Four of them never hold a key**; the fifth does, on purpose, and
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
`LocalWalletPanel`, the extension's approval window, and the browser-bundle smoke
check that has to exercise the real thing; no other mode imports it,
so the four key-free modes stay key-free. Nothing that runs inside a website can
reach it — the content script and the injected provider relay bytes and hold
nothing. `bun run check:keystore-boundary` fails CI if that ever stops being
true: this sentence is what makes the other modes safe to describe as key-free,
so it is checked rather than remembered. Full threat model:
[`docs/Phoenix Wallet-Feat.md`](<docs/Phoenix Wallet-Feat.md>) §2.1 / §2.1a.

- **Traditional use** — connect a standard Cardano extension (or watch an
  account key). No DID needed; no data goes to the Phoenix backend. (Reading
  balances and building transactions does query a public Cardano indexer,
  Koios — it sees the addresses you look up and your IP. The fiat estimate asks
  a price service for the ADA rate and nothing else: no address, no amount, and
  it can be switched off. Those two are the only hosts this wallet contacts.
  Nothing is sent to a Phoenix server, and your keys never leave your wallet.)
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
src/lib/cardano/   self-contained core: hash · address · xpub · gapScan · cip30 · provider ·
                   tx · send · staking · governance · receive · history · price · txSummary ·
                   walletPort · watchAddress · connect · qr
src/lib/night.ts   NIGHT redemption handoff (URL builder + info)
src/lib/wallet.ts  read-path calls to the PhoenixKey backend wallet API
src/components/     wallet/* and night/* UI (React)
src/app/            example /wallet and /night pages
src/lib/keystore/  local self-custody: mnemonic · derive · vault · signer · storage ·
                   session · port · signForeign
extension/          the browser extension: popup + approval window (same UI), plus the
                    content script, page-world provider and service worker that make
                    it a CIP-30 wallet for dApps
locales/            en · vi · ja · zh   (namespaces: wallet, night)
```

The `src/lib/cardano` core has no host dependencies — it relies only on
`@stricahq/*`, `@noble/hashes`, `bech32`, `bignumber.js` and the `buffer` shim.

## Host contract

**The contract is a file, not this section:** [`docs/host-contract.json`](docs/host-contract.json),
checked against the code by `check:host-contract`. Prose here can fall behind an
import; that file cannot, because CI fails when it does. It happened: a
`src/lib/keystore` directory and a new dependency were added, one host had
neither, and the wallet-creation screen was simply absent from the running site
while every gate in this repo stayed green.

Two directions, and mixing them up is the failure above:

- **Aliases the host must resolve *into* this module** — `@/lib/cardano`,
  `@/lib/keystore`, `@/lib/night`, `@/lib/wallet`, `@/components/wallet`,
  `@/components/night`. Miss one and the host's build fails on a file that
  compiles fine here.
- **Aliases the host *supplies*.** This repo ships minimal stand-ins so it
  type-checks and its tests run standalone:

| Alias | Ships here as | Host provides |
|---|---|---|
| `@/lib/api` | plain `fetch` client | session-authed API client |
| `@/lib/toast` | console logger | react-hot-toast + i18n |
| `@/components/CopyBtn` `Nav` `Footer` | placeholders | the host's styled components |

Runtime dependencies live in the host's `node_modules` — the module is consumed
as source. The list is `hostMustInstall` in the contract file.

The components use the host's Tailwind design tokens (`bg-bg1`, `text-text-dim`,
`teal-brand`, …); provide those in the host stylesheet.

**Where the chain is read from.** By default, Koios — which a **browser cannot
use**: measured 2026-09-08, all three Koios hosts answer the preflight with
`access-control-allow-origin: *` and then omit that header from the response
carrying the data, so a page-side `fetch` fails while `curl` succeeds. The
extension is unaffected; its `host_permissions` put it outside same-origin rules.
A host serving this on the web therefore has to point it somewhere else:

```ts
setChainSource(network, { kind: "blockfrost", base: "https://<your endpoint>/api/v0" });
```

…or set it at build time and write no host code at all. Either prefix works —
each bundler only exposes its own, and the name says out loud that the value
reaches the browser:

```bash
NEXT_PUBLIC_CHAIN_BASE_PREPROD=https://<your endpoint>/api/v0   # Next
VITE_CHAIN_BASE_PREPROD=https://<your endpoint>/api/v0          # Vite, incl. the extension
VITE_BLOCKFROST_PROJECT_ID_PREPROD=<key>   # only if the endpoint is Blockfrost's own service
```

**The extension is stricter than the web app, and refuses at build time rather
than at run time.** `bun run build:extension` rejects an endpoint carrying a
port or served over plain HTTP, with a message saying why. Both are fine on the
web — `chainSource` allows a loopback endpoint over HTTP on purpose — but
neither can be expressed as an extension permission: a Chrome match pattern has
no place for a port, so `https://host:8443/*` matches nothing at all, and a
plain-HTTP grant would let any network between the browser and that host read
every address the wallet looks up. That grant would also outlive the setting,
staying in the manifest whatever the chain source is later set to. So a variable
left over from a web dev loop fails the extension build instead of quietly
producing a package that reaches nothing, or one that reaches too much.

Per network, deliberately: `…_MAINNET`, `…_PREPROD`, `…_PREVIEW`. Pointing a
mainnet read at a preprod node returns a confident zero rather than an error.
`setChainSource` still wins over the build; setting neither keeps today's
behaviour. A `project_id` compiled into a browser bundle is **public** — anyone
who opens the page or unpacks the extension can read it. That is not a storage
mistake, it is what using a keyed third-party indexer from a browser costs.

The dialect is Blockfrost's REST API, which is what this platform's own chain
access already speaks — Cnode runs Dolos, and Dolos serves a Blockfrost-compatible
face from nodes the platform operates. That is the intended endpoint: no third
party, no API key. Byte-level parity between a given Dolos build and Blockfrost's
documented shapes is **not verified here** and must not be assumed — see
`src/lib/cardano/blockfrost.ts`.

Against Blockfrost itself the two sources have been compared directly, on
preprod, 2026-09-09: identical tip slot, protocol parameters equal field by
field, and for the same address identical lovelace, the same three tokens and
the same five UTxOs. That comparison is also what found a defect in the *default*
path — see `src/lib/cardano/__tests__/koiosTokenBalance.test.ts`.

**What it redirects, and what it does not.** The variable moves everything that
goes through `src/lib/cardano/provider.ts`: protocol parameters, chain tip,
balances, UTxOs, and transaction submit. It does **not** move pool search, the
DRep list, governance proposals, or transaction history — those call Koios
directly — every `koios()` call in `staking.ts`, `governance.ts` and
`history.ts` — and a
web page cannot call Koios at all, because Koios omits the CORS header on the
response that carries the data. So on the web those tabs stay broken after
setting this, until they go through `getChainSource` too. In the extension they
work either way, since `host_permissions` puts it outside the same-origin rule.

For the extension, the build widens `manifest.json` itself — `host_permissions`
and the CSP `connect-src` gain the origin the build was pointed at, and the
published manifest carries only the hosts the published build actually calls.
`check:package` checks both directions: no host declared that no source names or
this build reads, and no host this build reads that the manifest omits. The
second is the one that bites, because Chrome blocks those reads and the wallet
reports no readable reply — which reads as the endpoint being down.

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
bun run test          # 576 tests — golden vectors vs the Rust reference derivation, tx builders, safety guards
bun run typecheck
bun run check:locales # 4 languages × 2 namespaces must stay in step
bun run check:host-contract # what a host must wire up, checked against what the code imports
bun run check:urls    # no ungated outbound URL at the repo root or under src/, extension/, scripts/, docs/
bun run check:node-globals # the Node-globals shim is imported before @stricahq
bun run check:keystore-boundary # only the key-holding screens and the bundle smoke check may import the keystore
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

That build reads the chain the default way. To build one that reads it through
your own endpoint, set the variables from § Host contract in the environment of
that same command — nothing is read from a file, so the value stays in the one
process and lands only in `dist-extension/`, which is git-ignored. A build with
no variables set is the reproducible one: anyone can rebuild it from the tag and
diff it against what they were given.

The popup mounts the same `LocalWalletPanel` the web page uses, so there is one
implementation of key handling rather than two that can drift apart. What the
extension adds is a container the web page cannot give you:

- **Its own origin.** An XSS anywhere on a website is an XSS in a wallet running
  on that website. The extension page is not scriptable from any web page.
- **`script-src 'self'`.** Nothing is fetched at runtime — not the locale files,
  not a font, not a CDN script. Everything that can run shipped in the package.
- **`host_permissions` limited to the hosts the build actually calls.** Four in
  the published package: the three Koios networks and the price service. The
  list is not taken on trust — `check:package` compares it against the build in
  both directions, refusing a host that no source names and this build does not
  read, and refusing a host this build reads that the list omits. A build
  pointed at a custom endpoint widens both the manifest and the CSP for itself,
  and the closing line of that check names any host that reached the list that
  way rather than through a reviewed source file.

The build is deliberately **not minified**. An open-source wallet whose published
bundle cannot be read is open source in name only — you should be able to rebuild
from a tag and diff it against what you installed. That costs bundle size, and
that trade is made on purpose.

Keys live only while a wallet window is open — the toolbar popup, or the
approval window a site's request opens. Closing it destroys the JavaScript
context and the keys with it. The background service worker holds the per-origin
grants and never a key.

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
- ✅ Transaction history — every transaction that touched the wallet, with the
  amount told from **your** side rather than the chain's. Change coming back to
  you is not counted as money paid out, a staking withdrawal is counted as the
  income it is (it never appears as an input), and the fee is counted once
  because it is already inside the difference. No row links to a block
  explorer: the transaction id is shown in full and copyable instead, since a
  link is one click from handing an explorer the association between your
  addresses and your browser. A connected extension only lists the addresses it
  chooses to, which would make its own change look like a payment — so amounts
  are withheld with a reason on screen rather than shown wrong. Details:
  spec §5.9.
- ✅ Multiple accounts from one recovery phrase (`m/1852'/1815'/n'`) — separate
  addresses, balance and staking per account, and the open wallet says which one
  it is on next to the address. Switching asks for your password because the
  seed is erased as soon as an account is opened; there is nothing left in
  memory to derive the next one from. Details: spec §5.10.
- ✅ Balance in ordinary money (USD / VND / EUR / JPY) — and a switch to turn it
  off. This is the wallet's **second outbound host** and the first that is not a
  chain indexer, so it is worth being precise: the request carries the word
  `cardano` and a currency code, nothing about your wallet, so what the other
  end learns is your IP and that somebody asked. `Off` stops the request, not
  just the display. A rate that cannot be read shows nothing rather than a stale
  number or `0.00`, and every figure says when it was read. Details: spec §5.11.
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
- 🟡 CIP-30 injection — the extension injects `window.cardano.phoenix` into
  every top-level `https` page (and loopback) through a content script, so a
  dApp can connect to it. Reads sit behind a per-origin grant; `signTx` asks
  every time, in a separate `chrome-extension://` window a page cannot draw
  over, and the keys it uses are decided by what that window could describe —
  never by what the transaction asks for. Not yet loaded into a real Chrome, so
  every claim here rests on unit tests and `check:package`, not on a browser.
  Details: spec §5.8.

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
