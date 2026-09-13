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
 *
 * **`extension/src/` is outside it**, and that is a stated limit rather than an
 * oversight. The extension's approval screen imports from `@/lib/cardano` too,
 * so the same argument would reach it — it is excluded today only because that
 * screen returns a witness set and never submits (there is no `signAndSubmit`
 * in it, and every method other than `signTx` is refused). The day it submits,
 * this sweep must grow to cover it, and nothing here will say so.
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
    //
    // Three shapes throw the result away, not one. `void f()` and `(f)()` read
    // as ordinary tidying and were measured to walk straight through the first
    // version of this, which only knew `ExpressionStatement ⊃ CallExpression ⊃
    // Identifier`. So the test is "the call's value is discarded", and the
    // wrappers are unwrapped before asking.
    //
    // Measured limit, so nobody has to rediscover it: passing the call as an
    // argument to something else — `void (await Promise.resolve(f()))` — still
    // gets through. That is not a shape ordinary editing produces, and chasing
    // every wrapper has no end; the shapes worth catching are the ones a tidy-up
    // writes by accident.
    const unwrap = (e: ts.Expression): ts.Expression => {
      let cur = e;
      for (;;) {
        if (ts.isParenthesizedExpression(cur)) cur = cur.expression;
        else if (ts.isVoidExpression(cur)) cur = cur.expression;
        else if (ts.isAwaitExpression(cur)) cur = cur.expression;
        else return cur;
      }
    };
    const namesIt = (e: ts.Expression): boolean => {
      const c = unwrap(e);
      if (!ts.isCallExpression(c)) return false;
      const callee = unwrap(c.expression);
      return ts.isIdentifier(callee) && callee.text === "reportSignError";
    };

    const offenders: string[] = [];
    for (const { name, text } of panelSources()) {
      walk(parse(name, text), (n) => {
        if (!ts.isExpressionStatement(n)) return;
        // A comma expression discards every value but the last, so each side is
        // its own discard. `0, f()` was the shape `tsc` happened to catch; it
        // should not have needed `tsc` to.
        const parts: ts.Expression[] = [];
        const flatten = (e: ts.Expression) => {
          const u = unwrap(e);
          if (ts.isBinaryExpression(u) && u.operatorToken.kind === ts.SyntaxKind.CommaToken) {
            flatten(u.left);
            flatten(u.right);
          } else parts.push(u);
        };
        flatten(n.expression);
        if (parts.some(namesIt)) offenders.push(name);
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

  it("writes the lock down, and clears it only on acknowledge", () => {
    // React state dies on idle-lock (five minutes) and on reload. The notice
    // asks the reader to go wait for a block, which takes about that long — so
    // an in-memory-only lock expires while they are doing what it said. Moving
    // the state up a level moved that boundary; it did not remove it.
    //
    // Three wirings, all in `WalletTabs`: read it back on mount, write it when
    // a submit goes unresolved, and erase it when — and only when — the reader
    // says they have checked.
    const { name, text } = sourceOf("WalletTabs.tsx");
    for (const fn of ["readLock", "writeLock", "clearLock"]) {
      expect(new RegExp(`\\b${fn}\\s*\\(`).test(text), `WalletTabs never calls ${fn}`).toBe(true);
    }

    // Specifically at mount, not merely somewhere in the file. This was a real
    // survivor: two places read the lock — the initialiser and an effect — so
    // deleting either left the other doing the job and nothing went red. Two
    // paths covering each other measure the same as no path being watched, so
    // the initialiser is named here and the effect now only handles changes.
    //
    // Measured against the tree, not `getText()`. The text form accepted a
    // *comment* saying `readLock(…)` while the initialiser was `null`, which is
    // the round-two defect verbatim: reload the page and the warning is gone
    // with the Send button armed.
    let mountReads = false;
    walk(parse(name, text), (n) => {
      if (!ts.isVariableDeclaration(n)) return;
      if (!n.name.getText().includes("uncertainHash")) return;
      const init = n.initializer;
      if (!init || !ts.isCallExpression(init)) return;
      walk(init, (x) => {
        if (ts.isCallExpression(x) && x.expression.getText() === "readLock") mountReads = true;
      });
    });
    expect(mountReads, "the lock is not read back when the tabs mount").toBe(true);
    // `clearLock` belongs to acknowledging, nowhere else. A timeout or a later
    // successful send would erase the answer to a question they do not answer:
    // whether *that* transaction landed.
    const clears = [...text.matchAll(/clearLock\s*\(/g)].length;
    expect(clears, "clearLock is called from more than one place").toBe(1);
  });

  it("keys the lock on something that does not rotate when money moves", () => {
    // The third boundary this lock has had. A change address is "the first
    // internal address holding no UTxO right now", so if the uncertain
    // transaction *did* land, its own change output takes that address and the
    // next unlock resolves the next one. Keyed on it, the lock disappears on
    // exactly the branch it exists for — and an unreachable indexer (the same
    // provider as the submit door that produced the 5xx) rotates it too.
    // Written against the syntax tree, not the text. A `/accountKeyFrom\(/`
    // over the source was satisfied by a *comment* mentioning it, so the whole
    // defect above could be put back — keyed on `changeAddress` again, with one
    // line of prose keeping this green. Measured: 688 passed, tsc 0.
    const { name, text } = sourceOf("WalletTabs.tsx");
    const root = parse(name, text);

    let derived = false;
    const shadowed: string[] = [];
    walk(root, (n) => {
      if (!ts.isVariableDeclaration(n)) return;
      if (n.name.getText() !== "accountKey") return;
      const init = n.initializer;
      // Accumulate, never assign. A second `accountKey` declared later in the
      // file — in a dead function, say — used to decide the verdict for the
      // real one, which put the whole rotation defect back with every test
      // green. The same mistake appears twice more in this file; all three are
      // fixed together, because fixing one and leaving its siblings is how a
      // measured defect comes back wearing a different name.
      if (!!init && ts.isCallExpression(init) && init.expression.getText() === "accountKeyFrom") {
        derived = true;
      } else {
        shadowed.push(init?.getText() ?? "<no initializer>");
      }
    });
    expect(
      derived,
      "`accountKey` is not the result of accountKeyFrom — the lock is keyed on a rotating value",
    ).toBe(true);
    // And there must be exactly one of them. A decoy declaration is how the
    // accumulating check above would be satisfied while the live one rotates.
    expect(shadowed, "a second `accountKey` is declared and does not come from accountKeyFrom").toEqual(
      [],
    );

    // And every call into the store must key on that identifier, nothing else.
    // Listing what IS allowed rather than what is forbidden: a check for the
    // word `changeAddress` is walked around by one intermediate variable, and
    // the intermediate is the shape a refactor produces by accident.
    const KEY_ARG: Record<string, number> = { readLock: 2, writeLock: 2, clearLock: 2, lockKey: 1 };
    const misKeyed: string[] = [];
    walk(root, (n) => {
      if (!ts.isCallExpression(n)) return;
      const callee = n.expression.getText();
      const at = KEY_ARG[callee];
      if (at === undefined) return;
      const arg = n.arguments[at];
      if (!arg || !ts.isIdentifier(arg) || arg.text !== "accountKey") {
        misKeyed.push(`${callee}(… ${arg?.getText() ?? "<missing>"} …)`);
      }
    });
    expect(misKeyed, "a lock call is keyed on something other than accountKey").toEqual([]);
  });

  it("re-reads the lock when the account changes, and when another tab writes it", () => {
    // Two separate paths, and the file used to *claim* both were pinned while
    // deleting either one stayed green. Each is named here by the dependency it
    // reacts to, so removing one cannot hide behind the other.
    //
    //   - identity change: the account or chain can change without unmounting,
    //     and without this, account A's warning stays on screen for account B.
    //   - `storage` event: localStorage is shared across tabs, React state is
    //     not. The tab that did *not* send is the one most likely to be used for
    //     the retry, because the one that sent is showing a warning.
    // The measurement is "does the effect put the lock back on screen", not
    // "does the word readLock appear". Asking the weaker question let both
    // effects be turned into `readLock(…); // result thrown away` — green, and
    // strictly worse than the bug it replaced, because account B's real lock is
    // then on disk and never read up while B's Send button is armed.
    const { name, text } = sourceOf("WalletTabs.tsx");
    const isReadLock = (e: ts.Node | undefined): boolean =>
      !!e && ts.isCallExpression(e) && e.expression.getText() === "readLock";

    const feedsTheScreen = (body: ts.Node): boolean => {
      // A local `const next = readLock(…); … setUncertainHash(next)` is the same
      // wiring and has a reason to exist — the storage handler has to look at
      // the value before deciding. So resolve one level of local binding rather
      // than demanding the call sit literally inside the setter, which would
      // reject correct code and push the next author toward the inline form to
      // keep a gate quiet.
      const bound = new Set<string>();
      walk(body, (n) => {
        if (!ts.isVariableDeclaration(n) || !ts.isIdentifier(n.name)) return;
        if (isReadLock(n.initializer)) bound.add(n.name.text);
      });
      // …and drop any of them that is written to afterwards. One extra line
      // between the read and the setter turned a genuine wiring check into a
      // check that a *name* travelled, and a name can carry anything.
      walk(body, (n) => {
        if (!ts.isBinaryExpression(n)) return;
        if (n.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;
        if (ts.isIdentifier(n.left)) bound.delete(n.left.text);
      });
      let ok = false;
      walk(body, (n) => {
        if (ok || !ts.isCallExpression(n)) return;
        if (n.expression.getText() !== "setUncertainHash") return;
        const arg = n.arguments[0];
        if (!arg) return;
        ok = isReadLock(arg) || (ts.isIdentifier(arg) && bound.has(arg.text));
      });
      return ok;
    };

    const effects: { deps: string[]; body: ts.Node; listensToStorage: boolean }[] = [];
    walk(parse(name, text), (n) => {
      if (!ts.isCallExpression(n)) return;
      if (n.expression.getText() !== "useEffect") return;
      const deps = n.arguments[1];
      const body = n.arguments[0];
      if (!body) return;
      let listens = false;
      walk(body, (x) => {
        if (!ts.isCallExpression(x)) return;
        if (!/addEventListener$/.test(x.expression.getText())) return;
        const ev = x.arguments[0];
        if (ev && ts.isStringLiteralLike(ev) && ev.text === "storage") listens = true;
      });
      effects.push({
        deps: deps && ts.isArrayLiteralExpression(deps) ? deps.elements.map((e) => e.getText()) : [],
        body,
        listensToStorage: listens,
      });
    });

    const onIdentity = effects.filter(
      (e) =>
        e.deps.includes("accountKey") &&
        e.deps.includes("network") &&
        !e.listensToStorage &&
        feedsTheScreen(e.body),
    );
    expect(onIdentity.length, "no effect re-reads the lock when the account or chain changes").toBe(1);

    const onStorage = effects.filter((e) => e.listensToStorage);
    expect(onStorage.length, "no effect listens for another tab writing the lock").toBe(1);
    expect(
      feedsTheScreen(onStorage[0]!.body),
      "the storage listener reads the lock but never puts it back on screen",
    ).toBe(true);

    // A `storage` event with a null key is `localStorage.clear()` — site
    // housekeeping, an extension, a "clear browsing data" click. Read back
    // naively it produces `null`, which this listener would then push on screen
    // as "no unresolved submit". Only the acknowledge button is allowed to take
    // this warning down; data going away must not be able to impersonate a
    // person saying they checked.
    let refusesAWholesaleClear = false;
    walk(onStorage[0]!.body, (n) => {
      if (refusesAWholesaleClear || !ts.isIfStatement(n)) return;
      const leaves =
        ts.isReturnStatement(n.thenStatement) ||
        (ts.isBlock(n.thenStatement) && n.thenStatement.statements.some(ts.isReturnStatement));
      if (!leaves) return;
      // Both halves, and both operators. Shape alone is not enough: flipping
      // one `===` to `!==` leaves the same shape and hands the unlock straight
      // back, which is the whole defect. So: `<the read> === null` AND
      // `<the event>.key === null`, joined by `&&`.
      const c = n.expression;
      if (!ts.isBinaryExpression(c)) return;
      if (c.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken) return;
      const isNullCheck = (x: ts.Expression, onKey: boolean): boolean =>
        ts.isBinaryExpression(x) &&
        x.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
        x.right.kind === ts.SyntaxKind.NullKeyword &&
        (onKey
          ? ts.isPropertyAccessExpression(x.left) && x.left.name.text === "key"
          : ts.isIdentifier(x.left));
      const mentionsNullKey =
        (isNullCheck(c.left, false) && isNullCheck(c.right, true)) ||
        (isNullCheck(c.left, true) && isNullCheck(c.right, false));
      // Accumulate, never assign: the handler has a second early `return` that
      // compares the key with `!== null`, and plain assignment would let
      // whichever `if` the walk reached last decide the verdict.
      if (mentionsNullKey) refusesAWholesaleClear = true;
    });
    expect(
      refusesAWholesaleClear,
      "clearing site data silently takes the warning down, as if the reader had checked",
    ).toBe(true);
  });

  it("tells the reader when the hash was NOT written down", () => {
    // `writeLock` reports whether the value survives a reload, and that return
    // used to be dropped on the floor. In private mode, with site data blocked,
    // or on a full quota, the wallet went on showing a notice that implies the
    // number can be come back to — while the only copy was the text on screen.
    const { name, text } = sourceOf("WalletTabs.tsx");
    const root = parse(name, text);

    // EVERY call, not the last one seen. Assignment rather than accumulation
    // meant a second, discarded `writeLock` could follow a consumed one and the
    // gate would report the consumed one's verdict.
    const discarded: string[] = [];
    let writes = 0;
    walk(root, (n) => {
      if (!ts.isCallExpression(n)) return;
      if (n.expression.getText() !== "writeLock") return;
      writes += 1;
      if (ts.isExpressionStatement(n.parent)) discarded.push(n.getText());
    });
    expect(writes, "WalletTabs never writes the lock down").toBeGreaterThanOrEqual(1);
    expect(discarded, "a writeLock result is discarded — durability assumed, not known").toEqual([]);

    // And the answer has to reach the notice as a *value*. `durable={true}` and
    // `durable={!false}` both satisfied a text match, and both make the wallet
    // print "the id is kept here" in the browsers where nothing was kept —
    // which is the exact sentence this whole property exists to prevent.
    const durableAttrs: string[] = [];
    let durableAttrName: string | undefined;
    walk(root, (n) => {
      if (!ts.isJsxAttribute(n) || n.name.getText() !== "durable") return;
      const v = n.initializer;
      const inner = v && ts.isJsxExpression(v) ? v.expression : undefined;
      durableAttrs.push(inner ? ts.SyntaxKind[inner.kind] : "<no expression>");
      if (inner && ts.isIdentifier(inner)) durableAttrName = inner.text;
    });
    expect(durableAttrs.length, "the notice is never told whether the hash is durable").toBe(1);
    expect(
      durableAttrs[0],
      `durable is passed as a constant (${durableAttrs[0]}), not as the answer writeLock gave`,
    ).toBe(ts.SyntaxKind[ts.SyntaxKind.Identifier]);

    // An identifier is not enough either: `const keptHere = true` is a constant
    // wearing a name. What has to reach the notice is the value the writer set,
    // so the name must be bound by `useState` — the only thing in this file
    // that can still be holding what `writeLock` answered.
    const stateNames = new Set<string>();
    walk(root, (n) => {
      if (!ts.isVariableDeclaration(n)) return;
      if (!n.initializer || !ts.isCallExpression(n.initializer)) return;
      if (!/^useState/.test(n.initializer.expression.getText())) return;
      if (!ts.isArrayBindingPattern(n.name)) return;
      const first = n.name.elements[0];
      if (first && ts.isBindingElement(first) && ts.isIdentifier(first.name)) {
        stateNames.add(first.name.text);
      }
    });
    const passed = durableAttrName ?? "";
    expect(
      stateNames.has(passed),
      `durable is passed as \`${passed}\`, which is not React state — a constant renamed`,
    ).toBe(true);
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

  it("reports an unresolved submit from every function that can spend", () => {
    // The other half of the lock, and for a long time the weaker half. The
    // refusal was measured per FUNCTION against the syntax tree; the *report*
    // was measured per FILE with a text match — so a screen with two ways to
    // spend kept its gate satisfied by the other one, and the door that lost
    // its report produced no lock at all. Nothing else creates the lock, so
    // that is not a degraded warning: it is silence, on the screen that just
    // sent money into an unknown.
    //
    // Same sweep and same unit as the refusal, deliberately. A property worth
    // enforcing on one half of a pair is worth enforcing the same way on the
    // other, and the two drifting apart is what produced this.
    const silent: string[] = [];
    for (const { name, text } of panelSources()) {
      if (name === "WalletTabs.tsx") continue;
      walk(parse(name, text), (n) => {
        if (!ts.isCallExpression(n)) return;
        if (spendMethodOf(n) !== "signAndSubmit") return;
        let fn: ts.Node | undefined = n.parent;
        while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
        if (!fn) return; // the refusal gate already reports this shape
        let reports = false;
        walk(fn, (x) => {
          if (ts.isCallExpression(x) && x.expression.getText() === "onUncertain") reports = true;
        });
        const label = ts.isVariableDeclaration(fn.parent) ? fn.parent.name.getText() : "(anonymous)";
        if (!reports) silent.push(`${name}: ${label}`);
      });
    }
    expect(silent, "a spend path can end in an unknown outcome and set no lock").toEqual([]);
  });

  /**
   * Does this function actually refuse, before the offset given?
   *
   * The first version asked `fn.getText()` for `/uncertainHash !== null/`, which
   * measures the presence of a *string* in the source — comments included. Three
   * mutations walked through it, all green, all `tsc`-clean:
   *
   *   - `if (uncertainHash !== null) toastError(…)` — the `return` dropped. This
   *     is the one that matters: returning a `void` expression is exactly what a
   *     linter suggests removing, and what someone writing the `if` by hand
   *     forgets. After it, pressing Confirm while locked **shows the warning and
   *     then signs and submits** — worse than no guard, because the screen just
   *     said it had stopped.
   *   - the whole guard turned into a comment mentioning it.
   *
   * So: an `if` whose condition really is `uncertainHash !== null`, whose branch
   * really leaves the function, and which really sits before the call.
   *
   * That was still not enough. Walking the whole subtree accepts *any* matching
   * `if` anywhere inside the handler, and two shapes exploit it — both green,
   * both `tsc`-clean:
   *
   *   - the real guard deleted, a copy left behind inside a nested function that
   *     nothing calls;
   *   - the guard wrapped in `if (false) { … }`. This one has a concrete path to
   *     a double spend, because the Confirm button reads `busy` and `checked`,
   *     never `uncertainHash` — the disabled prop is a hint, not the lock.
   *
   * Neither is about the `if`; both are about whether control actually reaches
   * it. So the guard must be a **direct statement of the handler's own body**.
   * Nothing may stand between the top of the function and the refusal — which is
   * also how a person reading the handler would expect to find it.
   */
  const bodyStatements = (fn: ts.Node): readonly ts.Statement[] => {
    const body = (fn as ts.FunctionLikeDeclaration).body;
    return body && ts.isBlock(body) ? body.statements : [];
  };

  const guardsBefore = (fn: ts.Node, callStart: number): boolean => {
    let found = false;
    for (const n of bodyStatements(fn)) {
      if (found || !ts.isIfStatement(n)) continue;
      if (n.getStart() >= callStart) continue; // after the spend: too late to refuse
      // `if (uncertainHash !== null)` and `if (uncertainHash)` are the same
      // refusal — the value is `string | null`, so truthiness and the explicit
      // comparison cannot disagree. Rejecting the shorter one would fail
      // correct code, and a gate that fails correct code gets written around
      // rather than satisfied. Accept both; accept nothing else.
      const c = n.expression;
      const explicit =
        ts.isBinaryExpression(c) &&
        c.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken &&
        c.left.getText() === "uncertainHash" &&
        c.right.kind === ts.SyntaxKind.NullKeyword;
      const truthy = ts.isIdentifier(c) && c.text === "uncertainHash";
      if (!explicit && !truthy) continue;
      // The branch has to leave. A bare `toastError(…)` falls through to the
      // spend, and that is the shape this exists to catch.
      const leaves = (s: ts.Statement): boolean => {
        if (ts.isReturnStatement(s) || ts.isThrowStatement(s)) return true;
        if (ts.isBlock(s)) return s.statements.length > 0 && leaves(s.statements[s.statements.length - 1]!);
        return false;
      };
      if (leaves(n.thenStatement)) found = true;
    }
    return found;
  };

  /**
   * Is this call `<something>.signAndSubmit(…)` — however it is spelled?
   *
   * `port["signAndSubmit"](…)` is the same call and was invisible to a sweep
   * that only looked at property access. It is not a hypothetical shape: it is
   * what a fifth money screen would be written as by anyone holding the method
   * name in a variable, and it defeated the count as well as the guard check,
   * so the floor below stayed satisfied by the four known-good sites while the
   * fifth went unguarded.
   */
  const spendMethodOf = (n: ts.CallExpression): string | null => {
    // Parentheses first. `(port.signAndSubmit)(…)` is the same call, and it was
    // invisible to both the sweep *and* the count below — so a fifth spend
    // screen written that way left the floor satisfied by the four known-good
    // sites while nothing looked at the fifth. A floor only catches a door that
    // disappears; it cannot catch a door added in a spelling the counter is
    // blind to, which is why this has to unwrap rather than the floor rise.
    let e: ts.Expression = n.expression;
    while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
    if (ts.isPropertyAccessExpression(e)) return e.name.text;
    if (ts.isElementAccessExpression(e)) {
      const arg = e.argumentExpression;
      return ts.isStringLiteralLike(arg) ? arg.text : null;
    }
    return null;
  };

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
        if (spendMethodOf(n) !== "signAndSubmit") return;
        // Climb to the function this call sits in, then read its own top-level
        // statements: the guard has to be on the way in, not merely present.
        let fn: ts.Node | undefined = n.parent;
        while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
        if (!fn) {
          unguarded.push(`${name}: signAndSubmit outside any function`);
          return;
        }
        const label = ts.isVariableDeclaration(fn.parent) ? fn.parent.name.getText() : "(anonymous)";
        if (!guardsBefore(fn, n.getStart())) unguarded.push(`${name}: ${label}`);
      });
    }
    expect(unguarded).toEqual([]);
  });

  it("recognises a spend call however it is spelled", () => {
    // Fixtures, not the repo. Measured: deleting the paren-unwrapping from
    // `spendMethodOf` left every test green — the two table entries named after
    // that shape were going red for a different reason (the count floor fell
    // from four to three), so the unwrapping itself was pinned by nothing. Two
    // paths covering each other measure the same as neither being watched, and
    // the only way to test a detector is to hand it the inputs it claims to
    // detect rather than to run it over code that happens to be correct.
    const cases: [string, string | null][] = [
      ["port.signAndSubmit(b, n)", "signAndSubmit"],
      ['port["signAndSubmit"](b, n)', "signAndSubmit"],
      ["(port.signAndSubmit)(b, n)", "signAndSubmit"],
      ["port!.signAndSubmit(b, n)", "signAndSubmit"],
      ["((port.signAndSubmit))(b, n)", "signAndSubmit"],
      ["port.somethingElse(b, n)", "somethingElse"],
      ["plainFunction(b, n)", null],
    ];
    const seen: (string | null)[] = [];
    for (const [src] of cases) {
      let got: string | null = null;
      walk(parse("fixture.ts", `const x = ${src};`), (n) => {
        if (ts.isCallExpression(n)) got = spendMethodOf(n) ?? got;
      });
      seen.push(got);
    }
    expect(seen).toEqual(cases.map(([, want]) => want));
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
        if (spendMethodOf(n) === "signAndSubmit") sites++;
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
