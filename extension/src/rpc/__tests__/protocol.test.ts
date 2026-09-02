/**
 * The rules that decide whether a website gets an answer.
 *
 * These are the tests standing in for a browser. The content script, the
 * service worker and the approval window cannot be exercised in a unit test, so
 * every decision they make was pulled into `protocol.ts` and is checked here.
 * A rule that lives only inside an untestable file is a rule nobody can show
 * still holds.
 */
import { describe, it, expect } from "vitest";
import {
  CHANNEL,
  parseRequest,
  requirementOf,
  originOf,
  displayOrigin,
  isKnownMethod,
  GRANTED_METHODS,
  PER_USE_METHODS,
  API_ERROR,
} from "../protocol";

const req = (over: Record<string, unknown> = {}) => ({
  channel: CHANNEL,
  kind: "req",
  id: "abc",
  method: "getUtxos",
  params: [],
  ...over,
});

describe("parseRequest — recognise without trusting", () => {
  it("accepts a well-formed request", () => {
    expect(parseRequest(req())).toEqual({
      channel: CHANNEL,
      kind: "req",
      id: "abc",
      method: "getUtxos",
      params: [],
    });
  });

  it("ignores traffic that is not ours", () => {
    for (const junk of [
      null,
      undefined,
      "hello",
      42,
      {},
      { channel: "other", kind: "req", id: "a", method: "x", params: [] },
      { channel: CHANNEL, kind: "res", id: "a", method: "x", params: [] },
    ]) {
      expect(parseRequest(junk)).toBeNull();
    }
  });

  it("refuses params that are not an array", () => {
    // `params` reaches `signTx(params[0])`. A page sending an object with a
    // `0` key would otherwise flow straight through as if it were an array.
    expect(parseRequest(req({ params: { 0: "deadbeef" } }))).toBeNull();
    expect(parseRequest(req({ params: "deadbeef" }))).toBeNull();
    expect(parseRequest(req({ params: undefined }))).toBeNull();
  });

  it("refuses an empty or oversized id", () => {
    expect(parseRequest(req({ id: "" }))).toBeNull();
    expect(parseRequest(req({ id: "x".repeat(129) }))).toBeNull();
    expect(parseRequest(req({ id: 7 }))).toBeNull();
  });

  it("refuses an oversized method name", () => {
    expect(parseRequest(req({ method: "x".repeat(65) }))).toBeNull();
  });

  /**
   * The request type has no origin field, so a page cannot supply one — and a
   * page that adds one anyway must not have it survive into the parsed object,
   * where a later edit might start reading it.
   */
  it("drops any origin a page tries to smuggle in", () => {
    const parsed = parseRequest(req({ origin: "https://evil.example" }));
    expect(parsed).not.toBeNull();
    expect(Object.prototype.hasOwnProperty.call(parsed!, "origin")).toBe(false);
  });
});

describe("requirementOf — deny by default", () => {
  it("refuses a method it has never heard of", () => {
    for (const m of ["", "eval", "getSecretKey", "signTX", "SIGNTX", "__proto__", "toString"]) {
      expect(requirementOf(m)).toBe("refused");
      expect(isKnownMethod(m)).toBe(false);
    }
  });

  it("puts every read behind a grant", () => {
    for (const m of GRANTED_METHODS) expect(requirementOf(m)).toBe("grant");
  });

  it("puts everything that signs or broadcasts behind a fresh approval", () => {
    for (const m of PER_USE_METHODS) expect(requirementOf(m)).toBe("approval");
    // Named explicitly so a future edit that moves one of these to `grant`
    // fails here rather than silently letting one "yes" spend forever.
    expect(requirementOf("signTx")).toBe("approval");
    expect(requirementOf("signData")).toBe("approval");
    expect(requirementOf("submitTx")).toBe("approval");
  });

  it("lets only isEnabled through with no permission at all", () => {
    expect(requirementOf("isEnabled")).toBe("open");
    expect(requirementOf("enable")).toBe("enable");
    // Nothing else may be open. A read that slipped into this tier would answer
    // a site that has never been connected.
    const open = [...GRANTED_METHODS, ...PER_USE_METHODS].filter(
      (m) => requirementOf(m) === "open",
    );
    expect(open).toEqual([]);
  });

  it("does not answer for a method inherited from Object.prototype", () => {
    // `new Set()` is used for the lookup, not a plain object, so this cannot
    // regress into `{}.hasOwnProperty` — but it is the classic way this kind
    // of allow-list turns into an allow-everything.
    expect(requirementOf("constructor")).toBe("refused");
    expect(requirementOf("hasOwnProperty")).toBe("refused");
  });
});

