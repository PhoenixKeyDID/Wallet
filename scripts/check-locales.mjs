/**
 * Locale parity guard.
 *
 * Two failures this catches, both of which already shipped once:
 *  1. A namespace whose key set drifts between languages, so some users see raw
 *     key strings instead of text.
 *  2. Host-app string groups copied into the module's locale files. The module
 *     registers into the host's `wallet` namespace; a stale copy of the host's
 *     own keys overrides the host's live strings depending on load order. This
 *     is exactly how `wallet`/`magic`/`dashboard`/`lamp`/`activation`/`common`
 *     — byte-identical to phoenixkey-frontend — ended up in en/vi.
 *
 * Module locales are FLAT: every value is a string. A nested object is the
 * signature of host content that leaked in.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "locales");
const REFERENCE = "en";

const langs = readdirSync(ROOT).sort();
const namespaces = readdirSync(join(ROOT, REFERENCE))
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.replace(/\.json$/, ""));

const errors = [];

function load(lang, ns) {
  try {
    return JSON.parse(readFileSync(join(ROOT, lang, `${ns}.json`), "utf8"));
  } catch {
    return null;
  }
}

for (const ns of namespaces) {
  const reference = load(REFERENCE, ns);
  if (!reference) continue;
  const expected = Object.keys(reference).sort();

  for (const lang of langs) {
    const json = load(lang, ns);
    if (!json) {
      errors.push(`${lang}/${ns}.json is missing`);
      continue;
    }

    for (const [key, value] of Object.entries(json)) {
      if (typeof value !== "string") {
        const kind = Array.isArray(value) ? "an array" : typeof value;
        errors.push(
          `${lang}/${ns}.json: "${key}" is ${kind}, expected a string — ` +
            `nested groups are host content, not module content`,
        );
      }
    }

    const actual = Object.keys(json).sort();
    const missing = expected.filter((k) => !actual.includes(k));
    const extra = actual.filter((k) => !expected.includes(k));
    if (missing.length) errors.push(`${lang}/${ns}.json missing: ${missing.join(", ")}`);
    if (extra.length) errors.push(`${lang}/${ns}.json not in ${REFERENCE}: ${extra.join(", ")}`);
  }
}

if (errors.length) {
  console.error("Locale parity check FAILED:\n");
  for (const e of errors) console.error(`  • ${e}`);
  process.exit(1);
}

console.log(
  `Locale parity OK — ${langs.length} languages × ${namespaces.length} namespaces (${langs.join(", ")}).`,
);
