/**
 * Four things a money screen is not allowed to say, and one it must keep saying.
 *
 * All four were live at once, in four different files, and every gate in this
 * repo was green over them. They share a shape: a screen that answers a question
 * nobody asked, in place of the one they did. So they are pinned together.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { usesExtensionPopup, hasFiatPrice } from "../moneyNotice";
import { reportSignError } from "../signError";
import { SubmitUncertainError } from "@/lib/cardano/tx";
import { NetworkMismatchError } from "@/lib/cardano/cip30";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const LOCALES = join(REPO, "locales");

describe("sign hint > the sentence matches who is holding the key", () => {
  it("promises a popup only where a popup exists", () => {
    // Four screens printed the extension sentence unconditionally, this wallet's
    // own self-custody accounts included. Someone waiting for a window that
    // never opens reads it as a click that did not register — and clicks again.
    expect(usesExtensionPopup("cip30")).toBe(true);
    expect(usesExtensionPopup("local")).toBe(false);
  });
});

describe("fiat line > testnet ADA has no price, so it gets none", () => {
  it("prices mainnet and nothing else", () => {
    // A faucet hands out test ADA. Converting it at the mainnet rate produced a
    // figure with no referent: 10 000 test ADA read as tens of millions of đồng.
    expect(hasFiatPrice(1)).toBe(true);
    expect(hasFiatPrice(0)).toBe(false);
    expect(hasFiatPrice(2)).toBe(false);
  });

  it("says mainnet rather than not-testnet, so an unknown network is unpriced", () => {
    // The direction matters and cannot be seen from the two cases above: written
    // the other way round, a network id nobody has thought about yet would
    // default to being priced at the mainnet rate. Cast because the point is
    // exactly the value the type does not admit today.
    expect(hasFiatPrice(7 as unknown as 0)).toBe(false);
  });
});

describe("submit with no reply > the caller is told, not just the reader", () => {
  const toasts: string[] = [];

  beforeEach(() => {
    toasts.length = 0;
    vi.spyOn(console, "error").mockImplementation((...args) => {
      toasts.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "warn").mockImplementation((...args) => {
      toasts.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "log").mockImplementation((...args) => {
      toasts.push(args.map(String).join(" "));
    });
  });
  afterEach(() => vi.restoreAllMocks());

  /** Enough of `t` to see which key was asked for. */
  const t = (key: string) => key;

  it("hands back the hash when nobody knows whether the money moved", () => {
    // This is the whole fix. A banner alone cannot disarm the form behind it,
    // and the form behind it had already been re-armed by the same `catch`: the
    // screen ended with a live Send button, no hash on it, and a person who had
    // just been told to look the hash up. Following the instruction and paying
    // twice were the same click.
    const outcome = reportSignError(
      new SubmitUncertainError("deadbeef".repeat(8), new Error("socket hang up")),
      t,
    );
    expect(outcome.kind).toBe("uncertain");
    expect(outcome).toMatchObject({ txHash: "deadbeef".repeat(8) });
  });

  it("does not claim uncertainty for an error that means nothing was sent", () => {
    // The other direction, and the one that decides whether the notice keeps
    // being read: a wrong-network refusal moved no money, so locking the screen
    // and demanding an explorer lookup for it would train people to dismiss the
    // notice that matters.
    // networkId, not a name: 0 is every testnet, 1 is mainnet.
    expect(reportSignError(new NetworkMismatchError(0, 1), t).kind).toBe(
      "reported",
    );
    expect(reportSignError(new Error("anything else"), t).kind).toBe("reported");
  });

  it("still says it out loud — the return value is in addition, not instead", () => {
    reportSignError(new SubmitUncertainError("abc", new Error("socket hang up")), t);
    expect(toasts.join("\n")).toContain("submit_uncertain");
  });
});

/**
 * Two of these four fixes are *wiring*, spread across panels, and this repo's
 * test runner has no DOM — so nothing here can render a screen and look at it.
 * Rather than leave them unwatched and say they are covered, both are pinned at
 * the source level, with the parser, for the same reason `noRedirect.test.ts`
 * uses one: a text scan cannot tell a call from a sentence about a call.
 *
 * What this can prove is narrow and worth stating: that no panel *reintroduces*
 * the shape. It cannot prove the notice renders, or that the button is really
 * disabled. Those need a DOM, and adding one is a dependency decision rather
 * than a thing to slip into a bug fix.
 */
const PANELS = join(dirname(fileURLToPath(import.meta.url)), "..");

