/**
 * The one thing this proves: the code that runs in a browser derives the same
 * address as the code that runs in the test suite.
 *
 * That is not a given. The bundler rewrites Node built-ins away for the browser
 * — `events` and `stream` arrive from a transitive dependency of the PBKDF2
 * used by Icarus derivation, and the bundler replaces them with stubs that
 * throw on first touch. A wallet that derives a *different* address in Chrome
 * than in `vitest` sends funds to a place its owner cannot reach, and no
 * unit test running under Node would ever see it.
 *
 * So this file is compiled by the real browser build and then executed. If a
 * stub is on the live path, it throws here.
 */
import { accountFromEntropy, primaryAddress } from "../../src/lib/keystore/derive";
import { sealVault, openVault } from "../../src/lib/keystore/vault";

/** cardano-serialization-lib `tests/address.rs`, root_key_12. */
const ENTROPY_HEX = "df9ed25ed146bf43336a5d7cf7395994";
const EXPECT_ADDR =
  "addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp";

const entropy = new Uint8Array(
  (ENTROPY_HEX.match(/../g) as string[]).map((b) => parseInt(b, 16)),
);

function toHex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

(globalThis as Record<string, unknown>).__phoenixSmoke = async () => {
  const account = await accountFromEntropy(entropy, 0, 0);
  const address = primaryAddress(account);

  // Deliberately weak KDF: this checks the seal/open plumbing, not the cost.
  const vault = await sealVault(entropy, "correct horse battery staple", {
    kdf: { t: 1, m: 256, p: 1 },
  });
  const reopened = await openVault(vault, "correct horse battery staple");

  return {
    address,
    addressMatches: address === EXPECT_ADDR,
    entropyRoundTrips: toHex(reopened) === ENTROPY_HEX,
  };
};
