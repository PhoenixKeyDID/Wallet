/**
 * A redirect on the chain read is refused, not followed.
 *
 * Nothing guarded this. Turning `assertNoRedirect` into a no-op left the suite
 * fully green, which is the shape of a rule that exists only in a comment.
 *
 * What it protects is a sentence the wallet already shows: the receive screen
 * names one host as the party that learns which addresses this wallet looks up.
 * A redirect makes that sentence false — the addresses go somewhere the screen
 * did not name — and it does so silently, because a followed redirect answers
 * with ordinary-looking data. That is why this is refused rather than logged.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { assertNoRedirect, bfTipSlot, bfSubmitTx } from "../blockfrost";
import { koios, submitTx } from "../provider";
import { fetchAdaPrice, forgetPrice } from "../price";

/** The shape Node returns under `redirect: "manual"`: the real 3xx. */
const nodeRedirect = (status: number) =>
  ({ type: "default", status }) as unknown as Response;

/** The shape a browser returns under `redirect: "manual"`: opaque, status 0. */
const browserRedirect = () =>
  ({ type: "opaqueredirect", status: 0 }) as unknown as Response;

const ok = () => ({ type: "default", status: 200 }) as unknown as Response;

const BASE = "https://api.koios.rest/api/v1";

describe("assertNoRedirect > refuses a redirect on both runtimes", () => {
  it("refuses the real 3xx Node hands back", () => {
    // 308 rather than 301: a permanent redirect is the one an operator adds on
    // purpose and never thinks about again, so it is the one that would sit in
    // front of a wallet for months.
    expect(() => assertNoRedirect(nodeRedirect(308), "/address_info", BASE)).toThrow();
  });

  it("refuses the opaque response a browser hands back", () => {
    // Status 0, so any check written as `status >= 300` alone passes it — and
    // the browser is the runtime that actually ships. A check that understood
    // only the Node shape would be green here and inert in the extension.
    expect(() => assertNoRedirect(browserRedirect(), "/address_info", BASE)).toThrow();
  });

  it("names the host the receive screen names, and what to do", () => {
    // The message has a job beyond being red: a redirect looks identical to a
    // misconfigured endpoint from the outside, and without the host in the
    // sentence the reader has no way to tell which one they are looking at.
    let message = "";
    try {
      assertNoRedirect(nodeRedirect(302), "/address_info", BASE);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("api.koios.rest");
    expect(message).toContain("/address_info");
    expect(message).toMatch(/final address/);
  });

  it("lets an ordinary answer through", () => {
    // The direction that decides whether the rule survives: a check that also
    // refuses correct responses is a check somebody deletes.
    expect(() => assertNoRedirect(ok(), "/address_info", BASE)).not.toThrow();
  });

  it("lets a 4xx through, because that is the error path's business", () => {
    // A 404 on this route means "this address has never appeared on chain",
    // which `NotOnChainError` reads further down. Swallowing it here would turn
    // a new wallet into a broken one.
    expect(() =>
      assertNoRedirect({ type: "default", status: 404 } as unknown as Response, "/address_info", BASE),
    ).not.toThrow();
  });
});

/**
 * The wiring, which is a separate question from the rule.
 *
 * The cases above prove `assertNoRedirect` refuses a redirect. They prove
 * nothing about whether anything calls it, or whether the `fetch` beneath it
 * was told not to follow the redirect in the first place. Measured: deleting
 * `redirect: "manual"` from all four call sites left the suite at 521 green,
 * and so did deleting all four `assertNoRedirect(…)` lines. Two one-line
 * deletions, either of which silently retires the guarantee.
 *
 * The failure is silent by construction, which is why it needs a test rather
 * than a reviewer: a followed redirect answers `200` with ordinary-looking
 * JSON, from a host the receive screen never named.
 */
const SIGNED_TX = "84a300818258" + "00".repeat(40);

/**
 * Every outbound path, so a new one cannot be added without being seen.
 *
 * The price service is here even though it is not the chain: the README names
 * the indexer and the price service as the only hosts this wallet contacts, and
 * a followed redirect makes that sentence false in the place nobody checks — the
 * price arrives, the figure is plausible, and a third party nobody listed has
 * seen each user's IP. Exactly one path is deliberately absent — the backend
 * client in `src/lib/api.ts`, argued at its own call site — and the case below
 * is what makes a second absence something somebody has to decide about rather
 * than something nobody sees.
 */
const CHAIN_CALLS: Array<{ name: string; run: () => Promise<unknown> }> = [
  { name: "koios read", run: () => koios(0, "/tip") },
  { name: "koios submit", run: () => submitTx(0, SIGNED_TX) },
  { name: "blockfrost read", run: () => bfTipSlot({ base: "https://example.invalid/api/v0" }) },
  {
    name: "blockfrost submit",
    run: () => bfSubmitTx({ base: "https://example.invalid/api/v0" }, SIGNED_TX),
  },
  // `forgetPrice()` first: a cached reading short-circuits the fetch, and a
  // case that never reaches the network proves nothing about it either way.
  {
    name: "price service",
    run: () => {
      forgetPrice();
      return fetchAdaPrice("usd");
    },
  },
];

afterEach(() => vi.unstubAllGlobals());

describe("chain reads > every call site tells fetch not to follow a redirect", () => {
  for (const { name, run } of CHAIN_CALLS) {
    it(`${name} passes redirect: "manual"`, async () => {
      // Asserted at the call, not at the response. A caller that omits this
      // never sees a 3xx at all — `fetch` follows it and hands back the final
      // reply — so `assertNoRedirect` downstream is looking at the wrong host's
      // answer and finds nothing wrong with it.
      const seen: RequestInit[] = [];
      vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
        seen.push(init);
        return Promise.resolve(
          new Response("[]", { status: 200, headers: { "content-type": "application/json" } }),
        );
      });
      await run().catch(() => {
        // Shape errors past the fetch are none of this case's business; the
        // question is only what was handed to `fetch`.
      });
      expect(seen.length).toBeGreaterThan(0);
      for (const init of seen) expect(init.redirect).toBe("manual");
    });
  }
});

