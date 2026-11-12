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
const src = (t: string) =>
  t
    .replace(/«C»/g, ":")
    .replace(/«S»/g, "/")
    .replace(/«(htt\w*)»/g, "$1")
    .replace(/«X74»/g, "\\x74")
    .replace(/«U003A»/g, "\\u003a");
/** base64 of a placeholder fixture, computed here so no encoded URL sits in this file. */
const b64 = (t: string) => Buffer.from(src(t)).toString("base64");

/**
 * Runs the guard on a tree holding the four scan roots, a CODEOWNERS made of
 * `owners` lines, and `files` (repo-relative path → text).
 */
function check(files: Record<string, string>, owners: string[] = [], rawOwnerLines: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "check-urls-"));
  try {
    for (const d of ["src", "extension", "scripts", "docs", ".github"]) mkdirSync(join(root, d), { recursive: true });
    writeFileSync(
      join(root, ".github", "CODEOWNERS"),
      [...owners.map((o) => `${o}  @owner`), ...rawOwnerLines].join("\n") + "\n",
    );
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

  it("leaves a template member access ending in ws alone", () => {
    const r = check({ "src/a.ts": src(`export const x = "{rows«C»data.length}";\n`) });
    expect(r.status).toBe(0);
  });

  it("leaves prose naming a usenet group alone", () => {
    const r = check({ "src/a.ts": src(`// see news«C»example.org for the archive\n`) });
    expect(r.status).toBe(0);
  });

  it("leaves a string taken apart on the two slashes alone", () => {
    const r = check({ "src/a.ts": src(`export const parts = url.split("«S»«S»");\n`) });
    expect(r.status).toBe(0);
  });

  it("leaves a list of bare protocol strings alone", () => {
    const r = check({ "src/a.ts": src(`for (const proto of ["http«C»", "file«C»", "blob«C»", "data«C»"]) {}\n`) });
    expect(r.status).toBe(0);
  });

  it("leaves an object key named ws alone", () => {
    const r = check({ "src/a.ts": src(`export const o = { ws«C»x };\nexport const p = {ws«C»socket};\n`) });
    expect(r.out, r.out).toContain("Outbound-URL guard OK");
    expect(r.status).toBe(0);
  });

  it("leaves a scheme word followed by a newline escape and a plain word alone", () => {
    const r = check({ "src/a.ts": src(`export const m = "only https«C»\\nnext line";\n`) });
    expect(r.out, r.out).toContain("Outbound-URL guard OK");
    expect(r.status).toBe(0);
  });

  it("passes a look-alike host in a gated file — gating is the review, not a verdict on the host", () => {
    const r = check({ "src/a.ts": src(`export const a = "https«C»«S»«S»p\u0430ypal.com/x";\n`) }, ["/src/a.ts"]);
    expect(r.status).toBe(0);
  });
});

describe("check:urls — CODEOWNERS lines that do not gate", () => {
  it("does not count a pattern with no owner, which removes ownership", () => {
    const r = check({ "src/a.ts": src(`export const a = "https«C»«S»«S»evil.example/x";\n`) }, ["*"], ["/src/a.ts"]);
    expect(reasonOf(r.out), r.out).toBe(UNGATED);
    expect(r.status).toBe(1);
  });

  it("names the catch-all line as not counting, instead of asking for a CODEOWNERS entry it already has", () => {
    const r = check({ "src/a.ts": src(`export const a = "https«C»«S»«S»evil.example/x";\n`) }, ["*"]);
    expect(r.out).toContain("the catch-all `*` line does not count");
    expect(r.out).not.toContain("so changing\nit requires a maintainer review");
  });
});

