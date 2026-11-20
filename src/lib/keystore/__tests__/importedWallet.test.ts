/**
 * Attaching an external wallet to a DID (`POST /wallet/imported/attach`).
 *
 * Two oracles that are not this file's own code:
 * - the message bytes are compared with the vector the server's own test pins
 *   for its message builder, so a drift in field order, a separator, a trailing
 *   newline or the expiry's text form fails here, not as a 1387 in use;
 * - the proof is signed by this repo's keystore — a real CIP-30 `signData` — and
 *   checked by the vendored LAMP CIP-8 verifier, which reads the same COSE fields
 *   the server reads (protected `address` header, `blake2b224(COSE_Key.x)`,
 *   payload equality, Ed25519 over Sig_structure).
 */
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { Buffer } from "buffer";
import { bech32 } from "bech32";
import { accountFromEntropy, type Account } from "../index";
import { planDataSign, signDataCip8 } from "../signData";
import { verifyCip8 } from "./vendor/lamp-drip-pot/cip8";
import { ApiError } from "../../api";
import {
  IMPORT_PROOF_LIFETIME_SEC,
  attachImportedWallet,
  checkImportAddress,
  classifyImportError,
  detachImportedWallet,
  importAttachMessage,
  listImportedWallets,
  newImportNonce,
  samePaymentKeyAs,
  signImportProof,
  type DataSigner,
} from "../../wallet";

/**
 * The server's published vector for the attach message (PhoenixKey-Database
 * f5f26fa5, `WalletImportServiceTest.attachMessageVector`): five plain-text
 * lines joined by "\n", no trailing newline. Written out line by line here, not
 * built by the code under test.
 */
const VECTOR = {
  did: "did:phoenix:alice",
  address: "addr_test1qpy3zykaqy24cp76kjzlwx6h9cx2uav79nfck8qwja2599ea26s5nj7ethl6pylth7rye6uxzy7lapc5dqfpfrs9ynnsqqalcej6",
  nonce: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
  expiresAt: 1763456789,
};
const VECTOR_TEXT =
  "PhoenixKey: attach wallet\n" +
  "did: did:phoenix:alice\n" +
  "address: addr_test1qpy3zykaqy24cp76kjzlwx6h9cx2uav79nfck8qwja2599ea26s5nj7ethl6pylth7rye6uxzy7lapc5dqfpfrs9ynnsqqalcej6\n" +
  "nonce: 0f1e2d3c4b5a69788796a5b4c3d2e1f0\n" +
  "expires_at: 1763456789";

const ENTROPY = Uint8Array.from(Buffer.alloc(32, 9));
const rawHex = (bech: string) =>
  Buffer.from(bech32.fromWords(bech32.decode(bech, 1023).words)).toString("hex");
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

let acct: Account;
beforeAll(async () => {
  acct = await accountFromEntropy(ENTROPY, 0, 0);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A CIP-30 wallet backed by this repo's keystore. */
function keystoreWallet(account: Account): DataSigner {
  return {
    async signData(addr: string, payload: string) {
      const p = planDataSign(account, addr, payload);
      if (!p.ok) throw { code: p.refusal.code, info: p.refusal.reason };
      return signDataCip8(account, p.plan);
    },
  };
}

describe("importAttachMessage — the bytes the server rebuilds", () => {
  it("matches the server's published vector byte for byte", () => {
    const got = importAttachMessage(VECTOR.did, VECTOR.address, VECTOR.nonce, VECTOR.expiresAt);
    expect(Buffer.from(got).toString("utf8")).toBe(VECTOR_TEXT);
    expect(hex(got)).toBe(Buffer.from(VECTOR_TEXT, "utf8").toString("hex"));
    expect(got[got.length - 1]).not.toBe(0x0a);
  });

  it("encodes as UTF-8", () => {
    const m = importAttachMessage("é", "a", "b", 1);
    expect(hex(m)).toBe(
      Buffer.from("PhoenixKey: attach wallet\ndid: \u00e9\naddress: a\nnonce: b\nexpires_at: 1").toString("hex"),
    );
  });

  it("refuses a line break in the DID, the address or the nonce instead of signing it", () => {
    const ok = [VECTOR.did, VECTOR.address, VECTOR.nonce] as const;
    for (let i = 0; i < 3; i++) {
      for (const brk of ["\n", "\r", "\r\n"]) {
        const f: [string, string, string] = [...ok];
        f[i] = f[i]!.slice(0, 5) + brk + f[i]!.slice(5);
        expect(() => importAttachMessage(f[0], f[1], f[2], VECTOR.expiresAt)).toThrow(/line break/);
      }
    }
  });

  it("is text this repo's own wallet shows as text in its sign prompt", () => {
    const entry = acct.external[0]!;
    const msg = importAttachMessage(VECTOR.did, entry.address, VECTOR.nonce, VECTOR.expiresAt);
    const p = planDataSign(acct, rawHex(entry.address), hex(msg));
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.plan.payloadText).toBe(Buffer.from(msg).toString("utf8"));
  });

  it("refuses an expiry that is not a positive whole number", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, 2 ** 60]) {
      expect(() => importAttachMessage("d", "a", "n", bad)).toThrow();
    }
  });
});

