/**
 * The compile step the mutation runner takes before any test: a misspelt name
 * in a mutant is broken even where the code under test catches what it throws.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTypechecker, isTypo } from "../lib/typecheck-mutant.mjs";

const REPO = join(__dirname, "..", "..");
const APPROVE = "extension/src/approve.tsx";
const tc = createTypechecker(REPO);
const names = (text: string) => tc.namesOf(text);

describe("isTypo", () => {
  it("counts a name that is not in scope", () => {
    expect(isTypo({ code: 2304, name: "flase" }, names("if (false) {}"))).toBe(true);
    expect(isTypo({ code: 2552, name: "summariseTxx" }, names("summariseTx()"))).toBe(true);
  });

  it("counts an import of a name the module does not export", () => {
    expect(isTypo({ code: 2305, name: "sumariseTx" }, names("import { sumariseTx } from './m';"))).toBe(true);
    expect(isTypo({ code: 2724, name: "sumariseTx" }, names("import { sumariseTx as s } from './m';"))).toBe(true);
  });

  it("counts a property whose name the file never had", () => {
    expect(isTypo({ code: 2339, name: "refusl" }, names("r.refusal"))).toBe(true);
    expect(isTypo({ code: 2551, name: "lovelaces" }, names("x.lovelace"))).toBe(true);
  });

  it("counts an object-literal key the file never had, and not one it has", () => {
    expect(isTypo({ code: 2353, name: "lovelac" }, names("f({ lovelace: 1 })"))).toBe(true);
    expect(isTypo({ code: 2561, name: "lovelac" }, names("f({ lovelace: 1 })"))).toBe(true);
    expect(isTypo({ code: 2353, name: "lovelace" }, names("f({ lovelace: 1 })"))).toBe(false);
    expect(isTypo({ code: 2353, name: "min-ada" }, names('f({ "min-ada": 1 })'))).toBe(false);
  });

  // A removed guard stops narrowing; the property exists on the other member
  // of the union and reads as undefined at run time — a fair mutant.
  it("does not count a property the file already reads", () => {
    expect(isTypo({ code: 2339, name: "refusal" }, names("if (!r.ok) return r.refusal;"))).toBe(false);
    expect(isTypo({ code: 2339, name: "$x" }, names("a.$x"))).toBe(false);
    expect(isTypo({ code: 2339, name: "k" }, names('a["k"]'))).toBe(false);
  });

  // Round 6: `planned.ok` -> `planned.of` passed because a comment held "of".
  it("does not take a word in a comment or a string as a name the file has", () => {
    const text = '// one of the two\n/* of */ const s = "of"; const t = `of`; planned.ok;';
    expect(isTypo({ code: 2339, name: "of" }, names(text))).toBe(true);
    expect(names(text).has("ok")).toBe(true); // the code's own names are read
  });

  it("does not count any other diagnostic", () => {
    expect(isTypo({ code: 2345, name: "Account" }, names(""))).toBe(false);
    expect(isTypo({ code: 18047, name: "summary.collateral" }, names(""))).toBe(false);
  });
});

describe("createTypechecker", () => {
  const src = readFileSync(join(REPO, APPROVE), "utf8");
  const anchor = "const summary = summariseTx(cbor, view.ownAddressesHex";

  it("finds nothing in the unmutated file", () => {
    expect(src.split(anchor).length - 1).toBe(1);
    const r = tc.baseline([APPROVE]);
    expect(r.typo).toEqual([]);
    expect(r.other).toEqual([]);
  });

  // The case that `classifyRun` grades "caught": the catch beside the call
  // swallows the ReferenceError and eleven tests fail on assertions.
  it("flags a misspelt call that the code under test would catch", () => {
    const r = tc.check(new Map([[APPROVE, src.replace(anchor, anchor.replace("summariseTx(", "sumariseTx("))]]));
    expect(r.typo.map((d: { code: number; name: string }) => [d.code, d.name])).toEqual([[2552, "sumariseTx"]]);
  });

  // Round 6 PoC A: "of" is in a comment of approve.tsx, not in its code.
  it("flags a property renamed to a word that only a comment holds", () => {
    const from = "if (!planned.ok) {";
    expect(src.split(from).length - 1).toBe(1);
    expect(src).toMatch(/\bof\b/); // in the text…
    expect(tc.namesOf(src).has("of")).toBe(false); // …but not in the code
    const r = tc.check(new Map([[APPROVE, src.replace(from, "if (!planned.of) {")]]));
    expect(r.typo.map((d: { code: number; name: string }) => [d.code, d.name])).toEqual([[2339, "of"]]);
  });

  // Round 6 PoC C: the misspelling hides behind an alias, so every use of the
  // name still resolves and only the import line is wrong.
  it("flags a misspelt import behind an alias", () => {
    const from = "import { summariseTx, UndescribableTxError";
    expect(src.split(from).length - 1).toBe(1);
    const r = tc.check(new Map([[APPROVE, src.replace(from, "import { sumariseTx as summariseTx, UndescribableTxError")]]));
    expect(r.typo.map((d: { code: number; name: string }) => [d.code, d.name])).toEqual([[2724, "sumariseTx"]]);
  });

  it("flags a syntax error", () => {
    const r = tc.check(new Map([[APPROVE, src.replace(anchor, `${anchor} ) )`)]]));
    expect(r.typo.length).toBeGreaterThan(0);
    expect(r.typo.some((d: { code: number }) => d.code >= 1000 && d.code < 2000)).toBe(true);
  });

  it("reports a file outside tsconfig.json as unchecked rather than clean", () => {
    const r = tc.check(new Map([["scripts/check-popup-css.mjs", "flase;"]]));
    expect(r.unchecked).toEqual(["scripts/check-popup-css.mjs"]);
    expect(r.typo).toEqual([]);
  });

  it("leaves the next check unaffected by the last one's text", () => {
    tc.check(new Map([[APPROVE, src.replace(anchor, anchor.replace("summariseTx(", "sumariseTx("))]]));
    expect(tc.check(new Map([[APPROVE, src]])).typo).toEqual([]);
  });
}, 30_000);
