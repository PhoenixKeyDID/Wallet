/**
 * Type-check a mutated tree in memory, before any test runs on it.
 *
 * Why: the grader in `classify-run.mjs` reads vitest's output, and a typo in a
 * mutant's `to` only shows there if nothing swallows the error it raises. Code
 * under test with a `catch` around the call — `approve.tsx` wraps
 * `summariseTx(…)` in one — turns `ReferenceError: sumariseTx is not defined`
 * into an ordinary "could not read this transaction" path, eleven tests fail on
 * assertions, and the run reads "caught". The compiler does not depend on the
 * error reaching the output: a name that does not exist is a diagnostic
 * whether or not something at run time would catch it.
 *
 * Only the files the mutant edits are checked, and only two kinds of
 * diagnostic count against it (`typo`): a syntax error — the file cannot run
 * as written — and a misspelt name (`isTypo` below). A mutant may change a
 * type on purpose (a removed guard stops narrowing, a wider value flows on)
 * and still be a fair test of a guard; every other diagnostic is handed back
 * as `other`, shown, not graded.
 *
 *   TS2304  Cannot find name 'x'.
 *   TS2552  Cannot find name 'x'. Did you mean 'y'?
 *   TS2305  Module '"m"' has no exported member 'x'.
 *   TS2724  '"m"' has no exported member named 'x'. Did you mean 'y'?
 *   TS2339  Property 'x' does not exist on type 'T'.      (only if 'x' is new)
 *   TS2551  Property 'x' does not exist on type 'T'. Did you mean 'y'?  (idem)
 *   TS2353  Object literal may only specify known properties, and 'x' does
 *           not exist in type 'T'.                         (idem)
 *   TS2561  Object literal may only specify known properties, but 'x' does
 *           not exist in type 'T'. Did you mean to write 'y'?  (idem)
 *
 * The program is built once from `tsconfig.json`; each check builds a new one
 * that reuses every unchanged source file, so the cost is the checker's work
 * on the edited files and what they reference, not a full `tsc`.
 *
 * Files outside the program (`scripts/*.mjs`, which `tsconfig.json` does not
 * include and `allowJs` is off for) are returned in `unchecked` — a mutant on
 * such a file has no compile-time net, and the caller says so.
 */
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

/** A name that is not in scope, or an import of a name the module does not export: always a typo. */
const NAME_CODES = new Set([2304, 2552, 2305, 2724]);
/** A property or object-literal key the type does not have: a typo only when the name is new to the file. */
const NEW_NAME_CODES = new Set([2339, 2551, 2353, 2561]);
export const TYPO_CODES = new Set([...NAME_CODES, ...NEW_NAME_CODES]);

/**
 * Whether one semantic diagnostic is a misspelling rather than a type change.
 *
 *   - "Cannot find name" is always one: the mutated text names something that
 *     is not in scope, and running it throws.
 *   - "Property does not exist" is one only when the property's name is new to
 *     the file. Removing a guard is the usual reason this fires on a fair
 *     mutant: `if (r.ok) return; r.refusal` stops narrowing, `refusal` exists
 *     on the other member of the union, and at run time the read is a defined
 *     path. Measured 2026-11-12 over the registered mutants: four guard
 *     removals read `info`, `refusal`, `toLowerCase`, `cborHex` this way, each
 *     already in the file; a misspelling makes a name the file never had.
 *     The same holds for an object-literal key the type does not declare.
 *   - "New to the file" is read from the file's code, not its text:
 *     `originalNames` is the set `namesInCode` builds from the syntax tree —
 *     identifiers and the quoted names of properties — so a word in a comment
 *     or a string does not count. Reading the whole text let `planned.ok` →
 *     `planned.of` pass as a fair mutant because a comment says "of".
 *
 * Exported for the test; `name` is the text the diagnostic points at.
 */
export function isTypo({ code, name }, originalNames) {
  if (NAME_CODES.has(code)) return true;
  if (!NEW_NAME_CODES.has(code) || name === null) return false;
  return !originalNames.has(name);
}

/**
 * Every name the code of `text` uses: identifiers (JSX attribute names
 * included) and string literals that name a property — a quoted key, a quoted
 * member in a type, `obj["x"]`. Comments, other string literals and template
 * text are left out.
 */
