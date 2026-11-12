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
function check(
  files: Record<string, string>,
  opts: { tsconfig?: string; link?: [string, string]; viaSymlinkedRoot?: boolean } = {},
) {
  const outer = mkdtempSync(join(tmpdir(), "keystore-boundary-"));
  const root = join(outer, "real");
  mkdirSync(root);
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
    // The gate is handed a path through a symlink, so the repo it walks and the
    // real path it compares against differ — as they do under macOS's tmpdir,
    // made explicit here so the case means the same on every OS.
    let target = root;
    if (opts.viaSymlinkedRoot) {
      target = join(outer, "link");
      symlinkSync(root, target, "dir");
    }
    const r = spawnSync(process.execPath, [SCRIPT, target], { encoding: "utf8" });
    return { status: r.status, out: r.stdout + r.stderr };
  } finally {
    rmSync(outer, { recursive: true, force: true });
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
    ["a dynamic import in a template literal", "src/components/Panel.tsx", `export function f() {\n  return import(\`../lib/keystore\`);\n}`],
    ["a second import on the same line as an innocent one", "src/components/Panel.tsx", `import { other } from "@/lib/other"; import { vault } from "../lib/keystore";`],
    ["a Vite root-relative specifier", "src/components/Panel.tsx", `import { vault } from "/src/lib/keystore/vault";`],
    ["a file inside a directory named out", "src/out/Panel.tsx", `import { vault } from "../lib/keystore";`],
    ["a plain JavaScript file", "src/components/Panel.js", `import { vault } from "../lib/keystore";`],
    ["a script-module file", "src/components/Panel.mjs", `import { vault } from "../lib/keystore";`],
    ["a static import after a block comment on the same line", "src/components/Panel.tsx", `/**/ import { vault } from "../lib/keystore";`],
    ["a static import after an empty block on the same line", "src/components/Panel.tsx", `{} import { vault } from "../lib/keystore";`],
    ["a dynamic import with a comment before the specifier", "src/components/Panel.tsx", `function f() {\n  return import(/* @vite-ignore */ "../lib/keystore");\n}\nexport { f };`],
    ["import.meta.glob of a keystore module", "src/components/Panel.tsx", `function f() {\n  return import.meta.glob("../lib/keystore/vault.ts", { eager: true });\n}\nexport { f };`],
    ["import.meta.glob with the keystore in an array of patterns", "src/components/Panel.tsx", `export const m = import.meta.glob(["../lib/other.ts", "../lib/keystore/*.ts"]);`],
    ["an import from a file under scripts/", "scripts/relay.ts", `export * from "../src/lib/keystore";`],
    ["an import from a file at the repo root", "relay.ts", `export * from "./src/lib/keystore";`],
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

  it("refuses an alias declared in a config that tsconfig.json extends", () => {
    const r = check(
      {
        "src/components/Panel.tsx": `import { vault } from "#k";\n`,
        "tsconfig.base.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "#k": ["./src/lib/keystore/index.ts"] } } }),
      },
      { tsconfig: JSON.stringify({ extends: "./tsconfig.base.json" }) },
    );
    expect(r.out, r.out).toContain("src/components/Panel.tsx");
    expect(r.status).toBe(1);
  });

  it("refuses a .js specifier for a .ts keystore module when the repo path goes through a symlink", () => {
    const r = check({ "src/components/Panel.tsx": `import { vault } from "../lib/keystore/vault.js";\n` }, { viaSymlinkedRoot: true });
    expect(r.out, r.out).toContain("src/components/Panel.tsx:1");
    expect(r.status).toBe(1);
  });

  it("refuses a relay: a panel re-exporting a scripts/ module that re-exports the keystore", () => {
    const r = check({
      "src/components/Panel.tsx": `export * from "../../scripts/relay";\n`,
      "scripts/relay.ts": `export * from "../src/lib/keystore";\n`,
    });
    expect(r.out, r.out).toContain("scripts/relay.ts:1");
    expect(r.status).toBe(1);
  });

  it("reports the line of the dynamic import, not of an earlier export with no quote", () => {
    const r = check({
      "src/components/Panel.tsx": `export { g };\nconst g = 1;\nfunction f() {\n  return import("../lib/keystore");\n}\n`,
    });
    expect(r.out, r.out).toContain("src/components/Panel.tsx:4");
    expect(r.out).not.toContain("src/components/Panel.tsx:1");
    expect(r.status).toBe(1);
  });

  it("reads a helper module beside the gate's tests, and says which test files it skipped", () => {
    const r = check({
      "scripts/__tests__/helper.ts": `export * from "../../src/lib/keystore";\n`,
      "scripts/__tests__/thing.test.ts": `const fixture = 'import { vault } from "@/lib/keystore/vault"';\n`,
    });
    expect(r.out, r.out).toContain("scripts/__tests__/helper.ts:1");
    expect(r.out).not.toContain("thing.test.ts");
    expect(r.out).toContain("scripts/__tests__/*.test.* are not read (1 skipped)");
    expect(r.status).toBe(1);
  });

  it("fails on a source directory it does not scan", () => {
    const r = check({ "tools/relay.ts": `export * from "../src/lib/keystore";\n` });
    expect(r.out, r.out).toContain("source directories nobody scans: tools/");
    expect(r.status).toBe(1);
  });

  it("fails on an extends it cannot find, rather than resolving without the base config", () => {
    const r = check({ "src/a.ts": "export const a = 1;\n" }, { tsconfig: JSON.stringify({ extends: "./missing.json" }) });
    expect(r.out).toContain('cannot find "./missing.json"');
    expect(r.status).toBe(1);
  });
});

