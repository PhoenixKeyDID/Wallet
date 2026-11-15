/**
 * Every refusal the signer can raise has a sentence in every language.
 *
 * The approval window shows a `LocalSignError` as `t(err.key)`, and an unknown
 * key resolves to itself — so a missing string reaches the person as the bare
 * code `sign_foreign_mint` at the moment they need to know why a site's request
 * was refused. `check:i18n-keys` does not see these: they are thrown, not
 * passed to `t("…")` as a literal. This reads the throw sites instead.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..", "..", "..");
const SOURCES = ["src/lib/keystore/signForeign.ts", "src/lib/keystore/signer.ts"];
const LANGS = ["en", "vi", "ja", "zh"];

const thrown = [
  ...new Set(
    SOURCES.flatMap((rel) =>
      [...readFileSync(join(ROOT, rel), "utf8").matchAll(/new LocalSignError\(\s*"([a-z_]+)"/g)].map((m) => m[1]!),
    ),
  ),
].sort();

describe("signer refusals are translated", () => {
  it("finds the throw sites it is meant to check", () => {
    // A rename of the class or a move of the files would otherwise leave this
    // test checking an empty list, and passing.
    expect(thrown).toContain("sign_foreign_declared_invalid");
    expect(thrown.length).toBeGreaterThanOrEqual(10);
  });

  for (const lang of LANGS) {
    it(`${lang}: every key has a non-empty string`, () => {
      const dict = JSON.parse(readFileSync(join(ROOT, "locales", lang, "wallet.json"), "utf8")) as Record<string, unknown>;
      const missing = thrown.filter((k) => typeof dict[k] !== "string" || (dict[k] as string).trim() === "");
      expect(missing).toEqual([]);
    });
  }
});
