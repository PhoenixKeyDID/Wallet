/**
 * The build decides what the shipped extension may reach. Nothing checked it.
 *
 * After the build began generating `manifest.json`, `extension/vite.config.ts`
 * became the file that produces both the permissions Chrome enforces and the
 * receipt `check:package` trusts. It had zero coverage: deleting the `VITE_`
 * prefix filter and the entire CSP-widening block left the suite at 521 green,
 * `tsc` silent, and `check:package` printing OK — because the receipt and the
 * manifest widen from the same call, so both directions still agreed with each
 * other while agreeing about the wrong thing.
 *
 * These cases are about the decision only. Whether the file lands on disk is
 * `check:package`'s question, and it answers it on a real build.
 */
import { describe, it, expect } from "vitest";
import { manifestForBuild, extraChainOrigins } from "./vite.config";

/** The shipped manifest's shape, trimmed to the two fields under test. */
const BASE = () => ({
  host_permissions: ["https://api.koios.rest/*", "https://preprod.koios.rest/*"],
  content_security_policy: {
    extension_pages: "script-src 'self'; connect-src 'self' https://api.koios.rest; object-src 'none'",
  },
});

const hosts = (m: Record<string, unknown>) => m.host_permissions as string[];
const csp = (m: Record<string, unknown>) =>
  (m.content_security_policy as { extension_pages: string }).extension_pages;

describe("manifestForBuild > a plain build grants nothing", () => {
  it("returns the manifest untouched and an empty receipt", () => {
    const { manifest, granted } = manifestForBuild(BASE(), {});
    expect(granted).toEqual([]);
    expect(hosts(manifest)).toEqual(BASE().host_permissions);
  });

  it("ignores variables that are not chain endpoints", () => {
    const { granted } = manifestForBuild(BASE(), { VITE_SOMETHING_ELSE: "https://x.example" });
    expect(granted).toEqual([]);
  });
});

describe("manifestForBuild > only VITE_ reaches an extension bundle", () => {
  it("grants the origin a VITE_ variable names", () => {
    const { manifest, granted } = manifestForBuild(BASE(), {
      VITE_CHAIN_BASE_MAINNET: "https://chain.example/api/v0",
    });
    expect(granted).toEqual(["https://chain.example"]);
    expect(hosts(manifest)).toContain("https://chain.example/*");
  });

  it("ignores NEXT_PUBLIC_, which no extension bundle can read", () => {
    // The scenario this filter exists for: the web app's dev loop leaves a
    // variable in the shell, and without the filter a shipped extension gains
    // permission over a host its own code never calls. Nothing downstream
    // catches it — the receipt would widen too, so `check:package` sees two
    // lists agreeing.
    const { manifest, granted } = manifestForBuild(BASE(), {
      NEXT_PUBLIC_CHAIN_BASE_MAINNET: "https://web-only.example/api/v0",
    });
    expect(granted).toEqual([]);
    expect(hosts(manifest)).toEqual(BASE().host_permissions);
    expect(csp(manifest)).not.toContain("web-only.example");
  });

  it("takes the VITE_ one when both prefixes are present", () => {
    const { granted } = manifestForBuild(BASE(), {
      VITE_CHAIN_BASE_MAINNET: "https://chain.example/api/v0",
      NEXT_PUBLIC_CHAIN_BASE_MAINNET: "https://web-only.example/api/v0",
    });
    expect(granted).toEqual(["https://chain.example"]);
  });
});

describe("manifestForBuild > both lists move together", () => {
  it("widens connect-src alongside host_permissions", () => {
    // Widening one alone gets past Chrome's permission check and is then
    // blocked by the page's own CSP. The request fails with no status, and the
    // wallet reports the endpoint as unreachable — the same wrong sentence a
    // blocked host produces, from a different layer, so the symptom cannot tell
    // an operator which half is missing.
    const { manifest } = manifestForBuild(BASE(), {
      VITE_CHAIN_BASE_MAINNET: "https://chain.example/api/v0",
    });
    expect(csp(manifest)).toContain("https://chain.example");
    expect(csp(manifest)).toMatch(/connect-src[^;]*chain\.example/);
  });

  it("widens a connect-src written with any whitespace, as the gate reads it", () => {
    // The writer here and the reader in `check-extension-package.mjs` parse the
    // same field, and they had different spellings of it — one literal space
    // against `\s+`. A CSP written with a tab would have widened
    // `host_permissions` and not the CSP, silently, and only a cross-check one
    // layer down would have caught it. Two expressions for one field is the
    // shape behind every contradiction this build step has produced.
    const m = BASE();
    m.content_security_policy.extension_pages =
      "script-src 'self'; connect-src\t'self' https://api.koios.rest; object-src 'none'";
    const { manifest } = manifestForBuild(m, {
      VITE_CHAIN_BASE_MAINNET: "https://chain.example/api/v0",
    });
    expect(csp(manifest)).toContain("https://chain.example");
  });

  it("leaves script-src alone while doing it", () => {
    // `connect-src` is where a chain host belongs. Landing in `script-src`
    // would let that host serve code into the extension's own pages.
    const { manifest } = manifestForBuild(BASE(), {
      VITE_CHAIN_BASE_MAINNET: "https://chain.example/api/v0",
    });
    expect(csp(manifest)).toMatch(/script-src 'self';/);
    expect(csp(manifest)).not.toMatch(/script-src[^;]*chain\.example/);
  });
});

