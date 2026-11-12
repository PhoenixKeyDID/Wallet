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
  files: Record<string, string | Buffer>,
  opts: { tsconfig?: string; link?: [string, string]; viaSymlinkedRoot?: boolean } = {},
) {
  const outer = mkdtempSync(join(tmpdir(), "keystore-boundary-"));
  const root = join(outer, "real");
  mkdirSync(root);
  try {
    const tree: Record<string, string | Buffer> = {
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
    expect(r.out).toContain("scripts/__tests__/*.test.* are not read unless imported (1 skipped)");
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

describe("check:keystore-boundary — globs are matched against the files that exist", () => {
  const PANEL = "src/components/wallet/LocalWalletPanel.tsx";
  const LEAKY_PANEL = `export * from "../../lib/keystore";\nexport const LocalWalletPanel = 1;\n`;
  const refused: [string, string, Record<string, string>?][] = [
    ["a recursive glob over the directory above the keystore", `import.meta.glob("../lib/**/*.ts", { eager: true })`],
    ["a one-level wildcard above a keystore module name", `import.meta.glob("../lib/*/vault.ts", { eager: true })`],
    ["a brace set naming the keystore", `import.meta.glob("../lib/{other,keystore/vault}.ts")`],
    ["a ? wildcard inside the directory name", `import.meta.glob("../lib/k?ystore/*.ts")`],
    ["a character class inside the directory name", `import.meta.glob("../lib/[k]eystore/*.ts")`],
    ["a glob through the @/ alias", `import.meta.glob("@/lib/**/vault.ts")`],
    ["a root-relative glob", `import.meta.glob("/src/**/vault.ts")`],
    ["a glob loading the sealed LocalWalletPanel", `import.meta.glob("./wallet/*.tsx", { eager: true })`, { [PANEL]: LEAKY_PANEL }],
    ["a glob whose pattern is a variable", `import.meta.glob(pattern)`],
    ["a glob whose pattern is an interpolating template", "import.meta.glob(`../lib/${dir}/*.ts`)"],
    ["a glob whose array holds an expression", `import.meta.glob(["../lib/other.ts", base + "/*.ts"])`],
    ["a glob with an extglob", `import.meta.glob("../lib/@(keystore)/*.ts")`],
    ["a glob with a comment before the parenthesis", `import.meta.glob /* x */ ("../lib/**/*.ts")`],
  ];
  for (const [name, call, extra] of refused) {
    it(`refuses ${name}`, () => {
      const r = check({ "src/components/Panel.tsx": `const pattern = "x", dir = "y", base = "z";\nexport const m = ${call};\n`, ...(extra ?? {}) });
      expect(r.out, r.out).toContain("src/components/Panel.tsx:2");
      expect(r.status).toBe(1);
    });
  }

  const passed: [string, string, Record<string, string>?][] = [
    ["a recursive glob that matches only files beside the keystore", `import.meta.glob("../lib/**/other.ts")`],
    ["a wildcard over a directory holding no keystore file", `import.meta.glob("./wallet/*.tsx")`, { "src/components/wallet/WatchPanel.tsx": "export const W = 1;\n" }],
    ["a brace set naming only files beside the keystore", `import.meta.glob("../lib/{other,missing}.ts")`],
  ];
  for (const [name, call, extra] of passed) {
    it(`passes ${name}`, () => {
      const r = check({ "src/components/Panel.tsx": `export const m = ${call};\n`, ...(extra ?? {}) });
      expect(r.out, r.out).toContain("Keystore boundary OK");
      expect(r.status).toBe(0);
    });
  }

  it("passes prose that names import.meta.glob without calling it", () => {
    const r = check({ "src/components/Panel.tsx": "// import.meta.glob loads modules by pattern\nexport const p = 1;\n" });
    expect(r.out, r.out).toContain("Keystore boundary OK");
    expect(r.status).toBe(0);
  });
});

describe("check:keystore-boundary — a relay is found by the import that reaches it", () => {
  const refused: [string, Record<string, string>, string][] = [
    ["docs/", { "docs/relay.ts": `export * from "../src/lib/keystore";\n`, "src/components/Panel.tsx": `export * from "../../docs/relay";\n` }, "docs/relay.ts:1"],
    ["locales/", { "locales/relay.ts": `export * from "../src/lib/keystore";\n`, "src/components/Panel.tsx": `export * from "../../locales/relay";\n` }, "locales/relay.ts:1"],
    [".github/", { ".github/relay.ts": `export * from "../src/lib/keystore";\n`, "src/components/Panel.tsx": `export * from "../../.github/relay";\n` }, ".github/relay.ts:1"],
    ["a test file skipped by name", { "scripts/__tests__/relay.test.ts": `export * from "../../src/lib/keystore";\n`, "src/components/Panel.tsx": `export * from "../../scripts/__tests__/relay.test";\n` }, "scripts/__tests__/relay.test.ts:1"],
    ["two hops through docs/", { "docs/a.ts": `export * from "./b";\n`, "docs/b.ts": `export * from "../src/lib/keystore";\n`, "src/components/Panel.tsx": `export * from "../../docs/a";\n` }, "docs/b.ts:1 (read because docs/a.ts imports it)"],
    ["a dynamic import into docs/", { "docs/relay.ts": `export * from "../src/lib/keystore";\n`, "src/components/Panel.tsx": `export const l = () => import("../../docs/relay");\n` }, "docs/relay.ts:1"],
    ["a glob into docs/", { "docs/relay.ts": `export * from "../src/lib/keystore";\n`, "src/components/Panel.tsx": `export const m = import.meta.glob("../../docs/*.ts", { eager: true });\n` }, "docs/relay.ts:1"],
  ];
  for (const [name, files, site] of refused) {
    it(`refuses a relay through ${name}`, () => {
      const r = check(files);
      expect(r.out, r.out).toContain(site.includes("read because") ? site : `${site} (read because src/components/Panel.tsx imports it)`);
      expect(r.status).toBe(1);
    });
  }

  it("passes a docs/ file that re-exports the keystore when nothing imports it", () => {
    const r = check({ "docs/relay.ts": `export * from "../src/lib/keystore";\n` });
    expect(r.out, r.out).toContain("Keystore boundary OK");
    expect(r.status).toBe(0);
  });

  it("passes a clean docs/ module that a panel imports, and counts it", () => {
    const r = check({ "docs/table.ts": `export const t = 1;\n`, "src/components/Panel.tsx": `export { t } from "../../docs/table";\n` });
    expect(r.out, r.out).toContain("Keystore boundary OK");
    expect(r.out).toContain("(1 outside those)");
    expect(r.status).toBe(0);
  });
});

describe("check:keystore-boundary — package.json imports", () => {
  const cases: [string, unknown, string][] = [
    ["an exact key", { "#k": "./src/lib/keystore/index.ts" }, `export * from "#k";`],
    ["a key under conditions", { "#k": { node: "./src/lib/other.ts", default: "./src/lib/keystore/index.ts" } }, `export * from "#k";`],
    ["a wildcard key", { "#ks/*": "./src/lib/keystore/*.ts" }, `import { vault } from "#ks/vault";\nexport { vault };`],
  ];
  for (const [name, imports, text] of cases) {
    it(`refuses ${name}`, () => {
      const r = check({ "package.json": JSON.stringify({ name: "x", imports }), "src/components/Panel.tsx": text + "\n" });
      expect(r.out, r.out).toContain("src/components/Panel.tsx:1");
      expect(r.status).toBe(1);
    });
  }

  it("passes a # alias that resolves beside the keystore", () => {
    const r = check({ "package.json": JSON.stringify({ name: "x", imports: { "#o": "./src/lib/other.ts" } }), "src/components/Panel.tsx": `export * from "#o";\n` });
    expect(r.out, r.out).toContain("Keystore boundary OK");
    expect(r.status).toBe(0);
  });

  it("fails on a package.json it cannot parse, rather than resolving without it", () => {
    const r = check({ "package.json": "{ nope", "src/components/Panel.tsx": `export * from "#k";\n` });
    expect(r.out, r.out).toContain("cannot parse package.json");
    expect(r.status).toBe(1);
  });
});

describe("check:keystore-boundary — string names in an import clause", () => {
  const PANEL = "src/components/wallet/LocalWalletPanel.tsx";
  const CLEAN_PANEL = `import { vault } from "../../lib/keystore/vault";\nexport function LocalWalletPanel() { return vault; }\n`;
  const refused: [string, string][] = [
    ["a re-export under a string name", `export { vault as "v" } from "../lib/keystore";`],
    ["an import of a string name", `import { "vault" as v } from "../lib/keystore";\nexport { v };`],
    ["a string name with a comma inside", `import { "a,b" as v, vault } from "../lib/keystore";\nexport { v, vault };`],
  ];
  for (const [name, text] of refused) {
    it(`refuses ${name}`, () => {
      const r = check({ "src/components/Panel.tsx": text + "\n" });
      expect(r.out, r.out).toContain("src/components/Panel.tsx:1");
      expect(r.status).toBe(1);
    });
  }

  it("passes the sealed panel imported by its name spelled as a string", () => {
    const r = check({ [PANEL]: CLEAN_PANEL, "src/components/wallet/Hub.tsx": `import { "LocalWalletPanel" as P } from "./LocalWalletPanel";\nexport const h = P;\n` });
    expect(r.out, r.out).toContain("Keystore boundary OK");
    expect(r.status).toBe(0);
  });

  it("refuses a string name the sealed panel may not hand out", () => {
    const r = check({ [PANEL]: CLEAN_PANEL, "src/components/connect/P.tsx": `import { "vault" as v } from "../wallet/LocalWalletPanel";\nexport const x = v;\n` });
    expect(r.out, r.out).toContain("src/components/connect/P.tsx:1");
    expect(r.status).toBe(1);
  });

  it("passes a string-named re-export of a module beside the keystore", () => {
    const r = check({ "src/components/Panel.tsx": `export { other as "o" } from "../lib/other";\n` });
    expect(r.out, r.out).toContain("Keystore boundary OK");
    expect(r.status).toBe(0);
  });
});

describe("check:keystore-boundary — a source file it cannot read as text", () => {
  it("fails on a UTF-16 source file", () => {
    const body = Buffer.from(`export * from "../lib/keystore";\n`, "utf16le");
    const r = check({ "src/components/Panel.ts": Buffer.concat([Buffer.from([0xff, 0xfe]), body]) });
    expect(r.out, r.out).toContain("src/components/Panel.ts is UTF-16");
    expect(r.status).toBe(1);
  });

  it("fails on a source file with a NUL byte", () => {
    const r = check({ "src/components/Panel.ts": `// \u0000\nexport const p = 1;\n` });
    expect(r.out, r.out).toContain("src/components/Panel.ts has a NUL byte");
    expect(r.status).toBe(1);
  });
});

describe("check:keystore-boundary — read from the syntax tree, not the spelling", () => {
  // Each of these compiles, esbuild bundles the vault for each, and each printed
  // OK while the edges were read by patterns over the text: a clause pattern
  // that knew only ASCII names, and specifiers compared before their escapes
  // were decoded.
  const PANEL = "src/components/wallet/LocalWalletPanel.tsx";
  const CLEAN_PANEL = `import { vault } from "../../lib/keystore/vault";\nexport function LocalWalletPanel() { return vault; }\n`;
  const refused: [string, string][] = [
    ["a Vietnamese local name", `import { vault as độDài } from "../lib/keystore/vault";\nexport const n = độDài;`],
    ["a Cyrillic namespace name", `import * as ключ from "../lib/keystore/vault";\nexport const n = ключ;`],
    ["a local name spelled with a unicode escape", `import { vault as \\u006d } from "../lib/keystore/vault";\nexport const n = m;`],
    ["a specifier with its dots as unicode escapes", `import { vault } from "\\u002e\\u002e/lib/keystore/vault";\nexport const n = vault;`],
    ["a specifier with its slashes as hex escapes", `import { vault } from "..\\x2flib\\x2fkeystore\\x2fvault";\nexport const n = vault;`],
    ["a dynamic import with an escaped specifier", `export const f = () => import("..\\u002flib/keystore/vault");`],
    ["a re-export with an escaped specifier", `export * from "../lib/k\\u0065ystore";`],
    ["an import after JSX text with an apostrophe", `export const A = () => <p>don't</p>;\nexport const f = () => import("../lib/keystore/vault");`],
    ["a dynamic import of a variable", `export const f = (m: string) => import(m);`],
    ["a dynamic import of a template that interpolates", `const d = "keystore";\nexport const f = () => import(\`../lib/\${d}/vault\`);`],
    ["a require of a concatenation", `declare const require: (m: string) => unknown;\nexport const v = require("../lib/" + "keystore");`],
  ];
  for (const [name, text] of refused) {
    it(`refuses ${name}`, () => {
      const r = check({ "src/components/Panel.tsx": text + "\n" });
      expect(r.out, r.out).toContain("Keystore boundary FAILED");
      expect(r.out).toContain("src/components/Panel.tsx:");
      expect(r.status).toBe(1);
    });
  }

  it("reports the line of the statement, not of the comment before it or the name inside it", () => {
    const r = check({
      "src/components/Panel.tsx": `export const a = 1;\n/** doc */ import {\n  vault as độDài,\n} from "../lib/keystore/vault";\nexport const n = độDài;\n`,
    });
    expect(r.out, r.out).toContain("src/components/Panel.tsx:2 imports");
    expect(r.status).toBe(1);
  });

  it("refuses a file it cannot parse, rather than reading nothing in it", () => {
    const r = check({ "src/components/Panel.tsx": `export const a = (;\n` });
    expect(r.out, r.out).toContain("src/components/Panel.tsx:1 does not parse");
    expect(r.status).toBe(1);
  });

  it("refuses an escaped name the sealed panel may not hand out", () => {
    const r = check({ [PANEL]: CLEAN_PANEL, "src/components/connect/P.tsx": `import { v\\u0061ult } from "../wallet/LocalWalletPanel";\nexport const x = vault;\n` });
    expect(r.out, r.out).toContain("takes vault from allowed");
    expect(r.status).toBe(1);
  });

  const ok: [string, Record<string, string>][] = [
    ["the sealed panel imported by its name spelled with an escape", { [PANEL]: CLEAN_PANEL, "src/components/wallet/Hub.tsx": `import { L\\u006fcalWalletPanel as P } from "./LocalWalletPanel";\nexport const h = P;\n` }],
    ["a non-ASCII name imported from beside the keystore", { "src/components/Panel.tsx": `import { other as khác } from "../lib/other";\nexport const n = khác;\n` }],
    ["an import of the keystore spelled only in a comment", { "src/components/Panel.tsx": `// import { vault } from "../lib/keystore/vault";\nexport const a = 1;\n` }],
    ["an import of the keystore spelled only inside a string", { "src/components/Panel.tsx": `export const doc = 'import { vault } from "../lib/keystore/vault"';\n` }],
    ["a new URL of a variable, which names no module", { "src/components/Panel.tsx": `export const u = (h: string) => new URL(h);\n` }],
  ];
  for (const [name, files] of ok) {
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
