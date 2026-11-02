/**
 * The keystore boundary, checked by staging the imports that once got past it.
 *
 * The gate used to match the specifier's text, so it knew the spellings its
 * author thought of and no others: `../keystore` from a sibling directory, a
 * module of the keystore missing from its list, and `./keystore` from
 * `src/lib` were all reported OK. Each case below stages one importing file in
 * a throwaway tree with a real `src/lib/keystore/`, so a red result names its
 * own cause. The last case runs the gate on this repo.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "check-keystore-boundary.mjs");

const TSCONFIG = JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } } });

/** Runs the gate on a tree holding a keystore, a tsconfig, and `files`. */
function check(files: Record<string, string>, opts: { tsconfig?: string; link?: [string, string] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "keystore-boundary-"));
  try {
    const tree: Record<string, string> = {
      "tsconfig.json": opts.tsconfig ?? TSCONFIG,
      "src/lib/keystore/index.ts": "export * from './vault';\n",
      "src/lib/keystore/vault.ts": "export const vault = 1;\n",
      "src/lib/keystore/port.ts": "export const port = 1;\n",
      "src/lib/other.ts": "export const other = 1;\n",
      "extension/README.txt": "",
      ...files,
    };
    for (const [rel, text] of Object.entries(tree)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    if (opts.link) symlinkSync(join(root, opts.link[1]), join(root, opts.link[0]), "dir");
    const r = spawnSync(process.execPath, [SCRIPT, root], { encoding: "utf8" });
    return { status: r.status, out: r.stdout + r.stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("check:keystore-boundary — controls", () => {
  it("passes a tree where nothing outside the allow-list imports the keystore", () => {
    const r = check({ "src/components/wallet/WatchPanel.tsx": `import { other } from "@/lib/other";\nimport { x } from "../../lib/keystoreish";\n` });
    expect(r.out).toContain("Keystore boundary OK");
    expect(r.status).toBe(0);
  });

  it("passes the keystore imported from the one screen allowed to", () => {
    const r = check({ "src/components/wallet/LocalWalletPanel.tsx": `import { vault } from "../../lib/keystore/vault";\n` });
    expect(r.status).toBe(0);
  });

  it("fails on a tsconfig it cannot read, rather than resolving without aliases", () => {
    const r = check({ "src/a.ts": "export const a = 1;\n" }, { tsconfig: "{ not json" });
    expect(r.out).toContain("cannot parse tsconfig.json");
    expect(r.status).toBe(1);
  });
});

describe("check:keystore-boundary — imports that used to print OK", () => {
  const cases: [string, string, string][] = [
    ["the directory, one level up", "src/lib/cardano/panel.ts", `import { vault } from "../keystore";`],
    ["the index module, two levels up", "src/components/wallet/WatchPanel.tsx", `import { vault } from "../../lib/keystore/index";`],
    ["a module, from its parent directory", "src/lib/panel.ts", `import { vault } from "./keystore/vault";`],
    ["the directory, from its parent directory", "src/lib/panel.ts", `export { vault } from "./keystore";`],
    ["a module the old pattern did not list", "src/lib/cardano/panel.ts", `import { port } from "../keystore/port";`],
    ["a module named with its extension", "src/lib/cardano/panel.ts", `import { vault } from "../keystore/vault.ts";`],
    ["a path that walks out and back in", "src/components/Panel.tsx", `import { vault } from "../lib/cardano/../keystore/vault";`],
    ["a different case of the same directory", "src/lib/cardano/panel.ts", `import { vault } from "../Keystore/vault";`],
    ["a module through the @/ alias", "src/components/Panel.tsx", `import { vault } from "@/lib/keystore/vault";`],
    ["a bare path through baseUrl", "src/components/Panel.tsx", `import { vault } from "src/lib/keystore";`],
    ["a dynamic import, indented", "src/components/Panel.tsx", `export function f() {\n  return import("../lib/keystore");\n}`],
  ];

  for (const [name, file, text] of cases) {
    it(`refuses ${name}`, () => {
      const r = check({ [file]: text + "\n" });
      expect(r.out, r.out).toContain("Keystore boundary FAILED");
      expect(r.out).toContain(file);
      expect(r.status).toBe(1);
    });
  }

  it("refuses an alias declared in tsconfig that the old pattern never heard of", () => {
    const tsconfig = JSON.stringify({
      compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"], "#secrets": ["./src/lib/keystore/index.ts"] } },
    });
    const r = check({ "src/components/Panel.tsx": `import { vault } from "#secrets";\n` }, { tsconfig });
    expect(r.out).toContain("src/components/Panel.tsx");
    expect(r.status).toBe(1);
  });

  it("refuses the keystore reached through a symlinked directory", () => {
    const r = check({ "src/components/Panel.tsx": `import { vault } from "../lib/ks/vault";\n` }, { link: ["src/lib/ks", "src/lib/keystore"] });
    expect(r.out).toContain("src/components/Panel.tsx");
    expect(r.status).toBe(1);
  });
});

describe("check:keystore-boundary — this repo", () => {
  it("passes", () => {
    const r = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
    expect(r.stdout + r.stderr).toContain("Keystore boundary OK");
    expect(r.status).toBe(0);
  });
});