describe("originOf — the browser decides, not the page", () => {
  it("accepts a top-frame https origin", () => {
    expect(originOf({ origin: "https://dex.example", frameId: 0 })).toEqual({
      origin: "https://dex.example",
    });
  });

  it("refuses every sub-frame", () => {
    // An iframe on evil.example inside dex.example sends its own honest origin,
    // but the user reading the dialog is looking at the address bar.
    const r = originOf({ origin: "https://evil.example", frameId: 1 });
    expect(r).toHaveProperty("error");
    expect((r as { error: { code: number } }).error.code).toBe(API_ERROR.Refused);
  });

  it("refuses an opaque origin", () => {
    // What a sandboxed frame or a data: URL reports. There is nothing here to
    // show a person as "the site asking".
    expect(originOf({ origin: "null", frameId: 0 })).toHaveProperty("error");
    expect(originOf({ origin: "", frameId: 0 })).toHaveProperty("error");
    expect(originOf({ frameId: 0 })).toHaveProperty("error");
  });

  it("refuses plain http on the open network", () => {
    // A plaintext origin can be rewritten in flight, so a grant to it is a
    // grant to anyone on the path.
    expect(originOf({ origin: "http://dex.example", frameId: 0 })).toHaveProperty("error");
  });

  it("allows http on loopback, for someone building against this wallet", () => {
    for (const o of ["http://localhost:3000", "http://127.0.0.1:8080"]) {
      expect(originOf({ origin: o, frameId: 0 })).toEqual({ origin: o });
    }
  });

  it("refuses other schemes outright", () => {
    for (const o of ["file:///tmp/x.html", "ftp://dex.example", "javascript:alert(1)"]) {
      expect(originOf({ origin: o, frameId: 0 })).toHaveProperty("error");
    }
  });

  it("refuses a string that is not a URL", () => {
    expect(originOf({ origin: "not a url", frameId: 0 })).toHaveProperty("error");
  });

  it("normalises to a bare origin, dropping any path or query", () => {
    const r = originOf({ origin: "https://dex.example/some/path?a=b", frameId: 0 });
    expect(r).toEqual({ origin: "https://dex.example" });
  });

  it("keeps a non-default port, because it is part of the origin", () => {
    expect(originOf({ origin: "https://dex.example:8443", frameId: 0 })).toEqual({
      origin: "https://dex.example:8443",
    });
  });
});

describe("displayOrigin — what the person reads", () => {
  it("shows the host", () => {
    expect(displayOrigin("https://dex.example")).toBe("dex.example");
  });

  it("keeps the port", () => {
    expect(displayOrigin("https://dex.example:8443")).toBe("dex.example:8443");
  });

  /**
   * A look-alike puts its difference at the end: `pay.bank.example` versus
   * `pay.bank.example.evil.tld`. Anything that shortens from the right hides
   * exactly the part that distinguishes them.
   */
  it("does not shorten a long host", () => {
    const long = "https://pay.bank.example.attacker-controlled-domain.tld";
    const shown = displayOrigin(long);
    expect(shown).toBe("pay.bank.example.attacker-controlled-domain.tld");
    expect(shown).not.toContain("…");
    expect(shown).not.toContain("...");
  });

  it("distinguishes a real host from its look-alike", () => {
    expect(displayOrigin("https://pay.bank.example")).not.toBe(
      displayOrigin("https://pay.bank.example.evil.tld"),
    );
  });
});
