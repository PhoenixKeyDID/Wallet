/**
 * Attaching an external wallet to a DID (`POST /wallet/imported/attach`).
 *
 * Two oracles that are not this file's own code:
 * - the message bytes are compared with a vector produced by the server's own
 *   message builder (Java, run once and pasted here), so a drift in field order,
 *   length framing or the expiry's text form fails here, not as a 1387 in use;
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
  signImportProof,
  type DataSigner,
} from "../../wallet";

/**
 * `CanonicalMessage.build("PHOENIXKEY_WALLET_IMPORT_ATTACH:", did, address,
 * nonce, Long.toString(expiresAt))`, hex, for the inputs in the case below —
 * output of the backend class at the commit that added the attach route.
 */
const JAVA_VECTOR = "50484f454e49584b45595f57414c4c45545f494d504f52545f4154544143483a000000186469643a70686f656e69783a70726570726f643a3766336100000013616464725f7465737431717a6578616d706c650000002030303131323233333434353536363737383839396161626263636464656566660000000a31373633333030303030";

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
  it("matches the server's own builder byte for byte", () => {
    const got = importAttachMessage(
      "did:phoenix:preprod:7f3a",
      "addr_test1qzexample",
      "00112233445566778899aabbccddeeff",
      1763300000,
    );
    expect(JAVA_VECTOR).toMatch(/^[0-9a-f]+$/);
    expect(hex(got)).toBe(JAVA_VECTOR);
  });

  it("frames each field with a 4-byte big-endian length after the prefix", () => {
    const m = importAttachMessage("d", "ab", "c", 7);
    const prefix = Buffer.from("PHOENIXKEY_WALLET_IMPORT_ATTACH:");
    expect(Buffer.from(m.subarray(0, prefix.length)).equals(prefix)).toBe(true);
    expect(hex(m.subarray(prefix.length))).toBe(
      "00000001" + "64" + "00000002" + "6162" + "00000001" + "63" + "00000001" + "37",
    );
  });

  it("counts UTF-8 bytes, not UTF-16 code units", () => {
    const m = importAttachMessage("é", "a", "b", 1);
    const at = "PHOENIXKEY_WALLET_IMPORT_ATTACH:".length;
    expect(hex(m.subarray(at, at + 6))).toBe("00000002c3a9");
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

  it("falls back to the status when there is no known code", async () => {
    expect(classifyImportError(await failWith(401, 1001))).toBe("unauthorized");
    expect(classifyImportError(await failWith(404, 1320))).toBe("not_found");
    expect(classifyImportError(await failWith(500, 9999))).toBe("other");
    expect(classifyImportError(new Error("x"))).toBe("other");
  });

  it("a non-JSON error body still yields the status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { status: 403 })));
    const e = await detachImportedWallet("a").catch((x: unknown) => x);
    expect((e as ApiError).rawCode).toBeUndefined();
    expect(classifyImportError(e)).toBe("unauthorized");
  });
});
