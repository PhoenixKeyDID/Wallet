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
 * `SyntaxError` (a bad regular expression built at run time is one), each read
 * only at the start of a line, where vitest prints the error a test died on.
 * A mutant whose `to` reads `if (flase)` fails every test that reaches it,
 * with exactly such an error, and before this rule that counted as the guard
 * being pinned — the guard was never measured.
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
export function classifyRun(status, output) {
  // eslint-disable-next-line no-control-regex
  const text = output.replace(/\x1b\[[0-9;]*m/g, "");
  if (status === 0) return "pass";
  if (/Failed Suites|Unhandled Errors?|Transform failed/.test(text)) return "broken";
  if (TYPO_CLASS.test(text)) return "broken";
  if (/Tests\s+\d+ failed/.test(text)) return "caught";
  return "broken";
}

/** An error the mutated text raises by itself, as vitest prints it at the start of a line. */
const TYPO_CLASS = new RegExp(
  "^\\s*(?:" +
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
