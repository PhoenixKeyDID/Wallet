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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, existsSync } from "node:fs";
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

function runGate() {
  const r = spawnSync(process.execPath, [GATE], {
    cwd: REPO,
    encoding: "utf8",
    env: { ...process.env, PHOENIX_DIST: dir },
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
});

describe("check:package > a host must be reachable by code, not merely mentioned", () => {
  it("refuses a host_permission whose only backing is a comment", () => {
    // The attack that got through before: name a host in a sentence, add the
    // matching permission, and a whole-text search blesses it.
    const m = BASE_MANIFEST();
    m.host_permissions.push("https://evil.example/*");
    m.content_security_policy.extension_pages += " https://evil.example";
    stage({ manifest: m, receipt: [] });
    const { code, out } = runGate();
    expect(code).toBe(1);
    expect(out).toMatch(/evil\.example/);
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
  it("refuses a directory with no build receipt", () => {
    // Absence is not evidence of "no extra hosts" — it means this directory was
    // not produced by the build config, so the question cannot be answered. A
    // gate that answers it anyway is guessing in the reassuring direction.
    stage({ receipt: null });
    const { code, out } = runGate();
    expect(code).toBe(1);
    expect(out).toMatch(/chain-origins/);
  });
});