function panelSources(): Array<{ name: string; text: string }> {
  return readdirSync(PANELS)
    .filter((f) => /\.tsx?$/.test(f) && !/\.test\./.test(f))
    .map((f) => ({ name: f, text: readFileSync(join(PANELS, f), "utf8") }));
}

const parse = (name: string, text: string) =>
  ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (c) => walk(c, visit));
}

describe("wiring > a panel cannot quietly go back to the old shape", () => {
  it("never throws away what reportSignError hands back", () => {
    // The defect was not in `reportSignError` — it was that three callers had
    // nothing to receive. A fourth money screen added later would be written by
    // copying one of them, and copying the *old* shape compiles, passes every
    // gate, and silently re-arms the form after a submit nobody can account for.
    // So: calling it as a bare statement is the thing to catch.
    const offenders: string[] = [];
    for (const { name, text } of panelSources()) {
      walk(parse(name, text), (n) => {
        if (!ts.isExpressionStatement(n)) return;
        const e = n.expression;
        if (
          ts.isCallExpression(e) &&
          ts.isIdentifier(e.expression) &&
          e.expression.text === "reportSignError"
        ) {
          offenders.push(name);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the extension-popup sentence in the one place that decides on it", () => {
    // Four panels printed it unconditionally. The fix is a component that asks
    // `port.kind` first — which holds only as long as nobody writes the literal
    // back into a panel, and writing it back is one line that reviews as
    // harmless. `moneyNotice.ts` is allowed to name it in prose; `SignHint.tsx`
    // is where the branch lives.
    const allowed = new Set(["SignHint.tsx"]);
    const offenders: string[] = [];
    for (const { name, text } of panelSources()) {
      if (allowed.has(name)) continue;
      walk(parse(name, text), (n) => {
        if (!ts.isCallExpression(n)) return;
        const [arg] = n.arguments;
        if (arg && ts.isStringLiteralLike(arg) && arg.text === "extension_popup_hint") {
          offenders.push(name);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("gives BalanceView a network at every call site", () => {
    // The prop is required, so the compiler already refuses an omission — this
    // watches the other way somebody satisfies a required prop in a hurry, which
    // is to hardcode it. A literal `1` here would put every testnet balance back
    // on the mainnet rate while `tsc` stayed silent.
    const offenders: string[] = [];
    for (const { name, text } of panelSources()) {
      walk(parse(name, text), (n) => {
        if (!ts.isJsxSelfClosingElement(n) && !ts.isJsxOpeningElement(n)) return;
        if (n.tagName.getText() !== "BalanceView") return;
        for (const attr of n.attributes.properties) {
          if (!ts.isJsxAttribute(attr) || attr.name.getText() !== "network") continue;
          const init = attr.initializer;
          if (
            init &&
            ts.isJsxExpression(init) &&
            init.expression &&
            ts.isNumericLiteral(init.expression)
          ) {
            offenders.push(`${name}: network={${init.expression.text}}`);
          }
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});

describe("balance > the four languages carry every string these screens need", () => {
  // `check:locales` compares the languages against each other, so a key missing
  // from all four grades as fine — which is how three keys reached a shipped
  // wallet. `check:i18n-keys` closes that from the code side; this closes the
  // one direction neither covers, that the strings are actually present here
  // rather than merely consistent with each other.
  const NEEDED = [
    "balance_loading",
    "balance_unavailable",
    "local_balance_loading",
    "local_balance_unavailable",
    "fiat_testnet_note",
    "local_sign_hint",
    "extension_popup_hint",
    "uncertain_title",
    "uncertain_body",
    "uncertain_checked_cta",
    "uncertain_blocked",
  ];

  for (const lang of readdirSync(LOCALES)) {
    it(`${lang} has all of them, and none of them empty`, () => {
      const strings = JSON.parse(
        readFileSync(join(LOCALES, lang, "wallet.json"), "utf8"),
      ) as Record<string, string>;
      for (const key of NEEDED) {
        expect(strings[key], `${lang}/${key}`).toBeTypeOf("string");
        expect((strings[key] ?? "").trim().length, `${lang}/${key}`).toBeGreaterThan(0);
      }
    });
  }

  it("keeps the loading line and the failure line distinct in every language", () => {
    // Two identical strings would put the defect straight back: the screen would
    // branch correctly and still say the same thing either way, and nothing
    // would go red.
    for (const lang of readdirSync(LOCALES)) {
      const s = JSON.parse(
        readFileSync(join(LOCALES, lang, "wallet.json"), "utf8"),
      ) as Record<string, string>;
      expect(s.balance_loading, lang).not.toBe(s.balance_unavailable);
      expect(s.local_balance_loading, lang).not.toBe(s.local_balance_unavailable);
    }
  });
});