describe("manifestForBuild > an origin already declared is not declared twice", () => {
  it("grants nothing when the build points at a host the manifest already has", () => {
    const { manifest, granted } = manifestForBuild(BASE(), {
      VITE_CHAIN_BASE_MAINNET: "https://api.koios.rest/api/v1",
    });
    expect(granted).toEqual([]);
    expect(hosts(manifest)).toEqual(BASE().host_permissions);
  });

  it("does grant a host that merely shares a prefix with a declared one", () => {
    // The reason the comparison is against the parsed list rather than the
    // file's text: `https://api.koios.rest` is a substring of nothing here, but
    // a naive substring test would read a shorter host as already covered by a
    // longer one and silently fail to grant it — after which the build calls a
    // host Chrome blocks, and the wallet says the endpoint is unreachable.
    const m = BASE();
    m.host_permissions = ["https://chain.example.org/*"];
    const { granted } = manifestForBuild(m, {
      VITE_CHAIN_BASE_MAINNET: "https://chain.example/api/v0",
    });
    expect(granted).toEqual(["https://chain.example"]);
  });
});

describe("extraChainOrigins > a port cannot be expressed in a match pattern", () => {
  it("refuses a chain endpoint carrying a port, and says why", () => {
    // Measured: a build pointed at `https://my-node.example:8443` wrote a
    // manifest declaring that pattern, and the packaging gate then printed two
    // contradictory sentences about it. The manifest was the wrong artifact to
    // argue about — Chrome matches the host part whole, so the pattern matches
    // nothing and the extension reaches that endpoint never. Refused where it
    // is written rather than where it is later noticed.
    expect(() =>
      extraChainOrigins({ VITE_CHAIN_BASE_MAINNET: "https://my-node.example:8443/api/v0" }),
    ).toThrow(/no place for one/);
  });

  it("says what to do instead", () => {
    let message = "";
    try {
      extraChainOrigins({ VITE_CHAIN_BASE_MAINNET: "https://my-node.example:8443/api/v0" });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("my-node.example:8443");
    expect(message).toMatch(/443|web app/);
  });

  it("accepts the same host on the default port", () => {
    // The direction that keeps the rule from being a nuisance: a self-hosted
    // endpoint is the documented reason this variable exists.
    expect(extraChainOrigins({ VITE_CHAIN_BASE_MAINNET: "https://my-node.example/api/v0" })).toEqual(
      ["https://my-node.example"],
    );
  });
});

describe("extraChainOrigins > a standing grant cannot be plain HTTP", () => {
  it("refuses a loopback endpoint over HTTP, which is otherwise a supported source", () => {
    // `chainSource.ts` allows plain HTTP on loopback deliberately, so this
    // arrives from a documented setup rather than a mistake — and the port
    // guard beside it let it through, writing `http://localhost` into both
    // `host_permissions` and the CSP. Unlike a port, that manifest loads and
    // works: the grant is real, and it survives whatever the chain source is
    // set to afterwards.
    expect(() =>
      extraChainOrigins({ VITE_CHAIN_BASE_MAINNET: "http://localhost/api/v0" }),
    ).toThrow(/not https/);
  });

  it("refuses a scheme that is not a web scheme at all", () => {
    // `new URL("foo://bar/x").origin` is the string "null", so without this the
    // manifest would have been handed the pattern `null/*`.
    expect(() => extraChainOrigins({ VITE_CHAIN_BASE_MAINNET: "foo://bar/api/v0" })).toThrow(
      /not https/,
    );
  });

  it("points at the web build, where loopback HTTP is allowed", () => {
    // The refusal has to say where the supported configuration went, or it
    // reads as the feature being withdrawn.
    let message = "";
    try {
      extraChainOrigins({ VITE_CHAIN_BASE_MAINNET: "http://localhost/api/v0" });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/web app/);
  });
});

describe("extraChainOrigins > a project id alone still names a host", () => {
  it("resolves the vendor origin with no URL in the variable", () => {
    // The case a text search of the bundle cannot see, and the reason the gate
    // reads a receipt instead: nothing resembling a URL is compiled in, while
    // the package really does call that host.
    const origins = extraChainOrigins({ VITE_BLOCKFROST_PROJECT_ID_PREPROD: "preprodDEADBEEF" });
    expect(origins).toHaveLength(1);
    expect(origins[0]).toMatch(/^https:\/\//);
    expect(new URL(origins[0]).host).toContain("blockfrost");
  });

  it("keeps one network's variable out of another network's origin", () => {
    const preprod = extraChainOrigins({ VITE_BLOCKFROST_PROJECT_ID_PREPROD: "preprodDEADBEEF" });
    const mainnet = extraChainOrigins({ VITE_BLOCKFROST_PROJECT_ID_MAINNET: "mainnetDEADBEEF" });
    expect(preprod).not.toEqual(mainnet);
  });
});
