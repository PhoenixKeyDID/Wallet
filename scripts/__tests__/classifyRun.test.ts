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

  it.each([
    ["a let read before its line runs", "ReferenceError: Cannot access 'plan' before initialization"],
    ["new on a misspelt class", "TypeError: Bignumber is not a constructor"],
    ["for…of over a misspelt value", "TypeError: outputz is not iterable"],
  ])("grades %s as broken", (_, error) => {
    expect(classifyRun(1, REFERENCE.replace("ReferenceError: flase is not defined", error))).toBe("broken");
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

  // The three below each hold a line every later rule would grade "caught",
  // so each one is red only through the rule its name gives.
  it("grades a failed suite beside test failures in another file as broken", () => {
    const out = [
      BEFORE_ALL.split("\n").slice(0, 3).join("\n"),
      ASSERTION.replace(SUMMARY_FAILED, ""),
      " Test Files  2 failed (2)",
      "      Tests  3 failed | 2 passed (5)",
    ].join("\n");
    expect(classifyRun(1, out)).toBe("broken");
  });

  // A test that imports a module at run time (`await import`, `vi.importActual`)
  // reports a transform failure as its own error, not as a failed suite.
  it("grades a transform failure raised inside a test as broken", () => {
    const out = ASSERTION.replace(
      "AssertionError: expected 1 to be 2 // Object.is equality",
      'Error: Transform failed with 1 error:\nmod-syn.ts:1:44: ERROR: Unexpected ";"',
    );
    expect(out).not.toMatch(/Failed Suites/);
    expect(classifyRun(1, out)).toBe("broken");
  });

  // Vitest prints the failing test's source under the error. A test that
  // quotes "Transform failed" in its source showed it there, and the whole
  // run read "broken" although the test failed on an assertion.
  it("does not read 'Transform failed' in the code frame under an assertion failure", () => {
    const out = ASSERTION.replace(
      "AssertionError: expected 1 to be 2 // Object.is equality",
      "AssertionError: expected 'caught' to be 'broken' // Object.is equality\n" +
        "    158|       'Error: Transform failed with 1 error:\\nmod-syn.ts:1:44: ERROR: Unexpected \";\"',",
    );
    expect(out).toMatch(/Transform failed/);
    expect(classifyRun(1, out)).toBe("caught");
  });

  // The same code frame quoting vitest's section names: a test whose source says
  // "Failed Suites" or "Unhandled Errors" showed them there, and the run read "broken".
  it("does not read 'Failed Suites' or 'Unhandled Errors' in the code frame under an assertion failure", () => {
    for (const quoted of [
      "expect(out).not.toMatch(/Failed Suites/);",
      'const h = "Unhandled Errors";',
      // A fixture line quoted whole: the header's own rule, behind the quote mark.
      '"⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯",',
      '"⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯",',
    ]) {
      const out = ASSERTION.replace(
        "AssertionError: expected 1 to be 2 // Object.is equality",
        `AssertionError: expected 'caught' to be 'broken' // Object.is equality\n    162|     ${quoted}`,
      );
      expect(classifyRun(1, out)).toBe("caught");
    }
  });

  it("does not read a typo-class error quoted in the middle of an assertion message", () => {
    const out = ASSERTION.replace(
      "AssertionError: expected 1 to be 2",
      "AssertionError: expected 'ReferenceError: x is not defined' to be 'ok'",
    );
    expect(classifyRun(1, out)).toBe("caught");
  });

  it("grades a failed run with no test failure at all (vitest did not start) as broken", () => {
    expect(classifyRun(1, "Error: spawn npx ENOENT")).toBe("broken");
  });

  // vitest groups tests that died on the same error under one error line.
  it("reads the error under several FAIL headers in a row", () => {
    const out = REFERENCE.replace(
      " FAIL  scripts/__tests__/zz-probe/ref.test.ts > r",
      " FAIL  scripts/__tests__/zz-probe/ref.test.ts > r\n FAIL  scripts/__tests__/zz-probe/ref.test.ts > r2",
    );
    expect(classifyRun(1, out)).toBe("broken");
  });

  // Round 6: the code under test logged an error it had caught; the run's
  // only failure is an assertion. A `stderr |` block is not a test dying.
  it("does not read a typo-class line the code under test printed on stderr", () => {
    const out = [
      "stderr | scripts/__tests__/zz-probe/assert.test.ts > other",
      "TypeError: provider.fetch is not a function",
      "ReferenceError: flase is not defined",
      "",
      ASSERTION,
    ].join("\n");
    expect(classifyRun(1, out)).toBe("caught");
    expect(classifyRun(1, out, { compiled: true })).toBe("caught");
  });

  // Round 6: a fair mutant on a type-checked file that removes an
  // Array.isArray guard makes the loop throw `is not iterable`. The compiler
  // already refused the misspellings that raise these four.
  const NOT_ITERABLE = REFERENCE.replace("ReferenceError: flase is not defined", "TypeError: utxos is not iterable");
  it.each([
    ["is not iterable", "TypeError: utxos is not iterable"],
    ["is not a function", "TypeError: provider.fetch is not a function"],
    ["is not a constructor", "TypeError: Bignumber is not a constructor"],
    ["before initialization", "ReferenceError: Cannot access 'plan' before initialization"],
  ])("grades `%s` as caught when the mutated files were type-checked", (_, error) => {
    const out = REFERENCE.replace("ReferenceError: flase is not defined", error);
    expect(classifyRun(1, out, { compiled: true })).toBe("caught");
    expect(classifyRun(1, out)).toBe("broken"); // no compile step: still broken
  });
  it("still grades `is not defined` and a SyntaxError as broken after a type-check", () => {
    expect(classifyRun(1, REFERENCE, { compiled: true })).toBe("broken");
    const syntax = REFERENCE.replace("ReferenceError: flase is not defined", "SyntaxError: Invalid regular expression: /[/u: Unterminated character class");
    expect(classifyRun(1, syntax, { compiled: true })).toBe("broken");
    expect(classifyRun(1, NOT_ITERABLE, { compiled: false })).toBe("broken");
  });
});
