# Phoenix Wallet browser extension: security audit scope

Status: scope statement for an independent review · Module: `PhoenixKeyDID/Wallet` · Product under review: the Chrome extension built from `extension/` (Manifest V3), together with the code it bundles from `src/`.

This file says **what an auditor is asked to look at, what is out of scope, who is assumed hostile, and how to build and run the repository's own checks.** It describes mechanisms only as far as the code at the audited commit implements them. The module's behaviour and security model are in [`Phoenix Wallet-Feat.md`](<Phoenix Wallet-Feat.md>); where this file and that one differ, that one is the module spec and the difference is a finding worth reporting.

The wallet is **beta and unaudited**. Nothing here is a claim that the extension is safe. It is a list of where to look.

## 1. Which commit is audited

The scope applies to **the commit named in the audit contract**, not to a branch. Pin it before starting (`git rev-parse HEAD` must print that commit) and report findings against it. A finding that only reproduces at a later commit is still useful, but say which one.

The CIP-30 provider surface (section 3.2) is in scope **as it exists at that commit**. This file does not describe behaviour that is not in that commit. When the contract names a commit that serves more of CIP-30 than an earlier one, the contract's commit decides what is read; the component list below stays the same.

## 2. Roles and what each can see

| Question | Answer in this design | Where to verify |
|---|---|---|
| Who holds the key? | In local self-custody mode, the seed is generated in the extension, stored as an Argon2id + AES-256-GCM vault in the browser profile, and held decrypted in memory only while unlocked. Watch-only and Phoenix-custody views hold no spending key. A connected third-party wallet (Lace, Eternl) holds its own. | `src/lib/keystore/vault.ts`, `src/lib/keystore/session.ts`, `src/lib/keystore/storage.ts`; spec section 2.1a |
| Which process holds the unlocked key? | The extension's own approval window and popup (`chrome-extension://` origin). The service worker and the two scripts that touch websites are meant to hold none. | `extension/src/approve.tsx`, `extension/background/worker.ts`; spec section 5.8 |
| Who answers questions about the chain? | A public chain indexer (Koios) for balances, UTxOs, parameters and submission; a price service (CoinGecko) for the optional fiat figure. Neither is trusted for signing decisions; both see the client IP and what is queried. | `src/lib/cardano/provider.ts`, `src/lib/cardano/chainSource.ts`; `host_permissions` in `extension/manifest.json`; spec section 10 |
| Who sees the plaintext secret? | Nothing outside the unlocked extension page should. The recovery phrase is shown once on a screen with no copy control. The vault can be exported as ciphertext only. | `src/components/wallet/SeedPhraseStep.tsx`; spec sections 2.1a and 10 |
| Who checks that what is shown is what is signed? | `summariseTx` decodes the transaction body against an allow-list of fields and refuses what it cannot describe; `signForeignTx` hashes the exact body bytes the dApp supplied. | `src/lib/cardano/txSummary.ts`, `src/lib/keystore/signForeign.ts`; spec section 5.8 |

## 3. In scope

Paths are relative to the repository root. File sizes are not a measure of risk; read the whole directory.

### 3.1 Extension shell and packaging

- `extension/manifest.json`: permissions, `host_permissions`, `content_security_policy`, content-script matches, `all_frames`, `web_accessible_resources`.
- `extension/vite.config.ts`, `extension/manifestForBuild.test.ts`: how the manifest is produced for a build, including the build-time refusal of endpoints the manifest cannot express.
- `extension/popup.html`, `extension/approve.html`, `extension/src/popup.tsx`, `extension/src/approve.tsx`, `extension/src/hostStrings.ts`, `extension/src/i18n.ts`, `extension/src/toast.ts`, `extension/src/TxSummaryView.tsx`.
- `extension/src/popup.css`, which the approval window loads as well as the popup. The approval-window block (the rules under the comment "The approval window", selectors `.approve-*` and `body.approve-page`) is in scope as security code, not as styling: the file itself states two rules there that a stylesheet can break without any script changing. Nothing that identifies the counterparty (the origin, every payee address) may be truncated, and Reject is never the harder button to hit. Check whether a CSS-only change can hide or shorten the origin, hide the refusal or error block, or make the approve button easier to reach than Reject, while `check:popup-css` and the tests stay green.
- `locales/`, for the strings the approval window shows. A swapped translation can label Reject as Approve without touching code.

### 3.2 The dApp-facing path (CIP-30 provider)

