/**
 * The self-custody keystore is reachable from one place, and only one.
 *
 * `docs/Phoenix Wallet-Feat.md` §2.1a and the README both say it: the code that
 * holds a spendable seed lives in `src/lib/keystore/` and no other mode imports
 * it, which is what lets the spec claim the three key-free modes stay key-free.
 *
 * That sentence was true and unenforced. Nothing stopped a future panel from
 * importing `keystore/session` for something innocent-looking — a lock timer, a
 * wallet list — and once any Connect or Watch-only screen pulls the module in,
 * the claim is false everywhere it is written, silently, and the person who
 * broke it had no way to know they were breaking anything.
 *
 * An invariant a document asserts and a machine does not check is a wish. This
 * is the check. Widening the allow-list is allowed — it is a reviewed diff in a
 * CODEOWNERS-gated file, which is exactly the conversation that should happen.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Repo-relative, POSIX-separated. Anything here may import the keystore. */
const ALLOWED = [
  "src/lib/keystore/", // the module itself
  "src/components/wallet/LocalWalletPanel.tsx", // the one screen that holds a key
  "extension/smoke/", // the browser-bundle check, which must exercise the real thing
];

const SCAN = ["src", "extension"];
const IMPORT_RE = /^(?:import|export)\b[\s\S]*?["']([^"']+)["']/gm;
/** Any spelling of the keystore path: `@/lib/keystore`, `../keystore/vault`, … */
const KEYSTORE_RE = /(^|\/)lib\/keystore(\/|$)|(^|\/)keystore\/(vault|derive|signer|session|storage|mnemonic)$/;

function* walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    if (name === "node_modules" || name === "out") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.tsx?$/.test(name)) yield full;
  }
}

const rel = (f) => relative(REPO, f).split(sep).join("/");
const allowed = (r) => ALLOWED.some((a) => (a.endsWith("/") ? r.startsWith(a) : r === a));
const lineOf = (text, index) => text.slice(0, index).split("\n").length;

const offenders = [];
for (const file of SCAN.flatMap((d) => [...walk(join(REPO, d))])) {
  const r = rel(file);
  if (allowed(r)) continue;
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(IMPORT_RE)) {
    const spec = m[1];
    if (KEYSTORE_RE.test(spec.replace(/^@\//, "src/").replace(/^\.\.?\//, ""))) {
      offenders.push(`${r}:${lineOf(text, m.index)} imports "${spec}"`);
    }
  }
}

if (offenders.length) {
  console.error("Keystore boundary FAILED — the self-custody keystore is reachable from:\n");
  for (const o of offenders) console.error("  • " + o);
  console.error(
    "\nThe spec (§2.1a) and the README both promise this module is reachable only" +
      "\nfrom LocalWalletPanel, which is what makes the key-free modes key-free." +
      "\nEither route this through the panel, or widen ALLOWED in this file and say" +
      "\nin the same diff which document sentence you are changing.",
  );
  process.exit(1);
}

console.log(
  `Keystore boundary OK — src/lib/keystore is imported only from ${ALLOWED.length} allowed locations.`,
);
