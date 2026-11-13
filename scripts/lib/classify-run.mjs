/**
 * What one vitest run says about a mutated tree: "pass", "caught" or "broken".
 *
 * Kept out of `mutants.mjs` so a test can import it without starting a
 * mutation run — that file runs its whole list at module load.
 *
 *   - "pass"   — the run exited 0.
 *   - "caught" — at least one test ran and failed, and none of the failures
 *                is an error that the mutated text itself would raise.
 *   - "broken" — the run failed without a test failing on behaviour: a suite
 *                that did not load (syntax error, transform failure, an import
 *                that threw, a `beforeAll` that threw), an unhandled error, or
 *                a test that died on a typo-class error.
 *
 * Typo-class errors are `ReferenceError: … is not defined`, `ReferenceError:
 * Cannot access '…' before initialization`, `TypeError: … is not a function`,
 * `TypeError: … is not a constructor`, `TypeError: … is not iterable` and any
 * `SyntaxError` (a bad regular expression built at run time is one). A
 * mutant whose `to` reads `if (flase)` fails every test that reaches it, with
 * exactly such an error, and before this rule that counted as the guard
 * being pinned — the guard was never measured.
 *
 * Two limits on where they are read:
 *
 *   - Only as the error a test died on: the first line after the ` FAIL  …`
 *     header(s) vitest prints for a failed test. Anywhere else — a
 *     `stderr | …` block where the code under test logged an error it caught
 *     — the line is the program talking, not the test dying, and reading it
 *     made a fair mutant "broken" because some other code path logged.
 *   - `compiled: true` (every file the mutant edits was type-checked first,
 *     see `scripts/lib/typecheck-mutant.mjs`) keeps only the two that the
 *     compiler can miss or that no fair mutant raises: `SyntaxError` (a
 *     regular expression built from a string) and `… is not defined`. The
 *     other four are what a fair mutant does when it removes a guard — drop
 *     an `Array.isArray` check and the loop throws `… is not iterable` — and
 *     the misspellings that raise them (a property the type does not have)
 *     are already compile errors. For a file the type-check does not cover
 *     (`scripts/*.mjs`, CSS) all six still count: there is no other net.
 *
 * ## What is NOT measured here, said out loud
 *
 * This reads vitest's output, so it only sees an error that reaches it.
 *
 *   - A `catch` in the code under test that swallows the typo's error. The
 *     tests then fail on assertions and the run reads "caught". Measured
 *     2026-11-12: `summariseTx(` misspelt in `extension/src/approve.tsx`, the
 *     `catch` beside it turns the ReferenceError into the "cannot read this
 *     transaction" screen, eleven tests fail on assertions. That road is
 *     closed one step earlier, not here: `mutants.mjs` type-checks every
 *     mutant before a test runs (`scripts/lib/typecheck-mutant.mjs`), and a
 *     name that does not exist is a compile error whatever catches it later.
 *   - The same swallow in a file the type-check does not cover — anything
 *     outside `tsconfig.json`, which is every `scripts/*.mjs` gate. A typo in
 *     a mutant of a gate script that the gate catches is still read "caught".
 *   - A React event handler that throws under jsdom/happy-dom: the error is
 *     reported to the window, not to the test, and may not fail the run.
 *   - A "typo" that lands on a name that does exist (`amount` for `amounts`).
 *     It runs, it compiles, and it is a different mutant from the one named;
 *     nothing short of reading the `to` text catches it.
 *
 * Decisions, each tested in `scripts/__tests__/classifyRun.test.ts`:
 *
 *   - One typo-class failure makes the whole run "broken", even when another
 *     test failed on an assertion. The mutant did not run as written, so the
 *     assertion failure cannot be credited to the guard it removes.
 *   - "Unhandled Errors" with an assertion failure is "broken". Vitest itself
 *     warns that an unhandled error "might cause false positive tests"; a
 *     result the runner calls unreliable is not evidence a guard is pinned.
 *   - A test that fails on some other thrown error (`Error: …`, `TypeError:
 *     Cannot read properties of undefined`) is "caught": that is the code
 *     under test behaving differently, not the mutant failing to parse.
 *   - A `beforeAll` that throws reads as a failed suite, so it is "broken"
 *     even when the throw was the behaviour change. Rare, and the error is on
 *     the cautious side: the mutant is reported, not silently credited.
 */
export function classifyRun(status, output, { compiled = false } = {}) {
  // eslint-disable-next-line no-control-regex
  const text = output.replace(/\x1b\[[0-9;]*m/g, "");
  if (status === 0) return "pass";
  if (SECTION_HEADER.test(text) || TRANSFORM_FAILED.test(text)) return "broken";
  if ((compiled ? COMPILER_MISSES : TYPO_CLASS).test(text)) return "broken";
  if (/Tests\s+\d+ failed/.test(text)) return "caught";
  return "broken";
}

/**
 * A ` FAIL  file > test` header, then the line holding the error the test died on. When vitest
 * groups several headers over one error, the last header is the line before it, so one header is enough.
 */
const AFTER_FAIL = "^[ \\t]*FAIL[ \\t][^\\n]*\\n[ \\t]*(?:";
/** An error the mutated text raises by itself, read where vitest prints the error a test died on. */
const TYPO_CLASS = new RegExp(
  AFTER_FAIL +
    [
      "ReferenceError: .* is not defined",
      "ReferenceError: Cannot access '.*' before initialization",
      "TypeError: .* is not a function",
      "TypeError: .* is not a constructor",
      "TypeError: .* is not iterable",
      "SyntaxError: ",
    ].join("|") +
    ")",
  "m",
);
/**
 * Vitest's own "Failed Suites N" and "Unhandled Errors" section headers, read only as the
 * header line vitest draws (a rule of `⎯` either side). Read anywhere, the words matched the
 * code frame of a failing test that quotes them (this grader's own tests do), and a run that
 * failed on an assertion read "broken".
 */
const SECTION_HEADER = new RegExp("^[ \\t]*⎯+ (?:" + ["Failed Suites \\d+", "Unhandled Errors?"].join("|") + ") ⎯+", "m");
/**
 * A transform failure a test died on — read where the error a test died on is
 * printed, like the typo class, not anywhere. Vitest prints a code frame of the
 * failing test's source under the error, so a test whose source quotes
 * "Transform failed" (this grader's own tests do) made every run that failed it
 * read "broken", whatever it failed on. `SECTION_HEADER` above had the same fault.
 */
const TRANSFORM_FAILED = new RegExp(AFTER_FAIL + "Error: Transform failed)", "m");
/** The part of `TYPO_CLASS` that still counts after the type-check passed. */
const COMPILER_MISSES = new RegExp(AFTER_FAIL + ["ReferenceError: .* is not defined", "SyntaxError: "].join("|") + ")", "m");