Four pieces, each in a different trust zone:

| Zone | Files |
|---|---|
| Page's own JavaScript world | `extension/inpage/provider.ts` (the injected `window.cardano.phoenix`) |
| Content script, isolated world | `extension/content/bridge.ts` |
| Service worker | `extension/background/worker.ts` (origin, grants, approval-window bookkeeping) |
| Shared message contract | `extension/src/rpc/protocol.ts` (method lists and permission tiers, request parsing, origin rules) |

The surface a website can reach is every CIP-30 method named in `extension/src/rpc/protocol.ts`: `enable` and `isEnabled`; the read methods (`getNetworkId`, `getUtxos`, `getCollateral`, `getBalance`, `getUsedAddresses`, `getUnusedAddresses`, `getChangeAddress`, `getRewardAddresses`, `getExtensions`); and the per-use methods `signTx`, `signData` and `submitTx`. Naming a method in `protocol.ts` lets a request through the content script and service worker; it does not mean the wallet answers it. What each method gets is decided in the approval window (`serve` and the decide screen in `extension/src/approve.tsx`) and, for `isEnabled`, in `extension/background/worker.ts`.

When this section was last revised, the 13 methods fell into two groups:

| Group | Methods | What happens |
|---|---|---|
| Answered | `isEnabled` | The service worker answers from the stored grant, without opening a window. |
| | `enable` | The connect screen of the approval window asks the user; only a completed "allow" creates the grant. |
| | `getNetworkId`, `getUsedAddresses`, `getUnusedAddresses`, `getChangeAddress`, `getRewardAddresses`, `getExtensions` | Answered from the unlocked account, for an origin that holds a grant. Both address lists return the receiving chain; `getExtensions` returns an empty list. |
| | `signTx` | Shown on the decide screen. The approve button is enabled only when `summariseTx` can describe the transaction. |
| Refused | `getUtxos`, `getBalance` | Refused as unsupported. |
| | `getCollateral` | Refused with a "no collateral" error rather than an empty list. |
| | `signData`, `submitTx` | Opened on the decide screen with an "unsupported" line. The approve button stays disabled, so the only answer the user can give is a refusal. |

A pull request that adds CIP-30 support is in preparation and moves methods from the refused group to the answered group. Measure the groups again in `approve.tsx` at the audited commit, not from this table. Review every answered method for what it returns, what it asks the user, and what a hostile page can do with the answer. Review every refused method for whether the refusal holds on every path, including a crafted message and a request sent while another is on screen.

### 3.3 Key handling and signing

- `src/lib/keystore/`: `mnemonic.ts`, `derive.ts`, `vault.ts`, `storage.ts`, `session.ts`, `signer.ts`, `signForeign.ts`, `port.ts`, `index.ts`.
- `src/lib/cardano/walletPort.ts`: the interface through which Send, Staking and Governance sign, whichever wallet backs it.
- `src/lib/cardano/txSummary.ts`: the decoder that produces the text a person approves.
- `src/lib/cardano/tx.ts`, `send.ts`, `staking.ts`, `governance.ts`, `address.ts`, `hash.ts`, `xpub.ts`, `cip30.ts`, `connect.ts`: transaction construction, address handling, key derivation helpers.
- `src/lib/node-globals.ts`: the shim whose import order the `check:node-globals` gate enforces.

### 3.4 Network egress and error handling

- `src/lib/cardano/provider.ts`, `chainSource.ts`, `chainEnv.ts`, `blockfrost.ts`, `submitError.ts`: which hosts the wallet talks to, how responses are validated, what happens on a partial or malformed answer, where a signed transaction is sent.
- `src/lib/api.ts`, `src/lib/wallet.ts`, `src/lib/night.ts`: calls to a host backend and the redemption hand-off. Reviewed for what leaves the machine, not for the backend.

### 3.5 User-facing screens that handle money or secrets

- `src/components/wallet/`: in particular `LocalWalletPanel.tsx`, `SeedPhraseStep.tsx`, `ConfirmGate.tsx`, `SendPanel.tsx`, `StakingPanel.tsx`, `GovernancePanel.tsx`, `ReviewOutput.tsx`, `UncertainSubmitNotice.tsx`, `signError.ts`.
- `src/components/CopyBtn.tsx`: the only component allowed to touch the clipboard.

### 3.6 The repository's own safeguards

The `scripts/check-*.mjs` gates and their tests are part of the system under review, because several security claims are held by them rather than by prose. Audit them as code: can the property they claim be broken while they still print `OK`?

