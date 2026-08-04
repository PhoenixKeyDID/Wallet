/**
 * Cardano address assembly (CIP-19) — pure JS via @stricahq/typhonjs.
 *
 * Mirrors rust_core address construction so the browser derives the SAME
 * bech32 strings the mobile/enclave path produces:
 *   - Standard CIP-1852 base address  → `cardano.rs:derive_address_inner`
 *   - Phoenix custody enterprise addr → `phoenix_address.rs` (script credential)
 *
 * Golden vectors in `__tests__/address.test.ts` cross-check against the Rust
 * constants (VEC_NAME / VEC_HASH / VEC_ADDR_*), so any drift fails CI.
 *
 * NOTE: this module does NOT apply Plutus params (UPLC) — deriving the Phoenix
 * custody *script hash* from a DID needs `apply_params_to_did_payment`, which is
 * a Rust/UPLC step. The browser reads the ready custody address from the backend
 * (`GET /wallet/{did}/all`); this module only assembles an address from a hash
 * you already hold, and computes the anchor asset-name.
 */
import { Buffer } from "buffer";
import { address as tyAddress, types as tyTypes } from "@stricahq/typhonjs";
import { blake2b256, toHex } from "./hash";

/** rust_core network ids: 0=preprod, 1=mainnet, 2=preview. */
export type PhoenixNetwork = 0 | 1 | 2;

/** Map rust_core network id → typhon NetworkId (preprod/preview share the testnet header). */
export function toNetworkId(network: PhoenixNetwork): tyTypes.NetworkId {
  return network === 1 ? tyTypes.NetworkId.MAINNET : tyTypes.NetworkId.TESTNET;
}

function keyCredential(keyHashHex: string): tyTypes.HashCredential {
  return { hash: Buffer.from(keyHashHex, "hex"), type: tyTypes.HashType.ADDRESS };
}

function scriptCredential(scriptHashHex: string): tyTypes.ScriptCredential {
  return { hash: Buffer.from(scriptHashHex, "hex"), type: tyTypes.HashType.SCRIPT };
}

/**
 * Base address (payment + stake credential) — the Standard CIP-1852 wallet
 * address. `paymentKeyHashHex` / `stakeKeyHashHex` are 28-byte blake2b-224 hex.
 */
export function baseAddress(
  paymentKeyHashHex: string,
  stakeKeyHashHex: string,
  network: PhoenixNetwork,
): string {
  const addr = new tyAddress.BaseAddress(
    toNetworkId(network),
    keyCredential(paymentKeyHashHex),
    keyCredential(stakeKeyHashHex),
  );
  return addr.getBech32();
}

/** Reward (stake) address from a stake key-hash. */
export function rewardAddress(stakeKeyHashHex: string, network: PhoenixNetwork): string {
  const addr = new tyAddress.RewardAddress(toNetworkId(network), keyCredential(stakeKeyHashHex));
  return addr.getBech32();
}

/**
 * Enterprise address with a SCRIPT payment credential — the Phoenix custody
 * address, given its 28-byte Plutus-V3 script hash. Matches
 * `phoenix_address.rs:enterprise_address_from_hash`.
 */
export function enterpriseScriptAddress(scriptHashHex: string, network: PhoenixNetwork): string {
  const addr = new tyAddress.EnterpriseAddress(toNetworkId(network), scriptCredential(scriptHashHex));
  return addr.getBech32();
}

/**
 * Anchor asset-name = `blake2b_256(did_utf8)` (hex). This is the binding A-1
 * value shared with `did_payment.ak` and the Phoenix custody derivation
 * (`phoenix_address.rs:anchor_name_from_did`).
 */
export function anchorAssetNameHex(did: string): string {
  if (did.length === 0) throw new Error("did must not be empty");
  return toHex(blake2b256(new TextEncoder().encode(did)));
}