export function namesInCode(ts, text, fileName = "x.tsx") {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const names = new Set();
  const isPropertyName = (n) => {
    const p = n.parent;
    if (!p) return false;
    if (ts.isElementAccessExpression(p)) return p.argumentExpression === n;
    return "name" in p && p.name === n;
  };
  const visit = (n) => {
    if (ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) names.add(n.text);
    else if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && isPropertyName(n)) names.add(n.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return names;
}

export function createTypechecker(repo) {
  const ts = createRequire(join(repo, "package.json"))("typescript");
  const configPath = join(repo, "tsconfig.json");
  const cfg = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    },
  });
  const options = { ...cfg.options, noEmit: true };
  const roots = cfg.fileNames.map((f) => resolve(f));
  const inProgram = new Set(roots);

  let overrides = new Map();
  const base = ts.createCompilerHost(options, true);
  // Unchanged files are parsed once and handed back as the same object, which
  // is what lets each new program reuse them instead of parsing the tree again.
  const parsedOnce = new Map();
  const host = {
    ...base,
    readFile: (f) => (overrides.has(resolve(f)) ? overrides.get(resolve(f)) : base.readFile(f)),
    fileExists: (f) => overrides.has(resolve(f)) || base.fileExists(f),
    getSourceFile: (f, lang, onError, fresh) => {
      const abs = resolve(f);
      if (overrides.has(abs)) return ts.createSourceFile(f, overrides.get(abs), lang, true);
      if (!parsedOnce.has(abs)) parsedOnce.set(abs, base.getSourceFile(f, lang, onError, fresh));
      return parsedOnce.get(abs);
    },
  };

  let program = ts.createProgram(roots, options, host);

  const describe = (d) => {
    const msg = ts.flattenDiagnosticMessageText(d.messageText, "\n");
    if (!d.file || d.start === undefined) return `TS${d.code}: ${msg}`;
    const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
    return `${d.file.fileName.slice(repo.length + 1)}:${line + 1}:${character + 1} TS${d.code}: ${msg}`;
  };

  const diagnose = (rels) => {
    const typo = [];
    const other = [];
    const unchecked = [];
    for (const rel of rels) {
      const abs = resolve(repo, rel);
      if (!inProgram.has(abs)) {
        unchecked.push(rel);
        continue;
      }
      const sf = program.getSourceFile(abs);
      // Read from disk, which holds the unmutated text while a check runs.
      const original = namesInCode(ts, base.readFile(abs) ?? "", abs);
      for (const d of program.getSyntacticDiagnostics(sf)) typo.push({ code: d.code, name: null, text: describe(d) });
      for (const d of program.getSemanticDiagnostics(sf)) {
        const entry = { code: d.code, name: missingName(d), text: describe(d) };
        (isTypo(entry, original) ? typo : other).push(entry);
      }
    }
    return { typo, other, unchecked };
  };

  // The name a diagnostic is about is the source text it points at — for
  // TS2724 the message's first quoted string is the module path, not the name.
  // The quoted name in the message is the fallback for a diagnostic with no span.
  const missingName = (d) => {
    if (d.file && d.start !== undefined && d.length) {
      const span = d.file.text.slice(d.start, d.start + d.length).replace(/^#/, "");
      if (/^[\p{ID_Start}$_][\p{ID_Continue}$\u200c\u200d]*$/u.test(span)) return span;
    }
    const m = /'([^']+)'/.exec(ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    return m ? m[1] : null;
  };

  return {
    /** `namesInCode` with this checker's TypeScript, for the tests. */
    namesOf: (text) => namesInCode(ts, text),
    /** Diagnostics of the unmutated files, so a mutant is only charged with new ones. */
    baseline(rels) {
      overrides = new Map();
      program = ts.createProgram(roots, options, host, program);
      return diagnose(rels);
    },
    /** `next` maps repo-relative path → mutated text, as `mutants.mjs` builds it. */
    check(next) {
      overrides = new Map([...next].map(([rel, text]) => [resolve(repo, rel), text]));
      program = ts.createProgram(roots, options, host, program);
      const out = diagnose([...next.keys()]);
      overrides = new Map();
      return out;
    },
  };
}
