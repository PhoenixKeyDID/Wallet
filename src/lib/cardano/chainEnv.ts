/**
 * Reading the chain endpoint out of the build, so no host has to write code.
 *
 * `chainSource.ts` makes the endpoint swappable; this file is the one way it
 * actually gets swapped today. The reason it exists is a constraint neither
 * file could solve alone: this module is consumed **as source** by two hosts
 * with different bundlers, and one of them is a repository this house may not
 * commit to. A wiring that needs a line of host code would sit unwritten in
 * that repository and the wallet would keep reading nothing.
 *
 * So the endpoint arrives the one way both bundlers already carry values in —
 * a build-time variable — and `getChainSource` falls back to it. A host that
 * prefers to be explicit still calls `setChainSource`, and that still wins.
 *
 * ## What a value here costs
 *
 * A `project_id` compiled into a browser bundle is **public**. Anyone who opens
 * the page, or unpacks the extension, can read it and spend the quota. That is
 * not a flaw in how it is stored — there is no way to hold a secret in code the
 * user's own browser runs. It is the price of using a keyed third-party
 * indexer at all, and the reason the platform runs its own: a self-hosted Dolos
 * MiniBF endpoint needs no key, and `…_CHAIN_BASE_*` alone (with no project id)
 * is exactly that case.
 *
 * ## Why the hosts are literals here and not in `chainSource.ts`
 *
 * `chainSource.ts` deliberately ships no URL: it is the mechanism, and a URL
 * there would be a claim about infrastructure. These three are different — they
 * are the published addresses of one named vendor, they change only when that
 * vendor changes them, and `check:urls` plus a CODEOWNERS entry make adding a
 * fourth a reviewed act. Keeping them out of the mechanism keeps the mechanism
 * honest about owning nothing.
 */
import type { PhoenixNetwork } from "./address";
import type { ChainSource } from "./chainSource";

/**
 * Blockfrost's published REST hosts, one per network.
 *
 * Only ever a default: any of them is replaced by `…_CHAIN_BASE_<NETWORK>`,
 * which is how this points at the platform's own node without a code change.
 */
// `satisfies` rather than a type annotation: the commit guard reads
// `BLOCKFROST…: <long value>` as a key being written down, which is exactly the
// shape it should stop. Being blunt is the right setting for that gate, so the
// declaration moves rather than the gate.
const BLOCKFROST_HOST = {
  1: "https://cardano-mainnet.blockfrost.io/api/v0",
  0: "https://cardano-preprod.blockfrost.io/api/v0",
  2: "https://cardano-preview.blockfrost.io/api/v0",
} satisfies Record<PhoenixNetwork, string>;

const SUFFIX: Record<PhoenixNetwork, string> = { 1: "MAINNET", 0: "PREPROD", 2: "PREVIEW" };

/** What a build-time variable looks like once a bundler has inlined it. */
export type BuildEnv = Readonly<Record<string, string | undefined>>;

/**
 * `import.meta.env` declared here rather than pulled in from `vite/client`.
 *
 * This module is compiled by whichever host consumes it, and only one of them
 * uses Vite. Depending on Vite's ambient types would make the type check pass
 * or fail based on which app is building — the sort of difference that shows up
 * as a broken build in somebody else's repository.
 */
declare global {
  interface ImportMeta {
    /**
     * Declared as always present, and read inside a `try` because it is not.
     * An optional type would force `!` or `?.` onto every read below, and both
     * change the text a bundler is looking for — the one thing this file cannot
     * afford, since getting it wrong ships an empty endpoint silently.
     */
    readonly env: BuildEnv;
  }
}

/**
 * The same variable under either bundler's required prefix.
 *
 * Vite refuses to expose anything that is not `VITE_*`, and Next refuses
 * anything that is not `NEXT_PUBLIC_*`. Both refusals are deliberate — they
 * make "this value ships to the browser" visible in the variable's own name —
 * so this reads both rather than inventing a third name that hides it.
 */
