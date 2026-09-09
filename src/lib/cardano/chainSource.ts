/**
 * Where this wallet reads the chain from — and how that is allowed to change.
 *
 * The wallet shipped against exactly one indexer, Koios, with the host names
 * written into `provider.ts`. That was fine while the only question was *which*
 * public service to trust. It stopped being fine for two separate reasons, and
 * only the second one is about trust:
 *
 * 1. **A browser cannot use Koios at all.** Measured 2026-09-08 on all three
 *    networks: the preflight answers `access-control-allow-origin: *` and the
 *    response carrying the data does not, so every page-side `fetch` fails while
 *    `curl` gets `200` and the rows. The extension is unaffected — its
 *    `host_permissions` put it outside same-origin rules — but the web wallet is
 *    not, and that is most of what a wallet does.
 * 2. **The platform already runs its own chain access.** Cnode serves Dolos
 *    MiniBF, a Blockfrost-compatible REST face, from nodes it operates —
 *    deliberately so that nothing here depends on a third-party indexer. Writing
 *    a second indexer, or picking another SaaS, would be rebuilding something
 *    that exists and is more trustworthy than what it would replace.
 *
 * So the fix is not a new data source. It is making the existing one **swappable
 * from outside this repo**: the same six reads and one submit, behind a choice
 * the host or the person makes, defaulting to today's behaviour so nothing moves
 * until somebody moves it.
 *
 * **What this file deliberately does not do:** it does not pick an endpoint, and
 * it ships no address for one. A URL literal here would be a claim about
 * infrastructure this repo does not run and cannot check — and `check:urls`
 * would rightly stop it. The address arrives from outside: a host calling
 * `setChainSource`, or a build-time variable read by `chainEnv.ts` — which is
 * the only file here that names an endpoint, and is CODEOWNERS-gated for it.
 * See `README.md` § Host contract.
 */
import type { PhoenixNetwork } from "./address";
import { chainSourceFromEnv, readBuildEnv } from "./chainEnv";

/**
 * A place to read the chain from.
 *
 * `koios` carries no address because those hosts are literals in `provider.ts`,
 * where the outbound-URL gate can see them. `blockfrost` carries one because
 * that is the whole point of it — the shape is the API dialect, not the vendor:
 * Dolos MiniBF speaks it, and so does Blockfrost itself.
 */
export type ChainSource =
  | { kind: "koios" }
  | {
      kind: "blockfrost";
      /** Base URL up to and including the API version, no trailing slash. */
      base: string;
      /**
       * `project_id` header, when the endpoint is Blockfrost SaaS.
       *
       * Optional because the case this exists for — a self-hosted Dolos MiniBF —
       * needs no key at all. Anyone putting a real Blockfrost key here should
       * know what they are doing: in a browser it is readable by the page, so it
       * is a key shared with everyone who visits. That is a reason to run your
       * own endpoint, which is what the rest of this platform does.
       */
      projectId?: string;
    };

export const DEFAULT_CHAIN_SOURCE: ChainSource = { kind: "koios" };

/**
 * Reject an endpoint that cannot be one, before any request is built from it.
 *
 * Checked here rather than at the fetch, because a bad base URL fails as a
 * network error at the fetch — indistinguishable from the endpoint being down,
 * which is the one diagnosis that sends someone to look at the wrong machine.
 *
 * `http://` is allowed only for loopback. A wallet is not the place to make it
 * easy to read chain state over plain HTTP from another host: an attacker on the
 * path could not steal keys, but they could invent a balance, an unspent output
 * or a protocol parameter, and every one of those goes into a transaction the
 * person then signs.
 */
export function validateChainSource(src: ChainSource): void {
  if (src.kind === "koios") return;
  let u: URL;
  try {
    u = new URL(src.base);
  } catch {
    throw new Error(`chain source: "${src.base}" is not a URL`);
  }
  const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) {
    throw new Error(`chain source: ${u.protocol}//${u.host} — only https, or http on loopback`);
  }
  /**
   * `fetch` refuses a URL carrying credentials outright — and refuses it with
   * the same `TypeError` it uses for "the server never answered". That is
   * precisely the confusion this function exists to prevent: a pure
   * configuration mistake would be wrapped as `ProviderUnreachableError` and
   * send the operator to inspect a machine that is working fine.
   *
   * Realistic, not theoretical: pasting the URL of a reverse proxy that carries
   * basic auth is the ordinary way this arrives. A key for an endpoint belongs
   * in a header, which is where this module already puts it.
   */
  if (u.username || u.password) {
    throw new Error(`chain source: "${src.base}" must carry no username or password`);
  }
  if (u.search || u.hash) throw new Error(`chain source: "${src.base}" must carry no query or fragment`);
  if (src.base.endsWith("/")) throw new Error(`chain source: "${src.base}" must not end with "/"`);
}

/**
 * One source per network, not one for the wallet.
 *
 * An endpoint serves the chain it syncs, and pointing a mainnet balance read at
 * a preprod node returns a confident, entirely wrong number rather than an
 * error — the request succeeds, the JSON parses, the address simply holds
 * nothing there. Keying by network makes that mistake require two deliberate
 * acts instead of one.
 */
const configured = new Map<PhoenixNetwork, ChainSource>();

export function setChainSource(network: PhoenixNetwork, src: ChainSource): void {
  validateChainSource(src);
  configured.set(network, src);
}

/**
 * Read once, not per request.
 *
 * The build-time environment cannot change while the page is open, so re-deriving
 * it on every chain read would be work with a guaranteed identical answer. Cached
 * per network rather than globally because the answer differs per network, and
 * `null` — "this build was given nothing" — is itself a cached answer.
 */
const fromEnv = new Map<PhoenixNetwork, ChainSource | null>();

export function getChainSource(network: PhoenixNetwork): ChainSource {
  const explicit = configured.get(network);
  if (explicit) return explicit;

  if (!fromEnv.has(network)) {
    let derived: ChainSource | null = null;
    try {
      derived = chainSourceFromEnv(network, readBuildEnv());
      if (derived) validateChainSource(derived);
    } catch (err) {
      // A malformed value in the build environment is a mistake in the build,
      // not a reason to read the chain from somewhere the operator did not
      // choose — but it must not take the wallet down either. Say it once,
      // loudly enough to find, and fall back to the default.
      console.error(`[wallet] chain endpoint from build environment ignored: ${(err as Error).message}`);
      derived = null;
    }
    fromEnv.set(network, derived);
  }
  return fromEnv.get(network) ?? DEFAULT_CHAIN_SOURCE;
}

/** Drop every configured source. Exported for tests and for a host tearing down. */
export function resetChainSources(): void {
  configured.clear();
  fromEnv.clear();
}
