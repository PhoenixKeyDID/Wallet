import { describe, it, expect } from "vitest";
import { anchorAssetNameHex, enterpriseScriptAddress, baseAddress, rewardAddress } from "../address";

/**
 * Golden vectors copied verbatim from
 * `PhoenixKey-Core/Enclave/rust_core/src/phoenix_address.rs` tests. If the
 * browser derivation ever drifts from the Rust/CLI derivation, this fails.
 */
const VEC_DID = "did:phoenix:person:alice";
const VEC_NAME = "1643c0c9f776c4b173c475019e8d83b59e0269fa5d21f7fbe8e15af14c9ac470";
const VEC_HASH = "3aa8fe1376effcfcf966a80e86a9425396e8a8cb0d95205fe2ab2c53";
const VEC_ADDR_PREPROD = "addr_test1wqa23lsnwmhlel8ev65qap4fgffed69gevxe2gzlu24jc5c97w4rq";
const VEC_ADDR_MAINNET = "addr1wya23lsnwmhlel8ev65qap4fgffed69gevxe2gzlu24jc5c7k6fv9";

describe("anchor asset name", () => {
  it("blake2b_256(did) matches Rust VEC_NAME", () => {
    expect(anchorAssetNameHex(VEC_DID)).toBe(VEC_NAME);
  });
  it("rejects empty did", () => {
    expect(() => anchorAssetNameHex("")).toThrow();
  });
});

describe("Phoenix custody enterprise address (script credential)", () => {
  it("preprod address matches Rust CLI golden", () => {
    expect(enterpriseScriptAddress(VEC_HASH, 0)).toBe(VEC_ADDR_PREPROD);
  });
  it("mainnet address matches Rust CLI golden", () => {
    expect(enterpriseScriptAddress(VEC_HASH, 1)).toBe(VEC_ADDR_MAINNET);
  });
  it("preview shares the preprod testnet header", () => {
    expect(enterpriseScriptAddress(VEC_HASH, 2)).toBe(VEC_ADDR_PREPROD);
  });
});

describe("key-hash address assembly", () => {
  const pkh = "00".repeat(28);
  const skh = "11".repeat(28);
  it("base address is well-formed bech32 for the network", () => {
    expect(baseAddress(pkh, skh, 0)).toMatch(/^addr_test1[0-9a-z]+$/);
    expect(baseAddress(pkh, skh, 1)).toMatch(/^addr1[0-9a-z]+$/);
  });
  it("reward address is well-formed", () => {
    expect(rewardAddress(skh, 0)).toMatch(/^stake_test1[0-9a-z]+$/);
    expect(rewardAddress(skh, 1)).toMatch(/^stake1[0-9a-z]+$/);
  });
});
