/**
 * Browser Cardano wallet primitives (pure JS, no WASM).
 *
 * Three no-seed-online connect modes for `/wallet`:
 *   - CIP-30 (cip30.ts)      → extension holds the key, signs; we read + build.
 *   - Watch-only (xpub.ts)   → derive + view from an account public key only.
 *   - Air-gap QR (qr.ts)     → unsigned tx out, witness in; seed stays offline.
 *
 * See `src/lib/cardano/README` header comments in each file for the spec anchors.
 */
export * from "./hash";
export * from "./address";
export * from "./xpub";
export * from "./cip30";
export * from "./provider";
export * from "./qr";
export * from "./tx";
// Feature-tab builders (send/receive/staking/governance/connect) are imported
// via their direct path `@/lib/cardano/<feature>` to avoid barrel name clashes.
