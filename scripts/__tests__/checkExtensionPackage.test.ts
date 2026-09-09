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
