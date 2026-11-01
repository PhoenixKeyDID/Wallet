/**
 * Every utility class the popup renders must have a rule in `popup.css`.
 *
 * The wallet components are written against Tailwind (they also ship inside the
 * web app, which builds it). The extension has no Tailwind build, so
 * `extension/src/popup.css` carries a hand-typed copy of the classes it needs.
 * A hand-typed copy goes stale in one direction only — components gain classes,
 * the copy does not — and the staleness is invisible: an unknown class is not an
 * error in a browser, it is a missing style. Measured 2026-09-09: 160 classes
 * used, 93 with a rule. The visible result was a tab row that overflowed the
 * 400px popup, because `gap-1`, `overflow-x-auto` and `flex-1` did not exist.
 *
 * ## What is measured
 *
 * Start at the popup's entry file and follow every relative or `@/` import (the
 * same two spellings Vite resolves in `extension/vite.config.ts`). In each file
 * reached, collect the class tokens from
 *   - every `className` / `class` JSX attribute (all string and template pieces
 *     in its expression, so `cond ? "a" : "b"` and `` `x ${y}` `` both count);
 *   - every variable initialised with a string or template that a `className`
 *     expression names (the `btnCls` / `card` idiom the panels use — the name
 *     does not matter, the reference does).
 * Then compare against the classes `popup.css` defines.
 *
 * ## What is NOT measured, said out loud
 *
 * - A `className={someParameter}` whose value arrives from a caller cannot be
 *   read at that site (the caller's own literal is read at the caller). They are counted and printed, never silently
 *   dropped (the third state: "could not look" is not "fine").
 * - Classes assembled at runtime (`` `text-${tone}` ``) contribute their literal
 *   pieces only.
 * - The exemptions below, each with its reason, and the count of tokens they
 *   absorbed, so a growing exemption list is visible.
 *
 * Exit 1 when any used class has no rule. Exit 2 when the gate itself could not
 * run (entry missing, unreadable file).
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Tailwind breakpoint variants. The popup is 400px wide; the smallest
 * breakpoint (`sm`) starts at 640px, so none of these can ever apply here and
 * writing rules for them would be dead CSS that looks like coverage.
 */
const BREAKPOINT_VARIANT = /^(sm|md|lg|xl|2xl):/;

/**
 * Tokens that are class names with no declarations on purpose.
 * Each needs a reason; a bare entry is a hole in the gate.
 */
export const EXEMPT = new Map([
  ["group", "Tailwind marker class: it carries no style; only `group-hover:` variants read it"],
  ["peer", "Tailwind marker class: it carries no style; only `peer-*:` variants read it"],
]);

const EXTENSIONS = [".tsx", ".ts", "/index.tsx", "/index.ts"];