describe("check:keystore-boundary — controls for the widened patterns", () => {
  const ok: [string, Record<string, string>][] = [
    ["a glob over a directory beside the keystore", { "src/components/Panel.tsx": `export const m = import.meta.glob("../lib/*.ts");\n` }],
    ["a negated glob naming the keystore", { "src/components/Panel.tsx": `export const m = import.meta.glob(["../lib/*.ts", "!../lib/keystore/**"]);\n` }],
    ["an export list followed by unrelated strings", { "src/components/Panel.tsx": `export { g };\nconst g = "../lib/keystore";\n` }],
    ["a test file under scripts/__tests__ spelling an alias import in a fixture", { "scripts/__tests__/x.test.ts": `const t = 'import { v } from "@/lib/keystore/vault"';\n` }],
  ];
  for (const [name, files] of ok) {
    it(`passes ${name}`, () => {
      const r = check(files);
      expect(r.out, r.out).toContain("Keystore boundary OK");
      expect(r.status).toBe(0);
    });
  }
});

describe("check:keystore-boundary — worker and asset URLs", () => {
  const cases: [string, string][] = [
    ["a module worker built from new URL", `export const w = new Worker(new URL("../lib/keystore/vault.ts", import.meta.url), { type: "module" });`],
    ["a shared worker, with comments between every token", `export const w = new /* a */ SharedWorker( /* b */ new /* c */ URL( /* d */ "../lib/keystore/vault.ts", import.meta.url));`],
    ["a worker given a literal path", `export const w = new Worker("../lib/keystore/vault.ts");`],
    ["a bare new URL naming the keystore", `export const u = new URL(\`../lib/keystore/vault.ts\`, import.meta.url);`],
  ];
  for (const [name, text] of cases) {
    it(`refuses ${name}`, () => {
      const r = check({ "src/components/P.tsx": text + "\n" });
      expect(r.out, r.out).toContain("src/components/P.tsx:1");
      expect(r.status).toBe(1);
    });
  }

  it("passes a new URL that resolves outside the keystore", () => {
    const r = check({ "src/components/P.tsx": `export const w = new Worker(new URL("../lib/other.ts", import.meta.url));\n` });
    expect(r.out, r.out).toContain("Keystore boundary OK");
    expect(r.status).toBe(0);
  });
});

