/**
 * Midnight NIGHT redemption — handoff to the official portal.
 *
 * Redeeming thawed NIGHT executes a real Cardano transaction (ADA fee) against
 * Midnight's own infrastructure. Phoenix does NOT build or co-sign that
 * transaction over the user's funds — there is no public redemption contract/SDK
 * to do so safely. This page connects the user's Cardano wallet (CIP-30) so they
 * can see their address, then hands off to the official portal to sign.
 *
 * Official portal: https://redeem.midnight.gd  (source: midnight.gd/news).
 */

export const MIDNIGHT_REDEEM_PORTAL = "https://redeem.midnight.gd";
export const MIDNIGHT_CLAIM_PORTAL = "https://claim.midnight.gd";
export const MIDNIGHT_INFO = "https://midnight.gd";

/**
 * The official portal runs its own wallet connect + destination-address flow, so
 * the handoff is simply the portal URL. Kept as a function so a future official
 * deep-link (destination address / "on behalf of") can be threaded in without
 * touching callers.
 */
export function buildRedeemUrl(): string {
  return MIDNIGHT_REDEEM_PORTAL;
}