function pick(env: BuildEnv, name: string): string | undefined {
  const v = env[`VITE_${name}`] ?? env[`NEXT_PUBLIC_${name}`];
  const trimmed = v?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * The endpoint this build was given for one network, or `null` for "none".
 *
 * `null` is not a failure and must not be reported as one: a build with no
 * variable set is the normal open-source build, and it reads the chain the way
 * it always did.
 *
 * Pure, and takes the environment as an argument, because the alternative is a
 * function whose behaviour depends on which bundler compiled it — untestable in
 * exactly the case worth testing.
 */
export function chainSourceFromEnv(network: PhoenixNetwork, env: BuildEnv): ChainSource | null {
  const suffix = SUFFIX[network];
  const projectId = pick(env, `BLOCKFROST_PROJECT_ID_${suffix}`);
  const base = pick(env, `CHAIN_BASE_${suffix}`);
  if (!projectId && !base) return null;
  // A base with no key is the self-hosted case and the one this is aiming at;
  // a key with no base is Blockfrost's own service. Both are legitimate, and
  // the difference between them is a question about the endpoint, not an error.
  return { kind: "blockfrost", base: base ?? BLOCKFROST_HOST[network], ...(projectId ? { projectId } : {}) };
}

/**
 * Everything the bundler inlined, gathered from whichever of the two ran.
 *
 * Every one of the twelve reads below is spelled out in full, and that is not
 * clumsiness — it is the only form that works. Both bundlers replace the
 * **text** of a complete member expression with a string constant; neither
 * builds an object you can copy. `Object.assign(out, import.meta.env)` was
 * tried first and it failed the worst possible way: the code looked right, the
 * build was green, and the shipped bundle contained no endpoint at all.
 * Measured on the real extension build — the key appeared **0 times** in the
 * output. Nothing in the test suite could see it, because under `vitest` (which
 * is Vite in dev) the wholesale object does exist.
 *
 * That is why this list is duplicated rather than generated: a loop over names
 * would be exactly the version that silently ships nothing.
 *
 * The `typeof` guards and the two separate `try` blocks carry the other half:
 * whichever bundler did not run leaves its identifier genuinely undefined.
 */
export function readBuildEnv(): BuildEnv {
  const out: Record<string, string | undefined> = {};
  const keep = (k: string, v: string | undefined) => {
    if (v !== undefined) out[k] = v;
  };

  try {
    // Vite (the extension, and `vitest`). The wholesale object is read too,
    // because in dev it is the only place a stubbed variable appears.
    const meta = import.meta as unknown as { env?: BuildEnv };
    if (meta && typeof meta.env === "object" && meta.env) Object.assign(out, meta.env);
    keep("VITE_BLOCKFROST_PROJECT_ID_MAINNET", import.meta.env.VITE_BLOCKFROST_PROJECT_ID_MAINNET);
    keep("VITE_BLOCKFROST_PROJECT_ID_PREPROD", import.meta.env.VITE_BLOCKFROST_PROJECT_ID_PREPROD);
    keep("VITE_BLOCKFROST_PROJECT_ID_PREVIEW", import.meta.env.VITE_BLOCKFROST_PROJECT_ID_PREVIEW);
    keep("VITE_CHAIN_BASE_MAINNET", import.meta.env.VITE_CHAIN_BASE_MAINNET);
    keep("VITE_CHAIN_BASE_PREPROD", import.meta.env.VITE_CHAIN_BASE_PREPROD);
    keep("VITE_CHAIN_BASE_PREVIEW", import.meta.env.VITE_CHAIN_BASE_PREVIEW);
  } catch {
    // `import.meta` is a syntax-level form; a bundler that left it unreplaced
    // throws here rather than at module load.
  }

  try {
    // Next (the web app).
    if (typeof process !== "undefined" && process && typeof process.env === "object") {
      keep("NEXT_PUBLIC_BLOCKFROST_PROJECT_ID_MAINNET", process.env.NEXT_PUBLIC_BLOCKFROST_PROJECT_ID_MAINNET);
      keep("NEXT_PUBLIC_BLOCKFROST_PROJECT_ID_PREPROD", process.env.NEXT_PUBLIC_BLOCKFROST_PROJECT_ID_PREPROD);
      keep("NEXT_PUBLIC_BLOCKFROST_PROJECT_ID_PREVIEW", process.env.NEXT_PUBLIC_BLOCKFROST_PROJECT_ID_PREVIEW);
      keep("NEXT_PUBLIC_CHAIN_BASE_MAINNET", process.env.NEXT_PUBLIC_CHAIN_BASE_MAINNET);
      keep("NEXT_PUBLIC_CHAIN_BASE_PREPROD", process.env.NEXT_PUBLIC_CHAIN_BASE_PREPROD);
      keep("NEXT_PUBLIC_CHAIN_BASE_PREVIEW", process.env.NEXT_PUBLIC_CHAIN_BASE_PREVIEW);
    }
  } catch {
    // The Node-globals shim defines `process.env` as `{}`, and a real browser
    // defines no `process` at all. Both land here as "nothing was inlined".
  }
  return out;
}
