/**
 * Outbound-URL guard (Wallet#9).
 *
 * This repo is public, and the URLs it ships are a phishing surface: the
 * Midnight redemption portal, the wallet install link, the curated dApp
 * allow-list, the indexer base URLs. A homoglyph swap — `redeem.midnlght.gd`
 * for `redeem.midnight.gd` — is a one-character diff that no reviewer catches
 * by accident, and the wallet's own brand would vouch for the fake.
 *
 * CODEOWNERS makes changes to those files require a maintainer review. But that
 * only helps for files somebody remembered to list. This check closes the other
 * half: an absolute URL may appear ONLY in a file CODEOWNERS already gates.
 *
 * The allow-list is READ FROM CODEOWNERS rather than repeated here, so the two
 * cannot drift apart. Adding a URL to a new file fails CI until that file is
 * gated — and gating it is what pulls in the review.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
/**
 * Directories that ship code. `src` was the only one when this guard was
 * written, and that was the flaw: the extension arrived later as a NEW
 * top-level directory whose `manifest.json` holds the `host_permissions` list —
 * the single setting that decides which hosts the wallet may talk to — and the
 * guard walked straight past it. Measured: swapping a Koios host for a
 * look-alike in `extension/manifest.json` and adding an unrelated host left this
 * check reporting OK.
 *
 * `assertNoUnscannedSourceRoot()` below is what stops that happening again. A
 * hand-maintained list drifts; a list that fails CI when it falls behind does not.
 */
const SCAN_ROOTS = ["src", "extension", "scripts", "docs"];

/** Never source, or gated wholesale elsewhere. */
const NOT_SOURCE = new Set([".git", "node_modules", "dist-extension", ".claude", "_Agents", "locales", ".github"]);

/** Build output living inside a source root. Not written by hand, not shipped. */
const BUILD_OUTPUT = new Set(["extension/smoke/out"]);
const SOURCE_EXT = /\.(m|c)?[jt]sx?$|\.json$|\.html$|\.md$/;
const CODEOWNERS = join(REPO, ".github", "CODEOWNERS");

/**
 * An absolute URL with a plausible registrable host. Deliberately does NOT match
 * UI placeholders like `https://…/drep.jsonld`, whose "host" is an ellipsis —
 * those ship no destination and are not a phishing surface.
 */
const URL_RE = /https?:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+/gi;

/**
 * A URL whose host is not in the file — assembled at runtime instead.
 *
 * The check above only sees hosts written down. Measured against this guard on
 * 2026-09-08, two mutations were added to a source file and it still printed OK:
 * a scheme string concatenated with a host string, and a scheme in a template
 * literal with the host interpolated from a nearby constant. (Both are spelled
 * out in the tests rather than here, because writing either one in this file
 * would trip the rule it documents.)
 *
 * That is the whole guard defeated by a spacebar, and a gate that reports OK for
 * exactly what it exists to block is worse than no gate: the commit message
 * cites it as the constraint in force. Nothing in this repo has a reason to
 * build a scheme by concatenation, so both forms are refused outright — in
 * every scanned file, gated or not, because the point is that the host be
 * *visible* to the other checks, not merely reviewed.
 *
 * `https://…` (ellipsis) and `https://*` (a manifest match pattern) carry no
 * destination and are left alone.
 */
