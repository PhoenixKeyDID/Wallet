/**
 * The popup CSS gate, checked by staging the staleness it exists to catch.
 *
 * Each case builds a tiny source tree and a stylesheet differing from the
 * passing case by exactly one thing, so a red result names its own cause.
 * The last case runs the gate on the real repo: that is the one that goes red
 * when somebody adds a class to a shared component and forgets `popup.css`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
// @ts-expect-error — plain .mjs script, no declaration file
import { analyze, definedClasses, htmlClasses, MAX_UNREADABLE, scanSource } from "../check-popup-css.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "popup-css-"));
  mkdirSync(join(dir, "src"), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function stage(files: Record<string, string>, css: string) {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  writeFileSync(join(dir, "popup.css"), css);
  return analyze({ entries: [join(dir, "src/popup.tsx")], css: join(dir, "popup.css"), root: dir });
}

const missingOf = (r: { missing: { token: string }[] }) => r.missing.map((m) => m.token);

describe("class collection", () => {
  it("passes when every class has a rule", () => {
    const r = stage(
      { "src/popup.tsx": `export const A = () => <div className="flex gap-1" />;` },
      ".flex { display: flex; }\n.gap-1 { gap: .25rem; }",
    );
    expect(missingOf(r)).toEqual([]);
  });

  it("reports a class with no rule", () => {
    const r = stage(
      { "src/popup.tsx": `export const A = () => <div className="flex gap-1" />;` },
      ".flex { display: flex; }",
    );
    expect(missingOf(r)).toEqual(["gap-1"]);
  });

  it("follows relative imports and the @/ alias into other files", () => {
    const r = stage(
      {
        "src/popup.tsx": `import { B } from "./B"; import { C } from "@/deep/C"; export const A = () => <><B /><C /></>;`,
        "src/B.tsx": `export const B = () => <p className="from-b" />;`,
        "src/deep/C.tsx": `export const C = () => <p className="from-c" />;`,
      },
      "",
    );
    expect(missingOf(r)).toEqual(["from-b", "from-c"]);
  });

  it("does not read files the popup never imports", () => {
    const r = stage(
      {
        "src/popup.tsx": `export const A = () => <div className="used" />;`,
        "src/Unused.tsx": `export const U = () => <div className="orphan" />;`,
      },
      ".used { color: red; }",
    );
    expect(missingOf(r)).toEqual([]);
  });

  it("reads both arms of a conditional and the pieces of a template", () => {
    const r = stage(
      {
        "src/popup.tsx":
          "export const A = ({ on }: { on: boolean }) => (<div className={on ? 'arm-a' : 'arm-b'}><i className={`tpl-x ${on ? 'tpl-y' : ''}`} /></div>);",
      },
      "",
    );
    expect(missingOf(r)).toEqual(["arm-a", "arm-b", "tpl-x", "tpl-y"]);
  });

  it("reads a class list kept in a constant, whatever the constant is called", () => {
    const r = stage(
      {
        "src/popup.tsx":
          `const card = "in-card"; const btnCls = "in-btn"; export const A = () => <div className={card}><b className={btnCls} /></div>;`,
      },
      "",
    );
    expect(missingOf(r)).toEqual(["in-btn", "in-card"]);
  });

  it("counts a className it cannot read instead of passing over it silently", () => {
    const r = stage(
      { "src/popup.tsx": `export const A = ({ cls }: { cls: string }) => <div className={cls} />;` },
      "",
    );
    expect(r.dynamic).toBe(1);
    expect(r.missing).toEqual([]);
  });

  it("counts a spread onto a DOM element, not one onto a component", () => {
    const r = stage(
      {
        "src/popup.tsx":
          `const B = (p: object) => <span className="in-b" />;\n` +
          `export const A = (p: object) => <div><div {...p} /><B {...p} /></div>;`,
      },
      ".in-b {}",
    );
    expect(r.unreadable).toEqual([expect.stringMatching(/popup\.tsx:2$/)]);
  });

  it("reads classes written to the DOM by hand, outside JSX", () => {
    const r = stage(
      {
        "src/popup.tsx":
          `const K = { a: "via-table" } as const;\n` +
          `export function paint(el: HTMLElement, k: "a") {\n` +
          `  el.className = "by-assign";\n` +
          `  el.className += " by-append";\n` +
          `  el.setAttribute("class", "by-attr");\n` +
          `  el.classList.add("by-add", "by-add-2");\n` +
          `  el.classList.toggle("by-toggle", true);\n` +
          `  el.classList.replace("taken-away", "by-replace");\n` +
          `  el.className = K[k];\n` +
          `}`,
      },
      "",
    );
    expect(missingOf(r)).toEqual(
      ["by-add", "by-add-2", "by-append", "by-assign", "by-attr", "by-replace", "by-toggle", "via-table"].sort(),
    );
    expect(r.dynamic).toBe(0);
  });

  it("counts a className assigned outside JSX with nothing literal in it", () => {
    const r = stage({ "src/popup.tsx": `export function p(el: HTMLElement, c: string) { el.className = c; el.classList.add(c); }` }, "");
    expect(r.dynamic).toBe(2);
  });

  it("reports an import that does not resolve rather than skipping it", () => {
    const r = stage({ "src/popup.tsx": `import "./Gone"; export const A = () => <div />;` }, "");
    expect(r.problems.join("\n")).toContain("./Gone");
  });
});

describe("stylesheet reading", () => {
  it("unescapes variants, fractions and arbitrary values", () => {
    const set = definedClasses(
      ".hover\\:bg-x\\/20:hover { a: b; }\n.mt-0\\.5 { a: b; }\n.max-w-\\[60\\%\\] { a: b; }",
    );
    expect(set.has("hover:bg-x/20")).toBe(true);
    expect(set.has("mt-0.5")).toBe(true);
    expect(set.has("max-w-[60%]")).toBe(true);
  });

  it("does not count a class that only appears in a comment or a declaration value", () => {
    const set = definedClasses("/* .ghost { } */\n.real { background: url(a.png); }");
    expect(set.has("ghost")).toBe(false);
    expect(set.has("real")).toBe(true);
    expect(set.has("png")).toBe(false);
  });

  it("counts every class in a compound selector and inside @media", () => {
    const set = definedClasses(".a .b, .c:hover { x: y; }\n@media (min-width: 1px) { .d { x: y; } }");
    for (const c of ["a", "b", "c", "d"]) expect(set.has(c), c).toBe(true);
  });

  // `.a:not(.b)` styles what does NOT carry `b`; `.a:has(.b)` styles the parent.
  it("does not count a class named only inside :not() or :has()", () => {
    const set = definedClasses(".a:not(.b) { x: y; }\n.c:has(.d) { x: y; }\n.e:not(:is(.f, .g)) { x: y; }");
    for (const c of ["a", "c", "e"]) expect(set.has(c), c).toBe(true);
    for (const c of ["b", "d", "f", "g"]) expect(set.has(c), c).toBe(false);
  });

  it("still counts a class that has its own rule as well as a :not() mention", () => {
    const set = definedClasses(".a:not(.b) { x: y; }\n.b { x: y; }\n.h:is(.i) { x: y; }");
    expect(set.has("b")).toBe(true);
    expect(set.has("i")).toBe(true);
  });
});