describe("check:urls — inputs that used to print OK", () => {
  // Computed rather than written: this file sits under `scripts/`, which the
  // guard scans, and the pieces joined below decode to a URL when read
  // together — writing them out would fail the guard on this repo.
  const tornB64 = (() => {
    const b = b64(`https«C»«S»«S»evil.example`);
    return `export const u = atob("${b.slice(0, 14)}" + "${b.slice(14)}");`;
  })();

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
    ["an array joined on the empty string", `export const u = ["https«C»", "evil.example"].join("");`, RUNTIME],
    ["the separator held in a constant", `const SEP = \`«C»«S»«S»\`;\nexport const u = ["https", "evil.example"].join(SEP);`, RUNTIME],
    ["the separator torn into colon and slashes", `export const u = "«https»" + "«C»" + "«S»«S»evil.example";`, RUNTIME],
    ["the slashes appended to a protocol read elsewhere", `export const u = location.protocol + "«S»«S»evil.example";`, RUNTIME],
    ["the slashes and half a host appended, the rest after", `export const u = location.protocol + "«S»«S»evil" + ".example";`, RUNTIME],
    ["a WebSocket host interpolated into a template", `const h = "evil";\nexport const u = \`wss«C»«S»«S»\${h}.example\`;`, RUNTIME],
    ["a host interpolated into a scheme-only template", `const h = "evil";\nexport const u = \`https«C»\${h}.example\`;`, RUNTIME],
    ["a protocol-relative template with the host interpolated", `const h = "evil";\nexport const u = \`«S»«S»\${h}.example\`;`, RUNTIME],
    ["a scheme concatenated with concat", `export const u = "https«C»".concat("evil.example");`, RUNTIME],
    ["an upper-case scheme split across literals", `export const u = "HTTPS«C»" + "evil.example";`, RUNTIME],
    ["a scheme cut after its third letter", `export const u = "«htt»" + "ps«C»«S»«S»evil.example/x";`, RUNTIME],
    ["a scheme cut after its fourth letter", `export const u = "«http»" + "s«C»«S»«S»evil.example/x";`, RUNTIME],
    ["a scheme letter written as a hex escape", `export const u = "h«X74»tps«C»«S»«S»evil.example";`, RUNTIME],
    ["a colon written as a unicode escape", `export const u = "https«U003A»«S»«S»evil.example";`, RUNTIME],
    ["atob of a literal that decodes to a URL", `export const u = atob("${b64("https«C»«S»«S»evil.example/x")}");`, RUNTIME],
    ["a base64 constant decoded elsewhere", `const K = '${b64("https«C»«S»«S»evil.example")}';\nexport const u = atob(K);`, RUNTIME],
    ["base64 of a protocol-relative URL", `export const u = atob("${b64("«S»«S»evil.example")}");`, RUNTIME],
    ["base64url of a URL, via Buffer", `export const u = Buffer.from("${Buffer.from(src("https«C»«S»«S»evil.example/?a=>>")).toString("base64url")}", "base64url");`, RUNTIME],
    ["base64 torn in half across a plus", tornB64, RUNTIME],
    // Each of these parses as an absolute URL with `new URL()`, and each printed
    // OK while the host pattern wanted an ASCII first label and a dot.
    ["a URL with userinfo before the host", `export const u = "https«C»«S»«S»x@evil.example/";`, UNGATED],
    ["a percent-encoded host", `export const u = "https«C»«S»«S»%65vil.example/";`, UNGATED],
    ["a dotless IPv4 host in decimal", `export const u = "https«C»«S»«S»3232235777/x";`, UNGATED],
    ["a dotless IPv4 host in hex", `export const u = "https«C»«S»«S»0x7f000001/x";`, UNGATED],
    ["an IPv6 host", `export const u = "https«C»«S»«S»[2001«C»db8«C»«C»1]/x";`, UNGATED],
    ["a look-alike host whose first label is Cyrillic", `export const u = "https«C»«S»«S»p\u0430ypal.com/x";`, UNGATED],
    // The URL parser deletes tab, newline and carriage return wherever they sit.
    ["a tab escape inside the scheme", `export const u = "h\\tttps«C»«S»«S»evil.example/";`, RUNTIME],
    ["a literal tab inside the scheme", `export const u = "h\tttps«C»«S»«S»evil.example/";`, RUNTIME],
    ["a newline escape after the colon", `export const u = "https«C»\\n«S»«S»evil.example/";`, RUNTIME],
    ["a carriage-return escape between the slashes", `export const u = "https«C»«S»\\r«S»evil.example/";`, RUNTIME],
    ["a colon written as a braced unicode escape", `export const u = "https\\u{3a}«S»«S»evil.example/";`, RUNTIME],
    // A `*` used to end the host, so a match pattern naming real hosts read as
    // naming none.
    ["a match pattern with a wildcard subdomain of a real host", `export const m = "https«C»«S»«S»*.evil.example/*";`, UNGATED],
    ["a match pattern with a wildcard scheme and a real host", `export const m = "*«C»«S»«S»evil.example/*";`, UNGATED],
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

describe("check:urls — match patterns that name no host", () => {
  it("passes a bare wildcard host, with any or a wildcard scheme", () => {
    const r = check({ "src/a.ts": src(`export const m = ["https«C»«S»«S»*«S»*", "https«C»«S»«S»*", "*«C»«S»«S»*«S»*"];\n`) });
    expect(r.out, r.out).toContain("Outbound-URL guard OK");
    expect(r.status).toBe(0);
  });
});

describe("check:urls — one rule for which files are read", () => {
  const LINK = src(`<a href="https«C»«S»«S»evil.example/claim">claim</a>`);
  it("refuses a new directory holding only an SVG and a web manifest", () => {
    const r = check({
      "public/icon.svg": `<svg xmlns="x">${LINK}</svg>\n`,
      "public/site.webmanifest": src(`{"start_url": "https«C»«S»«S»evil.example/"}\n`),
    });
    expect(r.out, r.out).toContain("source directories nobody scans");
    expect(r.out).toContain("public/");
    expect(r.status).toBe(1);
  });

  const rootFiles: [string, string][] = [
    ["bunfig.toml", src(`[install]\nregistry = "https«C»«S»«S»evil.example/npm/"\n`)],
    [".npmrc", src(`registry=https«C»«S»«S»evil.example/npm/\n`)],
    ["icon.svg", `<svg xmlns="x">${LINK}</svg>\n`],
  ];
  for (const [name, text] of rootFiles) {
    it(`refuses a URL in ${name} at the repo root`, () => {
      const r = check({ [name]: text });
      expect(reasonOf(r.out), r.out).toBe(UNGATED);
      expect(r.out).toContain(name);
      expect(r.status).toBe(1);
    });
  }

  it("refuses an SVG under a scan root", () => {
    const r = check({ "src/icon.svg": `<svg xmlns="x">${LINK}</svg>\n` });
    expect(reasonOf(r.out), r.out).toBe(UNGATED);
    expect(r.status).toBe(1);
  });

  it("skips a binary file, and says so", () => {
    const r = check({ "src/img.png": "\u0000PNG " + LINK });
    expect(r.out, r.out).toContain("Outbound-URL guard OK");
    expect(r.out).toContain("1 binary file not read: src/img.png");
    expect(r.status).toBe(0);
  });
});

describe("check:urls — CODEOWNERS comments and owner syntax", () => {
  const URL_FILE = { "src/a.ts": src(`export const a = "https«C»«S»«S»evil.example/x";\n`) };
  it("counts a line with a comment after a real owner", () => {
    const r = check(URL_FILE, [], ["/src/a.ts  @AladinContract  # the provider"]);
    expect(r.out, r.out).toContain("Outbound-URL guard OK");
    expect(r.status).toBe(0);
  });
  it("counts an owner given as an email address", () => {
    const r = check(URL_FILE, [], ["/src/a.ts  dev@example.com"]);
    expect(r.status, r.out).toBe(0);
  });
  it("does not count an owner named only inside a trailing comment", () => {
    const r = check(URL_FILE, [], ["/src/a.ts  # owned by @AladinContract later"]);
    expect(reasonOf(r.out), r.out).toBe(UNGATED);
    expect(r.status).toBe(1);
  });
  it("does not count a line GitHub skips for an owner it cannot parse", () => {
    const r = check(URL_FILE, [], ["/src/a.ts  (@AladinContract)"]);
    expect(reasonOf(r.out), r.out).toBe(UNGATED);
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