const ASSEMBLED = [
  // A string literal ending in a scheme separator, handed straight to `+` or
  // `.concat` — on the same line, or on the next one where a formatter wrapped
  // it. Anchoring on the separator rather than on the word "https" also catches
  // a scheme torn in half across two literals, which otherwise reads as two
  // harmless fragments. The joiner must be an operator: a comma after a scheme
  // is ordinary prose and ordinary arguments, and matching it flags both.
  [
    /:\/\/["'`][ \t]*(?:\r?\n[ \t]*)?(?:\+|\.concat\b)/,
    "a scheme string joined to something else",
  ],
  // The array form of the same thing: a scheme string as the first element,
  // on its way to `.join`. Requiring the opening bracket is what separates it
  // from a comma in a sentence.
  [/\[[ \t]*["'`][^"'`\n]*:\/\/["'`][ \t]*,/, "a scheme string as an array element"],
  // A template literal starting with a scheme, interpolating anywhere in the
  // host — putting the placeholder after a subdomain hides the registrable part
  // just as well as putting it first.
  [/`https?:\/\/[^`\n]*\$\{/, "a host interpolated into a template literal"],
  // The scheme without its separator, glued to it afterwards. Only `+` here,
  // never a comma: a bare protocol literal is an ordinary argument — this repo
  // passes several to a test helper — and matching commas would flag every one.
  [/["'`]https?:["'`][ \t]*\+/, "a scheme split across string literals"],
  // Protocol-relative. `//host/path` inherits https on a page served over https,
  // so it reaches the network exactly like an absolute URL while containing no
  // scheme for anything above to find.
  [/["'`]\/\/[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+\//i, "a protocol-relative URL"],
  // Slashes spelled as escape sequences.
  [/https?:(?:\\u002f|\\x2f){2}/i, "a scheme whose slashes are escape sequences"],
];

/** Repo-relative, POSIX-separated paths that CODEOWNERS assigns to someone. */
function gatedPaths() {
  const rules = [];
  for (const raw of readFileSync(CODEOWNERS, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [pattern] = line.split(/\s+/);
    if (!pattern) continue;
    rules.push(pattern.replace(/^\//, ""));
  }
  return rules;
}

function isGated(relPath, rules) {
  return rules.some((rule) =>
    rule.endsWith("/") ? relPath.startsWith(rule) : relPath === rule,
  );
}

function* walk(dir) {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    const rel = relative(REPO, full).split(sep).join("/");
    if (BUILD_OUTPUT.has(rel) || entry === "node_modules") continue;
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

/**
 * Fail when a top-level directory holds source we never look at. This is the
 * part that survives the next person adding a directory.
 */
function assertNoUnscannedSourceRoot() {
  const missed = [];
  for (const entry of readdirSync(REPO).sort()) {
    if (NOT_SOURCE.has(entry) || SCAN_ROOTS.includes(entry)) continue;
    const full = join(REPO, entry);
    if (!statSync(full).isDirectory()) continue;
    for (const file of walk(full)) {
      if (SOURCE_EXT.test(file)) { missed.push(entry); break; }
    }
  }
  if (missed.length) {
    console.error("Outbound-URL guard FAILED — source directories nobody scans:\n");
    for (const d of missed) console.error(`  • ${d}/`);
    console.error("\nAdd them to SCAN_ROOTS in this file, or to NOT_SOURCE if they ship nothing.");
    process.exit(1);
  }
}

assertNoUnscannedSourceRoot();

const rules = gatedPaths();
const offenders = [];

// Files sitting at the repo root are scanned by rule, not by a list: README.md is
// the most-read file in a public repo and carried the install link nobody gated.
const rootFiles = readdirSync(REPO)
  .sort()
  .map((entry) => join(REPO, entry))
  .filter((full) => !statSync(full).isDirectory() && SOURCE_EXT.test(full));

const assembled = [];

for (const file of [...rootFiles, ...SCAN_ROOTS.flatMap((root) => [...walk(join(REPO, root))])]) {
  const rel = relative(REPO, file).split(sep).join("/");
  const text = readFileSync(file, "utf8");

  // Two lines at a time, overlapping, rather than the whole file: enough to see
  // a concatenation that wrapped onto the next line, while still naming the line
  // the offending text is on. Whole-file matching finds the same things and can
  // only report "somewhere in this file".
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const window = lines[i] + "\n" + (lines[i + 1] ?? "");
    for (const [re, why] of ASSEMBLED) {
      if (re.test(window)) {
        assembled.push(`${rel}:${i + 1}  ${why}\n      ${lines[i].trim()}`);
        break;
      }
    }
  }

  const found = new Set(text.match(URL_RE) ?? []);
  if (found.size === 0) continue;
  if (isGated(rel, rules)) continue;
  offenders.push({ rel, urls: [...found] });
}

if (assembled.length) {
  console.error("Outbound-URL guard FAILED — URLs built at runtime, so no check can read the host:\n");
  for (const line of assembled) console.error(`  • ${line}`);
  console.error("\nWrite the full URL as one literal in a CODEOWNERS-gated file.");
  process.exit(1);
}

if (offenders.length) {
  console.error("Outbound-URL guard FAILED — absolute URLs in ungated files:\n");
  for (const { rel, urls } of offenders) {
    console.error(`  • ${rel}`);
    for (const u of urls) console.error(`      ${u}`);
  }
  console.error(
    "\nEither drop the URL, or add the file to .github/CODEOWNERS so changing" +
      "\nit requires a maintainer review.",
  );
  process.exit(1);
}

console.log(
  `Outbound-URL guard OK — every absolute URL at the repo root and under ${SCAN_ROOTS.map((r) => r + "/").join(", ")} sits in a CODEOWNERS-gated file, and none is assembled at runtime.`,
);
