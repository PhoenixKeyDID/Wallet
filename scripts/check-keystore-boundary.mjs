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
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * The repo this script lives in, unless a root is passed as the first argument
 * — which is for the tests, so they can stage an import this gate must refuse
 * without writing it into the repo.
 */
const REPO = process.argv[2]
  ? resolve(process.argv[2])
  : join(dirname(fileURLToPath(import.meta.url)), "..");

/** Repo-relative, POSIX-separated. Anything here may import the keystore. */
const ALLOWED = [
  "src/lib/keystore/", // the module itself
  "src/components/wallet/LocalWalletPanel.tsx", // the one screen that holds a key
  "extension/smoke/", // the browser-bundle check, which must exercise the real thing
  /*
   * The approval window a website's request opens. It is the second screen that
   * holds a key, and it exists because the first one cannot do this job: a
   * password typed into a page served by a dApp is indistinguishable from a
   * phishing copy of that page, so the unlock form has to live on a
   * `chrome-extension://` origin. Signing for a dApp therefore has to happen
   * where the keys are, and that is here.
   *
   * What this widening does NOT do, and what keeps the claim it changes true:
   * the keystore is still unreachable from every Connect and Watch-only screen,
   * and still unreachable from anything a web page loads. `content/bridge.ts`
   * and `inpage/provider.ts` are the two files that run inside a website, and
   * neither is on this list — they relay bytes and hold nothing. The sentence
   * in README and in the spec (§2.1a) was updated in the same commit as this
   * line, which is the trade the gate's failure message asks for.
   */
  "extension/src/approve.tsx",
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

/**
 * Where an import specifier lands, decided by resolving it — not by what it
 * looks like.
 *
 * This used to be a pattern over the specifier's text, and a pattern over text
 * only knows the spellings its author thought of. Measured against it: a panel
 * one directory over importing `../keystore`, and one importing a module of the
 * keystore the pattern did not list, were both reported OK. Every relative
 * spelling of the same directory is a different string and the same folder;
 * resolving the specifier against the importing file collapses them all into
 * the one question that matters — is this path inside `src/lib/keystore`?
 *
 * Aliases come from `tsconfig.json` (`paths`, and `baseUrl` for bare paths like
 * `src/lib/keystore`), read rather than copied, so a new alias is covered the
 * day it is added. The comparison runs on real paths and ignores case: a
 * symlinked directory, or `../Keystore` on a case-insensitive disk, reaches the
 * same files under a name that is not `keystore`.
 */
const KEYSTORE = canonical(join(REPO, "src", "lib", "keystore"));

/** `tsconfig.json`'s module resolution, or a failure — never a silent default. */
function loadTsconfig() {
  const file = join(REPO, "tsconfig.json");
  if (!existsSync(file)) return { baseUrl: REPO, paths: [] };
  const text = readFileSync(file, "utf8");
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    try {
      // tsconfig is JSONC. Drop comments and trailing commas, outside strings.
      json = JSON.parse(
        text
          .replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str ?? "")
          .replace(/("(?:[^"\\]|\\.)*")|,(\s*[}\]])/g, (m, str, close) => str ?? close),
      );
    } catch (e) {
      // An alias this gate cannot read is an import it cannot resolve: fail, so
      // the gate does not go on reporting OK about a map it never saw.
      console.error(`Keystore boundary FAILED — cannot parse tsconfig.json: ${e.message}`);
      process.exit(1);
    }
  }
  const options = json.compilerOptions ?? {};
  const baseUrl = resolve(REPO, options.baseUrl ?? ".");
  return { baseUrl, paths: Object.entries(options.paths ?? {}) };
}

const TSCONFIG = loadTsconfig();

/**
 * The real path of what `p` names, trying the extensions the bundler tries.
 * A path that does not exist is compared as written: it cannot build, and
 * comparing it lexically still catches a typo'd spelling of the keystore.
 */
function canonical(p) {
  for (const c of [p, `${p}.ts`, `${p}.tsx`, `${p}.js`, `${p}.mjs`]) {
    if (existsSync(c)) return realpathSync(c);
  }
  return resolve(p);
}

/** Every path a specifier written in `fromFile` can resolve to. */
function candidates(spec, fromFile) {
  // `…/vault?raw` is still the vault. Not from the first character: a leading
  // `#` is a subpath-import alias, not a fragment.
  const s = spec.replace(/(.)[?#].*$/, "$1");
  if (s === "." || s === ".." || s.startsWith("./") || s.startsWith("../")) return [resolve(dirname(fromFile), s)];
  if (isAbsolute(s)) return [s];
  const out = [];
  for (const [pattern, targets] of TSCONFIG.paths) {
    const star = pattern.indexOf("*");
    const head = star < 0 ? pattern : pattern.slice(0, star);
    const tail = star < 0 ? "" : pattern.slice(star + 1);
    const hit = star < 0 ? s === pattern : s.startsWith(head) && s.endsWith(tail) && s.length >= head.length + tail.length;
    if (!hit) continue;
    const middle = star < 0 ? "" : s.slice(head.length, s.length - tail.length);
    for (const t of targets) out.push(resolve(TSCONFIG.baseUrl, t.replace("*", middle)));
  }
  // `baseUrl` makes every bare path a path from that directory as well.
  out.push(resolve(TSCONFIG.baseUrl, s));
  return out;
}

const inside = (p, dir) => {
  const a = p.toLowerCase();
  const b = dir.toLowerCase();
  return a === b || a.startsWith(b + sep);
};
const reachesKeystore = (spec, fromFile) => candidates(spec, fromFile).some((c) => inside(canonical(c), KEYSTORE));

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
      if (!reachesKeystore(spec, file)) continue;
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
