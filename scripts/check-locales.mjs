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
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "locales");
const REFERENCE = "en";

const langs = readdirSync(ROOT).sort();
const namespaces = readdirSync(join(ROOT, REFERENCE))
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.replace(/\.json$/, ""));

const errors = [];

/**
 * `null` only when the file is absent. A file that is there but does not parse
 * is a failure of its own: reading it as "missing" — or skipping the whole
 * namespace when it is the reference — turned a broken file into a green run.
 */
function load(lang, ns) {
  const path = join(ROOT, lang, `${ns}.json`);
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  try {
    return { json: JSON.parse(text), text };
  } catch (e) {
    errors.push(`${lang}/${ns}.json does not parse: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

/**
 * Every key of the top-level object, in order, duplicates included.
 *
 * Walks the text token by token instead of matching lines, so a duplicate on
 * the same line as another key, or indented differently, is still seen.
 */
function topLevelKeys(text) {
  const keys = [];
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      if (depth === 1) {
        let k = j + 1;
        while (/\s/.test(text[k] ?? "")) k++;
        if (text[k] === ":") keys.push(JSON.parse(text.slice(i, j + 1)));
      }
      i = j;
    } else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
  }
  return keys;
}

for (const ns of namespaces) {
  const reference = load(REFERENCE, ns);
  if (!reference) continue;
  const expected = Object.keys(reference.json).sort();

  for (const lang of langs) {
    const loaded = load(lang, ns);
    if (loaded === null) errors.push(`${lang}/${ns}.json is missing`);
    if (!loaded) continue;
    const { json, text } = loaded;

    for (const [key, value] of Object.entries(json)) {
      if (typeof value !== "string") {
        const kind = Array.isArray(value) ? "an array" : typeof value;
        errors.push(
          `${lang}/${ns}.json: "${key}" is ${kind}, expected a string — ` +
            `nested groups are host content, not module content`,
        );
      }
    }

    // `JSON.parse` keeps the LAST of two equal keys and says nothing, so a stale
    // translation and the fix for it can sit in one file with the stale one
    // silently winning or losing by position. Only the raw text can see it.
    const seen = new Map();
    for (const k of topLevelKeys(text)) seen.set(k, (seen.get(k) ?? 0) + 1);
    const dups = [...seen].filter(([, n]) => n > 1).map(([k]) => k);
    if (dups.length) errors.push(`${lang}/${ns}.json has duplicate keys (the later one silently wins): ${dups.join(", ")}`);

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