describe("HTML pages", () => {
  it("reads class attributes in any quoting, and not from comments", () => {
    const set = htmlClasses(`<body class="approve-page x"><div class='y'></div><p class=z></p><!-- <i class="ghost"> --></body>`);
    expect([...set].sort()).toEqual(["approve-page", "x", "y", "z"]);
  });

  // Each of these is a tag the browser reads as `class="x"`.
  it.each([
    [`<body/class="x">`],
    [`<body id="r"class="x">`],
    [`<body title="a>b" class="x">`],
    [`<body title='a>b' class=x>`],
    [`<body\nclass="x"\n>`],
    [`<body CLASS="x" class="later">`],
  ])("reads the class of %j the way the browser does", (html) => {
    expect([...htmlClasses(html)]).toEqual(["x"]);
  });

  // The browser closes `<!-->` and `<!--->` at once, and `--!>` closes a
  // comment too: the tag after each is a real tag.
  it.each([
    [`<!--><i class="x"><!-- -->`],
    [`<!---><i class="x"><!-- -->`],
    [`<!-- note --!><i class="x"><!-- -->`],
    [`<!-- a --!> <i class="x"> <!-- <b class="ghost"> -->`],
  ])("ends the comment in %j where the browser does", (html) => {
    expect([...htmlClasses(html)]).toEqual(["x"]);
  });
  it("still hides a tag inside an ordinary comment, and to the end in an unclosed one", () => {
    expect([...htmlClasses(`<!-- - -> <i class="ghost"> --><b class="x">`)]).toEqual(["x"]);
    expect([...htmlClasses(`<b class="x"><!-- <i class="ghost">`)]).toEqual(["x"]);
  });

  it("does not read a class from inside another attribute's value, a script or a style", () => {
    expect([...htmlClasses(`<body title=" class=y">`)]).toEqual([]);
    expect([...htmlClasses(`<body data-x='<p class="y">'>`)]).toEqual([]);
    expect([...htmlClasses(`<script>const s = '<p class="y">';</script><style>p[class="y"]{}</style><i class="z">`)]).toEqual(["z"]);
  });

  it("fails a class the page's own HTML uses with no rule", () => {
    writeFileSync(join(dir, "src/popup.tsx"), `export const A = () => <div className="ok" />;`);
    writeFileSync(join(dir, "page.html"), `<body class="approve-page"><div id="root"></div></body>`);
    writeFileSync(join(dir, "popup.css"), ".ok { x: y; }");
    const r = analyze({ entries: [join(dir, "src/popup.tsx")], css: join(dir, "popup.css"), root: dir, html: [join(dir, "page.html")] });
    expect(missingOf(r)).toEqual(["approve-page"]);
  });

  it("reports an HTML page it cannot read rather than skipping it", () => {
    writeFileSync(join(dir, "src/popup.tsx"), `export const A = () => <div />;`);
    writeFileSync(join(dir, "popup.css"), "");
    const r = analyze({ entries: [join(dir, "src/popup.tsx")], css: join(dir, "popup.css"), root: dir, html: [join(dir, "gone.html")] });
    expect(r.problems.join("\n")).toContain("gone.html");
  });
});

