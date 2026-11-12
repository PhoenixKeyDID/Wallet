/**
 * How the mutation runner grades one vitest run.
 *
 * Each output below is cut from a real vitest 2.1.9 run of a one-test file
 * built to fail that way (2026-11-12), keeping the lines the grader reads. A
 * mutant whose `to` has a typo — `if (flase)` — fails every test that reaches
 * it with a ReferenceError, and the runner used to grade that "caught": the
 * guard the mutant removes was never measured, yet the line said RED.
 */
import { describe, it, expect } from "vitest";
import { classifyRun } from "../lib/classify-run.mjs";

const SUMMARY_FAILED = " Test Files  1 failed (1)\n      Tests  1 failed (1)\n";

const ASSERTION = [
  "   × a 4ms",
  "     → expected 1 to be 2 // Object.is equality",
  "⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯",
  " FAIL  scripts/__tests__/zz-probe/assert.test.ts > a",
  "AssertionError: expected 1 to be 2 // Object.is equality",
  "- Expected",
  "+ Received",
  SUMMARY_FAILED,
].join("\n");

const REFERENCE = [
  "   × r 3ms",
  "     → flase is not defined",
  "⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯",
  " FAIL  scripts/__tests__/zz-probe/ref.test.ts > r",
  "ReferenceError: flase is not defined",
  " ❯ Module.f scripts/__tests__/zz-probe/mod-ref.ts:1:39",
  SUMMARY_FAILED,
].join("\n");

const NOT_A_FUNCTION = [
  "   × n 2ms",
  "     → o.go is not a function",
  " FAIL  scripts/__tests__/zz-probe/notfn.test.ts > n",
  "TypeError: o.go is not a function",
  SUMMARY_FAILED,
].join("\n");

const TRANSFORM = [
  "⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯",
  " FAIL  scripts/__tests__/zz-probe/syn.test.ts [ scripts/__tests__/zz-probe/syn.test.ts ]",
  "Error: Transform failed with 1 error:",
  "mod-syn.ts:1:44: ERROR: Unexpected \";\"",
  " Test Files  1 failed (1)",
  "      Tests  no tests",
].join("\n");

const BEFORE_ALL = [
  "⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯",
  " FAIL  scripts/__tests__/zz-probe/before.test.ts [ scripts/__tests__/zz-probe/before.test.ts ]",
  "Error: boom",
  " Test Files  1 failed (1)",
  "      Tests  1 skipped (1)",
].join("\n");

const UNHANDLED_WITH_ASSERTION = [
  " FAIL  scripts/__tests__/zz-probe/unh.test.ts > u",
  "AssertionError: expected 1 to be 2 // Object.is equality",
  "⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯",
  "Vitest caught 1 unhandled error during the test run.",
  "This might cause false positive tests. Resolve unhandled errors to make sure your tests are not affected.",
  "Error: late",
  " Test Files  1 failed (1)",
  "      Tests  1 failed | 1 passed (2)",
  "     Errors  1 error",
].join("\n");

describe("classifyRun", () => {
  it("grades an exit of 0 as pass", () => {
    expect(classifyRun(0, " Test Files  1 passed (1)\n      Tests  1 passed (1)\n")).toBe("pass");
  });

  it("grades an assertion failure as caught", () => {
    expect(classifyRun(1, ASSERTION)).toBe("caught");
  });

  it("reads through colour codes", () => {
    const coloured = ASSERTION.replace("AssertionError", "\x1b[31mAssertionError\x1b[39m").replace(
      "Tests  1 failed",
      "Tests  \x1b[1m\x1b[31m1 failed\x1b[39m\x1b[22m",
    );
    expect(classifyRun(1, coloured)).toBe("caught");
  });

  it("grades a ReferenceError raised inside a test as broken, not caught", () => {
    expect(classifyRun(1, REFERENCE)).toBe("broken");
  });

  it("grades `is not a function` as broken", () => {
    expect(classifyRun(1, NOT_A_FUNCTION)).toBe("broken");
  });

  it("grades a SyntaxError raised at run time (a bad regular expression) as broken", () => {
    const out = REFERENCE.replace("ReferenceError: flase is not defined", "SyntaxError: Invalid regular expression: /[/u: Unterminated character class");
    expect(classifyRun(1, out)).toBe("broken");
  });

  it("grades a transform (syntax) failure while loading as broken", () => {
    expect(classifyRun(1, TRANSFORM)).toBe("broken");
  });

  // Decision: one typo-class failure discredits the run, even beside a real
  // assertion failure — the mutant did not run as written.
  it("grades a ReferenceError beside an assertion failure as broken", () => {
    expect(classifyRun(1, `${ASSERTION}\n${REFERENCE}`)).toBe("broken");
  });

  // Decision: vitest says an unhandled error "might cause false positive
  // tests"; a run the runner calls unreliable does not pin a guard.
  it("grades Unhandled Errors with an assertion failure as broken", () => {
    expect(classifyRun(1, UNHANDLED_WITH_ASSERTION)).toBe("broken");
  });

  // Accepted over-report: a beforeAll that throws is a failed suite, so it is
  // broken even if the throw was the behaviour change.
  it("grades a beforeAll that throws as broken", () => {
    expect(classifyRun(1, BEFORE_ALL)).toBe("broken");
  });

  it("grades a test that fails on an ordinary thrown error as caught", () => {
    const out = ASSERTION.replace("AssertionError: expected 1 to be 2 // Object.is equality", "TypeError: Cannot read properties of undefined (reading 'lovelace')");
    expect(classifyRun(1, out)).toBe("caught");
  });

  it("does not mistake an assertion message that quotes `is not defined` for a ReferenceError", () => {
    const out = ASSERTION.replace("AssertionError: expected 1 to be 2", "AssertionError: expected 'x is not defined' to be 'ok'");
    expect(classifyRun(1, out)).toBe("caught");
  });

  it("grades a failed run with no test failure at all (vitest did not start) as broken", () => {
    expect(classifyRun(1, "Error: spawn npx ENOENT")).toBe("broken");
  });
});
