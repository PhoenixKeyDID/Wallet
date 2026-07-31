/**
 * Receive-address derivation from an account extended public key (`acct_xvk`).
 *
 * Same CKDpub soft-derivation as `xpub.ts:deriveWatchWallet`
 * (`Legacy/spec-proposals-2026-07-10/PhoenixKey-Connector-CIP30-Feat-Math.md §B.1`),
 * but parameterised by **address kind** (base vs enterprise) and an
 * explicit index, so the user can generate any receiving address the
 * connected wallet (or an `acct_xvk`) can produce — not just the first 5.
 *
 * Invariant M2-WATCH still holds: `acct_xvk` is a PUBLIC key, this module
 * only builds addresses, it never signs and never sees a private key.
 */
import { Buffer } from "buffer";
import type { Bip32PublicKey } from "@stricahq/bip32ed25519";
import { address as tyAddress, types as tyTypes } from "@stricahq/typhonjs";
import { baseAddress, toNetworkId, type PhoenixNetwork } from "./address";
import { keyHashAt } from "./xpub";

export type ReceiveAddressKind = "base" | "enterprise";

export type DeriveReceiveAddressArgs = {
  acctXvk: Bip32PublicKey;
  kind: ReceiveAddressKind;
  index: number;
  network: PhoenixNetwork;
};

export type DerivedReceiveAddress = {
  index: number;
  kind: ReceiveAddressKind;
  address: string;
  /** derivation path label, e.g. `m/1852'/1815'/0'/0/3`. */
  path: string;
};

function keyCredential(keyHashHex: string): tyTypes.HashCredential {
  return { hash: Buffer.from(keyHashHex, "hex"), type: tyTypes.HashType.ADDRESS };
}

/**
 * Enterprise address with a KEY (not script) payment credential — the
 * "no stake" receiving address, chain 0/index. `address.ts:enterpriseScriptAddress`
 * builds a SCRIPT-credential enterprise address (Phoenix custody) and is not
 * reusable here; this mirrors it with a key credential instead.
 */
function enterpriseKeyAddress(paymentKeyHashHex: string, network: PhoenixNetwork): string {
  const addr = new tyAddress.EnterpriseAddress(toNetworkId(network), keyCredential(paymentKeyHashHex));
  return addr.getBech32();
}

function pathLabel(kind: ReceiveAddressKind, index: number): string {
  // Both kinds derive the payment key at chain 0 (external); base additionally
  // pins the shared stake key at chain 2/0, which isn't part of the payment path.
  void kind;
  return `m/1852'/1815'/0'/0/${index}`;
}

/** Derive a single receive address (base or enterprise) at a given index. */
export function deriveReceiveAddress(args: DeriveReceiveAddressArgs): DerivedReceiveAddress {
  const { acctXvk, kind, index, network } = args;
  if (!Number.isInteger(index) || index < 0) {
    throw new Error("index must be a non-negative integer");
  }
  const paymentKeyHash = keyHashAt(acctXvk, 0, index);
  const address =
    kind === "base"
      ? baseAddress(paymentKeyHash, keyHashAt(acctXvk, 2, 0), network)
      : enterpriseKeyAddress(paymentKeyHash, network);
  return { index, kind, address, path: pathLabel(kind, index) };
}

export type DeriveReceiveRangeArgs = {
  acctXvk: Bip32PublicKey;
  kind: ReceiveAddressKind;
  start: number;
  count: number;
  network: PhoenixNetwork;
};

/** Derive a contiguous range of receive addresses `[start, start+count)`. */
export function deriveReceiveRange(args: DeriveReceiveRangeArgs): DerivedReceiveAddress[] {
  const { acctXvk, kind, start, count, network } = args;
  if (!Number.isInteger(start) || start < 0) throw new Error("start must be a non-negative integer");
  if (!Number.isInteger(count) || count <= 0) throw new Error("count must be a positive integer");
  const out: DerivedReceiveAddress[] = [];
  for (let i = 0; i < count; i++) {
    out.push(deriveReceiveAddress({ acctXvk, kind, index: start + i, network }));
  }
  return out;
}
