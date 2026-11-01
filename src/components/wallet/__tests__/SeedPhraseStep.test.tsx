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
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import i18next from "i18next";
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
   */
  const COPYABLE = new Set([
    "address",
    "a.address",
    "r.address",
    "primaryAddress(account)",
    "wallet.stakeAddress",
    "watched",
    "txHash",
    "u.txHash",
    "e.txHash",
    "sessionDid",
    "anchorName",
    // handed to a component in `FORWARDS`
    "receiveAddress",
    "custodyAddress",
    "walletAddress",
    "derived.address",
    "uncertainHash",
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
    "src/components/wallet/PhoenixCustodyPanel.tsx: sessionDid",
    "src/components/wallet/PhoenixCustodyPanel.tsx: anchorName",
    "src/components/wallet/ReviewOutput.tsx: address",
    "src/components/wallet/WatchOnlyPanel.tsx: watched",
    "src/components/wallet/SendPanel.tsx: txHash",
    "src/components/night/NightRedeem.tsx: address",
  ]);

  /** Shipped source, comments removed, keyed by repo-relative path. */
  const shipped = () => {
    const out = new Map<string, string>();
    const walk = (dir: string) => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, ent.name);
        if (ent.isDirectory()) {
          if (ent.name !== "__tests__" && ent.name !== "node_modules") walk(p);
        } else if (/\.[cm]?[jt]sx?$/.test(ent.name) && !/\.d\.ts$/.test(ent.name)) {
          const code = readFileSync(p, "utf8")
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
          out.set(relative(REPO, p), code);
        }
      }
    };
    walk(join(REPO, "src"));
    walk(join(REPO, "extension/src"));
    return out;
  };

  it("no copy button anywhere is handed anything but an address, a hash or a name", () => {
    const files = shipped();
    const seen: string[] = [];
    const bare: string[] = [];
    for (const [rel, code] of files) {
      for (const m of code.matchAll(/<CopyBtn\b([^>]*)>/g)) {
        const v = /\bvalue=\{([^}]*)\}/.exec(m[1]!);
        const value = v ? v[1]!.trim() : "<no value={…}>";
        seen.push(`${rel}: ${value}`);
        if (/^[A-Za-z_$][\w$]*$/.test(value)) bare.push(`${rel}: ${value}`);
      }
    }
    for (const [component, prop] of Object.values(FORWARDS)) {
      const tag = new RegExp(`<${component}\\b([^>]*)>`, "g");
      for (const [rel, code] of files) {
        for (const m of code.matchAll(tag)) {
          const v = new RegExp(`\\b${prop}=\\{([^}]*)\\}`).exec(m[1]!);
          if (v) seen.push(`${rel}: ${v[1]!.trim()}`);
          else if (new RegExp(`\\b${prop}=`).test(m[1]!) || /\{\s*\.\.\./.test(m[1]!)) {
            seen.push(`${rel}: <${component} ${prop} not a {…} expression>`);
          }
        }
      }
    }
    expect(seen.length).toBeGreaterThan(0);
    const unexpected = seen.filter((s) => !COPYABLE.has(s.slice(s.indexOf(": ") + 2)));
    expect(unexpected).toEqual([]);
    // A bare name is either this file's own value (`LOCAL`) or a prop it was
    // handed — and then its callers have to be read, which only `FORWARDS` does.
    const unaccounted = bare.filter((s) => {
      const [rel, name] = s.split(": ") as [string, string];
      return !LOCAL.has(s) && FORWARDS[rel]?.[1] !== name;
    });
    expect(unaccounted).toEqual([]);
  });

  it("nothing but the copy button reaches the clipboard, or the copy button by another name", () => {
    const offences: string[] = [];
    for (const [rel, code] of shipped()) {
      if (rel === join("src", "components", "CopyBtn.tsx")) continue;
      // Every way a page writes the clipboard: the async API under any spelling
      // (`navigator.clipboard`, `navigator["clipboard"]`, a saved reference),
      // the legacy `execCommand("copy")`, and a `copy` event's `clipboardData`.
      for (const re of [/clipboard/i, /execCommand/]) {
        if (re.test(code)) offences.push(`${rel}: ${re}`);
      }
      // The button reached any way but `<CopyBtn …>` and its one import — an
      // alias, `createElement(CopyBtn, …)`, handed on as a value — is a copy
      // button the value list above never sees.
      // The import names the button twice (binding and path), so it is taken out
      // before counting rather than counted.
      const body = code.replace(/import\s*\{\s*CopyBtn\s*\}\s*from\s*["']@\/components\/CopyBtn["'];?/g, "");
      const uses = body.match(/\bCopyBtn\b/g)?.length ?? 0;
      const jsx = body.match(/<CopyBtn\b/g)?.length ?? 0;
      if (uses !== jsx) offences.push(`${rel}: CopyBtn used other than as <CopyBtn …> (${uses} uses, ${jsx} tags)`);
    }
    expect(offences).toEqual([]);
  });
});