| Gate | What it claims to hold |
|---|---|
| `scripts/check-keystore-boundary.mjs` | only the key-holding screens and the bundle smoke check import `src/lib/keystore/` |
| `scripts/check-urls.mjs` | no outbound URL outside files that `.github/CODEOWNERS` gates |
| `scripts/check-extension-package.mjs` | the built extension loads and claims no reach it does not use |
| `scripts/check-extension-host.mjs` | the extension supplies what a host owes (`docs/host-contract.json`) |
| `scripts/check-host-contract.mjs` | the host contract matches what the code imports |
| `scripts/check-node-globals.mjs` | the Node-globals shim is imported before `@stricahq/*` |
| `scripts/check-tiers-codeowners.mjs` | in `docs/contribution-tiers.json`: every path `.github/CODEOWNERS` gates is `forbidden` (a CODEOWNERS line counts as a directory when git tracks a file under it, and each such directory is also probed with one not-yet-existing file name); every `low`/`mid` entry is one tracked file, not a pattern; no `low`/`mid` file is reached from a `forbidden` file through the static import graph of `src/` and `extension/` (`import`/`export … from`, `import()`, `new URL(…, import.meta.url)`, `@/` read as `src/`; test files left out). It does not see a dependency that is not an import — a component that only renders a warning, a value read at run time — so the table forbids those by hand |
| `scripts/check-popup-css.mjs`, `check-locales.mjs`, `check-i18n-keys.mjs`, `check-readme-claims.mjs` | consistency of popup styles, locales, translation keys and README claims |
| `scripts/mutants.mjs` | a list of exact edits that remove a guard, to show a named test goes red; not run in CI |
| `extension/smoke/` | the browser bundle runs with no Node globals |
| `.github/workflows/ci.yml`, `.github/CODEOWNERS` | what CI runs, and who must approve changes to trust-boundary files |

### 3.7 Dependencies and build chain

`package.json` and `bun.lock`: the runtime libraries that sign and derive (`@stricahq/typhonjs`, `@stricahq/bip32ed25519`, `@noble/hashes`), and anything that can alter the shipped bundle at build time. Report known advisories for the versions pinned in `bun.lock`.

## 4. Threat model

The adversaries below are assumed. For each: what they can do, and what the design is meant to deny them. The audit should try to break the "meant to deny" column, and should report any claim in the module spec that it breaks.

| Adversary | Capability assumed | Design intent (to be tested, not trusted) |
|---|---|---|
| Malicious website calling the CIP-30 API | Runs arbitrary script in its own page; can call every method on `window.cardano.phoenix`; can craft any message to the content script; can open many requests; can lie about transaction content | Origin is read from the browser (`sender.origin`), never from the message; only top-frame `https:` and loopback origins are served; reads need a grant given to that origin; `signTx`, `signData` and `submitTx` ask every time; an unknown method is refused; a transaction that cannot be described in words is refused rather than shown as hex |
| Malicious website imitating the wallet | Draws a fake approval or password prompt in the page | The password field exists only in the extension's own window on a `chrome-extension://` origin |
| Hostile or compromised web page script, same page | Executes in the same page as a legitimate dApp, can read anything the page's world can read | The injected provider and bridge hold no key and relay bytes; the unlocked account lives only in the extension page |
| Other browser extensions | May hold host access to pages or to the clipboard; cannot read this extension's isolated pages unless the browser allows it | Out of the wallet's control; auditors should state what a co-installed extension with broad host permissions can reach (page-world provider, clipboard, screenshots) |
| Malware or a compromised machine | Reads memory, injects input, replaces the installed extension, reads the browser profile | Out of scope as a defence goal (section 5). In scope as a question: what does the vault protect when the profile is copied, and what does `lock()` actually scrub from memory? |
| Malicious or compromised chain indexer | Returns wrong balances, UTxOs or parameters, truncates answers, delays or reorders responses, logs queries | Truncated answers are refused rather than shown; the indexer is never given a key; the wallet's signing decision is meant to rest on the transaction bytes, not on indexer claims |
| Malicious dApp supplying a crafted transaction | Valid CBOR whose effects differ from what a naive summary would say: extra outputs, certificates, withdrawals, minting, collateral fields, alternative encodings of the same body | `summariseTx` allow-list; the signature covers the dApp's exact body bytes; witness set returned alone |
| Supply chain | A dependency or build step alters the shipped bundle; a pull request alters an allow-list or a gate | Pinned lockfile; CODEOWNERS on trust-boundary files; `check:urls`, `check:package` and `check:keystore-boundary` in CI |
| Address poisoning | A look-alike destination is placed in the user's clipboard or history | `ConfirmGate` retype of the recipient tail. The spec states this defeats reflex ticks and mis-pastes, not a targeted grind; an auditor should confirm that statement is accurate |
| Attacker with physical access to an unlocked session | Uses a browser left open | Auto-lock after inactivity (default five minutes, configurable, "never" is opt-in) and lock on visibility change; review whether the approval window shares that lock |