function resolveImport(spec, fromFile, root, aliases) {
  let base;
  const hit = aliases.find(([from]) => spec === from);
  if (hit) base = hit[1];
  else if (spec.startsWith("@/")) base = join(root, "src", spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec);
  else return null; // a package: not our source
  if (/\.(css|json|svg|png)$/.test(base)) return null;
  for (const ext of ["", ...EXTENSIONS]) {
    const p = base + ext;
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  return undefined; // looked like ours, but does not resolve
}

function textOf(node) {
  // every literal piece under `node`
  const out = [];
  const visit = (n) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push(n.text);
    else if (ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) out.push(n.text);
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

function hasLiteral(node) {
  return textOf(node).length > 0;
}

/** Identifiers read inside `node` (not property names, not JSX tag names). */
function identifiersIn(node) {
  const out = [];
  const visit = (n) => {
    if (ts.isIdentifier(n)) {
      const p = n.parent;
      const isPropName =
        (ts.isPropertyAccessExpression(p) && p.name === n) ||
        (ts.isPropertyAssignment(p) && p.name === n);
      if (!isPropName) out.push(n.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

/** Reads one source file: its imports, its class tokens, its unreadable className count. */
export function scanSource(file, source) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const imports = [];
  const pieces = [];
  let dynamic = 0;

  // Pass 1: every variable initialised with a string/template, by name. A class
  // list kept in a constant (`const card = "rounded-brand …"`) is read through
  // whichever name it has — the `*Cls` convention is followed in some files and
  // not in others, and a gate that depended on the naming would miss the others.
  const named = new Map();
  const collect = (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && hasLiteral(n.initializer)) {
      named.set(n.name.text, textOf(n.initializer));
    }
    ts.forEachChild(n, collect);
  };
  collect(sf);

  const visit = (n) => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      imports.push(n.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(n) &&
      n.moduleSpecifier &&
      ts.isStringLiteral(n.moduleSpecifier)
    ) {
      imports.push(n.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(n) &&
      n.expression.kind === ts.SyntaxKind.ImportKeyword &&
      n.arguments[0] &&
      ts.isStringLiteral(n.arguments[0])
    ) {
      imports.push(n.arguments[0].text);
    } else if (
      ts.isJsxAttribute(n) &&
      (n.name.getText(sf) === "className" || n.name.getText(sf) === "class") &&
      n.initializer
    ) {
      const got = textOf(n.initializer);
      pieces.push(...got);
      let resolved = got.length > 0;
      for (const id of identifiersIn(n.initializer)) {
        const via = named.get(id);
        if (via) {
          pieces.push(...via);
          resolved = true;
        }
      }
      // `className={prop}` where nothing in it resolves to a literal here
      // (a parameter handed down by the caller): unreadable at this site. The
      // caller's own `className="…"` is read where the caller is.
      if (!resolved && ts.isJsxExpression(n.initializer) && n.initializer.expression) dynamic += 1;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  const tokens = new Set();
  for (const p of pieces) for (const t of p.split(/\s+/)) if (t) tokens.add(t);
  return { imports, tokens, dynamic };
}

/** The class names that `css` has at least one selector for. */
export function definedClasses(css) {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = new Set();
  const prelude = /([^{}]+)\{/g;
  let m;
  while ((m = prelude.exec(stripped))) {
    const sel = m[1];
    if (sel.trim().startsWith("@")) continue;
    const cls = /\.((?:\\.|[A-Za-z0-9_-])+)/g;
    let c;
    while ((c = cls.exec(sel))) out.add(c[1].replace(/\\(.)/g, "$1"));
  }
  return out;
}

/**
 * @param {{entries: string[], css: string, root?: string, aliases?: [string,string][]}} o
 */
export function analyze({ entries, css, root = REPO, aliases = [] }) {
  const seen = new Set();
  const queue = [...entries];
  const used = new Map(); // token -> first file
  const problems = [];
  let dynamic = 0;
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    let source;
    try {
      source = readFileSync(file, "utf8");
    } catch (e) {
      problems.push(`cannot read ${file}: ${e.code ?? e.message}`);
      continue;
    }
    const r = scanSource(file, source);
    dynamic += r.dynamic;
    for (const t of r.tokens) if (!used.has(t)) used.set(t, file);
    for (const spec of r.imports) {
      const p = resolveImport(spec, file, root, aliases);
      if (p === undefined) problems.push(`${file}: import "${spec}" does not resolve`);
      else if (p) queue.push(p);
    }
  }
  const defined = definedClasses(readFileSync(css, "utf8"));
  const missing = [];
  const exempted = [];
  for (const [token, file] of [...used].sort()) {
    if (defined.has(token)) continue;
    if (EXEMPT.has(token) || BREAKPOINT_VARIANT.test(token)) {
      exempted.push(token);
      continue;
    }
    missing.push({ token, file });
  }
  return { files: seen.size, used: used.size, missing, exempted, dynamic, problems };
}

function main() {
  const entries = [join(REPO, "extension/src/popup.tsx")];
  const css = join(REPO, "extension/src/popup.css");
  const aliases = [["@/lib/toast", join(REPO, "extension/src/toast.ts")]];
  const r = analyze({ entries, css, aliases });
  if (r.problems.length) {
    console.error("popup CSS gate did NOT run to completion:");
    for (const p of r.problems) console.error(`  • ${p}`);
    process.exit(2);
  }
  console.log(
    `popup CSS: ${r.files} source files reached from the popup, ${r.used} class tokens, ` +
      `${r.exempted.length} exempt (breakpoint variants + markers), ` +
      `${r.dynamic} className expression(s) not readable from source`,
  );
  if (r.missing.length) {
    console.error(`\npopup CSS check FAILED — ${r.missing.length} class(es) used with no rule in popup.css:\n`);
    for (const { token, file } of r.missing) {
      console.error(`  • ${token}   (first seen in ${file.replace(REPO + "/", "")})`);
    }
    process.exit(1);
  }
  console.log("popup CSS OK — every class the popup renders has a rule.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