describe("checkImportAddress", () => {
  it("accepts a base address and returns its bech32 + network", () => {
    const a = acct.external[0]!.address;
    expect(checkImportAddress(rawHex(a))).toEqual({ ok: true, bech32: a, network: 0 });
  });

  it("names a script payment part as such", () => {
    const keyAddr = Buffer.from(rawHex(acct.external[0]!.address), "hex");
    keyAddr[0] = 0x10 | (keyAddr[0]! & 0x0f); // type 1: script payment, key stake
    expect(checkImportAddress(keyAddr.toString("hex"))).toEqual({ ok: false, reason: "script_payment" });
  });

  it("refuses reward, Byron and malformed input", () => {
    expect(checkImportAddress(rawHex(acct.rewardAddress))).toEqual({ ok: false, reason: "unsupported_type" });
    expect(checkImportAddress("82" + "00".repeat(40))).toEqual({ ok: false, reason: "unsupported_type" });
    expect(checkImportAddress("zz")).toEqual({ ok: false, reason: "not_an_address" });
    expect(checkImportAddress("00" + "11".repeat(10))).toEqual({ ok: false, reason: "not_an_address" });
  });

  it("refuses an address whose length does not fit its type", () => {
    const base = rawHex(acct.external[0]!.address); // 57 bytes, type 0
    expect(checkImportAddress(base.slice(0, 58))).toEqual({ ok: false, reason: "not_an_address" }); // 29 bytes
    expect(checkImportAddress(base + "00")).toEqual({ ok: false, reason: "not_an_address" });
    const enterprise = "60" + base.slice(2, 58); // type 6, 29 bytes
    expect(checkImportAddress(enterprise)).toMatchObject({ ok: true });
    expect(checkImportAddress(enterprise + "00".repeat(40))).toEqual({ ok: false, reason: "not_an_address" });
    const pointer = "40" + base.slice(2, 58); // type 4 without its pointer
    expect(checkImportAddress(pointer)).toEqual({ ok: false, reason: "not_an_address" });
    expect(checkImportAddress(pointer + "010203")).toMatchObject({ ok: true });
  });
});

describe("IMPORT_PROOF_LIFETIME_SEC", () => {
  it("stays within the server's ten-minute ceiling", () => {
    // Above 600 s every proof is refused with 1389; the signing case compares
    // against the constant itself, so only this pins the ceiling.
    expect(IMPORT_PROOF_LIFETIME_SEC).toBeGreaterThan(0);
    expect(IMPORT_PROOF_LIFETIME_SEC).toBeLessThanOrEqual(600);
  });
});

