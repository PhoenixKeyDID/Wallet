#!/usr/bin/env node
/**
 * The host contract, checked against the code instead of described next to it.
 *
 * This module is mounted inside host apps. Two things have to line up for that
 * to work, and neither of them is visible from inside this repo:
 *
 * 1. **Path aliases.** The UI imports `@/lib/...` and `@/components/...`. Some
 *    of those must resolve *into this module*; the rest are things the host
 *    supplies. This repo type-checks either way, because its own `tsconfig.json`
 *    maps `@/*` to its own `src/`.
 * 2. **Runtime dependencies.** A package listed here has to exist in the host's
 *    `node_modules`, or the host's build fails on a file this repo compiles fine.
 *
 * Both failed silently in a real integration. `src/lib/keystore` was added, and
 * the host — which had no alias for it and no `@scure/bip39` — could not build
 * the wallet-creation screen at all. Nothing in this repo went red: every gate
 * here was green while the feature was unreachable on the site. That is the
 * shape this file exists to break — a check that answers "did we tell them?"
 * rather than "does it work here?".
 *
 * **What this cannot do**, stated so nobody reads more into a green line: it
 * cannot open the host's `tsconfig.json`, because the host is another repository
 * and this gate runs without it. It checks that the contract *document* covers
 * everything the code actually needs. A host that ignores the document still
 * breaks — but now the document cannot fall behind the code without CI saying so,
 * which is the half that was failing.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACT = join(REPO, "docs", "host-contract.json");
const SRC = join(REPO, "src");
const SOURCE_EXT = /\.(m|c)?[jt]sx?$/;

function* walk(dir) {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__") continue;
      yield* walk(full);
    } else if (SOURCE_EXT.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      yield full;
    }
  }
}

/**
 * Every `@/...` prefix the shipped code imports.
 *
 * Trimmed to two segments (`@/lib/keystore`, `@/components/wallet`) because that
 * is the granularity a host maps: an alias covers a directory, and listing every
 * leaf would turn the contract into a file index that goes stale on every rename.
 */
function importedAliases() {
  const found = new Map();
  for (const file of walk(SRC)) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/from\s+"(@\/[^"]+)"/g)) {
      const parts = m[1].split("/");
      const prefix = parts.slice(0, 3).join("/");
      if (!found.has(prefix)) found.set(prefix, relative(REPO, file).split(sep).join("/"));
    }
  }
  return found;
}

const fail = [];
let contract;
try {
  contract = JSON.parse(readFileSync(CONTRACT, "utf8"));
} catch (e) {
  console.error(`Host-contract guard FAILED — cannot read docs/host-contract.json: ${e.message}`);
  process.exit(1);
}

const declared = new Set([
  ...Object.keys(contract.aliasesIntoModule ?? {}),
  ...Object.keys(contract.aliasesFromHost ?? {}),
]);

for (const [prefix, firstSeenIn] of importedAliases()) {
  if (!declared.has(prefix)) {
    fail.push(
      `${prefix} is imported (first in ${firstSeenIn}) but appears in neither ` +
        `aliasesIntoModule nor aliasesFromHost`,
    );
  }
}

// The reverse direction. A contract entry for something no longer imported sends
// a host to wire up a path that does not exist — cheap to fix, and impossible to
// notice, because everything still builds.
const imported = new Set(importedAliases().keys());
for (const prefix of declared) {
  if (!imported.has(prefix)) fail.push(`${prefix} is declared in the contract but nothing imports it`);
}

const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
const deps = Object.keys(pkg.dependencies ?? {});
const mustInstall = new Set(contract.hostMustInstall ?? []);
for (const d of deps) {
  if (!mustInstall.has(d)) fail.push(`"${d}" is a runtime dependency but is not in hostMustInstall`);
}
for (const d of mustInstall) {
  if (!deps.includes(d)) fail.push(`"${d}" is in hostMustInstall but is not a dependency of this module`);
}

if (fail.length) {
  console.error("Host-contract guard FAILED — docs/host-contract.json is behind the code:\n");
  for (const f of fail) console.error(`  • ${f}`);
  console.error(
    "\nA host reads that file to wire this module in. Every line above is something\n" +
      "the host would not know to do, and would discover as a build error in their\n" +
      "repository rather than here.",
  );
  process.exit(1);
}

console.log(
  `Host-contract OK — ${declared.size} aliases and ${mustInstall.size} runtime dependencies, ` +
    `each one both declared and actually used.`,
);
