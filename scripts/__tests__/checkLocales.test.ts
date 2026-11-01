import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "check-locales.mjs");

/** Runs the guard on a locale tree built from `files` (`"vi/wallet.json": text`). */
function check(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "locales-"));
  try {
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(join(root, dirname(rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    const r = spawnSync(process.execPath, [SCRIPT, root], { encoding: "utf8" });
    return { status: r.status, out: r.stdout + r.stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const EN = '{\n  "a": "A",\n  "b": "B"\n}\n';

describe("check:locales", () => {
  it("passes a tree whose languages carry the same keys", () => {
    const r = check({ "en/wallet.json": EN, "vi/wallet.json": '{ "a": "Á", "b": "Bê" }' });
    expect(r.out).toContain("Locale parity OK");
    expect(r.status).toBe(0);
  });

  it("fails a translation that does not parse, instead of calling it missing", () => {
    const r = check({ "en/wallet.json": EN, "vi/wallet.json": '{ "a": "Á", ' });
    expect(r.out).toContain("vi/wallet.json does not parse");
    expect(r.status).toBe(1);
  });

  it("fails a reference file that does not parse, instead of skipping its namespace", () => {
    const r = check({ "en/wallet.json": '{ "a": ', "vi/wallet.json": '{ "a": "Á" }' });
    expect(r.out).toContain("en/wallet.json does not parse");
    expect(r.status).toBe(1);
  });

  it("fails a file that parses to something other than an object, with a sentence", () => {
    const r = check({ "en/wallet.json": EN, "vi/wallet.json": "null" });
    expect(r.out).toContain("vi/wallet.json is not a JSON object");
    expect(r.status).toBe(1);
  });

  it("sees a duplicate key on the same line as another, past an escaped quote", () => {
    const r = check({
      "en/wallet.json": EN,
      "vi/wallet.json": '{ "a": "say \\"{ [\\"", "b": "B", "a": "later" }',
    });
    expect(r.out).toContain("has duplicate keys (the later one silently wins): a");
    expect(r.status).toBe(1);
  });

  it("fails a missing translation file", () => {
    const r = check({ "en/wallet.json": EN, "vi/other.json": "{}" });
    expect(r.out).toContain("vi/wallet.json is missing");
    expect(r.status).toBe(1);
  });
});