/**
 * Every `.ts`/`.tsx` under `src/` that is not itself a test.
 *
 * Walked, not listed. The first version of the case below named four files and
 * called itself "finds no fetch in src/" — so a `fetch` added to any fifth file
 * was exactly the silent gap it claimed to close. Measured: a new call site in
 * `src/lib/cardano/history.ts` left the suite at 569 green.
 */
function sourceFilesUnderSrc(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__") sourceFilesUnderSrc(full, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Calls to `fetch`, counted with the language's own scanner.
 *
 * Two hand-written versions of this were wrong, in opposite directions, and the
 * second was wrong in a way this repo had already written down. Kept here
 * because the reasoning is not obvious from the fix.
 *
 * Version one, `(?<![.\w])fetch\(`, excluded every member spelling on purpose —
 * which is exactly the spelling somebody reaching past this rule would use.
 * `globalThis.fetch(` and `globalThis["fetch"](` both left the suite green.
 *
 * Version two widened the pattern and stripped comments first with two regexes.
 * That is the mistake `scripts/check-extension-package.mjs` documents in its own
 * host scan: stripping answers by elimination, and gets it wrong on code that
 * compiles. `provider.ts` has a prose line reading ``content-range: 0-999/*`` —
 * `/*` inside a `//` comment — which opened a phantom block that ran to the next
 * `*` + `/` fifty-seven lines below. Measured: a `fetch` to an unnamed host
 * placed inside `koios()`, the function every Koios read goes through, left all
 * 576 tests green; the same line forty-three lines lower turned the table red.
 * The same version also counted the word inside a string, so an error message
 * mentioning `fetch(url)` failed the suite for nothing.
 *
 * Wrong in both directions means the predicate was measuring the wrong thing, so
 * this parses instead of trying a third pattern. It counts call expressions whose
 * callee names `fetch`, which is the property the rule is actually about —
 * comments, strings, template text and regex literals are not call expressions,
 * so neither error is expressible rather than merely unlikely.
 *
 * A token scanner is not enough on its own: `/` is division or the start of a
 * regex depending on what precedes it, and only the parser knows which. Run over
 * this repository, a scanner-only version desynchronised and reported zero calls
 * in every file.
 *
 * `globalThis["fetch"]` is the one call spelled with a string, and it is matched
 * as the callee of a call rather than by looking at string contents — a sentence
 * that merely contains the word stays invisible.
 */
function fetchCallCount(text: string, fileName = "inline.ts"): number {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);

  /** `fetch`, `x.fetch`, `x["fetch"]` — every way of naming the one function. */
  const namesFetch = (e: ts.Expression): boolean => {
    if (ts.isIdentifier(e)) return e.text === "fetch";
    if (ts.isPropertyAccessExpression(e)) return e.name.text === "fetch";
    if (ts.isElementAccessExpression(e)) {
      return (
        ts.isStringLiteralLike(e.argumentExpression) && e.argumentExpression.text === "fetch"
      );
    }
    return false;
  };

  let count = 0;
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && namesFetch(node.expression)) count++;
    ts.forEachChild(node, walk);
  };
  walk(source);
  return count;
}

