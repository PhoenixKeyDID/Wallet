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
/**
 * The whole of `src/`, and recursively — not the one flat directory the panels
 * happen to sit in today.
 *
 * The first version of this read `src/components/wallet` with a non-recursive
 * `readdirSync`. A panel one directory deeper — `src/components/wallet/money/` —
 * committed all three offences at once and the suite stayed green, `tsc` stayed
 * green, and every `check:*` gate stayed green. A gate whose reach is "the
 * folder I was thinking of" is a gate that a `mkdir` walks around, and nothing
 * announces the day someone runs that `mkdir`.
 *
 * `src/` rather than the panel folder because the things being guarded —
 * `reportSignError`, `BalanceView`, the `extension_popup_hint` key — are
 * exports. Anything in `src/` can import them, so anything in `src/` is in
 * scope. `noRedirect.test.ts` walks the tree the same way, and states its own
 * escape hatches; this one has none to state, which is why the list below is
 * the file's whole reach.
 */
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function panelSources(): Array<{ name: string; text: string }> {
  const out: Array<{ name: string; text: string }> = [];
  const walkDir = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        // `__tests__` holds this file and its siblings: a test that *writes* the
        // forbidden shape in order to prove the gate bites must not be read by
        // the gate itself.
        if (entry.name !== "__tests__" && entry.name !== "node_modules") walkDir(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name) || /\.test\./.test(entry.name)) continue;
      out.push({ name: entry.name, text: readFileSync(full, "utf8") });
    }
  };
  walkDir(SRC);
  return out;
}

const parse = (name: string, text: string) =>
  ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (c) => walk(c, visit));
}

describe("wiring > the sweep reaches what it claims to reach", () => {
  // Every gate below is a loop over `panelSources()`, so the sweep's reach is
  // the reach of all of them at once. Narrowing it back to one flat directory —
  // which is what it used to be, and what a tidy-up would restore — leaves all
  // of them green while a panel one folder deeper does whatever it likes.
  // Measured: with the flat version restored, the whole suite stays green.
  //
  // So the reach is asserted directly, in three independent ways. Any one of
  // them alone is satisfiable by an accident.
  const files = panelSources();
  const names = new Set(files.map((f) => f.name));

  it("descends past the panel folder", () => {
    // A file that is in `src/` but not in `src/components/wallet/`. If this ever
    // moves, the replacement must also be outside that folder — the point is
    // the depth, not the file.
    expect(names.has("signer.ts"), "sweep does not leave src/components/wallet").toBe(true);
    expect(names.has("provider.ts"), "sweep does not reach src/lib/cardano").toBe(true);
  });

  it("does not read the tests that deliberately write the forbidden shapes", () => {
    expect([...names].filter((n) => /\.test\.|\.spec\./.test(n))).toEqual([]);
  });

  it("is large enough that a silent truncation would show", () => {
    // Not a golden count — that would fail on every new file. A floor: the repo
    // had well over a hundred source files when this was written, and a sweep
    // that suddenly returns a handful has stopped sweeping.
    expect(files.length).toBeGreaterThan(60);
  });
});

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

/**
 * The lock itself, rather than the shapes that would undo it.
 *
 * The block above watches for a panel *going back* to the old code. It says
 * nothing about whether the new code still does its job, and a measurement
 * settled which of those two matters: removing the guard from `canBuild`,
 * removing the whole notice render, removing the disable on both staking
 * buttons — each of those left the suite fully green. Four live locks, no
 * watcher on any of them.
 *
 * These read the source because the runner has no DOM. That is a real ceiling
 * and it is stated rather than papered over: what follows proves the guard is
 * *written*, not that React honours it at runtime. But "written" is the part
 * that a refactor deletes, and deleting it was free until now.
 *
 * ## What is still unwatched, measured rather than guessed
 *
 * Mutation, whole suite, after these gates were in place. Two survivors, both
 * deliberate, and naming them here is the point — an unstated gap is the kind
 * that gets rediscovered as a defect:
 *
 * - Dropping `uncertainHash === null &&` out of `SendPanel`'s `canBuild`.
 * - Turning the guard at the top of `GovernancePanel.review()` into `if (false)`.
 *
 * Both are *second* doors. The spend itself is refused inside the handler that
 * calls `signAndSubmit`, and removing that refusal is caught on all four paths.
 * These two make the button look disabled and refuse earlier, which is better
 * for the reader and is not what stops the money. A gate naming one function in
 * one file would pin them, and would then fail on any honest rename — the kind
 * of watcher that gets deleted rather than fixed. So: unpinned, on purpose,
 * written down.
 */
