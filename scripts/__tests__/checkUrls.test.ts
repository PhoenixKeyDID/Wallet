/**
 * The outbound-URL guard, checked by staging each input that once got past it.
 *
 * Every case below was measured printing OK against the guard as it stood
 * before these rules existed. Each one is staged alone, in an ungated file of a
 * throwaway tree, so a red result names its own cause.
 *
 * The inputs are written with placeholders — `«C»` for the colon, `«S»` for a
 * slash — and assembled when the test runs. This file sits under `scripts/`,
 * which the guard scans, and the assembled forms are refused in every file
 * whether gated or not: spelling them out here would fail the guard on the
 * real repo, which is the last case below.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "check-urls.mjs");

/** Turns a placeholder fixture into the text the guard will read. */
const src = (t: string) => t.replace(/«C»/g, ":").replace(/«S»/g, "/");
/** base64 of a placeholder fixture, computed here so no encoded URL sits in this file. */
const b64 = (t: string) => Buffer.from(src(t)).toString("base64");

/**
 * Runs the guard on a tree holding the four scan roots, a CODEOWNERS made of
 * `owners` lines, and `files` (repo-relative path → text).
 */
function check(files: Record<string, string>, owners: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "check-urls-"));
  try {
    for (const d of ["src", "extension", "scripts", "docs", ".github"]) mkdirSync(join(root, d), { recursive: true });
    writeFileSync(join(root, ".github", "CODEOWNERS"), owners.map((o) => `${o}  @owner`).join("\n") + "\n");
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    const r = spawnSync(process.execPath, [SCRIPT, root], { encoding: "utf8" });
    return { status: r.status, out: r.stdout + r.stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const UNGATED = "a URL in an ungated file";
const RUNTIME = "URLs built at runtime";
const reasonOf = (out: string) =>
  out.includes("absolute URLs in ungated files") ? UNGATED : out.includes(RUNTIME) ? RUNTIME : "OK";

describe("check:urls — controls", () => {
  it("passes a tree with no URL", () => {
    const r = check({ "src/a.ts": `export const a = "plain text";\n` });
    expect(r.out).toContain("Outbound-URL guard OK");
    expect(r.status).toBe(0);
  });

  it("passes an absolute URL in a gated file", () => {
    const r = check({ "src/a.ts": src(`export const a = "https«C»«S»«S»evil.example/x";\n`) }, ["/src/a.ts"]);
    expect(r.status).toBe(0);
  });

  it("fails the same URL in an ungated file", () => {
    const r = check({ "src/a.ts": src(`export const a = "https«C»«S»«S»evil.example/x";\n`) });
    expect(reasonOf(r.out)).toBe(UNGATED);
    expect(r.status).toBe(1);
  });

  it("does not read the catch-all owner line as gating every file", () => {
    const r = check({ "src/a.ts": src(`export const a = "https«C»«S»«S»evil.example/x";\n`) }, ["*"]);
    expect(reasonOf(r.out)).toBe(UNGATED);
    expect(r.status).toBe(1);
  });

  it("leaves the comment marker quoted in prose alone", () => {
    const r = check({ "src/a.ts": src("// a `«S»«S»` inside a string is not a comment\nexport const a = 1;\n") });
    expect(r.status).toBe(0);
  });

  it("leaves a data: URI whose payload names an XML namespace alone", () => {
    const svg = b64(`<svg xmlns="http«C»«S»«S»www.w3.org/2000/svg"></svg>`);
    const r = check({ "extension/a.ts": `export const icon = "data:image/svg+xml;base64,${svg}";\n` }, ["/extension/"]);
    expect(r.status).toBe(0);
  });
});

describe("check:urls — inputs that used to print OK", () => {
  const cases: [string, string, string][] = [
    ["a scheme with no slashes", `export const u = "https«C»evil.example";`, UNGATED],
    ["a scheme with one slash", `export const u = "https«C»«S»evil.example";`, UNGATED],
    ["a scheme with backslashes", `export const u = "https«C»\\\\\\\\evil.example";`, UNGATED],
    ["a secure WebSocket URL", `export const u = "wss«C»«S»«S»evil.example/socket";`, UNGATED],
    ["a plain WebSocket URL", `export const u = "ws«C»«S»«S»evil.example";`, UNGATED],
    ["a protocol-relative URL with no path", `export const u = "«S»«S»evil.example";`, RUNTIME],
    ["a protocol-relative URL with backslashes", `export const u = "\\\\\\\\evil.example";`, RUNTIME],
    ["an array joined on the separator", `export const u = ["https", "evil.example"].join("«C»«S»«S»");`, RUNTIME],
    ["an array joined on the slashes", `export const u = ["https«C»", "evil.example"].join("«S»«S»");`, RUNTIME],
    ["the separator held in a constant", `const SEP = \`«C»«S»«S»\`;\nexport const u = ["https", "evil.example"].join(SEP);`, RUNTIME],
    ["the separator torn into colon and slashes", `export const u = "https" + "«C»" + "«S»«S»evil.example";`, RUNTIME],
    ["the slashes appended to a protocol read elsewhere", `export const u = location.protocol + "«S»«S»evil.example";`, RUNTIME],
    ["the slashes and half a host appended, the rest after", `export const u = location.protocol + "«S»«S»evil" + ".example";`, RUNTIME],
    ["a WebSocket host interpolated into a template", `const h = "evil";\nexport const u = \`wss«C»«S»«S»\${h}.example\`;`, RUNTIME],
    ["a protocol-relative template with the host interpolated", `const h = "evil";\nexport const u = \`«S»«S»\${h}.example\`;`, RUNTIME],
    ["atob of a literal that decodes to a URL", `export const u = atob("${b64("https«C»«S»«S»evil.example/x")}");`, RUNTIME],
    ["a base64 constant decoded elsewhere", `const K = '${b64("https«C»«S»«S»evil.example")}';\nexport const u = atob(K);`, RUNTIME],
    ["base64 of a protocol-relative URL", `export const u = atob("${b64("«S»«S»evil.example")}");`, RUNTIME],
    ["base64url of a URL, via Buffer", `export const u = Buffer.from("${Buffer.from(src("https«C»«S»«S»evil.example/?a=>>")).toString("base64url")}", "base64url");`, RUNTIME],
  ];

  for (const [name, fixture, reason] of cases) {
    it(`refuses ${name}`, () => {
      const r = check({ "src/probe.ts": src(fixture) + "\n" });
      expect(reasonOf(r.out), r.out).toBe(reason);
      expect(r.status).toBe(1);
    });
  }

  it("refuses the runtime-assembled forms even in a gated file", () => {
    const r = check(
      { "src/probe.ts": src(`export const u = ["https", "evil.example"].join("«C»«S»«S»");\n`) },
      ["/src/"],
    );
    expect(reasonOf(r.out)).toBe(RUNTIME);
    expect(r.status).toBe(1);
  });
});

describe("check:urls — this repo", () => {
  it("passes", () => {
    const r = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
    expect(r.stdout + r.stderr).toContain("Outbound-URL guard OK");
    expect(r.status).toBe(0);
  });
});
