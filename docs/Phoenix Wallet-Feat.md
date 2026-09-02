# Phoenix Wallet — Feature & Security Spec

Status: **beta, unaudited** · Scope: this module (`PhoenixKeyDID/Wallet`) · Audience: integrators, reviewers, and users who want to know exactly what this wallet does and does not do with their keys.

This document is the source of truth for the module's behaviour and security model. If the code and this spec disagree, one of them has a bug — file it.

**Related**

- Repo: [README](../README.md) · platform: [phoenixkey.me](https://phoenixkey.me)
- Cardano standards used: [CIP-1852](https://github.com/cardano-foundation/CIPs/tree/master/CIP-1852) (HD derivation) · [CIP-19](https://github.com/cardano-foundation/CIPs/tree/master/CIP-0019) (addresses) · [CIP-30](https://github.com/cardano-foundation/CIPs/tree/master/CIP-0030) (dApp connector) · [CIP-95](https://github.com/cardano-foundation/CIPs/tree/master/CIP-0095) (governance keys) · [CIP-105](https://github.com/cardano-foundation/CIPs/tree/master/CIP-0105) / [CIP-129](https://github.com/cardano-foundation/CIPs/tree/master/CIP-0129) (dRep ids) · [CIP-108](https://github.com/cardano-foundation/CIPs/tree/master/CIP-0108) & [CIP-1694](https://github.com/cardano-foundation/CIPs/tree/master/CIP-1694) (Conway governance)
- Libraries: [@stricahq/typhonjs](https://github.com/StricaHQ/typhonjs) · [@stricahq/bip32ed25519](https://github.com/StricaHQ/bip32ed25519) · [@noble/hashes](https://github.com/paulmillr/noble-hashes)
- Chain reads: [Koios](https://koios.rest) · NIGHT redemption: [redeem.midnight.gd](https://redeem.midnight.gd)

---

## 1. What this is

A pure-JavaScript Cardano wallet module for the browser. It lets a user **view balances** and **build, sign and submit transactions** (send, delegate, withdraw rewards, vote, register as a dRep) — and hand off to the Midnight NIGHT redemption portal.

**Which mode signs, today.** Two of them. A connected CIP-30 extension signs, and so does the local self-custody mode — Send, Staking and Governance each take a `WalletPort` (`src/lib/cardano/walletPort.ts`) rather than a `Cip30Api`, and the two implementations of that port are the extension and a local `Account` (`src/lib/keystore/port.ts`). Watch-only and Phoenix custody hold no spending key and sign nothing.

Two consequences of that are worth stating where nobody can miss them. First, **the local mode's signature has no second screen behind it**: an extension shows its own popup, outside the page, which is a boundary a compromised page cannot cross; the local mode's only review is the in-page confirm gate in §2.5. Second, **the local mode needs the chain indexer directly**, so it works where Koios is reachable — inside the extension build — and a page served from a web origin is subject to that indexer's CORS policy. See §7.

It is designed to drop into a host application (the PhoenixKey Standard wallet / Frontend). It can be used **like a traditional wallet** (connect a standard Cardano extension, or watch an account public key) or alongside a **Phoenix DID** for the Phoenix-specific custody view — both at once.

### Non-goals (v1)

- It does **not** hold keys in the page for the Connect, Watch-only or Phoenix-custody modes. Local self-custody is a **separate, opt-in fourth mode** with its own threat model — see §2.1.
- It does **not** spend from a Phoenix DID custody address (that is a script address; v1 shows its balance only — see §5.6).
- It does **not** build or sign the NIGHT redemption transaction; `/night` hands off to the official Midnight portal (§5.7).

---

## 2. Security model (read this first)

Security is the top priority and is enforced **structurally**, not by promises.

### 2.1 Where the signing key lives — per mode

This section used to read "no hot wallet, ever" and claim the page never holds a spendable seed. That was true when the module had three modes. It is **no longer true**, and the old wording is kept out of this document on purpose: a security claim that has quietly stopped holding is worse than no claim, because readers act on it.

Three of the four modes still hold no key at all:

1. **Connect (CIP-30)** — delegated to a browser extension (Lace / Eternl / Typhon). The extension holds the keys, shows the transaction, and the user approves it there.
2. **Watch-only (`acct_xvk`)** — a public key only; it can derive addresses and read balances, never sign (§2.2).
3. **Phoenix custody** — a script address, read-only in v1; spending needs the controller key on the air-gap / mobile path.

For those three the old consequence still stands: the module holds no key, so a bug in it has no key to exfiltrate, and it is never the final signing authority.

**Local self-custody (§2.1a) is different, and the difference is the whole point of reading this section.** It exists so that somebody with no extension installed and no DID still has a wallet. The cost is that the signing key is in the page.

### 2.1a Local self-custody — the mode that does hold a key

The seed is generated in the page (BIP-39, 24 words by default, `crypto.getRandomValues` with no `Math.random` fallback), encrypted at rest with Argon2id + AES-256-GCM, and held in memory only while unlocked.

**Parameters, so a reviewer can check them against the code rather than take this on trust** (`src/lib/keystore/vault.ts`):

| | Value | Why this and not something else |
|---|---|---|
| KDF | Argon2id, `t=2`, `m=19456` KiB, `p=1` | The OWASP second-choice profile. Memory-hard, so a GPU farm loses most of its advantage over the defender's laptop. |
| Salt | 32 bytes, fresh per vault | Twice the 16-byte minimum. Free, and it removes any multi-target guessing win. |
| Cipher | AES-256-GCM via WebCrypto | The platform primitive gets hardware AES and the engine's own constant-time treatment. A cipher that is *not* our code is the safer one here. |
| IV | 12 bytes, fresh per encryption | GCM's native size; never reused, because a reused GCM nonce is catastrophic rather than merely weak. |
| AAD | the vault header | The header is stored in the clear. Binding it as additional data means editing the KDF parameters or the version breaks decryption instead of silently changing how the key is derived. |
| Stored | BIP-39 **entropy**, not the derived key | Icarus/CIP-3 derives from entropy, so this is what round-trips to Lace/Yoroi/Eternl. It also means there is no place to hang a 25th-word passphrase, so the UI does not offer one it cannot honour. |
| Minimum password | 10 characters | A floor, not a policy. Argon2id raises the cost per guess; it cannot rescue `password1`. |
| Auto-lock | 5 minutes, configurable, "never" is opt-in | See `session.ts` for why this differs from Lace's extension default of never. |

**Losing your password and losing your recovery phrase are different accidents, and only one of them is fatal.** Say it this way to a user, because the two get confused and the confusion costs money:

- **Password lost, phrase kept** — the vault on this device is unopenable and stays that way; there is no reset, because a reset would mean somebody else could reset it too. Restore from the phrase, choose a new password, and nothing is lost. The funds were never in the vault; the vault only held the key to reach them.
- **Phrase lost, password kept** — fine only for exactly as long as this browser profile survives. Clear site data, lose the laptop, or reinstall, and the money is gone permanently. Nobody — not Phoenix, not the platform — can recover it.

The practical consequence: the phrase is the asset and the password is a convenience. Back up the phrase off the device.

What this mode is **not** protected against, stated plainly because the mitigations do not reach it:

- **Any script that executes in the page can reach an unlocked key.** A compromised dependency, a hostile browser extension with host access, or an XSS bug in the host app defeats the vault, because the vault protects data at rest, not a running page.
- **Encryption at rest is only as strong as the password.** Argon2id raises the cost per guess; it does not rescue a weak password.
- Therefore this mode is appropriate for **small, hot balances** — spending money, not savings. For anything worth protecting, Connect mode with a hardware-backed extension remains the recommended path, and the UI says so.

The browser extension packaging (§ README) narrows the first bullet — its own origin, no remote code permitted by CSP — but does not remove it.

**The self-custody code is confined to `src/lib/keystore/` and reachable only from `LocalWalletPanel` and the extension's approval window.** No other mode imports it, so the three key-free modes stay key-free. The approval window is on the list because signing for a dApp needs a key and a password field, and a password field on a page a dApp serves is indistinguishable from a phishing copy of it — so that form has to sit on a `chrome-extension://` origin. The two files that actually run inside a website, `content/bridge.ts` and `inpage/provider.ts`, are **not** on the list: they relay bytes and hold nothing. That sentence is the load-bearing one in this section, so it is **checked by machine, not asserted here**: `bun run check:keystore-boundary` walks every module under `src/` and `extension/` and fails CI when anything outside an explicit allow-list imports the keystore, whatever spelling the import uses. Widening that list is a diff in a CODEOWNERS-gated file — which is the review this claim deserves and previously did not get. The on-screen assurance is swapped per mode for the same reason this section was rewritten: leaving "this page never asks for your recovery phrase" visible while the page asks for exactly that would train the habit the notice exists to prevent.

### 2.2 Invariant M2-WATCH — watch-only cannot sign

Watch-only mode consumes an **account extended _public_ key** (`acct_xvk`, 64 bytes = 32 pubkey ‖ 32 chaincode) and performs only BIP32-Ed25519 **soft** (`CKDpub`) derivation. No private key is derivable from a public key; this mode can reproduce the exact addresses the real signer will spend from, and read their balances, but can never sign. `parseAcctXvk` rejects anything that is not exactly 64 bytes (a 32-byte plain key or a 96-byte private key is refused), and rejects a bech32 key whose prefix says it is not account-level (`root_xvk`, `addr_xvk`, `stake_xvk`, `policy_xvk` are all 64 bytes too — deriving `role/index` from a root key yields addresses at `m/0/i` that no wallet will ever scan).

**M2-WATCH does not say `acct_xvk` is safe to publish.** Two things follow from soft derivation that a reader could otherwise miss:

1. **It links the whole account.** Anyone holding it can enumerate every address of the account, past and future, and therefore the entire transaction history behind them. That is a privacy break on its own.
2. **It amplifies any child-key leak into a total loss.** Soft derivation is invertible in the private direction: `kL_child = kL_parent + 8·Z_L` where `Z = HMAC-SHA512(chaincode, 0x02 ‖ A ‖ index)` depends only on the contents of `acct_xvk` and a public index. So `acct_xvk` plus the private key of **any one** soft child gives back the account key — and with it every payment, stake and dRep key of that account, including indices never used. BIP-32 states this normatively ("knowledge of the extended public key plus any non-hardened private key descending from it is equivalent to knowing the extended private key"). Hardened derivation blocks the step above the account, so the seed itself stays out of reach.

The leaked child key can come from software that has nothing to do with this wallet — the same account used in another tool is enough. Hence the rule this module holds to, verifiable in code: **`acct_xvk` is never persisted, never transmitted, never synced.** It lives in React state only (`WatchOnlyPanel.tsx`, `ReceivePanel.tsx`); `localStorage` holds nothing but `phoenix.testnetVariant`; no library under `src/lib/` ever sends it anywhere.

A second consequence matters for recovery: once an account is compromised this way, **a signature proves nothing about ownership at any index of that account**. Any proof-of-ownership test has to be anchored above the hardened boundary — at the DID, not at an address key. Migration after a compromise goes to a sibling account (`…/1'`), which the attacker cannot derive, never to another index of the broken one.

### 2.3 Security priority order

Security > Privacy > Experience > Cost. Where these conflict, the earlier one wins, and the conflict is called out to the user rather than hidden. A cheaper or smoother option that moves authority off the ledger is rejected.

### 2.4 Persistent, non-dismissable warning

Every page that can move funds renders a persistent, non-dismissable beta/unaudited banner. It cannot be hidden by state or local storage. Its copy covers **every** signing feature (send, staking, governance), not just send.

### 2.5 Retype-to-confirm (anti-poisoning gate)

The final confirmation before a signature request is not a bare checkbox. A checkbox is a reflex — on an irreversible action the user ticks it without reading. Instead the wallet asks the user to **retype a short challenge drawn from the transaction itself**: the last four characters of the recipient address (send), the pool id (delegate), or the dRep id (governance). The challenged characters are highlighted inside the full destination and **not** reprinted beside the input, so the eye has to cross the real address to find them rather than copying screen-to-screen.

On a multi-recipient send **every** output is challenged, one field per recipient, and the confirm button unlocks only when all of them match. Gating just the first output would leave the rest unread, which is the whole failure the gate exists to prevent.

**What this gate does and does not do.** It defeats the reflex tick and catches a mis-paste — the cases where the user simply was not looking. It does **not** defeat a targeted address-poisoning attack, and the wallet does not claim otherwise. Four bech32 characters are 20 bits (32⁴ ≈ 1.05 million), so grinding a vanity address that shares a tail is seconds of work on ordinary hardware; and if the poisoned address is already sitting in the form, the challenge is drawn from the poisoned address, so a correct answer confirms the wrong destination. Stopping a targeted swap needs a different mechanism — an address book plus a "you have never sent to this address before" warning — which is on the roadmap (§7), not in this gate.

The confirm button stays disabled until the retyped tail matches. For Send and Delegate the retype is required on **every** network, so the flow is exercised on preprod exactly as it runs on mainnet; for the lower-risk paths the retype is required on mainnet and a checkbox is kept on testnet. Actions with no address to mistype (Abstain, No-Confidence, withdraw-to-self) keep the checkbox. This gate is `ConfirmGate` (`src/components/wallet/ConfirmGate.tsx`).

---

## 3. Architecture — five modes, one of which holds a key

| Mode | View | Sign / spend | v1 |
|---|---|---|---|
| **Connect (CIP-30)** — Lace / Eternl / Typhon | ✅ from the extension | ✅ the extension signs | ✅ full |
| **Watch-only (`acct_xvk`)** | ✅ derived client-side from the account public key | ❌ view only | ✅ |
| **Phoenix custody (by DID)** | ✅ reads the script address + public balances | ❌ view only | ✅ view |
| **Air-gap QR co-sign** | ✅ (reuses the watch-only key) | 🟡 offline device signs → QR witness | 🟡 web scaffolded; enabled when the offline signer ships |
| **Local self-custody** 🔑 | ✅ | ✅ holds the key and signs Send / Staking / Governance through `WalletPort` (`keystore/port.ts`); reviewed only by the in-page confirm gate (§2.5), never by a popup outside the page | 🟡 |

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
change_pub_i  = CKDpub(acct_xvk, 1) → CKDpub(·, i)   -- chain 1 (internal / change)
stake_pub     = CKDpub(acct_xvk, 2) → CKDpub(·, 0)   -- chain 2 (stake)
drep_pub      = CKDpub(acct_xvk, 3) → CKDpub(·, 0)   -- chain 3 (dRep, CIP-105)
addr_i        = base_addr(pkh(payment_pub_i), pkh(stake_pub))
```

The **internal chain (role 1)** is listed because leaving it out of a derivation spec is how a wallet ends up unable to see its own change. Both chains are derived to `GAP_LIMIT` (20) addresses and both are scanned for balance; a restored wallet whose original had used more than 20 addresses on either chain will under-report — see §7.

On the private path the account is reached through **hardened** derivation, `m/1852'/1815'/account'`, and only then does soft derivation continue for the roles above. This is not the same code as the watch-only path and deliberately does not share it: soft derivation is reversible, so an `acct_xvk` plus any one soft-derived child private key reconstructs the account key. Keeping the two implementations apart means a refactor cannot quietly hand the watch-only path a private key to be clever with.

- `pkh` = blake2b-224 of the public key (28 bytes), CIP-19 credential.
- Path label: `m/1852'/1815'/0'/0/i`.
- Only **soft** indices are valid from a public key: an index ≥ 2³¹ (`0x80000000`) is a hardened index and is rejected up front with a clear message (`keyHashAt`), rather than surfacing an opaque library error.
- Network ids (rust_core convention): `0` preprod, `1` mainnet, `2` preview. Preprod and preview share the testnet address header; only mainnet carries the mainnet header.

---

## 5. Features

Each fund-moving feature is **two-step**: build an unsigned transaction → show every recipient / amount / fee / network in plain language → the user confirms → the extension signs and the module submits. Never build blind.

### 5.1 Send (multi-recipient, multi-asset)

- One or more assets (ADA + native tokens) to one or more recipients in a single transaction.
- Each recipient address is parsed and re-encoded from its bytes; the **full** bech32 address is shown in the review (never truncated), and the user retypes its last four characters to confirm (§2.5) — so the confirmation is a deliberate check against address-poisoning, not a reflex tick.
- Recipients on the wrong network are rejected **before** build (`addr_wrong_network`) rather than failing at submit.
- Token-bearing outputs are bumped to the protocol minimum-UTxO automatically, and the review shows the **effective** amounts that actually leave the wallet — a token-only row is never displayed as "0 ADA".
- Token amounts are entered in **raw on-chain units** (no decimal scaling); the UI states this explicitly next to the field.

### 5.2 Receive

- Derives base or enterprise (receive-only) addresses at any index from the connected wallet's account key.
- **Ownership check:** when an `acct_xvk` is pasted, the module derives addresses 0..23 and compares them to the connected wallet's own used/unused addresses. A key that is not the connected wallet's raises a mismatch warning — this flags the social-engineering setup where you are steered into receiving to someone else's wallet. (A standalone watch-only view has no wallet to check against, so it warns explicitly to only paste your own key.)
- **Watched check, which is a different question.** The tick above says *this key is yours*; a person reading it beside an address hears *this address is safe to use*, and those come apart. A local account watches base addresses `0..GAP_LIMIT-1` and nothing else, while this screen derives any kind at any index — so an enterprise address, or index 40, is genuinely the user's and genuinely absent from the balance query and from the inputs a spend is built from. Money sent there is **stranded, not lost**: inside the gap limit the account already holds the signing key, and past it the key is still derivable, so recovery needs a rescan or another wallet rather than a miracle. Any derived address the connected wallet did not list therefore carries its own warning, naming the derivation path. The comparison is against **what the wallet actually listed**, never against a guess at its scanning rules — guessing would tell an Eternl user their perfectly visible address is invisible. An empty list means *undecidable*, which the "could not verify" path already reports, so it raises nothing.

### 5.3 Staking

- Search pools, delegate, and withdraw rewards over CIP-30.
- The stake-key registration deposit and reward amounts come from the chain, not from user input; the review shows the pool id in full.

### 5.4 Governance (Conway / CIP-1694)

- Delegate voting power to a dRep (or the Abstain / No-Confidence pseudo-dReps) — needs only the stake credential, fully buildable over plain CIP-30.
- Vote, register/de-register as a dRep, and submit governance actions — these need the account's **dRep key** (CIP-1852 role 3), which plain CIP-30 does not expose; a CIP-95 wallet provides it via `getPubDRepKey`, otherwise it comes from the watch/xpub path. The module never fabricates a key the wallet cannot sign.
- Anyone can submit a governance action; the anchor is a URL + 32-byte hash (CIP-108) that the submitter provides — no host or gatekeeper is required. The URL is validated (http(s)/ipfs scheme, ≤ 128 bytes) before build.
- dRep register/de-register/vote use a hand-balanced fee path (the library does not reserve the dRep deposit). A one-witness fee floor is added so the dRep-key witness is always paid for; the exact figure must be confirmed on preprod before mainnet use (§7).

### 5.5 Connect (dApp launcher)

- A **curated** launcher of hand-reviewed dApps at their canonical URLs (currently [Minswap](https://minswap.org/) and [SundaeSwap](https://app.sundae.fi/)). Curation is the security boundary: the module does not connect to arbitrary user-supplied sites. The exact destination host is shown on each entry so a look-alike URL can be caught by eye.
- **The extension presents itself to dApps as a wallet; the web page does not, and cannot.** The extension declares `content_scripts`, a `background` service worker and `web_accessible_resources`, and injects `window.cardano.phoenix` into every https page and loopback (§5.8). The web build injects nothing: a page has no way to place a provider in another origin, and it should not — a wallet reachable from a site is a wallet an XSS on that site can reach. So "Connect" still opens the vetted dApp (`noopener,noreferrer`) and the user connects a wallet there; with the extension installed, Phoenix is one of the wallets offered, including to the web build of Phoenix itself.
- The CIP-30 provider bridge (`buildCip30Provider`) delegates reads and signing to the connected wallet. A real dApp transport must be built via `buildDappProvider(api, guards)`, which **refuses** to hand a dApp a signer without a plain-language review interposed — a guardless provider cannot be wired by accident.
- The embedded dApp browser (loading a dApp in an iframe with an injected provider) is **off** (`EMBEDDED_DAPP_BROWSER_ENABLED = false`); it has real CSP/clickjacking implications and is not shipped in v1.

### 5.6 Phoenix custody view

- Given a DID, shows the custody script address and its public balance. View-only in v1 (§3). The address is read from the backend; the UI notes it should be verified before sending anything large to it.

### 5.7 `/night` — Midnight NIGHT redemption

- Connect a Cardano wallet, then hand off to the official Midnight portal ([redeem.midnight.gd](https://redeem.midnight.gd)). The address that receives NIGHT was fixed when the claim was made and does not need to sign, so no recovery phrase or cold-wallet restore is ever required — only a wallet with a little ADA for the fee. Phoenix builds and signs nothing here; it never touches the funds.

### 5.8 CIP-30 injection — the extension as a provider

Extension only. Four processes, and the split between them is the design:

| Where it runs | File | Holds |
|---|---|---|
| The page's own world | `extension/inpage/provider.ts` | `window.cardano.phoenix`. Nothing else. |
| Isolated world, same page | `extension/content/bridge.ts` | Nothing. Relays bytes. |
| Service worker | `extension/background/worker.ts` | The origin, the grants, the window map. No keys. |
| `chrome-extension://` window | `extension/src/approve.tsx` | The unlocked account, for as long as the window is open. |

**The origin is never in the message.** A page can write anything into a message it sends, so `parseRequest` has no origin field at all to write into — and a test asserts that a page adding one does not have it survive parsing. The background reads `sender.origin` from the browser and refuses anything that is not a top-frame https origin, or loopback for someone developing against this wallet. An opaque origin (`"null"`, what a sandboxed frame reports) is refused: there is nothing there to show a person.

**Sub-frames get no wallet.** Twice: the manifest sets `all_frames: false`, and `originOf` refuses `frameId !== 0`. An iframe's own origin is honest, but the person reading the approval dialog is looking at the address bar, and those are different strings. Either check alone is one edit from being undone, which is why there are two.

**Three permission tiers, deny by default.** `isEnabled` answers anyone. Nine reads need a grant the user gave this origin. `signTx`, `signData` and `submitTx` ask every single time — one "yes" never becomes a standing licence to spend. A method not on any list is refused rather than forwarded, so a future CIP does not become reachable by being new.

**Nothing is signed that cannot be described.** `summariseTx` decodes the transaction body against an allow-list of known fields and refuses on anything it cannot render in words — an unknown body field, an inline datum, a reference script, a malformed policy id. The approval screen then shows the refusal. It does not fall back to hex: hex on an approval dialog is not information, it is the appearance of information.

**The number shown is the net change.** Summing outputs would count the change returning to the wallet, which turns "send 5 ADA" into a screen that says 95. What the screen shows is what leaves.

**The signature covers the bytes the dApp sent.** `signForeignTx` finds the body's exact byte range inside the CBOR the dApp supplied and hashes *that*, rather than re-encoding a decoded body — two encodings of the same body are different bytes and hash differently, and a witness over the wrong hash is a valid signature on a transaction that does not exist. It returns the witness set alone, as CIP-30 requires, and refuses to return a partial one unless the dApp said it would accept one.

**The password field is on an extension origin.** The approval window is `chrome.windows.create`, not the toolbar popup: the popup dies the moment it loses focus, and `LocalWalletPanel` locks on `visibilitychange`, so an approval flow there would lock the wallet at the instant the user glanced at the site they were being asked about. It is the only place besides `LocalWalletPanel` allowed to import the keystore (§2.1a).

**What is not proven.** None of this has been loaded into a real Chrome. `chrome.storage.session`, the CSP on a live `chrome-extension://` page, and window lifecycle under real focus changes are checked by `check:package` and by unit tests over `rpc/protocol.ts` — which is a statement about the rules, not about the browser running them. §7 carries this as 🟡 until someone loads the package.

**One more thing a test holds together.** Phoenix's web build runs its own completeness check on every injected wallet it finds — including this one. A method dropped from the provider would make Phoenix refuse Phoenix, with an on-screen message blaming the user's wallet. The mandatory list therefore lives in `rpc/protocol.ts`, which both sides import, and a test asserts the injected api satisfies the web build's list exactly.

---

## 6. Threat model & mitigations

| Threat | Mitigation | Where |
|---|---|---|
| Address-poisoning on send | Full (untruncated) recipient address in review + **retype the address tail** to confirm (not a checkbox); address re-encoded from bytes | `send.ts`, `SendPanel.tsx`, `ConfirmGate.tsx` |
| Receiving into an attacker's wallet (pasted `acct_xvk`) | Ownership check derives 0..23 and compares to the connected wallet; explicit "your own key only" warning | `ReceivePanel.tsx`, `WatchOnlyPanel.tsx` |
| Key exfiltration via watch-only | M2-WATCH: soft-derivation only; 64-byte public key enforced; bech32 prefix must be account-level | `xpub.ts` |
| `acct_xvk` turning a single leaked child key into a whole-account loss | Never persisted, never transmitted, never synced — held in React state only; `localStorage` carries `phoenix.testnetVariant` and nothing else | `WatchOnlyPanel.tsx`, `ReceivePanel.tsx`, `WalletTabs.tsx` |
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
- ✅ **Local self-custody spends from this UI.** The adapter that was missing is `WalletPort`: `SendPanel`, `StakingPanel` and `GovernancePanel` take the port instead of a `Cip30Api`, `cip30Port()` wraps an extension and `localPort()` wraps an unlocked `Account`, and `LocalWalletPanel` mounts the same five tabs the Connect screen does. The port keeps `PhoenixNetwork` intact down to the signer instead of narrowing to a CIP-30 network id, which is what lets a preview account refuse a preprod transaction — CIP-30 calls both `0` and cannot tell them apart at all. `localPort` lives inside `src/lib/keystore/` so that `check:keystore-boundary` still holds: the panels import a finished port, never the keystore.
- 🟡 **The local path's review is the page's own, and that is a real difference.** An extension signature is approved in a popup the page cannot draw over; a local signature is approved by the §2.5 confirm gate, in the same document as the wallet. Anyone who can execute script in this origin can therefore mis-draw the review it is checked against. The mitigations that exist are stated in §5 and are not equivalent to a separate window. A local wallet holding an amount worth attacking still belongs in hardware or an extension, and the UI says so.
- 🟡 **Change and receive addresses are chosen from live balances, not address history.** `localPort` picks the first internal address holding no UTxO for change, and the first external one for receiving. That is not a BIP-44 gap scan: an address that received and then spent everything is indistinguishable here from one never used, so a busy wallet reuses addresses sooner than a full wallet would. The cost is privacy, not funds — and it shares a root cause with the gap-limit item below, since both need address *history* the balance query does not return.
- 🔴 **Balance under-reports past 20 used addresses per chain.** Still true in the running app, and still 🔴 for that reason. What now exists is everything except the wiring: `cardano/gapScan.ts` walks a chain in gap-limit batches until a whole batch holds nothing and returns how deep to derive, and `buildAccount`/`accountFromEntropy` take that depth — with a refusal to build *shallower* than `GAP_LIMIT`, since a narrower account is how funds stop being visible. Both are tested (18 cases), including that a deeper account is an extension of the shallow one rather than a different wallet. The probe asks `anyAddressFunded`, built on the balance endpoint already load-bearing here, not on an address-history endpoint whose row format would have to be assumed; that finds every address holding money, and deliberately does not claim the history scan that would also fix *address reuse* (the separate 🟡 above). **What is left is one decision, not one commit:** the scan needs a network round trip during unlock, and an `Account` does not retain the account private key it would need to extend itself afterwards — so either the seed entropy stays in memory across that round trip, or the account key is kept on the `Account` and scrubbed by `wipe()`. Both widen the key-material window in a wallet, differently, and that is the owner's call rather than an implementation detail. A gap *wider* than the limit is not crossed by this or by any BIP-44 wallet; the receive screen's own warning (§5.2) is what covers an address handed out past it.
- 🟡 **CIP-30 injection (Phoenix as a provider to dApps)** — built in the extension (§5.8); **not yet loaded into a real Chrome**, so every claim about it rests on unit tests and a package check, not on a browser. Each constraint this item listed before it was built is now a specific mechanism, and each is tested: the origin comes from `sender.origin` and the request type has no origin field for a page to fill in; sub-frames are refused (`all_frames: false` in the manifest *and* a `frameId !== 0` refusal, because either alone is one edit from being undone); `summariseTx` refuses rather than guesses, and the screen shows the refusal instead of falling back to hex; the amount shown is the **net change to the wallet**, not the output total a change output inflates; reads sit behind a per-origin grant while `signTx`/`signData`/`submitTx` ask every time; and no password field exists anywhere except on the `chrome-extension://` approval window. That window is a real window (`chrome.windows.create`), never the toolbar popup, which is destroyed when it loses focus while `LocalWalletPanel` locks on `visibilitychange`.
- ⬜ **Phoenix custody spend** — needs the controller-key path (air-gap / mobile), phase 2.
- ⬜ **Multi-pool / multiple stake keys** — v1 delegates a single stake key; multi-stake-key management is a v2 item.
- ✅ **Watch-only by single address** — shipped, and it is the **default** of the two watch paths. A single address links nothing and amplifies nothing (§2.2), so it is offered ahead of the `acct_xvk` one rather than beside it; the account-key path now carries an explicit warning that it exposes every address and the whole history. `parseWatchAddress` refuses a wrong-network address (which would otherwise return a truthful, terrifying 0 ADA) and a stake address (which holds no UTxO, so it would read as an empty wallet).
- ⬜ **Randomised challenge position at confirm** — §2.5 always asks for the *last* four characters. Grinding a vanity address that matches one fixed window is cheap; grinding one that matches an unpredictable window ("type characters 18–21") is many times dearer, because the attacker must hit a position they cannot know in advance. Deliberately **not** shipped yet: it adds real friction to every send, and whether users tolerate reading into the middle of a bech32 string has to be tested with real people before it becomes the default. Until then the honest framing in §2.5 stands — this gate stops reflex ticks and mis-pastes, not a targeted grind.
- ⬜ **Saved / known recipient addresses ("address book")** — a user-curated, labelled list of familiar destinations, so a send targets a chosen saved entry instead of a freshly pasted string an attacker can grind a look-alike of. Storage is **distributed on LampNet in a Strata** (the same model Smartsend uses); the Phoenix platform keeps none of the user's data on any server. A saved label is display-only: the full address is still shown and its tail retyped at confirm (§2.5), since a saved entry could itself have been poisoned when it was added. Strata record shape + client-side encryption to be specified.
  **Hard constraint on that record: it carries labels and individual addresses only — never an `acct_xvk`, in any form, encrypted or not.** Syncing account keys through shared storage would build exactly the leak amplifier §2.2 describes, on public infrastructure, for every user at once. Written here because "sync the xpub so the address list follows the user" is the obvious convenience to reach for once the Strata exists.

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

- `bun run typecheck` (tsc, no emit) and `bun run test` must both pass, along with the `check:*` gates listed in the README. Tests cover: address golden vectors vs the Rust reference, CKDpub derivation, UTxO decoding, send/stake/governance builders and their on-chain balance equations, the CIP-30 provider guards, the dApp URL pins, the retype-confirm tail (`ConfirmGate`), the indexer error mapping, the air-gap integrity binding, the vault round-trip, what `lock()` actually scrubs, the refusal to treat a web page as an extension context, the rules deciding which websites this wallet answers (§5.8), and the injected provider driven end to end against a fake page — including the check that Phoenix's web build accepts Phoenix's own extension, which is a contract between two files that never call each other.
- **No test count is written here on purpose.** This line has read 98, 104, 130, 218, 241 and 249 at various times — each correct on the day it was typed and wrong a week later. A reader who catches one stale number stops believing the rest of the page, including the parts about what this wallet does *not* protect them from, so the cost of the habit is paid in the wrong place. The count belongs in exactly one file, next to the command that produces it, where a machine can compare the two.
- The send and delegation paths were exercised on **preprod** with disposable funds (send tADA, mint + send a native token, delegate to a stake pool), each confirmed on-chain, before this spec was written. Governance signing carries the preprod caveat in §7.
- Privacy: chain reads go to public Koios (which sees the queried addresses and the client IP). No data is sent to a Phoenix backend, and nothing sends a key anywhere — see §10 for the precise version of that sentence, which is narrower than "keys never leave the wallet".

---

## 10. Data & privacy

- **Keys: never uploaded. Held only in local self-custody mode, and only there** (§2.1a). This line used to read "never held, never uploaded", which contradicted §2.1a on the same page — the whole point of the fourth mode is that it *does* hold a key. Precisely: nothing in this module transmits key material to any server, in any mode. In the three key-free modes nothing holds one either. In local self-custody the encrypted vault sits in this browser profile (extension storage inside the extension, IndexedDB on a web page) and the decrypted key is in memory while unlocked.
- **The user can export the encrypted vault to a file** (`exportVault`, in the local wallet's own screen). That is a deliberate backup path and it is still ciphertext — but "keys never leave the wallet" was false while that button existed, and a security document that overstates in the user's favour is the kind that gets believed at the wrong moment.
- Chain reads: public Koios indexer (addresses queried + IP visible to Koios). Swappable for a backend proxy.
- No analytics, no remote images (emoji stand-ins keep the CSP tight and avoid third-party requests).