describe("chain reads > the list above is every outbound call there is", () => {
  it("accounts for every fetch under src/, file by file", () => {
    // A table rather than a total. A total is one number two changes can cancel
    // out; a table names the file, so a `fetch` appearing somewhere new is a new
    // key rather than an unchanged sum.
    //
    // Counted, not parsed, and that is the honest limit: this cannot tell which
    // function a call belongs to, so what it says is "something changed here,
    // decide". A rule that guessed which path a new call was on would be
    // answering a question it cannot see.
    const root = fileURLToPath(new URL("../../..", import.meta.url));
    const counts: Record<string, number> = {};
    for (const file of sourceFilesUnderSrc(root)) {
      // The name is passed through: a `.tsx` file has to be parsed as TSX, or
      // its markup is read as comparison operators and the walk goes wrong.
      const n = fetchCallCount(readFileSync(file, "utf8"), file);
      if (n > 0) counts[relative(root, file)] = n;
    }
    expect(counts).toEqual({
      // The documented exception, argued at its own call site.
      "lib/api.ts": 1,
      // The five in CHAIN_CALLS, each exercised by both describes below.
      "lib/cardano/price.ts": 1,
      "lib/cardano/blockfrost.ts": 2,
      "lib/cardano/provider.ts": 2,
    });
    expect(CHAIN_CALLS).toHaveLength(5);
  });

  it("counts every spelling of a call, including the ones written to hide", () => {
    // The predicate decides whether the table above can be trusted, so it gets
    // cases of its own. The first version was blind to every member spelling —
    // which is the spelling somebody reaching past this rule would reach for.
    for (const s of [
      `const r = await fetch(url);`,
      `const r = await globalThis.fetch(url);`,
      `const r = await window.fetch(url);`,
      `const r = await globalThis["fetch"](url);`,
      `const r = await self['fetch'] (url);`,
    ]) {
      expect(fetchCallCount(s)).toBe(1);
    }
  });

  it("counts a call sitting under a comment line that contains /*", () => {
    // The exact shape that let a real call hide. `provider.ts` carries the prose
    // ``content-range: 0-999/*`` inside a `//` comment; a stripper that removes
    // block comments first reads that as an opening delimiter and swallows
    // everything to the next `*` + `/`. Measured: fifty-seven lines of
    // `provider.ts` became invisible, `koios()` among them.
    const src =
      `// with \`content-range: 0-999/*\` and exactly 1000 rows\n` +
      `const a = 1;\n` +
      `await fetch("https://telemetry.invalid/ping");\n` +
      `const b = 2; /* an ordinary block */\n`;
    expect(fetchCallCount(src)).toBe(1);
  });

  it("does not count the word where it is only being talked about", () => {
    // The other direction, and the one that decides whether this rule survives
    // contact: an error message naming `fetch(url)` turned the suite red for
    // nothing, and a check that cries wolf gets deleted rather than fixed.
    const prose =
      `// we then fetch(url) here\n` +
      `/* or fetch(x) in a block */\n` +
      `const msg = "the browser refused the fetch(url) this wallet made";\n` +
      `const tpl = \`a fetch(y) inside a template\`;\n`;
    expect(fetchCallCount(prose)).toBe(0);
  });

  it("counts a call whose argument is a URL, which a comment stripper can eat", () => {
    // `//` inside a string is not a comment. A stripper working on raw text has
    // to be told that; a scanner cannot get it wrong.
    expect(fetchCallCount(`fetch("https://x.example/a");`)).toBe(1);
    expect(fetchCallCount(`const re = /\\/\\//; fetch(u);`)).toBe(1);
  });
});

describe("chain reads > every call site refuses the redirect it gets", () => {
  for (const { name, run } of CHAIN_CALLS) {
    it(`${name} rejects, naming the host`, async () => {
      // The other half: the `fetch` is configured correctly and a 302 comes
      // back. Something has to look at it. Deleting the `assertNoRedirect` line
      // from a call site is the mutation this case exists to kill.
      vi.stubGlobal("fetch", () =>
        Promise.resolve(
          new Response(null, { status: 302, headers: { location: "https://elsewhere.invalid/" } }),
        ),
      );
      await expect(run()).rejects.toThrow(/redirect/i);
    });
  }
});
