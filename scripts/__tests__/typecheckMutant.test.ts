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

describe("isTypo", () => {
  it("counts a name that is not in scope", () => {
    expect(isTypo({ code: 2304, name: "flase" }, "if (false) {}")).toBe(true);
    expect(isTypo({ code: 2552, name: "summariseTxx" }, "summariseTx()")).toBe(true);
  });

  it("counts a property whose name the file never had", () => {
    expect(isTypo({ code: 2339, name: "refusl" }, "r.refusal")).toBe(true);
    expect(isTypo({ code: 2551, name: "lovelaces" }, "x.lovelace")).toBe(true);
  });

  // A removed guard stops narrowing; the property exists on the other member
  // of the union and reads as undefined at run time — a fair mutant.
  it("does not count a property the file already reads", () => {
    expect(isTypo({ code: 2339, name: "refusal" }, "if (!r.ok) return r.refusal;")).toBe(false);
    expect(isTypo({ code: 2339, name: "$x" }, "a.$x")).toBe(false);
  });

  it("does not count any other diagnostic", () => {
    expect(isTypo({ code: 2345, name: "Account" }, "")).toBe(false);
    expect(isTypo({ code: 18047, name: "summary.collateral" }, "")).toBe(false);
  });
});

describe("createTypechecker", () => {
  const tc = createTypechecker(REPO);
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
