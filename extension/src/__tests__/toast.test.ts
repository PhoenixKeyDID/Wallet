/**
 * The extension shows sentences, not keys.
 *
 * Nothing checked this, and the shape of the failure is why: the module ships a
 * stand-in `@/lib/toast` so it type-checks standing alone, and a host is expected
 * to alias that name at its own implementation. The web app aliases all five
 * names in the host contract; the extension aliased none, so every one resolved
 * back into the stand-in. Resolving into a stand-in is not an error — the import
 * succeeds, the build succeeds, the suite stays green — and the person using the
 * packaged wallet reads `delegate_submitted` after delegating their stake.
 *
 * These cases assert the two properties that failure violated: the key becomes a
 * sentence, and the values travel with it. Both are asserted on the rendered
 * text rather than on a mock, because the defect was never in the call — it was
 * in which module the call reached.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { i18n } from "../i18n";
import { toastSuccess, toastInfo, toastError, toastApiError } from "../toast";

/**
 * A DOM small enough to fit the two things this module does to one.
 *
 * The suite runs under `environment: "node"` (`vitest.config.ts:22`) and this
 * repo installs no DOM implementation. Rather than add one — a dependency
 * bought for four assertions — the test supplies exactly the surface
 * `toast.ts` touches. That is not a shortcut: what these cases are about is
 * whether the key became a sentence and whether the values travelled, and both
 * are properties of the string handed to `textContent`.
 */
type FakeEl = {
  className: string;
  textContent: string;
  attrs: Record<string, string>;
  setAttribute(k: string, v: string): void;
  remove(): void;
};

let painted: FakeEl[] = [];

function installFakeDom(): void {
  painted = [];
  const body = {
    appendChild(el: FakeEl) {
      painted.push(el);
      return el;
    },
  };
  (globalThis as { document?: unknown }).document = {
    body,
    createElement(): FakeEl {
      const el: FakeEl = {
        className: "",
        textContent: "",
        attrs: {},
        setAttribute(k, v) {
          el.attrs[k] = v;
        },
        remove() {
          painted = painted.filter((p) => p !== el);
        },
      };
      return el;
    },
  };
}

/** The text of every banner currently on screen. */
const banners = () => painted.map((el) => el.textContent);
/** The `role` of the most recent banner — what a screen reader announces. */
const lastRole = () => painted[painted.length - 1]?.attrs.role;

beforeEach(async () => {
  installFakeDom();
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  await i18n.changeLanguage("en");
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as { document?: unknown }).document;
});

describe("extension toast > a key becomes a sentence", () => {
  it("does not print the key it was given", () => {
    // The whole defect in one assertion. `send_submitted` exists in every
    // language, so a host that resolves keys must show text — and a host that
    // does not shows the key, which is what shipped.
    toastSuccess("send_submitted", { hash: "abc123" });
    const [text] = banners();
    expect(text).not.toBe("send_submitted");
    expect(text).not.toContain("send_submitted");
  });

  it("carries the values through", () => {
    // Separate from the case above because the stand-in failed both ways and
    // fixing one does not fix the other: its signature named the parameter
    // `_values` and dropped it. A transaction hash is the only thing that lets
    // somebody check an uncertain submission in an explorer, so losing it turns
    // a recoverable moment into a guess.
    toastSuccess("send_submitted", { hash: "abc123" });
    expect(banners()[0]).toContain("abc123");
  });

  it("shows the same sentence in the language the person reads", async () => {
    // The extension picks a language from the browser and has no switcher, so
    // this is the only place a non-English reader is served at all.
    await i18n.changeLanguage("vi");
    toastSuccess("send_submitted", { hash: "abc123" });
    const vi = banners()[0];

    painted = [];
    await i18n.changeLanguage("en");
    toastSuccess("send_submitted", { hash: "abc123" });
    const en = banners()[0];

    expect(vi).not.toBe(en);
    expect(vi).toContain("abc123");
  });

  it("passes an unknown key through instead of blanking it", () => {
    // A key with no string is a bug, and `check:i18n-keys` fails the build for
    // it. What must not happen meanwhile is an empty banner: a failure the user
    // cannot see is worse than one they can read and report.
    toastInfo("no_such_key_anywhere");
    expect(banners()[0]).toBe("no_such_key_anywhere");
  });
});

describe("extension toast > the shape a person is looking at", () => {
  it("marks an error as an alert and everything else as a status", () => {
    // Screen readers announce `alert` immediately and `status` politely. A
    // wallet that announces a success the same way it announces "your money did
    // not move" has said nothing to the person who most needs the difference.
    toastError("plain sentence");
    expect(lastRole()).toBe("alert");

    painted = [];
    toastSuccess("send_submitted", { hash: "x" });
    expect(lastRole()).toBe("status");
  });

  it("shows an already-translated sentence unchanged", () => {
    // `toastError` exists separately because its caller has already resolved the
    // text. Running it through the translator would look up a whole sentence as
    // a key — harmless today, and the reason the two functions stay apart.
    toastError("Ví đã ký, nhưng chưa có xác nhận.");
    expect(banners()[0]).toBe("Ví đã ký, nhưng chưa có xác nhận.");
  });

  it("keeps an error on screen longer than a receipt", () => {
    // A success is glanced at; an error has to be read and acted on, and the
    // popup can close under somebody who is still reading it.
    vi.useFakeTimers();
    try {
      toastSuccess("send_submitted", { hash: "x" });
      toastError("something to read");
      expect(banners()).toHaveLength(2);
      vi.advanceTimersByTime(7_000);
      expect(banners()).toHaveLength(1);
      vi.advanceTimersByTime(6_000);
      expect(banners()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("extension toast > a cancelled signature is not a failure", () => {
  it("reads a CIP-30 user-declined rejection as information", () => {
    // The single highest-frequency branch of the signing flow: somebody pressed
    // Cancel. `TxSignError.UserDeclined = 2`, and it arrives as a plain object
    // rather than an `Error`, so a handler that only understands `Error` reports
    // a scary generic failure for the one outcome that is entirely normal.
    toastApiError({ code: 2, info: "user declined" });
    const [text] = banners();
    expect(lastRole()).toBe("status");
    expect(text).not.toBe("tx_cancelled_nothing_sent");
  });

  it("falls back to a sentence, not to errors.generic the string", () => {
    // `src/lib/api.ts` builds `errors.<code>`, and those strings belong to the
    // host. This host supplies them in `hostStrings.ts`; before it did, an
    // unrecognised failure printed the literal `errors.generic`.
    toastApiError({ something: "unrecognised" });
    const [text] = banners();
    expect(text).not.toBe("errors.generic");
    expect(text.length).toBeGreaterThan(20);
  });
});
