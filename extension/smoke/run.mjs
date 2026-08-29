/**
 * Build the browser bundle, then run it and check the address.
 *
 * Run under Node on purpose. The Node built-ins the browser build stubbed out
 * are inlined into the bundle as throwing stubs, so if the live path touches
 * one it fails here exactly as it would in Chrome — while Node still gives us
 * a process to run it in without a headless browser in CI.
 */
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

execFileSync(
  process.execPath,
  [resolve(here, "../../node_modules/vite/bin/vite.js"), "build", "--config", resolve(here, "vite.config.ts")],
  { stdio: "inherit" },
);

await import(resolve(here, "out/smoke.js"));
const result = await globalThis.__phoenixSmoke();

console.log(JSON.stringify(result, null, 2));
if (!result.addressMatches) {
  console.error("FAIL: browser build derives a different address than the golden vector");
  process.exit(1);
}
if (!result.entropyRoundTrips) {
  console.error("FAIL: vault does not round-trip in the browser build");
  process.exit(1);
}
console.log("Extension bundle OK — golden address and vault round-trip both hold in the browser build");
