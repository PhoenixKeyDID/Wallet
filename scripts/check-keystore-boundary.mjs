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
/**
 * Static `import`/`export … from`, anchored at the start of a line.
 *
 * The anchor is why the second pattern below exists. This one only sees a
 * statement beginning in column 0, which is every *static* import — but a
 * module can also be pulled in from inside a function body, indented, and that
 * is the shape someone reaches for when the obvious spelling is rejected.
 */
const IMPORT_RE = /^(?:import|export)\b[\s\S]*?["']([^"']+)["']/gm;
/**
 * Dynamic `import("…")` and `require("…")`, anywhere, at any indentation.
 *
 * Verified against this gate before it was added: a file containing only
 * `export const CLS = "probe";` and `return import("@/lib/keystore/port")`
 * inside a function was reported **OK**, as was the same file using
 * `require(...)`. The pattern above cannot reach either — its `^` anchor skips
 * indented code, and its lazy body stops at the first quote it meets, which in
 * such a file is an unrelated string literal.
 *
 * An invariant a document asserts and a machine only half-checks is still a
 * wish; it is just a wish that prints OK.
 *
 * What this still does not stop, stated so nobody mistakes the gate for more
 * than it is: a specifier that is never written literally — `eval("require")(…)`,
 * a path assembled from variables, a re-export laundered through a third module.
 * This is a textual check, so it catches the accident and the shortcut, not the
 * author who is deliberately hiding. That author is what code review is for.
 */
const DYNAMIC_RE = /\b(?:import|require)\s*\(\s*["']([^"']+)["']/g;
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
  const seen = new Set();
  for (const re of [IMPORT_RE, DYNAMIC_RE]) {
    re.lastIndex = 0; // these are /g and shared across files
    for (const m of text.matchAll(re)) {
      const spec = m[1];
      if (!KEYSTORE_RE.test(spec.replace(/^@\//, "src/").replace(/^\.\.?\//, ""))) continue;
      const line = lineOf(text, m.index);
      // A static import can match both patterns; report the site once.
      const at = `${r}:${line}`;
      if (seen.has(at)) continue;
      seen.add(at);
      offenders.push(`${at} imports "${spec}"`);
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