Questions the audit should answer explicitly, in the report:

1. Can any code path outside the extension's own pages obtain the seed, a derived private key, or the password?
2. Can any message from a web page cause a signature, a submission, or a grant without a user action in the extension window?
3. Is the text a user approves a faithful description of what the signature authorises, including for transaction shapes the summary refuses?
4. After `lock()`, what key material remains reachable in memory or storage?
5. Which outbound hosts can the extension contact, from which context, and can that set be widened by a pull request without a CODEOWNERS review?
6. For each gate in 3.6: can the property be broken while the gate passes?

## 5. Out of scope

- The PhoenixKey backend, DID registry, validators and any on-chain script (`PhoenixKeyDID/PhoenixKey-Database`, `PhoenixKey-Validator`, `PhoenixKey-Specs`). Findings about how this module calls a backend are in scope; the backend itself is not.
- The web application that mounts this module (`PhoenixKeyDID/PhoenixKey-Frontend`) and the host wiring of `@/lib/api`, `@/lib/toast`, `CopyBtn`, `Nav`, `Footer`. The module's own placeholder versions in this repository are in scope only where the extension bundles them.
- Third-party wallets used in Connect mode (Lace, Eternl, Typhon), the Koios and CoinGecko services, the Chrome browser, and the operating system.
- Cardano ledger rules and node behaviour.
- Attacks that require full control of the user's machine or of the browser process (malware reading process memory, a replaced browser binary), except where the audit can show the extension makes them worse than they need be.
- Social engineering outside the extension's own screens.
- The distribution channel (Chrome Web Store listing and review), and the optional air-gap QR co-sign path, whose signer is not in this repository.
- Locale text quality and the styling of screens other than the approval window, and the `dist-extension/` build output as an artefact (the build is in scope; a previously built folder is not). The approval-window CSS rules and the strings that window shows are in scope (section 3.1).

## 6. How to build and run the checks

Requirements: Bun and Node.js, as used by `.github/workflows/ci.yml` (which installs with `bun install --frozen-lockfile` and the latest Bun). Use a clean clone at the audited commit.

```
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run build:extension        # writes dist-extension/ (git-ignored)
bun run check:locales
bun run check:i18n-keys
bun run check:host-contract
bun run check:extension-host
bun run check:urls
bun run check:tiers-codeowners
bun run check:node-globals
bun run check:keystore-boundary
bun run check:bundle
bun run check:package
bun run check:popup-css
bun run check:readme
```

Load the built extension: in Chrome open `chrome://extensions`, enable Developer mode, choose Load unpacked, pick `dist-extension/`. The spec states, and the auditor should confirm, that the CIP-30 path had not been exercised in a real browser when the spec was last written; unit tests over `extension/src/rpc/protocol.ts` and `check:package` verify rules and packaging, not a running browser. A review that loads the package into Chrome and drives the provider from a test page adds evidence the repository does not have.

`node scripts/mutants.mjs` removes named guards one at a time and runs the tests; it is not part of CI and each mutation is a full test run. A mutation that stays green means the guard can be removed without a test objecting. That is a finding, and the auditor may add cases.

Useful for reproduction: use a preprod or preview recovery phrase with disposable funds. Do not use a mainnet seed that holds value.

## 7. Reporting

Report each finding with: the commit audited, file and line at that commit, the adversary from section 4, a reproduction (test, script or steps), the impact in terms of what an attacker gains, and a suggested change. Findings that show a claim in [`Phoenix Wallet-Feat.md`](<Phoenix Wallet-Feat.md>) is untrue are as valuable as code defects: the spec is a document people copy from.

Do not publish a finding that lets someone take funds before the maintainers have had a chance to fix it. This repository has no `SECURITY.md` at the time of writing; use the repository's private vulnerability reporting for anything exploitable, and a public issue only for non-exploitable findings.
