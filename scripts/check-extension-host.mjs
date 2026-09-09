/**
 * The extension is a host. Check that it acts like one.
 *
 * `docs/host-contract.json` names five aliases a host is expected to point at
 * its own implementations, and this repo ships a stand-in behind each so it
 * type-checks standing alone. The web app supplies all five. The extension
 * supplied none — `extension/vite.config.ts` declared a single catch-all — so
 * every one resolved back into a stand-in.
 *
 * Nothing failed. That is the whole problem: an import that lands on a stand-in
 * **succeeds**. `tsc` is happy, the build is happy, the suite is green, and the
 * person using the packaged wallet reads `delegate_submitted` after delegating
 * their stake — a message they cannot tell apart from a crash, arriving at the
 * moment they need to know whether their money moved.
 *
 * ## Why this reads the bundle and not the config
 *
 * A config check answers "was an alias declared". The question that matters is
 * "which module did the code actually reach", and those come apart in ways a
 * config reader cannot see: order (Vite tries aliases in sequence, so a
 * catch-all placed first swallows every specific entry after it), a typo in a
 * path that resolves somewhere else, a stand-in re-exported from the file the
 * alias points at. Measured: deleting the `@/lib/toast` line from the config
 * left the whole suite green and put the console logger back in the shipped
 * bundle.
 *
 * So each stand-in carries a marker string, and this gate asserts the marker is
 * absent from the built bundles. Absence of the stand-in is the property; a
 * declaration is only evidence for it.
 *
 * ## The third state
 *
 * A stand-in that has no marker cannot be measured. That is not the same as
 * "supplied", and it must not be reported as OK — a gate whose green means "I
 * could not look" is worse than no gate, because the green goes into a merge
 * decision. Unmeasurable entries are listed by name and the gate fails.
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = process.env.PHOENIX_DIST || join(REPO, "dist-extension");
const contract = JSON.parse(readFileSync(join(REPO, "docs", "host-contract.json"), "utf8"));

/**
 * A string that appears in the stand-in and in nothing else.
 *
 * Chosen from the stand-in's own code rather than added as a tag, so it cannot
 * drift out of sync with the file it identifies — if somebody rewrites the
 * stand-in past the marker, this gate says "cannot measure" rather than
 * quietly passing.
 */
const STANDIN_MARKER = {
  "@/lib/toast": "__phoenixToast",
};

/**
 * Aliases the extension is not expected to supply, each with the reason.
 *
 * An entry here is a decision somebody made in a diff a reviewer saw, which is
 * the difference between this list and silence. `Nav` and `Footer` are site
 * chrome: a 400px popup has no site to put chrome around. `CopyBtn` and
 * `api` are still on the stand-ins and that is a defect, recorded here so it
 * stays visible rather than being rediscovered.
 */
const NOT_SUPPLIED = {
  "@/components/Nav": "a popup has no site chrome to wrap",
  "@/components/Footer": "a popup has no site chrome to wrap",
  "@/components/CopyBtn": "still on the stand-in — its label is hard-coded English",
  "@/lib/api": "still on the stand-in — the extension makes no backend calls yet",
};

const problems = [];
const unmeasurable = [];

if (process.env.PHOENIX_DIST) {
  console.error(
    `⚠ PHOENIX_DIST is set: grading "${process.env.PHOENIX_DIST}" instead of dist-extension/. ` +
      `Every line below is about that, not about what a release would ship.`,
  );
}

if (!existsSync(DIST)) {
  console.error("No dist-extension/ — run `bun run build:extension` first.");
  process.exit(1);
}

/**
 * Refuse to grade a bundle older than the source it came from.
 *
 * This gate reads the BUILT files, so without this it answers about whatever
 * build happens to be lying around. Both directions are wrong, and the second
 * is the dangerous one:
 *
 *  - run it before `build:extension` and it reports a stand-in that the current
 *    source no longer uses — a false red, which teaches people to re-run gates;
 *  - break the alias order in `extension/vite.config.ts`, do NOT rebuild, and it
 *    reports OK on a bundle that predates the break — a false green on exactly
 *    the wiring this gate exists to prove.
 *
 * `check:package` grew the same guard in #32 for the same reason. `locales/` is
 * included because `extension/src/i18n.ts` imports the JSON, so a translation
 * edit changes the bundle just as a source edit does — and this gate DOES read
 * locale strings, unlike the package one.
 */
const newestUnder = (dir) => {
  if (!existsSync(dir)) return 0;
  let newest = 0;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const full = join(dir, entry);
    // `extension/smoke/out` is build output living under a source root — the
    // trap #32 documented. Counting it as source makes this gate refuse a
    // package that is not stale, right after `check:bundle` writes there.
    if (full === join(REPO, "extension", "smoke", "out")) continue;
    const st = statSync(full);
    newest = Math.max(newest, st.isDirectory() ? newestUnder(full) : st.mtimeMs);
  }
  return newest;
};

const bundles = readdirSync(DIST).filter((f) => f.endsWith(".js"));
if (bundles.length === 0) {
  console.error(
    "dist-extension/ holds no JavaScript, so no host wiring could be measured.\n" +
      "A build that failed part-way leaves a directory behind. Run `bun run build:extension`.",
  );
  process.exit(1);
}

// Only meaningful against the real output directory; `PHOENIX_DIST` points this
// gate at a fixture, which has no source to be newer than it.
if (!process.env.PHOENIX_DIST) {
  const builtAt = Math.max(
    ...bundles.map((f) => statSync(join(DIST, f)).mtimeMs),
  );
  const sourceAt = Math.max(
    newestUnder(join(REPO, "extension")),
    newestUnder(join(REPO, "src")),
    newestUnder(join(REPO, "locales")),
  );
  if (sourceAt > builtAt) {
    console.error(
      "dist-extension/ is older than the source it was built from — this check\n" +
        "would be grading a stale artifact, and a stale PASS here is a false green\n" +
        "about host wiring. Run `bun run build:extension` first.",
    );
    process.exit(1);
  }
}

const text = bundles.map((f) => readFileSync(join(DIST, f), "utf8")).join("\n");

for (const alias of Object.keys(contract.aliasesFromHost ?? {})) {
  if (alias in NOT_SUPPLIED) continue;
  const marker = STANDIN_MARKER[alias];
  if (!marker) {
    unmeasurable.push(alias);
    continue;
  }
  if (text.includes(marker)) {
    problems.push(
      `${alias} is still the stand-in in the shipped bundle — the marker "${marker}" is in it. ` +
        `Point the alias at this host's own implementation in extension/vite.config.ts, ` +
        `and put it BEFORE the catch-all "@" entry or it will be swallowed.`,
    );
  }
}

if (unmeasurable.length) {
  problems.push(
    `no marker is known for ${unmeasurable.join(", ")}, so whether the bundle uses the ` +
      `stand-in could not be measured. Add one to STANDIN_MARKER, or list the alias in ` +
      `NOT_SUPPLIED with a reason. Not measuring is not the same as passing.`,
  );
}

if (problems.length) {
  console.error("Extension host wiring FAILED:\n");
  for (const p of problems) console.error(`  • ${p}`);
  process.exit(1);
}

const supplied = Object.keys(contract.aliasesFromHost ?? {}).filter((a) => !(a in NOT_SUPPLIED));
console.log(
  `Extension host wiring OK — ${supplied.length} of ${Object.keys(contract.aliasesFromHost).length} ` +
    `host aliases supplied and measured in the built bundle (${supplied.join(", ")}); ` +
    `${Object.keys(NOT_SUPPLIED).length} deliberately on stand-ins, each with a reason in this file.`,
);