describe("check:keystore-boundary — allowed files used as relays", () => {
  const PANEL = "src/components/wallet/LocalWalletPanel.tsx";
  const LEAKY_PANEL = `import { vault } from "../../lib/keystore/vault";\nexport { vault };\nexport function LocalWalletPanel() { return vault; }\n`;
  const CLEAN_PANEL = `import { vault } from "../../lib/keystore/vault";\nexport function LocalWalletPanel() { return vault; }\n`;

  const refused: [string, Record<string, string>][] = [
    ["a re-export of a module under extension/smoke/", {
      "extension/smoke/relay.ts": `export * from "../../src/lib/keystore";\n`,
      "src/components/connect/P.tsx": `export * from "../../../extension/smoke/relay";\n`,
    }],
    ["a named import from a module under extension/smoke/", {
      "extension/smoke/relay.ts": `export { vault } from "../../src/lib/keystore/vault";\n`,
      "src/components/connect/P.tsx": `import { vault } from "../../../extension/smoke/relay";\nexport const v = vault;\n`,
    }],
    ["a name LocalWalletPanel re-exports from the keystore", { [PANEL]: LEAKY_PANEL, "src/components/connect/P.tsx": `import { vault } from "../wallet/LocalWalletPanel";\nexport const v = vault;\n` }],
    ["a star re-export of LocalWalletPanel", { [PANEL]: LEAKY_PANEL, "src/components/connect/P.tsx": `export * from "../wallet/LocalWalletPanel";\n` }],
    ["a namespace import of LocalWalletPanel", { [PANEL]: CLEAN_PANEL, "src/components/connect/P.tsx": `import * as L from "../wallet/LocalWalletPanel";\nexport const v = L;\n` }],
    ["a dynamic import of LocalWalletPanel", { [PANEL]: CLEAN_PANEL, "src/components/connect/P.tsx": `export const l = () => import("../wallet/LocalWalletPanel");\n` }],
    ["any import of the approval window", { "extension/src/approve.tsx": CLEAN_PANEL.replace("../../lib", "../../src/lib"), "src/components/connect/P.tsx": `import { LocalWalletPanel } from "../../../extension/src/approve";\nexport const v = LocalWalletPanel;\n` }],
  ];
  for (const [name, files] of refused) {
    it(`refuses ${name}`, () => {
      const r = check(files);
      expect(r.out, r.out).toContain("src/components/connect/P.tsx:1");
      expect(r.status).toBe(1);
    });
  }

  const passed: [string, Record<string, string>][] = [
    ["the panel imported by its own name", { [PANEL]: CLEAN_PANEL, "src/components/wallet/WalletHub.tsx": `import { LocalWalletPanel } from "./LocalWalletPanel";\nexport const h = LocalWalletPanel;\n` }],
    ["the panel re-exported by name, renamed, as a type", { [PANEL]: CLEAN_PANEL, "src/components/wallet/index.ts": `export { LocalWalletPanel as Panel } from "./LocalWalletPanel";\nimport { type LocalWalletPanel } from "./LocalWalletPanel";\nexport type T = typeof LocalWalletPanel;\n` }],
    ["an allowed file importing another allowed file wholesale", { [PANEL]: CLEAN_PANEL, "extension/smoke/entry.ts": `import * as L from "../../src/components/wallet/LocalWalletPanel";\nexport const l = L;\n` }],
  ];
  for (const [name, files] of passed) {
    it(`passes ${name}`, () => {
      const r = check(files);
      expect(r.out, r.out).toContain("Keystore boundary OK");
      expect(r.status).toBe(0);
    });
  }
});

describe("check:keystore-boundary — this repo", () => {
  it("passes", () => {
    const r = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
    expect(r.stdout + r.stderr).toContain("Keystore boundary OK");
    expect(r.status).toBe(0);
  });
});
