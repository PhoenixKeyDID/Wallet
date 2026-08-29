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
const SCAN_ROOTS = ["src", "extension", "scripts"];

/** Never source, or gated wholesale elsewhere. */
const NOT_SOURCE = new Set([".git", "node_modules", "dist-extension", ".claude", "_Agents", "locales", ".github"]);

/** Build output living inside a source root. Not written by hand, not shipped. */
const BUILD_OUTPUT = new Set(["extension/smoke/out"]);
const SOURCE_EXT = /\.(m|c)?[jt]sx?$|\.json$|\.html$/;
const CODEOWNERS = join(REPO, ".github", "CODEOWNERS");

/**
 * An absolute URL with a plausible registrable host. Deliberately does NOT match
 * UI placeholders like `https://…/drep.jsonld`, whose "host" is an ellipsis —
 * those ship no destination and are not a phishing surface.
 */
const URL_RE = /https?:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+/gi;

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

for (const file of SCAN_ROOTS.flatMap((root) => [...walk(join(REPO, root))])) {
  const rel = relative(REPO, file).split(sep).join("/");
  const found = new Set(readFileSync(file, "utf8").match(URL_RE) ?? []);
  if (found.size === 0) continue;
  if (isGated(rel, rules)) continue;
  offenders.push({ rel, urls: [...found] });
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
  `Outbound-URL guard OK — every absolute URL under ${SCAN_ROOTS.map((r) => r + "/").join(", ")} sits in a CODEOWNERS-gated file.`,
);
