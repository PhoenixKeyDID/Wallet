/**
 * The two Node globals our Cardano dependencies still reach for, defined for
 * the browser.
 *
 * This file exists because of a bug that a green test suite could not see. The
 * Icarus key derivation in `@stricahq/bip32ed25519` uses the `pbkdf2` package,
 * whose browser build pulls in `readable-stream@2`, and that reads a bare
 * `process` at module-evaluation time:
 *
 *     var asyncWrite = !process.browser && [...].indexOf(process.version...)
 *
 * In Node — where `vitest` runs, and where the bundle smoke test used to run —
 * `process` exists, so every test passed. In an actual browser it does not, so
 * loading the wallet threw `ReferenceError: process is not defined` before a
 * single pixel was painted. Measured in Chrome against the built extension
 * bundle: the popup rendered blank.
 *
 * The shim is deliberately the smallest thing that satisfies the branches those
 * libraries actually take, rather than a general-purpose Node polyfill:
 *
 * - `browser: true` sends `pbkdf2` down its browser path and stops
 *   `readable-stream` from asking for `setImmediate`.
 * - `version: ""` makes `process-nextick-args` use its own shim instead of
 *   trusting ours.
 * - `nextTick` goes through `queueMicrotask`, which has the ordering these
 *   libraries expect (before the next task, after the current one).
 *
 * `??=` means a real Node process — or another shim that got there first — is
 * left alone. Importing this module twice does nothing the second time.
 *
 * Any module that imports `@stricahq/*` at runtime must import this **first**,
 * because ES modules evaluate their imports in source order. `bun run
 * check:node-globals` enforces that; it is not left to memory.
 */

const g = globalThis as Record<string, unknown>;

g.global ??= globalThis;

g.process ??= {
  browser: true,
  env: {},
  version: "",
  nextTick: (fn: (...a: unknown[]) => void, ...args: unknown[]) =>
    queueMicrotask(() => fn(...args)),
};

export {};