describe("signImportProof — a proof the server's checks accept", () => {
  it("signs with the payment key over exactly the server's message", async () => {
    const entry = acct.external[0]!;
    const addressHex = rawHex(entry.address);
    const did = "did:phoenix:preprod:7f3a";
    const proof = await signImportProof(keystoreWallet(acct), did, addressHex, () => 1_763_300_000);

    expect(proof.address).toBe(entry.address);
    expect(proof.expires_at).toBe(1_763_300_000 + IMPORT_PROOF_LIFETIME_SEC);
    expect(proof.nonce).toMatch(/^[0-9a-f]{32}$/);

    const pub = verifyCip8(proof.cose_sign1, proof.cose_key, {
      rewardAddressHex: addressHex, // the header must carry the attached address's bytes
      stakeKeyHash: entry.keyHashHex, // blake2b224(COSE_Key.x) = payment credential
      payload: importAttachMessage(did, entry.address, proof.nonce, proof.expires_at),
    });
    expect(pub).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a proof for one DID does not verify as a proof for another", async () => {
    const entry = acct.external[0]!;
    const addressHex = rawHex(entry.address);
    const proof = await signImportProof(keystoreWallet(acct), "did:phoenix:preprod:aaaa", addressHex);
    expect(() =>
      verifyCip8(proof.cose_sign1, proof.cose_key, {
        rewardAddressHex: addressHex,
        stakeKeyHash: entry.keyHashHex,
        payload: importAttachMessage("did:phoenix:preprod:bbbb", entry.address, proof.nonce, proof.expires_at),
      }),
    ).toThrow();
  });

  it("uses a fresh nonce each time", async () => {
    const addressHex = rawHex(acct.external[0]!.address);
    const a = await signImportProof(keystoreWallet(acct), "did:x", addressHex);
    const b = await signImportProof(keystoreWallet(acct), "did:x", addressHex);
    expect(a.nonce).not.toBe(b.nonce);
  });

  it("does not ask the wallet to sign for an address the server would refuse", async () => {
    const signData = vi.fn();
    const scriptAddr = Buffer.from(rawHex(acct.external[0]!.address), "hex");
    scriptAddr[0] = 0x10 | (scriptAddr[0]! & 0x0f);
    await expect(
      signImportProof({ signData }, "did:x", scriptAddr.toString("hex")),
    ).rejects.toThrow(/script_payment/);
    expect(signData).not.toHaveBeenCalled();
  });

  it("passes the wallet's DataSignError through untouched", async () => {
    const declined = { code: 3, info: "user declined" };
    const wallet: DataSigner = { signData: async () => Promise.reject(declined) };
    await expect(
      signImportProof(wallet, "did:x", rawHex(acct.external[0]!.address)),
    ).rejects.toBe(declined);
  });

  it("refuses a wallet reply that is not hex signature + key", async () => {
    const wallet = { signData: async () => ({ signature: "not hex", key: "a0" }) } as DataSigner;
    await expect(
      signImportProof(wallet, "did:x", rawHex(acct.external[0]!.address)),
    ).rejects.toThrow(/not hex/);
  });
});

describe("samePaymentKeyAs", () => {
  it("finds the attached address that shares the payment key, not one that only shares the stake", () => {
    const a = acct.external[0]!.address;
    const raw = Buffer.from(rawHex(a), "hex");
    const otherStake = Buffer.from(raw);
    otherStake.fill(0x42, 29); // same header + payment hash, another stake hash
    const variant = bech32.encode("addr_test", bech32.toWords(otherStake), 1023);
    const otherPay = Buffer.from(raw);
    otherPay.fill(0x42, 1, 29);
    const unrelated = bech32.encode("addr_test", bech32.toWords(otherPay), 1023);
    expect(samePaymentKeyAs(variant, [unrelated, a])).toBe(a);
    expect(samePaymentKeyAs(variant, [unrelated])).toBeNull();
    expect(samePaymentKeyAs(a, [a])).toBeNull();
    expect(samePaymentKeyAs("garbage", [a])).toBeNull();
  });
});

describe("newImportNonce", () => {
  it("throws rather than inventing a nonce without a CSPRNG", () => {
    vi.stubGlobal("crypto", undefined);
    expect(() => newImportNonce()).toThrow(/random/);
  });
});

