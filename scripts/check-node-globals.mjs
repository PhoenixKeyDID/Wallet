/**
 * Every module that reaches `@stricahq/*` at runtime must import the Node-globals
 * shim first.
 *
 * The reason is an ordering rule, not a style preference. ES modules evaluate
 * their imports in source order, and `@stricahq/bip32ed25519` reads a bare
 * `process` while it is still evaluating — through `pbkdf2` → `readable-stream@2`.
 * If the shim is imported second, the crash has already happened.
 *
 * Getting this wrong is invisible to the test suite: `vitest` runs under Node,
 * where `process` is real. It shows up only in a browser, as a blank page. So
 * the rule is enforced here rather than left to whoever adds the next import.
 *
 * Type-only imports are exempt — they are erased before anything runs.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHIM = "node-globals";

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "__tests__") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) yield full;
  }
}

const offenders = [];

for (const file of [...walk(join(REPO, "src")), ...walk(join(REPO, "extension", "src"))]) {
  const lines = readFileSync(file, "utf8").split("\n");
  const imports = lines
    .map((line, i) => ({ line: line.trim(), no: i + 1 }))
    .filter(({ line }) => line.startsWith("import "));

  const stricahq = imports.find(
    ({ line }) => line.includes("@stricahq") && !line.startsWith("import type "),
  );
  if (!stricahq) continue;

  const shim = imports.find(({ line }) => line.includes(`/${SHIM}"`));
  if (!shim) {
    offenders.push(`${relative(REPO, file)}:${stricahq.no} imports @stricahq without importing the ${SHIM} shim`);
  } else if (shim.no > stricahq.no) {
    offenders.push(`${relative(REPO, file)}:${shim.no} imports the ${SHIM} shim AFTER @stricahq (line ${stricahq.no}) — too late`);
  }
}

if (offenders.length) {
  console.error("Node-globals guard FAILED:");
  for (const o of offenders) console.error("  " + o);
  console.error(`\nAdd \`import "<path>/${SHIM}";\` as the first import of each file listed.`);
  process.exit(1);
}

console.log("Node-globals guard OK — every runtime @stricahq import is preceded by the shim");
