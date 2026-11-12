import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "check-tiers-codeowners.mjs");

type Tiers = { low: string[]; mid: string[]; forbidden: string[] };

const BASE_TIERS: Tiers = {
  low: ["src/ui/Nav.tsx"],
  mid: ["src/ui/Badge.tsx"],
  forbidden: ["src/lib/guarded.ts", "locales/**", ".github/**", "docs/**"],
};

const BASE_FILES: Record<string, string> = {
  ".github/CODEOWNERS": "/src/lib/guarded.ts  @owner\n/locales/  @owner\n",
  "src/lib/guarded.ts": "export const guarded = 1;\n",
  "src/ui/Badge.tsx": "export const Badge = 1;\n",
  // A paid file importing another paid file is fine.
  "src/ui/Nav.tsx": 'import { Badge } from "./Badge";\nexport const Nav = Badge;\n',
  "locales/en/wallet.json": "{}\n",
  "locales/vi/wallet.json": "{}\n",
};

/**
 * Builds a scratch git repository from `files` plus the tier table, stages the
 * files listed in `tracked` (all of them by default), and runs the gate on it.
 */
function check(opts: { files?: Record<string, string | null>; tiers?: Partial<Tiers>; untracked?: string[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "tiers-"));
  try {
    const files: Record<string, string> = { ...BASE_FILES };
    for (const [rel, text] of Object.entries(opts.files ?? {})) {
      if (text === null) delete files[rel];
      else files[rel] = text;
    }
    files["docs/contribution-tiers.json"] = JSON.stringify({ version: 1, tiers: { ...BASE_TIERS, ...opts.tiers } }, null, 2);
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(join(root, dirname(rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    execFileSync("git", ["-C", root, "init", "-q"]);
    const add = Object.keys(files).filter((f) => !(opts.untracked ?? []).includes(f));
    execFileSync("git", ["-C", root, "add", "--", ...add]);
    const r = spawnSync(process.execPath, [SCRIPT, root], { encoding: "utf8" });
    return { status: r.status, out: r.stdout + r.stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("check:tiers-codeowners", () => {
  it("passes a table whose paid files nothing forbidden depends on", () => {
    const r = check();
    expect(r.out).toContain("Tier/CODEOWNERS OK");
    expect(r.out).toContain("2 CODEOWNERS entries, 3 guarded files,");
    expect(r.status).toBe(0);
  });

  it("fails a mid file that a forbidden file imports directly", () => {
    const r = check({ files: { "src/lib/guarded.ts": 'import { Badge } from "../ui/Badge";\nexport const guarded = Badge;\n' } });
    expect(r.out).toContain('src/ui/Badge.tsx is "mid" but a forbidden file depends on it: src/lib/guarded.ts → src/ui/Badge.tsx');
    expect(r.status).toBe(1);
  });

  it("fails a paid file reached through another paid file, and follows `@/` and import()", () => {
    const r = check({
      files: {
        "src/lib/guarded.ts": 'export const load = () => import("@/ui/Nav");\n',
      },
    });
    expect(r.out).toContain('src/ui/Nav.tsx is "low" but a forbidden file depends on it: src/lib/guarded.ts → src/ui/Nav.tsx');
    expect(r.out).toContain('src/ui/Badge.tsx is "mid" but a forbidden file depends on it: src/lib/guarded.ts → src/ui/Nav.tsx → src/ui/Badge.tsx');
    expect(r.status).toBe(1);
  });

  it("counts a file no pattern names as forbidden when it imports a paid file", () => {
    const r = check({ files: { "src/ui/Unlisted.tsx": 'export { Badge } from "./Badge";\n' } });
    expect(r.out).toContain("src/ui/Unlisted.tsx → src/ui/Badge.tsx");
    expect(r.status).toBe(1);
  });

  it("fails an import it cannot resolve instead of skipping it", () => {
    const r = check({ files: { "src/lib/guarded.ts": 'import { x } from "./gone";\nexport const guarded = x;\n' } });
    expect(r.out).toContain("src/lib/guarded.ts imports `./gone`, which resolves to no tracked file");
    expect(r.status).toBe(1);
  });

  it("does not let a test file make a paid file forbidden", () => {
    const r = check({ files: { "src/ui/Badge.test.ts": 'import { Badge } from "./Badge";\n' } });
    expect(r.out).toContain("Tier/CODEOWNERS OK");
    expect(r.status).toBe(0);
  });

  it("fails a wildcard in mid even when it matches nothing guarded", () => {
    const r = check({ tiers: { mid: ["src/ui/Badge.tsx", "src/ui/*.tsx"] } });
    expect(r.out).toContain('"mid" entry `src/ui/*.tsx` is a pattern');
    expect(r.status).toBe(1);
  });

  it("fails ?, [ and { in low", () => {
    const q = check({ tiers: { low: ["src/ui/Na?.tsx"] } });
    expect(q.out).toContain('"low" entry `src/ui/Na?.tsx` is a pattern');
    expect(q.status).toBe(1);
    // Brackets and braces are outside the table's dialect altogether, so the
    // gate refuses to read the table rather than judging it.
    for (const glob of ["src/ui/[N]av.tsx", "src/ui/{Nav}.tsx"]) {
      const r = check({ tiers: { low: [glob] } });
      expect(r.out).toContain("is outside the declared dialect");
      expect(r.status).toBe(2);
    }
  });

  it("fails a mid entry naming a file git does not track", () => {
    const r = check({ files: { "src/ui/Draft.tsx": "export const D = 1;\n" }, untracked: ["src/ui/Draft.tsx"], tiers: { mid: ["src/ui/Badge.tsx", "src/ui/Draft.tsx"] } });
    expect(r.out).toContain('"mid" entry `src/ui/Draft.tsx` is not a file git tracks');
    expect(r.status).toBe(1);
  });

  it("reads `/locales` without a trailing slash as the directory GitHub guards", () => {
    const r = check({
      files: { ".github/CODEOWNERS": "/src/lib/guarded.ts  @owner\n/locales  @owner\n" },
      tiers: { mid: ["src/ui/Badge.tsx", "locales/en/wallet.json"], forbidden: ["src/lib/guarded.ts", ".github/**", "docs/**"] },
    });
    expect(r.out).toContain('locales/en/wallet.json is guarded by .github/CODEOWNERS:2 but the tier table puts it in "mid"');
    expect(r.status).toBe(1);
  });

  it("reads an escaped space as part of the CODEOWNERS pattern", () => {
    const r = check({
      files: {
        ".github/CODEOWNERS": "/src/lib/guarded.ts  @owner\n/src/ui/My\\ Panel.tsx  @owner\n",
        "src/ui/My Panel.tsx": "export const P = 1;\n",
      },
      tiers: { mid: ["src/ui/Badge.tsx", "src/ui/My Panel.tsx"] },
    });
    expect(r.out).toContain('src/ui/My Panel.tsx is guarded by .github/CODEOWNERS:2 but the tier table puts it in "mid"');
    expect(r.status).toBe(1);
  });

  // ─── CODEOWNERS input it must not skip ───────────────────────────────────────

  it("fails a CODEOWNERS line in a form it does not parse", () => {
    const r = check({ files: { ".github/CODEOWNERS": "/src/lib/guarded.ts  @owner\n/locales/  @owner\n*.ts  @owner\n" } });
    expect(r.out).toContain(".github/CODEOWNERS:3: CODEOWNERS pattern `*.ts` is in a form this check does not parse");
    expect(r.status).toBe(1);
  });

  it("reads a bare `*` ahead of the anchored lines as a default reviewer, and still checks what follows", () => {
    const ok = check({ files: { ".github/CODEOWNERS": "*  @owner\n/src/lib/guarded.ts  @owner\n/locales/  @owner\n" } });
    expect(ok.out).toContain("(1 bare `*` default-reviewer line not counted as a guard)");
    expect(ok.status).toBe(0);
    // The anchored lines after it still guard their files.
    const bad = check({
      files: { ".github/CODEOWNERS": "*  @owner\n/src/lib/guarded.ts  @owner\n/locales/  @owner\n" },
      tiers: { mid: ["src/ui/Badge.tsx", "src/lib/guarded.ts"], forbidden: ["locales/**", ".github/**", "docs/**"] },
    });
    expect(bad.out).toContain('src/lib/guarded.ts is guarded by .github/CODEOWNERS:2 but the tier table puts it in "mid"');
    expect(bad.status).toBe(1);
  });

  it("reads each CODEOWNERS file's leading `*` on its own, not after another file's anchored lines", () => {
    const r = check({ files: { "docs/CODEOWNERS": "*  @owner\n/src/lib/guarded.ts  @owner\n" } });
    expect(r.out).toContain("(1 bare `*` default-reviewer line not counted as a guard)");
    expect(r.status).toBe(0);
  });

  it("refuses a bare `*` after an anchored line, where it would take those files over", () => {
    const r = check({ files: { ".github/CODEOWNERS": "/src/lib/guarded.ts  @owner\n/locales/  @owner\n*  @owner\n" } });
    expect(r.out).toContain(".github/CODEOWNERS:3: CODEOWNERS pattern `*` is in a form this check does not parse");
    expect(r.status).toBe(1);
  });

  it("fails a CODEOWNERS line that names no tracked file", () => {
    const r = check({ files: { ".github/CODEOWNERS": "/src/lib/guarded.ts  @owner\n/src/lib/gaurded.ts  @owner\n" } });
    expect(r.out).toContain(".github/CODEOWNERS:2: CODEOWNERS pattern `/src/lib/gaurded.ts` names no file git tracks");
    expect(r.status).toBe(1);
  });

  it("reads CODEOWNERS at the repository root and in docs/, the other places GitHub looks", () => {
    for (const place of ["CODEOWNERS", "docs/CODEOWNERS"]) {
      const r = check({ files: { [place]: "/src/ui/Badge.tsx  @owner\n" } });
      expect(r.out).toContain(`src/ui/Badge.tsx is guarded by ${place}:1 but the tier table puts it in "mid"`);
      expect(r.status).toBe(1);
    }
  });

  // ─── the table's shape ──────────────────────────────────────────────────────

  it("refuses a tier key the marketplace does not know", () => {
    const r = check({ tiers: { Mid: ["src/ui/Badge.tsx"] } as Partial<Tiers> });
    expect(r.out).toContain("names tiers the marketplace does not know: Mid");
    expect(r.status).toBe(2);
  });

  it("refuses a table over the marketplace's pattern limit", () => {
    const many = Array.from({ length: 501 }, (_, i) => `gen/f${i}.ts`);
    const r = check({ tiers: { forbidden: [...BASE_TIERS.forbidden, ...many] } });
    expect(r.out).toContain("over the marketplace's 500");
    expect(r.status).toBe(2);
  });

  it("refuses a table over the marketplace's size limit", () => {
    const long = Array.from({ length: 300 }, (_, i) => `gen/${"x".repeat(240)}${i}.ts`);
    const r = check({ tiers: { forbidden: [...BASE_TIERS.forbidden, ...long] } });
    expect(r.out).toContain("is over 65536 bytes");
    expect(r.status).toBe(2);
  });

  it("refuses a pattern over the marketplace's per-pattern caps", () => {
    const long = check({ tiers: { forbidden: [...BASE_TIERS.forbidden, `gen/${"x".repeat(1021)}`] } });
    expect(long.out).toContain("the table's reader stops at 1024");
    expect(long.status).toBe(2);
    // `**` counts once, like the marketplace's matcher: 1 + 16 = 17 is over.
    const wild = check({ tiers: { forbidden: [...BASE_TIERS.forbidden, `**/${"*a".repeat(16)}`] } });
    expect(wild.out).toContain("has 17 wildcards; the table's reader stops at 16");
    expect(wild.status).toBe(2);
    // `?` counts toward the same cap as `*`.
    const marks = check({ tiers: { forbidden: [...BASE_TIERS.forbidden, `gen/${"?".repeat(17)}`] } });
    expect(marks.out).toContain("has 17 wildcards; the table's reader stops at 16");
    expect(marks.status).toBe(2);
    // At the caps exactly, the table is read.
    const edge = check({ tiers: { forbidden: [...BASE_TIERS.forbidden, `gen/${"x".repeat(1020)}`, `**/${"*a".repeat(15)}`, `gen/${"?".repeat(16)}`] } });
    expect(edge.out).not.toContain("the table's reader stops at");
    expect(edge.status).toBe(0);
  });

  it("refuses a tier that is not a list of non-empty strings", () => {
    const r = check({ tiers: { mid: ["src/ui/Badge.tsx", ""] } });
    expect(r.out).toContain('tier "mid" is not a list of non-empty strings');
    expect(r.status).toBe(2);
  });

  it("refuses a tier set to null instead of reading it as empty", () => {
    const r = check({ tiers: { low: null } as unknown as Partial<Tiers> });
    expect(r.out).toContain('tier "low" is not a list of non-empty strings');
    expect(r.status).toBe(2);
  });

  // ─── every form of dependency ───────────────────────────────────────────────

  const viaGuarded = (src: string, extra: Record<string, string> = {}) =>
    check({ files: { "src/lib/guarded.ts": src, ...extra } });
  const BADGE_DEP = 'src/ui/Badge.tsx is "mid" but a forbidden file depends on it: src/lib/guarded.ts → src/ui/Badge.tsx';

  it.each([
    ["new URL(…, import.meta.url)", 'export const u = new URL("../ui/Badge.tsx", import.meta.url);\n'],
    ["a .js specifier naming a .ts file", 'export { Badge } from "../ui/Badge.js";\n'],
    ["a ?query suffix", 'export { default } from "../ui/Badge.tsx?raw";\n'],
    ["a template literal in import()", "export const l = () => import(`../ui/Badge`);\n"],
    ["require()", 'export const b = require("../ui/Badge");\n'],
    ["a string-named import", 'import { "Badge" as B } from "../ui/Badge";\nexport const g = B;\n'],
    ["import.meta.glob", 'export const m = import.meta.glob("../ui/*.tsx", { eager: true });\n'],
    ["import.meta.glob behind a cast", 'export const m = (import.meta as any).glob(["../ui/Bad*.tsx"]);\n'],
    ["import x = require()", 'import B = require("../ui/Badge");\nexport const g = B;\n'],
    ["an import() type", 'export type B = typeof import("../ui/Badge");\n'],
    ["a triple-slash reference", '/// <reference path="../ui/Badge.tsx" />\nexport const guarded = 1;\n'],
  ])("follows %s", (_name, src) => {
    const r = viaGuarded(src);
    expect(r.out).toContain(BADGE_DEP);
    expect(r.status).toBe(1);
  });

  it("follows an import that sits after an apostrophe in JSX text", () => {
    const r = check({
      files: {
        "src/lib/guarded.tsx": 'export const A = () => <p>Don\'t</p>; export const l = () => import("../ui/Badge");\n',
        ".github/CODEOWNERS": "/src/lib/guarded.tsx  @owner\n",
      },
      tiers: { forbidden: ["src/lib/guarded.ts", "src/lib/guarded.tsx", "locales/**", ".github/**", "docs/**"] },
    });
    expect(r.out).toContain('src/ui/Badge.tsx is "mid" but a forbidden file depends on it: src/lib/guarded.tsx → src/ui/Badge.tsx');
    expect(r.status).toBe(1);
  });

  it("resolves a bare specifier through tsconfig baseUrl before calling it a package", () => {
    const r = viaGuarded('export { Badge } from "src/ui/Badge";\n', {
      "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } } }),
    });
    expect(r.out).toContain(BADGE_DEP);
    expect(r.status).toBe(1);
  });

  it("resolves a tsconfig paths alias other than @/", () => {
    const r = viaGuarded('export { Badge } from "~ui/Badge";\n', {
      "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "~ui/*": ["./src/ui/*"] } } }),
    });
    expect(r.out).toContain(BADGE_DEP);
    expect(r.status).toBe(1);
  });

  it("resolves a directory through its package.json, which is itself an edge", () => {
    const r = check({
      files: {
        "src/lib/guarded.ts": 'export { Badge } from "../ui";\n',
        "src/ui/package.json": '{"types":"./Badge.tsx","main":"./Badge.tsx"}\n',
      },
      tiers: { mid: ["src/ui/Badge.tsx", "src/ui/package.json"] },
    });
    expect(r.out).toContain(BADGE_DEP);
    expect(r.out).toContain('src/ui/package.json is "mid" but a forbidden file depends on it: src/lib/guarded.ts → src/ui/package.json');
    expect(r.status).toBe(1);
  });

  it("lets only new URL name a directory as a plain path", () => {
    const ok = viaGuarded('export const u = new URL("../ui/", import.meta.url);\nexport const guarded = 1;\n');
    expect(ok.out).toContain("Tier/CODEOWNERS OK");
    expect(ok.status).toBe(0);
    const bad = viaGuarded('export * from "../ui";\n');
    expect(bad.out).toContain("src/lib/guarded.ts imports `../ui`, which resolves to no tracked file and no declared package");
    expect(bad.status).toBe(1);
  });

  it("calls a bare specifier a package only when package.json declares it or Node ships it", () => {
    const pkg = { "package.json": JSON.stringify({ dependencies: { react: "^19" }, devDependencies: { "@scope/tool": "1" } }) };
    const ok = viaGuarded('import "react/jsx-runtime";\nimport "@scope/tool/sub";\nimport "node:fs";\nimport "path";\nexport const guarded = 1;\n', pkg);
    expect(ok.out).toContain("Tier/CODEOWNERS OK");
    expect(ok.status).toBe(0);
    const bad = viaGuarded('import "lodash";\nexport const guarded = 1;\n', pkg);
    expect(bad.out).toContain("src/lib/guarded.ts imports `lodash`, which resolves to no tracked file and no declared package");
    expect(bad.status).toBe(1);
  });

  it.each([
    ["import()", "export const l = (p: string) => import(p);\n", "`import(…)` of something that is not a constant string"],
    ["a template import() with a substitution", "export const l = (p: string) => import(`../ui/${p}`);\n", "`import(…)` of something that is not a constant string"],
    ["require()", "export const l = (p: string) => require(p);\n", "`require(…)` of something that is not a constant string"],
    ["import.meta.glob", "const g = ['../ui/*.tsx'];\nexport const m = import.meta.glob(g);\n", "`import.meta.glob` of something that is not a constant string"],
  ])("fails %s whose argument is not a constant string", (_name, src, msg) => {
    const r = viaGuarded(src);
    expect(r.out).toContain(msg);
    expect(r.status).toBe(1);
  });

  it("fails a source file it cannot parse rather than reading part of it", () => {
    const r = viaGuarded('export const = 1;\nexport const l = () => import("../ui/Badge");\n');
    expect(r.out).toContain("src/lib/guarded.ts does not parse");
    expect(r.status).toBe(1);
  });

  it("does not read imports out of comments", () => {
    const r = viaGuarded('// do not import anything from "./legacy" here\n/* require("./gone") */\nexport const guarded = 1;\n');
    expect(r.out).toContain("Tier/CODEOWNERS OK");
    expect(r.status).toBe(0);
  });
});
