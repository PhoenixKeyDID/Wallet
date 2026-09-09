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

describe("check:package > a malformed field is a finding, not a crash", () => {
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