describe("exemptions", () => {
  it("lets breakpoint variants through (a 400px popup never reaches 640px)", () => {
    const r = stage({ "src/popup.tsx": `export const A = () => <div className="sm:grid-cols-3 md:flex" />;` }, "");
    expect(r.missing).toEqual([]);
    expect(r.exempted).toEqual(["md:flex", "sm:grid-cols-3"]);
  });

  it("does NOT let a state variant through", () => {
    const r = stage({ "src/popup.tsx": `export const A = () => <div className="hover:underline" />;` }, "");
    expect(missingOf(r)).toEqual(["hover:underline"]);
  });
});

describe("scanSource", () => {
  it("ignores package imports", () => {
    const r = scanSource("x.tsx", `import React from "react"; import { a } from "./a";`);
    expect(r.imports).toEqual(["react", "./a"]);
  });
});

describe("the real popup", () => {
  it("every class it renders has a rule (CLI exits 0)", () => {
    const run = spawnSync("node", [join(REPO, "scripts", "check-popup-css.mjs")], { encoding: "utf8" });
    expect(run.stdout + run.stderr).toContain("popup CSS OK");
    // Both pages, so a class on approve.html's own <body> is checked too.
    expect(run.stdout).toContain("(2 HTML pages and");
    expect(run.status).toBe(0);
  });

  it("stays within the declared ceiling of className expressions it cannot read", () => {
    const r = analyze({
      entries: [join(REPO, "extension/src/popup.tsx")],
      css: join(REPO, "extension/src/popup.css"),
      aliases: [["@/lib/toast", join(REPO, "extension/src/toast.ts")]],
    });
    // Equal, not at-most: once one site is made readable the ceiling has to come
    // down with it, or a new blind site could take its place unnoticed.
    expect(r.dynamic).toBe(MAX_UNREADABLE);
  });

  it("the CLI exits 1 and names the class when a rule is removed", () => {
    // Same engine, the real source tree, the real stylesheet minus one rule.
    const css = readFileSync(join(REPO, "extension/src/popup.css"), "utf8").replace(
      ".overflow-x-auto { overflow-x: auto; }\n",
      "",
    );
    writeFileSync(join(dir, "popup.css"), css);
    const r = analyze({
      entries: [join(REPO, "extension/src/popup.tsx")],
      css: join(dir, "popup.css"),
      aliases: [["@/lib/toast", join(REPO, "extension/src/toast.ts")]],
    });
    expect(missingOf(r)).toEqual(["overflow-x-auto"]);
  });
});
