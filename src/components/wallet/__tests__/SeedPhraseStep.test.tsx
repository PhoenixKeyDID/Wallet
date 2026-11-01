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
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import i18next from "i18next";
import ts from "typescript";
import { I18nextProvider, initReactI18next } from "react-i18next";
import en from "../../../../locales/en/wallet.json";
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
    "src/components/wallet/PhoenixCustodyPanel.tsx#PhoenixCustodyPanel: did",
    "src/components/wallet/ReceivePanel.tsx#AddressCard: address",
    "src/components/wallet/ReviewOutput.tsx#ReviewOutput: output",
    "src/components/wallet/UncertainSubmitNotice.tsx#UncertainSubmitNotice: txHash",
    "src/components/wallet/WalletHub.tsx#WalletHub: did",
    // The stored hash it copies is looked up by these; more than strictly
    // flows, which can only make callers' values checked that need not be.
    "src/components/wallet/WalletTabs.tsx#WalletTabs: changeAddress",
    "src/components/wallet/WalletTabs.tsx#WalletTabs: network",
    "src/components/wallet/WalletTabs.tsx#WalletTabs: networkId",
  ];

  const COPY_BTN_FILE = "src/components/CopyBtn.tsx";

  /**
   * Shipped source, parsed, keyed by repo-relative path. Parsed rather than
   * matched as text: a hand-made comment stripper reads `accept="image/*"` as
   * the start of a comment and swallows the code after it, and `[^>]*` stops
   * at the first `=>` inside a tag.
   */
  const shipped = () => {
    const out = new Map<string, ts.SourceFile>();
    const walk = (dir: string) => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, ent.name);
        if (ent.isDirectory()) {
          if (ent.name !== "__tests__" && ent.name !== "node_modules") walk(p);
        } else if (/\.[cm]?[jt]sx?$/.test(ent.name) && !/\.d\.[cm]?ts$/.test(ent.name)) {
          const kind = /\.[cm]?tsx$/.test(ent.name)
            ? ts.ScriptKind.TSX
            : /\.[cm]?ts$/.test(ent.name)
              ? ts.ScriptKind.TS
              : ts.ScriptKind.JSX;
          const sf = ts.createSourceFile(p, readFileSync(p, "utf8"), ts.ScriptTarget.Latest, true, kind);
          out.set(relative(REPO, p).split(sep).join("/"), sf);
        }
      }
    };
    walk(join(REPO, "src"));
    walk(join(REPO, "extension/src"));
    return out;
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
      while (e && (ts.isCallExpression(e) || ts.isParenthesizedExpression(e) || ts.isAsExpression(e))) {
        e = ts.isCallExpression(e) ? e.arguments.find((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a)) : e.expression;
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

  /**
   * For one component: every name in its body that holds something from its
   * props, mapped to the props it came from. A destructured prop, a variable
   * computed from one (`const sessionDid = did?.trim()`), a callback parameter
   * of a method called on one (`rows.map((r) => …)`). `*` is the whole props
   * object. Over-counts on shadowing, which can only add a forwarder.
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
    const of = (e: ts.Node): Set<string> => {
      const out = new Set<string>();
      const go = (n: ts.Node) => {
        if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && taint.get(n.expression.text)?.has("*")) {
          out.add(n.name.text);
          for (const p of taint.get(n.expression.text)!) if (p !== "*") out.add(p);
          return;
        }
        if (ts.isPropertyAccessExpression(n)) return go(n.expression);
        if (ts.isPropertyAssignment(n)) return go(n.initializer);
        if (ts.isIdentifier(n)) for (const p of taint.get(n.text) ?? []) out.add(p);
        ts.forEachChild(n, go);
      };
      go(e);
      return out;
    };
    for (let changed = true; changed; ) {
      changed = false;
      const go = (n: ts.Node) => {
        if (ts.isVariableDeclaration(n) && n.initializer) {
          const t = of(n.initializer);
          if (t.size) changed = bind(n.name, t) || changed;
        } else if (
          ts.isBinaryExpression(n) &&
          n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isIdentifier(n.left)
        ) {
          const t = of(n.right);
          if (t.size) changed = add(n.left.text, t) || changed;
        } else if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && n !== fn) {
          const call = n.parent;
          if (ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression)) {
            const t = of(call.expression.expression);
            if (t.size) for (const p of n.parameters) changed = bind(p.name, t) || changed;
          }
        }
        ts.forEachChild(n, go);
      };
      if (fn.body) go(fn.body);
    }
    return of;
  };

  /**
   * Every copy button and every component that hands one of its own props to
   * one, found in the code rather than read from a list. A copy button is
   * watched for `value`; a component whose watched element is handed something
   * from its props is then watched for those props, and so on until nothing
   * new turns up.
   */
  const survey = () => {
    const files = shipped();
    const watched = new Map<string, { rel: string; props: Set<string> }>([
      ["CopyBtn", { rel: COPY_BTN_FILE, props: new Set(["value"]) }],
    ]);
    const decl = new Map<string, string>();
    for (const [rel, sf] of files) {
      for (const s of sf.statements) {
        if ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) && s.name) decl.set(s.name.text, rel);
        if (ts.isVariableStatement(s))
          for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name)) decl.set(d.name.text, rel);
      }
    }
    let seen: string[] = [];
    let forwards: Set<string>;
    const tainters = new Map<NonNullable<Owner["fn"]>, (e: ts.Node) => Set<string>>();
    for (let grew = true; grew; ) {
      grew = false;
      seen = [];
      forwards = new Set();
      for (const [rel, sf] of files) {
        each(sf, (n) => {
          if (!ts.isJsxOpeningElement(n) && !ts.isJsxSelfClosingElement(n)) return;
          if (!ts.isIdentifier(n.tagName)) return;
          const tag = n.tagName.text;
          const w = watched.get(tag);
          if (!w) return;
          const o = owner(n);
          const key = `${rel}#${o.name}`;
          for (const a of n.attributes.properties) {
            // A spread can set the prop, or override it, out of sight of the list.
            if (ts.isJsxSpreadAttribute(a)) {
              seen.push(`${key}: <${tag} {...${a.expression.getText(sf)}}>`);
              continue;
            }
            const prop = a.name.getText(sf);
            if (!w.props.has(prop)) continue;
            const e = a.initializer && ts.isJsxExpression(a.initializer) ? a.initializer.expression : undefined;
            if (!e) {
              seen.push(`${key}: <${tag} ${prop} not a {…} expression>`);
              continue;
            }
            seen.push(`${key}: ${e.getText(sf)}`);
            if (!o.fn) continue;
            if (!tainters.has(o.fn)) tainters.set(o.fn, fromProps(o.fn));
            for (const p of tainters.get(o.fn)!(e)) {
              forwards.add(`${key}: ${p}`);
              const ow = watched.get(o.name) ?? { rel, props: new Set<string>() };
              if (!ow.props.has(p)) {
                ow.props.add(p);
                watched.set(o.name, ow);
                grew = true;
              }
            }
          }
        });
      }
    }
    // A component found to forward has to be declared where it is watched from.
    for (const [name, w] of watched) if (decl.has(name)) w.rel = decl.get(name)!;
    return { files, watched, seen, forwards: [...forwards!].sort() };
  };

  it("no copy button anywhere is handed anything but an address, a hash or a name", () => {
    const { seen, forwards } = survey();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((s) => !COPYABLE.has(s))).toEqual([]);
    // Forwarders the code has that the list does not, and the other way round.
    expect(forwards).toEqual([...FORWARDS].sort());
  });

  it("nothing but the copy button reaches the clipboard, or a copy button by another name", () => {
    const { files, watched } = survey();
    const offences: string[] = [];
    /** An import path that names one of the files above, however it is spelled. */
    const watchedModule = new RegExp(
      `(^|/)(${[...new Set([...watched.values()].map((w) => w.rel.replace(/^.*\//, "").replace(/\.[cm]?[jt]sx?$/, "")))].join("|")})(\\.[cm]?[jt]sx?)?$`,
    );
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
        // The one string let through is the key handed to `t()`: a sentence
        // about the clipboard is not a write to it.
        const i18nKey =
          ts.isStringLiteralLike(n) &&
          ts.isCallExpression(n.parent) &&
          n.parent.arguments[0] === n &&
          (ts.isIdentifier(n.parent.expression) ? n.parent.expression.text === "t" : ts.isPropertyAccessExpression(n.parent.expression) && n.parent.expression.name.text === "t");
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
        if (loads && watchedModule.test(n.text)) {
          const plain =
            ts.isImportDeclaration(p) &&
            !p.importClause?.name &&
            (!p.importClause?.namedBindings || ts.isNamedImports(p.importClause.namedBindings));
          if (!plain) offences.push(`${rel}:${at(sf, n)}: loads ${n.text} other than as a named import`);
        }
        // The button reached any way but `<Name …>`, its own declaration and an
        // unaliased import — `as Other`, `createElement(Name, …)`, `[Name].map`,
        // `typeof Name` — is a copy button the value list above never sees.
        if (ts.isIdentifier(n) && watched.has(n.text)) {
          const ok =
            ((ts.isJsxOpeningElement(p) || ts.isJsxSelfClosingElement(p) || ts.isJsxClosingElement(p)) && p.tagName === n) ||
            (ts.isImportSpecifier(p) && p.name === n && !p.propertyName) ||
            (rel === watched.get(n.text)!.rel &&
              (ts.isFunctionDeclaration(p) || ts.isVariableDeclaration(p) || ts.isClassDeclaration(p)) &&
              p.name === n);
          if (!ok) offences.push(`${rel}:${at(sf, n)}: ${n.text} used other than as <${n.text} …>`);
        }
      });
    }
    expect(offences).toEqual([]);
  });
});