describe("the three routes", () => {
  function stubFetch(body: unknown, status = 200) {
    const f = vi.fn(async (_url: string, _init?: RequestInit) => Response.json(body, { status }));
    vi.stubGlobal("fetch", f);
    return f;
  }

  it("attach POSTs the snake_case body the backend binds", async () => {
    const f = stubFetch({ code: 1000, message: "ok" });
    const proof = { address: "addr_test1x", cose_sign1: "84", cose_key: "a4", nonce: "00".repeat(16), expires_at: 9 };
    await attachImportedWallet(proof);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toMatch(/\/wallet\/imported\/attach$/);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual(proof);
    expect(Object.keys(JSON.parse(String(init?.body))).sort()).toEqual(
      ["address", "cose_key", "cose_sign1", "expires_at", "nonce"],
    );
  });

  it("detach encodes the address into the path", async () => {
    const f = stubFetch({ code: 1000, message: "ok" });
    await detachImportedWallet("addr_test1/../x");
    const [url, init] = f.mock.calls[0]!;
    expect(url).toMatch(/\/wallet\/imported\/addr_test1%2F\.\.%2Fx$/);
    expect(init?.method).toBe("DELETE");
  });

  it("list returns the wallets", async () => {
    stubFetch({
      code: 1000,
      message: "ok",
      result: { wallets: [{ address: "addr_test1a", kind: "imported", attached_at: "2026-11-18T00:00:00Z" }] },
    });
    await expect(listImportedWallets()).resolves.toEqual([
      { address: "addr_test1a", kind: "imported", attached_at: "2026-11-18T00:00:00Z" },
    ]);
  });

  it("list throws on a body without a wallets array — empty and broken must differ", async () => {
    stubFetch({ code: 1000, message: "ok", result: {} });
    await expect(listImportedWallets()).rejects.toThrow(/wallets array/);
    stubFetch({ code: 1000, message: "ok", result: { wallets: [{ kind: "imported" }] } });
    await expect(listImportedWallets()).rejects.toThrow(/address/);
  });
});

describe("classifyImportError — read from the backend's integer code", () => {
  async function failWith(status: number, code: number) {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ code, message: "m" }, { status })));
    return attachImportedWallet({ address: "a", cose_sign1: "84", cose_key: "a4", nonce: "00", expires_at: 1 }).then(
      () => {
        throw new Error("expected a failure");
      },
      (e: unknown) => e,
    );
  }

  it("a bad proof on 403 is not 'signed out'", async () => {
    const e = await failWith(403, 1387);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).rawCode).toBe(1387);
    expect(classifyImportError(e)).toBe("proof_invalid");
  });

  it("maps 1388, 1389 and 3006 on their HTTP statuses", async () => {
    expect(classifyImportError(await failWith(409, 1388))).toBe("already_attached");
    expect(classifyImportError(await failWith(400, 1389))).toBe("proof_expired");
    expect(classifyImportError(await failWith(409, 3006))).toBe("nonce_reused");
  });

  it("a 1388 inside a 200 envelope classifies the same", async () => {
    expect(classifyImportError(await failWith(200, 1388))).toBe("already_attached");
  });

  it("maps 1390 (wrong network) and 1320 on 400, the status the server sends them with", async () => {
    expect(classifyImportError(await failWith(400, 1390))).toBe("network_mismatch");
    expect(classifyImportError(await failWith(400, 1320))).toBe("not_attached");
  });

  it("falls back to the status when there is no known code", async () => {
    expect(classifyImportError(await failWith(401, 1001))).toBe("unauthorized");
    expect(classifyImportError(await failWith(500, 9999))).toBe("other");
    expect(classifyImportError(new Error("x"))).toBe("other");
  });

  it("a 404 with no backend code is a missing route; a coded 404 is not", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Not Found", { status: 404 })));
    expect(classifyImportError(await listImportedWallets().catch((x: unknown) => x))).toBe("unavailable");
    expect(classifyImportError(await failWith(404, 2002))).toBe("other");
  });

  it("a non-JSON error body still yields the status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { status: 403 })));
    const e = await detachImportedWallet("a").catch((x: unknown) => x);
    expect((e as ApiError).rawCode).toBeUndefined();
    expect(classifyImportError(e)).toBe("unauthorized");
  });
});
