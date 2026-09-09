/**
 * Every key the code asks for must exist.
 *
 * `check:locales` compares languages against each other. It never looks at the
 * code, so a key that is missing from **all four** languages is a key it grades
 * as fine. That is not a hypothetical: `delegate_submitted`, `withdraw_submitted`
 * and `gov_submitted` were each called on the success path of a money action —
 * stake delegation, reward withdrawal, a governance submission — and existed in
 * no locale file at all. Both hosts resolve an unknown key to the key itself, so
 * somebody who had just delegated their stake read the literal word
 * `delegate_submitted`. That is a message indistinguishable from a crash,
 * arriving at the exact moment a person needs to know whether their money moved.
 *
 * The gate that would have caught it does not compare two locale files. It
 * compares the code against one.
 *
 * ## What counts as a key, and why the list is short
 *
 * Only **string literals** are checked: `t("foo")`, `toastSuccess("foo")`. A key
 * assembled at runtime — `t(\`errors.${code}\`)`, `t(someVariable)` — cannot be
 * resolved by reading the source, and pretending otherwise would mean either
 * missing them silently or inventing a rule that guesses. Those are counted and
 * reported as a number, so the unmeasured part is visible rather than absent.
 *
 * Keys carrying a `.` are host content (`errors.generic` lives in the host's
 * `common` namespace — `src/lib/api.ts` builds it, `PhoenixKey-Frontend` and
 * `extension/src/hostStrings.ts` supply it). They are skipped here, because this
 * gate reads the module's own locale files and would otherwise fail on strings
 * it is not responsible for.
 *
 * ## Why this parses instead of matching text
 *
 * The first version of this file used a regular expression, and its very first
 * run reported a missing key at `extension/src/toast.ts:12` — a line of prose in
 * a doc comment that names `toastSuccess("delegate_submitted", …)` while
 * explaining this exact defect. A gate that goes red because somebody wrote down
 * why it exists is a gate that gets switched off.
 *
 * That is the same mistake, one axis over, as the one this repo had already paid
 * for in `src/lib/cardano/__tests__/noRedirect.test.ts`: a text scan cannot tell
 * a call from a sentence about a call. Comments and string contents are not call
 * expressions, so asking the parser makes the error inexpressible rather than
 * merely unlikely.
 */
import ts from "typescript";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const REFERENCE = "en";

/** Directories whose `t(...)` calls this gate is responsible for. */
const SCANNED = ["src", "extension"];

/** Files that are tests: they may reference keys on purpose to prove absence. */
const isTest = (p) => /(^|\/)__tests__(\/|$)/.test(p) || /\.test\.tsx?$/.test(p);

function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== "out") sourceFiles(full, out);
    } else if (/\.tsx?$/.test(entry.name) && !isTest(relative(REPO, full))) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Call sites that take an i18n key as their first argument.
 *
 * `toastError` is deliberately absent: it takes an already-translated sentence,
 * which is why it exists separately from `toastSuccess`.
 */
const CALLS = new Set(["t", "toastSuccess", "toastInfo", "toastApiError"]);

/** Does this call expression name one of the functions that take a key? */
function calleeName(node) {
  const e = node.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
}

/**
 * Every key argument in one file: `{ key, line }` for literals, and a count of
 * the calls whose first argument is built at runtime.
 */
function keysIn(text, fileName) {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const literals = [];
  let dynamic = 0;
  const walk = (node) => {
    if (ts.isCallExpression(node) && CALLS.has(calleeName(node) ?? "")) {
      const first = node.arguments[0];
      if (first && ts.isStringLiteralLike(first) && !ts.isTemplateExpression(first)) {
        const { line } = source.getLineAndCharacterOfPosition(first.getStart(source));
        literals.push({ key: first.text, line: line + 1 });
      } else if (first) {
        dynamic++;
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return { literals, dynamic };
}

const known = new Set();
const nsDir = join(REPO, "locales", REFERENCE);
for (const file of readdirSync(nsDir).filter((f) => f.endsWith(".json"))) {
  for (const key of Object.keys(JSON.parse(readFileSync(join(nsDir, file), "utf8")))) {
    known.add(key);
  }
}

const missing = [];
let dynamicCount = 0;

for (const dir of SCANNED) {
  const abs = join(REPO, dir);
  try {
    if (!statSync(abs).isDirectory()) continue;
  } catch {
    continue;
  }
  for (const file of sourceFiles(abs)) {
    const where = relative(REPO, file);
    const { literals, dynamic } = keysIn(readFileSync(file, "utf8"), file);
    for (const { key, line } of literals) {
      // Host content, and keys carrying a namespace prefix, are not ours.
      if (!key || key.includes(".") || key.includes(":")) continue;
      if (!known.has(key)) {
        missing.push(`${where}:${line} asks for "${key}", which is in no ${REFERENCE} locale file`);
      }
    }
    dynamicCount += dynamic;
  }
}

if (missing.length) {
  console.error("i18n key check FAILED:\n");
  for (const m of missing) console.error(`  • ${m}`);
  console.error(
    "\nA key with no string resolves to itself in both hosts, so the user reads the key.\n" +
      "Add it to every language in locales/, or stop calling it.",
  );
  process.exit(1);
}

console.log(
  `i18n keys OK — every literal key in ${SCANNED.join(" + ")} exists in ${REFERENCE}. ` +
    `${dynamicCount} call${dynamicCount === 1 ? "" : "s"} build the key at runtime and are not measured here.`,
);
