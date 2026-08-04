import { describe, it, expect, afterEach, vi } from "vitest";
import { apiFetch, ApiError } from "../api";

/**
 * The stub client must speak the same contract as the host client it stands in
 * for (Wallet#4).
 *
 * The backend wraps every payload in `DataResponse { code, message, result }`
 * and signals success with `code === 1000`. This stub used to `return
 * res.json()` raw, which only looked correct because integration swaps in the
 * host client — standalone it handed the envelope to code expecting `result`,
 * and a non-1000 error code riding on HTTP 200 read as success. That gap is
 * exactly what the host-contract layer was hiding, so it is pinned here.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubJson(body: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(body, { status })),
  );
}

describe("apiFetch — DataResponse envelope", () => {
  it("returns `result`, not the envelope", async () => {
    stubJson({ code: 1000, message: "ok", result: { wallets: [], magic: null } });
    await expect(apiFetch("/wallet/x/all")).resolves.toEqual({ wallets: [], magic: null });
  });

  it("throws on a non-1000 code even though HTTP said 200", async () => {
    // The dangerous shape: transport succeeded, the operation did not.
    stubJson({ code: 2002, message: "user_did_not_found" });
    await expect(apiFetch("/wallet/x/all")).rejects.toMatchObject({
      code: "code_2002",
      message: "user_did_not_found",
    });
  });

  it("passes through a body that is not enveloped", async () => {
    stubJson({ hello: "world" });
    await expect(apiFetch("/anything")).resolves.toEqual({ hello: "world" });
  });

  it("treats a missing `result` on a 1000 as undefined, not as the envelope", async () => {
    stubJson({ code: 1000, message: "ok" });
    await expect(apiFetch("/anything")).resolves.toBeUndefined();
  });
});

describe("apiFetch — error mapping", () => {
  it("maps 401 and 403 to `unauthorized`", async () => {
    for (const status of [401, 403]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("nope", { status })),
      );
      await expect(apiFetch("/wallet/x/all")).rejects.toMatchObject({ code: "unauthorized" });
      vi.unstubAllGlobals();
    }
  });

  it("maps 404 to `not_found`", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 404 })),
    );
    await expect(apiFetch("/wallet/x/all")).rejects.toMatchObject({ code: "not_found" });
  });

  it("reports a network failure as status 0", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    await expect(apiFetch("/wallet/x/all")).rejects.toMatchObject({
      status: 0,
      code: "network_error",
    });
  });

  it("rejects a 200 whose body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>gateway</html>", { status: 200 })),
    );
    await expect(apiFetch("/anything")).rejects.toMatchObject({ code: "invalid_json" });
  });

  it("throws ApiError, so callers can branch on it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 401 })),
    );
    await expect(apiFetch("/wallet/x/all")).rejects.toBeInstanceOf(ApiError);
  });
});
