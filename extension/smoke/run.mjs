/**
 * Build the browser bundle, then run it **with the Node globals taken away**.
 *
 * The earlier version of this file ran the browser bundle under a plain Node
 * process and checked the derived address. It passed while the real extension
 * was broken, because the thing that breaks in a browser is not the maths — it
 * is `process`. `@stricahq/bip32ed25519` reaches PBKDF2 → `readable-stream@2`,
 * which reads a bare `process.browser` while the module is still evaluating.
 * Node has `process`; Chrome does not. Measured: the built popup threw
 * `ReferenceError: process is not defined` and rendered a blank page, with
 * every unit test and this very check green.
 *
 * So before importing the bundle we delete `process`, `global`, `setImmediate`
 * and `Buffer` — the Node globals a browser does not have. `Buffer` joined the
 * list after the same shape of failure one step later: `@stricahq/typhonjs`
 * calls a bare `Buffer.from` while building a transaction, so the popup rendered
 * and Review failed with `Buffer is not defined`, while this check — which only
 * derived and sealed — stayed green. It now builds a payment too. What is left
 * is close enough to a browser that the failure happens here instead of on a
 * user's machine, while Node still gives us somewhere to run it without pulling
 * a headless browser into CI.
 *
 * The shim in `src/lib/node-globals.ts` is what puts them back, and this
 * check is the only thing that proves the shim is loaded early enough.
 */
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// Everything that needs the real Node environment happens first.
const node = process.execPath;
const vite = resolve(here, "../../node_modules/vite/bin/vite.js");
const config = resolve(here, "vite.config.ts");
const bundle = resolve(here, "out/smoke.js");
const fail = (msg) => {
  console.error("FAIL: " + msg);
  realProcess.exit(1);
};

execFileSync(node, [vite, "build", "--config", config], { stdio: "inherit" });

const realProcess = process;
for (const name of ["process", "global", "setImmediate", "Buffer"]) {
  if (!(name in globalThis)) continue;
  delete globalThis[name];
  if (name in globalThis) fail(`could not remove the Node global \`${name}\`; this check would not prove anything`);
}
// Spelled out a second time, not derived from the list above: dropping a name
// from that list would otherwise leave this check green while it no longer
// takes the global away.
if (typeof process !== "undefined" || typeof global !== "undefined" || typeof setImmediate !== "undefined" || typeof Buffer !== "undefined") {
  fail("a Node global is still present before the bundle loads; this check would not prove anything");
}

await import(bundle);
const result = await globalThis.__phoenixSmoke();

console.log(JSON.stringify(result, null, 2));
if (!result.addressMatches) fail("browser build derives a different address than the golden vector");
if (!result.entropyRoundTrips) fail("vault does not round-trip in the browser build");
if (!result.popupGraphLoads) fail("the popup's own module graph does not evaluate in the browser build");
if (!/^[1-9][0-9]{4,}$/.test(String(result.paymentFee))) fail("the browser build could not build a payment transaction");
console.log("Extension bundle OK — golden address, vault round-trip and a built payment hold with no Node globals present");
