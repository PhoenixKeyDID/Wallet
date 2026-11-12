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
    expect(r.out).toContain("3 guarded files and 1 new-file probes");
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
});