describe("wiring > the lock that is there now is still there", () => {
  const sourceOf = (file: string) => {
    const found = panelSources().find((s) => s.name === file);
    if (!found) throw new Error(`${file} not found — the sweep no longer reaches it`);
    return found;
  };

  it("renders the notice outside every tab condition, so leaving a tab cannot hide it", () => {
    // The defect this replaces: the notice lived inside a panel, `WalletTabs`
    // mounts panels with `activeTab === "…" && <Panel/>`, and the notice's own
    // body sends the reader to the History tab. Going where it said to go
    // unmounted it, dropped the only copy of the hash, and re-armed Send.
    //
    // So the property is positional: the element must exist in `WalletTabs.tsx`
    // and must have no ancestor that tests `activeTab`.
    const { name, text } = sourceOf("WalletTabs.tsx");
    const root = parse(name, text);
    const sites: Array<{ guardedBy: string | null }> = [];

    const guardText = (n: ts.Node): string | null => {
      for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
        if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
          const left = p.left.getText();
          if (left.includes("activeTab") || left.includes("tab ===")) return left;
        }
        if (ts.isConditionalExpression(p) && p.condition.getText().includes("activeTab")) {
          return p.condition.getText();
        }
      }
      return null;
    };

    walk(root, (n) => {
      if (!ts.isJsxSelfClosingElement(n) && !ts.isJsxOpeningElement(n)) return;
      if (n.tagName.getText() !== "UncertainSubmitNotice") return;
      sites.push({ guardedBy: guardText(n) });
    });

    // Present at all — a deleted render is the cheapest way to lose this.
    expect(sites.length, "UncertainSubmitNotice is not rendered by WalletTabs").toBe(1);
    expect(sites[0]?.guardedBy, "the notice sits inside a tab condition").toBeNull();
  });

  it("keeps the hash in exactly one place — no panel holds its own copy", () => {
    // Two copies is worse than the original bug: one panel clears the lock while
    // another still believes it, and which screen you are on decides whether the
    // wallet thinks its own UTxO set is known.
    const offenders: string[] = [];
    for (const { name, text } of panelSources()) {
      if (name === "WalletTabs.tsx" || name === "UncertainSubmitNotice.tsx") continue;
      walk(parse(name, text), (n) => {
        if (!ts.isCallExpression(n)) return;
        if (!ts.isIdentifier(n.expression) || n.expression.text !== "useState") return;
        // `const [uncertainHash, setUncertainHash] = useState(...)`
        const decl = n.parent;
        if (!ts.isVariableDeclaration(decl)) return;
        if (decl.name.getText().includes("ncertainHash")) offenders.push(name);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("makes every money panel read the lock it can set", () => {
    // Half the pair is the dangerous state: a panel that reports an unresolved
    // submit but never reads `uncertainHash` stays armed while every other
    // screen is locked — and it is armed on the screen that just sent money.
    const broken: string[] = [];
    for (const { name, text } of panelSources()) {
      if (name === "WalletTabs.tsx") continue;
      const setsIt = /\bonUncertain\s*\(/.test(text);
      const readsIt = /\buncertainHash\b/.test(text);
      if (setsIt && !readsIt) broken.push(`${name}: calls onUncertain, never reads uncertainHash`);
    }
    expect(broken).toEqual([]);
  });

  it("refuses inside every function that can spend, not once per file", () => {
    // The first version of this asked each file for *a* guard. `StakingPanel`
    // has two ways to spend; deleting the lock from one of them left the other
    // one matching, and the suite stayed green on a screen that could still
    // withdraw while locked. A lock that covers one of two doors covers
    // neither, so the unit here is the function, found by what it calls.
    //
    // The disabled prop on the button stays — it is the hint. This is the
    // refusal, and it is the half that a later edit cannot drop in silence.
    const unguarded: string[] = [];
    for (const { name, text } of panelSources()) {
      const root = parse(name, text);
      walk(root, (n) => {
        if (!ts.isCallExpression(n)) return;
        if (!ts.isPropertyAccessExpression(n.expression)) return;
        if (n.expression.name.text !== "signAndSubmit") return;
        // Climb to the function this call sits in, then read that function
        // whole: the guard has to be somewhere inside it.
        let fn: ts.Node | undefined = n.parent;
        while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
        if (!fn) {
          unguarded.push(`${name}: signAndSubmit outside any function`);
          return;
        }
        const body = fn.getText();
        if (!/uncertainHash\s*!==\s*null/.test(body)) {
          const label = ts.isVariableDeclaration(fn.parent) ? fn.parent.name.getText() : "(anonymous)";
          unguarded.push(`${name}: ${label}`);
        }
      });
    }
    expect(unguarded).toEqual([]);
  });

  it("has a spend path at all — an empty sweep is not a pass", () => {
    // The gate above is a `for` loop over found call sites. Zero call sites
    // makes it vacuously green, which is exactly what a renamed port method or
    // a narrowed sweep would produce: the measurement would stop measuring and
    // report success. Count them instead of trusting the loop ran.
    let sites = 0;
    for (const { name, text } of panelSources()) {
      walk(parse(name, text), (n) => {
        if (!ts.isCallExpression(n)) return;
        if (!ts.isPropertyAccessExpression(n.expression)) return;
        if (n.expression.name.text === "signAndSubmit") sites++;
      });
    }
    expect(sites, "no spend path found — the sweep above proved nothing").toBeGreaterThanOrEqual(4);
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
