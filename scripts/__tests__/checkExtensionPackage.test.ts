/**
 * The package gate, checked by staging the attacks it exists to stop.
 *
 * Nothing guarded this file. Two mutations that disabled real rules in it —
 * turning the string-literal host scan into "the whole file counts", and
 * deleting the direction that compares the build against the manifest — both
 * left the suite at 508 green. A gate deciding which hosts a wallet may talk to
 * was the only thing checking itself.
 *
 * The gate reads a directory, so each case builds one: a minimal `dist-extension`
 * in a temp dir, differing from the passing case by exactly the thing under test.
 * That is the point — a case whose fixture differs in several ways cannot say
 * which one made it red.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  cpSync,
  utimesSync,
  statSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GATE = join(REPO, "scripts", "check-extension-package.mjs");

/** The manifest the repo ships, as the baseline every case starts from. */
const BASE_MANIFEST = () =>
  // The real file, not a copy written out here: a second manifest in a test is a
  // second thing to keep updated, and it would drift in the direction of still
  // passing — which is the drift nobody notices.
  JSON.parse(readFileSync(join(REPO, "extension", "manifest.json"), "utf8"));

let dir: string;

function stage(opts: {
  manifest?: unknown;
  /** Contents of `.chain-origins.json`; `null` omits the file entirely. */
  receipt?: unknown | null;
  /** Extra JavaScript appended to the popup bundle. */
  js?: string;
}) {
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify(opts.manifest ?? BASE_MANIFEST(), null, 2) + "\n",
  );
  if (opts.receipt !== null) {
    writeFileSync(join(dir, ".chain-origins.json"), JSON.stringify(opts.receipt ?? []) + "\n");
  }
  writeFileSync(join(dir, "popup.js"), `export const x = 1;\n${opts.js ?? ""}`);
}

/** Stages a backing source in `where` and returns its path. */
function backingSourceIn(where: string, body: string): string {
  const f = join(where, "fake-source.ts");
  writeFileSync(f, body);
  return f;
}

