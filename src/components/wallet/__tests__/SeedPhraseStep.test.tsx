// @vitest-environment happy-dom
/**
 * The screen that shows a new recovery phrase offers no way to put the phrase
 * on the clipboard.
 *
 * A "copy" button next to the words reads as "this is the safe way to keep
 * them" and sends the phrase to every program that watches the clipboard. The
 * screen's own warning says the opposite, so the two cannot coexist.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import i18next from "i18next";
import ts from "typescript";
import { I18nextProvider, initReactI18next } from "react-i18next";
import en from "../../../../locales/en/wallet.json";
import night from "../../../../locales/en/night.json";
import { SeedPhraseStep } from "../SeedPhraseStep";

// Located from this file, not process.cwd(): run from another checkout, the
// walk below would read that checkout's source and pass or fail on it.
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

const PHRASE ="abandon ability able about above absent absorb abstract absurd abuse access accident";

const i18n = i18next.createInstance();
await i18n.use(initReactI18next).init({
  lng: "en",
  defaultNS: "wallet",
  ns: ["wallet"],
  resources: { en: { wallet: en } },
  interpolation: { escapeValue: false },
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function shown(concealed: boolean) {
  return render(
    <I18nextProvider i18n={i18n}>
      <SeedPhraseStep
        phrase={PHRASE}
        concealed={concealed}
        onReveal={() => {}}
        onNext={() => {}}
        onCancel={() => {}}
      />
    </I18nextProvider>,
  );
}

describe("recovery phrase screen", () => {
  it("shows the words and exactly two controls: continue and cancel", () => {
    const { container, getAllByRole } = shown(false);
    expect(container.textContent).toContain("abandon");
    expect(container.textContent).toContain("accident");
    expect(getAllByRole("button").map((b) => b.textContent)).toEqual([
      en.local_words_next,
      en.local_cancel,
    ]);
  });

  it("writes nothing to the clipboard whichever control is pressed", () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const { getAllByRole } = shown(false);
    for (const b of getAllByRole("button")) fireEvent.click(b);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("while concealed, shows no words and no copy control", () => {
    const { container, getAllByRole } = shown(true);
    expect(container.textContent).not.toContain("abandon");
    const labels = getAllByRole("button").map((b) => b.textContent);
    expect(labels).not.toContain("⧉");
    expect(labels).toHaveLength(3);
  });

  /**
   * An allow-list, not a deny-list: a phrase held in a variable called
   * `revealed` or `secret` matches no pattern of bad names, and the reveal
   * screen for an existing wallet holds it in exactly such a variable. So every
   * value handed to a copy button, or to a component that passes it on to one,
   * must be one of these — public identifiers — and a new one has to be added
   * here, in a diff someone reads.
   *
   * Keyed by file and component: `a.address` is an address where it is written
   * today, and anything a caller likes in a component added next to it.
   */
  const COPYABLE = new Set([
    "src/components/night/NightRedeem.tsx#NightRedeem: address",
    // `WalletTabs` copies the hash of a transaction it found in storage under
    // these two keys, so they count as handed to its copy button.
    "src/components/wallet/Cip30Panel.tsx#Cip30Panel: conn.changeAddress",
    "src/components/wallet/Cip30Panel.tsx#Cip30Panel: conn.networkId",
    "src/components/wallet/LocalWalletPanel.tsx#LocalWalletPanel: account.network",
    "src/components/wallet/LocalWalletPanel.tsx#LocalWalletPanel: changeAddrHex",
    // The port the panels below get the hash of a sent transaction back from,
    // and what they ask it with — not the hash, but what it is derived from.
    "src/components/wallet/Cip30Panel.tsx#Cip30Panel: port",
    "src/components/wallet/LocalWalletPanel.tsx#LocalWalletPanel: port",
    "src/components/wallet/WalletTabs.tsx#WalletTabs: changeAddress",
    "src/components/wallet/WalletTabs.tsx#WalletTabs: network",
    "src/components/wallet/WalletTabs.tsx#WalletTabs: port",
    "src/components/wallet/BalanceView.tsx#BalanceView: address",
    "src/components/wallet/Cip30Panel.tsx#Cip30Panel: receiveAddress",
    "src/components/wallet/HistoryPanel.tsx#HistoryPanel: e.txHash",
    "src/components/wallet/HistoryPanel.tsx#HistoryPanel: u.txHash",
    "src/components/wallet/LocalWalletPanel.tsx#LocalWalletPanel: primaryAddress(account)",
    "src/components/wallet/PhoenixCustodyPanel.tsx#PhoenixCustodyPanel: anchorName",
    "src/components/wallet/PhoenixCustodyPanel.tsx#PhoenixCustodyPanel: custodyAddress",
    "src/components/wallet/PhoenixCustodyPanel.tsx#PhoenixCustodyPanel: sessionDid",
    "src/components/wallet/ReceivePanel.tsx#AddressCard: address",
    "src/components/wallet/ReceivePanel.tsx#ReceivePanel: derived.address",
    "src/components/wallet/ReceivePanel.tsx#ReceivePanel: r.address",
    "src/components/wallet/ReceivePanel.tsx#ReceivePanel: walletAddress",
    "src/components/wallet/ReviewOutput.tsx#ReviewOutput: address",
    "src/components/wallet/SendPanel.tsx#SendPanel: o",
    "src/components/wallet/SendPanel.tsx#SendPanel: txHash",
    "src/components/wallet/UncertainSubmitNotice.tsx#UncertainSubmitNotice: txHash",
    "src/components/wallet/WalletHub.tsx#WalletHub: did",
    "src/components/wallet/WalletTabs.tsx#WalletTabs: uncertainHash",
    // Also set by `rememberUncertain`, handed to the money panels as
    // `onUncertain`: they call it with the hash of a submit whose reply never came.
    "src/components/wallet/WalletTabs.tsx#WalletTabs: uncertainHash holds a value handed in where the test cannot see what with",
    "src/components/wallet/WatchOnlyPanel.tsx#WatchOnlyPanel: a.address",
    "src/components/wallet/WatchOnlyPanel.tsx#WatchOnlyPanel: wallet.stakeAddress",
    "src/components/wallet/WatchOnlyPanel.tsx#WatchOnlyPanel: watched",
  ]);

  /**
   * Components whose copy button is handed something that comes from one of
   * their own props, and that prop. Not a list the test reads to find them —
   * it finds them in the code, then requires this list to match, so a new one
   * shows up in a diff rather than passing silently. What callers hand such a
   * prop is held to `COPYABLE` like a copy button's own value.
   */
  const FORWARDS = [
    "src/components/wallet/BalanceView.tsx#BalanceView: address",
    // These copy a hash the port answered with; it is set in state from the
    // answer, so it counts as derived from the port and what it was asked with.
    "src/components/wallet/HistoryPanel.tsx#HistoryPanel: network",
    "src/components/wallet/HistoryPanel.tsx#HistoryPanel: port",
    "src/components/wallet/PhoenixCustodyPanel.tsx#PhoenixCustodyPanel: did",
    "src/components/wallet/ReceivePanel.tsx#AddressCard: address",
    "src/components/wallet/ReceivePanel.tsx#ReceivePanel: network",
    "src/components/wallet/ReceivePanel.tsx#ReceivePanel: port",
    "src/components/wallet/ReviewOutput.tsx#ReviewOutput: output",
    "src/components/wallet/SendPanel.tsx#SendPanel: changeAddress",
    "src/components/wallet/SendPanel.tsx#SendPanel: network",
    "src/components/wallet/SendPanel.tsx#SendPanel: port",
    "src/components/wallet/UncertainSubmitNotice.tsx#UncertainSubmitNotice: txHash",
    "src/components/wallet/WalletHub.tsx#WalletHub: did",
    // The stored hash it copies is looked up by these; more than strictly
    // flows, which can only make callers' values checked that need not be.
    "src/components/wallet/WalletTabs.tsx#WalletTabs: changeAddress",
    "src/components/wallet/WalletTabs.tsx#WalletTabs: network",
    "src/components/wallet/WalletTabs.tsx#WalletTabs: networkId",
    "src/components/wallet/WalletTabs.tsx#WalletTabs: port",
  ];

  const COPY_BTN_FILE = "src/components/CopyBtn.tsx";
  const LOCALES: Record<string, Record<string, unknown> | undefined> = { wallet: en, night };

  /**
   * Shipped source, parsed, keyed by repo-relative path. Parsed rather than
   * matched as text: a hand-made comment stripper reads `accept="image/*"` as
   * the start of a comment and swallows the code after it, and `[^>]*` stops
   * at the first `=>` inside a tag.
   */
  /**
   * Types of the shipped source, for one question only: can a value hold
   * anything? A string handed to a call cannot be written into; an object can.
   */
  let checker: ts.TypeChecker | undefined;
  const shipped = () => {
    const paths: string[] = [];
    const walk = (dir: string) => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, ent.name);
        if (ent.isDirectory()) {
          if (ent.name !== "__tests__" && ent.name !== "node_modules") walk(p);
        } else if (/\.[cm]?[jt]sx?$/.test(ent.name) && !/\.d\.[cm]?ts$/.test(ent.name)) paths.push(p);
      }
    };
    walk(join(REPO, "src"));
    walk(join(REPO, "extension/src"));
    const config = ts.getParsedCommandLineOfConfigFile(join(REPO, "tsconfig.json"), {}, {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (d) => {
        throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n"));
      },
    });
    if (!config) throw new Error("tsconfig.json did not parse");
    const program = ts.createProgram(paths, { ...config.options, allowJs: true, noEmit: true });
    checker = program.getTypeChecker();
    const out = new Map<string, ts.SourceFile>();
    for (const p of paths) {
      const sf = program.getSourceFile(p);
      if (!sf) throw new Error(`${p} is not in the program`);
      out.set(relative(REPO, p).split(sep).join("/"), sf);
    }
    return out;
  };
  /** A value of a type no write can go into: a string, a number, a literal of one, or a union of them. */
  const primitive = (e: ts.Node) => {
    if (!checker) throw new Error("types asked for before the source was read");
    const t = checker.getTypeAtLocation(e);
    const flat = (t.isUnion() ? t.types : [t]) as ts.Type[];
    const plain =
      ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike | ts.TypeFlags.BooleanLike |
      ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void | ts.TypeFlags.Never;
    return flat.every((u) => (u.flags & plain) !== 0);
  };

  const each = (sf: ts.SourceFile, f: (n: ts.Node) => void) => {
    const go = (n: ts.Node) => {
      f(n);
      ts.forEachChild(n, go);
    };
    go(sf);
  };

  const at = (sf: ts.SourceFile, n: ts.Node) =>
    sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

  type Owner = { name: string; fn?: ts.SignatureDeclaration & { body?: ts.Node } };

  /** The top-level declaration a node sits in — the component, for JSX. */
  const owner = (n: ts.Node): Owner => {
    let s = n;
    while (s.parent && !ts.isSourceFile(s.parent)) s = s.parent;
    const fnOf = (e: ts.Node | undefined): Owner["fn"] => {
      // Through any depth of wrapping: `memo(forwardRef((props, ref) => …))`.
      while (e && (ts.isCallExpression(e) || ts.isParenthesizedExpression(e) || ts.isAsExpression(e))) {
        e = ts.isCallExpression(e)
          ? e.arguments.find((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a) || ts.isCallExpression(a))
          : e.expression;
      }
      return e && (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) ? e : undefined;
    };
    if (ts.isFunctionDeclaration(s)) return { name: s.name?.text ?? "default", fn: s };
    if (ts.isClassDeclaration(s)) return { name: s.name?.text ?? "default" };
    if (ts.isExportAssignment(s)) return { name: "default", fn: fnOf(s.expression) };
    if (ts.isVariableStatement(s)) {
      const d = s.declarationList.declarations.find((d) => d.pos <= n.pos && n.end <= d.end);
      if (d) return { name: d.name.getText(), fn: fnOf(d.initializer) };
    }
    return { name: "<module>" };
  };

  /** Taint of a value handed in from somewhere the test cannot follow. */
  const UNSEEN = "<unseen>";
  /**
   * For one component: every name in its body that holds something from its
   * props, mapped to the props it came from. A destructured prop, a name
   * assigned from one by any assignment (`const sessionDid = did?.trim()`,
   * `s += did`, `[s] = [did]`), a name a call handed one may keep it in
   * (`kept.push(did)`, `Object.assign(box, { did })`), a nested `function`
   * returning one, the parameters of a nested function called with one (handed
   * to a call that is handed one, `rows.map((r) => …)`; a prop or child of an
   * element handed one; or called by name with one), the variable of a
   * `for…of` / `for…in` over one, and state whose setter is called with one,
   * passed by reference to such a call, or handed as a JSX prop (then it holds
   * what that element is handed). In a component with props, a setter or the
   * parameters of a nested function that go anywhere else are `UNSEEN`. `*` is
   * the whole props object. A function's own parameters shadow outer names.
   */
  const fromProps = (fn: NonNullable<Owner["fn"]>) => {
    const taint = new Map<string, Set<string>>();
    const add = (name: string, props: Iterable<string>) => {
      const s = taint.get(name) ?? new Set<string>();
      const before = s.size;
      for (const p of props) s.add(p);
      taint.set(name, s);
      return s.size !== before;
    };
    const bind = (b: ts.BindingName, props: Set<string>): boolean => {
      if (ts.isIdentifier(b)) return add(b.text, props);
      let changed = false;
      for (const el of b.elements) {
        if (ts.isOmittedExpression(el)) continue;
        // `{ address } = props` takes exactly the prop it names.
        const key = el.propertyName ?? (ts.isIdentifier(el.name) ? el.name : undefined);
        const narrowed =
          ts.isObjectBindingPattern(b) && props.has("*") && key && !el.dotDotDotToken
            ? new Set([key.getText(), ...[...props].filter((p) => p !== "*")])
            : props;
        changed = bind(el.name, narrowed) || changed;
      }
      return changed;
    };
    for (const p of fn.parameters) bind(p.name, new Set(["*"]));
    /** Every name a binding pattern declares. */
    const names = (b: ts.BindingName): string[] =>
      ts.isIdentifier(b) ? [b.text] : b.elements.flatMap((el) => (ts.isOmittedExpression(el) ? [] : names(el.name)));
    /** `useState`, `React.useState`, `React["useState"]` and the same for `useReducer`. */
    const isStateHook = (e: ts.Expression) =>
      (ts.isIdentifier(e) && /^use(State|Reducer)$/.test(e.text)) ||
      (ts.isPropertyAccessExpression(e) && /^use(State|Reducer)$/.test(e.name.text)) ||
      (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression) && /^use(State|Reducer)$/.test(e.argumentExpression.text));
    /** The one shape whose setter is followed: `const [state, setState] = useState(…)`. */
    const statePair = (call: ts.CallExpression) => {
      const d = call.parent;
      if (!ts.isVariableDeclaration(d) || d.initializer !== call || !ts.isArrayBindingPattern(d.name)) return false;
      const els = d.name.elements;
      return (
        els.length <= 2 &&
        els.every((el) => ts.isOmittedExpression(el) || !el.dotDotDotToken) &&
        (els.length < 2 || (ts.isBindingElement(els[1]) && ts.isIdentifier(els[1].name)))
      );
    };
    // Inside a function, its own parameters are not the names outside it of the
    // same spelling: `(a) => a.toFixed()` holds nothing until it is called.
    const of = (e: ts.Node): Set<string> => {
      const out = new Set<string>();
      const go = (n: ts.Node, shadow: ReadonlySet<string>) => {
        if (ts.isFunctionLike(n) && n !== fn && n.parameters.length) {
          const inner = new Set(shadow);
          for (const p of n.parameters) for (const x of names(p.name)) inner.add(x);
          shadow = inner;
        }
        const tainted = (x: string) => (shadow.has(x) ? undefined : taint.get(x));
        if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && tainted(n.expression.text)?.has("*")) {
          out.add(n.name.text);
          for (const p of tainted(n.expression.text)!) if (p !== "*") out.add(p);
          return;
        }
        // State any other way than `[state, setState]` — `const st = useState(…)`,
        // `{ 0: s, 1: set }` — has a setter the test cannot follow: the state
        // holds `UNSEEN`. The hook handed on or renamed fails the clipboard test.
        if (ts.isCallExpression(n) && isStateHook(n.expression) && !statePair(n)) for (const x of unseen()) out.add(x);
        if (ts.isPropertyAccessExpression(n)) return go(n.expression, shadow);
        if (ts.isPropertyAssignment(n)) return go(n.initializer, shadow);
        if (ts.isIdentifier(n)) for (const p of tainted(n.text) ?? []) out.add(p);
        ts.forEachChild(n, (c) => go(c, shadow));
      };
      go(e, new Set());
      return out;
    };
    // `const [shown, setShown] = useState(…)`: what the setter is handed is shown.
    const setters = new Map<string, ts.BindingName>();
    const findSetters = (n: ts.Node) => {
      if (ts.isCallExpression(n) && isStateHook(n.expression) && statePair(n)) {
        const [state, setter] = (n.parent as ts.VariableDeclaration & { name: ts.ArrayBindingPattern }).name.elements;
        if (state && setter && ts.isBindingElement(state) && ts.isBindingElement(setter) && ts.isIdentifier(setter.name))
          setters.set(setter.name.text, state.name);
      }
      ts.forEachChild(n, findSetters);
    };
    if (fn.body) findSetters(fn.body);
    /** What a call hands a function given to it: the object it is called on and its other arguments. */
    const handedBy = (call: ts.CallExpression, skip: ts.Node) => {
      const t = new Set<string>();
      if (ts.isPropertyAccessExpression(call.expression)) for (const p of of(call.expression.expression)) t.add(p);
      for (const a of call.arguments) if (a !== skip) for (const p of of(a)) t.add(p);
      return t;
    };
    /** The left of any assignment: a name, a member of one, or a pattern of them. */
    const assign = (e: ts.Expression, t: Set<string>): boolean => {
      if (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e)) return assign(e.expression, t);
      if (ts.isIdentifier(e)) return add(e.text, t);
      if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) return assign(e.expression, t);
      if (ts.isSpreadElement(e)) return assign(e.expression, t);
      if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken) return assign(e.left, t);
      let changed = false;
      if (ts.isArrayLiteralExpression(e)) for (const el of e.elements) changed = assign(el, t) || changed;
      if (ts.isObjectLiteralExpression(e))
        for (const p of e.properties) {
          if (ts.isPropertyAssignment(p)) changed = assign(p.initializer, t) || changed;
          else if (ts.isShorthandPropertyAssignment(p)) changed = add(p.name.text, t) || changed;
          else if (ts.isSpreadAssignment(p)) changed = assign(p.expression, t) || changed;
        }
      return changed;
    };
    /** Names declared in the component — not `Object`, `JSON`, `console` or an import. */
    const locals = new Set<string>();
    const declared = (m: ts.Node) => {
      if (ts.isVariableDeclaration(m) || ts.isParameter(m)) for (const x of names(m.name)) locals.add(x);
      ts.forEachChild(m, declared);
    };
    declared(fn);
    /** The name a member chain starts from: `box` for `box.inner[0]`. */
    const rootName = (e: ts.Expression): string =>
      ts.isPropertyAccessExpression(e) ||
      ts.isElementAccessExpression(e) ||
      ts.isParenthesizedExpression(e) ||
      ts.isNonNullExpression(e) ||
      ts.isAsExpression(e) ||
      ts.isSatisfiesExpression(e) ||
      ts.isTypeAssertionExpression(e)
        ? rootName(e.expression)
        : ts.isIdentifier(e)
          ? e.text
          : "";
    /** `{…}` as a JSX prop or child: what the element it sits in is handed. */
    const inElement = (x: ts.JsxExpression) => {
      const el = ts.isJsxAttribute(x.parent) ? x.parent.parent.parent : x.parent;
      return of(ts.isJsxOpeningElement(el) ? el.parent : el);
    };
    const unseen = () => new Set(fn.parameters.length ? [UNSEEN] : []);
    /** What one use of a function, the function itself or a name for it, calls it with. */
    const callsWith = (use: ts.Node): Set<string> => {
      const p = use.parent;
      if (ts.isCallExpression(p) && p.expression === use) {
        const t = new Set<string>();
        for (const a of p.arguments) for (const x of of(a)) t.add(x);
        return t;
      }
      if (ts.isCallExpression(p) && p.arguments.includes(use as ts.Expression)) {
        // `useCallback(f, deps)` hands `f` back to be called by whoever gets the name.
        if (/(^|\.)useCallback$/.test(p.expression.getText()) && ts.isVariableDeclaration(p.parent)) return byName(p.parent);
        return handedBy(p, use);
      }
      if (ts.isJsxExpression(p)) return inElement(p);
      if (ts.isParenthesizedExpression(p)) return callsWith(p);
      return unseen();
    };
    /** Every use of the name a function is bound to; none at all leaves it uncalled. */
    const byName = (d: ts.VariableDeclaration | ts.FunctionDeclaration): Set<string> => {
      if (!d.name || !ts.isIdentifier(d.name)) return unseen();
      const name = d.name.text;
      const t = new Set<string>();
      const look = (m: ts.Node) => {
        if (ts.isIdentifier(m) && m.text === name && m !== d.name) for (const x of callsWith(m)) t.add(x);
        ts.forEachChild(m, look);
      };
      if (fn.body) look(fn.body);
      return t;
    };
    /**
     * What a function declared inside the component is called with, from where
     * it goes: a call it is handed to (`rows.map(cb)`), the element it is a prop
     * or child of (`onDone={(v) => setShown(v)}` gets what that element gets),
     * or every use of the name it is bound to. Anywhere else, a component with
     * props could be handing it anything: `UNSEEN`.
     */
    const calledWith = (f: ts.SignatureDeclaration): Set<string> => {
      if (ts.isFunctionDeclaration(f)) return byName(f);
      if (ts.isVariableDeclaration(f.parent) && f.parent.initializer === f) return byName(f.parent);
      return callsWith(f);
    };
    // A setter handed anywhere but a call that hands it values of its own is
    // called with something the test cannot see: its state holds `UNSEEN`.
    for (let changed = true; changed; ) {
      changed = false;
      const go = (n: ts.Node) => {
        if (ts.isForOfStatement(n) || ts.isForInStatement(n)) {
          const t = of(n.expression);
          if (t.size)
            if (ts.isVariableDeclarationList(n.initializer))
              for (const d of n.initializer.declarations) changed = bind(d.name, t) || changed;
            else changed = assign(n.initializer, t) || changed;
        } else if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && setters.has(n.expression.text) && n.arguments[0]) {
          const t = of(n.arguments[0]);
          if (t.size) changed = bind(setters.get(n.expression.text)!, t) || changed;
        } else if (ts.isIdentifier(n) && setters.has(n.text) && !(ts.isBindingElement(n.parent) && n.parent.name === n)) {
          const call = n.parent;
          if (ts.isCallExpression(call) && call.expression !== n && call.arguments.includes(n as ts.Expression)) {
            // `.then(setShown)`: handed what the call is handed.
            const t = handedBy(call, n);
            if (t.size) changed = bind(setters.get(n.text)!, t) || changed;
          } else if (!(ts.isCallExpression(call) && call.expression === n) && fn.parameters.length) {
            // Without props there is nothing of the caller's it could be handed.
            // `<Field onChange={setShown} … />`: handed what that element is.
            const el = ts.isJsxExpression(call) && ts.isJsxAttribute(call.parent) ? call.parent.parent.parent : undefined;
            const t = el ? of(ts.isJsxOpeningElement(el) ? el.parent : el) : new Set([UNSEEN]);
            if (t.size) changed = bind(setters.get(n.text)!, t) || changed;
          }
        }
        if (ts.isVariableDeclaration(n) && n.initializer) {
          const t = of(n.initializer);
          if (t.size) changed = bind(n.name, t) || changed;
        } else if (
          ts.isBinaryExpression(n) &&
          n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          n.operatorToken.kind <= ts.SyntaxKind.LastAssignment
        ) {
          // `=`, `+=`, `??=`, and a pattern on the left: `[txHash] = pair`.
          const t = of(n.right);
          if (t.size) changed = assign(n.left, t) || changed;
        } else if (ts.isFunctionLike(n) && n !== fn && n.parameters.length) {
          const t = calledWith(n);
          if (t.size) for (const p of n.parameters) changed = bind(p.name, t) || changed;
        }
        // `function current() { return secret; }`: the name holds what it returns;
        // `class K { v = secret }`: the class holds what its members do.
        if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) && n !== fn && n.name && (ts.isClassDeclaration(n) || n.body)) {
          const t = of(n);
          if (t.size) changed = add(n.name.text, t) || changed;
        }
        // `kept.push(secret)`, `Reflect.set(box, "v", secret)`,
        // `[].push.call(kept, secret)`: a call may keep anything it is handed in
        // any local it is handed — the object it is called on or an argument —
        // whose type can hold anything: `network` handed beside a hash stays a
        // network name, a box handed beside it may now hold the hash.
        if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
          const handed = [...(n.arguments ?? [])];
          const callee = n.expression;
          if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) handed.push(callee.expression);
          const t = new Set<string>();
          for (const a of handed) for (const p of of(a)) t.add(p);
          if (t.size)
            for (const a of handed) if (locals.has(rootName(a)) && !primitive(a)) changed = assign(a, t) || changed;
        }
        // `const alias = kept` or `ref = box`: both names are one object, so what
        // is kept through the alias is kept in the original too.
        const alias =
          ts.isVariableDeclaration(n) && n.initializer
            ? { names: names(n.name), from: n.initializer }
            : ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left)
              ? { names: [n.left.text], from: n.right }
              : undefined;
        if (alias) {
          const r = rootName(alias.from);
          if (r && locals.has(r))
            for (const x of alias.names) {
              const t = taint.get(x);
              if (t?.size) changed = add(r, t) || changed;
            }
        }
        ts.forEachChild(n, go);
      };
      if (fn.body) go(fn.body);
    }
    return of;
  };

  /**
   * Calls that run a function handed to them on the spot, with values from what
   * they are called on: the function's parameters are those values. Any other
   * function with parameters inside a component — a component or helper of its
   * own, `useCallback`'s — is called from somewhere the test does not follow.
   */
  const RUNS_CALLBACK = /^(map|flatMap|forEach|filter|find|findLast|some|every|reduce|reduceRight|then|catch)$/;
  const runsCallback = (f: ts.Node) => {
    const call = f.parent;
    if (!ts.isCallExpression(call) || !call.arguments.includes(f as ts.Expression)) return false;
    const c = call.expression;
    return (
      (ts.isPropertyAccessExpression(c) && RUNS_CALLBACK.test(c.name.text)) ||
      (ts.isPropertyAccessExpression(c) && c.getText() === "Array.from")
    );
  };

  /**
   * Every copy button and every component that hands one of its own props to
   * one, found in the code rather than read from a list. A copy button is
   * watched for `value`; a component whose watched element is handed something
   * from its props is then watched for those props, and so on until nothing
   * new turns up.
   */
  const EXTS = [".tsx", ".ts", ".jsx", ".js", ".mts", ".cts", ".mjs", ".cjs"];

  /** The shipped file an import names, or undefined for a package. */
  const resolveModule = (files: Map<string, ts.SourceFile>, from: string, spec: string) => {
    const base = spec.startsWith("@/")
      ? `src/${spec.slice(2)}`
      : spec.startsWith(".")
        ? posix.join(posix.dirname(from), spec)
        : undefined;
    if (base === undefined) return undefined;
    // `./CopyBtn.js` names `./CopyBtn.tsx` to the compiler and the bundler.
    const stem = base.replace(/\.[cm]?jsx?$/, "");
    return [base, ...EXTS.map((e) => base + e), ...EXTS.map((e) => stem + e), ...EXTS.map((e) => `${base}/index${e}`)].find((c) =>
      files.has(c),
    );
  };

  /**
   * Per file, what each top-level name means: `<file>#<name>` of its own
   * declarations and of what it imports by name. A tag is matched through
   * this, so two components that share a name in two files are two components.
   */
  const scopes = (files: Map<string, ts.SourceFile>) => {
    const out = new Map<string, Map<string, string>>();
    for (const [rel, sf] of files) {
      const scope = new Map<string, string>();
      for (const s of sf.statements) {
        if ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) && s.name) scope.set(s.name.text, `${rel}#${s.name.text}`);
        if (ts.isVariableStatement(s))
          for (const d of s.declarationList.declarations)
            if (ts.isIdentifier(d.name)) scope.set(d.name.text, `${rel}#${d.name.text}`);
        if (ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier) && s.importClause) {
          const target = resolveModule(files, rel, s.moduleSpecifier.text);
          if (!target) continue;
          if (s.importClause.name) scope.set(s.importClause.name.text, `${target}#default`);
          const nb = s.importClause.namedBindings;
          if (nb && ts.isNamedImports(nb))
            for (const el of nb.elements) scope.set(el.name.text, `${target}#${(el.propertyName ?? el.name).text}`);
        }
      }
      out.set(rel, scope);
    }
    return out;
  };

  const survey = () => {
    const files = shipped();
    const scope = scopes(files);
    const watched = new Map<string, Set<string>>([[`${COPY_BTN_FILE}#CopyBtn`, new Set(["value"])]]);
    let seen: string[] = [];
    let forwards: Set<string>;
    const tainters = new Map<NonNullable<Owner["fn"]>, ReturnType<typeof fromProps>>();
    for (let grew = true; grew; ) {
      grew = false;
      seen = [];
      forwards = new Set();
      for (const [rel, sf] of files) {
        each(sf, (n) => {
          if (!ts.isJsxOpeningElement(n) && !ts.isJsxSelfClosingElement(n)) return;
          if (!ts.isIdentifier(n.tagName)) return;
          const tag = n.tagName.text;
          const props = watched.get(scope.get(rel)!.get(tag) ?? "");
          if (!props) return;
          const o = owner(n);
          const key = `${rel}#${o.name}`;
          // A class, a value at module level, or a wrapper not unwrapped above:
          // where the props come from cannot be read, so it cannot pass.
          if (!o.fn) {
            seen.push(`${key}: <${tag}> sits where the test cannot read its props`);
            return;
          }
          // A component or helper declared inside this one: its parameters are
          // whatever its own callers hand it, which this test does not follow.
          for (let s: ts.Node = n.parent; s !== o.fn; s = s.parent)
            if (ts.isFunctionLike(s) && s.parameters.length && !runsCallback(s)) {
              seen.push(`${key}: <${tag}> sits in a function inside it the test cannot see the callers of`);
              return;
            }
          const handed: ts.Node[] = [];
          const fnBody = o.fn;
          /**
           * The props a spread sets, when it is a local object literal touched
           * nowhere but where it is declared and spread (`{ port, network }`,
           * itself spreading another such literal). Anything else — a prop, a
           * call, a literal written to after — is unreadable.
           */
          const expand = (e: ts.Expression, depth = 0): [string, ts.Node][] | undefined => {
            if (!ts.isIdentifier(e) || depth > 4) return undefined;
            const decls: ts.VariableDeclaration[] = [];
            let foreign = false;
            const look = (m: ts.Node) => {
              if (ts.isIdentifier(m) && m.text === e.text) {
                const q = m.parent;
                if (ts.isVariableDeclaration(q) && q.name === m) decls.push(q);
                else if (!((ts.isJsxSpreadAttribute(q) || ts.isSpreadAssignment(q)) && q.expression === m)) foreign = true;
              }
              ts.forEachChild(m, look);
            };
            look(fnBody);
            const init = decls.length === 1 ? decls[0].initializer : undefined;
            if (foreign || !init || !ts.isObjectLiteralExpression(init)) return undefined;
            const out: [string, ts.Node][] = [];
            for (const p of init.properties) {
              if (ts.isShorthandPropertyAssignment(p)) out.push([p.name.text, p.name]);
              else if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)))
                out.push([p.name.text, p.initializer]);
              else if (ts.isSpreadAssignment(p)) {
                const inner = expand(p.expression, depth + 1);
                if (!inner) return undefined;
                out.push(...inner);
              } else return undefined;
            }
            return out;
          };
          for (const a of n.attributes.properties) {
            // A spread can set the prop, or override it, out of sight of the list.
            if (ts.isJsxSpreadAttribute(a)) {
              const set = expand(a.expression);
              if (!set) seen.push(`${key}: <${tag} {...${a.expression.getText(sf)}}>`);
              else for (const [prop, e] of set) if (props.has(prop) || props.has("*")) handed.push(e);
              continue;
            }
            const prop = a.name.getText(sf);
            if (!props.has(prop) && !props.has("*")) continue;
            const e = a.initializer && ts.isJsxExpression(a.initializer) ? a.initializer.expression : undefined;
            if (!e) {
              seen.push(`${key}: <${tag} ${prop} not a {…} expression>`);
              continue;
            }
            handed.push(e);
          }
          // What sits between the tags is the `children` prop.
          if ((props.has("children") || props.has("*")) && ts.isJsxOpeningElement(n) && ts.isJsxElement(n.parent))
            for (const c of n.parent.children) {
              if (ts.isJsxText(c) && c.containsOnlyTriviaWhiteSpaces) continue;
              handed.push(ts.isJsxExpression(c) && c.expression ? c.expression : c);
            }
          if (!tainters.has(o.fn)) tainters.set(o.fn, fromProps(o.fn));
          const taintOf = tainters.get(o.fn)!;
          for (const e of handed) {
            seen.push(`${key}: ${e.getText(sf)}`);
            for (const p of taintOf(e)) {
              if (p === UNSEEN) {
                seen.push(`${key}: ${e.getText(sf)} holds a value handed in where the test cannot see what with`);
                continue;
              }
              forwards.add(`${key}: ${p}`);
              const ow = watched.get(key) ?? new Set<string>();
              if (!ow.has(p)) {
                ow.add(p);
                watched.set(key, ow);
                grew = true;
              }
            }
          }
        });
      }
    }
    return { files, scope, watched, seen, forwards: [...forwards!].sort() };
  };

  it("no copy button anywhere is handed anything but an address, a hash or a name", () => {
    const { seen, forwards } = survey();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((s) => !COPYABLE.has(s))).toEqual([]);
    // Forwarders the code has that the list does not, and the other way round.
    expect(forwards).toEqual([...FORWARDS].sort());
  });

  it("nothing but the copy button reaches the clipboard, or a copy button by another name", () => {
    const { files, scope, watched } = survey();
    const offences: string[] = [];
    /** An import path that names one of the files above, however it is spelled. */
    const watchedModule = new RegExp(
      `(^|/)(${[...new Set([...watched.keys()].map((k) => k.replace(/#.*$/, "").replace(/^.*\//, "").replace(/\.[cm]?[jt]sx?$/, "")))].join("|")})(\\.[cm]?[jt]sx?)?$`,
    );
    /** An i18n key that exists: a sentence about the clipboard, not a write to it. */
    const isKey = (k: string) => {
      const i = k.indexOf(":");
      const ns = i < 0 ? undefined : k.slice(0, i);
      const path = i < 0 ? k : k.slice(i + 1);
      const tables = ns ? [LOCALES[ns]] : Object.values(LOCALES);
      return tables.some((tb) => {
        if (!tb) return false;
        if (typeof tb[path] === "string") return true;
        let o: unknown = tb;
        for (const s of path.split(".")) o = o && typeof o === "object" ? (o as Record<string, unknown>)[s] : undefined;
        return typeof o === "string";
      });
    };
    for (const [rel, sf] of files) {
      if (rel === COPY_BTN_FILE) {
        // The one file allowed to write the clipboard hands out nothing but the
        // button: a helper exported next to it would copy whatever it is given.
        for (const s of sf.statements) {
          const exported =
            ts.canHaveModifiers(s) && ts.getModifiers(s)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
          if (ts.isExportDeclaration(s) || ts.isExportAssignment(s)) {
            offences.push(`${rel}:${at(sf, s)}: exports other than \`export function CopyBtn\``);
          } else if (exported && !(ts.isFunctionDeclaration(s) && s.name?.text === "CopyBtn") && !ts.isTypeAliasDeclaration(s) && !ts.isInterfaceDeclaration(s)) {
            offences.push(`${rel}:${at(sf, s)}: exports other than \`export function CopyBtn\``);
          }
        }
        continue;
      }
      each(sf, (n) => {
        // Every way a page writes the clipboard: the async API under any spelling
        // (`navigator.clipboard`, `navigator["clipboard"]`, a saved reference),
        // the legacy `execCommand("copy")`, and a `copy` event's `clipboardData`.
        // The one string let through is a key handed to `t()` that the English
        // locale has: a sentence about the clipboard is not a write to it, and
        // a function merely named `t` handed "clipboard" finds no such key.
        const i18nKey =
          ts.isStringLiteralLike(n) &&
          ts.isCallExpression(n.parent) &&
          n.parent.arguments[0] === n &&
          (ts.isIdentifier(n.parent.expression) ? n.parent.expression.text === "t" : ts.isPropertyAccessExpression(n.parent.expression) && n.parent.expression.name.text === "t") &&
          isKey(n.text);
        if (ts.isIdentifier(n) || ts.isPrivateIdentifier(n) || (ts.isStringLiteralLike(n) && !i18nKey) || ts.isTemplateLiteralToken(n)) {
          if (/clipboard|execCommand/i.test(n.text)) offences.push(`${rel}:${at(sf, n)}: ${n.text}`);
        }
        // An import of a copy-button file is a plain named one; any other way
        // of loading it (default, namespace, re-export, `import()`, `require`)
        // yields the button under a name the value list above never reads.
        const p = n.parent;
        const loads =
          ts.isStringLiteralLike(n) &&
          ((ts.isImportDeclaration(p) && p.moduleSpecifier === n) ||
            (ts.isExportDeclaration(p) && p.moduleSpecifier === n) ||
            (ts.isCallExpression(p) &&
              p.arguments[0] === n &&
              (p.expression.kind === ts.SyntaxKind.ImportKeyword ||
                (ts.isIdentifier(p.expression) && p.expression.text === "require"))));
        // `import(\`../${name}.tsx\`)`, `require(x)`: a path built at run time can
        // name the copy button, and nothing here can read which file it is.
        if (
          ts.isCallExpression(n) &&
          (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require")) &&
          !(n.arguments[0] && ts.isStringLiteralLike(n.arguments[0]))
        )
          offences.push(`${rel}:${at(sf, n)}: loads a path the test cannot read`);
        // A source file of this repo the test cannot find from the import is a
        // file whose components it cannot tell apart, the copy button included.
        if (
          loads &&
          (n.text.startsWith(".") || n.text.startsWith("@/")) &&
          !/\.(css|json|svg|png|jpe?g|webp|gif|html|wasm)(\?.*)?$/.test(n.text) &&
          !resolveModule(files, rel, n.text)
        )
          offences.push(`${rel}:${at(sf, n)}: loads ${n.text}, which the test cannot find`);
        if (loads && watchedModule.test(n.text)) {
          const plain =
            ts.isImportDeclaration(p) &&
            !p.importClause?.name &&
            (!p.importClause?.namedBindings || ts.isNamedImports(p.importClause.namedBindings));
          if (!plain) offences.push(`${rel}:${at(sf, n)}: loads ${n.text} other than as a named import`);
        }
        // `import.meta` is read for `.env` and `.url` only: `.glob` and anything
        // reached through a cast loads files by a pattern the test cannot resolve.
        if (ts.isMetaProperty(n) && n.keywordToken === ts.SyntaxKind.ImportKeyword) {
          let up: ts.Node = n;
          while (
            ts.isParenthesizedExpression(up.parent) ||
            ts.isAsExpression(up.parent) ||
            ts.isSatisfiesExpression(up.parent) ||
            ts.isNonNullExpression(up.parent) ||
            ts.isTypeAssertionExpression(up.parent)
          )
            up = up.parent;
          const envOrUrl = (x: ts.Node) =>
            ts.isPropertyAccessExpression(x.parent) && x.parent.expression === x && /^(env|url)$/.test(x.parent.name.text);
          // `const meta = import.meta as unknown as { env?: … }`, where every later
          // `meta` in the file is `meta.env` or `meta.url`. The cast is not taken
          // on trust: a `meta` spelled any other way fails the whole form.
          const d = up.parent;
          const held =
            ts.isVariableDeclaration(d) &&
            d.initializer === up &&
            ts.isIdentifier(d.name) &&
            (() => {
              const name = (d.name as ts.Identifier).text;
              let only = true;
              each(sf, (m) => {
                if (ts.isIdentifier(m) && m.text === name && m !== d.name && !ts.isMetaProperty(m.parent) && !envOrUrl(m)) only = false;
              });
              return only;
            })();
          if (!envOrUrl(up) && !held) offences.push(`${rel}:${at(sf, n)}: import.meta used other than as import.meta.env or .url`);
        }
        // The state hook reached any way but a call: `import { useState as u }`,
        // `const { useState: u } = React`, `const h = useState`. The setter of
        // such a call is one the value list above cannot follow.
        if ((ts.isIdentifier(n) || ts.isStringLiteralLike(n)) && (n.text === "useState" || n.text === "useReducer")) {
          const ok =
            (ts.isCallExpression(p) && p.expression === n) ||
            (ts.isPropertyAccessExpression(p) && p.name === n && ts.isCallExpression(p.parent) && p.parent.expression === p) ||
            (ts.isElementAccessExpression(p) && p.argumentExpression === n && ts.isCallExpression(p.parent) && p.parent.expression === p) ||
            (ts.isImportSpecifier(p) && p.name === n && !p.propertyName);
          if (!ok) offences.push(`${rel}:${at(sf, n)}: ${n.text} reached other than by calling it`);
        }
        // The button reached any way but `<Name …>`, its own declaration and an
        // unaliased import — `as Other`, `createElement(Name, …)`, `[Name].map`,
        // `typeof Name` — is a copy button the value list above never sees.
        // Matched through the file's scope: `import { CopyBtn as C }` binds `C`
        // to the button, so `C` is caught here even though it is spelled apart.
        const named = ts.isIdentifier(n) ? scope.get(rel)!.get(n.text) : undefined;
        if (ts.isIdentifier(n) && named && watched.has(named)) {
          const ok =
            ((ts.isJsxOpeningElement(p) || ts.isJsxSelfClosingElement(p) || ts.isJsxClosingElement(p)) && p.tagName === n) ||
            (ts.isImportSpecifier(p) && p.name === n && !p.propertyName) ||
            (named === `${rel}#${n.text}` &&
              (ts.isFunctionDeclaration(p) || ts.isVariableDeclaration(p) || ts.isClassDeclaration(p)) &&
              p.name === n);
          if (!ok) offences.push(`${rel}:${at(sf, n)}: ${n.text} used other than as <${n.text} …>`);
        }
      });
    }
    expect(offences).toEqual([]);
  });
});
