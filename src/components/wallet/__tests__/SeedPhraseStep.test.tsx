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
  ]);

  it("no copy button anywhere is handed anything but an address, a hash or a name", () => {
    const seen: string[] = [];
    const walk = (dir: string) => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, ent.name);
        if (ent.isDirectory()) {
          if (ent.name !== "__tests__" && ent.name !== "node_modules") walk(p);
        } else if (/\.tsx?$/.test(ent.name)) {
          const src = readFileSync(p, "utf8");
          for (const m of src.matchAll(/<CopyBtn\b([^>]*)>/g)) {
            const v = /\bvalue=\{([^}]*)\}/.exec(m[1]!);
            seen.push(`${relative(REPO, p)}: ${v ? v[1]!.trim() : "<no value={…}>"}`);
          }
          // The one place allowed to write the clipboard is the button itself.
          if (!p.endsWith(join("components", "CopyBtn.tsx"))) {
            expect(src, p).not.toMatch(/clipboard\s*\.\s*write/);
          }
        }
      }
    };
    walk(join(REPO, "src"));
    walk(join(REPO, "extension/src"));
    expect(seen.length).toBeGreaterThan(0);
    const unexpected = seen.filter((s) => !COPYABLE.has(s.slice(s.indexOf(": ") + 2)));
    expect(unexpected).toEqual([]);
  });
});