function runGate(backingSources?: string[]) {
  const r = spawnSync(process.execPath, [GATE], {
    cwd: REPO,
    encoding: "utf8",
    env: {
      ...process.env,
      PHOENIX_DIST: dir,
      ...(backingSources ? { PHOENIX_BACKING_SOURCES: backingSources.join(",") } : {}),
    },
  });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

/**
 * A built page, not the source one.
 *
 * `extension/popup.html` points at `/src/popup.tsx`, which the gate correctly
 * refuses — an absolute path leaves the package. Writing the post-build shape
 * here keeps each case self-contained: it does not require somebody to have run
 * a build first, and it cannot start passing or failing because of one.
 */
const BUILT_PAGE = (entry: string) =>
  `<!doctype html><html><head><meta charset="utf-8"></head><body>` +
  `<div id="root"></div><script type="module" src="./${entry}.js"></script></body></html>\n`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "phoenix-pkg-"));
  mkdirSync(dir, { recursive: true });
  for (const page of ["popup", "approve"]) {
    writeFileSync(join(dir, `${page}.html`), BUILT_PAGE(page));
  }
  for (const f of ["approve.js", "content.js", "inpage.js", "background.js"]) {
    writeFileSync(join(dir, f), "export const x = 1;\n");
  }
  cpSync(join(REPO, "extension", "icon128.png"), join(dir, "icon128.png"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("check:package > the default package passes", () => {
  it("accepts a build with no extra chain origins", () => {
    stage({ receipt: [] });
    expect(runGate().code).toBe(0);
  });

  it("says out loud that it is grading a directory that is not dist-extension/", () => {
    // Every case in this file sets PHOENIX_DIST, so every case triggers this
    // warning — and until this assertion existed, none of them looked at it.
    // The warning is not for whoever reaches for the variable on purpose; it is
    // for the variable left over in a shell, after which the gate prints a
    // confident OK about somewhere else. That is the third state: not "matches",
    // not "differs", but "measured something else".
    stage({ receipt: [] });
    expect(runGate().out).toMatch(/PHOENIX_DIST is set/);
  });

  it("refuses a directory older than the source it was built from", () => {
    // Staleness is the failure where every other rule in this gate is graded
    // against an artifact nobody is shipping. It had no case at all until the
    // PHOENIX_DIST seam made one possible in three lines.
    stage({ receipt: [] });
    const longAgo = new Date("2020-01-01T00:00:00Z");
    utimesSync(join(dir, "manifest.json"), longAgo, longAgo);
    const { code, out } = runGate();
    expect(code).toBe(1);
    expect(out).toMatch(/older than the source/);
  });
});

describe("check:package > the closing sentence says what was measured", () => {
  // Two earlier versions of this line were wrong in the same way: each asked one
  // question and inferred the other from its negation. Asserting the sentence
  // itself, because a line nobody reads for content is a line that drifts.

  it("calls every host reviewed when the receipt is empty", () => {
    stage({ receipt: [] });
    const { out } = runGate();
    expect(out).toMatch(/all named as URL literals in provider\.ts or chainEnv\.ts/);
    expect(out).not.toMatch(/reviewed only by whoever/);
  });

  it("does not call a host build-only when a source names it too", () => {
    // The ordinary build, and the case version two got wrong: the receipt lists
    // only origins the manifest did not already declare, and the vendor host is
    // named in chainEnv.ts — so a host holding both blessings was announced as
    // reviewed by nobody. A warning wrong in the ignorable direction teaches the
    // reader to skip the line it exists to make them read.
    const src = backingSourceIn(dir, `export const H = ["https://api.koios.rest"];\n`);
    const m = BASE_MANIFEST();
    m.host_permissions = ["https://api.koios.rest/*"];
    m.content_security_policy.extension_pages =
      "script-src 'self'; connect-src 'self' https://api.koios.rest; object-src 'none'";
    stage({ manifest: m, receipt: ["https://api.koios.rest"] });
    const { code, out } = runGate([src]);
    expect(code).toBe(0);
    expect(out).not.toMatch(/reviewed only by whoever/);
  });

  it("names the host nobody reviewed when there really is one", () => {
    const src = backingSourceIn(dir, `export const H = ["https://api.koios.rest"];\n`);
    const m = BASE_MANIFEST();
    m.host_permissions = ["https://api.koios.rest/*", "https://my-node.example/*"];
    m.content_security_policy.extension_pages =
      "script-src 'self'; connect-src 'self' https://api.koios.rest https://my-node.example; object-src 'none'";
    stage({ manifest: m, receipt: ["https://my-node.example"] });
    const { code, out } = runGate([src]);
    expect(code).toBe(0);
    expect(out).toMatch(/1 this build declared for itself and no source names \(my-node\.example\)/);
  });
});

describe("check:package > one reading of a host pattern, not three", () => {
  it("names the port as the reason, not a wildcard that is not there", () => {
    // A build pointed at a self-hosted endpoint on a non-default port produced
    // two contradictory sentences two lines apart: the pattern rejected for "a
    // wildcard scheme or host" — there was none — and `host_permissions` said
    // not to declare a host it declares verbatim. The strict regex dropped the
    // port; `new URL` kept it. A reader following those two sentences adds a
    // wildcard, which is the one change that would make things worse.
    const m = BASE_MANIFEST();
    m.host_permissions.push("https://my-node.example:8443/*");
    m.content_security_policy.extension_pages += " https://my-node.example:8443";
    stage({ manifest: m, receipt: ["https://my-node.example:8443"] });
    const { code, out } = runGate();
    expect(code).toBe(1);
    expect(out).toMatch(/no place for a port/);
    expect(out).not.toMatch(/wildcard scheme or host/);
    expect(out).not.toMatch(/host_permissions does not declare/);
  });

  it("does not blame a port for a colon that is not one", () => {
    // A colon shows up in three different mistakes and only one is a port.
    // `includes(":")` sent `https://[::1]/*` and `https://user:pass@host/*` away
    // with "point the endpoint at 443" — advice for a problem neither one has,
    // in a check whose whole subject is naming the real cause rather than the
    // nearest rule.
    const m = BASE_MANIFEST();
    m.host_permissions.push("https://[::1]/*");
    m.content_security_policy.extension_pages += " https://[::1]";
    stage({ manifest: m, receipt: [] });
    const { code, out } = runGate();
    expect(code).toBe(1);
    expect(out).toMatch(/is not a literal host/);
    expect(out).not.toMatch(/no place for a port/);
  });

  it("still refuses an actual wildcard, and says so", () => {
    // The direction that keeps the rule honest: renaming the reason must not
    // have cost the original one.
    const m = BASE_MANIFEST();
    m.host_permissions.push("https://*/*");
    m.content_security_policy.extension_pages += " https://*";
    stage({ manifest: m, receipt: [] });
    const { code, out } = runGate();
    expect(code).toBe(1);
    expect(out).toMatch(/wildcard scheme or host/);
  });

  it("refuses a host that is not literal, which the outer shape lets through", () => {
    // This check had no case of its own. The wildcard case above carries its
    // name but dies one pin earlier — `[^/*]+` already excludes `*` — so
    // deleting the literal-host rule left the whole suite green while the gate
    // accepted `a_b.example` and announced it as an ordinary host.
    const m = BASE_MANIFEST();
    m.host_permissions.push("https://a_b.example/*");
    m.content_security_policy.extension_pages += " https://a_b.example";
    stage({ manifest: m, receipt: ["https://a_b.example"] });
    const { code, out } = runGate();
    expect(code).toBe(1);
    expect(out).toMatch(/is not a literal host/);
    expect(out).not.toMatch(/does not declare/);
  });

  it("refuses a host carrying a character that folds into ASCII", () => {
    // `U+212A KELVIN SIGN` lowercases to `k` — the only codepoint above 127
    // that does, measured across the whole Unicode range. Testing the folded
    // string accepts `api.<U+212A>oios.rest` and reports it as `api.koios.rest`;
    // the strict regex it replaced refused it, because a regex `i` flag does not
    // fold non-ASCII into an ASCII range. Losing that is a look-alike host
    // passing the one file whose stated job is catching look-alike hosts.
    const kelvin = "https://api.Koios.rest/*";
    const m = BASE_MANIFEST();
    m.host_permissions.push(kelvin);
    m.content_security_policy.extension_pages += " https://api.Koios.rest";
    stage({ manifest: m, receipt: [] });
    const { code, out } = runGate();
    expect(code).toBe(1);
    expect(out).toMatch(/is not a literal host/);
  });

  it("names the scheme as the reason, and only once", () => {
    // A self-hosted node on loopback over plain HTTP is a configuration
    // `chainSource.ts` allows on purpose, so this arrives from a supported
    // setup rather than a mistake. Before the shared reading, it produced the
    // same pair of contradicting sentences the port case did — the "already
    // reported" set was rebuilt from a second regex that covered the port axis
    // and not the scheme axis.
    const m = BASE_MANIFEST();
    m.host_permissions.push("http://localhost/*");
    m.content_security_policy.extension_pages += " http://localhost";
    stage({ manifest: m, receipt: ["http://localhost"] });
    const { code, out } = runGate();
    expect(code).toBe(1);
    expect(out).toMatch(/only https is allowed/);
    expect(out).not.toMatch(/does not declare/);
    expect(out).not.toMatch(/wildcard scheme or host/);
  });
});

/**
 * One backing source used by both cases below, so they differ by exactly one
 * thing: which hosts the manifest declares. The four in string literals are the
 * ones the shipping manifest declares; the fifth is named only in prose.
 */
const SOURCE_WITH_A_HOST_IN_PROSE =
  `// See also the mirror at https://evil.example/api/v0\n` +
  `export const HOSTS = [\n` +
  `  "https://api.koios.rest",\n` +
  `  "https://preprod.koios.rest",\n` +
  `  "https://preview.koios.rest",\n` +
  `  "https://api.coingecko.com",\n` +
  `];\n`;

describe("check:package > a host must be reachable by code, not merely mentioned", () => {
  const backingSource = (body: string) => backingSourceIn(dir, body);

  /**
   * Written as whole literals, not assembled from a host variable: `check:urls`
   * refuses an interpolated host anywhere in the repo, and it is right to —
   * a URL built by concatenation is one nobody can grep for.
   */
  const widenedToEvilExample = () => {
    const m = BASE_MANIFEST();
    m.host_permissions.push("https://evil.example/*");
    m.content_security_policy.extension_pages += " https://evil.example";
    return m;
  };

  it("refuses a host_permission whose only backing is a comment", () => {
    // The attack, staged rather than described: the host really is present in a
    // backing source — in prose. A whole-file search blesses it; only a search
    // inside string literals asks the question that matters, which is whether
    // the code can hand this host to `fetch`.
    const src = backingSource(SOURCE_WITH_A_HOST_IN_PROSE);
    stage({ manifest: widenedToEvilExample(), receipt: [] });
    const { code, out } = runGate([src]);
    expect(code).toBe(1);
    expect(out).toMatch(/evil\.example/);
  });

  it("still accepts a host the same source reaches in a string", () => {
    // The other direction, and the one that decides whether the rule above
    // survives contact: a check that also rejects correct manifests is a check
    // somebody deletes. Same file, same run, only the quoting differs.
    const src = backingSource(SOURCE_WITH_A_HOST_IN_PROSE);
    stage({ manifest: BASE_MANIFEST(), receipt: [] });
    expect(runGate([src]).code).toBe(0);
  });
});

describe("check:package > the manifest cannot fall behind the build", () => {
  it("refuses a build that reads a chain host the manifest does not declare", () => {
    // What Chrome does here is block every chain read, and what the wallet then
    // says is that the endpoint gave no readable reply — which reads as the node
    // being down. The gate has to catch it, because the symptom does not.
    stage({ receipt: ["https://my-node.example"] });
    const { code, out } = runGate();
    expect(code).toBe(1);
    expect(out).toMatch(/my-node\.example/);
  });

  it("refuses the project-id-only build, where no URL is inlined at all", () => {
    // The case a text search of the bundle cannot see: given only a project id,
    // the base comes from `chainEnv.ts`, so nothing resembling a URL is compiled
    // in — while the package really does call that vendor host.
    stage({ receipt: ["https://cardano-preprod.blockfrost.io"] });
    expect(runGate().code).toBe(1);
  });

  it("accepts the same build once the manifest declares it", () => {
    const m = BASE_MANIFEST();
    m.host_permissions.push("https://my-node.example/*");
    m.content_security_policy.extension_pages += " https://my-node.example";
    stage({ manifest: m, receipt: ["https://my-node.example"] });
    expect(runGate().code).toBe(0);
  });
});

describe("check:package > an unmeasurable package is refused, not waved through", () => {
  it("counts a locale edit as source, because locales are compiled in", () => {
    // `extension/src/i18n.ts` imports the JSON, so a translation change alters
    // the bundle exactly as a code change does. The staleness rule scanned
    // `extension/` and `src/` only, so a package built before a locale edit was
    // graded as current — and until this case existed, deleting `locales/` from
    // that list left the whole suite green.
    stage({ receipt: [] });
    const soon = new Date(Date.now() + 60_000);
    const locale = join(REPO, "locales", "en", "wallet.json");
    const before = statSync(locale);
    try {
      utimesSync(locale, soon, soon);
      const { code, out } = runGate();
      expect(code).toBe(1);
      expect(out).toMatch(/older than the source/);
    } finally {
      // Restored whatever the assertion did — a case that leaves a repo file
      // with a future mtime makes every later run of this gate red.
      utimesSync(locale, before.atime, before.mtime);
    }
  });

  it("refuses a receipt that is not a list, rather than throwing over it", () => {
    // `for…of` on an object throws `TypeError` with a stack trace, about a file
    // whose whole job is to be read by this check. The shape rule was there;
    // nothing measured it.
    stage({ receipt: { a: 1 } });
    const { code, out } = runGate();
    expect(code).toBe(1);
    expect(out).toMatch(/must hold an array/);
    expect(out).not.toMatch(/TypeError/);
  });

  it("refuses a manifest whose CSP and host_permissions disagree", () => {
    // The cross-check that catches a build widening one list and not the other.
    // It predates this work and nothing exercised it — which matters more now,
    // because the build writes both lists and a mismatch between the two
    // expressions that write them would land exactly here.
    const m = BASE_MANIFEST();
    m.host_permissions.push("https://my-node.example/*");
    stage({ manifest: m, receipt: ["https://my-node.example"] });
    const { code, out } = runGate();
    expect(code).toBe(1);
    expect(out).toMatch(/connect-src/);
  });

  it("refuses a directory a failed build left behind, and says so", () => {
    // Reached on an ordinary path, not a strange one: the build throws after
    // Vite has emptied the output and written the bundle — a chain endpoint
    // carrying a port or a plain-HTTP scheme does exactly that — so the
    // directory holds fresh code and no manifest. Without this, `statSync` on a
    // file that is not there answered with `ENOENT` and an absolute path out of
    // the build machine, about a situation this gate already has words for.
    stage({ receipt: [] });
    rmSync(join(dir, "manifest.json"));
    const { code, out } = runGate();
    expect(code).toBe(1);
    expect(out).toMatch(/not produced by a completed build/);
    expect(out).not.toMatch(/ENOENT/);
  });

  it("refuses a directory with no build receipt, and says what to do", () => {
    // Absence is not evidence of "no extra hosts" — it means this directory was
    // not produced by the build config, so the question cannot be answered. A
    // gate that answers it anyway is guessing in the reassuring direction.
    //
    // Asserting the sentence, not just the exit code, because the exit code
    // alone cannot tell the check apart from its own absence: with the existence
    // check removed the read throws `ENOENT` and the gate is still red — at the
    // next pin down, with the message now carrying an absolute path out of the
    // build machine. Measured; the earlier version of this case stayed green
    // through exactly that mutation.
    stage({ receipt: null });
    const { code, out } = runGate();
    expect(code).toBe(1);
    expect(out).toMatch(/cannot be determined/);
    expect(out).toMatch(/rebuild with/);
    expect(out).not.toMatch(/ENOENT/);
  });
});

/**
 * A malformed manifest is reported, never a stack trace.
 *
 * The block was called *"…at every depth"* for one round, and that name was
 * measurably false while it was there: `background.service_worker` is a scalar
 * at depth one and still killed the gate. A coverage claim in a block name ages
 * badly in the one direction that matters — it reads as a guarantee, so the next
 * person adding a manifest field has been told they need not think about it.
 *
 * So the name states the property, and the coverage is stated here, where it can
 * be kept honest. Cases exist for: a list field given a string; a list given a
 * non-list; a string entry inside `host_permissions`; a `null` inside
 * `content_scripts`; the scalar path fields `action.default_popup` and
 * `background.service_worker`; and a non-path value inside `icons`.
 *
 * The root object is checked too, and by an exit rather than a finding: a
 * manifest that parses to `null` leaves nothing to report on.
 *
 * **What is not covered.** The other scalars the gate reads — `manifest_version`,
 * the CSP string, `content_scripts[].run_at`, `content_scripts[].all_frames` —
 * are compared or pattern-matched rather than joined onto a path, so a wrong
 * type there produces a wrong-looking finding rather than a crash.
 *
 * That list was itself wrong in both directions for one round, which is worth
 * leaving on the record: it named `version` and `name`, which this gate does not
 * read anywhere (they appear only in `ALLOWED_KEYS`), and it omitted
 * `all_frames`, which it does. A hand-written coverage note is a copy of
 * something the code knows, and it drifts the way copies drift — so treat it as
 * a reading aid, and the claim anything actually enforces is the block name.
 *
 * A rule added later that joins a new field onto `DIST` gets no protection from
 * any of this; the thing to copy is `stringAt`, not the shape of the rule next
 * to it.
 */
describe("check:package > a malformed manifest is reported, never a stack trace", () => {
  it("says which field is the wrong type instead of dying with a TypeError", () => {
    // `manifest.host_permissions ?? []` covers absence and nothing else, so a
    // hand-edit dropping the brackets reached `.map` and killed the gate with a
    // stack trace naming a line of the gate's own source. Same exit code as a
    // real finding, opposite meaning: the reader has been told the checker is
    // broken when what is broken is the package.
    const m = BASE_MANIFEST();
    m.host_permissions = "https://api.koios.rest/*";
    stage({ manifest: m });
    const { code, out } = runGate();
    expect(code).toBe(1);
    expect(out).toMatch(/host_permissions is string, not a list/);
    expect(out).not.toMatch(/TypeError/);
    expect(out).not.toMatch(/check-extension-package\.mjs:\d+/);
  });

  it("keeps reporting the rest of the package after one field is unreadable", () => {
    // The reason it is a finding rather than an exit: a run that stops at the
    // first malformed field hands back one problem at a time, and the person
    // fixing them learns the shape of the package one round trip per defect.
    const m = BASE_MANIFEST();
    m.permissions = "storage";
    // A second, entirely separate defect: a top-level key the allow-list has
    // never been taught about.
    m.devtools_page = "devtools.html";
    stage({ manifest: m });
    const { code, out } = runGate();
    expect(code).toBe(1);
    expect(out).toMatch(/permissions is string, not a list/);
    // A second, unrelated complaint in the same run.
    expect(out.split("\n").filter((l) => l.trim().startsWith("•")).length).toBeGreaterThan(1);
  });

  it("says so for a list nested inside content_scripts, not only a top-level one", () => {
    // The first version of this rule wrapped the top-level fields and stopped
    // there, which left the identical crash live a few lines further down. Both
    // cases above pass with the nested reads unguarded, so neither of them is
    // watching this: the two live at different depths in the same file, and a
    // fix scoped to where a defect was first noticed is a fix that leaves the
    // cause in place.
    const m = BASE_MANIFEST();
    m.content_scripts[0].matches = 5;
    stage({ manifest: m });
    const { code, out } = runGate();
    expect(code).toBe(1);
    expect(out).toMatch(/content_scripts\[\]\.matches is number, not a list/);
    expect(out).not.toMatch(/TypeError/);
    expect(out).not.toMatch(/check-extension-package\.mjs:\d+/);
  });

  it("refuses a string where a list of files belongs, instead of reading it letter by letter", () => {
    // The quiet half of the same defect, and the worse half. A string is
    // iterable, so `for (const f of cs.js)` walked `"content.js"` one character
    // at a time and the gate reported, with a straight face, that the manifest
    // names files called `c`, `o`, `n`. Every real rule about `js` was skipped
    // in the same breath, and the exit code was 1 either way — so the run looked
    // like a gate doing its job while it was grading nothing.
    const m = BASE_MANIFEST();
    m.content_scripts[0].js = "content.js";
    stage({ manifest: m });
    const { code, out } = runGate();
    expect(code).toBe(1);
    expect(out).toMatch(/content_scripts\[\]\.js is string, not a list/);
    // The letter-by-letter reading, named so the case fails if it comes back.
    expect(out).not.toMatch(/names "c"/);
    expect(out).not.toMatch(/names "o"/);
  });

  it("refuses an icons field that is not a name-to-path map", () => {
    // `Object.values` on a string is the same trap one type over: it hands back
    // characters, and the gate goes looking for files named `i`, `c`, `o`.
    // `icons` is a map rather than a list, so it needs its own door — bending it
    // through the list reader would accept `["icon.png"]`, which Chrome does not.
    const m = BASE_MANIFEST();
    m.icons = "icon.png";
    stage({ manifest: m });
    const { code, out } = runGate();
    expect(code).toBe(1);
    expect(out).toMatch(/icons is string, not a name-to-path map/);
    expect(out).not.toMatch(/names "i"/);
  });

  it("says so for the resource list nested inside web_accessible_resources", () => {
    // Named separately rather than folded into the content_scripts case because
    // they are two different call sites, and a case that covers one while
    // claiming both is how the other gets missed.
    const m = BASE_MANIFEST();
    m.web_accessible_resources[0].resources = "inpage.js";
    stage({ manifest: m });
    const { code, out } = runGate();
    expect(code).toBe(1);
    expect(out).toMatch(/web_accessible_resources\[\]\.resources is string, not a list/);
    expect(out).not.toMatch(/TypeError/);
  });

  it("says so for the match list nested inside web_accessible_resources", () => {
    // The fifth nested read, and the one the first four cases did not watch:
    // with the four above written and passing, putting this read back to
    // `?? []` left all thirty of them green. Measured, and it is the reason this
    // case exists — a sweep that stops at the defects somebody happened to name
    // leaves the last one behind, looking exactly like the ones that were fixed.
    //
    // This field decides which pages may reach the provider script, so the read
    // that goes unguarded here is the read that governs reach.
    const m = BASE_MANIFEST();
    m.web_accessible_resources[0].matches = "https://*/*";
    stage({ manifest: m });
    const { code, out } = runGate();
    expect(code).toBe(1);
    expect(out).toMatch(/web_accessible_resources\[\]\.matches is string, not a list/);
    // Character-by-character again: without the guard the gate complains that
    // the resources are exposed to "h", then "t", then "t".
    expect(out).not.toMatch(/exposed to "h"/);
  });

  it("says so for an entry inside a well-formed list, not only for the list", () => {
    // Guarding the containers was still a fix scoped to where the symptom was
    // noticed. `["https://…", 123]` is a list, so it walks straight through the
    // container check and dies one level down on `p.replace` — same crash, same
    // line-of-our-own-source, one nesting level deeper. The container was never
    // the whole question.
    const m = BASE_MANIFEST();
    m.host_permissions = [...m.host_permissions, 123];
    stage({ manifest: m });
    const { code, out } = runGate();
    expect(code).toBe(1);
    expect(out).toMatch(/host_permissions contains number, not a string/);
    expect(out).not.toMatch(/TypeError/);
    expect(out).not.toMatch(/check-extension-package\.mjs:\d+/);
  });

  it("says so for a null sitting in a list of objects", () => {
    // `[null]` passes every check about the list. The rules then read `.matches`
    // off it and the gate dies. Null rather than a number because it is the
    // shape a hand-edit leaves behind — a deleted entry, comma still in place.
    const m = BASE_MANIFEST();
    m.content_scripts = [null];
    stage({ manifest: m });
    const { code, out } = runGate();
    expect(code).toBe(1);
    expect(out).toMatch(/content_scripts contains null, not an object/);
    expect(out).not.toMatch(/TypeError/);
  });

  it("says so for a path field that is not a path", () => {
    // `join(DIST, 5)` throws `ERR_INVALID_ARG_TYPE`, which is the same failure
    // wearing a different error name — and `default_popup` is the single field
    // that decides whether the extension opens at all, so this is the manifest
    // edit most worth reporting clearly.
    const m = BASE_MANIFEST();
    m.action.default_popup = 5;
    stage({ manifest: m });
    const { code, out } = runGate();
    expect(code).toBe(1);
    expect(out).toMatch(/action\.default_popup is number, not a string/);
    expect(out).not.toMatch(/ERR_INVALID_ARG_TYPE/);
    expect(out).not.toMatch(/check-extension-package\.mjs:\d+/);
  });

  it("says so for an icon whose path is not a path", () => {
    // The map is the right shape and one value in it is not. Reported by name,
    // so the reader is told which icon rather than which line of this gate.
    const m = BASE_MANIFEST();
    m.icons = { ...(m.icons ?? {}), "16": 16 };
    stage({ manifest: m });
    const { code, out } = runGate();
    expect(code).toBe(1);
    expect(out).toMatch(/icons\["16"\] is number, not a path/);
    expect(out).not.toMatch(/ERR_INVALID_ARG_TYPE/);
  });

  it("says so for a service worker that is not a path", () => {
    // The last field in the file still going straight into `join(DIST, …)`. It
    // survived a round of fixing the same defect elsewhere because the fix was
    // scoped to where the crash had been *noticed*: containers, then elements,
    // then one scalar — and this one sat 162 lines below the others.
    const m = BASE_MANIFEST();
    m.background = { service_worker: 5 };
    stage({ manifest: m });
    const { code, out } = runGate();
    expect(code).toBe(1);
    expect(out).toMatch(/background\.service_worker is number, not a string/);
    expect(out).not.toMatch(/ERR_INVALID_ARG_TYPE/);
    expect(out).not.toMatch(/check-extension-package\.mjs:\d+/);
  });

  it("still reports a widened permission when another field is unreadable", () => {
    // Why a crash is worse than a wrong message, stated as a measurement rather
    // than an argument. The findings are printed at the end; a crash happens
    // before that block runs, so *nothing* is printed — and a manifest that both
    // widens `host_permissions` and holds one bad type reported neither. The
    // widening is the finding this gate exists for, and the type error is the
    // cheapest thing in the world to introduce by hand next to it.
    const m = BASE_MANIFEST();
    m.host_permissions = [...m.host_permissions, "https://*/*"];
    m.background = { service_worker: 5 };
    stage({ manifest: m });
    const { code, out } = runGate();
    expect(code).toBe(1);
    expect(out).toMatch(/background\.service_worker is number, not a string/);
    // The one that matters, and the one a crash used to swallow. Anchored on the
    // whole sentence, not the pattern: `https://*/*` is also the first entry of
    // `ALLOWED_MATCHES`, which the `content_scripts` finding interpolates in
    // full — so a bare match on the pattern goes green for a package that never
    // widened anything.
    expect(out).toMatch(/host_permissions declares "https:\/\/\*\/\*"/);
  });

  it("says a field is the wrong type without also saying it is missing", () => {
    // One cause, one sentence. Reading the field through `stringAt` and then
    // testing the result for falsiness merged two questions, because a wrong
    // type comes back `null` and an absent field comes back `""`. The report
    // then held both lines, and the second contradicts the first — the field IS
    // declared — so a reader acting on it adds a key that is already there.
    //
    // The `not` assertions are the whole point of the case: the suite was green
    // on both sides of this defect, because every case asserted that the right
    // sentence was present and none asserted the wrong one was absent.
    const m = BASE_MANIFEST();
    m.background = { service_worker: 5 };
    m.action.default_popup = 5;
    stage({ manifest: m });
    const { code, out } = runGate();
    expect(code).toBe(1);
    expect(out).toMatch(/background\.service_worker is number, not a string/);
    expect(out).toMatch(/action\.default_popup is number, not a string/);
    expect(out).not.toMatch(/declares no service_worker/);
    expect(out).not.toMatch(/declares no action\.default_popup/);
  });

  it("still says a field is missing when it is actually missing", () => {
    // The other direction, and the one that decides whether the fix is a fix
    // rather than a deletion: an empty `background` block really does declare no
    // service worker, and that sentence has to survive.
    const m = BASE_MANIFEST();
    m.background = {};
    delete m.action.default_popup;
    stage({ manifest: m });
    const { code, out } = runGate();
    expect(code).toBe(1);
    expect(out).toMatch(/background declares no service_worker/);
    expect(out).toMatch(/declares no action\.default_popup/);
  });

  it("calls an empty or null path missing, rather than calling the package fine", () => {
    // The direction a fix goes quiet in. Asking the raw value `=== undefined`
    // reads as the tighter test and is the looser one: `?? ""` collapses `null`
    // and `undefined` together, so `null` and `""` matched neither branch —
    // not wrong-typed, because `""` is a string, and not absent, because the key
    // is there. Measured, all four shapes below went from a finding to
    // `Extension package OK`, exit 0.
    //
    // A gate answering "fine" for a package with no popup and no service worker
    // is worse than one that crashes: a crash is read as broken, and this is
    // read as passed.
    for (const empty of [null, ""]) {
      const mp = BASE_MANIFEST();
      mp.action.default_popup = empty;
      stage({ manifest: mp });
      const p = runGate();
      expect(p.code, `default_popup=${JSON.stringify(empty)}`).toBe(1);
      expect(p.out, `default_popup=${JSON.stringify(empty)}`).toMatch(
        /declares no action\.default_popup/,
      );
      expect(p.out, `default_popup=${JSON.stringify(empty)}`).not.toMatch(
        /action\.default_popup is \w+.*, not a string/,
      );

      const mb = BASE_MANIFEST();
      mb.background = { service_worker: empty };
      stage({ manifest: mb });
      const b = runGate();
      expect(b.code, `service_worker=${JSON.stringify(empty)}`).toBe(1);
      expect(b.out, `service_worker=${JSON.stringify(empty)}`).toMatch(
        /background declares no service_worker/,
      );
      expect(b.out, `service_worker=${JSON.stringify(empty)}`).not.toMatch(
        /service_worker is \w+.*, not a string/,
      );
    }
  });

  it("names a wrong-typed container instead of blaming the field inside it", () => {
    // `"background": "background.js"` — a plausible hand-edit, and the shape
    // optional chaining hides best: `manifest.background?.service_worker` reads
    // a string exactly as quietly as it reads a missing key, so the gate
    // reported a missing field on a manifest whose problem is one level up.
    //
    // **All three containers, not just the one that was noticed.** `objectAt`
    // was written for `background` and wired to `background` alone, while
    // `action` sat three lines above it and `content_security_policy` directly
    // below — both still read with bare optional chaining. `"action":
    // "popup.html"` gave *"declares no action.default_popup"*, and a CSP string
    // gave two findings at once, both false: *"got: (none)"* for a policy
    // printed in full in the manifest, and *"has no connect-src"* under it.
    //
    // So this case iterates the containers rather than naming one. A test that
    // pins the instance that was noticed grows a gate no faster than the defect
    // moves.
    // Each container carries its own expected sentence rather than one built by
    // escaping the field name. The escaping version looked careful and did
    // nothing — its character class closed at the first `]`, so every name came
    // back unchanged. Harmless while the three names are plain words, and a
    // silently loosened assertion the day someone adds `content_scripts[0]`.
    const CONTAINERS: Array<{ field: string; wrongType: RegExp; downstream: RegExp }> = [
      {
        field: "background",
        wrongType: /manifest background is \w+.*, not an object/,
        downstream: /declares no service_worker/,
      },
      {
        field: "action",
        wrongType: /manifest action is \w+.*, not an object/,
        downstream: /declares no action\.default_popup/,
      },
      {
        field: "content_security_policy",
        wrongType: /manifest content_security_policy is \w+.*, not an object/,
        downstream: /got: \(none\)|has no `connect-src`/,
      },
    ];
    for (const { field, wrongType, downstream } of CONTAINERS) {
      for (const bad of [5, "a-string.js", [], null]) {
        const label = `${field}=${JSON.stringify(bad)}`;
        const m = BASE_MANIFEST();
        m[field] = bad;
        stage({ manifest: m });
        const { code, out } = runGate();
        expect(code, label).toBe(1);
        expect(out, label).toMatch(wrongType);
        // The sentence about the field inside it must not appear: that is the
        // whole defect, and asserting only the correct line leaves the suite
        // green on both sides of it.
        expect(out, label).not.toMatch(downstream);
      }
    }
  });

  it("still refuses a container that is missing outright, not only a wrong-typed one", () => {
    // The state the three-state `objectAt` was written for, and the one nothing
    // was watching. Measured: reverting `objectAt` to return `null` for absent —
    // the two-state version it replaced — left the whole suite at 604/604 and
    // all eight gates at exit 0, while a manifest with no `content_security_policy`
    // block and one with no `action` block both went from a finding to
    // `Extension package OK`.
    //
    // The cases above only ever *replace* a container with a wrong value. Absent
    // is a third thing, it is the commonest shape a bad edit leaves behind, and
    // for the CSP it removes the two rules that keep remote code out.
    // Each container names the sentence it must produce. Asserting only
    // `code === 1` and "not OK" was not enough and was measurably not enough: a
    // gate dying with a `TypeError` satisfies both, so a one-line tidy-up of the
    // nested conditional below — removing the `cspBlock === undefined` branch —
    // kept all 605 green while the gate crashed on a manifest with no CSP. The
    // block this case lives in is named "never a stack trace"; every other case
    // in it already refuses one, and this one had fewer constraints than its
    // neighbours with no line saying why.
    const ABSENT: Array<[string, RegExp]> = [
      ["action", /declares no action\.default_popup/],
      ["background", /but not background/],
      ["content_security_policy", /must be exactly `script-src 'self'`/],
    ];
    for (const [field, sentence] of ABSENT) {
      const m = BASE_MANIFEST();
      delete m[field];
      stage({ manifest: m });
      const { code, out } = runGate();
      expect(code, `absent ${field}`).toBe(1);
      expect(out, `absent ${field}`).toMatch(sentence);
      expect(out, `absent ${field}`).not.toMatch(/Extension package OK/);
      expect(out, `absent ${field}`).not.toMatch(/TypeError/);
      expect(out, `absent ${field}`).not.toMatch(/check-extension-package\.mjs:\d+/);
    }
  });

  it("keeps the CIP-30 path whole or absent, and says which half is missing", () => {
    // The rule this replaced required `background` and nothing else, because
    // `background` was the key under discussion. Measured, it was wrong in both
    // directions at once: it rejected a popup-only wallet that never wanted
    // CIP-30, and it passed three manifests that keep `background` and drop one
    // of the other two — which kill the dApp path just as completely, since
    // without `web_accessible_resources` no page can load `inpage.js` at all.
    const KEYS = ["background", "content_scripts", "web_accessible_resources"];
    for (const drop of KEYS) {
      const m = BASE_MANIFEST();
      delete m[drop];
      stage({ manifest: m });
      const { code, out } = runGate();
      expect(code, `dropped ${drop}`).toBe(1);
      expect(out, `dropped ${drop}`).toMatch(new RegExp(`but not[^\\n]*${drop}`));
    }

    // Present-but-empty, which is the same broken path wearing a declared key.
    // Measured: under a key-presence version of this rule, `"content_scripts":
    // []` and a missing `content_scripts` both exited 0 — the second level of
    // the same mistake the rule itself was written to stop making.
    for (const emptied of ["content_scripts", "web_accessible_resources"]) {
      const m = BASE_MANIFEST();
      m[emptied] = [];
      stage({ manifest: m });
      const { code, out } = runGate();
      expect(code, `empty ${emptied}`).toBe(1);
      expect(out, `empty ${emptied}`).toMatch(new RegExp(`but not[^\\n]*${emptied}`));
    }

    // `null` for a list is a wrong type, not an absence — the answer `objectAt`
    // gives for objects. While the two readers disagreed, these two exited 0,
    // and for these two keys that means a silently half-built CIP-30 path.
    for (const nulled of ["content_scripts", "web_accessible_resources", "permissions"]) {
      const m = BASE_MANIFEST();
      m[nulled] = null;
      stage({ manifest: m });
      const { code, out } = runGate();
      expect(code, `null ${nulled}`).toBe(1);
      expect(out, `null ${nulled}`).toMatch(new RegExp(`manifest ${nulled} is null, not a list`));
      expect(out, `null ${nulled}`).not.toMatch(/TypeError/);
    }

    // And the direction that keeps the rule honest: a wallet with none of the
    // three is a popup-only wallet, which is a real thing to ship.
    const m = BASE_MANIFEST();
    for (const k of KEYS) delete m[k];
    m.permissions = ["storage"];
    stage({ manifest: m });
    const { out } = runGate();
    expect(out).not.toMatch(/needs all three/);
  });

  it("refuses a CSP that allows a script from somewhere else", () => {
    // Property 3 of the four this gate claims at the top of the file — "no
    // remote code… an extension that can fetch a script is an extension whose
    // published source proves nothing" — and nothing was checking it. Replacing
    // the whole rule with `if (false)` left 605/605 green while the gate printed
    // "CSP allows no remote code" for a package that allows exactly that.
    const m = BASE_MANIFEST();
    m.content_security_policy.extension_pages =
      "script-src 'self' https://evil.example; connect-src 'self' https://api.koios.rest " +
      "https://preprod.koios.rest https://preview.koios.rest https://api.coingecko.com";
    stage({ manifest: m });
    const { code, out } = runGate();
    expect(code).toBe(1);
    expect(out).toMatch(/must be exactly `script-src 'self'`/);
    expect(out).not.toMatch(/Extension package OK/);
  });

  it("does not blame the manifest for a host the build reads when the list is unreadable", () => {
    // The second consumer of `hostPermissions`, and the one the first fix
    // missed. No case in this file stages a non-empty `.chain-origins.json`, so
    // this loop never ran under test and the gap was invisible — and the case
    // that pins the first consumer matches on that consumer's wording, which
    // this one does not share.
    const src = backingSourceIn(dir, `export const H = ["https://my-node.example"];\n`);
    const m = BASE_MANIFEST();
    m.host_permissions = 5;
    stage({ manifest: m, receipt: ["https://my-node.example"] });
    const { code, out } = runGate([src]);
    expect(code).toBe(1);
    expect(out).toMatch(/host_permissions is number, not a list/);
    expect(out).not.toMatch(/which host_permissions does not declare/);
  });

  it("calls an empty entry nothing, rather than comparing against it", () => {
    // `""` is the right type and still names nothing, so a type-only readable
    // flag let it rebuild the whole pile: four derived lines about hosts that
    // were fine, plus one printing the offending value as a blank space.
    const m = BASE_MANIFEST();
    m.host_permissions = [""];
    stage({ manifest: m });
    const { code, out } = runGate();
    expect(code).toBe(1);
    expect(out).toMatch(/host_permissions contains an empty string/);
    expect(out).not.toMatch(/which is not in host_permissions/);
  });

  it("does not derive findings from a list it has just called unreadable", () => {
    // The type finding for `host_permissions` says "every rule below about
    // host_permissions was skipped". That sentence was false: `stringsIn`
    // returns `[]`, an empty list is a valid answer, and the cross-check against
    // `connect-src` reasoned from it — so one cause printed five sentences, and
    // the four loudest ones pointed away from it at hosts that were fine.
    //
    // Both depths, because the first fix only covered the container: `[123]` is
    // a list, so the container reads fine, and the element does not. It printed
    // its element finding plus the same four derived lines — unchanged by the
    // fix that was supposed to have killed them. This file has already written
    // that lesson down twice about itself.
    const CASES: Array<[unknown, RegExp]> = [
      [5, /host_permissions is number, not a list/],
      [[123], /host_permissions contains number, not a string/],
      [[null], /host_permissions contains null, not a string/],
    ];
    for (const [value, own] of CASES) {
      const m = BASE_MANIFEST();
      m.host_permissions = value;
      stage({ manifest: m });
      const { code, out } = runGate();
      expect(code, JSON.stringify(value)).toBe(1);
      expect(out, JSON.stringify(value)).toMatch(own);
      expect(out, JSON.stringify(value)).not.toMatch(/which is not in host_permissions/);
    }
  });

  it("still compares against a list that is genuinely empty", () => {
    // The direction the fix above breaks if it is written one notch too tight,
    // and it was: a predicate reading "undefined or an array" excludes `null`,
    // which `asArray` accepts as an empty list without complaint. The gate then
    // had nothing to say about a manifest whose CSP reaches four hosts it holds
    // no permission for, and exited 0.
    //
    // An empty `host_permissions` really does disagree with a CSP naming hosts.
    // Suppressing a consequence is one edit away from suppressing the cause.
    for (const empty of [null, []]) {
      const m = BASE_MANIFEST();
      m.host_permissions = empty;
      stage({ manifest: m });
      const { code, out } = runGate();
      expect(code, JSON.stringify(empty)).toBe(1);
      expect(out, JSON.stringify(empty)).toMatch(/which is not in host_permissions/);
    }
  });

  it("reports a wrong-typed CSP string once, not as two claims about its contents", () => {
    // `"extension_pages": 5` printed `got: 5` and then `has no connect-src` — a
    // claim about the contents of something that has no contents. `[]` was
    // worse: `got:` followed by nothing, so the offending value appeared as
    // empty space.
    for (const bad of [5, [], {}, true, null]) {
      const m = BASE_MANIFEST();
      m.content_security_policy = { extension_pages: bad };
      stage({ manifest: m });
      const { code, out } = runGate();
      expect(code, JSON.stringify(bad)).toBe(1);
      expect(out, JSON.stringify(bad)).toMatch(
        /content_security_policy\.extension_pages is \w+.*, not a string/,
      );
      expect(out, JSON.stringify(bad)).not.toMatch(/has no `connect-src`/);
      expect(out, JSON.stringify(bad)).not.toMatch(/must be exactly/);
    }
  });

  it("refuses a manifest whose root is not an object, without a stack trace", () => {
    // `JSON.parse` succeeds on `null`, on `[]`, on `5`. None is a manifest, and
    // the first field read off one died naming a line of the gate's own source
    // — the exact shape this block is named after, sitting above every case in
    // it. `null` because that is what a build step writes from a variable
    // nothing assigned.
    for (const root of ["null", "[]", "5", '"manifest"']) {
      stage({});
      writeFileSync(join(dir, "manifest.json"), root);
      const { code, out } = runGate();
      expect(code, root).toBe(1);
      expect(out, root).toMatch(/root is (null|a list|number|string) rather than an object/);
      expect(out, root).not.toMatch(/Cannot read properties/);
      expect(out, root).not.toMatch(/check-extension-package\.mjs:\d+/);
    }
  });

  it("does not print a finding that reads as its own bug", () => {
    // `"manifest_version": "3"` is the commonest way to fail a `!==` comparison
    // against a number, and interpolated bare it printed `manifest_version is 3,
    // expected 3`. A reader shown that has been told the checker is broken —
    // the same wrong conclusion a stack trace produces, arrived at politely.
    const m = BASE_MANIFEST();
    m.manifest_version = "3";
    stage({ manifest: m });
    const { code, out } = runGate();
    expect(code).toBe(1);
    expect(out).toMatch(/manifest_version is "3", expected 3/);
  });

  it("names one bad host entry once, not once per rule that reads the list", () => {
    // Five separate rules read `host_permissions`, each re-reading it, so one
    // bad entry printed the same line five times. The report is what a reader
    // scans for the *other* findings; five copies of one line is how the rest
    // stop being read. Same failure mode as the crash above, by volume instead
    // of by absence.
    const m = BASE_MANIFEST();
    m.host_permissions = [...m.host_permissions, 123];
    stage({ manifest: m });
    const { out } = runGate();
    const hits = out
      .split("\n")
      .filter((l) => /host_permissions contains number/.test(l)).length;
    expect(hits).toBe(1);
  });
});

describe("check:package > the freshness check reads source, not build output", () => {
  it("does not call a package stale because the smoke test just ran", () => {
    // `extension/smoke/out` is written by `extension/smoke/run.mjs`. It sits
    // under `extension/`, so counting it made every check after a smoke run
    // refuse a package that was not stale — a red gate with no defect behind
    // it, on the ordinary path of running the checks in order. That is the
    // failure mode that teaches people to re-run a gate until it passes.
    const out = join(REPO, "extension", "smoke", "out");
    const marker = join(out, "freshness-probe.js");
    mkdirSync(out, { recursive: true });
    try {
      writeFileSync(marker, "// staged by a test\n");
      const soon = new Date(Date.now() + 60_000);
      utimesSync(marker, soon, soon);
      stage({});
      const { out: text } = runGate();
      expect(text).not.toMatch(/older than the source/);
    } finally {
      rmSync(marker, { force: true });
    }
  });

  it("still calls a package stale when real source is newer", () => {
    // The other pole. Without it the case above passes just as well against a
    // freshness check that was deleted outright.
    const probe = join(REPO, "extension", "manifest.json");
    const before = statSync(probe);
    try {
      const soon = new Date(Date.now() + 60_000);
      utimesSync(probe, soon, soon);
      stage({});
      const { code, out: text } = runGate();
      expect(code).toBe(1);
      expect(text).toMatch(/older than the source/);
    } finally {
      utimesSync(probe, before.atime, before.mtime);
    }
  });
});
