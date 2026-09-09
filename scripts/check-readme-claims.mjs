/**
 * The README makes two claims that go stale on their own, and have.
 *
 * **The test count.** It has read 98, 104, 130, 218, 241 at different times, each
 * correct when written and wrong a week later. A number nobody can trust is
 * worse than no number: a reader who spots one stale figure stops believing the
 * rest of the file, including the parts that matter (what the wallet does not
 * protect against).
 *
 * **The list of checks.** Every `check:*` script is a promise about what CI
 * enforces. `check:package` shipped, guarded the extension package, and went
 * unmentioned for a release — so a contributor reading the README would not know
 * to run it, and a reviewer would not know it existed.
 *
 * And "documented" is the weaker half of that promise. A gate that exists, is
 * written up in the README, and is never run by CI reads to every visitor as
 * enforcement while enforcing nothing — the strongest possible version of the
 * failure this file was written to prevent. It is not hypothetical here: CI
 * went for a release without ever running `build:extension`, so the package
 * users install was checked by nobody while the repo described a gate for it.
 * So each `check:*` must appear in **both** the README and the workflow.
 *
 * Both are mechanical facts. Nothing about them needs a human to remember.
 *
 * The count comes from `vitest list`, which collects without executing, so this
 * costs a collection pass rather than a second run of the suite.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const readme = readFileSync(join(REPO, "README.md"), "utf8");
const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
const problems = [];

// ─── the test count ───────────────────────────────────────────────────────────

const listed = execFileSync(
  process.execPath,
  [join(REPO, "node_modules/vitest/vitest.mjs"), "list"],
  { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
);
const actual = listed.split("\n").filter((l) => l.includes(" > ")).length;

const claim = readme.match(/bun run test\s+#\s*([\d,]+)\s+tests/);
if (!claim) {
  problems.push("README no longer states a test count next to `bun run test` — it is the line this check exists to keep honest");
} else {
  const claimed = Number(claim[1].replace(/,/g, ""));
  if (claimed !== actual) {
    problems.push(`README says ${claimed} tests, the suite collects ${actual}`);
  }
}

// ─── the list of checks ───────────────────────────────────────────────────────

for (const name of Object.keys(pkg.scripts ?? {})) {
  if (!name.startsWith("check:")) continue;
  if (!readme.includes(`bun run ${name}`)) {
    problems.push(`\`${name}\` is a CI gate that README never mentions — a gate nobody knows to run is a gate that only fails strangers`);
  }
}

// ─── and CI must actually run them ────────────────────────────────────────────

const workflow = readFileSync(join(REPO, ".github", "workflows", "ci.yml"), "utf8");
for (const name of Object.keys(pkg.scripts ?? {})) {
  if (!name.startsWith("check:")) continue;
  if (!workflow.includes(`bun run ${name}`)) {
    problems.push(
      `\`${name}\` is documented as a gate but .github/workflows/ci.yml never runs it — ` +
        `a gate CI skips is a claim of enforcement with no enforcement behind it`,
    );
  }
}

// Digits belong in a script name — `check:i18n-keys` is one. Without them the
// pattern stops at the `i`, and the gate reports that README names a script
// `check:i` which package.json does not define: a red line about a defect that
// is not there, pointing at a name nobody wrote. A gate that invents a finding
// is worse than one that misses it, because the person reading goes looking.
for (const [, name] of readme.matchAll(/bun run ([a-z][a-z0-9:-]*)/g)) {
  if (!(name in (pkg.scripts ?? {}))) {
    problems.push(`README tells the reader to run \`bun run ${name}\`, which package.json does not define`);
  }
}

if (problems.length) {
  console.error("README claims FAILED:");
  for (const p of problems) console.error("  • " + p);
  process.exit(1);
}

console.log(
  `README claims OK — ${actual} tests, and every check:* gate is both documented and run by CI`,
);
