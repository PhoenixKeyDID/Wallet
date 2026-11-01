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
   * value handed to a copy button anywhere in the shipped code must be one of
   * these — public identifiers — and a new one has to be added here, in a diff
   * someone reads.
   *
   * Keyed by file: `a.address` is an address where it is written today, and a
   * prop of anything a caller likes in a new component.
   */
  const COPYABLE = new Set([
    "src/components/night/NightRedeem.tsx: address",
    "src/components/wallet/BalanceView.tsx: address",
    "src/components/wallet/Cip30Panel.tsx: receiveAddress",
    "src/components/wallet/HistoryPanel.tsx: e.txHash",
    "src/components/wallet/HistoryPanel.tsx: u.txHash",
    "src/components/wallet/LocalWalletPanel.tsx: primaryAddress(account)",
    "src/components/wallet/PhoenixCustodyPanel.tsx: anchorName",
    "src/components/wallet/PhoenixCustodyPanel.tsx: custodyAddress",
    "src/components/wallet/PhoenixCustodyPanel.tsx: sessionDid",
    "src/components/wallet/ReceivePanel.tsx: address",
    "src/components/wallet/ReceivePanel.tsx: derived.address",
    "src/components/wallet/ReceivePanel.tsx: r.address",
    "src/components/wallet/ReceivePanel.tsx: walletAddress",
    "src/components/wallet/ReviewOutput.tsx: address",
    "src/components/wallet/SendPanel.tsx: txHash",
    "src/components/wallet/UncertainSubmitNotice.tsx: txHash",
    "src/components/wallet/WalletTabs.tsx: uncertainHash",
    "src/components/wallet/WatchOnlyPanel.tsx: a.address",
    "src/components/wallet/WatchOnlyPanel.tsx: wallet.stakeAddress",
    "src/components/wallet/WatchOnlyPanel.tsx: watched",
  ]);

  /**
   * Components that hand one of their own props straight to a copy button. What
   * their callers pass in that prop is a copy-button value too, so it is held to
   * the same list. A new forwarder has to be added here: a copy button handed a
   * bare name that is neither listed here nor in `LOCAL` fails the test below.
   */
  const FORWARDS: Record<string, [component: string, prop: string]> = {
    "src/components/wallet/BalanceView.tsx": ["BalanceView", "address"],
    "src/components/wallet/ReceivePanel.tsx": ["AddressCard", "address"],
    "src/components/wallet/UncertainSubmitNotice.tsx": ["UncertainSubmitNotice", "txHash"],
  };

  /** Bare names handed to a copy button that are this file's own state or derivation. */
  const LOCAL = new Set([
    "src/components/wallet/Cip30Panel.tsx: receiveAddress",
    "src/components/wallet/PhoenixCustodyPanel.tsx: sessionDid",
    "src/components/wallet/PhoenixCustodyPanel.tsx: anchorName",
    "src/components/wallet/PhoenixCustodyPanel.tsx: custodyAddress",
    "src/components/wallet/ReceivePanel.tsx: walletAddress",
    "src/components/wallet/WalletTabs.tsx: uncertainHash",
    "src/components/wallet/ReviewOutput.tsx: address",
    "src/components/wallet/WatchOnlyPanel.tsx: watched",
    "src/components/wallet/SendPanel.tsx: txHash",
    "src/components/night/NightRedeem.tsx: address",
  ]);

  const COPY_BTN_FILE = "src/components/CopyBtn.tsx";

  /** Copy-button components → the prop that ends up on the clipboard, and the file that declares each. */
  const WATCHED = new Map<string, { prop: string; file: string }>([
    ["CopyBtn", { prop: "value", file: COPY_BTN_FILE }],
    ...Object.entries(FORWARDS).map(([file, [c, prop]]) => [c, { prop, file }] as const),
  ]);

  /** An import path that names one of the files above, however it is spelled. */
  const WATCHED_MODULE = new RegExp(
    `(^|/)(${[...WATCHED.values()].map((w) => w.file.replace(/^.*\//, "").replace(/\.tsx$/, "")).join("|")})(\\.[cm]?[jt]sx?)?$`,
  );

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

  it("no copy button anywhere is handed anything but an address, a hash or a name", () => {
    const seen: string[] = [];
    const bare: string[] = [];
    for (const [rel, sf] of shipped()) {
      each(sf, (n) => {
        if (!ts.isJsxOpeningElement(n) && !ts.isJsxSelfClosingElement(n)) return;
        if (!ts.isIdentifier(n.tagName)) return;
        const tag = n.tagName.text;
        const w = WATCHED.get(tag);
        if (!w) return;
        // A forwarder without the prop copies nothing (`BalanceView` shows no
        // address then); a copy button without it is something to look at.
        let value = tag === "CopyBtn" ? `<CopyBtn without value={…}>` : undefined;
        for (const a of n.attributes.properties) {
          // A spread can set the prop, or override it, out of sight of the list.
          if (ts.isJsxSpreadAttribute(a)) seen.push(`${rel}: <${tag} {...${a.expression.getText(sf)}}>`);
          else if (a.name.getText(sf) === w.prop) {
            const e = a.initializer && ts.isJsxExpression(a.initializer) ? a.initializer.expression : undefined;
            value = e ? e.getText(sf) : `<${tag} ${w.prop} not a {…} expression>`;
          }
        }
        if (value === undefined) return;
        seen.push(`${rel}: ${value}`);
        if (/^[A-Za-z_$][\w$]*$/.test(value)) bare.push(`${rel}: ${value}`);
      });
    }
    expect(seen.length).toBeGreaterThan(0);
    const unexpected = seen.filter((s) => !COPYABLE.has(s));
    expect(unexpected).toEqual([]);
    // A bare name is either this file's own value (`LOCAL`) or a prop it was
    // handed — and then its callers have to be read, which only `FORWARDS` does.
    const unaccounted = bare.filter((s) => {
      const [rel, name] = s.split(": ") as [string, string];
      return !LOCAL.has(s) && FORWARDS[rel]?.[1] !== name;
    });
    expect(unaccounted).toEqual([]);
  });

  it("nothing but the copy button reaches the clipboard, or a copy button by another name", () => {
    const offences: string[] = [];
    for (const [rel, sf] of shipped()) {
      if (rel === COPY_BTN_FILE) continue;
      each(sf, (n) => {
        // Every way a page writes the clipboard: the async API under any spelling
        // (`navigator.clipboard`, `navigator["clipboard"]`, a saved reference),
        // the legacy `execCommand("copy")`, and a `copy` event's `clipboardData`.
        if (ts.isIdentifier(n) || ts.isPrivateIdentifier(n) || ts.isStringLiteralLike(n) || ts.isTemplateLiteralToken(n)) {
          if (/clipboard|execCommand/i.test(n.text)) offences.push(`${rel}:${at(sf, n)}: ${n.text}`);
        }
        // An import of a copy-button file is a plain named one; any other way
        // of loading it (default, namespace, re-export, `import()`, `require`)
        // yields the button under a name the value list above never reads.
        if (ts.isStringLiteralLike(n) && WATCHED_MODULE.test(n.text)) {
          const decl = n.parent;
          const plain =
            ts.isImportDeclaration(decl) &&
            decl.moduleSpecifier === n &&
            !decl.importClause?.name &&
            (!decl.importClause?.namedBindings || ts.isNamedImports(decl.importClause.namedBindings));
          if (!plain) offences.push(`${rel}:${at(sf, n)}: loads ${n.text} other than as a named import`);
        }
        // The button reached any way but `<Name …>`, its own declaration and an
        // unaliased import — `as Other`, `createElement(Name, …)`, `[Name].map`,
        // `typeof Name` — is a copy button the value list above never sees.
        if (ts.isIdentifier(n) && WATCHED.has(n.text)) {
          const p = n.parent;
          const ok =
            ((ts.isJsxOpeningElement(p) || ts.isJsxSelfClosingElement(p) || ts.isJsxClosingElement(p)) && p.tagName === n) ||
            (ts.isImportSpecifier(p) && p.name === n && !p.propertyName) ||
            (rel === WATCHED.get(n.text)!.file &&
              (ts.isFunctionDeclaration(p) || ts.isVariableDeclaration(p) || ts.isClassDeclaration(p)) &&
              p.name === n);
          if (!ok) offences.push(`${rel}:${at(sf, n)}: ${n.text} used other than as <${n.text} …>`);
        }
      });
    }
    expect(offences).toEqual([]);
  });
});
